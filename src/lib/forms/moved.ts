// When staff move a student to another family in the portal (afterStudentMoved() in src/lib/roster/writes.ts; since
// stage 3's slice 9c a move made in QuickBooks is no longer followed): what happens to the student's forms. A form signed and sealed is the
// club's record and goes with the student, its kept evidence too, so it still counts for them; but who signed it and its
// PDF stay the old family's: a parent of the new family reads only "Signed" (signedWithin(), src/lib/forms/requests.ts).
// A form not finished was made for the old family's guardians, so its document is withdrawn (after the transaction: the
// worker does it from form_withdrawal) and the request goes back to not opened under the new family, with the old
// family's consents taken away. Requests and evidence name the app's own family and student (stage 2 of the app-owned
// families spec), and since stage 3's slice 9f the move comes by those records too (the portal saves it first), so it
// runs the same for a student or family with no link to QuickBooks. Kept evidence changes only in the app family it
// names: its own copies of the QuickBooks ids stay as they were stored. Imports no staff-only module
// (tests/integration/page-guards.test.ts).
import "server-only";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { formWithdrawal, signatureConsent, signatureRequest, signedFormEvidence, type RequestSigner, type SignatureRequestState } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { NO_DOCUMENT } from "./requests";

/** What becomes of one of the student's requests. */
export type MovedPlan = { requestId: string; do: "move" | "reset"; withdraw: { envelopeId: string; anySigned: boolean } | null };

/**
 * The rule, pure: a complete request moves to the new family as it is; any other is reset to not opened under the new
 * family, and a document it had is withdrawn (cancelled when anyone signed it, deleted when nobody did).
 */
export function movedStudentPlan(rows: readonly { id: string; state: SignatureRequestState; envelopeId: string | null; signers: readonly Pick<RequestSigner, "signedAt">[] }[]): MovedPlan[] {
  return rows.map((r) => r.state === "complete"
    ? { requestId: r.id, do: "move", withdraw: null }
    : { requestId: r.id, do: "reset", withdraw: r.envelopeId === null ? null : { envelopeId: r.envelopeId, anySigned: r.state === "signed" || r.signers.some((s) => s.signedAt !== null) } });
}

/**
 * In the caller's transaction (the move itself): the student's requests that the old family holds are moved or reset
 * by movedStudentPlan(), each change audited. The documents to withdraw are queued for the worker; the answer lists
 * them too, for a caller that would rather withdraw them itself after the commit.
 *
 * The move comes by the app's own records (moveStudent() in src/lib/roster/writes.ts, which saves it in the portal
 * first, into one of the portal's own active families): the student, the family left and the family joined, each
 * linked to QuickBooks or not.
 */
export async function formsForMovedStudent(tx: Tx, o: { studentId: AppStudentId; fromFamilyId: AppFamilyId; toFamilyId: AppFamilyId; actor?: Actor; ip?: string | null }): Promise<{ moved: number; reset: number; toWithdraw: string[] }> {
  const nothing = { moved: 0, reset: 0, toWithdraw: [] };
  const { studentId, fromFamilyId, toFamilyId } = o;
  if (String(fromFamilyId) === String(toFamilyId)) return nothing;
  const rows = await tx.select().from(signatureRequest)
    .where(and(eq(signatureRequest.studentId, studentId), eq(signatureRequest.familyId, fromFamilyId))).for("update");
  const actor = o.actor ?? { door: "system", id: null, label: "roster" };
  const plans = movedStudentPlan(rows);
  const now = new Date();
  for (const plan of plans) {
    const row = rows.find((r) => r.id === plan.requestId)!;
    const familyId = toFamilyId;
    if (plan.do === "move") {
      await tx.update(signatureRequest).set({ familyId, updatedAt: now }).where(eq(signatureRequest.id, row.id));
      // The evidence of the current company only (an earlier company's is cut from its request and names no family).
      await tx.update(signedFormEvidence).set({ familyId }).where(and(eq(signedFormEvidence.requestId, row.id), isNotNull(signedFormEvidence.familyId)));
    } else {
      await tx.update(signatureRequest).set({ ...NO_DOCUMENT, familyId, preparingAt: null, evidenceOwed: false, updatedAt: now }).where(eq(signatureRequest.id, row.id));
      await tx.delete(signatureConsent).where(eq(signatureConsent.requestId, row.id));
      if (plan.withdraw) await tx.insert(formWithdrawal).values(plan.withdraw).onConflictDoNothing();
    }
    await writeAudit({ actor, action: "forms.request.moved", targetType: "signature_request", targetId: row.id, ip: o.ip ?? null,
      before: { familyId: String(fromFamilyId), studentId: String(studentId), state: row.state, envelopeId: row.envelopeId },
      after: { familyId: String(familyId), studentId: String(studentId), state: plan.do === "move" ? row.state : "not_opened", withdraw: plan.withdraw ? (plan.withdraw.anySigned ? "cancel" : "delete") : null } }, tx);
  }
  const toWithdraw = plans.flatMap((p) => (p.withdraw ? [p.withdraw.envelopeId] : []));
  return { moved: plans.filter((p) => p.do === "move").length, reset: plans.filter((p) => p.do === "reset").length, toWithdraw };
}
