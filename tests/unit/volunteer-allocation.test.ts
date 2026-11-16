import { describe, it, expect } from "vitest";
import { allocateCredit, compareSlots, slotKey, type Credit, type CreditRequirement, type Slot } from "@/lib/volunteer/allocation";

/**
 * How credit fills a family's volunteer requirements (v1 spec §11.4), as the pure rule src/lib/volunteer/allocation.ts
 * states it: required before optional, per student before per family, then the earliest due date, then the season's
 * order; credits in the order they were earned, each spent once, shifts whole and hours by the minute.
 */
const FAM = "FAM", S1 = "S1", S2 = "S2";
const req = (id: string, o: Partial<CreditRequirement> = {}): CreditRequirement => ({ id, required: true, appliesTo: "family", amount: 2, amountUnit: "shifts", dueOn: null, order: 0, ...o });
const slot = (r: CreditRequirement, subjectQboId = r.appliesTo === "family" ? FAM : S1): Slot => ({ requirement: r, subjectQboId });
let n = 0;
/** A check-in: a shift of `minutes` linked to these requirements, filled by the guardian or a student. */
const checkIn = (requirementIds: string[], minutes = 180, student?: string): Credit =>
  ({ id: `c${++n}`, minutes, shifts: 1, source: { kind: "shift", requirementIds, filler: student ? { kind: "student", studentQboId: student } : { kind: "guardian" } } });
const outside = (requirementId: string, subjectQboId: string, amount: { minutes?: number; shifts?: number }): Credit =>
  ({ id: `o${++n}`, minutes: amount.minutes ?? 0, shifts: amount.shifts ?? 0, source: { kind: "outside", requirementId, subjectQboId } });
const filled = (a: ReturnType<typeof allocateCredit>, r: CreditRequirement, subject = r.appliesTo === "family" ? FAM : S1) => a.filled.get(slotKey(r.id, subject));

describe("the order requirements are filled in", () => {
  it("puts required before optional, per student before per family, then the earliest due date, none last, then the season's order", () => {
    const optionalStudent = req("a", { required: false, appliesTo: "student" });
    const requiredFamilyLate = req("b", { dueOn: "2027-05-01" });
    const requiredFamilyNoDate = req("c", { order: 0 });
    const requiredFamilySoon = req("d", { dueOn: "2027-03-01", order: 9 });
    const requiredStudent = req("e", { appliesTo: "student", order: 5 });
    const requiredFamilyNoDateLater = req("f", { order: 3 });
    const sorted = [optionalStudent, requiredFamilyLate, requiredFamilyNoDate, requiredFamilySoon, requiredStudent, requiredFamilyNoDateLater].map((r) => slot(r)).sort(compareSlots);
    expect(sorted.map((s) => s.requirement.id)).toEqual(["e", "d", "b", "c", "f", "a"]);
  });
});

