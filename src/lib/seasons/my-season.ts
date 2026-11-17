// Privacy: the one query a parent page reads its season through. The family is the session's (ctx.familyQboId) and
// nothing else: progress and chosen lists are read only for that family and the students under it, and a requirement
// that covers none of them is dropped, title and all (loadFamilyStanding in ./recorded.ts). It never imports the
// staff-only modules (./setup.ts, ./subjects.ts, ./staff-progress.ts, src/lib/roster/queries.ts):
// tests/integration/page-guards.test.ts scans this file.
import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { qboCustomer, season } from "@/lib/db/schema";
import type { ParentCtx } from "@/lib/guards";
import type { MyStudent } from "@/lib/parents/my-family";
import { loadFamilyStanding } from "./recorded";
import type { FamilyRoster, SeasonStanding } from "./progress";

export type MySeason = SeasonStanding & {
  /** The current season's name, in the club's words. */
  name: string;
  /** The club's date the standing was worked out for (YYYY-MM-DD). */
  today: string;
};

/**
 * The club's current season as it stands for the signed-in parent's family, or null when there is no current season
 * (the page then shows no ruler and nothing in its place).
 *
 * `students` is what loadMyFamily(ctx) returned for the same session: the family's active students, or null when the
 * club doesn't list students. It is not trusted to belong to the family: only those the roster cache holds directly
 * under ctx.familyQboId are used, so nothing a caller passes can bring in another family's student.
 */
export async function loadMySeason(ctx: Pick<ParentCtx, "familyQboId" | "parentId">, students: readonly MyStudent[] | null): Promise<MySeason | null> {
  const familyQboId = ctx.familyQboId;
  const [current] = await db.select({ id: season.id, name: season.name }).from(season).where(eq(season.isCurrent, true));
  if (!current) return null;

  const asked = (students ?? []).map((s) => s.qboId);
  const under = asked.length === 0 ? [] : await db.select({ qboId: qboCustomer.qboId }).from(qboCustomer)
    .where(and(eq(qboCustomer.parentQboId, familyQboId), eq(qboCustomer.active, true), inArray(qboCustomer.qboId, asked)));
  const mine = new Set(under.map((c) => c.qboId));
  const family: FamilyRoster = { familyQboId, students: (students ?? []).filter((s) => mine.has(s.qboId)).map((s) => ({ qboId: s.qboId, name: s.name })) };
  // The waiver reasons that come back with the standing are for staff, and stop here.
  const { today, standing } = await loadFamilyStanding(current.id, family, { amounts: "fresh", parentId: ctx.parentId });
  return { name: current.name, today, ...standing };
}
