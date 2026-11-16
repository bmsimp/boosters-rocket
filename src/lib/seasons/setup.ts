// Staff only: how a club sets its seasons up (v1 spec §10.1). Every write is one transaction with its audit row.
// Never imported by parent code (tests/integration/page-guards.test.ts): the chosen lists here name other families.
import "server-only";
import { asc, count, desc, eq, inArray } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { requirement, requirementCover, requirementProgress, season, seasonStep, type RequirementKind } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { dropUnopenedForms, formsHolding, formsHoldingWords } from "@/lib/forms/removal";
import { linkedShifts, placesHolding, placesHoldingWords } from "@/lib/volunteer/removal";
import { KIND_LABELS, isAvailableKind } from "./kinds";
import { isCalendarDate, type AmountUnit, type AppliesTo, type Requirement } from "./progress";
import { loadCovers, toRequirement, type RequirementRow } from "./recorded";
import { candidatesFor, loadSubjects } from "./subjects";
import { lockRosterAs, ROSTER_MOVED } from "./roster-lock";

export type SeasonOp = { actor: Actor; ip: string | null; permission?: string };
export type Refused = { ok: false; errors: string[] };
type Done<T = object> = ({ ok: true } & T) | Refused;
const refuse = (...errors: string[]): Refused => ({ ok: false, errors });

/** The steps a club's first season starts with (v1 spec §10.1), to rename or trim. */
export const TEMPLATE_STEPS = ["Join", "Forms", "Volunteer", "Season", "Wrap-up"] as const;
export const NAME_MAX = 60, TITLE_MAX = 120, STEPS_MAX = 20, REQUIREMENTS_MAX = 50, AMOUNT_MAX = 1000, COVER_MAX = 5000;
const GONE = "That isn't there any more. Reload the page.";

export type SeasonSummary = { id: string; name: string; isCurrent: boolean; createdAt: string; steps: number; requirements: number };
export type SetupRequirement = Requirement & { position: number };
export type SetupStep = { id: string; name: string; position: number; startsOn: string | null; endsOn: string | null; requirements: SetupRequirement[] };
export type SeasonSetup = { id: string; name: string; isCurrent: boolean; steps: SetupStep[] };

const stepsOf = (seasonId: string, tx: Tx | typeof db = db) =>
  tx.select().from(seasonStep).where(eq(seasonStep.seasonId, seasonId)).orderBy(asc(seasonStep.position), asc(seasonStep.createdAt));
const requirementsOf = (stepIds: string[], tx: Tx | typeof db = db) => stepIds.length === 0 ? Promise.resolve([] as RequirementRow[])
  : tx.select().from(requirement).where(inArray(requirement.stepId, stepIds)).orderBy(asc(requirement.position), asc(requirement.createdAt));

/** Every season, the newest first. */
export async function listSeasons(): Promise<SeasonSummary[]> {
  const [seasons, steps, requirements] = await Promise.all([
    db.select().from(season).orderBy(desc(season.createdAt), desc(season.id)),
    db.select({ seasonId: seasonStep.seasonId, n: count() }).from(seasonStep).groupBy(seasonStep.seasonId),
    db.select({ seasonId: seasonStep.seasonId, n: count() }).from(requirement).innerJoin(seasonStep, eq(requirement.stepId, seasonStep.id)).groupBy(seasonStep.seasonId),
  ]);
  const of = (rows: { seasonId: string; n: number }[], id: string) => rows.find((r) => r.seasonId === id)?.n ?? 0;
  return seasons.map((s) => ({ id: s.id, name: s.name, isCurrent: s.isCurrent, createdAt: s.createdAt.toISOString(), steps: of(steps, s.id), requirements: of(requirements, s.id) }));
}

/** One season with its steps and their requirements in order, chosen lists included; null when there is none. */
export async function getSeasonSetup(seasonId: string, tx?: Tx): Promise<SeasonSetup | null> {
  const [s] = await (tx ?? db).select().from(season).where(eq(season.id, seasonId));
  if (!s) return null;
  const steps = await stepsOf(s.id, tx);
  const rows = await requirementsOf(steps.map((x) => x.id), tx);
  const covers = await loadCovers(rows.map((r) => r.id), null, tx);
  return { id: s.id, name: s.name, isCurrent: s.isCurrent, steps: steps.map((x) => ({
    id: x.id, name: x.name, position: x.position, startsOn: x.startsOn, endsOn: x.endsOn,
    requirements: rows.filter((r) => r.stepId === x.id).map((r) => ({ ...toRequirement(r, covers.get(r.id) ?? []), position: r.position })),
  })) };
}

