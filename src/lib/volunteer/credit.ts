// Confirmed volunteer credit, read and spent on requirements (v1 spec §11.4): the part of the volunteer kind's rule
// (src/lib/seasons/kinds.ts) that reads the database, and what a parent's Volunteer page shows of the family's own
// credit. Parent pages reach it with the session's family alone: every query here takes the families it is asked
// about and reads nothing else, and nothing a staff member wrote (a note, a reason) is read here: the staff pages read
// those through ./staff-credit.ts. Families and students are the app's own records (stage 2 of the app-owned families
// spec), as the season's chosen lists and waivers are. It imports no staff-only module (tests/integration/page-guards.test.ts scans this file).
import "server-only";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { requirement, season, seasonStep, student, volunteerCredit, volunteerEvent, volunteerShift, volunteerShiftRequirement, volunteerSignup } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { sessionFamily } from "@/lib/families/session-family";
import { isCovered, type Requirement, type RequirementFields, type SubjectId, type SubjectsAsked } from "@/lib/seasons/progress";
import { loadCovers, loadRecorded } from "@/lib/seasons/season-rows";
import { allocateCredit, slotKey, type Allocation, type Credit, type CreditRequirement, type Slot } from "./allocation";
import { buyoutsByRecord } from "./bought";
import { clockOf, dateWords, shiftTimeWords } from "./clock";
import type { Filler } from "./rules";

export type CreditKind = "checkin" | "staff_checkin" | "outside";
/** One live credit as the rule reads it, with what the pages say about it. Families and students are the app's own records. */
export type CreditRow = {
  id: string; kind: CreditKind; familyId: AppFamilyId; createdAt: Date; minutes: number; shifts: number;
  /** Outside credit: the requirement it counts toward, and the student when it is one student's. */
  requirementId: string | null; studentId: AppStudentId | null;
  /** A check-in: its sign-up, shift and who filled the place. */
  signupId: string | null; shiftId: string | null; filler: Filler | null; fillerName: string | null; fillerParentId: string | null;
};
/** A volunteer requirement the family's credit can count toward, with its title and who it is asked of. */
export type CreditRequirementRow = CreditRequirement & { title: string; covers: Requirement["covers"]; coveredIds: SubjectId[]; seasonId: string };
export type FamilyCredit = { familyId: AppFamilyId; credits: CreditRow[]; requirements: CreditRequirementRow[]; slots: Slot[]; allocation: Allocation };

/** The live (not removed) credit of these families, in the order it was earned; null is every family, for staff. */
async function liveCredits(familyIds: readonly AppFamilyId[] | null, tx?: Tx): Promise<CreditRow[]> {
  if (familyIds?.length === 0) return [];
  const rows = await (tx ?? db).select({ c: volunteerCredit, s: volunteerSignup }).from(volunteerCredit)
    .leftJoin(volunteerSignup, eq(volunteerSignup.id, volunteerCredit.signupId))
    .where(and(isNull(volunteerCredit.removedAt), familyIds ? inArray(volunteerCredit.familyId, [...familyIds]) : undefined))
    .orderBy(asc(volunteerCredit.createdAt), asc(volunteerCredit.id));
  return rows.map(({ c, s }) => ({
    id: c.id, kind: c.kind, familyId: c.familyId, createdAt: c.createdAt, minutes: c.minutes, shifts: c.shifts, requirementId: c.requirementId, studentId: c.studentId,
    signupId: c.signupId, shiftId: s?.shiftId ?? null, fillerName: s?.fillerName ?? null, fillerParentId: s?.fillerParentId ?? null,
    filler: s ? (s.fillerKind === "student" && s.studentId ? { kind: "student", studentId: s.studentId } : { kind: "guardian" }) : null,
  }));
}

/**
 * These families' credit and how the rule spends it (src/lib/volunteer/allocation.ts), by family (keyed by the app
 * family's id as text): every volunteer requirement any of their credit can count toward, plus `alsoRequirementIds`
 * (the ones a page asks about), each for the family or for each of its active students it is asked of. A family with
 * no live credit is left out. Only the families asked about, their own students and their own entries of each chosen
 * list are read; null is every family with credit, for staff.
 */
