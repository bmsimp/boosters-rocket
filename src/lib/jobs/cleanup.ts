import { and, eq, inArray, isNotNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { familyMoney, formReminderClaim, formReminderRound, jobRun, parent, parentAuthSession, parentAuthUser, parentAuthVerification, parentEmailChange, rateLimitEvent, requirementReminder, setting, signinCode, staffAuthSession, staffAuthVerification, writeQueue } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { RATE_LIMITS, type RateLimitKind } from "@/lib/parents/rate-limit";
import { RESEND_AFTER_MS } from "@/lib/parents/signin-codes";

export const CLEANUP_JOB = "cleanup.daily";
/** Job history is kept this long. The newest run of each job, and its newest run that worked, are kept whatever their age. */
export const JOB_HISTORY_DAYS = 90;
/** Reminder claims (who was reminded of which form on which day) are kept this long: long past the one-a-day rule they serve. */
export const REMINDER_CLAIM_DAYS = 365;
/** A staff roster write that went through, or that staff gave up, is kept this long for the Reconciliation page's story. */
export const FINISHED_WRITES_DAYS = 30;
const CLEANUP_ACTOR: Actor = { door: "system", id: null, label: "worker" };
/**
 * Settings whose feature is gone (stage 3 of the app-owned families spec, slice 7a), so nothing reads, writes or
 * expires them any more: the previous company's people as they were (`parents.previous_company`, names and addresses
 * of a company the club left, promised gone after 90 days) and the review notice's last send (`parents.review_notice`).
 * Their life ended with the feature: the clean-up removes any still stored.
 */
export const RETIRED_SETTINGS = ["parents.previous_company", "parents.review_notice"] as const;

export type CleanupCounts = {
  staffSessions: number; parentSessions: number; signinCodes: number; rateLimitEvents: number;
  emailChanges: number; familyMoney: number; jobRuns: number; reminderClaims: number; writeQueue: number; verifications: number; retiredSettings: number;
};
const WORDS: Record<keyof CleanupCounts, [string, string]> = {
  staffSessions: ["expired staff session", "expired staff sessions"], parentSessions: ["expired parent session", "expired parent sessions"],
  signinCodes: ["sign-in code", "sign-in codes"], rateLimitEvents: ["rate-limit record", "rate-limit records"],
  emailChanges: ["expired email change", "expired email changes"], familyMoney: ["set of figures for a family no longer in the roster", "sets of figures for families no longer in the roster"],
  jobRuns: ["old job record", "old job records"],
  reminderClaims: ["reminder record older than a year", "reminder records older than a year"],
  writeQueue: ["finished change to QuickBooks", "finished changes to QuickBooks"],
  verifications: ["expired sign-in check", "expired sign-in checks"],
  retiredSettings: ["setting of a retired feature", "settings of retired features"],
};

/**
 * Every table of src/lib/db/schema.ts is named here once: the ones cleanUp() deletes expired rows from, and the ones it
 * leaves alone, with why. A new table must join one list (tests/integration/cleanup.test.ts fails until it does); one
 * whose rows expire gets its delete below and a boundary test.
 */
export const CLEANED_TABLES = ["staff_auth_session", "parent_auth_session", "signin_code", "rate_limit_event", "parent_email_change", "family_money", "job_run",
  "form_reminder_claim", "form_reminder_round", "requirement_reminder", "write_queue", "staff_auth_verification", "parent_auth_verification"] as const;
export const KEPT_TABLES: Record<string, string> = {
  staff_auth_user: "Better Auth's staff accounts", staff_auth_account: "Better Auth's staff accounts",
  parent_auth_user: "Better Auth's parent accounts", parent_auth_account: "Better Auth's parent accounts",
  setting: "the portal's settings, replaced in place; only a retired feature's (RETIRED_SETTINGS) is deleted",
  auth_provider: "the staff sign-in set-up", provider_certificate: "the staff sign-in set-up, rotated by an Admin",
  staff_user: "staff accounts, removed by an Admin", role: "roles", role_rule: "roles", role_assignment: "roles",
  parent: "the people who sign in to the portal: the app's own records", guardian: "each person's membership of a family, open or closed: the app's own records",
  held_address: "retired with the held-address review (stage 3 of the app-owned families spec): neither read nor written, kept until a later slice drops it",
  family_match: "retired with the match review (stage 3 of the app-owned families spec): neither read nor written, kept until a later slice drops it",
  qbo_connection: "the one QuickBooks connection", qbo_customer_type: "the roster cache, replaced by each refresh", qbo_customer: "the roster cache, replaced by each refresh",
  qbo_item: "QuickBooks' products and services, replaced each time staff read the list; emptied on a change of company",
  season: "seasons are history", season_step: "seasons are history", requirement: "seasons are history", requirement_cover: "seasons are history",
  requirement_progress: "ticks and waivers: a season's record",
  volunteer_event: "volunteer history: what happened stays readable", volunteer_shift: "volunteer history", volunteer_shift_requirement: "volunteer history",
  volunteer_signup: "who volunteered: emptied on a change of company, otherwise kept",
  volunteer_credit: "volunteering done, the record a requirement is met by: emptied on a change of company, otherwise kept",
  volunteer_reminder: "one row per reminder email, so none goes twice: emptied on a change of company, otherwise kept",
  buyout: "a family's choice to pay instead of volunteering, and its invoice: the record a requirement is met by, never expires; emptied on a change of company",
  signature_request: "a form's record of signing: evidence, never expires", signature_consent: "a guardian's consent to sign electronically: evidence, never expires",
  signed_form_evidence: "a signed form's evidence: the club's record, never deleted, kept even after a change of company",
  signed_form_file: "the files of a signed form's evidence: never deleted", signed_form_copy: "the copies of a signed form sent to guardians: part of its record",
  form_withdrawal: "documents waiting to be withdrawn in Documenso: the worker removes each once it is done",
  qbo_check_run: "the runs of the check of the portal's QuickBooks requests: a few a year, the record of what QuickBooks was seen to answer",
  qbo_check_record: "the records the check made in a sandbox company, kept so the next run makes inactive any a cut-off run left; emptied on a change of company",
  family: "the portal's own families; emptied on a change of company",
  student: "the portal's own students; emptied on a change of company",
  accounting_link: "each family, student and sign-in's link to its QuickBooks customer; emptied on a change of company",
  audit_log: "append-only",
};

export const removedInAll = (c: CleanupCounts): number => Object.values(c).reduce((a, b) => a + b, 0);

/** The counts as a sentence for the job history, e.g. "Removed 3 expired parent sessions and 12 rate-limit records." */
export function describeCleanup(c: CleanupCounts): string {
  const parts = (Object.keys(WORDS) as (keyof CleanupCounts)[]).filter((k) => c[k] > 0).map((k) => `${c[k]} ${WORDS[k][c[k] === 1 ? 0 : 1]}`);
  if (parts.length === 0) return "Nothing to remove.";
  return `Removed ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`}.`;
}

/**
 * Deletes what is past any use, and nothing else. Every rule is "strictly older than its life": a row whose time is
 * exactly now, or a second ahead, stays.
 *
 * - Sessions of both doors whose `expires_at` has passed. Better Auth already refuses them; a parent's session is
 *   renewed by use (sessions.ts), so one that has run out was not used for 90 days.
 * - Sign-in codes that are used or have expired, once they are older than the wait between two sends: until then the
 *   newest code, used or not, is what holds back the next one (signin-codes.ts).
 * - Rate-limit records older than their kind's window (rate-limit.ts counts only those inside it): the sign-in limits
 *   and the limits on a parent's own contact edits, each kind by its own window.
 * - Email changes whose link has expired, confirmed or not.
 * - Money figures for a family the roster cache no longer holds: nobody can be shown them (family-money.ts). Skipped
 *   while the cache holds no customers at all, which says the roster is missing, not that every family left.
 * - Job history older than JOB_HISTORY_DAYS, except each job's newest run and its newest run that worked: the health
 *   page and the "is it due" check read those.
 * - Reminder claims and scheduled rounds older than REMINDER_CLAIM_DAYS, the forms' and the due-date reminders': they
 *   only stop a second reminder the same day.
 *   A signed form's evidence is never deleted.
 * - Staff roster writes that went through or were given up more than FINISHED_WRITES_DAYS ago. Waiting and stuck ones
 *   stay until they finish.
 * - Better Auth's verification rows of both doors (a staff sign-in's state while it is at Microsoft or Google) whose
 *   `expires_at` has passed: Better Auth refuses them already, and leaves them behind.
 *
 * The audit log is never touched: it is append-only.
 */
export async function cleanUp(tx: Tx, now: Date = new Date()): Promise<CleanupCounts> {
  const n = (rows: unknown[]) => rows.length;
  const staffSessions = n(await tx.delete(staffAuthSession).where(lt(staffAuthSession.expiresAt, now)).returning({ id: staffAuthSession.id }));
  // What hangs on a person goes in the order src/lib/parents/sessions.ts gives (lockedPerson()): the rows of everyone
  // it touches first, FOR UPDATE in id order, then their requests, then their codes, then their sessions. So the
  // clean-up never waits on a person's change of address while that change waits on it.
  const requestGone = lt(parentEmailChange.expiresAt, now);
  const codeGone = and(or(isNotNull(signinCode.usedAt), lt(signinCode.expiresAt, now)), lt(signinCode.createdAt, new Date(now.getTime() - RESEND_AFTER_MS)));
  const sessionGone = lt(parentAuthSession.expiresAt, now);
  await tx.select({ id: parent.id }).from(parent).where(or(
    inArray(parent.id, tx.select({ id: parentEmailChange.parentId }).from(parentEmailChange).where(requestGone)),
    inArray(parent.id, tx.select({ id: signinCode.parentId }).from(signinCode).where(codeGone)),
    inArray(parent.id, tx.select({ id: parentAuthUser.parentId }).from(parentAuthUser).innerJoin(parentAuthSession, eq(parentAuthSession.userId, parentAuthUser.id)).where(sessionGone)),
  )).orderBy(parent.id).for("update");
  const emailChanges = n(await tx.delete(parentEmailChange).where(requestGone).returning({ id: parentEmailChange.id }));
  const signinCodes = n(await tx.delete(signinCode).where(codeGone).returning({ id: signinCode.id }));
  const parentSessions = n(await tx.delete(parentAuthSession).where(sessionGone).returning({ id: parentAuthSession.id }));

  const kinds = Object.keys(RATE_LIMITS) as RateLimitKind[];
  let rateLimitEvents = 0;
  for (const kind of kinds) {
    rateLimitEvents += n(await tx.delete(rateLimitEvent)
      .where(and(eq(rateLimitEvent.kind, kind), lt(rateLimitEvent.at, new Date(now.getTime() - RATE_LIMITS[kind].windowMs)))).returning({ id: rateLimitEvent.id }));
  }
  // A kind this version doesn't know (left by another version) is kept for the longest window any kind has.
  const longest = Math.max(...kinds.map((k) => RATE_LIMITS[k].windowMs));
  rateLimitEvents += n(await tx.delete(rateLimitEvent)
    .where(and(notInArray(rateLimitEvent.kind, kinds), lt(rateLimitEvent.at, new Date(now.getTime() - longest)))).returning({ id: rateLimitEvent.id }));

  // A family's figures go only when its family customer (the customer its family record's own link names, in the
  // roster's company) is gone from the roster cache altogether: never because the family is inactive, since an inactive
  // customer is still in the cache. Skipped while the cache is empty.
  const money = n(await tx.delete(familyMoney)
    .where(sql`exists (select 1 from qbo_customer) and not exists (select 1 from accounting_link l join qbo_customer c on c.qbo_id = l.customer_id
      where l.family_id = ${familyMoney.familyId} and l.system = 'quickbooks'
        and l.realm_id = (select s.value->>'realmId' from setting s where s.key = 'roster.source'))`)
    .returning({ id: familyMoney.familyId }));

  const cutoff = new Date(now.getTime() - JOB_HISTORY_DAYS * 86_400_000);
  const jobRuns = n(await tx.delete(jobRun).where(and(lt(jobRun.startedAt, cutoff),
    sql`${jobRun.id} <> (select max(j.id) from job_run j where j.job = ${jobRun.job})`,
    sql`${jobRun.id} is distinct from (select max(j.id) from job_run j where j.job = ${jobRun.job} and j.outcome = 'ok')`)).returning({ id: jobRun.id }));

  const yearAgo = new Date(now.getTime() - REMINDER_CLAIM_DAYS * 86_400_000);
  const reminderClaims = n(await tx.delete(formReminderClaim).where(lt(formReminderClaim.createdAt, yearAgo)).returning({ id: formReminderClaim.id }))
    + n(await tx.delete(formReminderRound).where(lt(formReminderRound.createdAt, yearAgo)).returning({ id: formReminderRound.id }))
    + n(await tx.delete(requirementReminder).where(lt(requirementReminder.createdAt, yearAgo)).returning({ id: requirementReminder.id }));
  const writes = n(await tx.delete(writeQueue).where(and(inArray(writeQueue.state, ["done", "given_up"]),
    lt(writeQueue.finishedAt, new Date(now.getTime() - FINISHED_WRITES_DAYS * 86_400_000)))).returning({ id: writeQueue.id }));

  const verifications = n(await tx.delete(staffAuthVerification).where(lt(staffAuthVerification.expiresAt, now)).returning({ id: staffAuthVerification.id }))
    + n(await tx.delete(parentAuthVerification).where(lt(parentAuthVerification.expiresAt, now)).returning({ id: parentAuthVerification.id }));

  const retiredSettings = n(await tx.delete(setting).where(inArray(setting.key, [...RETIRED_SETTINGS])).returning({ key: setting.key }));

  return { staffSessions, parentSessions, signinCodes, rateLimitEvents, emailChanges, familyMoney: money, jobRuns, reminderClaims, writeQueue: writes, verifications, retiredSettings };
}

/**
 * One run of the daily clean-up, recorded in the job history. The deletes and the audit row are one transaction: a
 * run that removed something leaves exactly one `cleanup.run` audit row with the counts, and a run that removed
 * nothing leaves none. `now` decides what has expired, so it is always the real time outside a test.
 */
export async function runCleanup(now: Date = new Date()): Promise<{ ok: boolean; counts: CleanupCounts | null }> {
  const [run] = await db.insert(jobRun).values({ job: CLEANUP_JOB, startedBy: "worker" }).returning();
  try {
    const counts = await db.transaction(async (tx) => {
      const c = await cleanUp(tx, now);
      if (removedInAll(c) > 0) {
        await writeAudit({ actor: CLEANUP_ACTOR, action: "cleanup.run", targetType: "job_run", targetId: String(run!.id), after: c }, tx);
      }
      return c;
    });
    await db.update(jobRun).set({ finishedAt: new Date(), outcome: "ok", detail: describeCleanup(counts) }).where(eq(jobRun.id, run!.id));
    return { ok: true, counts };
  } catch {
    // Nothing of the error is kept: it could quote a row.
    await db.update(jobRun).set({ finishedAt: new Date(), outcome: "failed", detail: "The clean-up couldn't finish. Nothing was removed. (unexpected)" }).where(eq(jobRun.id, run!.id));
    return { ok: false, counts: null };
  }
}
