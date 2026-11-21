import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { buyout, familyMoney, writeQueue, type BuyoutState } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { checksOwnFlag } from "./closing";
import { paidIn } from "./rules";

// This module is called from src/lib/roster/source.ts, so it must import nothing from src/lib/roster/ (nor
// src/lib/money/stored.ts, which does), and nothing staff-only: source.ts is reached from parent code. ./closing.ts and
// ./rules.ts are pure.

/** A buy-out that stands with nothing paid on it as far as the portal knows: being invoiced, invoiced, being cancelled, or stuck. */
const UNPAID_LIVE: BuyoutState[] = ["being_invoiced", "invoiced", "being_voided", "stuck"];

/** The flags a void or a move leaves that a paid buy-out of an earlier company reads as a refund owed (earlierCompanyLook(), ./closing.ts). */
const KEPT_AS_REFUND = new Set<string>(["paid_before_void", "student_moved"]);

/**
 * Called inside clearRosterOfOtherCompanyLocked() (src/lib/roster/source.ts), under the roster lock, in its transaction,
 * before the queue is given up (stage 4's slice M7a, open question 16): a buy-out's customer, item and invoice are the
 * old company's, and nothing can be sent there now. Every unpaid live buy-out ends, `voided` with `end_reason`
 * `earlier_company`, in the portal alone, as one staff close does: nothing is sent to QuickBooks, and its invoice stays
 * in the old company's books for the treasurer. Its customer, item, invoice, company, flag and when it was flagged are
 * kept as they were, for the treasurer's list (stage 4's slice M7b). A paid one keeps counting, as it is, and so does
 * an invoiced one its family's stored figures show paid, which is marked paid first (markPaidAsStored(), slice M7b2); a
 * voided or refused one is history already. The family may choose again for that requirement, as far as the database
 * goes: the live indexes no longer hold it.
 *
 * One statement, which takes each row's lock: a void being queued at that moment (queueVoid(), src/lib/buyouts/writes.ts,
 * which moves an invoiced one to being voided holding no roster lock) either committed first, and its buy-out ends here
 * and its void is given up with the rest of the queue, or waits for this, and then finds the buy-out no longer
 * invoiced and queues nothing. Which state each was in, the paid ones kept and the ids ended are audited; nothing is
 * written when there was nothing. A buy-out write the worker is sending at that moment is not closed here: its finish
 * takes the roster lock shared, so it runs before or after the clear, never beside it, and after it leaves the item
 * given up and the buy-out ended (an invoice made meanwhile recorded on it: src/lib/buyouts/writes.ts, stage 4's
 * slice M7a2).
 */
