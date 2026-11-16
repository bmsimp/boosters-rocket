import { describe, it, expect } from "vitest";
import {
  currentStepIndex, isCalendarDate, isCovered, lineFor, linesDone, linesLeft, seasonStanding, stepStanding, stepsOutOfOrder, subjectsOf,
  type Facts, type FamilyRoster, type Requirement, type Step,
} from "@/lib/seasons/progress";

/** The progress rules of v1 spec §10.3, with nothing but values: no database and no clock. */
let n = 0;
const req = (o: Partial<Requirement> = {}): Requirement => ({
  id: `r${++n}`, kind: "checklist", title: `Item ${n}`, required: true, appliesTo: "student", amount: null, amountUnit: null, dueOn: null,
  covers: "everyone", coveredQboIds: [], ...o,
});
const step = (name: string, requirements: Requirement[] = [], dates: { startsOn?: string; endsOn?: string } = {}): Step =>
  ({ id: `s-${name}`, name, startsOn: dates.startsOn ?? null, endsOn: dates.endsOn ?? null, requirements });
const FAMILY: FamilyRoster = { familyQboId: "FAM", students: [{ qboId: "LEO", name: "Leo" }, { qboId: "MAYA", name: "Maya" }] };
/** Facts from two plain lists of "requirement id|subject id". */
const facts = (met: string[] = [], waived: string[] = []): Facts => ({
  standing: (r, subject) => (met.includes(`${r.id}|${subject}`) ? { met: true, words: "Done" } : { met: false, words: "Not done yet" }),
  waived: (id, subject) => waived.includes(`${id}|${subject}`),
});
const TODAY = "2026-09-10";

describe("who a requirement is asked of", () => {
  it("covers everyone, or only the chosen list", () => {
    expect(isCovered(req(), "ANYONE")).toBe(true);
    const chosen = req({ covers: "chosen", coveredQboIds: ["LEO"] });
    expect(isCovered(chosen, "LEO")).toBe(true);
    expect(isCovered(chosen, "MAYA")).toBe(false);
    // A list left over from "chosen" means nothing once the requirement covers everyone.
    expect(isCovered(req({ covers: "everyone", coveredQboIds: ["LEO"] }), "MAYA")).toBe(true);
    expect(isCovered(req({ covers: "chosen", coveredQboIds: [] }), "LEO")).toBe(false);
  });

  it("tracks a per-family requirement once for the family and a per-student one for each active student", () => {
    expect(subjectsOf(req({ appliesTo: "family" }), FAMILY)).toEqual(["FAM"]);
    expect(subjectsOf(req({ appliesTo: "student" }), FAMILY)).toEqual(["LEO", "MAYA"]);
    expect(subjectsOf(req({ appliesTo: "student", covers: "chosen", coveredQboIds: ["MAYA", "SOMEONE-ELSE"] }), FAMILY)).toEqual(["MAYA"]);
    expect(subjectsOf(req({ appliesTo: "family", covers: "chosen", coveredQboIds: ["OTHER-FAM"] }), FAMILY)).toEqual([]);
    // A student's id on a per-family list, or a family's on a per-student one, covers nobody.
    expect(subjectsOf(req({ appliesTo: "family", covers: "chosen", coveredQboIds: ["LEO"] }), FAMILY)).toEqual([]);
    expect(subjectsOf(req({ appliesTo: "student", covers: "chosen", coveredQboIds: ["FAM"] }), FAMILY)).toEqual([]);
    expect(subjectsOf(req({ appliesTo: "student" }), { familyQboId: "FAM", students: [] })).toEqual([]);
  });
});

describe("how one requirement stands", () => {
  it("says Done, Waived or Not done yet, and shows the due date only while something is left", () => {
    const r = req({ dueOn: "2026-11-15" });
    expect(lineFor(r, "LEO", facts())).toMatchObject({ state: "todo", words: "Not done yet", dueOn: "2026-11-15", title: r.title, required: true });
    expect(lineFor(r, "LEO", facts([`${r.id}|LEO`]))).toMatchObject({ state: "done", words: "Done", dueOn: null });
    expect(lineFor(r, "LEO", facts([], [`${r.id}|LEO`]))).toMatchObject({ state: "waived", words: "Waived", dueOn: null });
    // Done anyway and waived as well: it is done.
    expect(lineFor(r, "LEO", facts([`${r.id}|LEO`], [`${r.id}|LEO`]))).toMatchObject({ state: "done", words: "Done" });
    // One student's tick or waiver says nothing about the other.
    expect(lineFor(r, "MAYA", facts([`${r.id}|LEO`], [`${r.id}|LEO`]))).toMatchObject({ state: "todo" });
  });

  it("uses the kind's own words for what is left", () => {
    const shifts: Facts = { standing: () => ({ met: false, words: "1 of 2 shifts" }), waived: () => false };
    expect(lineFor(req({ kind: "volunteer", amount: 2, amountUnit: "shifts" }), "FAM", shifts)).toMatchObject({ state: "todo", words: "1 of 2 shifts" });
  });
});

