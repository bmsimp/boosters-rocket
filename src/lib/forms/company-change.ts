import { count, isNotNull } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { requirement, signatureRequest } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";

/**
 * Called inside `clearRosterOfOtherCompanyLocked` (src/lib/roster/source.ts), in its transaction, when a different
 * QuickBooks company is connected. A signature request is kept against a family's and a student's QuickBooks ids,
 * which mean other customers in another company: a signed form would pass to whoever has the same number there. Every
 * request is deleted, and each guardian's consent with it. The documents themselves stay in Documenso, signed ones
 * included, and every change of a form's state is still in the audit log from when it was read. The requirements
 * keep their templates: those are the club's own.
 */
export async function clearFormRecords(tx: Tx, o: { fromRealmId: string; toRealmId: string; actor: Actor; ip: string | null }): Promise<void> {
  const gone = await tx.delete(signatureRequest).returning({ state: signatureRequest.state, envelopeId: signatureRequest.envelopeId });
  if (gone.length === 0) return;
  const [templates] = await tx.select({ n: count() }).from(requirement).where(isNotNull(requirement.form));
  await writeAudit({ actor: o.actor, action: "form.records.cleared", targetType: "signature_request", ip: o.ip,
    before: { realmId: o.fromRealmId },
    after: { reason: "different_company", realmId: o.toRealmId, requests: gone.length, complete: gone.filter((g) => g.state === "complete").length,
      documentsLeftInDocumenso: gone.filter((g) => g.envelopeId !== null).length, requirementsKeepingTheirTemplate: templates?.n ?? 0 } }, tx);
}