export type RequirementSetup = { requirement: SetupRequirement; step: { id: string; name: string }; season: { id: string; name: string; isCurrent: boolean }; recorded: number };
/** One requirement with the step and season it is in, and how many ticks and waivers are recorded against it; null when there is none. */
export async function getRequirementSetup(requirementId: string, tx?: Tx): Promise<RequirementSetup | null> {
  const q = tx ?? db;
  const [row] = await q.select({ r: requirement, step: { id: seasonStep.id, name: seasonStep.name }, season: { id: season.id, name: season.name, isCurrent: season.isCurrent } })
    .from(requirement).innerJoin(seasonStep, eq(requirement.stepId, seasonStep.id)).innerJoin(season, eq(seasonStep.seasonId, season.id)).where(eq(requirement.id, requirementId));
  if (!row) return null;
  const [covers, [recorded]] = await Promise.all([
    loadCovers([row.r.id], null, tx),
    q.select({ n: count() }).from(requirementProgress).where(eq(requirementProgress.requirementId, row.r.id)),
  ]);
  return { requirement: { ...toRequirement(row.r, covers.get(row.r.id) ?? []), position: row.r.position }, step: row.step, season: row.season, recorded: recorded?.n ?? 0 };
}

const cleanName = (raw: string, what: string, max: number): { ok: true; value: string } | Refused => {
  const value = raw.trim().replace(/\s+/g, " ");
  if (!value) return refuse(`${what} needs a name.`);
  if (value.length > max) return refuse(`${what} is too long (${max} characters at most).`);
  return { ok: true, value };
};

/* ---- Seasons ---- */

/**
 * A new season: with no steps, with the template steps, or copied from the last season made. A copy takes the steps
 * and the requirements with their settings and chosen lists, and leaves out every date, tick and waiver. A new season
 * is never the current one: staff say when parents should see it.
 */
export async function createSeason(rawName: string, start: "empty" | "template" | "last", o: SeasonOp): Promise<Done<{ seasonId: string }>> {
  const name = cleanName(rawName, "The season", NAME_MAX);
  if (!name.ok) return name;
  return db.transaction(async (tx) => {
    const [last] = start === "last" ? await tx.select().from(season).orderBy(desc(season.createdAt), desc(season.id)).limit(1) : [];
    if (start === "last" && !last) return refuse("There is no season to copy yet.");
    const from = last ? await getSeasonSetup(last.id, tx) : null;
    const [made] = await tx.insert(season).values({ name: name.value }).returning();
    const stepNames = start === "template" ? [...TEMPLATE_STEPS] : (from?.steps ?? []).map((s) => s.name);
    const steps = stepNames.length ? await tx.insert(seasonStep).values(stepNames.map((n, position) => ({ seasonId: made!.id, name: n, position }))).returning() : [];
    // A payment requirement keeps the QuickBooks product or service it is met by.
    const sourceIds = (from?.steps ?? []).flatMap((x) => x.requirements.map((r) => r.id));
    const itemOf = new Map(sourceIds.length === 0 ? [] : (await tx.select({ id: requirement.id, itemQboId: requirement.itemQboId }).from(requirement)
      .where(inArray(requirement.id, sourceIds))).map((r) => [r.id, r.itemQboId]));
    let copied = 0;
    for (const [i, source] of (from?.steps ?? []).entries()) {
      const target = steps.find((s) => s.position === i)!;
      for (const [position, r] of source.requirements.entries()) {
        const [row] = await tx.insert(requirement).values({ stepId: target.id, kind: r.kind, title: r.title, required: r.required, appliesTo: r.appliesTo,
          amount: r.amount, amountUnit: r.amountUnit, dueOn: null, covers: r.covers, itemQboId: itemOf.get(r.id) ?? null, position }).returning({ id: requirement.id });
        if (r.covers === "chosen" && r.coveredQboIds.length) await tx.insert(requirementCover).values(r.coveredQboIds.map((subjectQboId) => ({ requirementId: row!.id, subjectQboId })));
        copied++;
      }
    }
    await writeAudit({ actor: o.actor, action: "season.create", permission: o.permission, targetType: "season", targetId: made!.id, ip: o.ip,
      after: { name: name.value, start, steps: stepNames, requirements: copied, ...(last ? { copiedFrom: { id: last.id, name: last.name } } : {}) } }, tx);
    return { ok: true as const, seasonId: made!.id };
  });
}

