// Privacy: the one query a parent page reads its season through. The family is the session's (ctx.familyId, the app's
// own family record the gate found) and nothing else, and only while that record is active; its students are the
// app's own active students of that family (sessionFamily(), src/lib/families/session-family.ts). Progress and chosen
// lists are then read only for that family and those students, and a requirement that covers none of them is dropped,
// title and all (loadFamilyStanding in ./recorded.ts). No link to the accounting system is needed. It never imports the
// staff-only modules (./setup.ts, ./subjects.ts, ./staff-progress.ts, src/lib/roster/queries.ts,
// src/lib/families/in-step.ts): tests/integration/page-guards.test.ts scans this file.
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { season } from "@/lib/db/schema";
import type { ParentCtx } from "@/lib/guards";
import { sessionFamily } from "@/lib/families/session-family";
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
 * (the page then shows no ruler and nothing in its place), or when the session's family record is not active. Its
 * students are the family's own active student records, read here from the session's family alone.
 */
export async function loadMySeason(ctx: Pick<ParentCtx, "familyId" | "parentId">): Promise<MySeason | null> {
  const [current] = await db.select({ id: season.id, name: season.name }).from(season).where(eq(season.isCurrent, true));
  if (!current) return null;
  const mine = await sessionFamily(ctx.familyId);
  if (mine === null) return null;
  const familyRoster: FamilyRoster = { familyId: mine.familyId, students: mine.students };
  // The waiver reasons that come back with the standing are for staff, and stop here.
  const { today, standing } = await loadFamilyStanding(current.id, familyRoster, { amounts: "fresh", parentId: ctx.parentId });
  return {
    name: current.name, today, currentIndex: standing.currentIndex, leftBefore: standing.leftBefore,
    steps: standing.steps,
  };
}
