// What a buy-out does when staff move a student to another family in the portal (afterStudentMoved() in
// src/lib/roster/writes.ts). A per-student buy-out was the old family's choice, billed to the student's own customer:
// the new family must never be billed for it. A move made in QuickBooks is not followed (stage 3's slice 9c): neither a
// refresh nor the daily check (./daily-check.ts) voids anything for it (the check flags it once, for Reconciliation);
// the student stays where the app has them, and stage 4 shows the move as a difference. Buy-outs name the app's own
// family and student (stage 2 of the app-owned families spec), and since stage 3's slice 9f the move comes by those
// records too (the portal saves it first), as volunteerForMovedStudent() takes it.
import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { buyout } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { queueVoid } from "./writes";

/**
 * Call inside the transaction that moves a student, after the move is written. For each of the old family's live
 * buy-outs for that student: an invoiced one has its void put on the write queue (the worker reads the invoice live
 * first and voids it only when nothing is paid on it; otherwise it is left and flagged for the treasurer), and it ends
 * as voided because the student moved; one still being invoiced is marked so its void follows as soon as the invoice
 * is made; a paid one, and one already being cancelled or stuck, is left as it is and flagged. A per-family buy-out is
 * untouched: the family is still the family. The move comes by the app's own records.
 */
export async function buyoutsForMovedStudent(tx: Tx, move: { studentId: AppStudentId; fromFamilyId: AppFamilyId; toFamilyId: AppFamilyId }, o: { actor: Actor; ip: string | null }):
  Promise<{ voiding: number; flagged: number }> {
  const { studentId, fromFamilyId, toFamilyId } = move;
  if (String(fromFamilyId) === String(toFamilyId)) return { voiding: 0, flagged: 0 };
  const rows = await tx.select().from(buyout).where(and(eq(buyout.familyId, fromFamilyId), eq(buyout.studentId, studentId),
    inArray(buyout.state, ["being_invoiced", "invoiced", "paid", "being_voided", "stuck"]))).for("update");
  if (rows.length === 0) return { voiding: 0, flagged: 0 };
  let voiding = 0, flagged = 0;
  for (const b of rows) {
    // An invoiced one's void is always queued (the item is filed under the buy-out's own family): only one with no
    // invoice to void comes back without an item, and is flagged with the rest.
    if (b.state === "invoiced" && (await queueVoid(tx, b, "student_moved", { actor: o.actor, label: "student moved", nextTryAt: new Date(), ip: o.ip }))) { voiding++; continue; }
    await tx.update(buyout).set({ flag: "student_moved", flaggedAt: new Date(), updatedAt: new Date() }).where(eq(buyout.id, b.id));
    await writeAudit({ actor: o.actor, action: "volunteer.buyout.flagged", targetType: "buyout", targetId: b.id, ip: o.ip,
      before: { state: b.state, flag: b.flag }, after: { flag: "student_moved", familyId: String(fromFamilyId), studentId: String(studentId), toFamilyId: String(toFamilyId) } }, tx);
    flagged++;
  }
  return { voiding, flagged };
}