export async function renameSeason(seasonId: string, rawName: string, o: SeasonOp): Promise<Done> {
  const name = cleanName(rawName, "The season", NAME_MAX);
  if (!name.ok) return name;
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(season).where(eq(season.id, seasonId)).for("update");
    if (!s) return refuse(GONE);
    await tx.update(season).set({ name: name.value, updatedAt: new Date() }).where(eq(season.id, s.id));
    await writeAudit({ actor: o.actor, action: "season.rename", permission: o.permission, targetType: "season", targetId: s.id, ip: o.ip,
      before: { name: s.name }, after: { name: name.value } }, tx);
    return { ok: true as const };
  });
}

/** Makes one season the current one, the season parents see, or (with null) none of them. */
export async function setCurrentSeason(seasonId: string | null, o: SeasonOp): Promise<Done> {
  return db.transaction(async (tx) => {
    const all = await tx.select().from(season).for("update");
    const before = all.find((s) => s.isCurrent) ?? null, next = seasonId === null ? null : all.find((s) => s.id === seasonId) ?? null;
    if (seasonId !== null && !next) return refuse(GONE);
    // One at most: the old one is cleared before the new one is set (season_current_uq).
    if (before && before.id !== next?.id) await tx.update(season).set({ isCurrent: false, updatedAt: new Date() }).where(eq(season.id, before.id));
    if (next && !next.isCurrent) await tx.update(season).set({ isCurrent: true, updatedAt: new Date() }).where(eq(season.id, next.id));
    const named = (s: typeof before) => (s ? { id: s.id, name: s.name } : null);
    await writeAudit({ actor: o.actor, action: "season.current.set", permission: o.permission, targetType: "season", targetId: next?.id ?? before?.id, ip: o.ip,
      before: { current: named(before) }, after: { current: named(next) } }, tx);
    return { ok: true as const };
  });
}

/* ---- Steps ---- */

const stepFacts = (s: typeof seasonStep.$inferSelect) => ({ name: s.name, startsOn: s.startsOn, endsOn: s.endsOn });

export async function addStep(seasonId: string, rawName: string, o: SeasonOp): Promise<Done<{ stepId: string }>> {
  const name = cleanName(rawName, "The step", NAME_MAX);
  if (!name.ok) return name;
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(season).where(eq(season.id, seasonId)).for("update");
    if (!s) return refuse(GONE);
    const steps = await stepsOf(s.id, tx);
    if (steps.length >= STEPS_MAX) return refuse(`A season can have ${STEPS_MAX} steps at most.`);
    const position = steps.reduce((max, x) => Math.max(max, x.position), -1) + 1;
    const [made] = await tx.insert(seasonStep).values({ seasonId: s.id, name: name.value, position }).returning();
    await writeAudit({ actor: o.actor, action: "season.step.add", permission: o.permission, targetType: "season_step", targetId: made!.id, ip: o.ip,
      after: { season: s.name, ...stepFacts(made!) } }, tx);
    return { ok: true as const, stepId: made!.id };
  });
}

/** A step's name and its optional date range. An empty date is no date. */
export async function updateStep(stepId: string, input: { name: string; startsOn: string | null; endsOn: string | null }, o: SeasonOp): Promise<Done> {
  const name = cleanName(input.name, "The step", NAME_MAX);
  if (!name.ok) return name;
  const startsOn = input.startsOn || null, endsOn = input.endsOn || null;
  if ((startsOn !== null && !isCalendarDate(startsOn)) || (endsOn !== null && !isCalendarDate(endsOn))) return refuse("Enter each date as a day on the calendar.");
  if (startsOn !== null && endsOn !== null && endsOn < startsOn) return refuse("The step ends before it starts. Check the two dates.");
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(seasonStep).where(eq(seasonStep.id, stepId)).for("update");
    if (!s) return refuse(GONE);
    await tx.update(seasonStep).set({ name: name.value, startsOn, endsOn, updatedAt: new Date() }).where(eq(seasonStep.id, s.id));
    await writeAudit({ actor: o.actor, action: "season.step.update", permission: o.permission, targetType: "season_step", targetId: s.id, ip: o.ip,
      before: stepFacts(s), after: { name: name.value, startsOn, endsOn } }, tx);
    return { ok: true as const };
  });
}

