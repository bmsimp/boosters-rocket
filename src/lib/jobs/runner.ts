import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { jobRun, setting } from "@/lib/db/schema";
import { accessToken, WORKER_ACTOR } from "@/lib/quickbooks/client";
import { connectionView } from "@/lib/quickbooks/connection";
import { QboError } from "@/lib/quickbooks/endpoints";
import { refreshRoster, ROSTER_JOB } from "@/lib/roster/refresh";

export const TOKEN_JOB = "quickbooks.token_refresh";
export const WAKE_KEY = "worker.last_wake";
const DUE_MS = 24 * 3_600_000;
const RETRY_MS = 15 * 60_000;

/** Due when the last successful run is more than 24 hours old, and the last attempt of any kind is at least 15 minutes old (spec §4). */
async function due(job: string, now: Date): Promise<boolean> {
  const [lastOk] = await db.select().from(jobRun).where(and(eq(jobRun.job, job), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1);
  if (lastOk?.finishedAt && now.getTime() - lastOk.finishedAt.getTime() <= DUE_MS) return false;
  const [last] = await db.select().from(jobRun).where(eq(jobRun.job, job)).orderBy(desc(jobRun.id)).limit(1);
  return !last || now.getTime() - last.startedAt.getTime() >= RETRY_MS;
}

/** One wake of the worker: records it, then runs whichever jobs are due. `now` is only for deciding what is due. */
export async function runDueJobs(now: Date = new Date()): Promise<{ ran: { job: string; ok: boolean }[] }> {
  const wake = { at: new Date().toISOString() };
  await db.insert(setting).values({ key: WAKE_KEY, value: wake }).onConflictDoUpdate({ target: setting.key, set: { value: wake, updatedAt: new Date() } });
  const ran: { job: string; ok: boolean }[] = [];
  if (!(await connectionView()).connected) return { ran };
  if (await due(TOKEN_JOB, now)) {
    const [run] = await db.insert(jobRun).values({ job: TOKEN_JOB, startedBy: "worker", startedAt: now }).returning();
    try {
      await accessToken({ force: true }); // spends the refresh token so a quiet summer can't let it lapse; failures are audited there
      await db.update(jobRun).set({ finishedAt: now, outcome: "ok" }).where(eq(jobRun.id, run!.id));
      ran.push({ job: TOKEN_JOB, ok: true });
    } catch (e) {
      // A QboError's message is a fixed sentence and its code a short code; anything else is recorded without its text.
      const detail = e instanceof QboError ? `${e.message} (${e.code})` : "The connection couldn't be refreshed. (unexpected)";
      await db.update(jobRun).set({ finishedAt: now, outcome: "failed", detail }).where(eq(jobRun.id, run!.id));
      ran.push({ job: TOKEN_JOB, ok: false });
    }
  }
  if (await due(ROSTER_JOB, now)) {
    const r = await refreshRoster({ startedBy: "worker", actor: WORKER_ACTOR, ip: null });
    if (r.ok || r.reason === "failed") ran.push({ job: ROSTER_JOB, ok: r.ok });
  }
  return { ran };
}

/** When the worker last checked in, for the settings view. */
export async function lastWake(): Promise<string | null> {
  const [row] = await db.select().from(setting).where(eq(setting.key, WAKE_KEY));
  const at = (row?.value as { at?: unknown } | undefined)?.at;
  return typeof at === "string" ? at : null;
}