export async function endBuyoutsOfEarlierCompany(tx: Tx, o: { fromRealmId: string; toRealmId: string; actor: Actor; ip: string | null }): Promise<void> {
  await markPaidAsStored(tx, o);
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

/**
 * Before the ending (stage 4's slice M7b2, the owner's reading of open question 16, 2026-11-21): every invoiced buy-out
 * of the earlier company whose own family's stored figures (`family_money`, kept by the family that chose it, per-student
 * ones too, whether or not the student is still in it), read from that same company, show its invoice paid (paidIn(),
 * ./rules.ts) is marked `paid`, so it keeps counting, as a paid one does: until this moment the family read "Paid
 * instead" for it (buyoutFacts(), ./standing.ts), and QuickBooks can no longer be asked for the old company's invoice.
 * The figures count as stored, whatever their age, a mark that they are behind or a failed last read, as buyoutFacts()
 * counts them; the audit row says so, with their dates. A family with no figures, or none of that company, has nothing
 * to mark by. Only `invoiced`: one being invoiced, being cancelled or stuck ends with the rest.
 *
 * As the daily check marks one paid (checkBuyoutInvoices(), ./daily-check.ts): its flag comes off only when it is the
 * check's own (checksOwnFlag(), ./closing.ts, read with whether a void was ever queued for it), and a void's or a move's
 * stays, so a buy-out paid though its void was asked for still reads as a refund owed; its customer, item, invoice,
 * company, units and amount are kept; audited `volunteer.buyout.paid` with the clear's actor. Nothing is sent or queued.
 * One flagged otherwise (`void_refused`: QuickBooks refused the void a switch back asked for; `given_up`) is not marked:
 * paid, it would read as nothing to settle and leave every list (earlierCompanyLook(), ./closing.ts, reads a refund owed
 * only for KEPT_AS_REFUND), so it ends with the rest and stays on the treasurer's list, as before this slice.
 *
 * The candidates are read FOR UPDATE, under the roster lock the caller holds: a void queued at that moment (queueVoid(),
 * src/lib/buyouts/writes.ts, holding no roster lock) either committed first, and its buy-out, being voided now, is no
 * candidate and ends as today, or waits for this transaction, and then finds the buy-out paid and queues nothing. One
 * the daily check marked paid first is no candidate either, and is not audited twice.
 */
async function markPaidAsStored(tx: Tx, o: { fromRealmId: string; actor: Actor; ip: string | null }): Promise<void> {
  const candidates = await tx.select().from(buyout)
    .where(and(eq(buyout.state, "invoiced"), isNotNull(buyout.invoiceQboId), eq(buyout.realmId, o.fromRealmId))).orderBy(asc(buyout.id)).for("update");
  if (candidates.length === 0) return;
  const figures = await tx.select({ familyId: familyMoney.familyId, realmId: familyMoney.realmId, readAt: familyMoney.readAt, staleAt: familyMoney.staleAt,
    invoices: familyMoney.invoices }).from(familyMoney).where(inArray(familyMoney.familyId, [...new Set(candidates.map((b) => b.familyId))]));
  const of = new Map(figures.map((f) => [f.familyId, f]));
  const paid = candidates.filter((b) => {
    const f = of.get(b.familyId);
    return f !== undefined && f.realmId === b.realmId && f.realmId === o.fromRealmId && paidIn(f.invoices, b.invoiceQboId);
  });
  if (paid.length === 0) return;
  // The buy-outs a void was ever queued for: a `student_moved` flag beside one is a move's or a void's, never the check's own.
  const voidsFor = new Set((await tx.select({ id: sql<string>`${writeQueue.request}->>'buyoutId'` }).from(writeQueue)
    .where(and(sql`${writeQueue.request}->>'op' = 'invoice_void'`, inArray(sql<string>`${writeQueue.request}->>'buyoutId'`, paid.map((b) => b.id))))).map((r) => r.id));
  for (const b of paid) {
    const f = of.get(b.familyId)!;
    const own = checksOwnFlag({ state: b.state, flag: b.flag, lastCode: b.lastCode, items: voidsFor.has(b.id) ? [{ op: "invoice_void" }] : [] });
    if (b.flag !== null && !own && !KEPT_AS_REFUND.has(b.flag)) continue;
    const [done] = await tx.update(buyout).set({ state: "paid", ...(own ? { flag: null, flaggedAt: null } : {}), updatedAt: new Date() })
      .where(and(eq(buyout.id, b.id), eq(buyout.state, "invoiced"))).returning({ id: buyout.id });
    if (!done) continue;
    await writeAudit({ actor: o.actor, action: "volunteer.buyout.paid", targetType: "buyout", targetId: b.id, ip: o.ip,
      before: { state: "invoiced", ...(own ? { flag: b.flag } : {}) },
      after: { state: "paid", ...(own ? { flag: null } : {}), invoiceQboId: b.invoiceQboId, amountCents: b.amountCents, why: "different_company", realmId: o.fromRealmId,
        figures: "as_stored", figuresReadAt: f.readAt?.toISOString() ?? null, figuresStaleAt: f.staleAt?.toISOString() ?? null } }, tx);
  }
}
