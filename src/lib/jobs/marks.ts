// What the worker last did in jobs that keep no job_run row of their own, for the Health page
// (src/lib/health/job-lines.ts, report.ts): the volunteer reminders, which look every wake, the daily check of the
// buy-out invoices, which follows each read of every family, the sweep of expired passkey challenges at each wake (read
// by nothing yet: counts kept for whoever looks), and the welcome emails, whose mark also decides how many a
// wake tries while mail is failing (sendOwedWelcomes(), src/lib/parents/welcome.ts). Counts and times only: never an
// address, a name or an id.
import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";

export const REMINDERS_MARK = "worker.mark.volunteer_reminders";
export const BUYOUT_CHECK_MARK = "worker.mark.buyout_check";
export const WELCOME_MARK = "worker.mark.welcomes";
/** The worker's sweep of expired passkey challenges at each wake (sweepExpiredChallenges(), ./cleanup.ts): how many it removed. */
export const CHALLENGE_SWEEP_MARK = "worker.mark.challenge_sweep";

export type JobMark = {
  /** When the job last ran, whatever it did. */
  ranAt: string | null;
  /**
   * When it last ran with nothing failing, as far as clearing a failure goes: after some of its tries failed
   * ("some_failed"), only a run that did something with nothing failing; after one that stopped with an error, any run
   * that finished. A failed reminder isn't tried again for 15 minutes, so the wakes in between, sending nothing, say
   * nothing about whether mail works.
   */
  okAt: string | null;
  /** When it last did something (sent a reminder, changed a buy-out), and what, in counts. */
  didAt: string | null;
  did: Record<string, number> | null;
  /** When it last failed: it stopped with an error ("threw"), or some of what it tried failed ("some_failed", with how many). */
  failedAt: string | null;
  failure: { kind: "threw" } | { kind: "some_failed"; count: number } | null;
  /**
   * Whether the failure is the latest word: set with failedAt, cleared with okAt. Two runs in one millisecond have
   * equal times, so the order can't be read from them (null in a mark from before it was kept).
   */
  failedLast: boolean | null;
};
const EMPTY: JobMark = { ranAt: null, okAt: null, didAt: null, did: null, failedAt: null, failure: null, failedLast: null };

export async function readMark(key: string, tx?: Tx): Promise<JobMark | null> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, key));
  return row ? { ...EMPTY, ...(row.value as Partial<JobMark>) } : null;
}

/** Whether the job's latest word is a failure: as marked, or, in a mark from before that was kept, by the times. */
export const failedLast = (m: JobMark | null): boolean => typeof m?.failedLast === "boolean" ? m.failedLast
  : Boolean(m?.failedAt && (!m.okAt || m.failedAt > m.okAt));

/**
 * Records one run of a job: `counts` of what it did (all zero when it did nothing) and how many of its tries failed,
 * or "threw" when it stopped with an error. Read and written under a lock of its key, so two wakes marking at once
 * take turns and neither's mark is lost. It never throws itself: a mark that can't be written must not stop the
 * worker's other jobs.
 */
export async function markJob(key: string, outcome: { counts: Record<string, number>; failed: number } | "threw", now = new Date()): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`booster.job_mark:${key}`}))`);
      const at = now.toISOString();
      const before = (await readMark(key, tx)) ?? EMPTY;
      const next: JobMark = { ...before, ranAt: at };
      if (outcome === "threw") Object.assign(next, { failedAt: at, failure: { kind: "threw" }, failedLast: true });
      else {
        const did = Object.values(outcome.counts).some((n) => n > 0);
        if (did) Object.assign(next, { didAt: at, did: outcome.counts });
        if (outcome.failed > 0) Object.assign(next, { failedAt: at, failure: { kind: "some_failed", count: outcome.failed }, failedLast: true });
        else if (did || before.failure?.kind !== "some_failed") Object.assign(next, { okAt: at, failedLast: false });
      }
      await tx.insert(setting).values({ key, value: next }).onConflictDoUpdate({ target: setting.key, set: { value: next, updatedAt: now } });
    });
  } catch {
    // Nothing to do: the next run writes it again.
  }
}
