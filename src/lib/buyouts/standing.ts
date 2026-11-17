// What the volunteer kind's rule (src/lib/seasons/kinds.ts) reads of buy-outs: for these requirements and these
// families or students, each live buy-out's state and whether its invoice is paid in the stored figures. Parent pages
// reach it with the session's family alone: with `subjectQboIds` only those subjects' buy-outs and their own families'
// stored figures are read. It imports no staff-only module (tests/integration/page-guards.test.ts scans this file).
import "server-only";
import { and, inArray } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { buyout, qboCustomer, type StoredInvoice } from "@/lib/db/schema";
import { moneyRows } from "@/lib/money/stored";
import { getRosterSource } from "@/lib/roster/source";
import { LIVE_STATES, type BuyoutFact } from "./rules";

/** Whether this invoice is paid in these stored figures: there, for something (a voided one has a total of 0), and nothing left to pay. */
export const paidIn = (invoices: readonly StoredInvoice[] | null | undefined, invoiceQboId: string | null): boolean =>
  invoiceQboId !== null && (invoices ?? []).some((i) => i.qboId === invoiceQboId && i.totalCents > 0 && i.balanceCents <= 0);

/**
 * The live buy-outs for these requirements, by `${requirementId}|${subjectQboId}` (pairKey), for these families or
 * students (null: everyone, for staff). A per-student buy-out counts for its student only while the student is in the
 * family it was chosen from: a student who has moved brings nothing of the old family's choice to the new one, and the
 * old family no longer has the student to count it for.
 */
export async function buyoutFacts(requirementIds: readonly string[], subjectQboIds: readonly string[] | null, tx?: Tx): Promise<Map<string, BuyoutFact>> {
  const out = new Map<string, BuyoutFact>();
  if (requirementIds.length === 0 || subjectQboIds?.length === 0) return out;
  const q = tx ?? db;
  const rows = await q.select({ requirementId: buyout.requirementId, familyQboId: buyout.familyQboId, subjectQboId: buyout.subjectQboId, state: buyout.state,
    invoiceQboId: buyout.invoiceQboId, realmId: buyout.realmId }).from(buyout)
    .where(and(inArray(buyout.requirementId, [...requirementIds]), inArray(buyout.state, [...LIVE_STATES]), subjectQboIds ? inArray(buyout.subjectQboId, [...subjectQboIds]) : undefined));
  if (rows.length === 0) return out;
  const students = [...new Set(rows.filter((r) => r.subjectQboId !== r.familyQboId).map((r) => r.subjectQboId))];
  const under = students.length === 0 ? [] : await q.select({ qboId: qboCustomer.qboId, parentQboId: qboCustomer.parentQboId }).from(qboCustomer).where(inArray(qboCustomer.qboId, students));
  const familyOf = new Map(under.map((u) => [u.qboId, u.parentQboId]));
  const kept = rows.filter((r) => r.subjectQboId === r.familyQboId || familyOf.get(r.subjectQboId) === r.familyQboId);
  const [money, source] = await Promise.all([moneyRows([...new Set(kept.map((r) => r.familyQboId))], tx), getRosterSource(tx)]);
  for (const r of kept) {
    const row = money.get(r.familyQboId);
    // Figures from another company than the buy-out's, or than the roster's, say nothing about its invoice.
    const figures = row && row.realmId === r.realmId && row.realmId === source ? row.invoices : null;
    out.set(`${r.requirementId}|${r.subjectQboId}`, { state: r.state, invoicePaid: paidIn(figures, r.invoiceQboId) });
  }
  return out;
}
