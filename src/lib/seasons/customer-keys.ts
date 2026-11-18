/**
 * A season as the areas still keyed by QuickBooks ids read it (stage 2 of the app-owned families spec): forms and money
 * (volunteering has moved, and buy-outs read the season by the app's ids through their own link lookup, in
 * src/lib/buyouts/my-buyouts.ts). The season keeps the app's own ids (./progress.ts); these are its requirements, chosen
 * lists and ticks with each family or student given as the customer its link names, for those areas' rules and pages.
 * Pure: the reads that translate are ./by-customer.ts, and the boundaries that use them are listed in AGENTS.md
 * (Seasons). Each goes when its area moves to the app's ids.
 */
import type { requirement } from "@/lib/db/schema";
import type { RequirementFields } from "./progress";

/** A requirement with its chosen list as customer ids: what the areas still keyed by QuickBooks ids read. */
export type CustomerRequirement = RequirementFields & {
  /** With `covers: "chosen"`: the customers its chosen list's families (per family) or students (per student) are linked to. */
  coveredQboIds: readonly string[];
};

/** A tick or waiver with its family or student given as the customer it is linked to. */
export type CustomerRecorded = {
  requirementId: string; subjectQboId: string;
  metAt: Date | null; metBy: string | null;
  waivedAt: Date | null; waivedBy: string | null; waivedReason: string | null;
};

/** The key of one requirement for one family or student by its customer: the key the kind rules answer with (./kinds.ts). */
export const customerPairKey = (requirementId: string, subjectQboId: string) => `${requirementId}|${subjectQboId}`;

/** Whether a requirement is asked of this customer's family (per family) or student (per student). */
export function isCustomerCovered(r: Pick<CustomerRequirement, "covers" | "coveredQboIds">, subjectQboId: string): boolean {
  return r.covers === "everyone" || r.coveredQboIds.includes(subjectQboId);
}

/** A requirement row as these areas read it, with whatever part of its chosen list the caller was allowed to load, by customer. */
export function toCustomerRequirement(row: typeof requirement.$inferSelect, coveredQboIds: readonly string[]): CustomerRequirement {
  return { id: row.id, kind: row.kind, title: row.title, required: row.required, appliesTo: row.appliesTo, amount: row.amount, amountUnit: row.amountUnit,
    dueOn: row.dueOn, covers: row.covers, coveredQboIds };
}
