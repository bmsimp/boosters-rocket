import type { Roster } from "@/lib/roster/model";

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "3 families, 1 student, 2 parents; 2 customers outside the portal", for the settings view and the roster pages. */
export function rosterCounts(roster: Roster | null): string {
  if (!roster) return "";
  const outside = `${n(roster.outside, "customer", "customers")} outside the portal`;
  if (roster.kind === "flat") return `${n(roster.members.length, "member", "members")}; ${outside}`;
  const students = roster.families.reduce((sum, f) => sum + f.students.length, 0), parents = roster.families.reduce((sum, f) => sum + f.parents.length, 0);
  return `${n(roster.families.length, "family", "families")}, ${n(students, "student", "students")}, ${n(parents, "parent", "parents")}; ${outside}`;
}
