/**
 * How confirmed volunteer credit fills a family's volunteer requirements (v1 spec §11.4), as one pure function. Nothing
 * here reads the database or the clock: src/lib/volunteer/credit.ts loads the family's credit and the requirements it
 * can count toward, and the volunteer entry of src/lib/seasons/kinds.ts reads what this gives, for the parent pages and
 * the staff pages alike.
 *
 * The rule, for one family:
 *  - Requirements are filled in order: required before optional; at each level, per-student before per-family (a
 *    student's own requirement can only be met by that student, while anyone's credit can meet the family's); then the
 *    earliest due date, none last; then the season's own order.
 *  - Credits are spent in the order they were earned. A credit counts only toward requirements it can count toward: a
 *    check-in toward the requirements its shift is linked to whose filler rule it meets (countsFor()), and volunteering
 *    done outside the portal toward its one requirement.
 *  - A requirement counted in shifts takes whole credits, one shift each, never part of one. A requirement counted in
 *    hours takes minutes, splitting a credit when it needs only part of it, from credits not already given as a shift.
 *  - Nothing goes beyond what a requirement needs; what is left flows on to the next, optional ones included. Each
 *    credit is spent once in total, never counted twice.
 *
 * Buy-outs (§11.5, src/lib/buyouts/) leave this rule as it is: credit is spent on a bought-out requirement as on any
 * other, and the requirement is met when credit reaches its amount or its buy-out is paid (withBuyout() in
 * src/lib/buyouts/rules.ts). A buy-out's price was fixed when it was chosen; credit earned later does not lower it.
 */
import type { Requirement } from "@/lib/seasons/progress";
import { countsFor, type Filler } from "./rules";

/** A volunteer requirement as the rule orders it. `order` is its place in its season (steps, then requirements), lower first. */
export type CreditRequirement = Pick<Requirement, "id" | "required" | "appliesTo" | "amount" | "amountUnit" | "dueOn"> & { order: number };
/** One requirement for one family (per family) or one student (per student) of that family. */
export type Slot = { requirement: CreditRequirement; subjectQboId: string };

/** Where a credit came from, as far as it decides what the credit can count toward. */
export type CreditSource =
  /** A check-in, by the guardian or added by staff: the requirements its shift counts toward, and who filled the place. */
  | { kind: "shift"; requirementIds: readonly string[]; filler: Filler }
  /** Volunteering done outside the portal, credited by staff toward one requirement, for the family or one student. */
  | { kind: "outside"; requirementId: string; subjectQboId: string };

/** One credit. A check-in is worth its shift's length in minutes or one shift; an outside credit is in its requirement's unit. */
export type Credit = { id: string; minutes: number; shifts: number; source: CreditSource };

/** Part of a credit given to one requirement for one family or student: minutes toward one counted in hours, or shifts. */
export type Given = { creditId: string; requirementId: string; subjectQboId: string; minutes: number; shifts: number };

export type Allocation = {
  given: Given[];
  /** How much each slot has, in its requirement's unit (shifts, or hours), by `${requirementId}|${subjectQboId}`. */
  filled: Map<string, number>;
  /** What is left of each credit, given to nothing. */
  left: Map<string, { minutes: number; shifts: number }>;
};

export const slotKey = (requirementId: string, subjectQboId: string) => `${requirementId}|${subjectQboId}`;

/** The order slots are filled in: required first, then per-student before per-family, then earliest due date (none last), then the season's order. */
export function compareSlots(a: Slot, b: Slot): number {
  const x = a.requirement, y = b.requirement;
  if (x.required !== y.required) return x.required ? -1 : 1;
  if (x.appliesTo !== y.appliesTo) return x.appliesTo === "student" ? -1 : 1;
  if (x.dueOn !== y.dueOn) return x.dueOn === null ? 1 : y.dueOn === null ? -1 : x.dueOn < y.dueOn ? -1 : 1;
  if (x.order !== y.order) return x.order - y.order;
  return a.subjectQboId < b.subjectQboId ? -1 : a.subjectQboId > b.subjectQboId ? 1 : 0;
}

/** Whether a credit can count toward this requirement for this family or student. */
export function canCountToward(credit: Credit, slot: Slot, familyQboId: string): boolean {
  const s = credit.source;
  if (s.kind === "outside") return s.requirementId === slot.requirement.id && s.subjectQboId === slot.subjectQboId;
  return s.requirementIds.includes(slot.requirement.id) && countsFor(slot.requirement, s.filler, familyQboId, slot.subjectQboId);
}

/**
 * Spends one family's credits on its requirements by the rule above. `credits` are in the order they were earned;
 * `slots` in any order (they are sorted here). A removed credit is not passed in.
 */
export function allocateCredit(familyQboId: string, slots: readonly Slot[], credits: readonly Credit[]): Allocation {
  const state = credits.map((c) => ({ credit: c, minutes: c.minutes, shifts: c.shifts, asMinutes: false, asShift: false }));
  const given: Given[] = [];
  const filled = new Map<string, number>();
  for (const slot of [...slots].sort(compareSlots)) {
    const r = slot.requirement;
    const amount = r.amount ?? 0;
    let have = 0;
    if (amount > 0) {
      for (const c of state) {
        if (!canCountToward(c.credit, slot, familyQboId)) continue;
        if (r.amountUnit === "hours") {
          const need = amount * 60 - have;
          if (need <= 0) break;
          // Minutes only from a credit not already given, whole, as a shift.
          if (c.asShift || c.minutes <= 0) continue;
          const take = Math.min(c.minutes, need);
          c.minutes -= take; c.asMinutes = true;
          // A credit split into minutes can't be a whole shift any more.
          c.shifts = 0;
          have += take;
          given.push({ creditId: c.credit.id, requirementId: r.id, subjectQboId: slot.subjectQboId, minutes: take, shifts: 0 });
        } else {
          const need = amount - have;
          if (need <= 0) break;
          // Whole credits only: one that has given minutes to a requirement counted in hours is no longer whole.
          if (c.asMinutes || c.shifts <= 0) continue;
          const take = Math.min(c.shifts, need);
          c.shifts -= take; c.asShift = true;
          // A check-in given as a shift is spent: its minutes go with it.
          if (c.credit.source.kind === "shift") c.minutes = 0;
          have += take;
          given.push({ creditId: c.credit.id, requirementId: r.id, subjectQboId: slot.subjectQboId, minutes: 0, shifts: take });
        }
      }
    }
    filled.set(slotKey(r.id, slot.subjectQboId), r.amountUnit === "hours" ? have / 60 : have);
  }
  return { given, filled, left: new Map(state.map((c) => [c.credit.id, { minutes: c.minutes, shifts: c.shifts }])) };
}
