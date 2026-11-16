// Staff and worker only: the worker's read of every family's invoices (step 4, Money for staff). It loads every family
// in the club, so it is never imported by parent code (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts).
// Each family is read through readFamilyForRun() (./family-money.ts), into the same family_money rows the parent pages
// show, by the same rules: never the wrong company, strict answers, a failed read keeps the last figures.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { jobRun, setting } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { connectionView, getConnection } from "@/lib/quickbooks/connection";
import { WORKER_ACTOR } from "@/lib/quickbooks/client";
import { getShape } from "@/lib/roster/shape";
import { getRosterSource } from "@/lib/roster/source";
import { readFamilyForRun } from "./family-money";
import { familiesCustomers } from "./stored";

import { MONEY_JOB, RUN_KEY } from "./run-keys";

export { MONEY_JOB, RUN_KEY };
/**
 * The gentle pace: at most one request to QuickBooks every this many milliseconds, one at a time. 150 a minute, well
 * inside Intuit's limit of 500 a minute for a company and 10 at once, and leaving room for the parents' own page loads.
 */
export const PACE_MS = 400;
/** How long one wake of the worker spends on the run before it leaves the rest for the next wake, a minute later. */
export const WAKE_BUDGET_MS = 4 * 60_000;
/** A run asked for by staff waits this long after the last one started: the limit protects QuickBooks. */
export const ASK_GAP_MS = 10 * 60_000;
const DUE_MS = 24 * 3_600_000;
const RETRY_MS = 15 * 60_000;
/** The advisory lock that makes one run at a time, in every copy of the portal. */
const RUN_LOCK = 7461003;

/** A family that couldn't be read for one of these reasons is counted and passed over; anything else stops the run, to carry on next time. */
const PASS_OVER = new Set(["bad_answer", "fault", "bad_id", "not_a_family", "http_400"]);

type RunState = {
  /** The job_run row of the run in hand, or null between runs. */
  runId: number | null;
  /** The last family read, in id order: the run, or the next one after a run that stopped, carries on after it. */
  after: string | null;
  /** Where the run in hand started: after the family an earlier run stopped at, or null from the first. */
  startedAfter: string | null;
  read: number; failed: number;
  /** A staff member asked for a run: the next wake starts it. */
  requested: { by: string; label: string | null; at: string } | null;
};
const EMPTY: RunState = { runId: null, after: null, startedAfter: null, read: 0, failed: 0, requested: null };

async function getState(tx?: Tx): Promise<RunState> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, RUN_KEY));
  const v = (row?.value ?? {}) as Partial<RunState>;
  return {
    runId: typeof v.runId === "number" ? v.runId : null, after: typeof v.after === "string" ? v.after : null,
    startedAfter: typeof v.startedAfter === "string" ? v.startedAfter : null,
    read: typeof v.read === "number" ? v.read : 0, failed: typeof v.failed === "number" ? v.failed : 0,
    requested: v.requested && typeof v.requested.by === "string" ? v.requested : null,
  };
}
async function saveState(state: RunState, tx?: Tx): Promise<void> {
  await (tx ?? db).insert(setting).values({ key: RUN_KEY, value: state }).onConflictDoUpdate({ target: setting.key, set: { value: state, updatedAt: new Date() } });
}

/** Every family the roster cache holds, in id order (numbers as numbers): the order a run reads them in. */
async function familiesInOrder(): Promise<string[]> {
  return [...(await familiesCustomers(null)).keys()].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}
const isAfter = (id: string, cursor: string | null) => cursor === null || id.localeCompare(cursor, "en", { numeric: true }) > 0;

