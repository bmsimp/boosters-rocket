// What the worker last did in two jobs that keep no job_run row of their own, for the Health page
// (src/lib/health/job-lines.ts): the volunteer reminders, which look every wake, and the daily check of the buy-out
// invoices, which follows each read of every family. Counts and times only: never an address, a name or an id.
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";

export const REMINDERS_MARK = "worker.mark.volunteer_reminders";
export const BUYOUT_CHECK_MARK = "worker.mark.buyout_check";

export type JobMark = {
  /** When the job last ran, whatever it did. */
  ranAt: string | null;
  /** When it last ran with nothing failing. */
  okAt: string | null;
  /** When it last did something (sent a reminder, changed a buy-out), and what, in counts. */
  didAt: string | null;
  did: Record<string, number> | null;
  /** When it last failed: it stopped with an error ("threw"), or some of what it tried failed ("some_failed", with how many). */
  failedAt: string | null;
  failure: { kind: "threw" } | { kind: "some_failed"; count: number } | null;
};
const EMPTY: JobMark = { ranAt: null, okAt: null, didAt: null, did: null, failedAt: null, failure: null };

export async function readMark(key: string): Promise<JobMark | null> {
  const [row] = await db.select().from(setting).where(eq(setting.key, key));
  return row ? { ...EMPTY, ...(row.value as Partial<JobMark>) } : null;
}

/**
 * Records one run of a job: `counts` of what it did (all zero when it did nothing) and how many of its tries failed,
 * or "threw" when it stopped with an error. It never throws itself: a mark that can't be written must not stop the
 * worker's other jobs.
 */
export async function markJob(key: string, outcome: { counts: Record<string, number>; failed: number } | "threw", now = new Date()): Promise<void> {
  try {
    const at = now.toISOString();
    const before = (await readMark(key)) ?? EMPTY;
    const next: JobMark = { ...before, ranAt: at };
    if (outcome === "threw") Object.assign(next, { failedAt: at, failure: { kind: "threw" } });
    else {
      if (Object.values(outcome.counts).some((n) => n > 0)) Object.assign(next, { didAt: at, did: outcome.counts });
      if (outcome.failed > 0) Object.assign(next, { failedAt: at, failure: { kind: "some_failed", count: outcome.failed } });
      else next.okAt = at;
    }
    await db.insert(setting).values({ key, value: next }).onConflictDoUpdate({ target: setting.key, set: { value: next, updatedAt: now } });
  } catch {
    // Nothing to do: the next run writes it again.
  }
}
