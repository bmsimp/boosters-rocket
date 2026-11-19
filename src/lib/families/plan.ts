import type { MembershipShape } from "@/lib/roster/shape";

/**
 * What the app's own records should be, worked out from what the database holds (stage 1 of
 * docs/superpowers/specs/2026-11-18-app-owned-families-design.md). Pure: keepAppRecordsInStep() (./in-step.ts) loads
 * the inputs and makes the tables agree with the answer, and migration 0023 fills them by the same rules in SQL
 * (tests/integration/app-records-fill.test.ts proves the two agree). Every id here is a QuickBooks customer id of the
 * company the roster cache came from. A record is of one kind, family or student, and a customer may have one of each.
 *
 * - Each family of the roster (the family customers in layered books, the members in flat books) has a family record,
 *   and each student of the roster (a customer of the student type directly under one of those families) a student
 *   record in that family. Each is active when its own customer is.
 * - Every customer a record of the current company names as a family (`refs`: a guardian row's family, the only record
 *   that still names one) has a family record too, and every one named as a student a student record (none does now,
 *   but the rule stands for any that may), whatever the roster holds it as: a record names a customer as the kind its
 *   column holds. One the roster doesn't hold as that kind is inactive. The records re-keyed since (the season's,
 *   volunteering's, form requests, buy-outs, the money cache, the write queue, and parents' sessions and pending email
 *   changes) are not among them: they name a record by its id and keep it (./in-step.ts). A student the roster doesn't hold is planned in no family; keepAppRecordsInStep() keeps the
 *   family such a student was last in, which a first fill (migration 0023) never knew.
 * - A record is named from the cache, else by the name it has already (`known`, by kind: the cache held it once), else
 *   from `hints` (a current-company kept form's). Otherwise it has no name: the portal never knew one.
 * - Each guardian row is in the family of its `family_qbo_id`, except one a change of company closed, whose ids are
 *   another company's: it is in none.
 * - Each such guardian row whose sign-in came from a record of its own (a `source_qbo_id` that isn't the family's own
 *   customer), open or closed, is linked to that record.
 *
 * The answer lists what must exist. Records that exist and are not in it are kept, inactive (./in-step.ts): nothing
 * but a change of company deletes one.
 */
export type PlanCustomer = { qboId: string; displayName: string; active: boolean; parentQboId: string | null; typeQboId: string | null };
export type PlanGuardian = { id: string; familyQboId: string; sourceQboId: string | null; status: "invited" | "active" | "disabled"; disabledReason: string | null };
export type RecordKind = "family" | "student";
export type PlanRef = { customerId: string; kind: RecordKind };
export type PlanInput = {
  shape: MembershipShape | null; customers: PlanCustomer[]; refs: PlanRef[]; guardians: PlanGuardian[];
  /** What the portal last knew a customer the cache doesn't hold as: a current-company kept form's name. */
  hints: Map<string, string>;
  /** The names the records have now, by kind and customer: empty for a first fill, as migration 0023's is. */
  known?: { families: Map<string, string>; students: Map<string, string> };
};

export type PlannedFamily = { name: string | null; active: boolean };
export type PlannedStudent = { name: string | null; active: boolean; familyCustomerId: string | null };
export type Plan = {
  /** Family records by their customer. */
  families: Map<string, PlannedFamily>;
  /** Student records by their customer. */
  students: Map<string, PlannedStudent>;
  /** Each guardian row's family, by the family's customer: null for none. */
  memberships: Map<string, string | null>;
  /** The customer each guardian row is linked to, for the rows that have a record of their own. */
  membershipLinks: Map<string, string>;
};

export const EMPTY_PLAN: Plan = { families: new Map(), students: new Map(), memberships: new Map(), membershipLinks: new Map() };

/** A link a change of company closed: its ids name nobody in this one. */
const fromAnotherCompany = (g: PlanGuardian) => g.disabledReason === "company_changed";

export function planAppRecords(i: PlanInput): Plan {
  const byId = new Map(i.customers.map((c) => [c.qboId, c]));
  const rosterFamilies = new Set<string>();
  const rosterStudents = new Map<string, string>(); // student -> the family customer they are directly under
  const shape = i.shape;
  if (shape?.kind === "flat") {
    const members = new Set(shape.memberTypeIds);
    for (const c of i.customers) if (c.typeQboId !== null && members.has(c.typeQboId)) rosterFamilies.add(c.qboId);
  } else if (shape?.kind === "layered") {
    for (const c of i.customers) if (c.typeQboId === shape.familyTypeId) rosterFamilies.add(c.qboId);
    for (const c of i.customers) {
      if (shape.studentTypeId !== null && c.typeQboId === shape.studentTypeId && c.parentQboId !== null && rosterFamilies.has(c.parentQboId) && !rosterFamilies.has(c.qboId)) {
        rosterStudents.set(c.qboId, c.parentQboId);
      }
    }
  }

  const refs: PlanRef[] = [...i.refs, ...i.guardians.filter((g) => !fromAnotherCompany(g)).map((g) => ({ customerId: g.familyQboId, kind: "family" as const }))];
  const familyIds = new Set(rosterFamilies), studentIds = new Set(rosterStudents.keys());
  for (const r of refs) (r.kind === "family" ? familyIds : studentIds).add(r.customerId);

  const nameOf = (id: string, known: Map<string, string> | undefined) => byId.get(id)?.displayName ?? known?.get(id) ?? i.hints.get(id) ?? null;
  const families = new Map<string, PlannedFamily>();
  for (const id of familyIds) families.set(id, { name: nameOf(id, i.known?.families), active: rosterFamilies.has(id) && byId.get(id)!.active });
  const students = new Map<string, PlannedStudent>();
  for (const id of studentIds) {
    students.set(id, { name: nameOf(id, i.known?.students), active: rosterStudents.has(id) && byId.get(id)!.active, familyCustomerId: rosterStudents.get(id) ?? null });
  }

  const memberships = new Map<string, string | null>();
  const membershipLinks = new Map<string, string>();
  for (const g of i.guardians) {
    memberships.set(g.id, fromAnotherCompany(g) ? null : g.familyQboId);
    if (!fromAnotherCompany(g) && g.sourceQboId !== null && g.sourceQboId !== g.familyQboId) membershipLinks.set(g.id, g.sourceQboId);
  }
  return { families, students, memberships, membershipLinks };
}
