// Staff only: who has met each requirement, across every family, and the ticks and waivers staff record (v1 spec
// §10.2). Every write is one transaction with its audit rows. Never imported by parent code
// (tests/integration/page-guards.test.ts). Families and students are the app's own records (stage 2 of the app-owned
// families spec): the pages send their ids, and an id is acted on only once it is found on the roster, or among the
// rows already recorded against the requirement.
import "server-only";
import { asc, eq, inArray } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { family, requirement, requirementProgress, season, seasonStep, staffUser, student } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { KIND_RULES, pairKey } from "./kinds";
import { lineFor, type LineState, type Requirement, type SeasonStanding, type SubjectId } from "./progress";
import { loadFamilyStanding, toRequirement } from "./recorded";
import { everyCover, everyonesFacts } from "./everyone";
import { getRequirementSetup, type Refused, type RequirementSetup, type SeasonOp } from "./setup";
import { coveredBy, loadSeasonFamilies, seasonFamilyAt, type SeasonFamily, type SeasonSubject } from "./subjects";
import { currentRosterTag, lockRosterAs, ROSTER_MOVED } from "./roster-lock";

type Done<T = object> = ({ ok: true } & T) | Refused;
const refuse = (...errors: string[]): Refused => ({ ok: false, errors });
export const REASON_MAX = 500, BULK_MAX = 5000;
const GONE = "That isn't there any more. Reload the page.";
const NO_ROSTER = "The roster can't be shown right now, so nothing was changed. Check QuickBooks under Roster.";
const NOT_COVERED = "Someone in that list isn't covered by this requirement any more. Reload the page and try again.";

export type ProgressRow = SeasonSubject & {
  state: LineState; words: string;
  /** A checklist tick: when, and who ticked it. */
  metAt: string | null; metBy: string | null;
  waivedAt: string | null; waivedBy: string | null; waivedReason: string | null;
};
/**
 * A tick or waiver recorded for someone the roster no longer lists under this requirement: kept, and shown apart.
 * `name` is the record's, null when the portal never knew one (recordNameWords() says so).
 */
export type LeftRow = { subjectId: SubjectId; kind: "family" | "student"; name: string | null; metAt: string | null; waivedAt: string | null; waivedReason: string | null };
export type RequirementProgress = RequirementSetup & {
  /** True for a kind staff meet by hand (a checklist item). */
  ticked: boolean;
  /** Everyone the requirement is asked of now, by family and then by name; null when the roster can't be shown. */
  rows: ProgressRow[] | null;
  left: LeftRow[];
  counts: { asked: number; done: number; waived: number; todo: number };
  /** The company the roster was read from, for the page's ticks and waivers to carry (roster-lock.ts). */
  rosterTag: string;
};

const iso = (d: Date | null) => d?.toISOString() ?? null;
const countsOf = (rows: readonly { state: LineState }[]) => ({
  asked: rows.length, done: rows.filter((r) => r.state === "done").length, waived: rows.filter((r) => r.state === "waived").length, todo: rows.filter((r) => r.state === "todo").length,
});

async function staffNames(ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (!wanted.length) return new Map();
  return new Map((await db.select({ id: staffUser.id, name: staffUser.name }).from(staffUser).where(inArray(staffUser.id, wanted))).map((s) => [s.id, s.name]));
}

/** The names the app's own records have, of a requirement's kind: a per-family one names families, a per-student one students. */
async function recordNames(kind: "family" | "student", ids: readonly SubjectId[]): Promise<Map<string, string | null>> {
  if (ids.length === 0) return new Map();
  // A requirement's rows hold the kind it applies to (./recorded.ts), so these ids are of that kind.
  const rows = kind === "family"
    ? await db.select({ id: family.id, name: family.name }).from(family).where(inArray(family.id, ids as AppFamilyId[]))
    : await db.select({ id: student.id, name: student.name }).from(student).where(inArray(student.id, ids as AppStudentId[]));
  return new Map(rows.map((r) => [String(r.id), r.name]));
}

/**
 * One requirement and how it stands for everyone it is asked of; null when there is no such requirement. `amounts`
 * is "all" for staff who may read what families owe (Finance.Balance.Read), else "none": a payment then reads "Not
 * paid yet" with no amount.
 */