describe("when a step is done (spec 10.3)", () => {
  it("is done for a student when every required item asked of them is met or waived", () => {
    const a = req(), b = req();
    const s = step("Forms", [a, b]);
    const view = stepStanding(s, FAMILY, facts([`${a.id}|LEO`, `${b.id}|LEO`, `${a.id}|MAYA`]));
    expect(view.students.map((x) => [x.name, x.done])).toEqual([["Leo", true], ["Maya", false]]);
    expect(view.done).toBe(false);
    // A waiver finishes it as a tick does.
    const waived = stepStanding(s, FAMILY, facts([`${a.id}|LEO`, `${b.id}|LEO`, `${a.id}|MAYA`], [`${b.id}|MAYA`]));
    expect(waived.students.every((x) => x.done)).toBe(true);
    expect(waived.done).toBe(true);
    expect(waived.students[1]!.lines.map((l) => l.words)).toEqual(["Done", "Waived"]);
  });

  it("never lets an optional item hold a step open, and still shows its progress", () => {
    const must = req(), may = req({ required: false, title: "Booster shirt ordered" });
    const view = stepStanding(step("Join", [must, may]), FAMILY, facts([`${must.id}|LEO`, `${must.id}|MAYA`]));
    expect(view.done).toBe(true);
    expect(view.students[0]!.lines).toEqual([
      expect.objectContaining({ title: must.title, state: "done", required: true }),
      expect.objectContaining({ title: "Booster shirt ordered", state: "todo", words: "Not done yet", required: false }),
    ]);
    expect(linesLeft(view.students[0]!.lines)).toBe(0);
    // A step of optional items only is done from the start.
    expect(stepStanding(step("Extras", [may]), FAMILY, facts()).done).toBe(true);
  });

  it("is done from the start when it asks nothing, of anyone or of this family", () => {
    expect(stepStanding(step("Wrap-up"), FAMILY, facts()).done).toBe(true);
    const others = req({ covers: "chosen", coveredQboIds: ["SOMEONE-ELSE"] });
    const view = stepStanding(step("Trip", [others]), FAMILY, facts());
    expect(view.done).toBe(true);
    // Not a line of it, not even its title, for a family it doesn't cover.
    expect(JSON.stringify(view)).not.toContain(others.title);
    expect(view.family).toEqual([]);
    expect(view.students.map((s) => s.lines)).toEqual([[], []]);
  });

  it("keeps the family's own items apart from each student's: the step needs both", () => {
    const perFamily = req({ appliesTo: "family", title: "Membership dues" }), perStudent = req({ title: "Uniform fitting" });
    const s = step("Join", [perFamily, perStudent]);
    const studentsOnly = stepStanding(s, FAMILY, facts([`${perStudent.id}|LEO`, `${perStudent.id}|MAYA`]));
    expect(studentsOnly.students.every((x) => x.done)).toBe(true);
    expect(studentsOnly.family).toEqual([expect.objectContaining({ title: "Membership dues", state: "todo" })]);
    expect(studentsOnly.done).toBe(false);
    const familyOnly = stepStanding(s, FAMILY, facts([`${perFamily.id}|FAM`, `${perStudent.id}|LEO`]));
    expect(familyOnly.students.map((x) => x.done)).toEqual([true, false]);
    expect(familyOnly.done).toBe(false);
    expect(stepStanding(s, FAMILY, facts([`${perFamily.id}|FAM`, `${perStudent.id}|LEO`, `${perStudent.id}|MAYA`])).done).toBe(true);
    // The family's tick is the family's: it is not read as a student's, or the other way round.
    expect(stepStanding(s, FAMILY, facts([`${perFamily.id}|LEO`, `${perStudent.id}|FAM`])).done).toBe(false);
  });

  it("covers only the chosen students: the others have nothing to do in it", () => {
    const guard = req({ title: "Color guard gloves", covers: "chosen", coveredQboIds: ["MAYA"] });
    const view = stepStanding(step("Uniforms", [guard]), FAMILY, facts());
    expect(view.students.map((x) => [x.name, x.lines.length, x.done])).toEqual([["Leo", 0, true], ["Maya", 1, false]]);
    expect(view.done).toBe(false);
  });

  it("holds a step open again for a student added mid-season, with nothing recorded for them", () => {
    const a = req();
    const s = step("Join", [a]);
    const done = facts([`${a.id}|LEO`, `${a.id}|MAYA`]);
    expect(stepStanding(s, FAMILY, done).done).toBe(true);
    const grown: FamilyRoster = { ...FAMILY, students: [...FAMILY.students, { qboId: "NICO", name: "Nico" }] };
    const view = stepStanding(s, grown, done);
    expect(view.students.map((x) => [x.name, x.done])).toEqual([["Leo", true], ["Maya", true], ["Nico", false]]);
    expect(view.done).toBe(false);
    // And a student who has left the roster drops out of what is shown, whatever was recorded.
    const shrunk: FamilyRoster = { ...FAMILY, students: [FAMILY.students[0]!] };
    expect(stepStanding(s, shrunk, facts([`${a.id}|LEO`])).students.map((x) => x.name)).toEqual(["Leo"]);
    expect(stepStanding(s, shrunk, facts([`${a.id}|LEO`])).done).toBe(true);
  });

  it("counts what is done and what is left", () => {
    const lines = [lineFor(req(), "LEO", facts()), lineFor(req({ required: false }), "LEO", facts())];
    expect(linesDone(lines)).toBe(false);
    expect(linesLeft(lines)).toBe(1);
    expect(linesDone([])).toBe(true);
  });
});

