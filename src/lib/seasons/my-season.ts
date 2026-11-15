// Privacy: the one query a parent page reads its season through. The family is the session's (ctx.familyQboId) and
// nothing else: progress and chosen lists are read only for that family and the students under it, and a requirement
// that covers none of them is dropped here, title and all. It never imports the staff-only modules (./setup.ts,
// ./subjects.ts, ./staff-progress.ts, src/lib/roster/queries.ts): tests/integration/page-guards.test.ts scans this file.
import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { qboCustomer, requirement, season, seasonStep } from "@/lib/db/schema";
import type { ParentCtx } from "@/lib/guards";
import type { MyStudent } from "@/lib/parents/my-family";
import { clubToday } from "@/lib/settings/club";
import { loadCovers, loadFacts, toRequirement } from "./recorded";
import { seasonStanding, subjectsOf, type FamilyRoster, type SeasonStanding, type Step } from "./progress";

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
export async function loadMySeason(ctx: Pick<ParentCtx, "familyQboId">, students: readonly MyStudent[] | null): Promise<MySeason | null> {
  const familyQboId = ctx.familyQboId;
  const [current] = await db.select({ id: season.id, name: season.name }).from(season).where(eq(season.isCurrent, true));
  if (!current) return null;

  const asked = (students ?? []).map((s) => s.qboId);
  const [steps, under, today] = await Promise.all([
    db.select().from(seasonStep).where(eq(seasonStep.seasonId, current.id)).orderBy(asc(seasonStep.position), asc(seasonStep.createdAt)),
    asked.length === 0 ? [] : db.select({ qboId: qboCustomer.qboId }).from(qboCustomer)
      .where(and(eq(qboCustomer.parentQboId, familyQboId), eq(qboCustomer.active, true), inArray(qboCustomer.qboId, asked))),
    clubToday(),
  ]);
  const mine = new Set(under.map((c) => c.qboId));
  const family: FamilyRoster = { familyQboId, students: (students ?? []).filter((s) => mine.has(s.qboId)).map((s) => ({ qboId: s.qboId, name: s.name })) };
  const subjects = [familyQboId, ...family.students.map((s) => s.qboId)];

  const rows = steps.length === 0 ? [] : await db.select().from(requirement).where(inArray(requirement.stepId, steps.map((s) => s.id)))
    .orderBy(asc(requirement.position), asc(requirement.createdAt));
  // Only this family's own entries of each chosen list are read.
  const covers = await loadCovers(rows.filter((r) => r.covers === "chosen").map((r) => r.id), subjects);
  // A requirement that is asked of nobody in this family goes no further than this line.
  const asksUs = rows.map((r) => ({ stepId: r.stepId, requirement: toRequirement(r, covers.get(r.id) ?? []) })).filter((r) => subjectsOf(r.requirement, family).length > 0);
  const { facts } = await loadFacts(asksUs.map((r) => r.requirement), subjects);

  const ordered: Step[] = steps.map((s) => ({ id: s.id, name: s.name, startsOn: s.startsOn, endsOn: s.endsOn,
    requirements: asksUs.filter((r) => r.stepId === s.id).map((r) => r.requirement) }));
  return { name: current.name, today, ...seasonStanding(ordered, family, facts, today) };
}