/** Moves a step one place earlier or later in its season. At the end already, nothing changes and nothing is recorded. */
export async function moveStep(stepId: string, direction: "earlier" | "later", o: SeasonOp): Promise<Done<{ moved: boolean }>> {
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(seasonStep).where(eq(seasonStep.id, stepId));
    if (!s) return refuse(GONE);
    await tx.select({ id: season.id }).from(season).where(eq(season.id, s.seasonId)).for("update"); // one reorder of a season at a time
    const steps = await stepsOf(s.seasonId, tx);
    const from = steps.findIndex((x) => x.id === s.id), to = direction === "earlier" ? from - 1 : from + 1;
    if (from < 0) return refuse(GONE);
    if (to < 0 || to >= steps.length) return { ok: true as const, moved: false };
    const order = steps.map((x) => x.id);
    [order[from], order[to]] = [order[to]!, order[from]!];
    for (const [position, id] of order.entries()) await tx.update(seasonStep).set({ position, updatedAt: new Date() }).where(eq(seasonStep.id, id));
    const names = (ids: string[]) => ids.map((id) => steps.find((x) => x.id === id)!.name);
    await writeAudit({ actor: o.actor, action: "season.step.move", permission: o.permission, targetType: "season_step", targetId: s.id, ip: o.ip,
      before: { order: names(steps.map((x) => x.id)) }, after: { order: names(order) } }, tx);
    return { ok: true as const, moved: true };
  });
}

const recordedFor = async (requirementIds: string[], tx: Tx): Promise<number> => {
  if (requirementIds.length === 0) return 0;
  const [n] = await tx.select({ n: count() }).from(requirementProgress).where(inArray(requirementProgress.requirementId, requirementIds));
  return n?.n ?? 0;
};
const requirementFacts = (r: RequirementRow) => ({ kind: r.kind, title: r.title, required: r.required, appliesTo: r.appliesTo, amount: r.amount, amountUnit: r.amountUnit, dueOn: r.dueOn, covers: r.covers });

/**
 * Removes a step with the requirements in it. Refused, with the reason, while any of them has a tick or a waiver
 * recorded: history is never destroyed along with a step.
 */
export async function removeStep(stepId: string, o: SeasonOp): Promise<Done> {
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(seasonStep).where(eq(seasonStep.id, stepId)).for("update");
    if (!s) return refuse(GONE);
    const rows = await tx.select().from(requirement).where(eq(requirement.stepId, s.id)).orderBy(asc(requirement.position)).for("update");
    const recorded = await recordedFor(rows.map((r) => r.id), tx);
    if (recorded > 0) return refuse(`${s.name} can't be removed: ${recorded === 1 ? "a tick or waiver is" : `${recorded} ticks and waivers are`} recorded on its requirements. `
      + `Clear them first on each requirement's progress page, or rename the step and keep it.`);
    // A form that was made for a family to sign is history too (src/lib/forms/removal.ts); one nobody opened is not.
    const held = await formsHolding(rows.map((r) => r.id), tx);
    if (held > 0) return refuse(formsHoldingWords(s.name, held));
    const places = await placesHolding(rows.map((r) => r.id), tx);
    if (places > 0) return refuse(placesHoldingWords(s.name, places));
    const shifts = await linkedShifts(rows.map((r) => r.id), tx);
    await dropUnopenedForms(rows.map((r) => r.id), tx);
    await tx.delete(seasonStep).where(eq(seasonStep.id, s.id)); // its requirements and their chosen lists go with it
    await writeAudit({ actor: o.actor, action: "season.step.remove", permission: o.permission, targetType: "season_step", targetId: s.id, ip: o.ip,
      before: { ...stepFacts(s), position: s.position, requirements: rows.map((r) => ({ ...requirementFacts(r), ...(shifts.has(r.id) ? { shiftIds: shifts.get(r.id) } : {}) })) } }, tx);
    return { ok: true as const };
  });
}

/* ---- Requirements ---- */