/** Due once a day: the last run that read everyone ended more than 24 hours ago, and the last attempt of any kind at least 15 minutes ago. */
async function due(now: Date): Promise<boolean> {
  const [lastOk] = await db.select().from(jobRun).where(and(eq(jobRun.job, MONEY_JOB), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1);
  if (lastOk?.finishedAt && now.getTime() - lastOk.finishedAt.getTime() <= DUE_MS) return false;
  const [last] = await db.select().from(jobRun).where(eq(jobRun.job, MONEY_JOB)).orderBy(desc(jobRun.id)).limit(1);
  return !last || now.getTime() - (last.finishedAt ?? last.startedAt).getTime() >= RETRY_MS;
}

/** At most one call through every `gapMs`, in turn. */
export function pacer(gapMs: number): () => Promise<void> {
  let next = 0;
  return async () => {
    const wait = next - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    next = Date.now() + gapMs;
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const STOP_WORDS: Record<string, string> = {
  not_connected: "QuickBooks isn't connected",
  needs_admin: "QuickBooks needs an Admin to connect it again",
  other_company: "the roster was read from another QuickBooks company than the connected one",
};

export type MoneyJobResult = { ran: false } | { ran: true; finished: boolean; ok: boolean };

/**
 * One wake's share of the run: called by the worker every minute (src/lib/jobs/runner.ts). Starts a run when one is
 * due (once a day) or a staff member asked for one, then reads one family at a time, in id order, at PACE_MS between
 * requests, until every family is read or the wake's budget is spent; what is left is read at the next wake.
 *
 * A family whose answer is refused (an odd answer, an id that can't be sent) is counted and passed over. Anything else
 * (QuickBooks unreachable, slow or refusing, the connection gone, another company) ends the run as failed, saying how
 * far it got: the next run, 15 minutes later, carries on from the family it stopped at. One audit row per run, when it
 * ends. Nothing here runs twice at once: a second caller finds the lock taken and does nothing.
 */
export async function runMoneyJob(o: { now?: Date; budgetMs?: number; paceMs?: number } = {}): Promise<MoneyJobResult> {
  const now = o.now ?? new Date();
  return db.transaction(async (lockTx): Promise<MoneyJobResult> => {
    const [lock] = (await lockTx.execute(sql`select pg_try_advisory_xact_lock(${RUN_LOCK}) as locked`)) as unknown as { locked: boolean }[];
    if (!lock?.locked) return { ran: false };
    let state = await getState();
    const open = state.runId === null ? undefined
      : (await db.select().from(jobRun).where(and(eq(jobRun.id, state.runId), isNull(jobRun.outcome))))[0];
    if (!open) {
      if (!state.requested && !(await due(now))) return { ran: false };
      // Nothing to run and nothing to record, as for the other QuickBooks jobs: QuickBooks not connected, or connected but
      // only an Admin connecting again can mend it, or no roster to read families from (no membership shape, or a cache
      // read from another company than the connected one).
      const [conn, c, shape, source] = await Promise.all([connectionView(), getConnection(), getShape(), getRosterSource()]);
      if (!conn.connected || conn.needsAdmin || shape === null || source === null || source !== c?.realmId) return { ran: false };
      const [run] = await db.insert(jobRun).values({ job: MONEY_JOB, startedBy: state.requested?.by ?? "worker" }).returning();
      // A run that stopped part way left `after`: this one carries on from there.
      state = { ...state, runId: run!.id, startedAfter: state.after, read: 0, failed: 0 };
      await saveState(state);
    }
    const runId = state.runId!;
    // A run under way whose connection has gone, or needs an Admin to connect again, ends here without asking QuickBooks.
    const conn = await connectionView();
    const unusable = !conn.connected ? "not_connected" : conn.needsAdmin ? "needs_admin" : null;
    const requestedBy = state.requested;
    const families = await familiesInOrder();
    const total = families.length;
    const carriedOn = state.startedAfter !== null;
    // A run can be ended from outside while it reads (a change of QuickBooks company ends it and forgets its place):
    // then it writes nothing more, neither its place nor its outcome, which would carry the old company's ids over.
    const stillOpen = async () => (await db.select({ id: jobRun.id }).from(jobRun).where(and(eq(jobRun.id, runId), isNull(jobRun.outcome)))).length > 0;
    const finish = async (outcome: "ok" | "failed", detail: string, after: string | null, code?: string) => {
      await db.transaction(async (tx) => {
        const ended = await tx.update(jobRun).set({ finishedAt: new Date(), outcome, detail }).where(and(eq(jobRun.id, runId), isNull(jobRun.outcome))).returning({ id: jobRun.id });
        if (ended.length === 0) return;
        await saveState({ ...EMPTY, after }, tx);
        await writeAudit({ actor: WORKER_ACTOR, action: outcome === "ok" ? "money.read_all" : "money.read_all.failed", targetType: "job_run", targetId: String(runId),
          after: { families: total, read: state.read, couldNotRead: state.failed, ...(carriedOn ? { carriedOnFromAnEarlierRun: true } : {}),
            ...(code ? { stoppedBy: code } : {}), ...(requestedBy ? { askedBy: { id: requestedBy.by, label: requestedBy.label } } : {}) } }, tx);
      });
    };
    const done = () => `Read ${plural(state.read, "family", "families")}${state.failed ? `; ${plural(state.failed, "family", "families")} couldn't be read` : ""}`;

    if (unusable) {
      await finish("failed", `${done()} of ${total}, then stopped: ${STOP_WORDS[unusable]} (${unusable}). The next run carries on from there.`, state.after, unusable);
      return { ran: true, finished: true, ok: false };
    }
    const pace = pacer(o.paceMs ?? PACE_MS);
    const deadline = Date.now() + (o.budgetMs ?? WAKE_BUDGET_MS);
    for (const familyQboId of families.filter((id) => isAfter(id, state.after))) {
      if (Date.now() >= deadline) return { ran: true, finished: false, ok: true };
      let outcome: Awaited<ReturnType<typeof readFamilyForRun>>;
      try { outcome = await readFamilyForRun(familyQboId, { pace }); } catch { outcome = { ok: false, code: "unexpected" }; }
      if (!(await stillOpen())) return { ran: true, finished: true, ok: false };
      if (!outcome.ok && !PASS_OVER.has(outcome.code)) {
        const why = STOP_WORDS[outcome.code] ?? "QuickBooks couldn't be read";
        await finish("failed", `${done()} of ${total}, then stopped: ${why} (${outcome.code.slice(0, 40)}). The next run carries on from there.`, state.after, outcome.code.slice(0, 40));
        return { ran: true, finished: true, ok: false };
      }
      state = { ...state, after: familyQboId, read: state.read + (outcome.ok ? 1 : 0), failed: state.failed + (outcome.ok ? 0 : 1) };
      await saveState(state);
    }
    await finish("ok", `${done()}${carriedOn ? ", carrying on from where the last run stopped" : ""}.`, null);
    return { ran: true, finished: true, ok: true };
  });
}

export type AskResult = { ok: true } | { ok: false; reason: "running" | "asked" | "too_soon" | "not_connected" };

/**
 * A staff member asks for every family to be read now. The worker starts the run at its next wake, within a minute,
 * so the person's page never waits on QuickBooks. Refused while a run is under way or already asked for, within
 * ASK_GAP_MS of the last run's start, and while QuickBooks isn't connected.
 */
export async function askForMoneyRun(o: { actor: Actor & { id: string }; ip: string | null; permission: string }): Promise<AskResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${RUN_LOCK + 1})`); // two asks at once: one waits for the other
    const state = await getState(tx);
    const conn = await getConnection(tx);
    // Refused, too, while only an Admin connecting again can mend the connection: the worker would never start the run.
    if (!conn?.realmId || !conn.refreshTokenCiphertext || (await getRosterSource(tx)) !== conn.realmId || (await getShape(tx)) === null || (await connectionView()).needsAdmin) return { ok: false, reason: "not_connected" };
    if (state.runId !== null && (await tx.select().from(jobRun).where(and(eq(jobRun.id, state.runId), isNull(jobRun.outcome)))).length) return { ok: false, reason: "running" };
    if (state.requested) return { ok: false, reason: "asked" };
    const [last] = await tx.select().from(jobRun).where(eq(jobRun.job, MONEY_JOB)).orderBy(desc(jobRun.id)).limit(1);
    if (last && Date.now() - last.startedAt.getTime() < ASK_GAP_MS) return { ok: false, reason: "too_soon" };
    await saveState({ ...state, requested: { by: o.actor.id, label: o.actor.label, at: new Date().toISOString() } }, tx);
    await writeAudit({ actor: o.actor, action: "money.read_all.ask", permission: o.permission, targetType: "job_run", ip: o.ip }, tx);
    return { ok: true };
  });
}

export type MoneyRunView = {
  /** The run under way: when it started, and how far it has got. */
  running: { startedAt: string; read: number; failed: number } | null;
  /** A run was asked for and the worker hasn't started it yet. */
  asked: boolean;
  /** The last run that ended. */
  last: { finishedAt: string; ok: boolean; detail: string | null } | null;
};

/** How the worker's read of every family stands, for the Balances page. */
export async function moneyRunView(): Promise<MoneyRunView> {
  const state = await getState();
  const [open] = state.runId === null ? [] : await db.select().from(jobRun).where(and(eq(jobRun.id, state.runId), isNull(jobRun.outcome)));
  const [last] = await db.select().from(jobRun).where(and(eq(jobRun.job, MONEY_JOB), sql`${jobRun.outcome} is not null`)).orderBy(desc(jobRun.id)).limit(1);
  return {
    running: open ? { startedAt: open.startedAt.toISOString(), read: state.read, failed: state.failed } : null,
    asked: state.requested !== null && !open,
    last: last?.finishedAt ? { finishedAt: last.finishedAt.toISOString(), ok: last.outcome === "ok", detail: last.detail } : null,
  };
}
