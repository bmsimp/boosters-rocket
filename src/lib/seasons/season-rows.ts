// The season's chosen lists and ticks, read for the families and students asked about and nothing else, by the app's
// own ids (stage 2 of the app-owned families spec). It imports no rule (./kinds.ts) at run time, so the areas whose
// own records the kind rules read (volunteering: src/lib/volunteer/credit.ts) can read a season through it too. The
// same reads for everyone, for staff, are in ./everyone.ts (STAFF_ONLY_IMPORTS). Parent code may import it.
import "server-only";
import { and, inArray, or, type AnyColumn, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { requirementCover, requirementProgress } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import type { Recorded } from "./kinds";
import type { SubjectId, SubjectsAsked } from "./progress";

/** A season row's family or student: the database holds exactly one of the two (requirement_cover_one_subject, requirement_progress_one_subject). */
export const subjectOf = (row: { familyId: AppFamilyId | null; studentId: AppStudentId | null }): SubjectId => (row.familyId ?? row.studentId)!;

/** Only the rows of these families and students. */
export const rowsOf = (t: { familyId: AnyColumn; studentId: AnyColumn }, asked: SubjectsAsked): SQL | undefined => or(
  ...(asked.families.length ? [inArray(t.familyId, [...asked.families])] : []),
  ...(asked.students.length ? [inArray(t.studentId, [...asked.students])] : []));
export const asksNobody = (asked: SubjectsAsked) => asked.families.length === 0 && asked.students.length === 0;

/** A chosen list's rows as ids by requirement. */
export function coversFrom(rows: readonly { requirementId: string; familyId: AppFamilyId | null; studentId: AppStudentId | null }[]): Map<string, SubjectId[]> {
  const covers = new Map<string, SubjectId[]>();
  for (const r of rows) covers.set(r.requirementId, [...(covers.get(r.requirementId) ?? []), subjectOf(r)]);
  return covers;
}
/** The columns of requirement_progress the rules read, with the row's family or student. */
export const RECORDED_COLUMNS = {
  requirementId: requirementProgress.requirementId, familyId: requirementProgress.familyId, studentId: requirementProgress.studentId, metAt: requirementProgress.metAt,
  metBy: requirementProgress.metBy, waivedAt: requirementProgress.waivedAt, waivedBy: requirementProgress.waivedBy, waivedReason: requirementProgress.waivedReason,
};
/** Rows read with RECORDED_COLUMNS, each with its family or student as one id. */
export const recordedFrom = (rows: readonly ({ familyId: AppFamilyId | null; studentId: AppStudentId | null } & Omit<Recorded, "subjectId">)[]): Recorded[] =>
  rows.map(({ familyId, studentId, ...r }) => ({ ...r, subjectId: subjectOf({ familyId, studentId }) }));

/**
 * The chosen lists of these requirements, by requirement id: only the entries that name one of these families or
 * students. A parent's query passes its own family and students, and so never loads who else is on a list.
 */
export async function loadCovers(requirementIds: readonly string[], asked: SubjectsAsked, tx?: Tx): Promise<Map<string, SubjectId[]>> {
  if (requirementIds.length === 0 || asksNobody(asked)) return new Map();
  return coversFrom(await (tx ?? db).select({ requirementId: requirementCover.requirementId, familyId: requirementCover.familyId, studentId: requirementCover.studentId })
    .from(requirementCover).where(and(inArray(requirementCover.requirementId, [...requirementIds]), rowsOf(requirementCover, asked))));
}

/** What requirement_progress holds for these requirements and only these families or students. */
export async function loadRecorded(requirementIds: readonly string[], asked: SubjectsAsked, tx?: Tx): Promise<Recorded[]> {
  if (requirementIds.length === 0 || asksNobody(asked)) return [];
  return recordedFrom(await (tx ?? db).select(RECORDED_COLUMNS).from(requirementProgress)
    .where(and(inArray(requirementProgress.requirementId, [...requirementIds]), rowsOf(requirementProgress, asked))));
}
