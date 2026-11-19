import { and, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { family, guardian, parent, parentAuthSession, parentAuthUser, parentDevice, parentSigninToken, signinCode, student } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { mailWorking } from "@/lib/mail/settings";
import { getShape, shapeNamesStudents } from "@/lib/roster/shape";
import type { StaffOp } from "./people";
import { unspentLink } from "./link-state";
import { hasRowThatCounts, studentsRuleInForce } from "./sessions";
import { getParentSettings, putParentSettings, PARENTS_KEY, type ParentSettings } from "./settings";

export type SwitchResult = { ok: true } | { ok: false; errors: string[] };

/**
 * Who can sign in now, by the gate's own rule (a guardian row that counts, ./sessions.ts) and never blocked: how many
 * people, to how many families, and how many of those people have never been welcomed. Nothing here reads QuickBooks.
 */
export type SigninCounts = { people: number; families: number; welcomeNow: number };
/**
 * What switching "Families with no active student" on would do now (the gate reads the setting, so nothing is closed):
 * how many families with someone who can sign in have no active student record, and how many people would then have
 * no family to sign in to.
 */
export type StudentsEffect = { families: number; people: number };

/**
 * One settings change: lock, write, do the work the change needs, and audit it with what happened (spec §7). A patch
 * that changes nothing (a stale press) does nothing and records nothing. `refuse`, checked under the lock and before
 * that, can stop the change with its reasons before anything is written, a stale press included. The lock is the settings' own: nothing a switch does reads
 * or waits for the roster.
 */
async function change(patch: Partial<ParentSettings>, o: StaffOp, work: (tx: Tx, next: ParentSettings, before: ParentSettings) => Promise<Record<string, unknown>>,
  refuse?: (before: ParentSettings, tx: Tx) => string[] | null | Promise<string[] | null>): Promise<SwitchResult> {
  return db.transaction(async (tx): Promise<SwitchResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${PARENTS_KEY}))`);
    const before = await getParentSettings(tx);
    const next = { ...before, ...patch };
    // Refused before a patch that changes nothing is answered: a value stored already is refused for the same reason
    // as one that isn't (the students rule stored on beside a shape that names no students is not in force).
    const errors = await refuse?.(before, tx);
    if (errors) return { ok: false, errors };
    if ((Object.keys(patch) as (keyof ParentSettings)[]).every((k) => before[k] === next[k])) return { ok: true };
    await putParentSettings(tx, next);
    const did = await work(tx, next, before);
    await writeAudit({ actor: o.actor, action: "settings.parents.save", permission: o.permission, targetType: "setting", targetId: PARENTS_KEY, ip: o.ip,
      before, after: { ...next, ...did } }, tx);
    return { ok: true };
  });
}

/**
 * Takes FOR UPDATE, in id order, the row of every person `where` names, before this transaction touches anything that
 * hangs on them: the order ./sessions.ts gives (lockedPerson()), so a switch never waits on a person's change of
 * address while that change waits on the switch.
 */
async function lockPeople(tx: Tx, where: SQL | undefined): Promise<void> {
  await tx.select({ id: parent.id }).from(parent).where(where).orderBy(parent.id).for("update");
}

/**
 * Marks as owed a welcome everyone who can sign in by the gate's rule (a row that counts, with the students rule as
 * it is in force in `tx`, where change() has just stored the new settings), is not blocked and was never welcomed. A
 * person with no row that counts is not marked: the welcome is for someone who can sign in. Returns how many were
 * marked.
 */
async function oweWelcomes(tx: Tx): Promise<number> {
  const owed = and(isNull(parent.welcomedAt), eq(parent.blocked, false), eq(parent.welcomeOwed, false), hasRowThatCounts(await studentsRuleInForce(tx)));
  await lockPeople(tx, owed);
  const rows = await tx.update(parent).set({ welcomeOwed: true, updatedAt: new Date() }).where(owed).returning({ id: parent.id });
  return rows.length;
}

/**
 * The sentences for what is missing before sign-ins can be switched on; empty when ready. The settings page uses them
 * too. Only working mail: a sign-in is a code sent by email. QuickBooks plays no part (open question 15 of the
 * app-owned families spec).
 */
export async function missingForSignins(): Promise<string[]> {
  return (await mailWorking()) ? [] : ["Set up outgoing mail and send a test email first."];
}

export async function setSignins(on: boolean, o: StaffOp): Promise<SwitchResult> {
  if (!on) {
    // Off already (or never on): there is nothing to close, and nothing to record.
    if (!(await getParentSettings()).signin) return { ok: true };
    // Welcome emails go off with sign-ins: switching sign-ins on again must never start emailing families by itself.
    return change({ signin: false, welcome: false }, o, async (tx, _next, before) => {
      // Everyone's rows first, in id order, then what hangs on them in the order ./sessions.ts gives: the owed welcomes
      // (on the person's row), the unused codes, the unused set-up and reset links, the remembered devices, the
      // sessions. Passwords stay: switching sign-ins on again lets the same people in the same way.
      await lockPeople(tx, or(eq(parent.welcomeOwed, true),
        inArray(parent.id, tx.select({ id: signinCode.parentId }).from(signinCode).where(isNull(signinCode.usedAt))),
        inArray(parent.id, tx.select({ id: parentSigninToken.parentId }).from(parentSigninToken).where(unspentLink)),
        inArray(parent.id, tx.select({ id: parentDevice.parentId }).from(parentDevice)),
        inArray(parent.id, tx.select({ id: parentAuthUser.parentId }).from(parentAuthUser).innerJoin(parentAuthSession, eq(parentAuthSession.userId, parentAuthUser.id)))));
      const owed = await tx.update(parent).set({ welcomeOwed: false, updatedAt: new Date() }).where(eq(parent.welcomeOwed, true)).returning({ id: parent.id });
      const codes = await tx.delete(signinCode).where(isNull(signinCode.usedAt)).returning({ id: signinCode.id });
      const links = await tx.delete(parentSigninToken).where(unspentLink).returning({ id: parentSigninToken.id });
      const devices = await tx.delete(parentDevice).returning({ id: parentDevice.id });
      const ended = await tx.delete(parentAuthSession).returning({ id: parentAuthSession.id });
      return { sessionsEnded: ended.length, codesDeleted: codes.length, linksDeleted: links.length, devicesForgotten: devices.length,
        ...(before.welcome ? { welcomeSwitchedOff: true, owedCleared: owed.length } : {}) };
    });
  }
  if ((await getParentSettings()).signin) return { ok: true }; // already on: a stale press changes nothing
  const errors = await missingForSignins();
  if (errors.length) return { ok: false, errors };
  // Who can sign in is the guardian rows the app holds, as they are: switching on opens and closes none of them.
  return change({ signin: true }, o, async (tx, next) => (next.welcome ? { welcomeOwed: await oweWelcomes(tx) } : {}));
}

/** Why "Families with no active student" can't be switched on, when it can't. */
export const NO_STUDENTS_IN_SHAPE = "The membership shape doesn't say which customers are students, so this can't be used.";
/**
 * What the settings page says when "Families with no active student" is stored on beside a shape that names no
 * students (one saved before stage 3's slice 7a, or a shape saved later without students): it is not in force
 * (studentsRuleInForce(), ./sessions.ts).
 */
export const STUDENTS_RULE_NOT_IN_USE = "On, but not in use: the membership shape doesn't say which customers are students, so students don't affect who can sign in. It is used again once a membership shape that names students is saved.";

/**
 * "Families with no active student": saved and audited, and nothing else. The gate reads it (enterableGuardianRows(),
 * ./sessions.ts) from the app's own student records, so a family with no active student stops counting at once, a
 * session already open in one is sent back on its next request, and switching it off lets them in again. No row is
 * closed or reopened. It is switched on only while the membership shape names a student type (shapeNamesStudents()):
 * with none the app holds no active student, and the setting would keep every parent out. That reads the stored shape,
 * never QuickBooks. A shape saved later without students leaves the stored value alone: it is simply not in force
 * while the shape names no students (studentsRuleInForce(), ./sessions.ts), and is again once a shape with students
 * is saved.
 */
export async function setRequireStudents(on: boolean, o: StaffOp): Promise<SwitchResult> {
  return change({ requireActiveStudents: on }, o, async () => ({}),
    async (_before, tx) => (on && !shapeNamesStudents(await getShape(tx)) ? [NO_STUDENTS_IN_SHAPE] : null));
}

/**
 * How many guardian rows an earlier version of the portal closed for "Families with no active student"
 * (`disabled_reason` `no_active_students`). Nothing reopens them now, whatever the setting or the family's students:
 * the settings page says so, so its words hold for them too.
 */
export async function closedForNoStudents(): Promise<number> {
  const rows = await db.select({ id: guardian.id }).from(guardian).where(and(eq(guardian.status, "disabled"), eq(guardian.disabledReason, "no_active_students")));
  return rows.length;
}

/** Whether "Families with no active student" can be switched on now (setRequireStudents()). */
export async function studentsRuleUsable(): Promise<boolean> {
  return shapeNamesStudents(await getShape());
}

/** How many people can sign in now by the gate's rule (a row that counts) and are not blocked, whether or not the parent door is open. */
export async function peopleWithAccess(): Promise<number> {
  return (await signinCounts()).people;
}

/** SigninCounts, by the gate's rule with the students rule as it is in force (studentsRuleInForce()). */
export async function signinCounts(): Promise<SigninCounts> {
  const studentsRule = await studentsRuleInForce();
  const people = await db.select({ id: parent.id, welcomedAt: parent.welcomedAt }).from(parent)
    .where(and(eq(parent.blocked, false), hasRowThatCounts(studentsRule)));
  const ids = new Set(people.map((p) => p.id));
  const rows = (await countingRows()).filter((r) => ids.has(r.parentId) && (!studentsRule || r.hasStudent));
  return { people: people.length, families: new Set(rows.map((r) => r.familyId)).size, welcomeNow: people.filter((p) => p.welcomedAt === null).length };
}

/** StudentsEffect, worked out from the rows that count with the setting off. */
export async function studentsEffect(): Promise<StudentsEffect> {
  const rows = await countingRows();
  const without = new Set(rows.filter((r) => !r.hasStudent).map((r) => r.familyId));
  const keeps = new Set(rows.filter((r) => r.hasStudent).map((r) => r.parentId));
  const loses = new Set(rows.filter((r) => !r.hasStudent && !keeps.has(r.parentId)).map((r) => r.parentId));
  return { families: without.size, people: loses.size };
}

/** Every open row of a person who isn't blocked, in an active family record, with whether that family has an active student. */
async function countingRows(): Promise<{ parentId: string; familyId: string; hasStudent: boolean }[]> {
  const rows = await db.select({ parentId: guardian.parentId, familyId: family.id,
    hasStudent: sql<boolean>`exists (select 1 from ${student} where ${student.familyId} = ${family.id} and ${student.active})` })
    .from(guardian).innerJoin(family, eq(family.id, guardian.familyId)).innerJoin(parent, eq(parent.id, guardian.parentId))
    .where(and(sql`${guardian.status} <> 'disabled'`, eq(family.active, true), eq(parent.blocked, false)));
  return rows.map((r) => ({ parentId: r.parentId, familyId: String(r.familyId), hasStudent: r.hasStudent === true }));
}

/**
 * Welcome emails, behind their own switch (spec §3 step 3). On: everyone who can sign in (a row that counts) and was
 * never welcomed is owed one. Refused while sign-ins are off; off always works.
 */
export async function setWelcome(on: boolean, o: StaffOp): Promise<SwitchResult> {
  return change({ welcome: on }, o, async (tx) => {
    if (!on) {
      await lockPeople(tx, eq(parent.welcomeOwed, true));
      const owed = await tx.update(parent).set({ welcomeOwed: false, updatedAt: new Date() }).where(eq(parent.welcomeOwed, true)).returning({ id: parent.id });
      return { owedCleared: owed.length };
    }
    return { owed: await oweWelcomes(tx) };
  }, (before) => (on && !before.signin ? ["Switch parent sign-ins on first."] : null));
}