export type RequirementInput = { title: string; required: boolean; amount: number | null; amountUnit: AmountUnit | null; dueOn: string | null };
export type NewRequirementInput = RequirementInput & { kind: RequirementKind; appliesTo: AppliesTo };

function checkRequirement(kind: RequirementKind, input: RequirementInput): { ok: true; value: RequirementInput } | Refused {
  const title = cleanName(input.title, "The requirement", TITLE_MAX);
  if (!title.ok) return title;
  const dueOn = input.dueOn || null;
  if (dueOn !== null && !isCalendarDate(dueOn)) return refuse("Enter the due date as a day on the calendar.");
  if (kind !== "volunteer") {
    if (input.amount !== null || input.amountUnit !== null) return refuse(`Only a volunteering requirement has an amount.`);
    return { ok: true, value: { title: title.value, required: input.required, amount: null, amountUnit: null, dueOn } };
  }
  if (input.amount === null || !Number.isInteger(input.amount) || input.amount < 1 || input.amount > AMOUNT_MAX) return refuse(`Say how much volunteering: a whole number from 1 to ${AMOUNT_MAX}.`);
  if (input.amountUnit !== "shifts" && input.amountUnit !== "hours") return refuse("Say whether the amount is in shifts or in hours.");
  return { ok: true, value: { title: title.value, required: input.required, amount: input.amount, amountUnit: input.amountUnit, dueOn } };
}

/** A new requirement at the end of a step, asked of everyone until a list is chosen. Only kinds that can be met today (./kinds.ts) can be made. */
export async function addRequirement(stepId: string, input: NewRequirementInput, o: SeasonOp): Promise<Done<{ requirementId: string }>> {
  if (!isAvailableKind(input.kind)) return refuse("Choose a kind of requirement from the list.");
  if (input.appliesTo !== "family" && input.appliesTo !== "student") return refuse("Say whether it is for each family or each student.");
  const checked = checkRequirement(input.kind, input);
  if (!checked.ok) return checked;
  return db.transaction(async (tx) => {
    const [s] = await tx.select().from(seasonStep).where(eq(seasonStep.id, stepId)).for("update");
    if (!s) return refuse(GONE);
    const rows = await tx.select({ position: requirement.position }).from(requirement).where(eq(requirement.stepId, s.id));
    if (rows.length >= REQUIREMENTS_MAX) return refuse(`A step can have ${REQUIREMENTS_MAX} requirements at most.`);
    const position = rows.reduce((max, r) => Math.max(max, r.position), -1) + 1;
    const [made] = await tx.insert(requirement).values({ stepId: s.id, kind: input.kind, appliesTo: input.appliesTo, ...checked.value, position }).returning();
    await writeAudit({ actor: o.actor, action: "season.requirement.add", permission: o.permission, targetType: "requirement", targetId: made!.id, ip: o.ip,
      after: { step: s.name, ...requirementFacts(made!) } }, tx);
    return { ok: true as const, requirementId: made!.id };
  });
}

/** A requirement's title, whether it is required, its amount and its due date. Its kind and who it applies to stay as they were made. */
export async function updateRequirement(requirementId: string, input: RequirementInput, o: SeasonOp): Promise<Done> {
  return db.transaction(async (tx) => {
    const [r] = await tx.select().from(requirement).where(eq(requirement.id, requirementId)).for("update");
    if (!r) return refuse(GONE);
    const checked = checkRequirement(r.kind, input);
    if (!checked.ok) return checked;
    const [after] = await tx.update(requirement).set({ ...checked.value, updatedAt: new Date() }).where(eq(requirement.id, r.id)).returning();
    await writeAudit({ actor: o.actor, action: "season.requirement.update", permission: o.permission, targetType: "requirement", targetId: r.id, ip: o.ip,
      before: requirementFacts(r), after: requirementFacts(after!) }, tx);
    return { ok: true as const };
  });
}

/**
 * Who a requirement is asked of: everyone, or a list picked from the roster (families for a per-family requirement,
 * students for a per-student one). Every id must be on the roster now. Someone already listed who has since left the
 * roster stays listed, so they are covered again if they come back.
 */
