// Staff only: this loads every family in the club. Never imported by parent code (tests/integration/page-guards.test.ts).
import "server-only";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { linksOfCustomers } from "@/lib/families/links";
import { loadRosterPage } from "@/lib/roster/queries";
import { getShape } from "@/lib/roster/shape";
import { isCovered, type Requirement } from "./progress";

/**
 * A family as the roster lists it, by QuickBooks id: what the areas still keyed by QuickBooks ids read (forms'
 * matrix and reminders, volunteering's staff pages and reminders; boundaries AGENTS.md lists, Seasons).
 */
export type FamilySubject = { qboId: string; name: string; students: { qboId: string; name: string }[] };

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

/**
 * A family on the roster as the season keeps it: the app's own records of the family and its students (stage 2 of the
 * app-owned families spec). `qboId` is only the address of the family's staff progress page, which still names the
 * family by its QuickBooks id (seasonFamilyAt()).
 */
export type SeasonFamily = { id: AppFamilyId; qboId: string; name: string; students: { id: AppStudentId; name: string }[] };
/** One family or one student a requirement can be asked of, by the app's own id, with the family it belongs to. */
export type SeasonSubject = ({ kind: "family"; id: AppFamilyId } | { kind: "student"; id: AppStudentId }) & {
  name: string; familyId: AppFamilyId; familyName: string;
  /** The address of the family's staff progress page (seasonFamilyAt()). */
  familyQboId: string;
};

/**
 * loadSubjects(), each family and student as its own app record, found through the link of its kind in the records'
 * company: the one place the season's staff pages and writes turn the roster into the app's ids. A family or student
 * with no record there (the records are kept in step with every roster read, so none should be) is left out, as if it
 * weren't on the roster. Null when the roster can't be shown.
 */
export async function loadSeasonFamilies(): Promise<SeasonFamily[] | null> {
  const families = await loadSubjects();
  if (!families) return null;
  const links = await linksOfCustomers({ families: families.map((f) => f.qboId), students: families.flatMap((f) => f.students.map((s) => s.qboId)) });
  return families.flatMap((f) => {
    const id = links.familyOfCustomer.get(f.qboId);
    if (id === undefined) return [];
    return [{ id, qboId: f.qboId, name: f.name, students: f.students.flatMap((s) => {
      const sid = links.studentOfCustomer.get(s.qboId);
      return sid === undefined ? [] : [{ id: sid, name: s.name }];
    }) }];
  });
}

/**
 * The family a staff page's address names, by its QuickBooks id (the address each page has today): the one place an
 * address is turned into the app's family. Null when it isn't an active family on the roster.
 */
export async function seasonFamilyAt(familyQboId: string): Promise<SeasonFamily | null> {
  return (await loadSeasonFamilies())?.find((f) => f.qboId === familyQboId) ?? null;
}

/** Everyone a requirement could be asked of: the families for a per-family one, the students for a per-student one. */
export function candidatesFor(appliesTo: Requirement["appliesTo"], families: readonly SeasonFamily[]): SeasonSubject[] {
  return appliesTo === "family"
    ? families.map((f): SeasonSubject => ({ kind: "family", id: f.id, name: f.name, familyId: f.id, familyName: f.name, familyQboId: f.qboId }))
    : families.flatMap((f) => f.students.map((s): SeasonSubject => ({ kind: "student", id: s.id, name: s.name, familyId: f.id, familyName: f.name, familyQboId: f.qboId })));
}

/** Those a requirement is asked of now: its candidates, less whoever a chosen list leaves out. */
export function coveredBy(requirement: Requirement, families: readonly SeasonFamily[]): SeasonSubject[] {
  return candidatesFor(requirement.appliesTo, families).filter((s) => isCovered(requirement, s.id));
}

/**
 * True when the club's membership shape is set and lists no students (members who are their own families, or families
 * with no student type): a requirement asked of each student would then be asked of nobody. False while there is no
 * shape yet, so a season can be set up before the roster is.
 */
export async function rosterListsNoStudents(): Promise<boolean> {
  const shape = await getShape();
  return shape !== null && (shape.kind === "flat" || shape.studentTypeId === null);
}
