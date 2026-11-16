// Confirmed volunteer credit, read and spent on requirements (v1 spec §11.4): the part of the volunteer kind's rule
// (src/lib/seasons/kinds.ts) that reads the database, and what a parent's Volunteer page shows of the family's own
// credit. Parent pages reach it with the session's family alone: every query here takes the families it is asked
// about and reads nothing else, and nothing a staff member wrote (a note, a reason) is read here: the staff pages read
// those through ./staff-credit.ts. It imports no staff-only module (tests/integration/page-guards.test.ts scans this file).
import "server-only";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { qboCustomer, requirement, requirementCover, requirementProgress, season, seasonStep, volunteerCredit, volunteerEvent, volunteerShift, volunteerShiftRequirement, volunteerSignup } from "@/lib/db/schema";
import type { Requirement } from "@/lib/seasons/progress";
import { allocateCredit, type Allocation, type Credit, type CreditRequirement, type Slot } from "./allocation";
import { clockOf, dateWords, shiftTimeWords } from "./clock";
import type { Filler } from "./rules";

export type CreditKind = "checkin" | "staff_checkin" | "outside";
/** One live credit as the rule reads it, with what the pages say about it. */
export type CreditRow = {
  id: string; kind: CreditKind; familyQboId: string; createdAt: Date; minutes: number; shifts: number;
  /** Outside credit: the requirement it counts toward, and the student when it is one student's. */
  requirementId: string | null; studentQboId: string | null;
  /** A check-in: its sign-up, shift and who filled the place. */
  signupId: string | null; shiftId: string | null; filler: Filler | null; fillerName: string | null; fillerParentId: string | null;
};
/** A volunteer requirement the family's credit can count toward, with its title and who it is asked of. */
export type CreditRequirementRow = CreditRequirement & { title: string; covers: Requirement["covers"]; coveredQboIds: string[]; seasonId: string };
export type FamilyCredit = { familyQboId: string; credits: CreditRow[]; requirements: CreditRequirementRow[]; slots: Slot[]; allocation: Allocation };

/** The live (not removed) credit of these families, in the order it was earned; null is every family, for staff. */
async function liveCredits(familyQboIds: readonly string[] | null, tx?: Tx): Promise<CreditRow[]> {
  if (familyQboIds?.length === 0) return [];
  const rows = await (tx ?? db).select({ c: volunteerCredit, s: volunteerSignup }).from(volunteerCredit)
    .leftJoin(volunteerSignup, eq(volunteerSignup.id, volunteerCredit.signupId))
    .where(and(isNull(volunteerCredit.removedAt), familyQboIds ? inArray(volunteerCredit.familyQboId, [...familyQboIds]) : undefined))
    .orderBy(asc(volunteerCredit.createdAt), asc(volunteerCredit.id));
  return rows.map(({ c, s }) => ({
    id: c.id, kind: c.kind, familyQboId: c.familyQboId, createdAt: c.createdAt, minutes: c.minutes, shifts: c.shifts, requirementId: c.requirementId, studentQboId: c.studentQboId,
    signupId: c.signupId, shiftId: s?.shiftId ?? null, fillerName: s?.fillerName ?? null, fillerParentId: s?.fillerParentId ?? null,
    filler: s ? (s.fillerKind === "student" && s.studentQboId ? { kind: "student", studentQboId: s.studentQboId } : { kind: "guardian" }) : null,
  }));
}

/**
 * These families' credit and how the rule spends it (src/lib/volunteer/allocation.ts), by family: every volunteer
 * requirement any of their credit can count toward, plus `alsoRequirementIds` (the ones a page asks about), each for
 * the family or for each of its active students it is asked of. A family with no live credit is left out. Only the
 * families asked about, their own students and their own entries of each chosen list are read.
 */