export async function setCoverage(requirementId: string, rosterTag: string, covers: "everyone" | "chosen", subjectQboIds: readonly string[], o: SeasonOp): Promise<Done> {
  const chosen = [...new Set(subjectQboIds)];
  if (covers === "chosen" && chosen.length === 0) return refuse("Choose at least one, or ask it of everyone.");
  if (chosen.length > COVER_MAX) return refuse("That list is too long.");
  return db.transaction(async (tx) => {
    // Under the roster lock, and against the company the page was shown: the list is checked against the roster it is kept with.
    if (!(await lockRosterAs(tx, rosterTag))) return refuse(ROSTER_MOVED);
    const families = covers === "chosen" ? await loadSubjects() : [];
    if (families === null) return refuse("The roster can't be shown right now, so a list can't be chosen. Check QuickBooks under Roster.");
    const [r] = await tx.select().from(requirement).where(eq(requirement.id, requirementId)).for("update");
    if (!r) return refuse(GONE);
    const before = (await tx.select({ subjectQboId: requirementCover.subjectQboId }).from(requirementCover).where(eq(requirementCover.requirementId, r.id))).map((c) => c.subjectQboId).sort();
    let after: string[] = [];
    if (covers === "chosen") {
      const onRoster = new Set(candidatesFor(r.appliesTo, families).map((s) => s.qboId));
      if (chosen.some((id) => !onRoster.has(id))) return refuse("Someone in that list isn't on the roster any more. Reload the page and choose again.");
      after = [...new Set([...chosen, ...before.filter((id) => !onRoster.has(id))])].sort();
    }
    await tx.delete(requirementCover).where(eq(requirementCover.requirementId, r.id));
    if (after.length) await tx.insert(requirementCover).values(after.map((subjectQboId) => ({ requirementId: r.id, subjectQboId })));
    await tx.update(requirement).set({ covers, updatedAt: new Date() }).where(eq(requirement.id, r.id));
    await writeAudit({ actor: o.actor, action: "season.requirement.cover", permission: o.permission, targetType: "requirement", targetId: r.id, ip: o.ip,
      before: { covers: r.covers, subjectQboIds: before }, after: { covers, subjectQboIds: after } }, tx);
    return { ok: true as const };
  });
}

/** Removes a requirement. Refused, with the reason, while a tick or a waiver is recorded against it. */
export async function removeRequirement(requirementId: string, o: SeasonOp): Promise<Done> {
  return db.transaction(async (tx) => {
    const [r] = await tx.select().from(requirement).where(eq(requirement.id, requirementId)).for("update");
    if (!r) return refuse(GONE);
    const recorded = await recordedFor([r.id], tx);
    if (recorded > 0) return refuse(`${r.title} can't be removed: ${recorded === 1 ? "a tick or waiver is" : `${recorded} ticks and waivers are`} recorded against it. `
      + `Clear them first on its progress page, or make it optional so it no longer holds the step open.`);
    const held = await formsHolding([r.id], tx);
    if (held > 0) return refuse(formsHoldingWords(r.title, held));
    const places = await placesHolding([r.id], tx);
    if (places > 0) return refuse(placesHoldingWords(r.title, places));
    const shifts = (await linkedShifts([r.id], tx)).get(r.id);
    await dropUnopenedForms([r.id], tx);
    const covered = (await tx.select({ subjectQboId: requirementCover.subjectQboId }).from(requirementCover).where(eq(requirementCover.requirementId, r.id))).map((c) => c.subjectQboId).sort();
    await tx.delete(requirement).where(eq(requirement.id, r.id)); // its chosen list goes with it
    await writeAudit({ actor: o.actor, action: "season.requirement.remove", permission: o.permission, targetType: "requirement", targetId: r.id, ip: o.ip,
      before: { ...requirementFacts(r), subjectQboIds: covered, ...(shifts ? { shiftIds: shifts } : {}) } }, tx);
    return { ok: true as const };
  });
}

/** A requirement's settings in a few words, for a list: "Checklist item · Required · Each student". */
export function describeRequirement(r: Pick<Requirement, "kind" | "required" | "appliesTo" | "amount" | "amountUnit">): string {
  return [KIND_LABELS[r.kind], r.required ? "Required" : "Optional", r.appliesTo === "family" ? "Each family" : "Each student",
    ...(r.amount !== null && r.amountUnit ? [`${r.amount} ${r.amount === 1 ? r.amountUnit.replace(/s$/, "") : r.amountUnit}`] : [])].join(" · ");
}