export async function allocateFamilies(familyIds: readonly AppFamilyId[] | null, alsoRequirementIds: readonly string[] = [], tx?: Tx): Promise<Map<string, FamilyCredit>> {
  const out = new Map<string, FamilyCredit>();
  const credits = await liveCredits(familyIds, tx);
  if (credits.length === 0) return out;
  const q = tx ?? db;
  const families = [...new Map(credits.map((c) => [String(c.familyId), c.familyId])).values()];
  const shiftIds = [...new Set(credits.flatMap((c) => (c.shiftId ? [c.shiftId] : [])))];
  const links = shiftIds.length === 0 ? [] : await q.select().from(volunteerShiftRequirement).where(inArray(volunteerShiftRequirement.shiftId, shiftIds));
  const requirementIds = [...new Set([...links.map((l) => l.requirementId), ...credits.flatMap((c) => (c.requirementId ? [c.requirementId] : [])), ...alsoRequirementIds])];
  const rows = requirementIds.length === 0 ? [] : await q.select({ r: requirement, position: seasonStep.position, seasonId: season.id, seasonCreated: season.createdAt })
    .from(requirement).innerJoin(seasonStep, eq(seasonStep.id, requirement.stepId)).innerJoin(season, eq(season.id, seasonStep.seasonId))
    .where(and(inArray(requirement.id, requirementIds), eq(requirement.kind, "volunteer")))
    .orderBy(asc(season.createdAt), asc(seasonStep.position), asc(requirement.position), asc(requirement.createdAt));
  // The family's own active students, in it now (the app's own records, kept in step with the roster): a student who
  // has moved takes no slot here, so their past check-ins stay with this family and count toward its per-family
  // requirements alone.
  const students = await q.select({ id: student.id, familyId: student.familyId }).from(student)
    .where(and(inArray(student.familyId, families), eq(student.active, true)));
  const asked: SubjectsAsked = { families, students: students.map((s) => s.id) };
  const chosen = rows.filter((x) => x.r.covers === "chosen").map((x) => x.r.id);
  // Only these families' own entries of each chosen list.
  const covers = await loadCovers(chosen, asked, tx);
  const requirements: CreditRequirementRow[] = rows.map((x, i) => ({
    id: x.r.id, title: x.r.title, required: x.r.required, appliesTo: x.r.appliesTo, amount: x.r.amount, amountUnit: x.r.amountUnit, dueOn: x.r.dueOn, order: i,
    covers: x.r.covers, coveredIds: covers.get(x.r.id) ?? [], seasonId: x.seasonId,
  }));
  // A requirement staff waived for the family or a student needs nothing, so it takes no credit and what it would have
  // taken flows on to the others. Only when it was waived is read, never why. So does one whose buy-out is paid
  // (v1 spec §11.4: never beyond the amount needed; allocation.ts), read by the same records (./bought.ts).
  const waived = new Set((await loadRecorded(requirements.map((r) => r.id), asked, tx)).filter((w) => w.waivedAt !== null).map((w) => slotKey(w.requirementId, w.subjectId)));
  const bought = await buyoutsByRecord(requirements, asked, slotKey, tx);
  const paidFor = (key: string) => { const f = bought.get(key); return Boolean(f && (f.state === "paid" || f.invoicePaid)); };
  const askedOf = (r: CreditRequirementRow, subject: SubjectId) => isCovered(r, subject) && !waived.has(slotKey(r.id, subject)) && !paidFor(slotKey(r.id, subject));
  for (const family of families) {
    const theirs = students.filter((s) => s.familyId === family).map((s) => s.id);
    const slots: Slot[] = requirements.flatMap((r): Slot[] => (r.appliesTo === "family" ? (askedOf(r, family) ? [{ requirement: r, subjectId: family }] : [])
      : theirs.filter((s) => askedOf(r, s)).map((s) => ({ requirement: r, subjectId: s }))));
    const own = credits.filter((c) => c.familyId === family);
    const rule: Credit[] = own.map((c) => ({ id: c.id, minutes: c.minutes, shifts: c.shifts,
      source: c.kind === "outside" ? { kind: "outside", requirementId: c.requirementId!, subjectId: c.studentId ?? c.familyId }
        : { kind: "shift", requirementIds: links.filter((l) => l.shiftId === c.shiftId).map((l) => l.requirementId), filler: c.filler ?? { kind: "guardian" } } }));
    out.set(String(family), { familyId: family, credits: own, requirements, slots, allocation: allocateCredit(family, slots, rule) });
  }
  return out;
}

/**
 * How much confirmed credit each family or student has toward each of these volunteer requirements, in the
 * requirement's unit, keyed by `pairKey` (src/lib/seasons/kinds.ts passes its own in). With `asked` (a parent's own
 * family and students) only that family's credit is read; null is everyone, for staff.
 */
