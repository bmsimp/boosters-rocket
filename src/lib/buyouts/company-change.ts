import { eq, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { buyout, type BuyoutState } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";

// This module is called from src/lib/roster/source.ts, so it must import nothing from src/lib/roster/, and nothing
// staff-only: source.ts is reached from parent code.

/** A buy-out that stands with nothing paid on it as far as the portal knows: being invoiced, invoiced, being cancelled, or stuck. */
const UNPAID_LIVE: BuyoutState[] = ["being_invoiced", "invoiced", "being_voided", "stuck"];

/**
 * Called inside clearRosterOfOtherCompanyLocked() (src/lib/roster/source.ts), under the roster lock, in its transaction,
 * before the queue is given up (stage 4's slice M7a, open question 16): a buy-out's customer, item and invoice are the
 * old company's, and nothing can be sent there now. Every unpaid live buy-out ends, `voided` with `end_reason`
 * `earlier_company`, in the portal alone, as one staff close does: nothing is sent to QuickBooks, and its invoice stays
 * in the old company's books for the treasurer. Its customer, item, invoice, company, flag and when it was flagged are
 * kept as they were, for the treasurer's list (stage 4's slice M7b). A paid one keeps counting, as it is; a voided or
 * refused one is history already. The family may choose again for that requirement, as far as the database goes: the
 * live indexes no longer hold it.
 *
 * One statement, which takes each row's lock: a void being queued at that moment (queueVoid(), src/lib/buyouts/writes.ts,
 * which moves an invoiced one to being voided holding no roster lock) either committed first, and its buy-out ends here
 * and its void is given up with the rest of the queue, or waits for this, and then finds the buy-out no longer
 * invoiced and queues nothing. Which state each was in, the paid ones kept and the ids ended are audited; nothing is
 * written when there was nothing.
 */
export async function endBuyoutsOfEarlierCompany(tx: Tx, o: { fromRealmId: string; toRealmId: string; actor: Actor; ip: string | null }): Promise<void> {
  // The state each was in is the row as this update found it, once its lock was had (RETURNING old: Postgres 18, as
  // every database of the portal is): a row another transaction changed meanwhile is read again after it commits.
  const ended = Array.from(await tx.execute<{ id: string; state_before: BuyoutState }>(sql`
    UPDATE buyout SET state = 'voided', end_reason = 'earlier_company', updated_at = now()
    WHERE state IN ('being_invoiced', 'invoiced', 'being_voided', 'stuck')
    RETURNING id, old.state AS state_before`) as ArrayLike<{ id: string; state_before: BuyoutState }>);
  const paid = await tx.select({ id: buyout.id }).from(buyout).where(eq(buyout.state, "paid"));
  if (ended.length === 0) return;
  const byState = Object.fromEntries(UNPAID_LIVE.map((s) => [s, ended.filter((e) => e.state_before === s).length]));
  await writeAudit({ actor: o.actor, action: "volunteer.buyouts.ended", targetType: "buyout", ip: o.ip,
    before: { realmId: o.fromRealmId, ...byState },
    after: { reason: "different_company", realmId: o.toRealmId, state: "voided", endReason: "earlier_company", ended: ended.length,
      endedIds: ended.map((e) => e.id).sort(), paidKept: paid.length, sentToQuickBooks: false } }, tx);
}
