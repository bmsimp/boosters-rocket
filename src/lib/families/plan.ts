import type { MembershipShape } from "@/lib/roster/shape";

/**
 * What the app's own records should be, worked out from the roster cache (stage 1 of
 * docs/superpowers/specs/2026-11-18-app-owned-families-design.md). Pure: importRecordsFromRoster() (./roster-import.ts) loads
 * the inputs and makes the tables agree with the answer; migration 0023 filled them by the same rules in SQL
 * (tests/integration/app-records-fill.test.ts proves the two agree). Every id here is a QuickBooks customer id of the
 * company the roster cache came from. A record is of one kind, family or student, and a customer may have one of each.
 *
 * - Each family of the roster (the family customers in layered books, the members in flat books) has a family record,
 *   and each student of the roster (a customer of the student type directly under one of those families) a student
 *   record in that family, each named as its customer and active when it is.
 * - Nothing else: guardian rows are not the import's (each is given its family record and its own link by whoever makes
 *   it, stage 3's slice 12b1), and no record of the current company names a customer any more, so every customer planned
 *   is one the cache holds.
 *
 * The answer lists what must exist. Records that exist and are not in it are kept, inactive (./roster-import.ts): nothing
 * but a change of company deletes one.
 */
export type PlanCustomer = { qboId: string; displayName: string; active: boolean; parentQboId: string | null; typeQboId: string | null };
export type RecordKind = "family" | "student";
export type PlanInput = { shape: MembershipShape | null; customers: PlanCustomer[] };

export type PlannedFamily = { name: string | null; active: boolean };
export type PlannedStudent = { name: string | null; active: boolean; familyCustomerId: string | null };
export type Plan = {
  /** Family records by their customer. */
  families: Map<string, PlannedFamily>;
  /** Student records by their customer. */
  students: Map<string, PlannedStudent>;
};

export const EMPTY_PLAN: Plan = { families: new Map(), students: new Map() };

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

  const families = new Map<string, PlannedFamily>();
  for (const id of rosterFamilies) families.set(id, { name: byId.get(id)!.displayName, active: byId.get(id)!.active });
  const students = new Map<string, PlannedStudent>();
  for (const [id, familyCustomerId] of rosterStudents) students.set(id, { name: byId.get(id)!.displayName, active: byId.get(id)!.active, familyCustomerId });
  return { families, students };
}

/**
 * The plan narrowed to one family customer: its family record and the student records of the customers the plan holds
 * directly under it, by the same rules. What "Create a family from this" makes (src/lib/roster/no-family.ts, through
 * importRecordsFromRoster()'s `one`): one definition of which customers are a family's students and what each record is
 * named, not a second copy. Empty when the plan has no family record of that customer.
 */
export function planForOneFamily(plan: Plan, familyCustomerId: string): Plan {
  const f = plan.families.get(familyCustomerId);
  if (f === undefined) return EMPTY_PLAN;
  return { families: new Map([[familyCustomerId, f]]), students: new Map([...plan.students].filter(([, s]) => s.familyCustomerId === familyCustomerId)) };
}
