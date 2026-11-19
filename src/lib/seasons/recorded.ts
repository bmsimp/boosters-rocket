// What is recorded against requirements, read once and judged by each kind's rule (./kinds.ts). Shared by the parent
// query (./my-season.ts) and the staff ones (./staff-progress.ts); it imports no staff-only module, and reads only the
// requirements and the families or students it is asked about. The season's records name the app's own families and
// students (stage 2 of the app-owned families spec), and every kind's rule is asked by those ids (the payment rule turns
// them into customers itself: its figures are kept by the app's family, but whose invoices are whose is still the roster
// cache's tree of customers, src/lib/money/payment-standings.ts). Every read
// here takes the families and students it is for; the same reads for everyone, for staff, are in
// ./everyone.ts (STAFF_ONLY_IMPORTS), built on factsFrom(). The chosen lists and ticks themselves are read in
// ./season-rows.ts.
import "server-only";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { requirement, seasonStep } from "@/lib/db/schema";
import { clubToday } from "@/lib/settings/club";
import { KIND_RULES, NO_RULE_YET, pairKey, type Recorded, type Viewing } from "./kinds";
import {
  seasonStanding, subjectsOf, type Facts, type FamilyRoster, type Requirement, type SeasonStanding, type Standing, type Step, type SubjectId, type SubjectsAsked,
} from "./progress";
import { asksNobody, loadCovers, loadRecorded } from "./season-rows";

export { RECORDED_COLUMNS, coversFrom, loadCovers, loadRecorded, recordedFrom, subjectOf } from "./season-rows";
export type { SubjectsAsked } from "./progress";

export type RequirementRow = typeof requirement.$inferSelect;

/** A requirement as the rules read it. `coveredIds` is whatever part of its list the caller was allowed to load. */
export function toRequirement(row: RequirementRow, coveredIds: readonly SubjectId[]): Requirement {
  return { id: row.id, kind: row.kind, title: row.title, required: row.required, appliesTo: row.appliesTo, amount: row.amount, amountUnit: row.amountUnit,
    dueOn: row.dueOn, covers: row.covers, coveredIds };
}

/** How each kind's rule says these requirements stand: keyed by pairKey(). */
async function ruleStandings(requirements: readonly Requirement[], asked: SubjectsAsked | null, recorded: readonly Recorded[], viewing: Viewing): Promise<Map<string, Standing>> {
  const standings = new Map<string, Standing>();
  for (const kind of new Set(requirements.map((r) => r.kind))) {
    const rule = KIND_RULES[kind];
    if (!rule) continue;
    const ofKind = requirements.filter((r) => r.kind === kind), ids = new Set(ofKind.map((r) => r.id));
    for (const [key, standing] of await rule.standings({ requirements: ofKind, asked, recorded: recorded.filter((r) => ids.has(r.requirementId)), viewing })) standings.set(key, standing);
  }
  return standings;
}

/**
 * How these requirements stand, judged from what is recorded for them (`recorded`), for these families and students
 * (`asked`; null when `recorded` is everyone's, as ./everyone.ts reads it for staff). Each kind's rule judges its own
 * requirements, asked by the app's own ids, and a waiver is a waiver whatever the kind. `viewing` is who is looking
 * (./kinds.ts): a parent's pages say a payment's amount only from current figures, staff only with Finance.Balance.Read.
 */
export async function factsFrom(requirements: readonly Requirement[], asked: SubjectsAsked | null, recorded: Recorded[], viewing: Viewing): Promise<{ facts: Facts; recorded: Recorded[] }> {
  const standings = requirements.length > 0 && (asked === null || !asksNobody(asked)) ? await ruleStandings(requirements, asked, recorded, viewing) : new Map<string, Standing>();
  const waived = new Set(recorded.filter((r) => r.waivedAt !== null).map((r) => pairKey(r.requirementId, r.subjectId)));
  return {
    recorded,
    facts: {
      standing: (r, subject) => standings.get(pairKey(r.id, subject)) ?? KIND_RULES[r.kind]?.nothingYet(r) ?? NO_RULE_YET,
      waived: (id, subject) => waived.has(pairKey(id, subject)),
    },
  };
}

/** How these requirements stand for these families and students (factsFrom(), from what is recorded for them alone). */
export async function loadFacts(requirements: readonly Requirement[], asked: SubjectsAsked, viewing: Viewing): Promise<{ facts: Facts; recorded: Recorded[] }> {
  if (requirements.length === 0 || asksNobody(asked)) return factsFrom(requirements, asked, [], viewing);
  return factsFrom(requirements, asked, await loadRecorded(requirements.map((r) => r.id), asked), viewing);
}

/**
 * One season as it stands for one family on the club's own day: the one reading both a parent's pages and a staff
 * page about one family are built from. Only that family's entries of each chosen list, and only what is recorded for
 * the family and the students given, are read; a requirement asked of none of them is dropped here, title and all.
 * The caller answers for `family`: a parent's query builds it from the session, a staff one from the roster.
 * `recorded` holds the waiver reasons, which are for staff: a parent's query does not pass it on.
 */
export async function loadFamilyStanding(seasonId: string, family: FamilyRoster, viewing: Viewing): Promise<{ today: string; standing: SeasonStanding; recorded: Recorded[] }> {
  const asked: SubjectsAsked = { families: [family.familyId], students: family.students.map((s) => s.id) };
  const [steps, today] = await Promise.all([
    db.select().from(seasonStep).where(eq(seasonStep.seasonId, seasonId)).orderBy(asc(seasonStep.position), asc(seasonStep.createdAt)),
    clubToday(),
  ]);
  const rows = steps.length === 0 ? [] : await db.select().from(requirement).where(inArray(requirement.stepId, steps.map((s) => s.id)))
    .orderBy(asc(requirement.position), asc(requirement.createdAt));
  // Only this family's own entries of each chosen list are read.
  const covers = await loadCovers(rows.filter((r) => r.covers === "chosen").map((r) => r.id), asked);
  // A requirement that is asked of nobody in this family goes no further than this line.
  const asksThem = rows.map((r) => ({ stepId: r.stepId, requirement: toRequirement(r, covers.get(r.id) ?? []) })).filter((r) => subjectsOf(r.requirement, family).length > 0);
  const { facts, recorded } = await loadFacts(asksThem.map((r) => r.requirement), asked, viewing);
  const ordered: Step[] = steps.map((s) => ({ id: s.id, name: s.name, startsOn: s.startsOn, endsOn: s.endsOn,
    requirements: asksThem.filter((r) => r.stepId === s.id).map((r) => r.requirement) }));
  return { today, standing: seasonStanding(ordered, family, facts, today), recorded };
}
