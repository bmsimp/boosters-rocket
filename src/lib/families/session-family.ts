// Privacy: how parent code finds the session's own family and students as the app's records, while the session still
// holds the family's QuickBooks id (until stage 3 of the app-owned families spec). The family is found through that
// customer's own family link (./links.ts), in the records' company, and only while its record is active; its students
// are only those the caller was given that the roster cache holds active and directly under that customer and whose
// own active student record is in that family. Nothing a caller passes can bring in another family. It reads only the
// family it is asked about, so parent code may import it (PARENT_CODE_ELSEWHERE in tests/integration/page-guards.test.ts).
import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { family, qboCustomer, student } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "./ids";
import { familyLinkedTo, linksOfCustomers } from "./links";

/** One of the session family's students: the app's own record, with the QuickBooks id the page was given it by. */
export type SessionStudent = { id: AppStudentId; qboId: string; name: string };
export type SessionFamily = { familyId: AppFamilyId; students: SessionStudent[] };

/** The app family linked to the session's family customer, only while that family record is active; null otherwise. */
export async function activeFamilyOf(familyQboId: string, tx?: Tx): Promise<AppFamilyId | null> {
  const familyId = await familyLinkedTo(familyQboId, tx);
  if (familyId === null) return null;
  const [mine] = await (tx ?? db).select({ active: family.active }).from(family).where(eq(family.id, familyId));
  return mine?.active ? familyId : null;
}

/**
 * The session's family as the app's records, with those of `students` (what loadMyFamily() gave, by QuickBooks id;
 * untrusted) that are its own: held active and directly under `familyQboId` in the roster cache, with their own active
 * student record in this family. In the order given. Null when the family has no active record.
 */
export async function sessionFamily(familyQboId: string, students: readonly { qboId: string; name: string }[] | null, tx?: Tx): Promise<SessionFamily | null> {
  const familyId = await activeFamilyOf(familyQboId, tx);
  if (familyId === null) return null;
  return { familyId, students: await ownStudents(familyQboId, familyId, students ?? [], tx) };
}

async function ownStudents(familyQboId: string, familyId: AppFamilyId, students: readonly { qboId: string; name: string }[], tx?: Tx): Promise<SessionStudent[]> {
  const asked = students.map((s) => s.qboId);
  if (asked.length === 0) return [];
  const q = tx ?? db;
  const under = await q.select({ qboId: qboCustomer.qboId }).from(qboCustomer)
    .where(and(eq(qboCustomer.parentQboId, familyQboId), eq(qboCustomer.active, true), inArray(qboCustomer.qboId, asked)));
  if (under.length === 0) return [];
  const links = await linksOfCustomers({ families: [], students: under.map((c) => c.qboId) }, tx);
  const recordIds = [...links.studentOfCustomer.values()];
  const records = recordIds.length === 0 ? [] : await q.select({ id: student.id }).from(student)
    .where(and(inArray(student.id, recordIds), eq(student.familyId, familyId), eq(student.active, true)));
  const theirs = new Set(records.map((r) => String(r.id)));
  return students.flatMap((s) => {
    const id = links.studentOfCustomer.get(s.qboId);
    return id !== undefined && theirs.has(String(id)) ? [{ id, qboId: s.qboId, name: s.name }] : [];
  });
}

/**
 * Of these student records, the ones still active and in this family: a place a student fills, and credit for one,
 * belongs to the family it was made from only while that is so (AGENTS.md, Volunteering).
 */
export async function studentsStillIn(familyId: AppFamilyId, studentIds: readonly AppStudentId[], tx?: Tx): Promise<Set<string>> {
  if (studentIds.length === 0) return new Set();
  const rows = await (tx ?? db).select({ id: student.id }).from(student)
    .where(and(inArray(student.id, [...studentIds]), eq(student.familyId, familyId), eq(student.active, true)));
  return new Set(rows.map((r) => String(r.id)));
}
