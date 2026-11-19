// Remembered devices (the sign-in release, slice SI-3b; open question 26 of the app-owned families spec): a device that
// has passed a sign-in's second step, or a set-up link, is remembered for the person for 90 days, so the next password
// sign-in on it needs no emailed code. A row of `parent_device` holds only the keyed hash of the device's token; the
// token itself is only ever in the device's cookie (src/lib/auth/parent-signin-step.ts): never stored, logged, audited
// or sent anywhere else. Server only.
//
// Renewal: this slice renews a device's row (and its cookie) only at a password sign-in on that device. Renewing it
// while its session is in use, as open question 26 says ("renewed by use, like sessions"), is slice SI-5's, with the
// page that lists and forgets devices.
import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parent, parentAuthSession, parentDevice } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { env } from "@/env";
import { lockedPerson } from "./sessions";

/** How long a device is remembered from its last password sign-in (open question 26). */
export const DEVICE_LIFE_MS = 90 * 24 * 60 * 60 * 1000;
const DEVICE_TOKEN_BYTES = 32;
/** A device token as the portal makes one: 32 random bytes, base64url, 43 characters. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
export const isDeviceToken = (v: unknown): v is string => typeof v === "string" && TOKEN_SHAPE.test(v);

/**
 * The one form of a device token the database holds: an HMAC-SHA256 keyed with the server secret over a string that
 * names its purpose, as a link's token and a code are hashed, so a copy of the database alone can't be turned into a
 * cookie, and a device token is never found as anything else.
 */
export const hashDeviceToken = (token: string): string =>
  createHmac("sha256", env.BETTER_AUTH_SECRET).update(`signin-device:${token}`).digest("hex");

/**
 * The person's remembered device the cookie's token names, unexpired, or null: none, of another shape (answered without
 * a query), expired, or another person's.
 */
export async function rememberedDevice(parentId: string, token: string | null, now = new Date()): Promise<{ deviceId: string } | null> {
  if (!isDeviceToken(token)) return null;
  const [row] = await db.select({ id: parentDevice.id }).from(parentDevice)
    .where(and(eq(parentDevice.tokenHash, hashDeviceToken(token)), eq(parentDevice.parentId, parentId), gt(parentDevice.expiresAt, now)));
  return row ? { deviceId: row.id } : null;
}

/**
 * The remembered device the cookie's token names, unexpired, of the person who holds `email` (as normalizeEmail() reads
 * it), or null: no such person, none, of another shape (answered without a query), expired, or another person's. The
 * password step reads it before it counts a try (password-signin.ts), to count a try on the person's own device against
 * that device rather than the address. It tells a stranger nothing: only the device's own token finds its row.
 */
export async function deviceOfAddress(email: string, token: string | null, now = new Date()): Promise<{ deviceId: string } | null> {
  if (!isDeviceToken(token)) return null;
  const [row] = await db.select({ id: parentDevice.id }).from(parentDevice).innerJoin(parent, eq(parent.id, parentDevice.parentId))
    .where(and(eq(parentDevice.tokenHash, hashDeviceToken(token)), eq(parent.email, email), gt(parentDevice.expiresAt, now)));
  return row ? { deviceId: row.id } : null;
}

/** The device cookie to set: its token, and when the device's row ends. */
export type DeviceCookie = { token: string; expiresAt: Date };
/** What a strong sign-in remembers: a new device (a code's or a set-up link's sign-in), or the remembered one it used, by its row and its cookie's token. */
export type StrongDevice = { remember: true } | { deviceId: string; token: string | null };

class Undone extends Error {}

/**
 * The last write of a sign-in that proved a password and a second step, or a set-up link (finishParentSignin(),
 * src/lib/auth/parent-signin-finish.ts, after completeParentSignin() and before the session cookie): one transaction,
 * in the order above lockedPerson() (./sessions.ts): the person's row (FOR KEY SHARE, which a block waits for), their
 * devices, their sessions. It reads that the person is not blocked and the session row still exists, and otherwise
 * writes nothing; then, for a new device, makes a `parent_device` row (a new token, only its hash stored, 90 days)
 * audited `signin.device_remembered`, or, for a remembered one, moves its row's last use and expiry on, audited
 * `signin.device_used` (refused when the row is gone, or no longer the cookie's); and sets the session's `strong_at` to
 * now. A refusal is audited `signin.refused` with its reason, and the caller ends the session with no cookie. The
 * token is returned for the cookie alone.
 */
export async function recordStrongSignin(o: { parentId: string; email: string; sessionId: string; device: StrongDevice; ip: string | null; now?: Date }):
  Promise<{ ok: true; cookie: DeviceCookie } | { ok: false }> {
  const now = o.now ?? new Date();
  const expiresAt = new Date(now.getTime() + DEVICE_LIFE_MS);
  const actor = { door: "parent" as const, id: o.parentId, label: o.email };
  let refused: "blocked" | "session_ended" | "device_gone" = "session_ended";
  try {
    const cookie = await db.transaction(async (tx) => {
      const live = await lockedPerson(tx, o.parentId);
      if (!live || live.blocked) { refused = "blocked"; throw new Undone(); }
      const [session] = await tx.select({ id: parentAuthSession.id }).from(parentAuthSession).where(eq(parentAuthSession.id, o.sessionId));
      if (!session) { refused = "session_ended"; throw new Undone(); }
      let made: DeviceCookie;
      if ("remember" in o.device) {
        const token = randomBytes(DEVICE_TOKEN_BYTES).toString("base64url");
        const [row] = await tx.insert(parentDevice).values({ parentId: o.parentId, tokenHash: hashDeviceToken(token), createdAt: now, lastUsedAt: now, expiresAt })
          .returning({ id: parentDevice.id });
        await writeAudit({ actor, action: "signin.device_remembered", targetType: "parent", targetId: o.parentId,
          after: { deviceId: row!.id, expiresAt: expiresAt.toISOString() }, ip: o.ip }, tx);
        made = { token, expiresAt };
      } else {
        const token = o.device.token;
        const [row] = isDeviceToken(token)
          ? await tx.update(parentDevice).set({ lastUsedAt: now, expiresAt })
            .where(and(eq(parentDevice.id, o.device.deviceId), eq(parentDevice.parentId, o.parentId), eq(parentDevice.tokenHash, hashDeviceToken(token)), gt(parentDevice.expiresAt, now)))
            .returning({ id: parentDevice.id })
          : [];
        if (!row || !isDeviceToken(token)) { refused = "device_gone"; throw new Undone(); }
        await writeAudit({ actor, action: "signin.device_used", targetType: "parent", targetId: o.parentId,
          after: { deviceId: row.id, expiresAt: expiresAt.toISOString() }, ip: o.ip }, tx);
        made = { token, expiresAt };
      }
      // Last, in the lock order: the session. A session ended since the read above takes the device's write back with it.
      const stamped = await tx.update(parentAuthSession).set({ strongAt: now }).where(eq(parentAuthSession.id, o.sessionId)).returning({ id: parentAuthSession.id });
      if (stamped.length === 0) { refused = "session_ended"; throw new Undone(); }
      return made;
    });
    return { ok: true, cookie };
  } catch (e) {
    if (!(e instanceof Undone)) throw e;
    await writeAudit({ actor, action: "signin.refused", targetType: "parent", targetId: o.parentId, after: { reason: refused }, ip: o.ip });
    return { ok: false };
  }
}
