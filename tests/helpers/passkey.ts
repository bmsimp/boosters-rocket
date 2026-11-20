import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parentAuthPasskey, parentAuthUser } from "@/lib/db/schema";
import { getParentAuth } from "@/lib/auth/parent-auth";
import { env } from "@/env";
import { DOOR_IP, cookieNamed, postDoor, type DoorBody } from "./parent-door";
import { assertionFor, makePasskeyKey, type AssertionJSON, type PasskeyKey } from "./passkey-keys";

/**
 * A guardian's passkey in a test (the sign-in release, slice SI-7a): nothing a parent can press adds one until SI-7b,
 * so it is seeded as the passkey library stores one (its COSE public key, standard base64; the credential id,
 * base64url), and signed with by the software authenticator of ./passkey-keys.ts. The relying party is the test's
 * APP_URL (its host and its origin), as the parent instance names it.
 */
export const RP_ID = new URL(env.APP_URL).hostname;
export const ORIGIN = new URL(env.APP_URL).origin;

/**
 * A passkey for the person, made `createdAt` (an hour ago unless told, so a proof a test stamps just now is newer than
 * it and counts beside it), with the counter it was last seen at (0 as a synced passkey keeps, unless told). The key,
 * which only the test holds, and the row's id.
 */
export async function seedPasskey(parentId: string, o: { key?: PasskeyKey; counter?: number; createdAt?: Date; publicKey?: string } = {}): Promise<PasskeyKey & { rowId: string }> {
  const key = o.key ?? makePasskeyKey();
  const [user] = await db.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, parentId));
  if (!user) throw new Error("the person has no sign-in account");
  const rowId = randomUUID();
  await db.insert(parentAuthPasskey).values({ id: rowId, name: null, publicKey: o.publicKey ?? key.publicKey, userId: user.id, credentialID: key.id,
    counter: o.counter ?? 0, deviceType: "multiDevice", backedUp: true, transports: "internal,hybrid", createdAt: o.createdAt ?? new Date(Date.now() - 60 * 60_000) });
  return { ...key, rowId };
}

/** The person's passkey rows. */
export const passkeyRows = async (parentId: string) => {
  const users = db.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, parentId));
  return db.select().from(parentAuthPasskey).where(inArray(parentAuthPasskey.userId, users));
};

/**
 * The passkey library's challenge, as a browser asks for it (GET /passkey/generate-authenticate-options), with any
 * Cookie header the browser sends: the options' answer and the signed challenge cookie it set (`name=value`).
 */
export async function passkeyOptions(o: { cookie?: string; query?: string } = {}) {
  const auth = await getParentAuth();
  const res = await auth.handler(new Request(`${env.APP_URL}/api/auth/parent/passkey/generate-authenticate-options${o.query ?? ""}`, {
    method: "GET", headers: { origin: env.APP_URL, "cf-connecting-ip": DOOR_IP, ...(o.cookie ? { cookie: o.cookie } : {}) },
  }));
  const body = (await res.json()) as { challenge: string; rpId?: string; allowCredentials?: { id: string }[]; userVerification?: string };
  return { res, body, challengeCookie: cookieNamed(res, "better-auth-passkey") };
}

/** What the passkey step was asked to sign: the switches of assertionFor(), or the assertion itself. */
export type PasskeyTry = { flags?: number; origin?: string; rpId?: string; counter?: number; signWith?: PasskeyKey; id?: string };

/**
 * The passkey at the door, as the sign-in page's ceremony sends it: the options (with `cookie`, the pending step's when
 * there is one), an assertion for their challenge signed by `key` (with the switches), posted to /portal-passkey/check
 * with the pending step's cookie and the challenge cookie, and `next` (and `alone=1`, as the first screen's button
 * sends it, when told) in the query string. Its response, its body, and the assertion sent (to send it again).
 */
export async function passkeyStep(key: PasskeyKey, o: PasskeyTry & { cookie?: string; next?: string; alone?: boolean; challengeCookie?: string | null } = {}) {
  const options = await passkeyOptions({ cookie: o.cookie });
  const assertion = assertionFor(key, options.body.challenge, { origin: o.origin ?? ORIGIN, rpId: o.rpId ?? RP_ID, flags: o.flags, counter: o.counter, signWith: o.signWith, id: o.id });
  const challenge = o.challengeCookie === null ? "" : o.challengeCookie ?? options.challengeCookie;
  const cookie = [o.cookie, challenge].filter(Boolean).join("; ");
  const sent = await postPasskey(assertion, { cookie, next: o.next, alone: o.alone });
  return { ...sent, assertion, cookie };
}

/**
 * One post of an assertion to /portal-passkey/check, with a Cookie header, and `next`, `alone=1` when told, and any
 * other query string the test writes (`query`, without its `?`) in the query string.
 */
export async function postPasskey(assertion: AssertionJSON | unknown, o: { cookie?: string; next?: string; alone?: boolean; query?: string } = {}) {
  const query = [o.next ? `next=${encodeURIComponent(o.next)}` : "", o.alone ? "alone=1" : "", o.query ?? ""].filter(Boolean).join("&");
  const res = await postDoor(`/portal-passkey/check${query ? `?${query}` : ""}`, { response: assertion }, { cookie: o.cookie });
  return { res, body: (await res.json()) as DoorBody };
}
