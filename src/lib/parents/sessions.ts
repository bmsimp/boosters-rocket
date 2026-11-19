import { and, eq, gt, isNull, lte, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { family, guardian, parent, parentAuthSession, signinCode } from "@/lib/db/schema";
import type { Actor } from "@/lib/audit/log";
import type { AppFamilyId } from "@/lib/families/ids";

export type GuardianRow = typeof guardian.$inferSelect;

export const parentActor = (p: { id: string; email: string }): Actor => ({ door: "parent", id: p.id, label: p.email });

/**
 * Spec §1 The session: a parent stays signed in for 90 days from the last day they used the portal. The session row is
 * the authority: Better Auth refuses and removes a row past its `expiresAt`, and renewParentSession() moves that time
 * on. The cookie only has to outlive the row. It is set once, at sign-in, and never again (a session is read while a
 * page renders, where a new cookie could not be sent), so it gets the longest life browsers allow, 400 days: a parent
 * who keeps using the portal is asked for a code about once a year, and one who stays away 90 days is asked on return.
 */
export const PARENT_SESSION_SECONDS = 90 * 24 * 60 * 60;
export const PARENT_SESSION_COOKIE_SECONDS = 400 * 24 * 60 * 60;
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Starts the session's 90 days again, at most once a day: a row made or renewed less than a day ago is left alone,
 * without a query. Called for a session the portal has just accepted (src/lib/auth/identity.ts). A row that has run
 * out is never brought back: the update only matches one that is still live.
 */
export async function renewParentSession(s: { id: string; expiresAt: Date }, now = new Date()): Promise<boolean> {
  const expiresAt = new Date(now.getTime() + PARENT_SESSION_SECONDS * 1000);
  const renewable = new Date(expiresAt.getTime() - RENEW_AFTER_MS);
  if (s.expiresAt.getTime() > renewable.getTime()) return false;
  const rows = await db.update(parentAuthSession).set({ expiresAt, updatedAt: now })
    .where(and(eq(parentAuthSession.id, s.id), gt(parentAuthSession.expiresAt, now), lte(parentAuthSession.expiresAt, renewable)))
    .returning({ id: parentAuthSession.id });
  return rows.length > 0;
}

/**
 * The person's address and block as they stand, read under a lock that a change to either has to wait for. Every
 * change of address (the reconcile's in-place change, a staff change, a parent's confirmed change) updates
 * `parent.email`, a unique column, and Postgres takes FOR UPDATE on the row for that; blocking takes FOR UPDATE itself.
 * FOR KEY SHARE conflicts with FOR UPDATE and nothing else: this read waits for a change that is under way and then
 * sees its result, and a change that starts later waits for the caller's transaction. It does not conflict with the
 * FOR NO KEY UPDATE the reconcile holds on every person while it works, so a roster refresh that leaves the person's
 * address alone does not hold a code request up.
 *
 * Lock order, the same everywhere: the person's row first, their sign-in codes after. The address changes and the
 * block take the row and then delete the person's unused codes; a code request calls this before it touches a code.
 */
export async function lockedPerson(tx: Tx, parentId: string): Promise<{ email: string; blocked: boolean } | null> {
  const [p] = await tx.select({ email: parent.email, blocked: parent.blocked }).from(parent).where(eq(parent.id, parentId)).for("key share");
  return p ?? null;
}

/** Serializes changes that claim an email address, so two staff adding the same address can't make two people. */
export const lockEmail = (tx: Tx, email: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booster.parent_email:${email}`}))`);

/** Ends every session the person has, at once (spec §1 The session). Sessions are read from the database on each request. */
export async function endParentSessions(parentId: string, tx?: Tx): Promise<number> {
  const rows = await (tx ?? db).execute<{ id: string }>(sql`DELETE FROM parent_auth_session
    WHERE user_id IN (SELECT id FROM parent_auth_user WHERE parent_id = ${parentId}) RETURNING id`);
  return Array.from(rows as ArrayLike<{ id: string }>).length;
}

/**
 * Ends the person's sessions that chose one family (spec §2 Closing a link), by the app's own family record the session
 * stores (`parent_auth_session.family_id`). Sessions in their other families, and one still choosing, carry on.
 */
export async function endFamilySessions(parentId: string, familyId: AppFamilyId, tx?: Tx): Promise<number> {
  const rows = await (tx ?? db).execute<{ id: string }>(sql`DELETE FROM parent_auth_session
    WHERE family_id = ${String(familyId)} AND user_id IN (SELECT id FROM parent_auth_user WHERE parent_id = ${parentId}) RETURNING id`);
  return Array.from(rows as ArrayLike<{ id: string }>).length;
}

/** An open guardian row whose family the person may enter: it names an app family record, and that record is active. */
export type EnterableRow = GuardianRow & { familyId: AppFamilyId };

/**
 * The person's open rows whose family the portal lets them into (app-owned families spec §6: a guardian signs in while
 * they are an active guardian of an active family in the app): an open row (`status` not `disabled`) whose
 * `family_id` names a family record that is active. A row with no family record, or one whose record is inactive, is
 * not a family the person can enter: the chooser doesn't offer it, a session that chose it is sent back to choose, and
 * a person with no row that counts is refused as one with no open row (src/lib/auth/resolve.ts): sent no code and
 * refused at the code check (signin-codes.ts, `no_enabled_guardian`) and at the sign-in's end (completeParentSignin()).
 * In the chooser's order, by `family_qbo_id`. Nothing else asks this: the welcome email counts every open row with a
 * query of its own (welcome.ts), and closing a membership ends the sessions that chose the row's family record
 * (endFamilySessions()), and every session once no open row is left (membership.ts).
 */
export async function enterableGuardianRows(parentId: string, tx?: Tx): Promise<EnterableRow[]> {
  const rows = await (tx ?? db).select({ g: guardian, familyId: family.id }).from(guardian).innerJoin(family, eq(family.id, guardian.familyId))
    .where(and(eq(guardian.parentId, parentId), ne(guardian.status, "disabled"), eq(family.active, true))).orderBy(guardian.familyQboId);
  return rows.map((r) => ({ ...r.g, familyId: r.familyId }));
}

export async function deleteUnusedSigninCodes(parentId: string, tx: Tx): Promise<void> {
  await tx.delete(signinCode).where(and(eq(signinCode.parentId, parentId), isNull(signinCode.usedAt)));
}
