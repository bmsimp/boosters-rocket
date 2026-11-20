import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parentAuthPasskey, parentAuthUser } from "@/lib/db/schema";
import { env } from "@/env";
import { cookieNamed, getDoor, postDoor, type DoorBody } from "./parent-door";
import { assertionFor, makePasskeyKey, registrationFor, type AssertionJSON, type PasskeyKey, type RegistrationJSON } from "./passkey-keys";

/**
 * A guardian's passkey in a test (the sign-in release, slice SI-7a; since SI-7b a parent adds one too, addPasskey() below),
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
  const res = await getDoor(`/passkey/generate-authenticate-options${o.query ?? ""}`, { cookie: o.cookie });
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

/*
 * Adding a passkey and asking again with one (the sign-in release, slice SI-7b), as the sign-in settings' ceremonies
 * send them: the library's registration options (GET /passkey/generate-register-options, with the parent's session
 * cookie), a registration answer for their challenge (registrationFor(), ./passkey-keys.ts) posted to the portal's
 * /portal-passkey/add with the session and challenge cookies and the name beside it; and an assertion for the library's
 * challenge posted to /portal-passkey/again with the parent's session.
 */

/** The library's registration options, as the sign-in settings ask for them: the answer, its status and the challenge cookie. */
export async function registerOptions(o: { cookie?: string; query?: string } = {}) {
  const res = await getDoor(`/passkey/generate-register-options${o.query ?? ""}`, { cookie: o.cookie });
  const text = await res.text();
  let body: { challenge?: string; user?: { name?: string; displayName?: string }; excludeCredentials?: { id: string }[]; authenticatorSelection?: Record<string, unknown> } = {};
  try { body = JSON.parse(text) as typeof body; } catch { body = {}; }
  return { res, body, challengeCookie: cookieNamed(res, "better-auth-passkey") };
}

/** One post to /portal-passkey/add: the registration answer (or anything), the name when given, with a Cookie header. */
export async function postAdd(response: RegistrationJSON | unknown, o: { cookie?: string; name?: unknown; body?: unknown } = {}) {
  const body = o.body ?? (o.name === undefined ? { response } : { response, name: o.name });
  const res = await postDoor("/portal-passkey/add", body, { cookie: o.cookie });
  return { res, body: (await res.json()) as { ok: boolean; codes?: string[]; error?: string } };
}

/**
 * A passkey added for the session `cookie` carries, as the settings page adds one: the options, a registration answer
 * for `key` (a new one unless given) with the switches, posted with the name. Its answer, and the key.
 */
export async function addPasskey(cookie: string, o: { key?: PasskeyKey; name?: unknown; flags?: number; origin?: string; rpId?: string } = {}) {
  const key = o.key ?? makePasskeyKey();
  const options = await registerOptions({ cookie });
  const registration = registrationFor(key, options.body.challenge ?? "bm8tb3B0aW9ucw", { origin: o.origin ?? ORIGIN, rpId: o.rpId ?? RP_ID, flags: o.flags });
  const sent = await postAdd(registration, { cookie: [cookie, options.challengeCookie].filter(Boolean).join("; "), name: o.name });
  return { ...sent, key, options };
}

/** Asking again with a passkey for the session `cookie` carries: the library's challenge, an assertion by `key`, posted to /portal-passkey/again. */
export async function passkeyAgain(key: PasskeyKey, cookie: string, o: PasskeyTry = {}) {
  const options = await passkeyOptions({ cookie });
  const assertion = assertionFor(key, options.body.challenge, { origin: o.origin ?? ORIGIN, rpId: o.rpId ?? RP_ID, flags: o.flags, counter: o.counter, signWith: o.signWith, id: o.id });
  const res = await postDoor("/portal-passkey/again", { response: assertion }, { cookie: [cookie, options.challengeCookie].filter(Boolean).join("; ") });
  return { res, body: (await res.json()) as { ok: boolean; error?: string }, options };
}
