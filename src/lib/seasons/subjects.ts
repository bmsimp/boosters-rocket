// Staff only: this loads every family in the club. Never imported by parent code (tests/integration/page-guards.test.ts).
import "server-only";
import { loadRosterPage } from "@/lib/roster/queries";
import { isCovered, type Requirement } from "./progress";

export type FamilySubject = { qboId: string; name: string; students: { qboId: string; name: string }[] };
/** One family or one student a requirement can be asked of, with the family it belongs to. */
export type Subject = { qboId: string; name: string; familyQboId: string; familyName: string };

/**
 * Every active family the roster shows, each with its active students: who a requirement can be asked of. In a club
 * whose members are their own families (the flat shape) nobody is a student. Null when the roster can't be shown
 * (no membership shape, or a cache read from another company): nothing is guessed.
 */
export async function loadSubjects(): Promise<FamilySubject[] | null> {
  const { roster } = await loadRosterPage();
  if (!roster) return null;
  if (roster.kind === "flat") return roster.members.filter((m) => m.active).map((m) => ({ qboId: m.qboId, name: m.displayName, students: [] }));
  return roster.families.filter((f) => f.customer.active).map((f) => ({
    qboId: f.customer.qboId, name: f.customer.displayName,
    students: f.students.filter((s) => s.active).map((s) => ({ qboId: s.qboId, name: s.displayName })),
  }));
}

/** Everyone a requirement could be asked of: the families for a per-family one, the students for a per-student one. */
export function candidatesFor(appliesTo: Requirement["appliesTo"], families: readonly FamilySubject[]): Subject[] {
  return appliesTo === "family"
    ? families.map((f) => ({ qboId: f.qboId, name: f.name, familyQboId: f.qboId, familyName: f.name }))
    : families.flatMap((f) => f.students.map((s) => ({ qboId: s.qboId, name: s.name, familyQboId: f.qboId, familyName: f.name })));
}

/** Those a requirement is asked of now: its candidates, less whoever a chosen list leaves out. */
export function coveredBy(requirement: Requirement, families: readonly FamilySubject[]): Subject[] {
  return candidatesFor(requirement.appliesTo, families).filter((s) => isCovered(requirement, s.qboId));
}
