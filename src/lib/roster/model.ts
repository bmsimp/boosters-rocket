import type { MembershipShape } from "./shape";

export type Cust = { qboId: string; displayName: string; active: boolean; parentQboId: string | null; typeQboId: string | null; email: string | null; phone: string | null };
export type Family = { customer: Cust; students: Cust[]; parents: Cust[] };
export type Roster =
  | { kind: "flat"; members: Cust[]; outside: number }
  | { kind: "layered"; families: Family[]; strays: Cust[]; outside: number };

// Same-named customers keep a steady order: by QuickBooks ID, compared as numbers (9 before 100).
const byName = (a: Cust, b: Cust) => a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" }) || a.qboId.localeCompare(b.qboId, "en", { numeric: true });

/**
 * Turns cached customers into the club's roster (spec §1). Pure. A student or parent belongs to a family only when it
 * sits directly under it; one that doesn't is a stray. Customers the shape doesn't name are only counted.
 */
export function buildRoster(shape: MembershipShape, customers: Cust[]): Roster {
  if (shape.kind === "flat") {
    const types = new Set(shape.memberTypeIds);
    const members = customers.filter((c) => c.typeQboId !== null && types.has(c.typeQboId)).sort(byName);
    return { kind: "flat", members, outside: customers.length - members.length };
  }
  const isFamily = (c: Cust) => c.typeQboId === shape.familyTypeId;
  const isStudent = (c: Cust) => shape.studentTypeId !== null && c.typeQboId === shape.studentTypeId;
  const isParent = (c: Cust) => shape.parentTypeId !== null && c.typeQboId === shape.parentTypeId;
  const families = new Map<string, Family>(customers.filter(isFamily).sort(byName).map((c) => [c.qboId, { customer: c, students: [], parents: [] }]));
  const strays: Cust[] = [];
  let outside = 0;
  for (const c of [...customers].sort(byName)) {
    if (isFamily(c)) continue;
    if (!isStudent(c) && !isParent(c)) { outside++; continue; }
    const family = c.parentQboId ? families.get(c.parentQboId) : undefined;
    if (!family) strays.push(c);
    else (isStudent(c) ? family.students : family.parents).push(c);
  }
  return { kind: "layered", families: [...families.values()], strays, outside };
}
