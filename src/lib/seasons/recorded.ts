// What is recorded against requirements, read once and judged by each kind's rule (./kinds.ts). Shared by the parent
// query (./my-season.ts) and the staff ones (./staff-progress.ts); it imports no staff-only module, and reads only the
// requirements and the families or students it is asked about. The season's records name the app's own families and
// students (stage 2 of the app-owned families spec), and so do volunteering and forms, whose rules are asked by the
// app's ids. The rules of the kinds still read by customer (payments, and the checklist with them) are asked through the
// links, and their answers turned back into the app's ids: a boundary AGENTS.md lists (Seasons), to go when those areas
// move. Every read here takes the families and students it is for; the same reads for everyone, for staff, are in
// ./everyone.ts (STAFF_ONLY_IMPORTS), built on factsFrom(). The chosen lists and ticks themselves are read in
// ./season-rows.ts.
import "server-only";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { requirement, seasonStep } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { linksOf, type LinkMaps } from "@/lib/families/links";
import { clubToday } from "@/lib/settings/club";
import type { CustomerRecorded, CustomerRequirement } from "./customer-keys";
import { KIND_RULES, NO_RULE_YET, pairKey, type Recorded, type Viewing } from "./kinds";
import {
  seasonStanding, subjectsOf, type AppliesTo, type Facts, type FamilyRoster, type Requirement, type RequirementFields, type SeasonStanding, type Standing, type Step,
  type SubjectId, type SubjectsAsked,
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

/** How the rules of the kinds asked by customer say these requirements stand: keyed by customerPairKey(). */
async function customerStandings(requirements: readonly CustomerRequirement[], subjectQboIds: readonly string[] | null, recorded: readonly CustomerRecorded[], viewing: Viewing): Promise<Map<string, Standing>> {
  const standings = new Map<string, Standing>();
  for (const kind of new Set(requirements.map((r) => r.kind))) {
    const rule = KIND_RULES[kind];
    if (!rule || rule.keyedBy === "app") continue;
    const ofKind = requirements.filter((r) => r.kind === kind), ids = new Set(ofKind.map((r) => r.id));
    for (const [key, standing] of await rule.standings({ requirements: ofKind, subjectQboIds, recorded: recorded.filter((r) => ids.has(r.requirementId)), viewing })) standings.set(key, standing);
  }
  return standings;
}

/** How the rules of the kinds asked by the app's own ids (volunteering, forms) say these requirements stand: keyed by pairKey(). */
async function appStandings(requirements: readonly Requirement[], asked: SubjectsAsked | null, recorded: readonly Recorded[], viewing: Viewing): Promise<Map<string, Standing>> {
  const standings = new Map<string, Standing>();
  for (const kind of new Set(requirements.map((r) => r.kind))) {
    const rule = KIND_RULES[kind];
    if (!rule || rule.keyedBy !== "app") continue;
    const ofKind = requirements.filter((r) => r.kind === kind), ids = new Set(ofKind.map((r) => r.id));
    for (const [key, standing] of await rule.standings({ requirements: ofKind, asked, recorded: recorded.filter((r) => ids.has(r.requirementId)), viewing })) standings.set(key, standing);
  }
  return standings;
}

const fieldsOf = (r: Requirement): RequirementFields => ({ id: r.id, kind: r.kind, title: r.title, required: r.required, appliesTo: r.appliesTo, amount: r.amount,
  amountUnit: r.amountUnit, dueOn: r.dueOn, covers: r.covers });

/** The customer one family or student record of a requirement's kind is linked to. A per-family requirement names families, a per-student one students. */
function customerOf(links: LinkMaps, appliesTo: AppliesTo, subject: SubjectId): string | undefined {
  return appliesTo === "family" ? links.customerOfFamily.get(subject as AppFamilyId) : links.customerOfStudent.get(subject as AppStudentId);
}
function recordOf(links: LinkMaps, appliesTo: AppliesTo, customerId: string): SubjectId | undefined {
  return appliesTo === "family" ? links.familyOfCustomer.get(customerId) : links.studentOfCustomer.get(customerId);
}
const askedByCustomer = (r: Requirement) => KIND_RULES[r.kind]?.keyedBy !== "app";

/**
 * How these requirements stand, judged from what is recorded for them (`recorded`) and the links of the records they
 * name (`links`), for these families and students (`asked`; null when `recorded` and `links` are everyone's, as
 * ./everyone.ts reads them for staff). Each kind's rule judges its own requirements, and a waiver is a waiver whatever
 * the kind. `viewing` is who is looking (./kinds.ts): a parent's pages say a payment's amount only from current
 * figures, staff only with Finance.Balance.Read.
 *
 * Volunteering and forms keep their records by the app's own ids, so their rules are asked with them. The other rules
 * read invoices and ticks, still asked by customer, so they are asked by customer: each family and student given, each chosen
 * list and each tick goes as the customer its record is linked to (in the records' company), and each answer comes back
 * to the record of the requirement's kind linked to that customer. A record with no link there is judged as having
 * nothing to show yet by those rules. Waivers are the season's own and read as they are.
 */
export async function factsFrom(requirements: readonly Requirement[], asked: SubjectsAsked | null, recorded: Recorded[], links: LinkMaps | null, viewing: Viewing): Promise<{ facts: Facts; recorded: Recorded[] }> {
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const standings = new Map<string, Standing>();
  const byCustomer = requirements.filter(askedByCustomer), byRecord = requirements.filter((r) => !askedByCustomer(r));
  if (links && byCustomer.length > 0) {
    const asCustomer = byCustomer.map((r): CustomerRequirement => ({ ...fieldsOf(r), coveredQboIds: r.coveredIds.flatMap((id) => customerOf(links, r.appliesTo, id) ?? []) }));
    const subjectQboIds = asked === null ? null : [...asked.families.flatMap((f) => links.customerOfFamily.get(f) ?? []), ...asked.students.flatMap((s) => links.customerOfStudent.get(s) ?? [])];
    const ticks = recorded.flatMap(({ subjectId, ...rec }): CustomerRecorded[] => {
      const r = byId.get(rec.requirementId), subjectQboId = r && askedByCustomer(r) && customerOf(links, r.appliesTo, subjectId);
      return subjectQboId ? [{ ...rec, subjectQboId }] : [];
    });
    for (const [key, standing] of await customerStandings(asCustomer, subjectQboIds, ticks, viewing)) {
      const at = key.indexOf("|"), r = byId.get(key.slice(0, at)), subject = r && recordOf(links, r.appliesTo, key.slice(at + 1));
      if (r && subject) standings.set(pairKey(r.id, subject), standing);
    }
  }
  if (byRecord.length > 0 && (asked === null || !asksNobody(asked))) {
    for (const [key, standing] of await appStandings(byRecord, asked, recorded, viewing)) standings.set(key, standing);
  }
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
  if (requirements.length === 0 || asksNobody(asked)) return factsFrom(requirements, asked, [], null, viewing);
  const [recorded, links] = await Promise.all([loadRecorded(requirements.map((r) => r.id), asked), linksOf(asked)]);
  return factsFrom(requirements, asked, recorded, links, viewing);
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
