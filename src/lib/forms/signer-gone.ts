// When a guardian can no longer sign for a family: staff blocked the person, or the reconcile closed their link to the
// family. A document already made for them keeps them as a Documenso recipient with a working signing token (the
// portal handed it to their page), and readAndStore() would count their signature or decline for the family. So the
// family's unfinished forms that still wait for that guardian's signature are reset to not opened, in the caller's
// transaction, and their documents withdrawn by the worker (form_withdrawal: cancelled when anyone signed, deleted when
// nobody did), as formsForMovedStudent() does. A form the guardian signed already, and one everyone has signed, complete
// or declined, is left as it is. Requests name the app's own family (stage 2 of the app-owned families spec); the caller
// names the family by its QuickBooks id, as the guardian row and the reconcile still do until stage 3, and it is turned
// into the app's family here through its family link: a family with no record there has no requests. Imports no
// staff-only module (tests/integration/page-guards.test.ts).
import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { formWithdrawal, signatureRequest } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { familyLinkedTo } from "@/lib/families/links";
import { NO_DOCUMENT, requestRecords } from "./requests";

export type SignerGoneReason = "blocked" | "access_ended";

/** Resets the forms of `familyQboId` (every family, for a block) still waiting for this person to sign. Returns how many. */
export async function formsForGoneSigner(tx: Tx, o: { parentId: string; familyQboId: string | null; reason: SignerGoneReason; actor: Actor; ip?: string | null }): Promise<number> {
  const familyId = o.familyQboId === null ? null : await familyLinkedTo(o.familyQboId, tx);
  if (o.familyQboId !== null && familyId === null) return 0;
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
