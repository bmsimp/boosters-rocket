import { and, eq, inArray, isNotNull, lt, notInArray, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { familyMoney, jobRun, parentAuthSession, parentEmailChange, rateLimitEvent, signinCode, staffAuthSession, writeQueue } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { RATE_LIMITS, type RateLimitKind } from "@/lib/parents/rate-limit";
import { RESEND_AFTER_MS } from "@/lib/parents/signin-codes";

export const CLEANUP_JOB = "cleanup.daily";
/** Job history is kept this long. The newest run of each job, and its newest run that worked, are kept whatever their age. */
export const JOB_HISTORY_DAYS = 90;
/** A staff roster write that went through, or that staff gave up, is kept this long for the Reconciliation page's story. */
export const FINISHED_WRITES_DAYS = 30;
const CLEANUP_ACTOR: Actor = { door: "system", id: null, label: "worker" };

export type CleanupCounts = {
  staffSessions: number; parentSessions: number; signinCodes: number; rateLimitEvents: number;
  emailChanges: number; familyMoney: number; jobRuns: number; writeQueue: number;
};
const WORDS: Record<keyof CleanupCounts, [string, string]> = {
  staffSessions: ["expired staff session", "expired staff sessions"], parentSessions: ["expired parent session", "expired parent sessions"],
  signinCodes: ["sign-in code", "sign-in codes"], rateLimitEvents: ["rate-limit record", "rate-limit records"],
  emailChanges: ["expired email change", "expired email changes"], familyMoney: ["set of figures for a family no longer in the roster", "sets of figures for families no longer in the roster"],
  jobRuns: ["old job record", "old job records"],
  writeQueue: ["finished change to QuickBooks", "finished changes to QuickBooks"],
};

/**
 * Every table of src/lib/db/schema.ts is named here once: the ones cleanUp() deletes expired rows from, and the ones it
 * leaves alone, with why. A new table must join one list (tests/integration/cleanup.test.ts fails until it does); one
 * whose rows expire gets its delete below and a boundary test.
 */
export const CLEANED_TABLES = ["staff_auth_session", "parent_auth_session", "signin_code", "rate_limit_event", "parent_email_change", "family_money", "job_run", "write_queue"] as const;
export const KEPT_TABLES: Record<string, string> = {
  staff_auth_user: "Better Auth's staff accounts", staff_auth_account: "Better Auth's staff accounts", staff_auth_verification: "Better Auth's own, short-lived and kept by it",
  parent_auth_user: "Better Auth's parent accounts", parent_auth_account: "Better Auth's parent accounts", parent_auth_verification: "Better Auth's own, short-lived and kept by it",
  setting: "the portal's settings, replaced in place",
  auth_provider: "the staff sign-in set-up", provider_certificate: "the staff sign-in set-up, rotated by an Admin",
  staff_user: "staff accounts, removed by an Admin", role: "roles", role_rule: "roles", role_assignment: "roles",
  parent: "parents, kept from QuickBooks by the roster refresh", guardian: "links from parents to families, kept by the roster refresh",
  held_address: "addresses held for staff to decide", family_match: "staff decisions about families",
  qbo_connection: "the one QuickBooks connection", qbo_customer_type: "the roster cache, replaced by each refresh", qbo_customer: "the roster cache, replaced by each refresh",
  qbo_item: "QuickBooks' products and services, replaced each time staff read the list; emptied on a change of company",
  season: "seasons are history", season_step: "seasons are history", requirement: "seasons are history", requirement_cover: "seasons are history",
  requirement_progress: "ticks and waivers: a season's record",
  volunteer_event: "volunteer history: what happened stays readable", volunteer_shift: "volunteer history", volunteer_shift_requirement: "volunteer history",
  volunteer_signup: "who volunteered: emptied on a change of company, otherwise kept",
  signature_request: "a form's record of signing: evidence, never expires", signature_consent: "a guardian's consent to sign electronically: evidence, never expires",
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
 * - Staff roster writes that went through or were given up more than FINISHED_WRITES_DAYS ago. Waiting and stuck ones
 *   stay until they finish.
 *
 * The audit log is never touched: it is append-only.
 */
export async function cleanUp(tx: Tx, now: Date = new Date()): Promise<CleanupCounts> {
  const n = (rows: unknown[]) => rows.length;
  const staffSessions = n(await tx.delete(staffAuthSession).where(lt(staffAuthSession.expiresAt, now)).returning({ id: staffAuthSession.id }));
  const parentSessions = n(await tx.delete(parentAuthSession).where(lt(parentAuthSession.expiresAt, now)).returning({ id: parentAuthSession.id }));
  const signinCodes = n(await tx.delete(signinCode)
    .where(and(or(isNotNull(signinCode.usedAt), lt(signinCode.expiresAt, now)), lt(signinCode.createdAt, new Date(now.getTime() - RESEND_AFTER_MS))))
    .returning({ id: signinCode.id }));

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

  const emailChanges = n(await tx.delete(parentEmailChange).where(lt(parentEmailChange.expiresAt, now)).returning({ id: parentEmailChange.id }));
  const money = n(await tx.delete(familyMoney)
    .where(sql`exists (select 1 from qbo_customer) and not exists (select 1 from qbo_customer c where c.qbo_id = ${familyMoney.familyQboId})`)
    .returning({ id: familyMoney.familyQboId }));

  const cutoff = new Date(now.getTime() - JOB_HISTORY_DAYS * 86_400_000);
  const jobRuns = n(await tx.delete(jobRun).where(and(lt(jobRun.startedAt, cutoff),
    sql`${jobRun.id} <> (select max(j.id) from job_run j where j.job = ${jobRun.job})`,
    sql`${jobRun.id} is distinct from (select max(j.id) from job_run j where j.job = ${jobRun.job} and j.outcome = 'ok')`)).returning({ id: jobRun.id }));

  const writes = n(await tx.delete(writeQueue).where(and(inArray(writeQueue.state, ["done", "given_up"]),
    lt(writeQueue.finishedAt, new Date(now.getTime() - FINISHED_WRITES_DAYS * 86_400_000)))).returning({ id: writeQueue.id }));

  return { staffSessions, parentSessions, signinCodes, rateLimitEvents, emailChanges, familyMoney: money, jobRuns, writeQueue: writes };
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
