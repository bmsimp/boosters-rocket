// What is recorded against requirements, read once and judged by each kind's rule (./kinds.ts). Shared by the parent
// query (./my-season.ts) and the staff ones (./staff-progress.ts); it imports no staff-only module, and reads only the
// requirements and the families or students it is asked about.
import "server-only";
import { and, inArray } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { requirement, requirementCover, requirementProgress } from "@/lib/db/schema";
import { KIND_RULES, NO_RULE_YET, pairKey, type Recorded } from "./kinds";
import type { Facts, Requirement, Standing } from "./progress";

export type RequirementRow = typeof requirement.$inferSelect;

/** A requirement as the rules read it. `coveredQboIds` is whatever part of its list the caller was allowed to load. */
export function toRequirement(row: RequirementRow, coveredQboIds: readonly string[]): Requirement {
  return { id: row.id, kind: row.kind, title: row.title, required: row.required, appliesTo: row.appliesTo, amount: row.amount, amountUnit: row.amountUnit,
    dueOn: row.dueOn, covers: row.covers, coveredQboIds };
}

/**
 * The chosen lists of these requirements, by requirement id. With `subjectQboIds`, only the entries that name one of
 * them are read: a parent's query passes its own family and students, and so never loads who else is on a list.
 */
export async function loadCovers(requirementIds: readonly string[], subjectQboIds: readonly string[] | null, tx?: Tx): Promise<Map<string, string[]>> {
  const covers = new Map<string, string[]>();
  if (requirementIds.length === 0 || subjectQboIds?.length === 0) return covers;
  const rows = await (tx ?? db).select({ requirementId: requirementCover.requirementId, subjectQboId: requirementCover.subjectQboId }).from(requirementCover)
    .where(and(inArray(requirementCover.requirementId, [...requirementIds]), subjectQboIds ? inArray(requirementCover.subjectQboId, [...subjectQboIds]) : undefined));
  for (const r of rows) covers.set(r.requirementId, [...(covers.get(r.requirementId) ?? []), r.subjectQboId]);
  return covers;
}

/** What requirement_progress holds for these requirements and, when given, only these families or students. */
export async function loadRecorded(requirementIds: readonly string[], subjectQboIds: readonly string[] | null, tx?: Tx): Promise<Recorded[]> {
  if (requirementIds.length === 0 || subjectQboIds?.length === 0) return [];
  return (tx ?? db).select({
    requirementId: requirementProgress.requirementId, subjectQboId: requirementProgress.subjectQboId, metAt: requirementProgress.metAt, metBy: requirementProgress.metBy,
    waivedAt: requirementProgress.waivedAt, waivedBy: requirementProgress.waivedBy, waivedReason: requirementProgress.waivedReason,
  }).from(requirementProgress)
    .where(and(inArray(requirementProgress.requirementId, [...requirementIds]), subjectQboIds ? inArray(requirementProgress.subjectQboId, [...subjectQboIds]) : undefined));
}

/**
 * How these requirements stand, for these families and students (null: everyone, for staff): each kind's rule judges
 * its own requirements, and a waiver is a waiver whatever the kind.
 */
export async function loadFacts(requirements: readonly Requirement[], subjectQboIds: readonly string[] | null): Promise<{ facts: Facts; recorded: Recorded[] }> {
  const recorded = await loadRecorded(requirements.map((r) => r.id), subjectQboIds);
  const standings = new Map<string, Standing>();
  for (const kind of new Set(requirements.map((r) => r.kind))) {
    const rule = KIND_RULES[kind];
    if (!rule) continue;
    const ofKind = requirements.filter((r) => r.kind === kind), ids = new Set(ofKind.map((r) => r.id));
    for (const [key, standing] of await rule.standings({ requirements: ofKind, subjectQboIds, recorded: recorded.filter((r) => ids.has(r.requirementId)) })) standings.set(key, standing);
  }
  const waived = new Set(recorded.filter((r) => r.waivedAt !== null).map((r) => pairKey(r.requirementId, r.subjectQboId)));
  return {
    recorded,
    facts: {
      standing: (r, subject) => standings.get(pairKey(r.id, subject)) ?? KIND_RULES[r.kind]?.nothingYet(r) ?? NO_RULE_YET,
      waived: (id, subject) => waived.has(pairKey(id, subject)),
    },
  };
}
