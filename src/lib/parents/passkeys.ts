// A guardian's passkeys (the sign-in release, slice SI-7a; section 6 of the app-owned families spec, "Passkeys
// anywhere", and open questions 24, 30 and 35): the only portal module that writes `parent_auth_passkey`, and the only
// one that reads it for one person. Two staff-only modules read it for the whole club, each in one query: the counts of
// factors and Strict's switch (holdsPasskey(), switches.ts) and the count of passkeys from an earlier address
// (oldAddressPasskeys(), signin-reset.ts, through madeElsewhere() below); a change to what counts as a person's
// passkey here is a change to them too. The
// WebAuthn ceremony is the passkey library's (@better-auth/passkey, on the parent instance, src/lib/auth/parent-auth.ts):
// it makes the challenge, verifies an assertion against the stored public key and writes the signature counter itself.
// What the portal reads here is whether a person has a passkey (who is asked which step at the door), when their newest
// came into force (a proof older than it doesn't count for asking again), the passkey an assertion's credential id names
// (passkeyNamed(), by that id alone, which is unique here: read before the library verifies, and again by the library's
// `afterVerification`, src/lib/auth/passkey-check.ts, for the id it verified; whether its person is the pending step's
// is the door's own check, `other_person` in passkey-signin.ts), and, in the door's own transaction, that the passkey that verified is still the person's, with its `last_used_at` set. Adding,
// naming, listing and removing passkeys (slice SI-7b) are read and written here too, below. Server only.
import "server-only";
import { and, asc, count, eq, inArray, max, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { parentAuthPasskey, parentAuthUser } from "@/lib/db/schema";
import { hasAuthenticator } from "./authenticator";

/** A query runner: the database, or the caller's transaction. */
type Reader = Pick<typeof db, "select">;

/** The person's sign-in account ids (one at most), for a passkey's `user_id`. */
const usersOf = (q: Reader, parentId: string) => q.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, parentId));

/**
 * Whether the person has a passkey: a second step of their own at either level (open question 24), and a whole sign-in
 * alone (question 35). Read for every address at the door (a fixed nobody's too), so it costs the same either way.
 */
export async function hasPasskey(parentId: string, q: Reader = db): Promise<boolean> {
  const [row] = await q.select({ id: parentAuthPasskey.id }).from(parentAuthPasskey).where(inArray(parentAuthPasskey.userId, usersOf(q, parentId))).limit(1);
  return row !== undefined;
}

/**
 * When the person's newest passkey came into force (its `created_at`), or null with none: a session's proof older than
 * the newest of their second factors no longer counts for asking again (sessionStrongAt(), asking-again.ts).
 */
export async function newestPasskeySince(parentId: string, q: Reader = db): Promise<Date | null> {
  const [row] = await q.select({ since: max(parentAuthPasskey.createdAt) }).from(parentAuthPasskey).where(inArray(parentAuthPasskey.userId, usersOf(q, parentId)));
  return row?.since ?? null;
}

/** A passkey as the door reads it before the library verifies: its row, its person, and whether its key can be read. */
export type NamedPasskey = { id: string; parentId: string; readable: boolean };

/**
 * The passkey an assertion's credential id names, with its person (the sign-in account's `parent_id`), or null. Never a
 * typed address: the browser offers the passkey and the credential id alone names it (open question 30). The stored
 * public key is checked to be one the library can read (readablePublicKey()), so a row that won't decode is refused in
 * words of its own (`passkey_unreadable`), never a throw.
 */
export async function passkeyNamed(credentialId: string, q: Reader = db): Promise<NamedPasskey | null> {
  const [row] = await q.select({ id: parentAuthPasskey.id, parentId: parentAuthUser.parentId, publicKey: parentAuthPasskey.publicKey })
    .from(parentAuthPasskey).innerJoin(parentAuthUser, eq(parentAuthUser.id, parentAuthPasskey.userId))
    .where(eq(parentAuthPasskey.credentialID, credentialId));
  return row ? { id: row.id, parentId: row.parentId, readable: readablePublicKey(row.publicKey) } : null;
}