describe("the current step (spec 10.3)", () => {
  const plain = (count: number) => Array.from({ length: count }, () => ({ startsOn: null, endsOn: null }));

  it("has none for a season with no steps", () => {
    expect(currentStepIndex([], [], TODAY)).toBeNull();
  });

  describe("with no dates: the first step not yet done by everyone in the family", () => {
    it.each([
      [[false, false, false], 0],
      [[true, false, false], 1],
      [[true, true, false], 2],
      // A later step done ahead of time doesn't move the family past an earlier one.
      [[false, true, true], 0],
      [[true, false, true], 1],
    ])("done %j is step %i", (done, expected) => {
      expect(currentStepIndex(plain(3), done, TODAY)).toBe(expected);
    });

    it("has none once every step is done", () => {
      expect(currentStepIndex(plain(3), [true, true, true], TODAY)).toBeNull();
    });
  });

  describe("with dates: the club's current step by date, whatever the family has done", () => {
    const d = (startsOn: string | null, endsOn: string | null) => ({ startsOn, endsOn });
    const NOT_DONE = [false, false, false, false], ALL_DONE = [true, true, true, true];
    const at = (steps: ReturnType<typeof d>[], today: string, done = NOT_DONE) => currentStepIndex(steps, done.slice(0, steps.length), today);

    it("follows full ranges that meet", () => {
      const steps = [d("2026-08-01", "2026-08-15"), d("2026-08-16", "2026-08-31"), d("2026-09-01", "2026-11-30")];
      expect(at(steps, "2026-08-01")).toBe(0);
      expect(at(steps, "2026-08-15")).toBe(0); // the end date is the step's last day
      expect(at(steps, "2026-08-16")).toBe(1);
      expect(at(steps, "2026-10-01")).toBe(2);
      // The family's own progress doesn't move the club's date.
      expect(at(steps, "2026-08-10", ALL_DONE)).toBe(0);
      expect(at(steps, "2026-10-01", NOT_DONE)).toBe(2);
    });

    it("is the first step before the season starts, and stays on the last once every step has ended", () => {
      const steps = [d("2026-08-01", "2026-08-15"), d("2026-08-16", "2026-08-31")];
      expect(at(steps, "2026-07-01")).toBe(0);
      expect(at(steps, "2027-01-01")).toBe(1);
    });

    it("with start dates only, runs each step until the next one starts", () => {
      const steps = [d("2026-08-01", null), d("2026-08-15", null), d("2026-09-01", null)];
      expect(at(steps, "2026-08-10")).toBe(0);
      expect(at(steps, "2026-08-15")).toBe(1);
      expect(at(steps, "2026-08-31")).toBe(1);
      expect(at(steps, "2026-12-25")).toBe(2);
    });

    it("with end dates only, runs each step until its end", () => {
      const steps = [d(null, "2026-08-15"), d(null, "2026-09-01"), d(null, "2026-11-30")];
      expect(at(steps, "2026-07-04")).toBe(0);
      expect(at(steps, "2026-08-20")).toBe(1);
      expect(at(steps, "2026-09-01")).toBe(1);
      expect(at(steps, "2026-09-02")).toBe(2);
    });

    it("keeps the earlier step current where two ranges overlap, until it ends", () => {
      const steps = [d("2026-08-01", "2026-09-15"), d("2026-09-01", "2026-11-30")];
      expect(at(steps, "2026-09-10")).toBe(0);
      expect(at(steps, "2026-09-15")).toBe(0);
      expect(at(steps, "2026-09-16")).toBe(1);
    });

    it("shows the step coming up in a gap between two ranges", () => {
      const steps = [d("2026-08-01", "2026-08-15"), d("2026-09-01", "2026-09-30")];
      expect(at(steps, "2026-08-20")).toBe(1);
    });

    it("runs a step with no dates, among dated ones, from the end of the one before to the start of the next", () => {
      const steps = [d("2026-08-01", "2026-08-15"), d(null, null), d("2026-09-01", "2026-11-30")];
      expect(at(steps, "2026-08-10")).toBe(0);
      expect(at(steps, "2026-08-20")).toBe(1);
      expect(at(steps, "2026-09-01")).toBe(2);
    });

    it("stays on a step with no dates that comes after the last dated one", () => {
      const steps = [d(null, "2026-08-15"), d(null, "2026-09-01"), d(null, null), d(null, null)];
      expect(at(steps, "2026-10-01")).toBe(2);
    });

    it("uses the dates as soon as a single step has one", () => {
      // By progress this family would be on the first step; by date the club is on the second.
      const steps = [d(null, null), d("2026-09-01", null), d(null, null)];
      expect(at(steps, "2026-09-10")).toBe(1);
      expect(at(steps, "2026-08-10")).toBe(0);
    });

    it("skips a step whose dates are in the past even when a later one is written earlier in the year", () => {
      const steps = [d("2026-10-01", "2026-10-31"), d("2026-08-01", "2026-08-31")];
      expect(at(steps, "2026-09-10")).toBe(0);
      expect(at(steps, "2026-11-05")).toBe(1);
    });

    it("ends a step with no end date once a later step has ended, not only once one has started", () => {
      // Join has no dates (it is open all year); the steps after it have end dates only.
      const year = [d(null, null), d(null, "2027-09-30"), d(null, "2027-10-31"), d(null, "2027-12-15"), d(null, "2028-01-31")];
      expect(at(year, "2027-09-15", [false, false, false, false, false])).toBe(0);
      expect(at(year, "2027-09-30", [false, false, false, false, false])).toBe(0);
      // Forms has ended, so Join before it has too: the club is not on Join for the rest of the year.
      expect(at(year, "2027-10-01", [false, false, false, false, false])).toBe(2);
      expect(at(year, "2027-11-15", [false, false, false, false, false])).toBe(3);
      expect(at(year, "2028-03-01", [false, false, false, false, false])).toBe(4); // every step has ended: the last one stays
      const three = [d(null, null), d(null, "2027-09-30"), d(null, "2027-10-31")];
      expect(at(three, "2027-11-15")).toBe(2);
      // A step with a start date and no end, before one with an end date and no start.
      const two = [d("2027-08-01", null), d(null, "2027-09-30")];
      expect(at(two, "2027-07-15")).toBe(0);
      expect(at(two, "2027-09-30")).toBe(0);
      expect(at(two, "2027-10-15")).toBe(1);
    });
  });
});

