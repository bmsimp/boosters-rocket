// Where the books have a student's linked customer, against the family the portal has the student in, and its words:
// one place for both pages that say it (a family's page, studentStanding() in src/app/staff/(app)/roster/[id]/page.tsx,
// and the accounting links screen's differences, src/lib/accounting/differences.ts), so the two never say a move
// differently. Since stage 3's slice 9c the portal and QuickBooks can disagree where a student is: a move made in
// QuickBooks alone, or a move saved in the portal first that QuickBooks hasn't taken (app-owned families spec,
// section 5). Pure: it reads nothing, and every input is passed in.
import type { Cust, Roster } from "./model";
import type { MembershipShape } from "./shape";

/**
 * Where the books have a student's linked customer:
 * - `here`: directly under the family's own customer, which the roster lists as a family;
 * - `other_family`: directly under another customer the roster lists as a family (`familyQboId`, its name in the
 *   books, `familyName`: QuickBooks text, shown as text only), whether or not a family of the portal is linked to it;
 * - `top`: under no customer at all;
 * - `under_other`: under a customer that is no family here (a stray's parent: another type, or none; the family's own
 *   customer included, once the roster no longer lists it as a family);
 * - `not_student`: not a student customer in the books now (its type changed);
 * - `gone`: the cache holds customers, and not this one;
 * - `unknown`: nothing can be told: the cache holds no customer at all, or the shape names no student type (flat books
 *   included), so no customer is a student customer and a type that hasn't changed isn't said to have.
 */
export type StudentPlace =
  | { at: "here" }
  | { at: "other_family"; familyQboId: string; familyName: string }
  | { at: "top" } | { at: "under_other" } | { at: "not_student" } | { at: "gone" } | { at: "unknown" };

/** Where a student's linked customer is, against the family's own customer (null when the family has none). */
export type PlaceOf = (studentCustomerId: string, familyCustomerId: string | null) => StudentPlace;

/**
 * The place rule over one roster and the cache's customers it was built from (buildRoster()), built once for a page
 * however many students it places. A customer is a student customer by the shape's student type (layered books only);
 * a family is one the roster lists as a family (by the shape's family type, active or not).
 */
export function placesOf(shape: MembershipShape, roster: Roster, customers: readonly Cust[]): PlaceOf {
  const byId = new Map(customers.map((c) => [c.qboId, c]));
  const families = new Map(roster.kind === "flat" ? [] : roster.families.map((f) => [f.customer.qboId, f.customer]));
  const studentType = shape.kind === "layered" ? shape.studentTypeId : null;
  return (studentCustomerId, familyCustomerId) => {
    const c = byId.get(studentCustomerId);
    if (c === undefined) return byId.size > 0 ? { at: "gone" } : { at: "unknown" };
    if (studentType === null) return { at: "unknown" };
    if (c.typeQboId !== studentType) return { at: "not_student" };
    if (c.parentQboId === null) return { at: "top" };
    // Under the family's own customer only while the roster lists it as a family: otherwise it is no family here.
    if (familyCustomerId !== null && c.parentQboId === familyCustomerId && families.has(familyCustomerId)) return { at: "here" };
    const other = families.get(c.parentQboId);
    return other ? { at: "other_family", familyQboId: other.qboId, familyName: other.displayName } : { at: "under_other" };
  };
}

/**
 * A place in words, the same on both pages: they name QuickBooks, as a family's page always has ("Under <family> in
 * QuickBooks"). A family's name is the books' text, said as text.
 */
export function placeWords(p: StudentPlace): string {
  switch (p.at) {
    case "here": return "Under this family in QuickBooks";
    case "other_family": return `Under ${p.familyName} in QuickBooks`;
    case "top": return "Not under any customer in QuickBooks";
    case "under_other": return "Under a customer in QuickBooks that isn't a family here";
    case "not_student": return "Not a student customer in QuickBooks now";
    case "gone": return "Its customer isn't in the portal's copy of QuickBooks any more";
    case "unknown": return "Not under a family in QuickBooks";
  }
}