/**
 * A passkey sign-in's own write, in the caller's transaction (which holds the person's row, lockedPerson(), and writes
 * the `signin.second_step` row): the passkey that verified is still the person's, and its `last_used_at` is set, by one
 * update returning the row. False when it is gone or no longer theirs (removed since, SI-7b, by a staff reset, SI-9a, or as one from an earlier address, SI-9b).
 */
export async function usePasskey(tx: Tx, parentId: string, passkeyId: string, now: Date): Promise<boolean> {
  const rows = await tx.update(parentAuthPasskey).set({ lastUsedAt: now })
    .where(and(eq(parentAuthPasskey.id, passkeyId), inArray(parentAuthPasskey.userId, usersOf(tx, parentId))))
    .returning({ id: parentAuthPasskey.id });
  return rows.length > 0;
}

/** The passkey a sign-in used is still there and the person's (signinStands(), signin-codes.ts: `passkey_gone` otherwise). */
export async function passkeyStands(q: Reader, parentId: string, passkeyId: string): Promise<boolean> {
  const [row] = await q.select({ id: parentAuthPasskey.id }).from(parentAuthPasskey)
    .where(and(eq(parentAuthPasskey.id, passkeyId), inArray(parentAuthPasskey.userId, usersOf(q, parentId))));
  return row !== undefined;
}

/**
 * Whether a stored public key is one the library can read: standard base64 (as `base64.encode()` of
 * @better-auth/utils writes it) of a COSE key, which is a CBOR map. Anything else (empty, not base64, not a map) is a
 * key that won't decode.
 */
export function readablePublicKey(stored: string): boolean {
  if (stored.length === 0 || stored.length > 4096 || !/^[A-Za-z0-9+/]+={0,2}$/.test(stored)) return false;
  const bytes = Buffer.from(stored, "base64");
  if (bytes.length < 2 || bytes.toString("base64").replace(/=+$/, "") !== stored.replace(/=+$/, "")) return false;
  const major = bytes[0]! >> 5;
  return major === 5; // a CBOR map
}

/**
 * Whether the person has a second factor of their own (open question 24): an authenticator app in force
 * (hasAuthenticator(), authenticator.ts) or a passkey. Strict's readers count it so too (doorStops(), signin-codes.ts,
 * and the request page's rule, password-request.ts), and since slice SI-7b asking again does, at the door's rule: a
 * holder is never emailed a code anywhere.
 */
export async function hasSecondFactor(parentId: string, q: Reader = db): Promise<boolean> {
  const [app, passkey] = await Promise.all([hasAuthenticator(parentId, q), hasPasskey(parentId, q)]);
  return app || passkey;
}

/*
 * Adding, naming, listing and removing (the sign-in release, slice SI-7b; section 6 of the spec, "Several passkeys per
 * guardian, each named, listed and removable"). The library inserts a new passkey's row itself, as it verifies the
 * browser's answer (verify-registration, run in process by the portal's /portal-passkey/add, passkey-settings.ts),
 * outside any portal transaction; everything after that is the portal's, here, each write in the caller's transaction,
 * which holds the person's row (lockedPerson(), sessions.ts) and writes the audit row.
 */

/** The most a passkey's name may hold, as typed (decision 2 of SI-7b). */
export const MOST_PASSKEY_NAME = 50;

/**
 * A passkey's name as the portal keeps it, or null when what was sent isn't one: a string, trimmed, at most
 * MOST_PASSKEY_NAME characters by Unicode code point, with no line break or other control character. Empty (or only
 * spaces) is no name (`""`), drawn as "Passkey added" and its date.
 */
export function readPasskeyName(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MOST_PASSKEY_NAME * 4) return null;
  const name = raw.trim();
  if ([...name].length > MOST_PASSKEY_NAME || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(name)) return null;
  return name;
}

