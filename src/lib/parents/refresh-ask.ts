import { and, desc, eq } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { jobRun, setting } from "@/lib/db/schema";
import { ROSTER_JOB } from "@/lib/roster/source";

/**
 * A request that the worker read the roster again at its next wake, rather than at the daily time. Asked when a
 * parent's change of sign-in address went into QuickBooks while the roster was busy (./email-change.ts): the portal
 * then leaves its copy alone, and the refresh brings the change in with the rest. Nothing runs a refresh here; the
 * worker does (src/lib/jobs/runner.ts).
 *
 * The ask is only a time. It is answered by a successful refresh that started after it; a refresh that failed is tried
 * again after the worker's usual wait, as a failed daily one is. A later ask moves the time on, so the refresh that
 * answers it is one that read QuickBooks after the change.
 */
export const ROSTER_ASK_KEY = "roster.refresh_asked";
const RETRY_MS = 15 * 60_000;

export async function askForRosterRefresh(tx: Tx, now = new Date()): Promise<void> {
  const value = { at: now.toISOString() };
  await tx.insert(setting).values({ key: ROSTER_ASK_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: now } });
}

/** True when a refresh was asked for and no successful one has started since, and the last try is old enough to try again. */
export async function rosterRefreshAsked(now = new Date()): Promise<boolean> {
  const [row] = await db.select({ value: setting.value }).from(setting).where(eq(setting.key, ROSTER_ASK_KEY));
  const raw = (row?.value as { at?: unknown } | undefined)?.at;
  const at = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (Number.isNaN(at)) return false;
  // Strictly after, as the write queue reads the same ask (src/lib/roster/queue.ts): a refresh that started in the
  // ask's own millisecond may have read QuickBooks before the change, so it neither answers the ask nor counts as a try.
  const [lastOk] = await db.select({ startedAt: jobRun.startedAt }).from(jobRun).where(and(eq(jobRun.job, ROSTER_JOB), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1);
  if (lastOk && lastOk.startedAt.getTime() > at) return false;
  const [last] = await db.select({ startedAt: jobRun.startedAt }).from(jobRun).where(eq(jobRun.job, ROSTER_JOB)).orderBy(desc(jobRun.id)).limit(1);
  return !last || last.startedAt.getTime() <= at || now.getTime() - last.startedAt.getTime() >= RETRY_MS;
}
