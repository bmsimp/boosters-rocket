/**
 * A season as the area still keyed by QuickBooks ids reads it (stage 2 of the app-owned families spec): money, through
 * the payment rule, and the checklist's rule with it (volunteering, forms and buy-outs have moved). The season keeps the app's own ids
 * (./progress.ts); these are its requirements and ticks with each family or student given as the customer its link
 * names, as factsFrom() in ./recorded.ts translates them. Pure: a boundary AGENTS.md lists (Seasons), which goes when
 * money moves to the app's ids.
 */
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
