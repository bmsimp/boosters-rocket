import type { Tx } from "@/lib/db/client";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { formsForMovedStudent } from "@/lib/forms/moved";
import { volunteerForMovedStudent } from "@/lib/volunteer/moved-student";
import type { AppFamilyId, AppStudentId } from "./ids";

export type StudentMove = { studentId: AppStudentId; fromFamilyId: AppFamilyId; toFamilyId: AppFamilyId; cause: string };
/** What an accounting plugin adds to a move's follow-ups, as counts for the move's audit row (QuickBooks: its buy-outs). */
export type MoreFollowUps = (tx: Tx, who: Omit<StudentMove, "cause">) => Promise<Record<string, number>>;

/**
 * The part of a student's move that other parts of the portal follow, in the move's save transaction, after the
 * student record's family is set. In this order: the student's signature requests (formsForMovedStudent,
 * src/lib/forms/moved.ts: a complete one moves with its evidence, any other is reset under the new family and its
 * document queued for the worker to withdraw), then the student's volunteer places (volunteerForMovedStudent,
 * src/lib/volunteer/moved-student.ts: places on shifts still to come are given up, credit stays with the family it was
 * earned for), then what an accounting plugin adds (`more`: QuickBooks' buy-outs, afterStudentMoved() in
 * src/lib/roster/writes.ts), then the audit row of the move's follow-up with their counts
 * (`roster.student.move.followed`). The answer's `tell` emails the guardians whose places were given up: call it after
 * the transaction commits. The core's own, books or none: a move staff make by hand runs it with nothing more.
 */
export async function followMovedStudent(tx: Tx, move: StudentMove, o: { actor: Actor; ip: string | null }, more?: MoreFollowUps):
  Promise<{ tell: () => Promise<unknown>; more: Record<string, number> }> {
  const who = { studentId: move.studentId, fromFamilyId: move.fromFamilyId, toFamilyId: move.toFamilyId };
  const forms = await formsForMovedStudent(tx, { ...who, actor: o.actor, ip: o.ip });
  const volunteer = await volunteerForMovedStudent(tx, who, { actor: o.actor, ip: o.ip });
  const added = more ? await more(tx, who) : {};
  await writeAudit({ actor: { door: "system", id: null, label: "roster" }, action: "roster.student.move.followed", targetType: "student", targetId: String(move.studentId),
    after: { studentId: String(move.studentId), fromFamilyId: String(move.fromFamilyId), toFamilyId: String(move.toFamilyId), cause: move.cause,
      formsMoved: forms.moved, formsReset: forms.reset, formsToWithdraw: forms.toWithdraw.length, placesGivenUp: volunteer.cancelled, ...added } }, tx);
  return { tell: volunteer.tell, more: added };
}
