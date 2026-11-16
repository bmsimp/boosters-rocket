// Staff only: who has met each requirement, across every family, and the ticks and waivers staff record (v1 spec
// §10.2). Every write is one transaction with its audit rows. Never imported by parent code
// (tests/integration/page-guards.test.ts).
import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { qboCustomer, requirement, requirementProgress, season, seasonStep, staffUser } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { KIND_RULES, pairKey } from "./kinds";
import { lineFor, type LineState, type Requirement, type SeasonStanding } from "./progress";
import { loadCovers, loadFacts, loadFamilyStanding, toRequirement } from "./recorded";
import { getRequirementSetup, type Refused, type RequirementSetup, type SeasonOp } from "./setup";
import { coveredBy, loadSubjects, type FamilySubject, type Subject } from "./subjects";

type Done<T = object> = ({ ok: true } & T) | Refused;
const refuse = (...errors: string[]): Refused => ({ ok: false, errors });
export const REASON_MAX = 500, BULK_MAX = 5000;
const GONE = "That isn't there any more. Reload the page.";
const NO_ROSTER = "The roster can't be shown right now, so nothing was changed. Check QuickBooks under Roster.";
const NOT_COVERED = "Someone in that list isn't covered by this requirement any more. Reload the page and try again.";

export type ProgressRow = Subject & {
  state: LineState; words: string;
  /** A checklist tick: when, and who ticked it. */
  metAt: string | null; metBy: string | null;
  waivedAt: string | null; waivedBy: string | null; waivedReason: string | null;
};
/** A tick or waiver recorded for someone the roster no longer lists under this requirement: kept, and shown apart. */
export type LeftRow = { subjectQboId: string; name: string | null; metAt: string | null; waivedAt: string | null; waivedReason: string | null };
export type RequirementProgress = RequirementSetup & {
  /** True for a kind staff meet by hand (a checklist item). */
  ticked: boolean;
  /** Everyone the requirement is asked of now, by family and then by name; null when the roster can't be shown. */
  rows: ProgressRow[] | null;
  left: LeftRow[];
  counts: { asked: number; done: number; waived: number; todo: number };
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

/** One requirement and how it stands for everyone it is asked of; null when there is no such requirement. */
export async function loadRequirementProgress(requirementId: string): Promise<RequirementProgress | null> {
  const setup = await getRequirementSetup(requirementId);
  if (!setup) return null;
  const [families, { facts, recorded }] = await Promise.all([loadSubjects(), loadFacts([setup.requirement], null)]);
  const who = await staffNames(recorded.flatMap((r) => [r.metBy, r.waivedBy]));
  const by = new Map(recorded.map((r) => [r.subjectQboId, r]));
  const covered = families ? coveredBy(setup.requirement, families) : null;
  const rows = covered?.map((s): ProgressRow => {
    const line = lineFor(setup.requirement, s.qboId, facts), r = by.get(s.qboId);
    return { ...s, state: line.state, words: line.words, metAt: iso(r?.metAt ?? null), metBy: r?.metBy ? who.get(r.metBy) ?? null : null,
      waivedAt: iso(r?.waivedAt ?? null), waivedBy: r?.waivedBy ? who.get(r.waivedBy) ?? null : null, waivedReason: r?.waivedReason ?? null };
  }) ?? null;
  // Recorded for someone not asked now: they left the roster, or a chosen list no longer names them.
  const shown = new Set((covered ?? []).map((s) => s.qboId));
  const gone = covered ? recorded.filter((r) => !shown.has(r.subjectQboId)) : [];
  const names = gone.length ? new Map((await db.select({ qboId: qboCustomer.qboId, name: qboCustomer.displayName }).from(qboCustomer)
    .where(inArray(qboCustomer.qboId, gone.map((r) => r.subjectQboId)))).map((c) => [c.qboId, c.name])) : new Map<string, string>();
  const left = gone.map((r) => ({ subjectQboId: r.subjectQboId, name: names.get(r.subjectQboId) ?? null, metAt: iso(r.metAt), waivedAt: iso(r.waivedAt), waivedReason: r.waivedReason }));
  return { ...setup, ticked: KIND_RULES[setup.requirement.kind]?.ticked ?? false, rows, left, counts: countsOf(rows ?? []) };
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
  const covers = await loadCovers(rows.map((r) => r.id), null);
  const requirements = rows.map((r) => ({ stepId: r.stepId, requirement: toRequirement(r, covers.get(r.id) ?? []) }));
  const [families, { facts }] = await Promise.all([loadSubjects(), loadFacts(requirements.map((r) => r.requirement), null)]);
  return {
    season: { id: s.id, name: s.name, isCurrent: s.isCurrent }, roster: families !== null,
    steps: steps.map((x) => ({ id: x.id, name: x.name, requirements: requirements.filter((r) => r.stepId === x.id).map(({ requirement: r }) => ({
      id: r.id, title: r.title, required: r.required, appliesTo: r.appliesTo,
      counts: countsOf(coveredBy(r, families ?? []).map((subject) => lineFor(r, subject.qboId, facts))),
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
  family: { qboId: string; name: string };
  season: { id: string; name: string; isCurrent: boolean };
  /** The club's date the standing was worked out for (YYYY-MM-DD). */
  today: string;
  /** Each waiver recorded for the family or one of its students, by pairKey(requirementId, subjectQboId): staff see the reason. */
  waivers: Map<string, { reason: string; at: string; by: string | null }>;
};

/**
 * One family's standing through one season, in full: what a parent of the family sees, and the reason for each waiver.
 * Null when there is no such season, when the roster can't be shown, or when the id isn't an active family on it (a
 * student's id, a parent's, a family QuickBooks has made inactive). Only that family's records are read. The page that
 * shows this audits the read.
 */
export async function loadFamilyProgress(familyQboId: string, seasonId: string): Promise<FamilyProgress | null> {
  const [families, [s]] = await Promise.all([loadSubjects(), db.select().from(season).where(eq(season.id, seasonId))]);
  const family = families?.find((f) => f.qboId === familyQboId);
  if (!family || !s) return null;
  const { today, standing, recorded } = await loadFamilyStanding(s.id, { familyQboId: family.qboId, students: family.students });
  const who = await staffNames(recorded.map((r) => r.waivedBy));
  const waivers = new Map(recorded.filter((r) => r.waivedAt !== null).map((r) => [pairKey(r.requirementId, r.subjectQboId),
    { reason: r.waivedReason ?? "", at: r.waivedAt!.toISOString(), by: r.waivedBy ? who.get(r.waivedBy) ?? null : null }]));
  return { ...standing, family: { qboId: family.qboId, name: family.name }, season: { id: s.id, name: s.name, isCurrent: s.isCurrent }, today, waivers };
}

type Target = { setup: RequirementSetup; families: FamilySubject[] | null };
const target = async (requirementId: string): Promise<Target | null> => {
  const setup = await getRequirementSetup(requirementId);
  return setup ? { setup, families: await loadSubjects() } : null;
};
const auditTarget = (requirementId: string, subjectQboId: string) => `${requirementId}:${subjectQboId}`;
const described = (t: RequirementSetup, subject: Subject | undefined, subjectQboId: string) => ({
  season: t.season.name, step: t.step.name, requirement: t.requirement.title, subjectQboId,
  ...(subject ? { subject: subject.name, familyQboId: subject.familyQboId } : {}),
});

/**
 * Ticks a checklist item off, or unticks it, for one or many families or students in one go. A tick is given only to
 * someone the requirement is asked of now; any tick that exists can be taken away, whoever it is for. Each change gets
 * its own audit row, and a pair already as asked is left alone.
 */
export async function setTicks(requirementId: string, subjectQboIds: readonly string[], ticked: boolean, o: SeasonOp): Promise<Done<{ changed: number }>> {
  const ids = [...new Set(subjectQboIds)];
  if (ids.length === 0 || ids.length > BULK_MAX) return refuse("There is nobody to change.");
  const t = await target(requirementId);
  if (!t) return refuse(GONE);
  if (!KIND_RULES[t.setup.requirement.kind]?.ticked) return refuse("This kind of requirement isn't ticked off by hand.");
  const covered = new Map((t.families ? coveredBy(t.setup.requirement, t.families) : []).map((s) => [s.qboId, s]));
  if (ticked) {
    if (!t.families) return refuse(NO_ROSTER);
    if (ids.some((id) => !covered.has(id))) return refuse(NOT_COVERED);
  }
  return db.transaction(async (tx) => {
    const [r] = await tx.select({ id: requirement.id }).from(requirement).where(eq(requirement.id, requirementId)).for("update");
    if (!r) return refuse(GONE);
    const existing = new Map((await tx.select().from(requirementProgress)
      .where(and(eq(requirementProgress.requirementId, r.id), inArray(requirementProgress.subjectQboId, ids))).for("update")).map((row) => [row.subjectQboId, row]));
    const now = new Date();
    let changed = 0;
    for (const subjectQboId of ids) {
      const row = existing.get(subjectQboId);
      if (ticked === Boolean(row?.metAt)) continue;
      if (ticked) {
        if (row) await tx.update(requirementProgress).set({ metAt: now, metBy: o.actor.id, updatedAt: now }).where(eq(requirementProgress.id, row.id));
        else await tx.insert(requirementProgress).values({ requirementId: r.id, subjectQboId, metAt: now, metBy: o.actor.id });
      } else if (row!.waivedAt) {
        await tx.update(requirementProgress).set({ metAt: null, metBy: null, updatedAt: now }).where(eq(requirementProgress.id, row!.id));
      } else {
        await tx.delete(requirementProgress).where(eq(requirementProgress.id, row!.id)); // a row exists only while it records something
      }
      await writeAudit({ actor: o.actor, action: ticked ? "season.requirement.tick" : "season.requirement.untick", permission: o.permission, ip: o.ip,
        targetType: "requirement_progress", targetId: auditTarget(r.id, subjectQboId),
        before: { ...described(t.setup, covered.get(subjectQboId), subjectQboId), ticked: !ticked, ...(row?.metAt ? { tickedAt: row.metAt.toISOString(), tickedBy: row.metBy } : {}) },
        after: { ticked } }, tx);
      changed++;
    }
    return { ok: true as const, changed };
  });
}

/**
 * Waives a requirement of any kind for one family or student it is asked of, with a reason (v1 spec §10.2). The reason
 * is in the audit row. Waiving again replaces the reason.
 */
export async function waiveRequirement(requirementId: string, subjectQboId: string, rawReason: string, o: SeasonOp): Promise<Done> {
  const reason = rawReason.trim();
  if (!reason) return refuse("Say why, in a few words. The reason is kept in the audit log.");
  if (reason.length > REASON_MAX) return refuse(`The reason is too long (${REASON_MAX} characters at most).`);
  const t = await target(requirementId);
  if (!t) return refuse(GONE);
  if (!t.families) return refuse(NO_ROSTER);
  const subject = coveredBy(t.setup.requirement, t.families).find((s) => s.qboId === subjectQboId);
  if (!subject) return refuse(NOT_COVERED);
  return db.transaction(async (tx) => {
    const [r] = await tx.select({ id: requirement.id }).from(requirement).where(eq(requirement.id, requirementId)).for("update");
    if (!r) return refuse(GONE);
    const [row] = await tx.select().from(requirementProgress).where(and(eq(requirementProgress.requirementId, r.id), eq(requirementProgress.subjectQboId, subjectQboId))).for("update");
    const now = new Date();
    if (row) await tx.update(requirementProgress).set({ waivedAt: now, waivedBy: o.actor.id, waivedReason: reason, updatedAt: now }).where(eq(requirementProgress.id, row.id));
    else await tx.insert(requirementProgress).values({ requirementId: r.id, subjectQboId, waivedAt: now, waivedBy: o.actor.id, waivedReason: reason });
    await writeAudit({ actor: o.actor, action: "season.requirement.waive", permission: o.permission, ip: o.ip, targetType: "requirement_progress", targetId: auditTarget(r.id, subjectQboId),
      before: { ...described(t.setup, subject, subjectQboId), waived: Boolean(row?.waivedAt), ...(row?.waivedAt ? { reason: row.waivedReason } : {}) },
      after: { waived: true, reason } }, tx);
    return { ok: true as const };
  });
}

/** Takes a waiver away, whoever it is for. With none recorded, nothing changes and nothing is recorded. */
export async function removeWaiver(requirementId: string, subjectQboId: string, o: SeasonOp): Promise<Done<{ changed: boolean }>> {
  const t = await target(requirementId);
  if (!t) return refuse(GONE);
  const subject = t.families ? coveredBy(t.setup.requirement, t.families).find((s) => s.qboId === subjectQboId) : undefined;
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(requirementProgress).where(and(eq(requirementProgress.requirementId, requirementId), eq(requirementProgress.subjectQboId, subjectQboId))).for("update");
    if (!row?.waivedAt) return { ok: true as const, changed: false };
    if (row.metAt) await tx.update(requirementProgress).set({ waivedAt: null, waivedBy: null, waivedReason: null, updatedAt: new Date() }).where(eq(requirementProgress.id, row.id));
    else await tx.delete(requirementProgress).where(eq(requirementProgress.id, row.id));
    await writeAudit({ actor: o.actor, action: "season.requirement.unwaive", permission: o.permission, ip: o.ip, targetType: "requirement_progress", targetId: auditTarget(requirementId, subjectQboId),
      before: { ...described(t.setup, subject, subjectQboId), waived: true, reason: row.waivedReason, waivedAt: row.waivedAt.toISOString(), waivedBy: row.waivedBy },
      after: { waived: false } }, tx);
    return { ok: true as const, changed: true };
  });
}
