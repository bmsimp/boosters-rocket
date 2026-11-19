// Privacy: the queries a parent's Forms pages read through, and the only ones. The family is the session's
// (ctx.familyId, the app's own family record) and nothing else, and only while that record is active (activeFamilyOf(),
// src/lib/families/session-family.ts); every request is read and written by it. No link to the accounting system is
// needed. A form is one the family's own current season asks of
// it or of a student under it (loadMySeason reads the session's family alone and gives each student's own record); a
// request id from an address or an action is looked up within that family and then checked against those forms, so
// another family's id finds nothing. It never imports the staff-only modules: tests/integration/page-guards.test.ts
// scans this folder.
import "server-only";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { requirement, signatureRequest, type FormSetting } from "@/lib/db/schema";
import type { ParentCtx } from "@/lib/guards";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { activeFamilyOf } from "@/lib/families/session-family";
import { loadMyFamily, type MyFamily } from "@/lib/parents/my-family";
import { loadMySeason, type MySeason } from "@/lib/seasons/my-season";
import { isUuid } from "@/lib/seasons/ids";
import type { Line, SubjectId } from "@/lib/seasons/progress";
import { requestOfFamily, subjectOfRequest, type RequestRow } from "./requests";
import { getFormsConfig } from "./settings";

/** One form as it stands for the family or one student. `requestId` is null only for a form another family opened for this student before they moved. */
export type MyFormLine = { requestId: string | null; line: Line; stepName: string };
/** `key` tells the groups apart on the page: the subject's own id as text, never shown. */
export type MyFormGroup = { key: string; name: string; who: "family" | "student"; forms: MyFormLine[] };
export type MyForms = { seasonName: string; today: string; ready: boolean; groups: MyFormGroup[] };

type Asked = { subject: SubjectId; studentId: AppStudentId | null; name: string; who: "family" | "student"; stepName: string; line: Line };

/** Every form the current season asks of this family, in the order the season lists them: the family's own, then each student's. */
function formsAsked(season: MySeason, family: MyFamily, familyId: AppFamilyId): Asked[] {
  const asked: Asked[] = [];
  for (const step of season.steps) for (const line of step.family) if (line.kind === "form") asked.push({ subject: familyId, studentId: null, name: family.name, who: "family", stepName: step.name, line });
  for (const step of season.steps) for (const student of step.students) for (const line of student.lines) {
    if (line.kind === "form") asked.push({ subject: student.id, studentId: student.id, name: student.name, who: "student", stepName: step.name, line });
  }
  return asked;
}
const sameSubject = (a: SubjectId, b: SubjectId) => String(a) === String(b);

/**
 * This season's forms for the signed-in family, grouped by who each is for; null when there is no current season, or
 * the session's family has no active record. `family` is what loadMyFamily(ctx) returned for the same session. A
 * request row is made here for each form that has none yet (state "not opened"), so each has an id to open it by. A
 * student's row another family left for a student who has since moved here is taken over only while nothing was ever
 * made for it.
 */
export async function loadMyForms(ctx: ParentCtx, family: MyFamily): Promise<MyForms | null> {
  const season = await loadMySeason(ctx);
  if (!season) return null;
  const familyId = await activeFamilyOf(ctx.familyId);
  if (familyId === null) return null;
  const asked = formsAsked(season, family, familyId);
  const ready = (await getFormsConfig()) !== null;
  if (asked.length === 0) return { seasonName: season.name, today: season.today, ready, groups: [] };

  const forFamily = asked.filter((a) => a.studentId === null).map((a) => ({ requirementId: a.line.requirementId, familyId }));
  const forStudents = asked.flatMap((a) => (a.studentId === null ? [] : [{ requirementId: a.line.requirementId, familyId, studentId: a.studentId }]));
  if (forFamily.length) await db.insert(signatureRequest).values(forFamily).onConflictDoNothing({ target: [signatureRequest.requirementId, signatureRequest.familyId], where: isNull(signatureRequest.studentId) });
  if (forStudents.length) await db.insert(signatureRequest).values(forStudents).onConflictDoUpdate({
    target: [signatureRequest.requirementId, signatureRequest.studentId], targetWhere: isNotNull(signatureRequest.studentId),
    set: { familyId: sql`excluded.family_id`, updatedAt: new Date() },
    setWhere: sql`${signatureRequest.familyId} <> excluded.family_id AND ${signatureRequest.state} = 'not_opened' AND ${signatureRequest.envelopeId} IS NULL AND ${signatureRequest.preparingAt} IS NULL`,
  });
  const rows = await db.select({ id: signatureRequest.id, requirementId: signatureRequest.requirementId, familyId: signatureRequest.familyId, studentId: signatureRequest.studentId }).from(signatureRequest)
    .where(and(eq(signatureRequest.familyId, familyId), inArray(signatureRequest.requirementId, [...new Set(asked.map((a) => a.line.requirementId))])));
  const idOf = (a: Asked) => rows.find((r) => r.requirementId === a.line.requirementId && sameSubject(subjectOfRequest(r), a.subject))?.id ?? null;

  const groups: MyFormGroup[] = [];
  for (const a of asked) {
    let group = groups.find((g) => g.key === String(a.subject));
    if (!group) groups.push(group = { key: String(a.subject), name: a.name, who: a.who, forms: [] });
    group.forms.push({ requestId: idOf(a), line: a.line, stepName: a.stepName });
  }
  return { seasonName: season.name, today: season.today, ready, groups };
}

export type MyForm = {
  row: RequestRow;
  /** The session's own app family: the request names it. */
  familyId: AppFamilyId;
  line: Line; stepName: string; today: string;
  subject: { id: SubjectId; name: string; who: "family" | "student" };
  appliesTo: "family" | "student";
  /** The template staff attached and who must sign; null until they have. */
  setting: FormSetting | null;
};

/**
 * One form of the signed-in family, by the id in the address or the action: the family's own request (the row names
 * the session's app family), for a form the family's current season still asks of that student or of the family. Null
 * for anything else, whatever the reason: the caller answers 404 or refuses, in the same words.
 */
export async function findMyForm(ctx: ParentCtx, requestId: unknown): Promise<MyForm | null> {
  if (!isUuid(requestId)) return null;
  const familyId = await activeFamilyOf(ctx.familyId);
  if (familyId === null) return null;
  const row = await requestOfFamily(requestId, familyId);
  if (!row) return null;
  const family = await loadMyFamily(ctx);
  if (!family) return null;
  const season = await loadMySeason(ctx);
  if (!season) return null;
  const asked = formsAsked(season, family, familyId).find((a) => a.line.requirementId === row.requirementId && sameSubject(a.subject, subjectOfRequest(row)));
  if (!asked) return null;
  const [r] = await db.select({ form: requirement.form, appliesTo: requirement.appliesTo }).from(requirement).where(eq(requirement.id, row.requirementId));
  if (!r) return null;
  return { row, familyId, line: asked.line, stepName: asked.stepName, today: season.today, subject: { id: asked.subject, name: asked.name, who: asked.who }, appliesTo: r.appliesTo, setting: r.form ?? null };
}
