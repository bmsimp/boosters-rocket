import type { MembershipShape } from "@/lib/roster/shape";

/**
 * What the app's own records should be, worked out from what the database holds (stage 1 of
 * docs/superpowers/specs/2026-11-18-app-owned-families-design.md). Pure: keepAppRecordsInStep() (./in-step.ts) loads
 * the inputs and makes the tables agree with the answer, and migration 0023 fills them by the same rules in SQL
 * (tests/integration/app-records-fill.test.ts proves the two agree). Every id here is a QuickBooks customer id of the
 * company the roster cache came from.
 *
 * - The roster's families are a record each: the family customers in layered books, the members in flat books. So are
 *   its students: a customer of the student type directly under one of those families. Each is active when its own
 *   customer is, and named as the cache names it.
 * - Every other customer a record of the current company names (`refs`: a guardian row's family, a tick, a sign-up, a
 *   buy-out...) is a record too, of the kind the record names it as (a family before a student), inactive and named
 *   from what the portal last knew: the cache's name, else the name its record has already (`known`: the cache held it
 *   once), else `hints` (a kept form, a request, a sign-up), else "Family <id>" or "Student <id>". Such a student is in
 *   no family.
 * - Each guardian row is in the family of its `family_qbo_id`, except one a change of company closed, whose ids are
 *   another company's: it is in none.
 * - Each open guardian row whose sign-in came from a record of its own (a `source_qbo_id` that isn't the family's own
 *   customer) is linked to that record, unless that customer is already a family or student record. Two open rows
 *   from one record: the first by id is linked.
 */
export type PlanCustomer = { qboId: string; displayName: string; active: boolean; parentQboId: string | null; typeQboId: string | null };
export type PlanGuardian = { id: string; familyQboId: string; sourceQboId: string | null; status: "invited" | "active" | "disabled"; disabledReason: string | null };
export type RecordKind = "family" | "student";
export type PlanRef = { customerId: string; kind: RecordKind };
export type PlanInput = {
  shape: MembershipShape | null; customers: PlanCustomer[]; refs: PlanRef[]; guardians: PlanGuardian[];
  /** What the portal last knew a customer the cache doesn't hold as: a kept form's name, a request's, a sign-up's. */
  hints: Map<string, string>;
  /** The name each customer's record has now, by customer: empty for a first fill, as migration 0023's is. */
  known?: Map<string, string>;
};

export type PlannedFamily = { name: string; active: boolean };
export type PlannedStudent = { name: string; active: boolean; familyCustomerId: string | null };
export type Plan = {
  /** Family records by their customer. */
  families: Map<string, PlannedFamily>;
  /** Student records by their customer. */
  students: Map<string, PlannedStudent>;
  /** Each guardian row's family, by the family's customer: null for none. */
  memberships: Map<string, string | null>;
  /** The customer each guardian row is linked to, for the rows that have one. */
  membershipLinks: Map<string, string>;
};

export const EMPTY_PLAN: Plan = { families: new Map(), students: new Map(), memberships: new Map(), membershipLinks: new Map() };

/** A closed link of another company's: its ids name nobody in this one. */
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

  // Each customer is one kind of record: the roster's say first, then what the records name it as, a family first.
  const kindOf = new Map<string, RecordKind>();
  for (const id of rosterFamilies) kindOf.set(id, "family");
  for (const id of rosterStudents.keys()) kindOf.set(id, "student");
  const refs: PlanRef[] = [...i.refs, ...i.guardians.filter((g) => !fromAnotherCompany(g)).map((g) => ({ customerId: g.familyQboId, kind: "family" as const }))];
  for (const r of refs) if (r.kind === "family" && !kindOf.has(r.customerId)) kindOf.set(r.customerId, "family");
  for (const r of refs) if (r.kind === "student" && !kindOf.has(r.customerId)) kindOf.set(r.customerId, "student");

  const nameOf = (id: string, kind: RecordKind) => byId.get(id)?.displayName ?? i.known?.get(id) ?? i.hints.get(id) ?? `${kind === "family" ? "Family" : "Student"} ${id}`;
  const families = new Map<string, PlannedFamily>();
  const students = new Map<string, PlannedStudent>();
  for (const [id, kind] of kindOf) {
    if (kind === "family") families.set(id, { name: nameOf(id, kind), active: rosterFamilies.has(id) && byId.get(id)!.active });
    else students.set(id, { name: nameOf(id, kind), active: rosterStudents.has(id) && byId.get(id)!.active, familyCustomerId: rosterStudents.get(id) ?? null });
  }

  const memberships = new Map<string, string | null>();
  for (const g of i.guardians) memberships.set(g.id, !fromAnotherCompany(g) && families.has(g.familyQboId) ? g.familyQboId : null);

  const membershipLinks = new Map<string, string>();
  const taken = new Set<string>();
  for (const g of [...i.guardians].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const source = g.sourceQboId;
    if (g.status === "disabled" || source === null || source === g.familyQboId || kindOf.has(source) || taken.has(source)) continue;
    membershipLinks.set(g.id, source);
    taken.add(source);
  }
  return { families, students, memberships, membershipLinks };
}
