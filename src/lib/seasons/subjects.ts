// Staff only: this loads every family in the club. Never imported by parent code (tests/integration/page-guards.test.ts).
import "server-only";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { family, student } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { recordNameWords } from "@/lib/families/words";
import { getShape } from "@/lib/roster/shape";
import { isCovered, type Requirement } from "./progress";

/**
 * A family as the season keeps it: the app's own record of the family and its students (stage 3 of the app-owned
 * families spec), named as a page shows them. No QuickBooks id: a caller that needs a customer for something that is
 * QuickBooks' own asks src/lib/families/links.ts at that point. A family's staff pages are addressed by `id`
 * (seasonFamilyAt()).
 */
export type SeasonFamily = { id: AppFamilyId; name: string; students: { id: AppStudentId; name: string }[] };
/** One family or one student a requirement can be asked of, by the app's own id, with the family it belongs to (whose page `familyId` addresses). */
export type SeasonSubject = ({ kind: "family"; id: AppFamilyId } | { kind: "student"; id: AppStudentId }) & {
  name: string; familyId: AppFamilyId; familyName: string;
};

/** By name, ignoring case and accents, as the roster lists them; one record before another of the same name by its id, so the order is steady. */
const COLLATOR = new Intl.Collator("en", { sensitivity: "base" });
const byName = (a: { name: string; id: unknown }, b: { name: string; id: unknown }) => COLLATOR.compare(a.name, b.name) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);

async function activeFamilies(only?: AppFamilyId): Promise<SeasonFamily[]> {
  const [families, students] = await Promise.all([
    db.select({ id: family.id, name: family.name }).from(family).where(only === undefined ? eq(family.active, true) : and(eq(family.active, true), eq(family.id, only))),
    // An active student is always in a family (student_active_in_family); only those of an active family are kept below.
    db.select({ id: student.id, familyId: student.familyId, name: student.name }).from(student)
      .where(and(eq(student.active, true), only === undefined ? isNotNull(student.familyId) : eq(student.familyId, only))),
  ]);
  const under = new Map<string, { id: AppStudentId; name: string }[]>();
  for (const s of students) {
    if (s.familyId === null) continue;
    const key = String(s.familyId);
    under.set(key, [...(under.get(key) ?? []), { id: s.id, name: recordNameWords(s.name, "student") }]);
  }
  return families.map((f) => ({ id: f.id, name: recordNameWords(f.name, "family") })).sort(byName)
    .map((f) => ({ ...f, students: (under.get(String(f.id)) ?? []).sort(byName) }));
}

/**
 * Every active family the app keeps, each with its active students: who a requirement can be asked of, the one place
 * the season's, volunteering's and forms' staff pages and jobs, and the staff home, read the club's families through.
 * Read from the app's own tables alone (`family`, and `student` by its `family_id`): no link, no membership shape and
 * no QuickBooks connection is needed, so a family with no QuickBooks customer is here like any other, and the list
 * stands while the shape is broken or QuickBooks is disconnected. While the records mirror the roster cache (every
 * roster read and staff write keeps them in step) these are the roster's active families and the active students
 * directly under each; in flat books a member is a family and nobody is a student. By name, as the roster lists them.
 */
export async function loadSeasonFamilies(): Promise<SeasonFamily[]> {
  return activeFamilies();
}

/**
 * The family a staff page's address names, by the app's own family id (checked by familyRecordAt() first), as the
 * season keeps it: the one place the season's and volunteer credit's family pages find it. Null when the record isn't
 * active.
 */
export async function seasonFamilyAt(familyId: AppFamilyId): Promise<SeasonFamily | null> {
  return (await activeFamilies(familyId))[0] ?? null;
}

/** Everyone a requirement could be asked of: the families for a per-family one, the students for a per-student one. */
export function candidatesFor(appliesTo: Requirement["appliesTo"], families: readonly SeasonFamily[]): SeasonSubject[] {
  return appliesTo === "family"
    ? families.map((f): SeasonSubject => ({ kind: "family", id: f.id, name: f.name, familyId: f.id, familyName: f.name }))
    : families.flatMap((f) => f.students.map((s): SeasonSubject => ({ kind: "student", id: s.id, name: s.name, familyId: f.id, familyName: f.name })));
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
