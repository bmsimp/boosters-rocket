// What a buy-out does when staff move a student to another family in the portal (afterStudentMoved() in
// src/lib/roster/writes.ts). A per-student buy-out was the old family's choice, billed to the student's own customer:
// the new family must never be billed for it. A move made in QuickBooks and read by a refresh is not seen here: the
// daily check (./daily-check.ts) finds the invoice's customer no longer the family's and puts its void on the queue
// the same way; a refresh itself voids nothing.
import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { buyout } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { queueVoid } from "./writes";

/**
 * Call inside the transaction that moves a student, after the move is written. For each of the old family's live
 * buy-outs for that student: an invoiced one has its void put on the write queue (the worker reads the invoice live
 * first and voids it only when nothing is paid on it; otherwise it is left and flagged for the treasurer), and it ends
 * as voided because the student moved; one still being invoiced is marked so its void follows as soon as the invoice
 * is made; a paid one, and one already being cancelled or stuck, is left as it is and flagged. A per-family buy-out is
 * untouched: the family is still the family.
 */
export async function buyoutsForMovedStudent(tx: Tx, move: { studentQboId: string; fromFamilyQboId: string; toFamilyQboId: string }, o: { actor: Actor; ip: string | null }):
  Promise<{ voiding: number; flagged: number }> {
  const rows = await tx.select().from(buyout).where(and(eq(buyout.familyQboId, move.fromFamilyQboId), eq(buyout.subjectQboId, move.studentQboId),
    inArray(buyout.state, ["being_invoiced", "invoiced", "paid", "being_voided", "stuck"]))).for("update");
  let voiding = 0, flagged = 0;
  for (const b of rows) {
    if (b.subjectQboId === b.familyQboId) continue;
    if (b.state === "invoiced" && (await queueVoid(tx, b, "student_moved", { actor: o.actor, label: "student moved", nextTryAt: new Date(), ip: o.ip }))) { voiding++; continue; }
    await tx.update(buyout).set({ flag: "student_moved", flaggedAt: new Date(), updatedAt: new Date() }).where(eq(buyout.id, b.id));
    await writeAudit({ actor: o.actor, action: "volunteer.buyout.flagged", targetType: "buyout", targetId: b.id, ip: o.ip,
      before: { state: b.state, flag: b.flag }, after: { flag: "student_moved", fromFamilyQboId: move.fromFamilyQboId, toFamilyQboId: move.toFamilyQboId } }, tx);
    flagged++;
  }
  return { voiding, flagged };
}
