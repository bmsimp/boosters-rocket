// Privacy: the one query a parent page reads its season through. The family is the session's (ctx.familyQboId) and
// nothing else: it is found as the app's own family through that customer's own family link, in the records' company
// (src/lib/families/links.ts), and only while that family is active; progress and chosen lists are then read only for
// that family and the students under it, and a requirement that covers none of them is dropped, title and all
// (loadFamilyStanding in ./recorded.ts). It never imports the staff-only modules (./setup.ts, ./subjects.ts,
// ./staff-progress.ts, src/lib/roster/queries.ts, src/lib/families/in-step.ts): tests/integration/page-guards.test.ts
// scans this file.
import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { family, qboCustomer, season, student } from "@/lib/db/schema";
import type { ParentCtx } from "@/lib/guards";
import type { AppStudentId } from "@/lib/families/ids";
import { familyLinkedTo, linksOfCustomers } from "@/lib/families/links";
import type { MyStudent } from "@/lib/parents/my-family";
import { loadFamilyStanding } from "./recorded";
import type { FamilyRoster, SeasonStanding } from "./progress";

/**
 * The current season as a parent's pages read it. Each student is the app's own record (`id`), and nothing of a
 * student's QuickBooks id is in it: the Home students box matches a standing to loadMyFamily()'s students by the app's
 * id each of those carries, and the forms pages (src/lib/forms/my-forms.ts) find a form's request by it too.
 */
export type MySeason = SeasonStanding & {
  /** The current season's name, in the club's words. */
  name: string;
  /** The club's date the standing was worked out for (YYYY-MM-DD). */
  today: string;
};

/**
 * The club's current season as it stands for the signed-in parent's family, or null when there is no current season
 * (the page then shows no ruler and nothing in its place), or when the session's family has no active app family
 * record in the records' company.
 *
 * `students` is what loadMyFamily(ctx) returned for the same session: the family's active students, or null when the
 * club doesn't list students. It is not trusted to belong to the family: only those the roster cache holds directly
 * under ctx.familyQboId, whose own active student record is in the session's app family, are used, so nothing a
 * caller passes can bring in another family's student.
 */
export async function loadMySeason(ctx: Pick<ParentCtx, "familyQboId" | "parentId">, students: readonly Pick<MyStudent, "qboId" | "name">[] | null): Promise<MySeason | null> {
  const [current] = await db.select({ id: season.id, name: season.name }).from(season).where(eq(season.isCurrent, true));
  if (!current) return null;
  // The session's family, as the app's own record: through its own family link, and only while that record is active.
  const familyId = await familyLinkedTo(ctx.familyQboId);
  if (familyId === null) return null;
  const [mine] = await db.select({ active: family.active }).from(family).where(eq(family.id, familyId));
  if (!mine?.active) return null;

  const asked = (students ?? []).map((s) => s.qboId);
  const under = asked.length === 0 ? [] : await db.select({ qboId: qboCustomer.qboId }).from(qboCustomer)
    .where(and(eq(qboCustomer.parentQboId, ctx.familyQboId), eq(qboCustomer.active, true), inArray(qboCustomer.qboId, asked)));
  const links = under.length === 0 ? null : await linksOfCustomers({ families: [], students: under.map((c) => c.qboId) });
  const recordIds = links ? [...links.studentOfCustomer.values()] : [];
  const records = recordIds.length === 0 ? [] : await db.select({ id: student.id }).from(student)
    .where(and(inArray(student.id, recordIds), eq(student.familyId, familyId), eq(student.active, true)));
  const theirs = new Set(records.map((r) => String(r.id)));
  const roster: { id: AppStudentId; name: string }[] = [];
  for (const s of students ?? []) {
    const id = links?.studentOfCustomer.get(s.qboId);
    if (id === undefined || !theirs.has(String(id))) continue;
    roster.push({ id, name: s.name });
  }
  const familyRoster: FamilyRoster = { familyId, students: roster };
  // The waiver reasons that come back with the standing are for staff, and stop here.
  const { today, standing } = await loadFamilyStanding(current.id, familyRoster, { amounts: "fresh", parentId: ctx.parentId });
  return {
    name: current.name, today, currentIndex: standing.currentIndex, leftBefore: standing.leftBefore,
    steps: standing.steps,
  };
}