export async function loadRequirementProgress(requirementId: string, amounts: "all" | "none"): Promise<RequirementProgress | null> {
  const setup = await getRequirementSetup(requirementId);
  if (!setup) return null;
  // Read before the roster: a roster read from another company in between makes the tag the older one, and a write is refused.
  const rosterTag = await currentRosterTag();
  const [families, { facts, recorded }] = await Promise.all([loadSeasonFamilies(), everyonesFacts([setup.requirement], { amounts, parentId: null })]);
  const who = await staffNames(recorded.flatMap((r) => [r.metBy, r.waivedBy]));
  const by = new Map(recorded.map((r) => [String(r.subjectId), r]));
  const covered = families ? coveredBy(setup.requirement, families) : null;
  const rows = covered?.map((s): ProgressRow => {
    const line = lineFor(setup.requirement, s.id, facts), r = by.get(String(s.id));
    return { ...s, state: line.state, words: line.words, metAt: iso(r?.metAt ?? null), metBy: r?.metBy ? who.get(r.metBy) ?? null : null,
      waivedAt: iso(r?.waivedAt ?? null), waivedBy: r?.waivedBy ? who.get(r.waivedBy) ?? null : null, waivedReason: r?.waivedReason ?? null };
  }) ?? null;
  // Recorded for someone not asked now: they left the roster, or a chosen list no longer names them.
  const shown = new Set((covered ?? []).map((s) => String(s.id)));
  const gone = covered ? recorded.filter((r) => !shown.has(String(r.subjectId))) : [];
  const kind = setup.requirement.appliesTo;
  const names = await recordNames(kind, gone.map((r) => r.subjectId));
  const left = gone.map((r): LeftRow => ({ subjectId: r.subjectId, kind, name: names.get(String(r.subjectId)) ?? null, metAt: iso(r.metAt), waivedAt: iso(r.waivedAt), waivedReason: r.waivedReason }));
  return { ...setup, ticked: KIND_RULES[setup.requirement.kind]?.ticked ?? false, rows, left, counts: countsOf(rows ?? []), rosterTag };
}

export type OverviewRequirement = { id: string; title: string; required: boolean; appliesTo: Requirement["appliesTo"]; counts: RequirementProgress["counts"] };
export type ProgressOverview = {
  season: { id: string; name: string; isCurrent: boolean };
  /** False when the roster can't be shown: the counts are then all zero and mean nothing. */
  roster: boolean;
  steps: { id: string; name: string; requirements: OverviewRequirement[] }[];
};

/** One season's requirements, each with how many of those it is asked of are done; null when there is no such season. */
export async function loadProgressOverview(seasonId: string): Promise<ProgressOverview | null> {
  const [s] = await db.select().from(season).where(eq(season.id, seasonId));
  if (!s) return null;
  const steps = await db.select().from(seasonStep).where(eq(seasonStep.seasonId, s.id)).orderBy(asc(seasonStep.position), asc(seasonStep.createdAt));
  const rows = steps.length ? await db.select().from(requirement).where(inArray(requirement.stepId, steps.map((x) => x.id))).orderBy(asc(requirement.position), asc(requirement.createdAt)) : [];
  const covers = await everyCover(rows.map((r) => r.id));
  const requirements = rows.map((r) => ({ stepId: r.stepId, requirement: toRequirement(r, covers.get(r.id) ?? []) }));
  const [families, { facts }] = await Promise.all([loadSeasonFamilies(), everyonesFacts(requirements.map((r) => r.requirement), { amounts: "none", parentId: null })]);
  return {
    season: { id: s.id, name: s.name, isCurrent: s.isCurrent }, roster: families !== null,
    steps: steps.map((x) => ({ id: x.id, name: x.name, requirements: requirements.filter((r) => r.stepId === x.id).map(({ requirement: r }) => ({
      id: r.id, title: r.title, required: r.required, appliesTo: r.appliesTo,
      counts: countsOf(coveredBy(r, families ?? []).map((subject) => lineFor(r, subject.id, facts))),
    })) })),
  };
}

/** The season the progress pages open on: the current one, or the newest when none is current. */
export async function defaultProgressSeasonId(): Promise<string | null> {
  const all = await db.select({ id: season.id, isCurrent: season.isCurrent, createdAt: season.createdAt }).from(season);
  const newest = [...all].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return (all.find((x) => x.isCurrent) ?? newest)?.id ?? null;
}

export type FamilyProgress = SeasonStanding & {
  /** The family's own id, which its page's address names it by, and its name. */
  family: { id: AppFamilyId; name: string };
  season: { id: string; name: string; isCurrent: boolean };
  /** The club's date the standing was worked out for (YYYY-MM-DD). */
  today: string;
  /** Each waiver recorded for the family or one of its students, by pairKey(requirementId, subjectId): staff see the reason. */
  waivers: Map<string, { reason: string; at: string; by: string | null }>;
};

/**
 * One family's standing through one season, in full: what a parent of the family sees, and the reason for each waiver.
 * The family is the app's record its page's address names, found as the season keeps it (seasonFamilyAt()). Null
 * when there is no such season, when the roster can't be shown, or when the family isn't an active family on it (a
 * record made inactive, or one whose customer QuickBooks has made inactive or no longer lists as a family). Only that
 * family's records are read. The page that shows this audits the read.
 */
