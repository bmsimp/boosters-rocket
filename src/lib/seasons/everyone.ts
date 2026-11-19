// Staff and worker only: the season's reads for every family at once (STAFF_ONLY_IMPORTS in
// tests/integration/page-guards.test.ts). Every chosen list's entries and every tick and waiver with its reason: never
// imported by parent code, whose reads (./recorded.ts, ./season-rows.ts) each take the families and students they are for.
import "server-only";
import { inArray } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { requirementCover, requirementProgress } from "@/lib/db/schema";
import type { Recorded, Viewing } from "./kinds";
import type { Facts, Requirement, SubjectId } from "./progress";
import { factsFrom } from "./recorded";
import { RECORDED_COLUMNS, coversFrom, recordedFrom } from "./season-rows";

/** The whole chosen list of each of these requirements, by requirement id. */
export async function everyCover(requirementIds: readonly string[], tx?: Tx): Promise<Map<string, SubjectId[]>> {
  if (requirementIds.length === 0) return new Map();
  return coversFrom(await (tx ?? db).select({ requirementId: requirementCover.requirementId, familyId: requirementCover.familyId, studentId: requirementCover.studentId })
    .from(requirementCover).where(inArray(requirementCover.requirementId, [...requirementIds])));
}

/** How these requirements stand for everyone they are asked of, with every tick and waiver (the reasons are staff's). */
export async function everyonesFacts(requirements: readonly Requirement[], viewing: Viewing): Promise<{ facts: Facts; recorded: Recorded[] }> {
  if (requirements.length === 0) return factsFrom(requirements, null, [], viewing);
  return factsFrom(requirements, null, await everyRecorded(requirements.map((r) => r.id)), viewing);
}

/** Every tick and waiver of these requirements, by the app's own ids, with the waivers' reasons (staff's). */
export async function everyRecorded(requirementIds: readonly string[], tx?: Tx): Promise<Recorded[]> {
  if (requirementIds.length === 0) return [];
  return recordedFrom(await (tx ?? db).select(RECORDED_COLUMNS).from(requirementProgress).where(inArray(requirementProgress.requirementId, [...requirementIds])));
}
