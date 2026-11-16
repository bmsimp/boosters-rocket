// When staff move a student to another family (the roster writes slice calls this; nothing in this slice does): what
// happens to the student's forms. A form signed and sealed is the club's record and goes with the student, its kept
// evidence too, so it still counts for them; but who signed it and its PDF stay the old family's: a parent of the new
// family reads only "Signed" (signedWithin(), src/lib/forms/requests.ts). A form not finished was made for the old family's guardians, so its document is withdrawn (after the
// transaction: the worker does it from form_withdrawal) and the request goes back to not opened under the new family,
// with the old family's consents taken away. Imports no staff-only module (tests/integration/page-guards.test.ts).
import "server-only";
import { and, eq } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { formWithdrawal, signatureConsent, signatureRequest, signedFormEvidence, type RequestSigner, type SignatureRequestState } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
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
 */
export async function formsForMovedStudent(tx: Tx, o: { studentQboId: string; fromFamilyQboId: string; toFamilyQboId: string; actor?: Actor; ip?: string | null }): Promise<{ moved: number; reset: number; toWithdraw: string[] }> {
  if (o.fromFamilyQboId === o.toFamilyQboId) return { moved: 0, reset: 0, toWithdraw: [] };
  const rows = await tx.select().from(signatureRequest)
    .where(and(eq(signatureRequest.subjectQboId, o.studentQboId), eq(signatureRequest.familyQboId, o.fromFamilyQboId))).for("update");
  const actor = o.actor ?? { door: "system", id: null, label: "roster" };
  const plans = movedStudentPlan(rows);
  const now = new Date();
  for (const plan of plans) {
    const row = rows.find((r) => r.id === plan.requestId)!;
    if (plan.do === "move") {
      await tx.update(signatureRequest).set({ familyQboId: o.toFamilyQboId, updatedAt: now }).where(eq(signatureRequest.id, row.id));
      await tx.update(signedFormEvidence).set({ familyQboId: o.toFamilyQboId }).where(eq(signedFormEvidence.requestId, row.id));
    } else {
      await tx.update(signatureRequest).set({ ...NO_DOCUMENT, familyQboId: o.toFamilyQboId, preparingAt: null, evidenceOwed: false, updatedAt: now }).where(eq(signatureRequest.id, row.id));
      await tx.delete(signatureConsent).where(eq(signatureConsent.requestId, row.id));
      if (plan.withdraw) await tx.insert(formWithdrawal).values(plan.withdraw).onConflictDoNothing();
    }
    await writeAudit({ actor, action: "forms.request.moved", targetType: "signature_request", targetId: row.id, ip: o.ip ?? null,
      before: { familyQboId: o.fromFamilyQboId, state: row.state, envelopeId: row.envelopeId },
      after: { familyQboId: o.toFamilyQboId, state: plan.do === "move" ? row.state : "not_opened", withdraw: plan.withdraw ? (plan.withdraw.anySigned ? "cancel" : "delete") : null } }, tx);
  }
  const toWithdraw = plans.flatMap((p) => (p.withdraw ? [p.withdraw.envelopeId] : []));
  return { moved: plans.filter((p) => p.do === "move").length, reset: plans.filter((p) => p.do === "reset").length, toWithdraw };
}

