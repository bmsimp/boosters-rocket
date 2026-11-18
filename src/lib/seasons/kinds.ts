/**
 * How each kind of requirement is met (v1 spec §10.2): one entry per kind, and the only place that knows. All four are
 * built: checklist items (a staff tick), forms (Documenso), payments (invoices carrying an item) and volunteering
 * (confirmed credit: check-ins and what staff credit, spent by allocateCredit() in src/lib/volunteer/allocation.ts).
 * A kind whose entry is null can't be created by staff.
 */
import type { RequirementKind } from "@/lib/db/schema";
import { NO_INVOICE_YET } from "@/lib/money/payment-rule";
import { paymentStandings, type AmountsShown } from "@/lib/money/payment-standings";
import { volunteerStanding } from "@/lib/volunteer/rules";
import { signedUpAmounts } from "@/lib/volunteer/signed-up";
import { confirmedAmounts } from "@/lib/volunteer/credit";
import { buyoutsByRecord } from "@/lib/volunteer/bought";
import { formRule } from "@/lib/forms/kind";
import { withBuyout } from "@/lib/buyouts/rules";
import { customerPairKey, type CustomerRecorded, type CustomerRequirement } from "./customer-keys";
import type { Requirement, RequirementFields, Standing, SubjectId, SubjectsAsked } from "./progress";

/** What `requirement_progress` holds for one requirement and one family or student, by the app's own id. */
export type Recorded = {
  requirementId: string; subjectId: SubjectId;
  metAt: Date | null; metBy: string | null;
  waivedAt: Date | null; waivedBy: string | null; waivedReason: string | null;
};

/** The key of one requirement for one family or student, by the app's own id. */
export const pairKey = (requirementId: string, subject: SubjectId) => `${requirementId}|${String(subject)}`;

/**
 * Who is looking, as far as the words depend on it. `amounts`: whether a payment's words say how much is left to pay
 * (src/lib/money/payment-standings.ts). `parentId`: the signed-in guardian on a parent's page, so a form a guardian
 * still has to sign reads "Not signed yet" to them while it waits for nobody else; null for staff.
 */
export type Viewing = { amounts: AmountsShown; parentId: string | null };

type RuleBase = {
  /** How a requirement stands for a family or student with nothing to show for it yet. */
  nothingYet(requirement: RequirementFields): Standing;
  /** True when staff meet it by hand, with a tick (requirement_progress.met_at). */
  ticked: boolean;
};

/**
 * A kind's rule asked by customer: one whose own records are still keyed by QuickBooks ids (payments; stage 2 of the
 * app-owned families spec), and the checklist with them. The families and students are the customers their
 * links name, and it answers by customerPairKey(). The season's reads translate on the way in and out (factsFrom() in
 * ./recorded.ts): a boundary AGENTS.md lists (Seasons), each going when its area moves.
 */
export type CustomerKindRule = RuleBase & {
  keyedBy?: "customer";
  /**
   * How things stand for these requirements (all of this kind) and these families or students, keyed by
   * customerPairKey(). `subjectQboIds` is null when staff ask about everyone. `recorded` is what requirement_progress
   * holds for them; a kind judged from its own records (invoices, signatures) reads those here instead. A pair left out
   * stands as `nothingYet`. `viewing` is who is looking.
   */
  standings(ask: { requirements: readonly CustomerRequirement[]; subjectQboIds: readonly string[] | null; recorded: readonly CustomerRecorded[]; viewing: Viewing }): Promise<Map<string, Standing>>;
};

/** A kind's rule asked by the app's own ids: one whose own records name the app's families and students (volunteering, forms). */
export type AppKindRule = RuleBase & {
  keyedBy: "app";
  /**
   * How things stand for these requirements (all of this kind) and these families and students (`asked`; null when
   * staff ask about everyone), keyed by pairKey(). `recorded` is what requirement_progress holds for them. A pair left
   * out stands as `nothingYet`. `viewing` is who is looking.
   */
  standings(ask: { requirements: readonly Requirement[]; asked: SubjectsAsked | null; recorded: readonly Recorded[]; viewing: Viewing }): Promise<Map<string, Standing>>;
};

export type KindRule = CustomerKindRule | AppKindRule;

const checklist: CustomerKindRule = {
  // Met when staff have ticked it off for the family or student.
  standings: async ({ recorded }) => new Map(recorded.filter((r) => r.metAt !== null).map((r) => [customerPairKey(r.requirementId, r.subjectQboId), { met: true, words: "Done" }])),
  nothingYet: () => ({ met: false, words: "Not done yet" }),
  ticked: true,
};

const payment: CustomerKindRule = {
  // Met when invoices carrying its QuickBooks product or service exist for the family or student and none of them is
  // still open (src/lib/money/payment-rule.ts), judged from the figures QuickBooks last gave the family.
  standings: async ({ requirements, subjectQboIds, viewing }) =>
    new Map((await paymentStandings(requirements, subjectQboIds, viewing.amounts)).map((s) => [customerPairKey(s.requirementId, s.subjectQboId), s.standing])),
  nothingYet: () => NO_INVOICE_YET,
  ticked: false,
};

/**
 * Volunteering (§11): met when confirmed credit reaches the amount, in shifts or hours as the requirement counts. The
 * shifts a requirement can count toward are listed in volunteer_shift_requirement, so it needs no column of its own.
 * Credit comes from check-ins and from staff (src/lib/volunteer/credit.ts), spent on the family's requirements by one
 * rule (src/lib/volunteer/allocation.ts); a place already credited no longer counts as "signed up for". A buy-out
 * (§11.5, src/lib/buyouts/) meets it too once its invoice is paid in the stored figures: "Buy-out being set up" while
 * the invoice is made, "Buy-out invoiced" until it is paid, then "Paid instead" (withBuyout() in
 * src/lib/buyouts/rules.ts). Credit counts as before alongside it. Nothing is ticked by hand: staff correct credit instead.
 */
const volunteer: AppKindRule = {
  keyedBy: "app",
  standings: async ({ requirements, asked }) => {
    const [signedUp, confirmed, bought] = await Promise.all([signedUpAmounts(requirements, asked, pairKey), confirmedAmounts(requirements, asked, pairKey),
      buyoutsByRecord(requirements, asked, pairKey)]);
    const standings = new Map<string, Standing>();
    for (const key of new Set([...signedUp.keys(), ...confirmed.keys(), ...bought.keys()])) {
      const r = requirements.find((x) => key.startsWith(`${x.id}|`));
      if (r) standings.set(key, withBuyout(volunteerStanding(r, { confirmed: confirmed.get(key) ?? 0, signedUp: signedUp.get(key) ?? 0 }), bought.get(key) ?? null));
    }
    return standings;
  },
  nothingYet: (r) => volunteerStanding(r, { confirmed: 0, signedUp: 0 }),
  ticked: false,
};

/** Each kind's rule; volunteering's and the form's are asked by the app's own ids, the others by customer (a boundary AGENTS.md lists, Seasons). */
export const KIND_RULES: { [K in RequirementKind]: (K extends "volunteer" | "form" ? AppKindRule : CustomerKindRule) | null } = {
  checklist,
  form: formRule,  // met when Documenso says the document is completed by the required guardians (§9; src/lib/forms/kind.ts)
  payment,
  volunteer,
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