export async function loadFamilyProgress(familyId: AppFamilyId, seasonId: string, amounts: "all" | "none"): Promise<FamilyProgress | null> {
  const [found, [s]] = await Promise.all([seasonFamilyAt(familyId), db.select().from(season).where(eq(season.id, seasonId))]);
  if (!found || !s) return null;
  const { today, standing, recorded } = await loadFamilyStanding(s.id, { familyId: found.id, students: found.students }, { amounts, parentId: null });
  const who = await staffNames(recorded.map((r) => r.waivedBy));
  const waivers = new Map(recorded.filter((r) => r.waivedAt !== null).map((r) => [pairKey(r.requirementId, r.subjectId),
    { reason: r.waivedReason ?? "", at: r.waivedAt!.toISOString(), by: r.waivedBy ? who.get(r.waivedBy) ?? null : null }]));
  return { ...standing, family: { id: found.id, name: found.name }, season: { id: s.id, name: s.name, isCurrent: s.isCurrent }, today, waivers };
}

type Target = { setup: RequirementSetup; families: SeasonFamily[] | null };
/** The requirement and the roster, read under the roster lock (lockRosterAs) by the transaction that writes. */
const target = async (requirementId: string, tx: Tx): Promise<Target | null> => {
  const setup = await getRequirementSetup(requirementId, tx);
  return setup ? { setup, families: await loadSeasonFamilies() } : null;
};
type Row = typeof requirementProgress.$inferSelect;
/** A row's family or student: exactly one is set (requirement_progress_one_subject). */
const subjectOfRow = (row: Row): SubjectId => (row.familyId ?? row.studentId)!;
/** The columns that name a subject of the roster, of its own kind. */
const columnsOf = (s: SeasonSubject) => (s.kind === "family" ? { familyId: s.id, studentId: null } : { familyId: null, studentId: s.id });
/** Every row recorded against this requirement, locked, by its subject's id as text: the ids a page sends are matched against these. */
const rowsOfRequirement = async (requirementId: string, tx: Tx): Promise<Map<string, Row>> =>
  new Map((await tx.select().from(requirementProgress).where(eq(requirementProgress.requirementId, requirementId)).for("update")).map((row) => [String(subjectOfRow(row)), row]));
const auditTarget = (requirementId: string, subject: SubjectId) => `${requirementId}:${String(subject)}`;
const described = (t: RequirementSetup, subject: SeasonSubject | undefined, subjectId: SubjectId) => ({
  season: t.season.name, step: t.step.name, requirement: t.requirement.title, subjectId: String(subjectId), subjectKind: t.requirement.appliesTo,
  ...(subject ? { subject: subject.name, familyId: String(subject.familyId) } : {}),
});

/**
 * Ticks a checklist item off, or unticks it, for one or many families or students in one go, by the app's own ids. A
 * tick is given only to someone the requirement is asked of now; any tick that exists can be taken away, whoever it
 * is for. Each change gets its own audit row, and a pair already as asked is left alone. An id that names nobody the
 * requirement is asked of, and no tick recorded against it, changes nothing.
 */
export async function setTicks(requirementId: string, rosterTag: string, subjectIds: readonly string[], ticked: boolean, o: SeasonOp): Promise<Done<{ changed: number }>> {
  const ids = [...new Set(subjectIds)];
  if (ids.length === 0 || ids.length > BULK_MAX) return refuse("There is nobody to change.");
  return db.transaction(async (tx) => {
    if (!(await lockRosterAs(tx, rosterTag))) return refuse(ROSTER_MOVED);
    const t = await target(requirementId, tx);
    if (!t) return refuse(GONE);
    if (!KIND_RULES[t.setup.requirement.kind]?.ticked) return refuse("This kind of requirement isn't ticked off by hand.");
    const covered = new Map((t.families ? coveredBy(t.setup.requirement, t.families) : []).map((s) => [String(s.id), s]));
    if (ticked) {
      if (!t.families) return refuse(NO_ROSTER);
      if (ids.some((id) => !covered.has(id))) return refuse(NOT_COVERED);
    }
    const [r] = await tx.select({ id: requirement.id }).from(requirement).where(eq(requirement.id, requirementId)).for("update");
    if (!r) return refuse(GONE);
    const existing = await rowsOfRequirement(r.id, tx);
    const now = new Date();
    let changed = 0;
    for (const id of ids) {
      const row = existing.get(id), subject = covered.get(id);
      if (ticked === Boolean(row?.metAt)) continue;
      // Ticking: someone on the roster (checked above). Unticking: a row that holds a tick, whoever it is for.
      const subjectId = row ? subjectOfRow(row) : subject!.id;
      if (ticked) {
        if (row) await tx.update(requirementProgress).set({ metAt: now, metBy: o.actor.id, updatedAt: now }).where(eq(requirementProgress.id, row.id));
        else await tx.insert(requirementProgress).values({ requirementId: r.id, ...columnsOf(subject!), metAt: now, metBy: o.actor.id });
      } else if (row!.waivedAt) {
        await tx.update(requirementProgress).set({ metAt: null, metBy: null, updatedAt: now }).where(eq(requirementProgress.id, row!.id));
      } else {
        await tx.delete(requirementProgress).where(eq(requirementProgress.id, row!.id)); // a row exists only while it records something
      }
      await writeAudit({ actor: o.actor, action: ticked ? "season.requirement.tick" : "season.requirement.untick", permission: o.permission, ip: o.ip,
        targetType: "requirement_progress", targetId: auditTarget(r.id, subjectId),
        before: { ...described(t.setup, subject, subjectId), ticked: !ticked, ...(row?.metAt ? { tickedAt: row.metAt.toISOString(), tickedBy: row.metBy } : {}) },
        after: { ticked } }, tx);
      changed++;
    }
    return { ok: true as const, changed };
  });
}