describe("how credit fills requirements", () => {
  it("fills a required requirement before an optional one, and lets what is left flow on to the optional one", () => {
    const optional = req("opt", { required: false, order: 0 }), required = req("req", { order: 1 });
    const credits = [checkIn(["opt", "req"]), checkIn(["opt", "req"]), checkIn(["opt", "req"])];
    const a = allocateCredit(FAM, [slot(optional), slot(required)], credits);
    expect(filled(a, required)).toBe(2);
    expect(filled(a, optional)).toBe(1);
    // In the order earned: the first two go to the required one.
    expect(a.given.filter((g) => g.requirementId === "req").map((g) => g.creditId)).toEqual([credits[0]!.id, credits[1]!.id]);
  });

  it("fills a student's own requirement before the family's, since only that student can meet it", () => {
    const family = req("fam", { amount: 1, order: 0 }), own = req("own", { appliesTo: "student", amount: 1, order: 1 });
    const leo = checkIn(["fam", "own"], 180, S1);
    const a = allocateCredit(FAM, [slot(family), slot(own, S1)], [leo]);
    expect(filled(a, own, S1)).toBe(1);
    expect(filled(a, family)).toBe(0);
    // A guardian's shift can't count toward a student's own requirement, so it goes to the family's.
    const b = allocateCredit(FAM, [slot(family), slot(own, S1)], [checkIn(["fam", "own"]), leo]);
    expect(filled(b, own, S1)).toBe(1);
    expect(filled(b, family)).toBe(1);
    // Nor does one student's shift count toward another student's.
    const c = allocateCredit(FAM, [slot(own, S2)], [checkIn(["own"], 180, S1)]);
    expect(filled(c, own, S2)).toBe(0);
  });

  it("gives a requirement counted in shifts whole credits, one shift each, and one counted in hours the minutes", () => {
    const shifts = req("shifts", { amount: 2, amountUnit: "shifts" });
    const hours = req("hours", { amount: 4, amountUnit: "hours", required: true, order: 1 });
    const credits = [checkIn(["shifts", "hours"], 90), checkIn(["shifts", "hours"], 300), checkIn(["shifts", "hours"], 240)];
    const a = allocateCredit(FAM, [slot(shifts), slot(hours)], credits);
    // The first two shifts are given whole to the shifts requirement, however short; the third gives its four hours.
    expect(filled(a, shifts)).toBe(2);
    expect(filled(a, hours)).toBe(4);
    expect(a.given).toEqual([
      { creditId: credits[0]!.id, requirementId: "shifts", subjectQboId: FAM, minutes: 0, shifts: 1 },
      { creditId: credits[1]!.id, requirementId: "shifts", subjectQboId: FAM, minutes: 0, shifts: 1 },
      { creditId: credits[2]!.id, requirementId: "hours", subjectQboId: FAM, minutes: 240, shifts: 0 },
    ]);
    // A check-in given as a shift is spent whole, minutes and all.
    expect(a.left.get(credits[1]!.id)).toEqual({ minutes: 0, shifts: 0 });
  });

  it("splits a credit when a requirement counted in hours needs only part of it, and a split credit is never a whole shift", () => {
    const hours = req("hours", { amount: 1, amountUnit: "hours", order: 0 });
    const more = req("more", { amount: 5, amountUnit: "hours", order: 1 });
    const shifts = req("shifts", { amount: 1, amountUnit: "shifts", required: false });
    const three = checkIn(["hours", "more", "shifts"], 180);
    const a = allocateCredit(FAM, [slot(hours), slot(more), slot(shifts)], [three]);
    expect(filled(a, hours)).toBe(1);
    expect(filled(a, more)).toBe(2);
    expect(filled(a, shifts)).toBe(0);
    expect(a.left.get(three.id)).toEqual({ minutes: 0, shifts: 0 });
    // With minutes left over, a split credit still can't be given as a shift.
    const b = allocateCredit(FAM, [slot(hours), slot(shifts)], [three]);
    expect(filled(b, hours)).toBe(1);
    expect(filled(b, shifts)).toBe(0);
    expect(b.left.get(three.id)).toEqual({ minutes: 120, shifts: 0 });
  });

  it("gives nothing beyond what a requirement needs, and leaves what nothing can take", () => {
    const two = req("two", { amount: 2 });
    const credits = [checkIn(["two"]), checkIn(["two"]), checkIn(["two"])];
    const a = allocateCredit(FAM, [slot(two)], credits);
    expect(filled(a, two)).toBe(2);
    expect(a.left.get(credits[2]!.id)).toEqual({ minutes: 180, shifts: 1 });
    const hours = req("h", { amount: 2, amountUnit: "hours" });
    const b = allocateCredit(FAM, [slot(hours)], [checkIn(["h"], 300)]);
    expect(filled(b, hours)).toBe(2);
    expect(b.given.reduce((sum, g) => sum + g.minutes, 0)).toBe(120);
  });

  it("spends a shift linked to two requirements once: it counts toward one of them, never both", () => {
    const first = req("first", { amount: 1, order: 0 }), second = req("second", { amount: 1, order: 1 });
    const one = checkIn(["first", "second"]);
    const a = allocateCredit(FAM, [slot(first), slot(second)], [one]);
    expect(filled(a, first)).toBe(1);
    expect(filled(a, second)).toBe(0);
    expect(a.given).toHaveLength(1);
    // Two requirements in hours share its minutes, no more than it has.
    const h1 = req("h1", { amount: 2, amountUnit: "hours", order: 0 }), h2 = req("h2", { amount: 2, amountUnit: "hours", order: 1 });
    const b = allocateCredit(FAM, [slot(h1), slot(h2)], [checkIn(["h1", "h2"], 180)]);
    expect(filled(b, h1)).toBe(2);
    expect(filled(b, h2)).toBe(1);
  });

  it("counts a shift only toward the requirements it is linked to", () => {
    const linked = req("linked", { amount: 1 }), other = req("other", { amount: 1, order: -1 });
    const a = allocateCredit(FAM, [slot(linked), slot(other)], [checkIn(["linked"])]);
    expect(filled(a, linked)).toBe(1);
    expect(filled(a, other)).toBe(0);
  });

  it("counts an outside credit only toward its one requirement, for its family or student, in that requirement's unit", () => {
    const hours = req("hours", { amount: 6, amountUnit: "hours" }), other = req("other", { amount: 6, amountUnit: "hours", order: -1 });
    const own = req("own", { appliesTo: "student", amount: 2 });
    const credits = [outside("hours", FAM, { minutes: 240 }), outside("own", S1, { shifts: 3 }), outside("own", S2, { shifts: 1 })];
    const a = allocateCredit(FAM, [slot(hours), slot(other), slot(own, S1), slot(own, S2)], credits);
    expect(filled(a, hours)).toBe(4);
    expect(filled(a, other)).toBe(0);
    expect(filled(a, own, S1)).toBe(2);
    expect(filled(a, own, S2)).toBe(1);
    expect(a.left.get(credits[1]!.id)).toEqual({ minutes: 0, shifts: 1 });
  });

  it("counts nothing for a check-in staff removed: the caller leaves it out, and the next credit takes its place", () => {
    const two = req("two", { amount: 2 });
    const credits = [checkIn(["two"]), checkIn(["two"]), checkIn(["two"])];
    const all = allocateCredit(FAM, [slot(two)], credits);
    expect(all.given.map((g) => g.creditId)).toEqual([credits[0]!.id, credits[1]!.id]);
    const removed = allocateCredit(FAM, [slot(two)], credits.filter((c) => c.id !== credits[0]!.id));
    expect(filled(removed, two)).toBe(2);
    expect(removed.given.map((g) => g.creditId)).toEqual([credits[1]!.id, credits[2]!.id]);
    expect(filled(allocateCredit(FAM, [slot(two)], [credits[1]!]), two)).toBe(1);
  });

  it("asks nothing of a requirement with no amount, and fills nothing with no credit", () => {
    const none = req("none", { amount: null }), two = req("two");
    const a = allocateCredit(FAM, [slot(none), slot(two)], [checkIn(["none", "two"])]);
    expect(filled(a, none)).toBe(0);
    expect(filled(a, two)).toBe(1);
    expect(filled(allocateCredit(FAM, [slot(two)], []), two)).toBe(0);
  });
});