/** A passkey as the person's sign-in settings list it: its row's id, its name (null with none), when it was added and last used. */
export type ListedPasskey = { id: string; name: string | null; createdAt: Date; lastUsedAt: Date | null };

/** The person's passkeys, oldest first: never a credential id, a public key, a counter, an AAGUID, transports or the device type. */
export async function passkeysOf(parentId: string, q: Reader = db): Promise<ListedPasskey[]> {
  return q.select({ id: parentAuthPasskey.id, name: parentAuthPasskey.name, createdAt: parentAuthPasskey.createdAt, lastUsedAt: parentAuthPasskey.lastUsedAt })
    .from(parentAuthPasskey).where(inArray(parentAuthPasskey.userId, usersOf(q, parentId)))
    .orderBy(asc(parentAuthPasskey.createdAt), asc(parentAuthPasskey.id));
}

/** How many passkeys the person has. */
export async function passkeyCount(parentId: string, q: Reader = db): Promise<number> {
  const [row] = await q.select({ n: count() }).from(parentAuthPasskey).where(inArray(parentAuthPasskey.userId, usersOf(q, parentId)));
  return Number(row?.n ?? 0);
}

/**
 * How many of the person's other passkeys were added before this one (by `created_at`, then the row's id): none makes
 * it their first (the add's backup codes, decision 2 of SI-7b). Read under the person's row FOR UPDATE, after the
 * library's insert, so two adds whose inserts both land before either is recorded still find exactly one first.
 */
export async function passkeysAddedBefore(q: Reader, parentId: string, passkeyId: string): Promise<number> {
  const [row] = await q.select({ n: count() }).from(parentAuthPasskey)
    .where(and(inArray(parentAuthPasskey.userId, usersOf(q, parentId)),
      sql`(${parentAuthPasskey.createdAt}, ${parentAuthPasskey.id}) < (SELECT p.created_at, p.id FROM parent_auth_passkey p WHERE p.id = ${passkeyId})`));
  return Number(row?.n ?? 0);
}

/** Whether a credential id is held by a passkey already (anyone's): the library's answer for it is refused before its insert. */
export async function credentialTaken(credentialId: string, q: Reader = db): Promise<boolean> {
  const [row] = await q.select({ id: parentAuthPasskey.id }).from(parentAuthPasskey).where(eq(parentAuthPasskey.credentialID, credentialId)).limit(1);
  return row !== undefined;
}

/** One of the person's own passkeys, by its row's id, with its name; null when it isn't theirs (or isn't one at all). */
export async function passkeyOfPerson(q: Reader, parentId: string, passkeyId: string): Promise<{ id: string; name: string | null } | null> {
  const [row] = await q.select({ id: parentAuthPasskey.id, name: parentAuthPasskey.name }).from(parentAuthPasskey)
    .where(and(eq(parentAuthPasskey.id, passkeyId), inArray(parentAuthPasskey.userId, usersOf(q, parentId))));
  return row ?? null;
}

/** A passkey of the person's named (null for no name), in the caller's transaction; false when it isn't theirs. */
export async function namePasskey(tx: Tx, parentId: string, passkeyId: string, name: string | null): Promise<boolean> {
  const rows = await tx.update(parentAuthPasskey).set({ name })
    .where(and(eq(parentAuthPasskey.id, passkeyId), inArray(parentAuthPasskey.userId, usersOf(tx, parentId))))
    .returning({ id: parentAuthPasskey.id });
  return rows.length > 0;
}

/**
 * The origin a passkey of the person's was made for (slice SI-9b), set by the add's own record in the caller's
 * transaction, beside its name (addMyPasskey(), passkey-settings.ts): the origin the library verified the registration
 * against, passkeyOrigin() (src/lib/auth/passkey-origin.ts). Never by a rename, which may happen at a new address and
 * must never mark an old passkey current. False when it isn't theirs.
 */
