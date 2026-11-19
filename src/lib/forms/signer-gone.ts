// When a guardian can no longer sign for a family: staff blocked the person, or their membership was closed (closeMembership()) for the
// family. A document already made for them keeps them as a Documenso recipient with a working signing token (the
// portal handed it to their page), and readAndStore() would count their signature or decline for the family. So the
// family's unfinished forms that still wait for that guardian's signature are reset to not opened, in the caller's
// transaction, and their documents withdrawn by the worker (form_withdrawal: cancelled when anyone signed, deleted when
// nobody did), as formsForMovedStudent() does. A form the guardian signed already, and one everyone has signed, complete
// or declined, is left as it is. Requests name the app's own family (stage 2 of the app-owned families spec), and the
// caller names it the same way: the guardian row's own `family_id`. A row with none (one a change of company closed)
// has no requests to start again, as the family link it was once looked up by answered nothing for it. Imports no
// staff-only module (tests/integration/page-guards.test.ts).
import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { formWithdrawal, signatureRequest } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import type { AppFamilyId } from "@/lib/families/ids";
import { NO_DOCUMENT, requestRecords } from "./requests";

export type SignerGoneReason = "blocked" | "access_ended";

/**
 * Resets the forms of `family` (every family, for a block) still waiting for this person to sign. Returns how many.
 * A null family is a guardian row with no family record: nothing is reset.
 */
export async function formsForGoneSigner(tx: Tx, o: { parentId: string; family: AppFamilyId | null | "every family"; reason: SignerGoneReason; actor: Actor; ip?: string | null }): Promise<number> {
  if (o.family === null) return 0;
  const familyId = o.family === "every family" ? null : o.family;
  const rows = await tx.select().from(signatureRequest).where(and(
    eq(signatureRequest.state, "waiting"),
    familyId === null ? undefined : eq(signatureRequest.familyId, familyId),
    sql`${signatureRequest.signers} @> ${JSON.stringify([{ parentId: o.parentId }])}::jsonb`,
  )).for("update");
  const now = new Date();
  let reset = 0;
  for (const row of rows) {
    const mine = row.signers.find((s) => s.parentId === o.parentId);
    if (!mine || mine.signedAt !== null || row.envelopeId === null) continue;
    const anySigned = row.signers.some((s) => s.signedAt !== null);
    await tx.update(signatureRequest).set({ ...NO_DOCUMENT, preparingAt: null, evidenceOwed: false, updatedAt: now }).where(eq(signatureRequest.id, row.id));
    await tx.insert(formWithdrawal).values({ envelopeId: row.envelopeId, anySigned }).onConflictDoNothing();
    await writeAudit({ actor: o.actor, action: "forms.request.signer_gone", targetType: "signature_request", targetId: row.id, ip: o.ip ?? null,
      before: { state: row.state, envelopeId: row.envelopeId },
      after: { state: "not_opened", parentId: o.parentId, ...requestRecords(row), reason: o.reason, withdraw: anySigned ? "cancel" : "delete" } }, tx);
    reset++;
  }
  return reset;
}