describe("steps whose dates run against their order", () => {
  const d = (startsOn: string | null, endsOn: string | null) => ({ startsOn, endsOn });

  it("finds none where the dates follow the order, meet, overlap or are missing", () => {
    for (const steps of [
      [],
      [d(null, null), d(null, null)],
      [d("2027-08-01", "2027-08-15"), d("2027-08-16", "2027-08-31"), d("2027-09-01", null)],
      [d("2027-08-01", null), d("2027-08-15", null), d("2027-09-01", null)],
      [d(null, "2027-08-15"), d(null, "2027-09-01"), d(null, "2027-11-30")],
      [d("2027-08-01", "2027-09-15"), d("2027-09-01", "2027-11-30")],          // an overlap: the earlier step stays current until it ends
      [d("2027-08-01", "2027-08-15"), d(null, null), d("2027-09-01", "2027-11-30")],
      [d("2027-08-01", "2027-08-01"), d("2027-08-01", "2027-08-01")],          // the same day
      [d(null, null), d(null, "2027-09-30"), d("2027-10-01", null)],
    ]) expect(stepsOutOfOrder(steps), JSON.stringify(steps)).toEqual([]);
  });

  it("names each step that starts or ends before a step that comes before it", () => {
    // Uniforms (starts Sep 1) was moved ahead of Forms (starts Aug 1): from Aug 1 the ruler is on Forms, and never on Uniforms.
    expect(stepsOutOfOrder([d("2027-09-01", null), d("2027-08-01", null)])).toEqual([1]);
    expect(stepsOutOfOrder([d(null, "2027-10-31"), d(null, "2027-09-30")])).toEqual([1]);
    // Over before the step ahead of it begins.
    expect(stepsOutOfOrder([d("2027-09-01", null), d(null, "2027-08-31")])).toEqual([1]);
    expect(stepsOutOfOrder([d("2027-08-01", "2027-08-15"), d("2027-10-01", null), d("2027-09-01", "2027-09-30"), d("2027-11-01", null)])).toEqual([2]);
    // A step with no dates between them changes nothing.
    expect(stepsOutOfOrder([d("2027-09-01", null), d(null, null), d("2027-08-01", null), d("2027-07-01", null)])).toEqual([2, 3]);
  });
});

