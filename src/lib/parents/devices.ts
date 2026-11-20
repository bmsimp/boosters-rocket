// Remembered devices (the sign-in release, slice SI-3b; open question 26 of the app-owned families spec): a device that
// has passed a sign-in's second step, or a set-up link, is remembered for the person for 90 days from its last use, so
// the next password sign-in on it needs no emailed code. A row of `parent_device` holds only the keyed hash of the
// device's token; the token itself is only ever in the device's cookie (src/lib/auth/parent-signin-step.ts): never
// stored, logged, audited or sent anywhere else. Server only.
//
// Renewal ("renewed by use, like sessions"): a password sign-in on the device moves its row's last use and expiry on
// (recordStrongSignin(), `signin.device_used`), and, since slice SI-5b, so does the use of a session made on it: every
// session names the device it was made on (`parent_auth_session.device_id`, written below), and the session's own
// renewal, at most once a day, renews that device in the same transaction (renewParentSession(), ./sessions.ts), so a
// parent who keeps using the portal on a device keeps it remembered without signing in again. The row is the authority:
// the cookie is set for the longest life browsers allow (setDeviceCookie()), and a device is known only while its row
// is unexpired. The person lists and forgets their devices on their sign-in settings (forgetMyDevice(),
// forgetMyOtherDevices(), signin-settings.ts).
import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parent, parentAuthSession, parentDevice } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { env } from "@/env";
import { DEVICE_LIFE_MS, lockedPerson } from "./sessions";

/** How long a device is remembered from its last use (sessions.ts, beside the session's own life, which its renewal shares). */
export { DEVICE_LIFE_MS };
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

/** A device row's id as the portal makes one (a uuid), the only form a device is named by outside its cookie. */
const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isDeviceId = (v: unknown): v is string => typeof v === "string" && v.length <= 36 && ID_SHAPE.test(v);

/**
 * The remembered device, unexpired, of the person who holds `email` (as normalizeEmail() reads it), or null: no such
 * person, none, of another shape (answered without a query), expired, or another person's. The device is named either
 * by the token of the request's cookie (the door) or, since slice SI-5b, by its row's id as a session names it
 * (`parent_auth_session.device_id`: asking again, which runs on a page whose requests carry no device cookie). The
 * password step reads it before it counts a try (password-signin.ts), to count a try on the person's own device against
 * that device rather than the address. It tells a stranger nothing: only the device's own token finds its row at the
 * door, and an id is taken only from the asking session's own row.
 */
export async function deviceOfAddress(email: string, device: string | { deviceId: string } | null, now = new Date()): Promise<{ deviceId: string } | null> {
  const which = typeof device === "string" ? (isDeviceToken(device) ? eq(parentDevice.tokenHash, hashDeviceToken(device)) : null)
    : device && isDeviceId(device.deviceId) ? eq(parentDevice.id, device.deviceId) : null;
  if (!which) return null;
  const [row] = await db.select({ id: parentDevice.id }).from(parentDevice).innerJoin(parent, eq(parent.id, parentDevice.parentId))
    .where(and(which, eq(parent.email, email), gt(parentDevice.expiresAt, now)));
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
 * `signin.device_used` (refused when the row is gone, or no longer the cookie's); then sets the session's `device_id` to
 * that device's row (since SI-5b, for every proof), and, for a new device only (a code's or a set-up link's sign-in,
 * which proved the password and a second step), its `strong_at` to now. A sign-in
 * on a remembered device leaves it as it is: it proved only the password at that moment, the device standing in for the
 * code, and a change of how the parent signs in asks for the second step itself (asking-again.ts; the lead's decision
 * of SI-5a, which reverses SI-3b's stamp for it). Its session row is still updated, so a session ended meanwhile is
 * seen. A refusal is audited `signin.refused` with its reason, and the caller ends the session with no cookie. The
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
      let deviceId: string;
      if ("remember" in o.device) {
        const token = randomBytes(DEVICE_TOKEN_BYTES).toString("base64url");
        const [row] = await tx.insert(parentDevice).values({ parentId: o.parentId, tokenHash: hashDeviceToken(token), createdAt: now, lastUsedAt: now, expiresAt })
          .returning({ id: parentDevice.id });
        await writeAudit({ actor, action: "signin.device_remembered", targetType: "parent", targetId: o.parentId,
          after: { deviceId: row!.id, expiresAt: expiresAt.toISOString() }, ip: o.ip }, tx);
        made = { token, expiresAt };
        deviceId = row!.id;
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
        deviceId = row.id;
      }
      // Last, in the lock order: the session. A session ended since the read above takes the device's write back with it.
      // `strong_at` is set only for a sign-in that proved the password and a second step itself: the emailed code, or a
      // set-up link (a new device). A sign-in on a remembered device proved only the password at that moment, so its
      // session keeps `strong_at` as it is (null, being new) and opens no window for a change (asking-again.ts).
      // `device_id` (since SI-5b) names the device the session was made on, whichever the proof: the session's renewal
      // renews it while the session is used (renewParentSession(), ./sessions.ts), and the sign-in settings mark it.
      const stamped = await tx.update(parentAuthSession)
        .set({ strongAt: "remember" in o.device ? now : sql`${parentAuthSession.strongAt}`, deviceId })
        .where(eq(parentAuthSession.id, o.sessionId)).returning({ id: parentAuthSession.id });
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
