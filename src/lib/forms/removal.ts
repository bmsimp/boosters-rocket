// What stands in the way of removing a form requirement (src/lib/seasons/setup.ts): a document was made for it. A
// request nobody has opened holds nothing, and goes with the requirement.
import "server-only";
import { and, count, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { signatureRequest } from "@/lib/db/schema";

/** How many forms of these requirements have a document made, signed or not: history a removal would destroy. */
export async function formsHolding(requirementIds: readonly string[], tx: Tx): Promise<number> {
  if (requirementIds.length === 0) return 0;
  const [n] = await tx.select({ n: count() }).from(signatureRequest)
    .where(and(inArray(signatureRequest.requirementId, [...requirementIds]), or(isNotNull(signatureRequest.envelopeId), ne(signatureRequest.state, "not_opened"))));
  return n?.n ?? 0;
}

/** Deletes the requests of these requirements that nothing was ever made for, so the requirements themselves can go. */
export async function dropUnopenedForms(requirementIds: readonly string[], tx: Tx): Promise<void> {
  if (requirementIds.length === 0) return;
  await tx.delete(signatureRequest).where(and(inArray(signatureRequest.requirementId, [...requirementIds]), isNull(signatureRequest.envelopeId), eq(signatureRequest.state, "not_opened")));
}

/** The refusal staff read, for a step or a requirement by name. */
export const formsHoldingWords = (name: string, held: number): string =>
  `${name} can't be removed: ${held === 1 ? "a form has" : `${held} forms have`} been made for families to sign. Make it optional so it no longer holds the step open, or keep it.`;
