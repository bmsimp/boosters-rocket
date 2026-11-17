import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { qboCheckRecord, qboCheckRun, type CheckResult, type QboEnvironment } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { errorNeedsAdmin } from "@/lib/quickbooks/endpoints";
import { getConnection } from "@/lib/quickbooks/connection";
import { getRosterSource } from "@/lib/roster/source";
import { untriedChanges } from "./expectations";

/**
 * What the check of the portal's requests shows (./run.ts): whether it can run against the connection now, its runs,
 * and the records a cut-off run left open. Read by the check's page, the QuickBooks settings view and the Health page.
 * Nothing here sends a request.
 */
export type NotReady = "not_connected" | "needs_admin" | "not_quickbooks";
export type Readiness = { ok: true; realmId: string; environment: QboEnvironment } | { ok: false; reason: NotReady };

export const NOT_READY_WORDS: Record<NotReady, string> = {
  not_connected: "QuickBooks isn't connected, so there is nothing to check. Connect a company in QuickBooks settings first.",
  needs_admin: "The QuickBooks connection needs to be connected again before the check can run. Open the QuickBooks steps and sign in to Intuit again.",
  not_quickbooks: "This connection can't be checked: the portal's copy of its roster holds IDs QuickBooks never gives, so it isn't a company the portal can reach. "
    + "That is how the portal's own browser tests set QuickBooks up, with a made-up connection that nothing may send to Intuit.",
};

/** A QuickBooks id as QuickBooks gives one: digits only. */
const DIGITS = "^[0-9]{1,19}$";

/**
 * Whether the check may send anything to the connected company. Decided before any request: a company that isn't
 * connected, a connection only an Admin can mend, or one whose roster copy (read from this same company) holds ids that
 * aren't QuickBooks ids. The last is the browser test run's made-up connection: its roster's ids are not digits, its
 * tokens are made up, and nothing in that run may reach Intuit. The roster copy is only read here, never changed.
 */
export async function checkReadiness(): Promise<Readiness> {
  const c = await getConnection();
  if (!c?.realmId || !c.refreshTokenCiphertext) return { ok: false, reason: "not_connected" };
  if (errorNeedsAdmin(c.lastError)) return { ok: false, reason: "needs_admin" };
  if (!new RegExp(DIGITS).test(c.realmId)) return { ok: false, reason: "not_quickbooks" };
  if ((await getRosterSource()) === c.realmId) {
    const [odd] = Array.from(await db.execute<{ odd: boolean }>(sql`select (exists (select 1 from qbo_customer where qbo_id !~ ${DIGITS})
      or exists (select 1 from qbo_customer_type where qbo_id !~ ${DIGITS})) as odd`));
    if (odd?.odd) return { ok: false, reason: "not_quickbooks" };
  }
  return { ok: true, realmId: c.realmId, environment: c.environment };
}

export type RunView = {
  id: string; startedAt: string; finishedAt: string | null; startedBy: string | null; environment: QboEnvironment; writes: boolean; tag: string;
  outcome: "passed" | "not_as_expected" | "incomplete" | "stopped" | "cut_off" | null; stopCode: string | null; results: CheckResult[];
  /** Whether it was run against the company connected now. */
  thisCompany: boolean;
};
export type OpenRecord = { id: string; kind: string; name: string; tag: string; lastCode: string | null };
export type CheckPageView = { readiness: Readiness; environment: QboEnvironment | null; latest: RunView | null; earlier: RunView[]; open: OpenRecord[] };

const runView = (r: typeof qboCheckRun.$inferSelect, realmId: string | null): RunView => ({
  id: r.id, startedAt: r.startedAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null, startedBy: r.startedByLabel, environment: r.environment,
  writes: r.writes, tag: r.tag, outcome: r.outcome, stopCode: r.stopCode, results: r.results, thisCompany: r.realmId === realmId,
});

/** Everything the check's page shows. */
export async function checkPageView(): Promise<CheckPageView> {
  const [readiness, c] = await Promise.all([checkReadiness(), getConnection()]);
  const realmId = c?.realmId ?? null;
  const runs = (await db.select().from(qboCheckRun).orderBy(desc(qboCheckRun.startedAt)).limit(11)).map((r) => runView(r, realmId));
  const open = realmId === null ? [] : await db.select({ id: qboCheckRecord.id, kind: qboCheckRecord.kind, name: qboCheckRecord.name, tag: qboCheckRun.tag, lastCode: qboCheckRecord.lastCode })
    .from(qboCheckRecord).innerJoin(qboCheckRun, eq(qboCheckRecord.runId, qboCheckRun.id))
    .where(and(eq(qboCheckRecord.realmId, realmId), isNull(qboCheckRecord.closedAt), isNotNull(qboCheckRun.finishedAt))).orderBy(qboCheckRecord.createdAt);
  return { readiness, environment: c?.environment ?? null, latest: runs[0] ?? null, earlier: runs.slice(1), open };
}

export type LastCheck = { at: string; outcome: "passed" | "not_as_expected" | "incomplete" | "stopped" | "cut_off"; environment: QboEnvironment; writes: boolean; notAsExpected: number; notTried: number } | null;

/** When the requests were last checked, and how it went: for the QuickBooks settings view and the Health page. */
export async function lastCheck(): Promise<LastCheck> {
  const [r] = await db.select().from(qboCheckRun).where(isNotNull(qboCheckRun.finishedAt)).orderBy(desc(qboCheckRun.startedAt)).limit(1);
  if (!r?.outcome) return null;
  return { at: r.finishedAt!.toISOString(), outcome: r.outcome, environment: r.environment, writes: r.writes, notAsExpected: r.results.filter((x) => x.outcome === "not_as_expected").length, notTried: untriedChanges(r.results) };
}

/** The words for the last check, one sentence, as the settings view and the Health page say it. */
export function lastCheckWords(l: LastCheck): string {
  if (!l) return "The portal's requests to QuickBooks haven't been checked against a company yet.";
  const against = l.environment === "sandbox" ? (l.writes ? "an Intuit sandbox company, reads and changes" : "an Intuit sandbox company, reads only") : "the club's real books, reads only";
  if (l.outcome === "passed") return `Last checked against ${against}: every request answered as the portal expects.`;
  if (l.outcome === "incomplete") return `Last checked against ${against}: every request tried answered as the portal expects, but ${l.notTried === 1 ? "1 of the changes wasn't" : `${l.notTried} of the changes weren't`} tried, so the check should be run again.`;
  if (l.outcome === "not_as_expected") return `Last checked against ${against}: ${l.notAsExpected === 1 ? "1 request didn't" : `${l.notAsExpected} requests didn't`} answer as the portal expects.`;
  return `The last check, against ${against}, didn't finish.`;
}

/**
 * Called inside clearRosterOfOtherCompanyLocked(): the records the check made belong to the company that is no longer
 * connected, so they go (the runs, which hold no customer's id, stay). The caller owns the transaction.
 */
export async function clearCheckRecords(tx: Tx, o: { actor: Actor; ip: string | null }): Promise<void> {
  const gone = await tx.delete(qboCheckRecord).returning({ id: qboCheckRecord.id });
  if (gone.length) await writeAudit({ actor: o.actor, action: "quickbooks.check.records.cleared", targetType: "qbo_check_record", targetId: "all", after: { deleted: gone.length }, ip: o.ip }, tx);
}
