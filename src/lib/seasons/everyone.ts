// Staff and worker only: the season's reads for every family at once (STAFF_ONLY_IMPORTS in
// tests/integration/page-guards.test.ts). Every chosen list's entries, every tick and waiver with its reason, and every
// record's link: never imported by parent code, whose reads (./recorded.ts, ./season-rows.ts, src/lib/families/links.ts)
// each take the families and students they are for.
import "server-only";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { accountingLink, requirementCover, requirementProgress } from "@/lib/db/schema";
import { QUICKBOOKS } from "@/lib/families/ids";
import { LINK_COLUMNS, linkMapsFrom, recordsCompany, type LinkMaps } from "@/lib/families/links";
import type { Recorded, Viewing } from "./kinds";
import type { Facts, Requirement, SubjectId } from "./progress";
import { factsFrom } from "./recorded";
import { RECORDED_COLUMNS, coversFrom, recordedFrom } from "./season-rows";

/** Every family and student record's link, in the records' company (src/lib/families/links.ts reads it the same way). */
export async function everyLink(tx?: Tx): Promise<LinkMaps> {
  const realmId = await recordsCompany(tx);
  if (realmId === null) return linkMapsFrom([]);
  return linkMapsFrom(await (tx ?? db).select(LINK_COLUMNS).from(accountingLink)
    .where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId), or(isNotNull(accountingLink.familyId), isNotNull(accountingLink.studentId)))));
}

/** The whole chosen list of each of these requirements, by requirement id. */
export async function everyCover(requirementIds: readonly string[], tx?: Tx): Promise<Map<string, SubjectId[]>> {
  if (requirementIds.length === 0) return new Map();
  return coversFrom(await (tx ?? db).select({ requirementId: requirementCover.requirementId, familyId: requirementCover.familyId, studentId: requirementCover.studentId })
    .from(requirementCover).where(inArray(requirementCover.requirementId, [...requirementIds])));
}

/** How these requirements stand for everyone they are asked of, with every tick and waiver (the reasons are staff's). */
export async function everyonesFacts(requirements: readonly Requirement[], viewing: Viewing): Promise<{ facts: Facts; recorded: Recorded[] }> {
  if (requirements.length === 0) return factsFrom(requirements, null, [], null, viewing);
  const [recorded, links] = await Promise.all([everyRecorded(requirements.map((r) => r.id)), everyLink()]);
  return factsFrom(requirements, null, recorded, links, viewing);
}

/** Every tick and waiver of these requirements, by the app's own ids, with the waivers' reasons (staff's). */
export async function everyRecorded(requirementIds: readonly string[], tx?: Tx): Promise<Recorded[]> {
  if (requirementIds.length === 0) return [];
  return recordedFrom(await (tx ?? db).select(RECORDED_COLUMNS).from(requirementProgress).where(inArray(requirementProgress.requirementId, [...requirementIds])));
}