export async function confirmedAmounts(requirements: readonly RequirementFields[], asked: SubjectsAsked | null, pairKey: (requirementId: string, subject: SubjectId) => string): Promise<Map<string, number>> {
  const amounts = new Map<string, number>();
  // Credit is always a family's: asked about no family, there is none to read.
  if (requirements.length === 0 || asked?.families.length === 0) return amounts;
  const wanted = new Set(requirements.map((r) => r.id)), subjects = asked ? new Set([...asked.families, ...asked.students].map(String)) : null;
  for (const family of (await allocateFamilies(asked ? asked.families : null, [...wanted])).values()) {
    for (const slot of family.slots) {
      if (!wanted.has(slot.requirement.id) || (subjects && !subjects.has(String(slot.subjectId)))) continue;
      amounts.set(pairKey(slot.requirement.id, slot.subjectId), family.allocation.filled.get(slotKey(slot.requirement.id, slot.subjectId)) ?? 0);
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

/**
 * Of these sign-ups, the ones that have ever had a credit, a removed one included. A check-in staff removed (a guardian
 * checked in who wasn't there, say) is the club's correction: the guardian can't undo it by pressing again. Staff add a
 * missed check-in themselves (addMissedCheckIn). No reason is read: it is for staff.
 */
export async function correctedSignups(signupIds: readonly string[], tx?: Tx): Promise<Set<string>> {
  if (signupIds.length === 0) return new Set();
  const rows = await (tx ?? db).select({ signupId: volunteerCredit.signupId }).from(volunteerCredit).where(inArray(volunteerCredit.signupId, [...signupIds]));
  return new Set(rows.flatMap((r) => (r.signupId ? [r.signupId] : [])));
}

/* ---- What a parent sees of the family's own credit ---- */

/** One credit as a parent reads it: "Checked in", or "Added by the club" with its amount. Never a staff note. */
export type MyCredit =
  | { id: string; kind: "checkin"; words: "Checked in"; event: string; when: string; who: string }
  | { id: string; kind: "outside"; words: "Added by the club"; amount: string; toward: string; who: string };

/**
 * The family's own live credit, newest first, in a parent's words: each check-in (by the guardian or added by staff,
 * which a parent reads alike) and each credit for volunteering done outside the portal. The family is the session's,
 * found as the app's own active family through its link (sessionFamily(), src/lib/families/session-family.ts), and
 * nothing at all is shown without one. `students` are the family's own, as loadMyFamily() gave them, for the names;
 * `parentId` is the guardian looking, who reads "You".
 */
export async function loadMyCredit(ctx: { familyQboId: string; parentId: string }, students: readonly { qboId: string; name: string }[]): Promise<MyCredit[]> {
  const mine = await sessionFamily(ctx.familyQboId, students);
  if (!mine) return [];
  const rows = await db.select({ c: volunteerCredit, s: volunteerSignup, shift: volunteerShift, event: volunteerEvent, title: requirement.title, unit: requirement.amountUnit })
    .from(volunteerCredit)
    .leftJoin(volunteerSignup, eq(volunteerSignup.id, volunteerCredit.signupId))
    .leftJoin(volunteerShift, eq(volunteerShift.id, volunteerSignup.shiftId))
    .leftJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
    .leftJoin(requirement, eq(requirement.id, volunteerCredit.requirementId))
    .where(and(eq(volunteerCredit.familyId, mine.familyId), isNull(volunteerCredit.removedAt)))
    .orderBy(asc(volunteerCredit.createdAt), asc(volunteerCredit.id));
  const nameOf = (id: AppStudentId) => mine.students.find((s) => s.id === id)?.name ?? null;
  return rows.flatMap(({ c, s, shift, event, title, unit }): MyCredit[] => {
    if (c.kind !== "outside") {
      if (!s || !shift || !event) return [];
      const who = s.fillerKind === "guardian" && s.fillerParentId === ctx.parentId ? "You" : s.fillerName;
      return [{ id: c.id, kind: "checkin", words: "Checked in", event: `${event.name}${shift.role ? `, ${shift.role}` : ""}`, when: `${dateWords(event.onDate)}, ${shiftTimeWords(clockOf(shift.startsAt), clockOf(shift.endsAt))}`, who }];
    }
    if (!title) return [];
    return [{ id: c.id, kind: "outside", words: "Added by the club", amount: creditAmountWords(unit, c), toward: title, who: c.studentId ? nameOf(c.studentId) ?? "A student" : "Your family" }];
  }).reverse();
}

/** An outside credit's amount in its requirement's unit: "2 shifts", "1.5 hours". */
export function creditAmountWords(unit: Requirement["amountUnit"], c: { minutes: number; shifts: number }): string {
  if (unit === "hours") { const h = Math.round((c.minutes / 60) * 100) / 100; return `${h} ${h === 1 ? "hour" : "hours"}`; }
  return `${c.shifts} ${c.shifts === 1 ? "shift" : "shifts"}`;
}