export async function allocateFamilies(familyQboIds: readonly string[] | null, alsoRequirementIds: readonly string[] = [], tx?: Tx): Promise<Map<string, FamilyCredit>> {
  const out = new Map<string, FamilyCredit>();
  const credits = await liveCredits(familyQboIds, tx);
  if (credits.length === 0) return out;
  const q = tx ?? db;
  const families = [...new Set(credits.map((c) => c.familyQboId))];
  const shiftIds = [...new Set(credits.flatMap((c) => (c.shiftId ? [c.shiftId] : [])))];
  const links = shiftIds.length === 0 ? [] : await q.select().from(volunteerShiftRequirement).where(inArray(volunteerShiftRequirement.shiftId, shiftIds));
  const requirementIds = [...new Set([...links.map((l) => l.requirementId), ...credits.flatMap((c) => (c.requirementId ? [c.requirementId] : [])), ...alsoRequirementIds])];
  const rows = requirementIds.length === 0 ? [] : await q.select({ r: requirement, position: seasonStep.position, seasonId: season.id, seasonCreated: season.createdAt })
    .from(requirement).innerJoin(seasonStep, eq(seasonStep.id, requirement.stepId)).innerJoin(season, eq(season.id, seasonStep.seasonId))
    .where(and(inArray(requirement.id, requirementIds), eq(requirement.kind, "volunteer")))
    .orderBy(asc(season.createdAt), asc(seasonStep.position), asc(requirement.position), asc(requirement.createdAt));
  // The family's own active students, directly under it: a student who has moved takes no slot here, so their past
  // check-ins stay with this family and count toward its per-family requirements alone.
  const students = await q.select({ qboId: qboCustomer.qboId, parentQboId: qboCustomer.parentQboId }).from(qboCustomer)
    .where(and(inArray(qboCustomer.parentQboId, families), eq(qboCustomer.active, true)));
  const subjects = [...families, ...students.map((s) => s.qboId)];
  const chosen = rows.filter((x) => x.r.covers === "chosen").map((x) => x.r.id);
  const covers = chosen.length === 0 ? [] : await q.select({ requirementId: requirementCover.requirementId, subjectQboId: requirementCover.subjectQboId }).from(requirementCover)
    .where(and(inArray(requirementCover.requirementId, chosen), inArray(requirementCover.subjectQboId, subjects)));
  const requirements: CreditRequirementRow[] = rows.map((x, i) => ({
    id: x.r.id, title: x.r.title, required: x.r.required, appliesTo: x.r.appliesTo, amount: x.r.amount, amountUnit: x.r.amountUnit, dueOn: x.r.dueOn, order: i,
    covers: x.r.covers, coveredQboIds: covers.filter((c) => c.requirementId === x.r.id).map((c) => c.subjectQboId), seasonId: x.seasonId,
  }));
  // A requirement staff waived for the family or a student needs nothing, so it takes no credit and what it would have
  // taken flows on to the others, as a buy-out's does (allocation.ts). Only when it was waived is read, never why.
  const waived = requirements.length === 0 ? [] : await q.select({ requirementId: requirementProgress.requirementId, subjectQboId: requirementProgress.subjectQboId })
    .from(requirementProgress).where(and(inArray(requirementProgress.requirementId, requirements.map((r) => r.id)), inArray(requirementProgress.subjectQboId, subjects), isNotNull(requirementProgress.waivedAt)));
  const asked = (r: CreditRequirementRow, subject: string) => (r.covers === "everyone" || r.coveredQboIds.includes(subject))
    && !waived.some((w) => w.requirementId === r.id && w.subjectQboId === subject);
  for (const family of families) {
    const theirs = students.filter((s) => s.parentQboId === family).map((s) => s.qboId);
    const slots: Slot[] = requirements.flatMap((r) => (r.appliesTo === "family" ? (asked(r, family) ? [{ requirement: r, subjectQboId: family }] : [])
      : theirs.filter((s) => asked(r, s)).map((s) => ({ requirement: r, subjectQboId: s }))));
    const own = credits.filter((c) => c.familyQboId === family);
    const rule: Credit[] = own.map((c) => ({ id: c.id, minutes: c.minutes, shifts: c.shifts,
      source: c.kind === "outside" ? { kind: "outside", requirementId: c.requirementId!, subjectQboId: c.studentQboId ?? c.familyQboId }
        : { kind: "shift", requirementIds: links.filter((l) => l.shiftId === c.shiftId).map((l) => l.requirementId), filler: c.filler ?? { kind: "guardian" } } }));
    out.set(family, { familyQboId: family, credits: own, requirements, slots, allocation: allocateCredit(family, slots, rule) });
  }
  return out;
}

/**
 * How much confirmed credit each family or student has toward each of these volunteer requirements, in the
 * requirement's unit, keyed by `pairKey` (src/lib/seasons/kinds.ts passes its own in). With `subjectQboIds` (a
 * parent's own family and students) only that family's credit is read; null is everyone, for staff.
 */
