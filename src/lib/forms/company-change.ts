import { count, isNotNull, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { formReminderClaim, formReminderRound, requirement, signatureRequest, signedFormEvidence } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";

/**
 * Called inside `clearRosterOfOtherCompanyLocked` (src/lib/roster/source.ts), in its transaction, when a different
 * QuickBooks company is connected, before the app's own families and students are removed (clearAppRecords()): a
 * signature request names one of them (stage 2 of the app-owned families spec), and so does the current company's
 * evidence, and the database refuses to remove a record one still names. Every request is deleted, and each
 * guardian's consent with it, and every reminder record. Nothing the portal runs reaches it until stage 4 ships: a
 * different company is refused wherever one is connected or read (open question 18), and stage 4 replaces it, when a
 * change of company clears only links and the money cache. The documents themselves stay in
 * Documenso, signed ones included, and every change of a form's state is still in the audit log from when it was read.
 * The requirements keep their templates: those are the club's own.
 *
 * A signed form's kept evidence is the club's record and is never destroyed (signed_form_evidence and its files): each
 * row is kept, with every byte, hash, consent, name and QuickBooks id as it was, marked as from an earlier company, cut
 * from the request it came from and from the app's family and student it named, in the same statement. From then on no
 * parent is shown it, the matrix leaves it out, and it is never matched to a family of the new company by a QuickBooks
 * id; staff find it in the archive on the staff Forms page.
 */
export async function clearFormRecords(tx: Tx, o: { fromRealmId: string | null; toRealmId: string; actor: Actor; ip: string | null }): Promise<void> {
  // Every request is locked first: evidence being stored right now (storeEvidence() holds its request's row) commits
  // before the evidence below is marked, so none is left unmarked, pointing at a request deleted here.
  await tx.select({ id: signatureRequest.id }).from(signatureRequest).for("update");
  const kept = await tx.update(signedFormEvidence).set({ earlierCompanyAt: sql`now()`, requestId: null, familyId: null, studentId: null })
    .where(isNull(signedFormEvidence.earlierCompanyAt)).returning({ id: signedFormEvidence.id });
  const claims = await tx.delete(formReminderClaim).returning({ id: formReminderClaim.id });
  const rounds = await tx.delete(formReminderRound).returning({ id: formReminderRound.id });
  const gone = await tx.delete(signatureRequest).returning({ state: signatureRequest.state, envelopeId: signatureRequest.envelopeId, evidenceOwed: signatureRequest.evidenceOwed });
  if (gone.length === 0 && kept.length === 0 && claims.length + rounds.length === 0) return;
  const [templates] = await tx.select({ n: count() }).from(requirement).where(isNotNull(requirement.form));
  await writeAudit({ actor: o.actor, action: "form.records.cleared", targetType: "signature_request", ip: o.ip,
    before: { realmId: o.fromRealmId },
    after: { reason: "different_company", realmId: o.toRealmId, requests: gone.length, complete: gone.filter((g) => g.state === "complete").length,
      documentsLeftInDocumenso: gone.filter((g) => g.envelopeId !== null).length, requirementsKeepingTheirTemplate: templates?.n ?? 0,
      evidenceKeptAsEarlierCompany: kept.length, completeWithEvidenceNotYetKept: gone.filter((g) => g.state === "complete" && g.evidenceOwed).length,
      reminderRecordsCleared: claims.length + rounds.length } }, tx);
}
