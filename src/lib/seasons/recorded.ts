// What is recorded against requirements, read once and judged by each kind's rule (./kinds.ts). Shared by the parent
// query (./my-season.ts) and the staff ones (./staff-progress.ts); it imports no staff-only module, and reads only the
// requirements and the families or students it is asked about. The season's records name the app's own families and
// students (stage 2 of the app-owned families spec); the kind rules still read areas keyed by QuickBooks ids, so
// loadFacts() asks them by customer, through the links, and turns their answers back into the app's ids. That
// translation, and loadCustomerFacts() for the areas that read a season by customer, are boundaries AGENTS.md lists
// (Seasons), to go when those areas move. Every read here takes the families and students it is for; the same reads
// for everyone, for staff, are in ./everyone.ts (STAFF_ONLY_IMPORTS), built on factsFrom() and customerFactsFrom().
import "server-only";
import { and, asc, eq, inArray, or, type AnyColumn, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { requirement, requirementCover, requirementProgress, seasonStep } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { linksOf, type LinkMaps } from "@/lib/families/links";
import { clubToday } from "@/lib/settings/club";
import { loadCustomerRecorded } from "./by-customer";
import { customerPairKey, type CustomerRecorded, type CustomerRequirement } from "./customer-keys";
import { KIND_RULES, NO_RULE_YET, pairKey, type Recorded, type Viewing } from "./kinds";
import {
  seasonStanding, subjectsOf, type AppliesTo, type Facts, type FamilyRoster, type Requirement, type RequirementFields, type SeasonStanding, type Standing, type Step,
  type SubjectId,
} from "./progress";

export type RequirementRow = typeof requirement.$inferSelect;

/** The families and students a read is for: a parent's own family and its students (everyone, for staff, is ./everyone.ts). */
export type SubjectsAsked = { families: readonly AppFamilyId[]; students: readonly AppStudentId[] };

/** A requirement as the rules read it. `coveredIds` is whatever part of its list the caller was allowed to load. */
export function toRequirement(row: RequirementRow, coveredIds: readonly SubjectId[]): Requirement {
  return { id: row.id, kind: row.kind, title: row.title, required: row.required, appliesTo: row.appliesTo, amount: row.amount, amountUnit: row.amountUnit,
    dueOn: row.dueOn, covers: row.covers, coveredIds };
}

/** A season row's family or student: the database holds exactly one of the two (requirement_cover_one_subject, requirement_progress_one_subject). */
export const subjectOf = (row: { familyId: AppFamilyId | null; studentId: AppStudentId | null }): SubjectId => (row.familyId ?? row.studentId)!;

/** Only the rows of these families and students. */
const rowsOf = (t: { familyId: AnyColumn; studentId: AnyColumn }, asked: SubjectsAsked): SQL | undefined => or(
  ...(asked.families.length ? [inArray(t.familyId, [...asked.families])] : []),
  ...(asked.students.length ? [inArray(t.studentId, [...asked.students])] : []));
const asksNobody = (asked: SubjectsAsked) => asked.families.length === 0 && asked.students.length === 0;

/** A chosen list's rows as ids by requirement. */
export function coversFrom(rows: readonly { requirementId: string; familyId: AppFamilyId | null; studentId: AppStudentId | null }[]): Map<string, SubjectId[]> {
  const covers = new Map<string, SubjectId[]>();
  for (const r of rows) covers.set(r.requirementId, [...(covers.get(r.requirementId) ?? []), subjectOf(r)]);
  return covers;
}
/** The columns of requirement_progress the rules read, with the row's family or student. */
export const RECORDED_COLUMNS = {
  requirementId: requirementProgress.requirementId, familyId: requirementProgress.familyId, studentId: requirementProgress.studentId, metAt: requirementProgress.metAt,
  metBy: requirementProgress.metBy, waivedAt: requirementProgress.waivedAt, waivedBy: requirementProgress.waivedBy, waivedReason: requirementProgress.waivedReason,
};
/** Rows read with RECORDED_COLUMNS, each with its family or student as one id. */
export const recordedFrom = (rows: readonly ({ familyId: AppFamilyId | null; studentId: AppStudentId | null } & Omit<Recorded, "subjectId">)[]): Recorded[] =>
  rows.map(({ familyId, studentId, ...r }) => ({ ...r, subjectId: subjectOf({ familyId, studentId }) }));

/**
 * The chosen lists of these requirements, by requirement id: only the entries that name one of these families or
 * students. A parent's query passes its own family and students, and so never loads who else is on a list.
 */
export async function loadCovers(requirementIds: readonly string[], asked: SubjectsAsked, tx?: Tx): Promise<Map<string, SubjectId[]>> {
  if (requirementIds.length === 0 || asksNobody(asked)) return new Map();
  return coversFrom(await (tx ?? db).select({ requirementId: requirementCover.requirementId, familyId: requirementCover.familyId, studentId: requirementCover.studentId })
    .from(requirementCover).where(and(inArray(requirementCover.requirementId, [...requirementIds]), rowsOf(requirementCover, asked))));
}

/** What requirement_progress holds for these requirements and only these families or students. */
export async function loadRecorded(requirementIds: readonly string[], asked: SubjectsAsked, tx?: Tx): Promise<Recorded[]> {
  if (requirementIds.length === 0 || asksNobody(asked)) return [];
  return recordedFrom(await (tx ?? db).select(RECORDED_COLUMNS).from(requirementProgress)
    .where(and(inArray(requirementProgress.requirementId, [...requirementIds]), rowsOf(requirementProgress, asked))));
}

/** How each kind's rule says these requirements stand, by customer: keyed by customerPairKey(). */
async function customerStandings(requirements: readonly CustomerRequirement[], subjectQboIds: readonly string[] | null, recorded: readonly CustomerRecorded[], viewing: Viewing): Promise<Map<string, Standing>> {
  const standings = new Map<string, Standing>();
  for (const kind of new Set(requirements.map((r) => r.kind))) {
    const rule = KIND_RULES[kind];
    if (!rule) continue;
    const ofKind = requirements.filter((r) => r.kind === kind), ids = new Set(ofKind.map((r) => r.id));
    for (const [key, standing] of await rule.standings({ requirements: ofKind, subjectQboIds, recorded: recorded.filter((r) => ids.has(r.requirementId)), viewing })) standings.set(key, standing);
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

/**
 * How these requirements stand, judged from what is recorded for them (`recorded`) and the links of the records they
 * name (`links`), for these families and students (`asked`; null when `recorded` and `links` are everyone's, as
 * ./everyone.ts reads them for staff). Each kind's rule judges its own requirements, and a waiver is a waiver whatever
 * the kind. `viewing` is who is looking (./kinds.ts): a
 * parent's pages say a payment's amount only from current figures, staff only with Finance.Balance.Read.
 *
 * The rules read invoices, signatures and volunteer credit, still kept by customer, so they are asked by customer: each
 * family and student given, each chosen list and each tick goes as the customer its record is linked to (in the
 * records' company), and each answer comes back to the record of the requirement's kind linked to that customer. A
 * record with no link there is judged as having nothing to show yet. Waivers are the season's own and read as they are.
 */
export async function factsFrom(requirements: readonly Requirement[], asked: SubjectsAsked | null, recorded: Recorded[], links: LinkMaps | null, viewing: Viewing): Promise<{ facts: Facts; recorded: Recorded[] }> {
  const byId = new Map(requirements.map((r) => [r.id, r]));
  const standings = new Map<string, Standing>();
  if (links && requirements.length > 0) {
    const asCustomer = requirements.map((r): CustomerRequirement => ({ ...fieldsOf(r), coveredQboIds: r.coveredIds.flatMap((id) => customerOf(links, r.appliesTo, id) ?? []) }));
    const subjectQboIds = asked === null ? null : [...asked.families.flatMap((f) => links.customerOfFamily.get(f) ?? []), ...asked.students.flatMap((s) => links.customerOfStudent.get(s) ?? [])];
    const ticks = recorded.flatMap(({ subjectId, ...rec }): CustomerRecorded[] => {
      const r = byId.get(rec.requirementId), subjectQboId = r && customerOf(links, r.appliesTo, subjectId);
      return subjectQboId ? [{ ...rec, subjectQboId }] : [];
    });
    for (const [key, standing] of await customerStandings(asCustomer, subjectQboIds, ticks, viewing)) {
      const at = key.indexOf("|"), r = byId.get(key.slice(0, at)), subject = r && recordOf(links, r.appliesTo, key.slice(at + 1));
      if (r && subject) standings.set(pairKey(r.id, subject), standing);
    }
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

/** What is recorded, as the areas still keyed by QuickBooks ids ask for it: by customer. */
export type CustomerFacts = {
  standing(requirement: CustomerRequirement, subjectQboId: string): Standing;
  waived(requirementId: string, subjectQboId: string): boolean;
};

/**
 * loadFacts() for the areas still keyed by QuickBooks ids (a boundary AGENTS.md lists, Seasons): these requirements,
 * with their chosen lists by customer, for the families and students linked to these customers, judged by the same
 * rules. The ticks and waivers come by customer through ./by-customer.ts; for everyone, for staff, ./everyone.ts.
 */
export async function loadCustomerFacts(requirements: readonly CustomerRequirement[], subjectQboIds: readonly string[], viewing: Viewing): Promise<{ facts: CustomerFacts; recorded: CustomerRecorded[] }> {
  return customerFactsFrom(requirements, subjectQboIds, await loadCustomerRecorded(requirements.map((r) => r.id), subjectQboIds), viewing);
}

/** loadCustomerFacts() judged from what is recorded (`recorded`), for these customers or (null) everyone. */
export async function customerFactsFrom(requirements: readonly CustomerRequirement[], subjectQboIds: readonly string[] | null, recorded: CustomerRecorded[], viewing: Viewing): Promise<{ facts: CustomerFacts; recorded: CustomerRecorded[] }> {
  const standings = await customerStandings(requirements, subjectQboIds, recorded, viewing);
  const waived = new Set(recorded.filter((r) => r.waivedAt !== null).map((r) => customerPairKey(r.requirementId, r.subjectQboId)));
  return {
    recorded,
    facts: {
      standing: (r, subject) => standings.get(customerPairKey(r.id, subject)) ?? KIND_RULES[r.kind]?.nothingYet(r) ?? NO_RULE_YET,
      waived: (id, subject) => waived.has(customerPairKey(id, subject)),
    },
  };
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
