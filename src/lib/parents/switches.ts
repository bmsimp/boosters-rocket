import { and, count, eq, exists, gt, inArray, isNotNull, isNull, not, notExists, or, sql, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { family, guardian, parent, parentAuthAccount, parentAuthenticator, parentAuthPasskey, parentAuthSession, parentAuthUser, parentDevice, parentSigninToken, signinCode, student } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { mailWorking } from "@/lib/mail/settings";
import { getShape, shapeNamesStudents } from "@/lib/roster/shape";
import type { StaffOp } from "./people";
import { heldLink, unspentLink } from "./link-state";
import { hasRowThatCounts, studentsRuleInForce } from "./sessions";
import { RESEND_AFTER_MS } from "./signin-codes";
import { getParentSettings, putParentSettings, PARENTS_KEY, readStoredSettings, type ParentSettings, type SigninLevel } from "./settings";

/** A switch's answer. `did` is what change()'s work recorded in the audit row, which setLevel() reads; no other caller passes it on. */
export type SwitchResult = { ok: true; did?: Record<string, unknown> } | { ok: false; errors: string[] };
/**
 * change()'s own answer: a switch's, and on `ok` the stored `signin` as change() read it under the parents' settings
 * lock (`signinOn`), which setLevel() answers; it is carried out beside the audit row, never added to it (whose
 * `after` holds `signin` already among the stored switches).
 */
type ChangeResult = { ok: true; did?: Record<string, unknown>; signinOn: boolean } | { ok: false; errors: string[] };
/** A switch's answer without `did`, for the switches whose answer is only whether it was done. */
const answered = (r: ChangeResult): SwitchResult => (r.ok ? { ok: true } : r);

/**
 * Why a save is refused when the stored value fails to parse and names no readable level (storedLevel()): until a
 * level is chosen, nothing but that choice is saved (slice SI-10b).
 */
export const LEVEL_UNREADABLE = "The saved sign-in settings can't be read, so the sign-in level isn't known. Choose Standard or Strict first.";
/** Why the switch to Strict is refused when the count it was shown is no longer the count (setLevel()). */
export const LEVEL_COUNT_CHANGED = "Since this page was drawn, the number of guardians with neither a passkey nor an authenticator app has changed. Nothing was switched. Please reload the page and look again.";

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
 * that, can stop the change with its reasons before anything is written, a stale press included; it is given the level
 * stored (null when unreadable). The lock is the settings' own: nothing a switch does reads or waits for the roster.
 *
 * The settings are read through readStoredSettings() (slice SI-10b): a stored value that fails to parse is the closed
 * state's switches with the level it names (storedLevel()), so any switch keeps a readable level; when it names none,
 * every patch with no `level` is refused (LEVEL_UNREADABLE), and a patch with one is always written (the closed state's
 * other switches with the level chosen), its audit row's `before` saying `level: null`. Returns what `work` recorded.
 */
async function change(patch: Partial<ParentSettings>, o: StaffOp, work: (tx: Tx, next: ParentSettings, before: ParentSettings) => Promise<Record<string, unknown>>,
  refuse?: (before: ParentSettings, tx: Tx, stored: SigninLevel | null) => string[] | null | Promise<string[] | null>): Promise<ChangeResult> {
  return db.transaction(async (tx): Promise<ChangeResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${PARENTS_KEY}))`);
    const { settings, level } = await readStoredSettings(tx);
    const before: ParentSettings = { ...settings, level: level ?? settings.level };
    if (level === null && !("level" in patch)) return { ok: false, errors: [LEVEL_UNREADABLE] };
    const next = { ...before, ...patch };
    // Refused before a patch that changes nothing is answered: a value stored already is refused for the same reason
    // as one that isn't (the students rule stored on beside a shape that names no students is not in force).
    const errors = await refuse?.(before, tx, level);
    if (errors) return { ok: false, errors };
    if (level !== null && (Object.keys(patch) as (keyof ParentSettings)[]).every((k) => before[k] === next[k])) return { ok: true, signinOn: before.signin };
    await putParentSettings(tx, next);
    const did = await work(tx, next, before);
    await writeAudit({ actor: o.actor, action: "settings.parents.save", permission: o.permission, targetType: "setting", targetId: PARENTS_KEY, ip: o.ip,
      before: level === null ? { ...settings, level: null } : before, after: { ...next, ...did } }, tx);
    return { ok: true, did, signinOn: before.signin };
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
 * too. Only working mail: a parent chooses their password from a link sent by email, and on a new device a code sent
 * by email is the second step. QuickBooks plays no part (open question 15 of the app-owned families spec).
 */
export async function missingForSignins(): Promise<string[]> {
  return (await mailWorking()) ? [] : ["Set up outgoing mail and send a test email first."];
}

/**
 * Parent sign-ins switched on or off by an Admin. Off ends all of everyone's sign-in: welcome emails go off too, owed
 * welcomes are cleared, and every unused code, unused set-up or reset link, remembered device and session goes. The
 * passwords stay, and so (since the sign-in release's slices SI-6a and SI-7a) do the authenticator apps, backup codes and passkeys, so
 * switching sign-ins on again lets the same people in the same way. On needs working mail (missingForSignins()) and
 * opens or closes no guardian row.
 */
export async function setSignins(on: boolean, o: StaffOp): Promise<SwitchResult> {
  if (!on) {
    // Off already (or never on): there is nothing to close, and nothing to record.
    if (!(await getParentSettings()).signin) return { ok: true };
    // Welcome emails go off with sign-ins: switching sign-ins on again must never start emailing families by itself.
    return answered(await change({ signin: false, welcome: false }, o, async (tx, _next, before) => {
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
    }));
  }
  if ((await getParentSettings()).signin) return { ok: true }; // already on: a stale press changes nothing
  const errors = await missingForSignins();
  if (errors.length) return { ok: false, errors };
  // Who can sign in is the guardian rows the app holds, as they are: switching on opens and closes none of them.
  return answered(await change({ signin: true }, o, async (tx, next) => (next.welcome ? { welcomeOwed: await oweWelcomes(tx) } : {})));
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
  return answered(await change({ requireActiveStudents: on }, o, async () => ({}),
    async (_before, tx) => (on && !shapeNamesStudents(await getShape(tx)) ? [NO_STUDENTS_IN_SHAPE] : null)));
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

/**
 * Who can sign in by a second step of their own (the sign-in release, slice SI-10b; section 9 of the app-owned
 * families spec: staff see on Parents how many guardians have a passkey): over the people signinCounts() counts (not
 * blocked, a row that counts by the students rule in force), how many have a passkey (hasPasskey()'s condition: a
 * `parent_auth_passkey` row of their sign-in account, readable or not), how many an authenticator app in force
 * (hasAuthenticator()'s: `confirmed_at` set), and how many neither. Someone with both is counted in `passkey` and in
 * `app`. Counts only: nobody is named. With sign-ins off they are of who could sign in once sign-ins are on: the door is
 * closed and nobody is signed in.
 */
export type FactorCounts = { people: number; passkey: number; app: number; neither: number };

/** hasPasskey()'s condition (passkeys.ts) on a query of `parent`. */
const holdsPasskey = (): SQL => exists(db.select({ id: parentAuthPasskey.id }).from(parentAuthPasskey)
  .innerJoin(parentAuthUser, eq(parentAuthUser.id, parentAuthPasskey.userId)).where(eq(parentAuthUser.parentId, parent.id)));
/** hasAuthenticator()'s condition (authenticator.ts) on a query of `parent`. */
const holdsApp = (): SQL => exists(db.select({ id: parentAuthenticator.id }).from(parentAuthenticator)
  .where(and(eq(parentAuthenticator.parentId, parent.id), isNotNull(parentAuthenticator.confirmedAt))));
/** The people signinCounts() counts, as a condition on a query of `parent`. */
const canSignIn = (studentsRule: boolean): SQL => and(eq(parent.blocked, false), hasRowThatCounts(studentsRule))!;

/** FactorCounts now, in one query, read in `tx` when given (the switch reads it under the parents' settings lock). */
export async function factorCounts(tx?: Tx): Promise<FactorCounts> {
  const studentsRule = await studentsRuleInForce(tx);
  const [row] = await (tx ?? db).select({ people: count(),
    passkey: sql<number>`count(*) filter (where ${holdsPasskey()})`.mapWith(Number),
    app: sql<number>`count(*) filter (where ${holdsApp()})`.mapWith(Number),
    neither: sql<number>`count(*) filter (where not ${holdsPasskey()} and not ${holdsApp()})`.mapWith(Number) })
    .from(parent).where(canSignIn(studentsRule));
  return { people: row?.people ?? 0, passkey: row?.passkey ?? 0, app: row?.app ?? 0, neither: row?.neither ?? 0 };
}

/**
 * setLevel()'s answer: for Strict, how many people with neither were signed out; and `signinOn`, the stored `signin`
 * as change() read it under its lock (the press's own moment, not a read after it). With sign-ins off nobody can be
 * signed in: the gate ends any session at its next request while the door is closed (resolveParentSession(),
 * parentDoorClosed()). A session left from a value never stored or one that can't be read (whose `signin` reads as
 * off without setSignins(false) having run) is still deleted and counted in `signedOut`, though it could reach nothing.
 */
export type LevelResult = { ok: true; signedOut: number; signinOn: boolean } | { ok: false; errors: string[] };

/**
 * The Admin's choice of the club's sign-in level (the sign-in release, slice SI-10b; section 6 of the app-owned
 * families spec, "Signing in", and open question 21 (a)), through change(): the parents' settings lock, the setting and
 * one `settings.parents.save` row with its before and after, all in one transaction. Strict may be chosen with sign-ins
 * on or off: the level is the club's, not the door's. With sign-ins off nobody can be signed in (the gate ends any
 * session while the door is closed; LevelResult says what `signedOut` still counts then), and FactorCounts are of who
 * could sign in once they are on; the answer's `signinOn` says which.
 *
 * To Strict from Standard (or from a level that can't be read), refused, changing nothing and recording nothing, when
 * the count of people with neither read under the lock differs from the count the Admin was shown (`shownNeither`,
 * LEVEL_COUNT_CHANGED). Then, in the same transaction, in the lock order above lockedPerson() (sessions.ts): the row
 * of every person with a session, in id order (lockPeople()); the sessions of everyone FactorCounts counts as neither,
 * read again here, deleted; and `strong_at` cleared on every other session that has one, so no proof made under
 * Standard (an emailed code, a proof older than a factor) is a proof under Strict. Devices, passwords, apps, backup
 * codes and passkeys stay, and nobody is mailed: the gate and the enrolment tell each guardian at their next sign-in.
 * The audit row's `after` holds the counts read here, `signedOut` (people), `sessionsEnded` and `proofsCleared`.
 * Removing a factor (turnOffMyAuthenticator(), removeMyPasskey()) and starting an app's set-up (startMyAuthenticator())
 * hold the parents' settings lock shared, so they wait for this press. Confirming an app (confirmMyAuthenticator()),
 * recording a passkey (addMyPasskey()'s transaction) and the passkey library's own insert of its row before that
 * (SI-7b) don't: the first two hold the person's row FOR UPDATE, which lockPeople() here waits for or makes wait, and
 * the library's insert takes no lock of ours. So the counts are read again after lockPeople(): a factor that came
 * into force before that read makes its person a holder, not signed out, and the counts recorded are the ones read
 * there, never the first read's (which only refuses a stale page). A session the switch
 * misses (one made by a sign-in that commits after it) is ended by the gate at its next request (sessionStanding(),
 * enrolment-rule.ts): the gate is the invariant, and this ending is for the count and its record.
 *
 * Back to Standard (`shownNeither` null) does no work: passkeys, apps and backup codes stay, nobody is signed out, an
 * enrolling session ends at its next request (the gate's `enrol_ended`), and remembered devices stand in for the
 * emailed code again. A press for the level stored already changes nothing and records nothing (change()'s rule).
 */
export async function setLevel(level: SigninLevel, shownNeither: number | null, o: StaffOp): Promise<LevelResult> {
  const r = level === "strict"
    ? await change({ level }, o, async (tx) => strictNow(tx), async (_before, tx, stored) => {
      if (stored === "strict") return null; // stored already: change() does nothing
      return (await factorCounts(tx)).neither === shownNeither ? null : [LEVEL_COUNT_CHANGED];
    })
    : await change({ level }, o, async () => ({}));
  if (!r.ok) return r;
  return { ok: true, signedOut: typeof r.did?.signedOut === "number" ? r.did.signedOut : 0, signinOn: r.signinOn };
}

/** The switch to Strict's work (setLevel()), in change()'s transaction, after the setting is stored. */
async function strictNow(tx: Tx): Promise<Record<string, unknown>> {
  const withSession = inArray(parent.id, tx.select({ id: parentAuthUser.parentId }).from(parentAuthUser)
    .innerJoin(parentAuthSession, eq(parentAuthSession.userId, parentAuthUser.id)));
  await lockPeople(tx, withSession);
  const counts = await factorCounts(tx);
  const neither = tx.select({ id: parent.id }).from(parent)
    .where(and(canSignIn(await studentsRuleInForce(tx)), not(holdsPasskey()), not(holdsApp())));
  const ended = await tx.delete(parentAuthSession)
    .where(inArray(parentAuthSession.userId, tx.select({ id: parentAuthUser.id }).from(parentAuthUser).where(inArray(parentAuthUser.parentId, neither))))
    .returning({ id: parentAuthSession.id, userId: parentAuthSession.userId });
  const cleared = await tx.update(parentAuthSession).set({ strongAt: null }).where(isNotNull(parentAuthSession.strongAt)).returning({ id: parentAuthSession.id });
  return { counts, signedOut: new Set(ended.map((e) => e.userId)).size, sessionsEnded: ended.length, proofsCleared: cleared.length };
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
  return answered(await change({ welcome: on }, o, async (tx) => {
    if (!on) {
      await lockPeople(tx, eq(parent.welcomeOwed, true));
      const owed = await tx.update(parent).set({ welcomeOwed: false, updatedAt: new Date() }).where(eq(parent.welcomeOwed, true)).returning({ id: parent.id });
      return { owedCleared: owed.length };
    }
    return { owed: await oweWelcomes(tx) };
  }, (before) => (on && !before.signin ? ["Switch parent sign-ins on first."] : null)));
}

/**
 * Who the Admin's press would email a set-up link (the sign-in release, slice SI-4): everyone who can sign in by the
 * gate's rule (a row that counts, with the students rule as it is in force), not blocked, with a sign-in account and no
 * password (no `credential` row of `parent_auth_account`), not owed a mail already, with no set-up link that still
 * works (unused and not expired, however long ago it was made: a welcome's, the press's or one asked for on "Set up or
 * reset my password", which may be in their mailbox unread, and which a new link would replace), and none on its way
 * made less than RESEND_AFTER_MS ago (a held link, linkSentWithin()'s rule, signin-links.ts). So a person the press or
 * a welcome has just mailed is not counted again while their link works, and is counted again once it runs out
 * unused. A condition on a query of `parent`.
 */
function setupMailOwedTo(studentsRule: boolean, now: Date): SQL {
  return and(eq(parent.blocked, false), eq(parent.welcomeOwed, false), hasRowThatCounts(studentsRule),
    exists(db.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, parent.id))),
    notExists(db.select({ id: parentAuthAccount.id }).from(parentAuthAccount).innerJoin(parentAuthUser, eq(parentAuthUser.id, parentAuthAccount.userId))
      .where(and(eq(parentAuthUser.parentId, parent.id), eq(parentAuthAccount.providerId, "credential")))),
    notExists(db.select({ id: parentSigninToken.id }).from(parentSigninToken).where(and(eq(parentSigninToken.parentId, parent.id), eq(parentSigninToken.purpose, "setup"),
      or(and(isNull(parentSigninToken.usedAt), gt(parentSigninToken.expiresAt, now)),
        and(heldLink, gt(parentSigninToken.createdAt, new Date(now.getTime() - RESEND_AFTER_MS))))))))!;
}

/** How many people the press would email a set-up link now (setupMailOwedTo()), for the settings page. */
export async function setupMailsToOwe(now: Date = new Date()): Promise<number> {
  const rows = await db.select({ id: parent.id }).from(parent).where(setupMailOwedTo(await studentsRuleInForce(), now));
  return rows.length;
}

/** Why the press can't be used now. */
export const SETUP_MAILS_NEED_SWITCHES = "Switch parent sign-ins and welcome emails on first.";

/**
 * The Admin's press: "Email a set-up link to everyone who can sign in and hasn't chosen a password" (the sign-in
 * release, slice SI-4). People welcomed before this release were told there was no password, have none, and are
 * welcomed again by nothing else. It marks owed (`parent.welcome_owed`) everyone setupMailOwedTo() names, and the
 * worker sends them in the welcome's batches under the same switches (sendOwedWelcomes(), ./welcome.ts): a person
 * welcomed before is sent the mail with a link to choose their password (choosePasswordMessage()), one never welcomed the welcome, each with a set-up
 * link. Nothing else owes a welcome to someone welcomed already, so "owed and welcomed before" is this press's mail;
 * and everything that clears an owed welcome clears it too (welcome emails or sign-ins switched off, a block, a change
 * of company). Under the parents' settings lock, as change() takes it, then the rows of the people it marks, in id order
 * (lockPeople()); refused in words while either switch is off. A second press while they are still owed marks nobody
 * twice. One audit row, `parent.setup_mail.owed`, with the count, in the same transaction.
 */
export async function oweSetupMails(o: StaffOp, now: Date = new Date()): Promise<{ ok: true; owed: number } | { ok: false; errors: string[] }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${PARENTS_KEY}))`);
    const settings = await getParentSettings(tx);
    if (!settings.signin || !settings.welcome) return { ok: false as const, errors: [SETUP_MAILS_NEED_SWITCHES] };
    const owe = setupMailOwedTo(await studentsRuleInForce(tx), now);
    await lockPeople(tx, owe);
    const rows = await tx.update(parent).set({ welcomeOwed: true, updatedAt: new Date() }).where(owe).returning({ id: parent.id });
    await writeAudit({ actor: o.actor, action: "parent.setup_mail.owed", permission: o.permission, targetType: "setting", targetId: PARENTS_KEY, ip: o.ip,
      after: { owed: rows.length } }, tx);
    return { ok: true as const, owed: rows.length };
  });
}
