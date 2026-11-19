// Privacy: how parent code reads the session's own family and its students as the app's records (stage 3 of the
// app-owned families spec). The family is the session's (ctx.familyId, which the gate found from the person's own open
// guardian row: src/lib/auth/resolve.ts) and nothing else; it is shown only while its record is active. Its students
// are the app's own: the `student` rows of that family that are active, read here and nowhere else, so nothing a caller
// passes can bring in another family's student. No link and no roster cache is read: a family with no link to the
// accounting system still has its season, forms and volunteering. It reads only the family it is asked about, so parent
// code may import it (PARENT_CODE_ELSEWHERE in tests/integration/page-guards.test.ts).
import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { family, student } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "./ids";
import { recordNameWords } from "./words";

/** One of the session family's students: the app's own record, and its name in words (recordNameWords()). */
export type SessionStudent = { id: AppStudentId; name: string };
/** The session's family as the app's records: its name as the record holds it (null when the portal knows none), and its active students. */
export type SessionFamily = { familyId: AppFamilyId; name: string | null; students: SessionStudent[] };

/** This family, only while its record is active; null otherwise. */
export async function activeFamilyOf(familyId: AppFamilyId, tx?: Tx): Promise<AppFamilyId | null> {
  const [mine] = await (tx ?? db).select({ active: family.active }).from(family).where(eq(family.id, familyId));
  return mine?.active ? familyId : null;
}

/** The order a family's students are listed in: by name as a page says it, then by the record's own id. */
const byName = (a: SessionStudent, b: SessionStudent) =>
  a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);

/**
 * The session's family as the app's records, with its active students, by name. Null when the family's record is not
 * active (or not there).
 */
export async function sessionFamily(familyId: AppFamilyId, tx?: Tx): Promise<SessionFamily | null> {
  const q = tx ?? db;
  const [mine] = await q.select({ name: family.name, active: family.active }).from(family).where(eq(family.id, familyId));
  if (!mine?.active) return null;
  const rows = await q.select({ id: student.id, name: student.name }).from(student).where(and(eq(student.familyId, familyId), eq(student.active, true)));
  return { familyId, name: mine.name, students: rows.map((r) => ({ id: r.id, name: recordNameWords(r.name, "student") })).sort(byName) };
}

/**
 * Of these student records, the ones still active and in this family: a place a student fills, and credit for one,
 * belongs to the family it was made from only while that is so (AGENTS.md, Volunteering). A write that names a student
 * the page sent checks it here, inside its transaction: a student's id is the app's, the same in every family, so it is
 * always looked up within the family.
 */
export async function studentsStillIn(familyId: AppFamilyId, studentIds: readonly AppStudentId[], tx?: Tx): Promise<Set<string>> {
  if (studentIds.length === 0) return new Set();
  const rows = await (tx ?? db).select({ id: student.id }).from(student)
    .where(and(inArray(student.id, [...studentIds]), eq(student.familyId, familyId), eq(student.active, true)));
  return new Set(rows.map((r) => String(r.id)));
}
