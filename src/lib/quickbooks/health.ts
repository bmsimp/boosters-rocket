import { connectionView } from "./connection";
import { loadRosterPage } from "@/lib/roster/queries";

export type QboProblem = { kind: "token_failed" | "expiring" | "roster_failed" | "roster_old" | "shape_broken"; text: string };
const EXPIRING_MS = 30 * 86_400_000;
const OLD_MS = 48 * 3_600_000;

/** What Admins are warned about on the staff home (spec §5 The staff warning). Nothing on a site that isn't connected. */
export async function quickbooksProblems(now: Date = new Date()): Promise<QboProblem[]> {
  const conn = await connectionView();
  if (!conn.connected) return [];
  const page = await loadRosterPage();
  const out: QboProblem[] = [];
  if (conn.lastError) out.push({ kind: "token_failed", text: `The QuickBooks connection couldn't be refreshed: ${conn.lastError}` });
  if (conn.refreshExpiresAt && Date.parse(conn.refreshExpiresAt) - now.getTime() < EXPIRING_MS) {
    out.push({ kind: "expiring", text: "The QuickBooks connection expires within 30 days. Connect QuickBooks again to renew it." });
  }
  const since = page.lastOkAt ?? conn.connectedAt;
  if (page.lastRun && !page.lastRun.ok) out.push({ kind: "roster_failed", text: `The last roster refresh failed: ${page.lastRun.detail ?? "no reason was recorded"}` });
  else if (since && now.getTime() - Date.parse(since) > OLD_MS) {
    out.push({ kind: "roster_old", text: "The roster hasn't been refreshed from QuickBooks in more than 2 days. Check that the worker is running." });
  }
  if (page.brokenTypes.length) out.push({ kind: "shape_broken", text: "The membership shape names a customer type QuickBooks no longer has. Choose the shape again." });
  return out;
}