describe("a whole season for one family", () => {
  it("puts the steps in order with the current one marked, and nothing left behind it without dates", () => {
    const join = req({ appliesTo: "family", title: "Membership form" }), fitting = req({ title: "Uniform fitting" });
    const steps = [step("Join", [join]), step("Uniforms", [fitting]), step("Wrap-up")];
    const view = seasonStanding(steps, FAMILY, facts([`${join.id}|FAM`, `${fitting.id}|LEO`]), TODAY);
    expect(view.steps.map((s) => [s.name, s.done])).toEqual([["Join", true], ["Uniforms", false], ["Wrap-up", true]]);
    expect(view.currentIndex).toBe(1);
    expect(view.leftBefore).toBe(0);
    expect(view.steps[1]!.students.map((s) => [s.name, s.done])).toEqual([["Leo", true], ["Maya", false]]);
    // All done: no step is current.
    const done = seasonStanding(steps, FAMILY, facts([`${join.id}|FAM`, `${fitting.id}|LEO`, `${fitting.id}|MAYA`]), TODAY);
    expect(done.currentIndex).toBeNull();
    expect(done.steps.every((s) => s.done)).toBe(true);
  });

  it("with dates, counts the required items left in steps before the current one", () => {
    const join = req({ appliesTo: "family" }), fitting = req(), optional = req({ required: false }), later = req();
    const steps = [step("Join", [join, optional], { endsOn: "2026-08-15" }), step("Uniforms", [fitting], { endsOn: "2026-09-01" }), step("Season", [later])];
    const view = seasonStanding(steps, FAMILY, facts([`${fitting.id}|LEO`]), TODAY);
    expect(view.currentIndex).toBe(2);
    // The family's membership item and Maya's fitting; not the optional item, and not what the current step asks.
    expect(view.leftBefore).toBe(2);
    expect(seasonStanding(steps, FAMILY, facts([`${fitting.id}|LEO`, `${fitting.id}|MAYA`], [`${join.id}|FAM`]), TODAY).leftBefore).toBe(0);
  });

  it("counts what is left in a step that ended while a step with no end date stood before it", () => {
    const join = req({ appliesTo: "family" }), forms = req(), volunteer = req();
    const steps = [step("Join", [join]), step("Forms", [forms], { endsOn: "2027-09-30" }), step("Volunteer", [volunteer], { endsOn: "2027-10-31" })];
    const view = seasonStanding(steps, FAMILY, facts([`${forms.id}|LEO`]), "2027-10-15");
    expect(view.currentIndex).toBe(2);
    // Join's item for the family, and Maya's form: both are behind the club now, and both are still to do.
    expect(view.leftBefore).toBe(2);
  });

  it("has no current step when the season has no steps", () => {
    expect(seasonStanding([], FAMILY, facts(), TODAY)).toEqual({ steps: [], currentIndex: null, leftBefore: 0 });
  });
});

describe("calendar dates", () => {
  it.each(["2026-08-01", "2028-02-29", "1999-12-31"])("accepts %s", (value) => expect(isCalendarDate(value)).toBe(true));
  it.each(["2026-02-30", "2026-13-01", "2026-8-1", "08/01/2026", "2026-08-01T00:00:00Z", "", " 2026-08-01", "0000-01-01", null, 20260801, undefined])("refuses %j", (value) => expect(isCalendarDate(value)).toBe(false));
});
