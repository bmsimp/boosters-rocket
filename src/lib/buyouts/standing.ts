// What the volunteer kind's rule (src/lib/seasons/kinds.ts) reads of buy-outs: for these requirements and these
// families or students (the app's own records), each live buy-out's state and whether its invoice is paid in the stored
// figures. Parent pages reach it with the session's family alone: with `asked` only those records' buy-outs and their
// own families' stored figures are read. It imports no staff-only module (tests/integration/page-guards.test.ts scans
// this file).
import "server-only";
import { and, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { buyout, student, type StoredInvoice } from "@/lib/db/schema";
import { linksOf } from "@/lib/families/links";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import type { SubjectId, SubjectsAsked } from "@/lib/seasons/progress";
import { moneyRows } from "@/lib/money/stored";
import { getRosterSource } from "@/lib/roster/source";
import { LIVE_STATES, type BuyoutFact } from "./rules";

/** Whether this invoice is paid in these stored figures: there, for something (a voided one has a total of 0), and nothing left to pay. */
export const paidIn = (invoices: readonly StoredInvoice[] | null | undefined, invoiceQboId: string | null): boolean =>
  invoiceQboId !== null && (invoices ?? []).some((i) => i.qboId === invoiceQboId && i.totalCents > 0 && i.balanceCents <= 0);

type Row = typeof buyout.$inferSelect;
/** Whom a buy-out is for: its student for a per-student requirement, its family for a per-family one. */
export const subjectOfBuyout = (b: Pick<Row, "familyId" | "studentId">): SubjectId => b.studentId ?? b.familyId;
/** The app's records a buy-out names, as its audit rows write them (open question 17: older rows keep the QuickBooks ids). */
export const buyoutRecords = (b: Pick<Row, "familyId" | "studentId">): { familyId: string; studentId: string | null } =>
  ({ familyId: String(b.familyId), studentId: b.studentId === null ? null : String(b.studentId) });

/**
 * The live buy-outs for these requirements, by `key(requirementId, subject)` (the season's pairKey, or the credit's
 * slotKey), for these families or students (null: everyone, for staff). A per-family buy-out is asked for by its
 * family, a per-student one by its student. A per-student buy-out counts for its student only while the student's own
 * record is active and in the family it was chosen from: a student who has moved brings nothing of the old family's
 * choice to the new one, and the old family no longer has the student to count it for. Whether its invoice is paid is
 * read from the stored figures of the family that chose it, found by the customer the family's link names (`family_money`
 * is kept by the family's customer until the money slice of stage 2).
 */
export async function buyoutFacts(requirementIds: readonly string[], asked: SubjectsAsked | null,
  key: (requirementId: string, subject: SubjectId) => string, tx?: Tx): Promise<Map<string, BuyoutFact>> {
  const out = new Map<string, BuyoutFact>();
  if (requirementIds.length === 0 || (asked && asked.families.length === 0 && asked.students.length === 0)) return out;
  const q = tx ?? db;
  const whose: SQL | undefined = asked ? or(
    ...(asked.families.length ? [and(isNull(buyout.studentId), inArray(buyout.familyId, [...asked.families]))!] : []),
    ...(asked.students.length ? [inArray(buyout.studentId, [...asked.students])] : []),
  ) : undefined;
  const rows = await q.select({ requirementId: buyout.requirementId, familyId: buyout.familyId, studentId: buyout.studentId, state: buyout.state,
    invoiceQboId: buyout.invoiceQboId, realmId: buyout.realmId }).from(buyout)
    .where(and(inArray(buyout.requirementId, [...requirementIds]), inArray(buyout.state, [...LIVE_STATES]), whose));
  if (rows.length === 0) return out;
  const students = [...new Set(rows.flatMap((r) => (r.studentId === null ? [] : [r.studentId])))];
  const records = students.length === 0 ? [] : await q.select({ id: student.id, familyId: student.familyId }).from(student)
    .where(and(inArray(student.id, students), eq(student.active, true)));
  const inFamily = new Map<AppStudentId, AppFamilyId | null>(records.map((s) => [s.id, s.familyId]));
  const kept = rows.filter((r) => r.studentId === null || inFamily.get(r.studentId) === r.familyId);
  const families = [...new Set(kept.map((r) => r.familyId))];
  const [links, source] = await Promise.all([linksOf({ families, students: [] }, tx), getRosterSource(tx)]);
  const money = await moneyRows([...new Set(links.customerOfFamily.values())], tx);
  for (const r of kept) {
    const customer = links.customerOfFamily.get(r.familyId);
    const row = customer === undefined ? undefined : money.get(customer);
    // Figures from another company than the buy-out's, or than the roster's, say nothing about its invoice.
    const figures = row && row.realmId === r.realmId && row.realmId === source ? row.invoices : null;
    out.set(key(r.requirementId, subjectOfBuyout(r)), { state: r.state, invoicePaid: paidIn(figures, r.invoiceQboId) });
  }
  return out;
}