export async function recordPasskeyOrigin(tx: Tx, parentId: string, passkeyId: string, origin: string): Promise<boolean> {
  const rows = await tx.update(parentAuthPasskey).set({ origin })
    .where(and(eq(parentAuthPasskey.id, passkeyId), inArray(parentAuthPasskey.userId, usersOf(tx, parentId))))
    .returning({ id: parentAuthPasskey.id });
  return rows.length > 0;
}

/**
 * How long a row with no origin may be an add still under way rather than one the portal never recorded: the library
 * inserts a new passkey's row (origin null) just before the add's own transaction records its origin, in the same
 * request (addMyPasskey(), passkey-settings.ts), so a press of the removal in that moment must neither count it nor
 * remove it. Minutes, many times a request's length; a row the add never recorded is taken by a press after it.
 */
export const ADD_UNDER_WAY_MINUTES = 10;

/**
 * A passkey made at an address other than `origin` (the portal's now): its recorded origin is distinct from it, so a
 * row the portal never recorded (null) counts as one too (slice SI-9b), once it is older than ADD_UNDER_WAY_MINUTES
 * (one younger may be an add under way at this address). A condition on a query of the table.
 */
export const madeElsewhere = (origin: string) => sql`(${parentAuthPasskey.origin} IS DISTINCT FROM ${origin}
  and not (${parentAuthPasskey.origin} is null and ${parentAuthPasskey.createdAt} > now() - ${sql.raw(`interval '${ADD_UNDER_WAY_MINUTES} minutes'`)}))`;

/**
 * A passkey of the person's removed, in the caller's transaction; false when it isn't theirs. A sign-in that verified
 * it just before and whose session is made after is refused at its last check (signinStands(): `passkey_gone`).
 */
export async function removePasskey(tx: Tx, parentId: string, passkeyId: string): Promise<boolean> {
  const rows = await tx.delete(parentAuthPasskey)
    .where(and(eq(parentAuthPasskey.id, passkeyId), inArray(parentAuthPasskey.userId, usersOf(tx, parentId))))
    .returning({ id: parentAuthPasskey.id });
  return rows.length > 0;
}

/**
 * Every passkey of the person removed, in the caller's transaction, which holds the person's row and writes the audit
 * row: an Admin's reset of their sign-in (resetSignin(), signin-reset.ts; the sign-in release, slice SI-9a), which takes
 * away what they sign in with, the passkeys that no longer work after a change of the portal's address included (for
 * every parent at once, removeOldAddressPasskeysOf() below). Answers how many went. A sign-in that verified one just before and whose session is made after is refused at its last
 * check (signinStands(): `passkey_gone`).
 */
export async function removeAllPasskeys(tx: Tx, parentId: string): Promise<number> {
  const rows = await tx.delete(parentAuthPasskey).where(inArray(parentAuthPasskey.userId, usersOf(tx, parentId))).returning({ id: parentAuthPasskey.id });
  return rows.length;
}

/**
 * The person's passkeys made at an address other than `origin` (madeElsewhere()) removed, in the caller's transaction,
 * which holds the person's row and writes the audit row: an Admin's removal of every passkey made at an earlier address
 * (removeOldAddressPasskeys(), signin-reset.ts; slice SI-9b). Their passkeys made at `origin` stay. Answers the origin
 * each one that went was made at (null for one the portal never recorded), so the press counts what it removed, never
 * a credential id. A sign-in that verified one just before and whose session is made after is refused at its last check
 * (signinStands(): `passkey_gone`).
 */
export async function removeOldAddressPasskeysOf(tx: Tx, parentId: string, origin: string): Promise<(string | null)[]> {
  const rows = await tx.delete(parentAuthPasskey).where(and(inArray(parentAuthPasskey.userId, usersOf(tx, parentId)), madeElsewhere(origin)))
    .returning({ origin: parentAuthPasskey.origin });
  return rows.map((r) => r.origin);
}