/**
 * Waives a requirement of any kind for one family or student it is asked of, by the app's own id, with a reason (v1
 * spec §10.2). The reason is in the audit row. Waiving again replaces the reason.
 */
export async function waiveRequirement(requirementId: string, rosterTag: string, subjectId: string, rawReason: string, o: SeasonOp): Promise<Done> {
  const reason = rawReason.trim();
  if (!reason) return refuse("Say why, in a few words. The reason is kept in the audit log.");
  if (reason.length > REASON_MAX) return refuse(`The reason is too long (${REASON_MAX} characters at most).`);
  return db.transaction(async (tx) => {
    if (!(await lockRosterAs(tx, rosterTag))) return refuse(ROSTER_MOVED);
    const t = await target(requirementId, tx);
    if (!t) return refuse(GONE);
    if (!t.families) return refuse(NO_ROSTER);
    const subject = coveredBy(t.setup.requirement, t.families).find((s) => String(s.id) === subjectId);
    if (!subject) return refuse(NOT_COVERED);
    const [r] = await tx.select({ id: requirement.id }).from(requirement).where(eq(requirement.id, requirementId)).for("update");
    if (!r) return refuse(GONE);
    const row = (await rowsOfRequirement(r.id, tx)).get(String(subject.id));
    const now = new Date();
    if (row) await tx.update(requirementProgress).set({ waivedAt: now, waivedBy: o.actor.id, waivedReason: reason, updatedAt: now }).where(eq(requirementProgress.id, row.id));
    else await tx.insert(requirementProgress).values({ requirementId: r.id, ...columnsOf(subject), waivedAt: now, waivedBy: o.actor.id, waivedReason: reason });
    await writeAudit({ actor: o.actor, action: "season.requirement.waive", permission: o.permission, ip: o.ip, targetType: "requirement_progress", targetId: auditTarget(r.id, subject.id),
      before: { ...described(t.setup, subject, subject.id), waived: Boolean(row?.waivedAt), ...(row?.waivedAt ? { reason: row.waivedReason } : {}) },
      after: { waived: true, reason } }, tx);
    return { ok: true as const };
  });
}

/** Takes a waiver away, whoever it is for, by the app's own id. With none recorded, nothing changes and nothing is recorded. */
export async function removeWaiver(requirementId: string, rosterTag: string, subjectId: string, o: SeasonOp): Promise<Done<{ changed: boolean }>> {
  return db.transaction(async (tx) => {
    if (!(await lockRosterAs(tx, rosterTag))) return refuse(ROSTER_MOVED);
    const t = await target(requirementId, tx);
    if (!t) return refuse(GONE);
    const subject = t.families ? coveredBy(t.setup.requirement, t.families).find((s) => String(s.id) === subjectId) : undefined;
    const row = (await rowsOfRequirement(requirementId, tx)).get(subjectId);
    if (!row?.waivedAt) return { ok: true as const, changed: false };
    if (row.metAt) await tx.update(requirementProgress).set({ waivedAt: null, waivedBy: null, waivedReason: null, updatedAt: new Date() }).where(eq(requirementProgress.id, row.id));
    else await tx.delete(requirementProgress).where(eq(requirementProgress.id, row.id));
    const recordedFor = subjectOfRow(row);
    await writeAudit({ actor: o.actor, action: "season.requirement.unwaive", permission: o.permission, ip: o.ip, targetType: "requirement_progress", targetId: auditTarget(requirementId, recordedFor),
      before: { ...described(t.setup, subject, recordedFor), waived: true, reason: row.waivedReason, waivedAt: row.waivedAt.toISOString(), waivedBy: row.waivedBy },
      after: { waived: false } }, tx);
    return { ok: true as const, changed: true };
  });
}
