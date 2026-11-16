/**
 * How each kind of requirement is met (v1 spec §10.2): one entry per kind, and the only place that knows. Checklist
 * items and payments are worked out. Forms and volunteering each get their entry in the slice that builds them: until a
 * kind has one, staff can't create a requirement of it (KIND_RULES[kind] is null), and nothing else has to change.
 */
import type { RequirementKind } from "@/lib/db/schema";
import { NO_INVOICE_YET } from "@/lib/money/payment-rule";
import { paymentStandings } from "@/lib/money/payment-standings";
import type { Requirement, Standing } from "./progress";

/** What `requirement_progress` holds for one requirement and one family or student. */
export type Recorded = {
  requirementId: string; subjectQboId: string;
  metAt: Date | null; metBy: string | null;
  waivedAt: Date | null; waivedBy: string | null; waivedReason: string | null;
};

/** The key of one requirement for one family or student. */
export const pairKey = (requirementId: string, subjectQboId: string) => `${requirementId}|${subjectQboId}`;

export type KindRule = {
  /**
   * How things stand for these requirements (all of this kind) and these families or students, keyed by pairKey().
   * `subjectQboIds` is null when staff ask about everyone. `recorded` is what requirement_progress holds for them; a
   * kind judged from its own records (invoices, signatures, volunteer credit) reads those here instead. A pair left
   * out stands as `nothingYet`.
   */
  standings(ask: { requirements: readonly Requirement[]; subjectQboIds: readonly string[] | null; recorded: readonly Recorded[] }): Promise<Map<string, Standing>>;
  /** How a requirement stands for a family or student with nothing to show for it yet. */
  nothingYet(requirement: Requirement): Standing;
  /** True when staff meet it by hand, with a tick (requirement_progress.met_at). */
  ticked: boolean;
};

const checklist: KindRule = {
  // Met when staff have ticked it off for the family or student.
  standings: async ({ recorded }) => new Map(recorded.filter((r) => r.metAt !== null).map((r) => [pairKey(r.requirementId, r.subjectQboId), { met: true, words: "Done" }])),
  nothingYet: () => ({ met: false, words: "Not done yet" }),
  ticked: true,
};

const payment: KindRule = {
  // Met when invoices carrying its QuickBooks product or service exist for the family or student and none of them is
  // still open (src/lib/money/payment-rule.ts), judged from the figures QuickBooks last gave the family.
  standings: async ({ requirements, subjectQboIds }) =>
    new Map((await paymentStandings(requirements, subjectQboIds)).map((s) => [pairKey(s.requirementId, s.subjectQboId), s.standing])),
  nothingYet: () => NO_INVOICE_YET,
  ticked: false,
};

export const KIND_RULES: Record<RequirementKind, KindRule | null> = {
  checklist,
  form: null,      // Forms with Documenso: met when the document is completed by the required guardians (§9).
  payment,
  volunteer: null, // Volunteering: met when confirmed credit reaches the amount, or a buy-out is paid (§11).
};

/** What staff call each kind. */
export const KIND_LABELS: Record<RequirementKind, string> = { checklist: "Checklist item", form: "Form", payment: "Payment", volunteer: "Volunteering" };

/** Every kind, in the order staff are offered them. */
export const REQUIREMENT_KINDS = Object.keys(KIND_RULES) as RequirementKind[];
/** The kinds staff can create today: those whose rule exists. */
export const availableKinds = (): RequirementKind[] => REQUIREMENT_KINDS.filter((k) => KIND_RULES[k] !== null);
export const isAvailableKind = (kind: unknown): kind is RequirementKind => typeof kind === "string" && (availableKinds() as string[]).includes(kind);

/** A requirement whose kind has no rule can't be met yet: it reads as still to do. */
export const NO_RULE_YET: Standing = { met: false, words: "Not done yet" };
