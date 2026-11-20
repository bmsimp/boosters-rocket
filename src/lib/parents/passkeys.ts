// A guardian's passkeys (the sign-in release, slice SI-7a; section 6 of the app-owned families spec, "Passkeys
// anywhere", and open questions 24, 30 and 35): the only portal module that reads or writes `parent_auth_passkey`. The
// WebAuthn ceremony is the passkey library's (@better-auth/passkey, on the parent instance, src/lib/auth/parent-auth.ts):
// it makes the challenge, verifies an assertion against the stored public key and writes the signature counter itself.
// What the portal reads here is whether a person has a passkey (who is asked which step at the door), when their newest
// came into force (a proof older than it doesn't count for asking again), the passkey an assertion names, and, in the
// door's own transaction, that the passkey that verified is still the person's, with its `last_used_at` set. Adding,
// naming, listing and removing passkeys are SI-7b's. Server only.
import "server-only";
import { and, eq, inArray, max } from "drizzle-orm";
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
 * The passkey the library has just verified (its `afterVerification`, src/lib/auth/passkey-check.ts), found again by the
 * credential id it verified and the sign-in account it belongs to: its row and its person, or null.
 */
export async function verifiedPasskey(credentialId: string, userId: string, q: Reader = db): Promise<{ id: string; parentId: string } | null> {
  const [row] = await q.select({ id: parentAuthPasskey.id, parentId: parentAuthUser.parentId })
    .from(parentAuthPasskey).innerJoin(parentAuthUser, eq(parentAuthUser.id, parentAuthPasskey.userId))
    .where(and(eq(parentAuthPasskey.credentialID, credentialId), eq(parentAuthPasskey.userId, userId)));
  return row ?? null;
}

/**
 * A passkey sign-in's own write, in the caller's transaction (which holds the person's row, lockedPerson(), and writes
 * the `signin.second_step` row): the passkey that verified is still the person's, and its `last_used_at` is set, by one
 * update returning the row. False when it is gone or no longer theirs (removed since, SI-7b, or by a staff reset, SI-9).
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
 * Whether the person has a second factor of their own at the door (open question 24): an authenticator app in force
 * (hasAuthenticator(), authenticator.ts) or a passkey. Strict's readers count it so too (doorStops(), signin-codes.ts,
 * and the request page's rule, password-request.ts). Asking again counts the app alone until slice SI-7b makes it take
 * a passkey: signin-codes.ts tells the two apart by the code's use.
 */
export async function hasSecondFactor(parentId: string, q: Reader = db): Promise<boolean> {
  const [app, passkey] = await Promise.all([hasAuthenticator(parentId, q), hasPasskey(parentId, q)]);
  return app || passkey;
}