export async function confirmedAmounts(requirements: readonly Requirement[], subjectQboIds: readonly string[] | null, pairKey: (requirementId: string, subjectQboId: string) => string): Promise<Map<string, number>> {
  const amounts = new Map<string, number>();
  if (requirements.length === 0 || subjectQboIds?.length === 0) return amounts;
  const wanted = new Set(requirements.map((r) => r.id)), asked = subjectQboIds ? new Set(subjectQboIds) : null;
  for (const family of (await allocateFamilies(subjectQboIds, [...wanted])).values()) {
    for (const slot of family.slots) {
      if (!wanted.has(slot.requirement.id) || (asked && !asked.has(slot.subjectQboId))) continue;
      amounts.set(pairKey(slot.requirement.id, slot.subjectQboId), family.allocation.filled.get(`${slot.requirement.id}|${slot.subjectQboId}`) ?? 0);
    }
  }
  return amounts;
}

/** Of these sign-ups, the ones holding a live credit: a sign-up checked in is no longer "signed up for", it is done. */
export async function creditedSignups(signupIds: readonly string[], tx?: Tx): Promise<Set<string>> {
  if (signupIds.length === 0) return new Set();
  const rows = await (tx ?? db).select({ signupId: volunteerCredit.signupId }).from(volunteerCredit)
    .where(and(inArray(volunteerCredit.signupId, [...signupIds]), isNull(volunteerCredit.removedAt)));
  return new Set(rows.flatMap((r) => (r.signupId ? [r.signupId] : [])));
}

/* ---- What a parent sees of the family's own credit ---- */

/** One credit as a parent reads it: "Checked in", or "Added by the club" with its amount. Never a staff note. */
export type MyCredit =
  | { id: string; kind: "checkin"; words: "Checked in"; event: string; when: string; who: string }
  | { id: string; kind: "outside"; words: "Added by the club"; amount: string; toward: string; who: string };

/**
 * The family's own live credit, newest first, in a parent's words: each check-in (by the guardian or added by staff,
 * which a parent reads alike) and each credit for volunteering done outside the portal. `students` are the family's
 * own, as loadMyFamily() gave them, for the names; `parentId` is the guardian looking, who reads "You".
 */
export async function loadMyCredit(ctx: { familyQboId: string; parentId: string }, students: readonly { qboId: string; name: string }[]): Promise<MyCredit[]> {
  const rows = await db.select({ c: volunteerCredit, s: volunteerSignup, shift: volunteerShift, event: volunteerEvent, title: requirement.title, unit: requirement.amountUnit })
    .from(volunteerCredit)
    .leftJoin(volunteerSignup, eq(volunteerSignup.id, volunteerCredit.signupId))
    .leftJoin(volunteerShift, eq(volunteerShift.id, volunteerSignup.shiftId))
    .leftJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
    .leftJoin(requirement, eq(requirement.id, volunteerCredit.requirementId))
    .where(and(eq(volunteerCredit.familyQboId, ctx.familyQboId), isNull(volunteerCredit.removedAt)))
    .orderBy(asc(volunteerCredit.createdAt), asc(volunteerCredit.id));
  const nameOf = (qboId: string | null) => students.find((s) => s.qboId === qboId)?.name ?? null;
  return rows.flatMap(({ c, s, shift, event, title, unit }): MyCredit[] => {
    if (c.kind !== "outside") {
      if (!s || !shift || !event) return [];
      const who = s.fillerKind === "guardian" && s.fillerParentId === ctx.parentId ? "You" : s.fillerName;
      return [{ id: c.id, kind: "checkin", words: "Checked in", event: `${event.name}${shift.role ? `, ${shift.role}` : ""}`, when: `${dateWords(event.onDate)}, ${shiftTimeWords(clockOf(shift.startsAt), clockOf(shift.endsAt))}`, who }];
    }
    if (!title) return [];
    return [{ id: c.id, kind: "outside", words: "Added by the club", amount: creditAmountWords(unit, c), toward: title, who: c.studentQboId ? nameOf(c.studentQboId) ?? "A student" : "Your family" }];
  }).reverse();
}

/** An outside credit's amount in its requirement's unit: "2 shifts", "1.5 hours". */
export function creditAmountWords(unit: Requirement["amountUnit"], c: { minutes: number; shifts: number }): string {
  if (unit === "hours") { const h = Math.round((c.minutes / 60) * 100) / 100; return `${h} ${h === 1 ? "hour" : "hours"}`; }
  return `${c.shifts} ${c.shifts === 1 ? "shift" : "shifts"}`;
}
