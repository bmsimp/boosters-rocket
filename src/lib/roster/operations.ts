import type { RosterRole } from "@/lib/db/schema";
import type { MembershipShape } from "./shape";

/**
 * What staff may change in QuickBooks from the roster pages, as the membership shape allows (v1 spec §6.1). Pure, and
 * the only place that knows: the pages offer what this offers, and the write module refuses what it does not.
 */
export type RosterOperation =
  | "create_family" | "add_student" | "add_parent" | "rename_family" | "rename_student" | "rename_parent" | "move_student"
  | "deactivate_family" | "deactivate_student" | "deactivate_parent"
  | "create_member" | "rename_member" | "deactivate_member";

export type ShapeOperations = {
  offered: ReadonlySet<RosterOperation>;
  /** What isn't offered under this shape, and why, in words the pages show. */
  notOffered: { operations: RosterOperation[]; why: string }[];
};

const LAYERED_ALL: RosterOperation[] = ["create_family", "add_student", "add_parent", "rename_family", "rename_student", "rename_parent", "move_student",
  "deactivate_family", "deactivate_student", "deactivate_parent"];

export const NOT_HERE = {
  contact: "A guardian's phone and mailing address are the portal's own: they change them themselves on their Family page, and staff change them on the person's page (or on the family's page, where the club's books have no parents of their own). Each change is then sent to their own record in QuickBooks (the family's, where the books have no parents of their own), unless QuickBooks holds details there the portal didn't know of, which the Reconciliation page then lists. Email addresses are changed in QuickBooks; the roster shows them once it is read again.",
  parentsInFamilyEmail: "This club's parents aren't customers of their own in QuickBooks: their addresses are in the family's email field, which is changed in QuickBooks; the roster shows it once it is read again.",
  noStudents: "This club doesn't identify students in QuickBooks, so the portal can't tell a student and can't add or move one.",
  flat: "Members aren't grouped into families, so there are no students or parents to add.",
} as const;

export function shapeOperations(shape: MembershipShape): ShapeOperations {
  if (shape.kind === "flat") {
    return { offered: new Set<RosterOperation>(["create_member", "rename_member", "deactivate_member"]), notOffered: [{ operations: [], why: NOT_HERE.flat }] };
  }
  const notOffered: ShapeOperations["notOffered"] = [];
  let ops = LAYERED_ALL;
  if (shape.studentTypeId === null) {
    const gone: RosterOperation[] = ["add_student", "move_student", "rename_student", "deactivate_student"];
    ops = ops.filter((o) => !gone.includes(o));
    notOffered.push({ operations: gone, why: NOT_HERE.noStudents });
  }
  if (shape.parentTypeId === null) {
    const gone: RosterOperation[] = ["add_parent", "rename_parent", "deactivate_parent"];
    ops = ops.filter((o) => !gone.includes(o));
    notOffered.push({ operations: gone, why: NOT_HERE.parentsInFamilyEmail });
  }
  return { offered: new Set(ops), notOffered };
}

export const offers = (shape: MembershipShape, op: RosterOperation): boolean => shapeOperations(shape).offered.has(op);

/** The operation that renames or makes inactive a customer of this role. */
export const renameOf = (role: RosterRole): RosterOperation => `rename_${role}`;
export const deactivateOf = (role: RosterRole): RosterOperation => `deactivate_${role}`;

/**
 * The customer type a new customer of this role is made with. A flat club with several member types names the one staff
 * chose, which must be one of them; with one it is that one. Null when the shape has no such role or the choice isn't one.
 */
export function typeForNew(shape: MembershipShape, role: RosterRole, chosen: string | null): string | null {
  if (shape.kind === "flat") {
    if (role !== "member") return null;
    if (chosen === null) return shape.memberTypeIds.length === 1 ? shape.memberTypeIds[0]! : null;
    return shape.memberTypeIds.includes(chosen) ? chosen : null;
  }
  return role === "family" ? shape.familyTypeId : role === "student" ? shape.studentTypeId : role === "parent" ? shape.parentTypeId : null;
}
