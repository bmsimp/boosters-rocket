// When a student moves to another family (afterStudentMoved() in src/lib/roster/writes.ts for a move staff make, and
// the roster refresh for one made in QuickBooks): what happens to the student's forms. A form signed and sealed is the
// club's record and goes with the student, its kept evidence too, so it still counts for them; but who signed it and its
// PDF stay the old family's: a parent of the new family reads only "Signed" (signedWithin(), src/lib/forms/requests.ts).
// A form not finished was made for the old family's guardians, so its document is withdrawn (after the transaction: the
// worker does it from form_withdrawal) and the request goes back to not opened under the new family, with the old
// family's consents taken away. Requests and evidence name the app's own family and student (stage 2 of the app-owned
// families spec); the roster names the move by QuickBooks ids, so the move is turned into those records here, through
// their links in the records' company: a boundary AGENTS.md lists, until stage 3 moves the roster to the app. Kept
// evidence changes only in the app family it names: its own copies of the QuickBooks ids stay as they were stored.
// Imports no staff-only module (tests/integration/page-guards.test.ts).
import "server-only";
import { and, eq, isNotNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Tx } from "@/lib/db/client";
import { accountingLink, formWithdrawal, signatureConsent, signatureRequest, signedFormEvidence, type RequestSigner, type SignatureRequestState } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { QUICKBOOKS } from "@/lib/families/ids";
import { familyLinkedTo, recordsCompany, studentLinkedTo } from "@/lib/families/links";
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
 * The move comes by QuickBooks ids, as the roster has it; a student or old family with no app record has no requests.
 * Both callers bring the records into step first (a roster read runs its reconcile before its follow-ups, and a staff
 * move goes to a family already on the roster), so the new family has its record. Should one ever have none, it can't
 * be given a request: a complete one then stays where it is, and an unfinished one is still reset and its document
 * withdrawn, under the old family, where the new family's Forms page takes it over as it takes over any request
 * nothing was made for (loadMyForms()); the next roster read finds the complete one held elsewhere
 * (requestsHeldElsewhere()) and moves it then.
 */
export async function formsForMovedStudent(tx: Tx, o: { studentQboId: string; fromFamilyQboId: string; toFamilyQboId: string; actor?: Actor; ip?: string | null }): Promise<{ moved: number; reset: number; toWithdraw: string[] }> {
  const nothing = { moved: 0, reset: 0, toWithdraw: [] };
  if (o.fromFamilyQboId === o.toFamilyQboId) return nothing;
  const [studentId, fromFamilyId, toFamilyId] = await Promise.all([studentLinkedTo(o.studentQboId, tx), familyLinkedTo(o.fromFamilyQboId, tx), familyLinkedTo(o.toFamilyQboId, tx)]);
  if (studentId === null || fromFamilyId === null || String(fromFamilyId) === String(toFamilyId)) return nothing;
  const rows = await tx.select().from(signatureRequest)
    .where(and(eq(signatureRequest.studentId, studentId), eq(signatureRequest.familyId, fromFamilyId))).for("update");
  const actor = o.actor ?? { door: "system", id: null, label: "roster" };
  const plans = movedStudentPlan(rows).filter((p) => p.do === "reset" || toFamilyId !== null);
  const now = new Date();
  for (const plan of plans) {
    const row = rows.find((r) => r.id === plan.requestId)!;
    const familyId = toFamilyId ?? fromFamilyId;
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

const studentLink = alias(accountingLink, "student_link");
const familyLink = alias(accountingLink, "family_link");

/**
 * The students' form requests held under another family than the one each is under now (`under`: student to family,
 * by QuickBooks id, studentsUnderFamilies() in src/lib/roster/moves.ts), for a roster refresh to follow a move it didn't
 * see in one read. Each request's student and family are taken to the customers their links name, in the records'
 * company. A request the follow-up moved is under the new family, so none is held elsewhere once a move is followed.
 */
export async function requestsHeldElsewhere(tx: Tx, under: ReadonlyMap<string, string>): Promise<{ studentQboId: string; familyQboId: string }[]> {
  if (under.size === 0) return [];
  const realmId = await recordsCompany(tx);
  if (realmId === null) return [];
  const rows = await tx.selectDistinct({ studentQboId: studentLink.customerId, familyQboId: familyLink.customerId }).from(signatureRequest)
    .innerJoin(studentLink, and(eq(studentLink.studentId, signatureRequest.studentId), eq(studentLink.system, QUICKBOOKS), eq(studentLink.realmId, realmId)))
    .innerJoin(familyLink, and(eq(familyLink.familyId, signatureRequest.familyId), eq(familyLink.system, QUICKBOOKS), eq(familyLink.realmId, realmId)))
    .where(isNotNull(signatureRequest.studentId));
  return rows.filter((r) => under.has(r.studentQboId) && under.get(r.studentQboId) !== r.familyQboId);
}
