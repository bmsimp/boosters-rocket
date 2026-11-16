/**
 * How each kind of requirement is met (v1 spec §10.2): one entry per kind, and the only place that knows. All four are
 * built: checklist items (a staff tick), forms (Documenso), payments (invoices carrying an item) and volunteering
 * (signed-up and, later, confirmed shifts). A kind whose entry is null can't be created by staff.
 */
import type { RequirementKind } from "@/lib/db/schema";
import { NO_INVOICE_YET } from "@/lib/money/payment-rule";
import { paymentStandings, type AmountsShown } from "@/lib/money/payment-standings";
import { volunteerStanding } from "@/lib/volunteer/rules";
import { signedUpAmounts } from "@/lib/volunteer/signed-up";
import { formRule } from "@/lib/forms/kind";
import type { Requirement, Standing } from "./progress";

/** What `requirement_progress` holds for one requirement and one family or student. */
export type Recorded = {
  requirementId: string; subjectQboId: string;
  metAt: Date | null; metBy: string | null;
  waivedAt: Date | null; waivedBy: string | null; waivedReason: string | null;
};

/** The key of one requirement for one family or student. */
export const pairKey = (requirementId: string, subjectQboId: string) => `${requirementId}|${subjectQboId}`;

/**
 * Who is looking, as far as the words depend on it. `amounts`: whether a payment's words say how much is left to pay
 * (src/lib/money/payment-standings.ts). `parentId`: the signed-in guardian on a parent's page, so a form a guardian
 * still has to sign reads "Not signed yet" to them while it waits for nobody else; null for staff.
 */
export type Viewing = { amounts: AmountsShown; parentId: string | null };

export type KindRule = {
  /**
   * How things stand for these requirements (all of this kind) and these families or students, keyed by pairKey().
   * `subjectQboIds` is null when staff ask about everyone. `recorded` is what requirement_progress holds for them; a
   * kind judged from its own records (invoices, signatures, volunteer credit) reads those here instead. A pair left
   * out stands as `nothingYet`. `viewing` is who is looking.
   */
  standings(ask: { requirements: readonly Requirement[]; subjectQboIds: readonly string[] | null; recorded: readonly Recorded[]; viewing: Viewing }): Promise<Map<string, Standing>>;
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
  standings: async ({ requirements, subjectQboIds, viewing }) =>
    new Map((await paymentStandings(requirements, subjectQboIds, viewing.amounts)).map((s) => [pairKey(s.requirementId, s.subjectQboId), s.standing])),
  nothingYet: () => NO_INVOICE_YET,
  ticked: false,
};

/**
 * Volunteering (§11): met when confirmed volunteering reaches the amount, in shifts or hours as the requirement counts.
 * The shifts a requirement can count toward are listed in volunteer_shift_requirement, so it needs no column of its
 * own. Nothing is confirmed until check-in is built: that slice reads its credit here and passes it as `confirmed`
 * (and leaves out of `signedUp` the places it has credited); a buy-out (§11.5) is met the same way. Until then staff
 * record that the work is done with a tick, as for a checklist item, so a requirement can be met without a waiver.
 */
const volunteer: KindRule = {
  standings: async ({ requirements, subjectQboIds, recorded }) => {
    const signedUp = await signedUpAmounts(requirements, subjectQboIds, pairKey);
    const confirmed = new Map<string, number>(); // credit from check-ins: none yet
    const standings = new Map<string, Standing>();
    for (const key of new Set([...signedUp.keys(), ...confirmed.keys()])) {
      const r = requirements.find((x) => key.startsWith(`${x.id}|`));
      if (r) standings.set(key, volunteerStanding(r, { confirmed: confirmed.get(key) ?? 0, signedUp: signedUp.get(key) ?? 0 }));
    }
    for (const r of recorded) if (r.metAt !== null) standings.set(pairKey(r.requirementId, r.subjectQboId), { met: true, words: "Done" });
    return standings;
  },
  nothingYet: (r) => volunteerStanding(r, { confirmed: 0, signedUp: 0 }),
  ticked: true,
};

export const KIND_RULES: Record<RequirementKind, KindRule | null> = {
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
