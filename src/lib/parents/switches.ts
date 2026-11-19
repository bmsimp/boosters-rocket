import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { family, guardian, parent, parentAuthSession, signinCode, student } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { mailWorking } from "@/lib/mail/settings";
import type { StaffOp } from "./people";
import { hasRowThatCounts } from "./sessions";
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
 * that changes nothing (a stale press) does nothing and records nothing. `refuse`, checked under the lock, can stop
 * the change with its reasons before anything is written. The lock is the settings' own: nothing a switch does reads
 * or waits for the roster.
 */
async function change(patch: Partial<ParentSettings>, o: StaffOp, work: (tx: Tx, next: ParentSettings, before: ParentSettings) => Promise<Record<string, unknown>>,
  refuse?: (before: ParentSettings) => string[] | null): Promise<SwitchResult> {
  return db.transaction(async (tx): Promise<SwitchResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${PARENTS_KEY}))`);
    const before = await getParentSettings(tx);
    const next = { ...before, ...patch };
    if ((Object.keys(patch) as (keyof ParentSettings)[]).every((k) => before[k] === next[k])) return { ok: true };
    const errors = refuse?.(before);
    if (errors) return { ok: false, errors };
    await putParentSettings(tx, next);
    const did = await work(tx, next, before);
    await writeAudit({ actor: o.actor, action: "settings.parents.save", permission: o.permission, targetType: "setting", targetId: PARENTS_KEY, ip: o.ip,
      before, after: { ...next, ...did } }, tx);
    return { ok: true };
  });
}

/**
 * Marks as owed a welcome everyone who can sign in by the gate's rule (a row that counts, under `settings`), is not
 * blocked and was never welcomed. A person with no row that counts is not marked: the welcome is for someone who can
 * sign in. Returns how many were marked.
 */
async function oweWelcomes(tx: Tx, settings: ParentSettings): Promise<number> {
  const rows = await tx.update(parent).set({ welcomeOwed: true, updatedAt: new Date() })
    .where(and(isNull(parent.welcomedAt), eq(parent.blocked, false), eq(parent.welcomeOwed, false), hasRowThatCounts(settings.requireActiveStudents)))
    .returning({ id: parent.id });
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
    // Never on: there is nothing to close, and nothing to record.
    if (!(await getParentSettings()).everEnabled) return { ok: true };
    // Welcome emails go off with sign-ins: switching sign-ins on again must never start emailing families by itself.
    return change({ signin: false, welcome: false }, o, async (tx, _next, before) => {
      const ended = await tx.delete(parentAuthSession).returning({ id: parentAuthSession.id });
      const codes = await tx.delete(signinCode).where(isNull(signinCode.usedAt)).returning({ id: signinCode.id });
      const owed = await tx.update(parent).set({ welcomeOwed: false, updatedAt: new Date() }).where(eq(parent.welcomeOwed, true)).returning({ id: parent.id });
      return { sessionsEnded: ended.length, codesDeleted: codes.length, ...(before.welcome ? { welcomeSwitchedOff: true, owedCleared: owed.length } : {}) };
    });
  }
  if ((await getParentSettings()).signin) return { ok: true }; // already on: a stale press changes nothing
  const errors = await missingForSignins();
  if (errors.length) return { ok: false, errors };
  // Who can sign in is the guardian rows the app holds, as they are: switching on opens and closes none of them.
  return change({ signin: true, everEnabled: true }, o, async (tx, next) => (next.welcome ? { welcomeOwed: await oweWelcomes(tx, next) } : {}));
}

/**
 * "Families with no active student": saved and audited, and nothing else. The gate reads it (enterableGuardianRows(),
 * ./sessions.ts) from the app's own student records, so a family with no active student stops counting at once, a
 * session already open in one is sent back on its next request, and switching it off lets them in again. No row is
 * closed or reopened.
 */
export async function setRequireStudents(on: boolean, o: StaffOp): Promise<SwitchResult> {
  return change({ requireActiveStudents: on }, o, async () => ({}));
}

/** How many people can sign in now by the gate's rule (a row that counts) and are not blocked, whether or not the parent door is open. */
export async function peopleWithAccess(): Promise<number> {
  return (await signinCounts()).people;
}

/** SigninCounts, by the gate's rule as the stored setting has it. */
export async function signinCounts(): Promise<SigninCounts> {
  const { requireActiveStudents } = await getParentSettings();
  const people = await db.select({ id: parent.id, welcomedAt: parent.welcomedAt }).from(parent)
    .where(and(eq(parent.blocked, false), hasRowThatCounts(requireActiveStudents)));
  const ids = new Set(people.map((p) => p.id));
  const rows = (await countingRows()).filter((r) => ids.has(r.parentId) && (!requireActiveStudents || r.hasStudent));
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
  return change({ welcome: on }, o, async (tx, next) => {
    if (!on) {
      const owed = await tx.update(parent).set({ welcomeOwed: false, updatedAt: new Date() }).where(eq(parent.welcomeOwed, true)).returning({ id: parent.id });
      return { owedCleared: owed.length };
    }
    return { owed: await oweWelcomes(tx, next) };
  }, (before) => (on && !before.signin ? ["Switch parent sign-ins on first."] : null));
}
