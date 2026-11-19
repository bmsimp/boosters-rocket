import { and, eq, exists, gt, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { family, guardian, parent, parentAuthSession, parentDevice, parentSigninToken, signinCode, student } from "@/lib/db/schema";
import type { Actor } from "@/lib/audit/log";
import type { AppFamilyId } from "@/lib/families/ids";
import { getShape, shapeNamesStudents, type MembershipShape } from "@/lib/roster/shape";
import { getParentSettings } from "./settings";

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
 * change of address (a parent's confirmed change, email-change.ts) updates `parent.email`, a unique column, and
 * Postgres takes FOR UPDATE on the row for that; blocking takes FOR UPDATE itself. FOR KEY SHARE conflicts with FOR
 * UPDATE and nothing else: this read waits for a change that is under way and then sees its result, and a change that
 * starts later waits for the caller's transaction. It does not conflict with FOR NO KEY UPDATE, so a change that
 * leaves the person's address alone does not hold a code request up.
 *
 * Lock order, the same everywhere: the address locks first (lockEmail(), in the order of the addresses), then the
 * person's row (`parent`), then what hangs on the person, in this order: their email change requests, their sign-in
 * codes, their set-up and reset links (`parent_signin_token`), their password (the `credential` row of
 * `parent_auth_account`), their remembered devices (`parent_device`), their sessions. Links are made since the sign-in
 * release's slice SI-2 (mintSigninLink(), signin-links.ts); nothing makes a device yet. Everything that ends all of a
 * person's sign-in deletes their unused links (a password reset spends its own) and forgets their devices, in that
 * place, and keeps their password: blocking, sign-ins switched off, the change-of-company clear, a password reset, a
 * confirmed change of sign-in email, and closing a person's last open membership (closeMembership(), membership.ts;
 * the lead's choice 10 of the sign-in release). So:
 * - choosePasswordFromLink() (password-set.ts) takes the row FOR UPDATE, then, as its re-check, its link's row FOR
 *   UPDATE, and only then, for a reset, deletes the unused codes and those spent within a code's life (so the code
 *   door's last check refuses a sign-in whose code was spent before the reset: signinStands(), below); then it
 *   spends the link, replaces or inserts the password, and for a reset forgets the devices and ends the sessions. That one link ahead of the codes is the one
 *   step out of the order above, and is safe because nothing else takes both without the person's row first: every
 *   writer of a person's links holds that row, and the code check of signin-codes.ts touches no link. A new writer of
 *   both that does not take the person's row first must take the link before the codes too. mintSigninLink() takes the row FOR UPDATE, then replaces the unused link
 *   of its purpose;
 * - confirmMyEmailChange() (email-change.ts) takes both address locks and the row FOR UPDATE, spends its request and
 *   changes the address, then deletes the person's other requests, then their unused codes, then their unused links,
 *   then their devices, then their sessions, and only then, in a savepoint, the roster lock and the app's records;
 * - requestMyEmailChange() takes the row FOR UPDATE, then replaces the person's unused request;
 * - blockPerson() (people.ts) takes the row FOR UPDATE, then deletes the unused requests, then the codes, then the
 *   unused links, then the devices, then the sessions; renamePerson() (people.ts) takes the row FOR UPDATE and touches nothing that hangs on it;
 * - the staff writes of guardians.ts take the parents' settings lock shared first (setSignins() and setWelcome() take
 *   it before the people they touch), then the person's locks, and only then the roster lock shared, as the email
 *   confirm takes the roster after the person's locks: a write that held the roster lock while it waited for a person
 *   the confirm holds, as the confirm asked for the roster, would be a deadlock, which Postgres ends by aborting one of
 *   them (its check runs after a second, before the confirm's three-second wait is up). No roster read waits for a
 *   person's row, so waiting for the roster while holding one is safe against it; the change-of-company clear, which
 *   holds the roster as it takes everyone's rows, could meet these writes and the confirm alike, though nothing the
 *   portal runs reaches it until stage 4. So addGuardian() takes the address lock, then the row FOR UPDATE, then the
 *   roster lock, then makes the person if there is none, then takes their guardian row in the family FOR UPDATE;
 *   removeGuardian() and reinstateGuardian() take the row FOR UPDATE (no address lock: the address isn't changed or
 *   claimed), then the roster lock, then the guardian row FOR UPDATE, and removeGuardian() then deletes the person's
 *   unused requests, then, when it closes their last open row, their unused codes, links and devices, then ends
 *   sessions, through closeMembership() (membership.ts). Each waits for the
 *   roster lock at most three seconds, as the confirm does, and gives up changing nothing: a roster read holds it
 *   through its whole QuickBooks read, and the person's row must not be held that long, since a code request waits for
 *   it (FOR KEY SHARE, below);
 * - setSignins(false) (switches.ts) takes FOR UPDATE, in id order, the row of every person it will touch (an owed
 *   welcome, an unused code, an unused link, a device, a session), then clears the owed welcomes, then deletes the
 *   unused codes, then the unused links, then the devices, then the sessions; setWelcome() takes the rows whose welcome it changes the same way before it changes them;
 * - the daily clean-up (cleanUp(), src/lib/jobs/cleanup.ts) takes FOR UPDATE, in id order, the row of every person
 *   with an expired request, a spent or expired code, a used or expired link, an expired device or an expired session,
 *   then deletes those requests, then the codes, then the links and devices, then the sessions;
 * - clearParentAccess() (company-change.ts), on a change of company, takes FOR UPDATE, in id order, every person's
 *   row, then the open guardian rows, then deletes every request, then the unused codes, then the unused links, then
 *   the devices, then the sessions;
 * - a code request calls this before it touches a code, and the code door's last check (signinStands(),
 *   signin-codes.ts) calls it and then reads the code it spent.
 */
export async function lockedPerson(tx: Tx, parentId: string): Promise<{ email: string; blocked: boolean } | null> {
  const [p] = await tx.select({ email: parent.email, blocked: parent.blocked }).from(parent).where(eq(parent.id, parentId)).for("key share");
  return p ?? null;
}

/**
 * Serializes changes that claim an email address, so two changes to the same address can't give it to two people. A
 * change that takes more than one takes them in the order of the addresses, before the person's row.
 */
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
 * Whether the family record `familyId` (a column or value of the outer query) has an active student record, the
 * condition the Admin's "Families with no active student" setting adds (`requireActiveStudents`; open question 15 of
 * the app-owned families spec: read from the app's own students, never from QuickBooks). A condition for a `where`:
 * there drizzle names every column with its table, so the outer family is never read as the student's own id.
 */
export const hasActiveStudent = (familyId: typeof family.id): SQL =>
  exists(db.select({ id: student.id }).from(student).where(and(eq(student.familyId, familyId), eq(student.active, true))));

/**
 * Whether "Families with no active student" is in force: stored on, and the stored membership shape names a student
 * type (shapeNamesStudents()). With no student type the app holds no active student, so the rule would keep every
 * parent out: it is in force only while the shape names students, as it was before stage 3's slice 7a, and a value
 * stored on beside a shape without students is not used until a shape with students is saved. This is the one place
 * that decides it: the gate, the code request and check, the chooser, the welcome, the switches' counts, the staff
 * words and the reminders all go through it, through studentsRuleInForce(), which reads both as stored.
 */
export const studentsRuleApplies = (requireActiveStudents: boolean, shape: MembershipShape | null): boolean =>
  requireActiveStudents && shapeNamesStudents(shape);

/** studentsRuleApplies() for the stored setting and shape, read in `tx` when given. */
export async function studentsRuleInForce(tx?: Tx): Promise<boolean> {
  const [{ requireActiveStudents }, shape] = await Promise.all([getParentSettings(tx), getShape(tx)]);
  return studentsRuleApplies(requireActiveStudents, shape);
}

/**
 * The one definition of a guardian row that counts (app-owned families spec §6: a guardian signs in while they are an
 * active guardian of an active family in the app): an open row (`status` not `disabled`) whose `family_id` names a
 * family record that is active, and, while the students rule is in force (studentsRuleInForce()), a family with at
 * least one active `student` record. Nothing here reads QuickBooks, and nothing closes a row for any of it: a row of a
 * family that stops counting stays open and counts again when the family does. A row that doesn't count is not a
 * family the person can enter: the chooser doesn't offer it (chooseFamily() refuses it), a session that chose it is
 * sent back to choose, and a person with no row that counts is refused as one with no open row
 * (src/lib/auth/resolve.ts): sent no code and refused at the code check (signin-codes.ts, `no_enabled_guardian`) and
 * at the sign-in's end (completeParentSignin()), and sent no welcome (welcome.ts, through hasRowThatCounts(), the same
 * rule as SQL). A session already open when the rule comes into force, or when a family loses its last active student
 * or goes inactive, is caught on its next request. In the chooser's order, by `family_qbo_id`, then the rows that name
 * no customer (made while their family had no link, stage 3's slice 9d), then by row id, so no linked family's place in
 * the chooser (and its "(1)", "(2)" in myFamilyNames()) moves. Closing a membership
 * ends the sessions that chose the row's family record (endFamilySessions()), and every session once no open row is
 * left (membership.ts).
 */
export async function enterableGuardianRows(parentId: string, tx?: Tx): Promise<EnterableRow[]> {
  const studentsRule = await studentsRuleInForce(tx);
  const rows = await (tx ?? db).select({ g: guardian, familyId: family.id }).from(guardian).innerJoin(family, eq(family.id, guardian.familyId))
    .where(and(eq(guardian.parentId, parentId), ne(guardian.status, "disabled"), eq(family.active, true),
      studentsRule ? hasActiveStudent(family.id) : undefined)).orderBy(sql`${guardian.familyQboId} asc nulls last`, guardian.id);
  return rows.map((r) => ({ ...r.g, familyId: r.familyId }));
}

/**
 * enterableGuardianRows()'s rule as a condition on a query of `parent`: the person has at least one row that counts.
 * The welcome's batch and claim and the switches' marking read it, so a person is welcomed exactly when they could
 * sign in. The caller passes studentsRuleInForce(), read in the transaction it reads the rows in.
 */
export function hasRowThatCounts(studentsRule: boolean): SQL {
  return exists(db.select({ id: guardian.id }).from(guardian).where(and(eq(guardian.parentId, parent.id), guardianRowCounts(studentsRule))));
}

/**
 * enterableGuardianRows()'s rule as a condition on a query of `guardian`: this row counts. Mail sent to a family's
 * guardians that asks them to sign in (the due-date, form and volunteer reminders) goes only to rows that count, so
 * nobody is asked to sign in where the gate would refuse them. The caller passes studentsRuleInForce().
 */
export function guardianRowCounts(studentsRule: boolean): SQL {
  return and(ne(guardian.status, "disabled"), exists(db.select({ id: family.id }).from(family)
    .where(and(eq(family.id, guardian.familyId), eq(family.active, true), studentsRule ? hasActiveStudent(family.id) : undefined))))!;
}

/**
 * The person's sign-in codes not yet used, and how many there were. With `spentSince`, the codes spent since then go
 * too: a password reset passes the start of a code's life back from now, so a sign-in whose code was spent just before
 * the reset, and whose session is made just after it, is refused by the code door's last check (signinStands(), which
 * reads the code it spent again).
 */
export async function deleteUnusedSigninCodes(parentId: string, tx: Tx, o: { spentSince?: Date } = {}): Promise<number> {
  const which = o.spentSince ? or(isNull(signinCode.usedAt), gt(signinCode.usedAt, o.spentSince)) : isNull(signinCode.usedAt);
  const rows = await tx.delete(signinCode).where(and(eq(signinCode.parentId, parentId), which)).returning({ id: signinCode.id });
  return rows.length;
}

/** The person's set-up and reset links not yet used (signin-links.ts), and how many there were. A used one stays until the daily clean-up. */
export async function deleteUnusedSigninLinks(parentId: string, tx: Tx): Promise<number> {
  const rows = await tx.delete(parentSigninToken).where(and(eq(parentSigninToken.parentId, parentId), isNull(parentSigninToken.usedAt)))
    .returning({ id: parentSigninToken.id });
  return rows.length;
}

/** Every device remembered for the person (`parent_device`), and how many there were: each asks for the second step again. */
export async function forgetDevices(parentId: string, tx: Tx): Promise<number> {
  const rows = await tx.delete(parentDevice).where(eq(parentDevice.parentId, parentId)).returning({ id: parentDevice.id });
  return rows.length;
}
