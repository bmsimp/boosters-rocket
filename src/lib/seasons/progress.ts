/**
 * The progress rules of a season (v1 spec §10.3), as pure functions: who a requirement is asked of, how it stands for
 * a family or a student, when a step is done, and which step is the current one. Nothing here reads the database or
 * the clock: the callers (./my-season.ts for a parent, ./staff-progress.ts for staff) hand in what is recorded and
 * what day it is for the club.
 */
import type { RequirementKind } from "@/lib/db/schema";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";

/**
 * Who a requirement is asked of, by the app's own id: a family for a per-family requirement, a student for a
 * per-student one (stage 2 of the app-owned families spec). Never a QuickBooks id: the areas still keyed by those read a
 * season through ./by-customer.ts.
 */
export type SubjectId = AppFamilyId | AppStudentId;

export type AppliesTo = "family" | "student";
export type AmountUnit = "shifts" | "hours";

/** A requirement's own settings, whoever reads it. */
export type RequirementFields = {
  id: string;
  kind: RequirementKind;
  /** In the club's own words. */
  title: string;
  /** An optional requirement shows its progress and never holds a step open. */
  required: boolean;
  appliesTo: AppliesTo;
  /** Volunteer only: how many shifts or hours. */
  amount: number | null;
  amountUnit: AmountUnit | null;
  /** A calendar date (YYYY-MM-DD) in the club's time zone. */
  dueOn: string | null;
  covers: "everyone" | "chosen";
};

export type Requirement = RequirementFields & {
  /** With `covers: "chosen"`: the families (per family) or students (per student) it is asked of, by the app's own id. */
  coveredIds: readonly SubjectId[];
};

export type Step = { id: string; name: string; startsOn: string | null; endsOn: string | null; requirements: readonly Requirement[] };

/** A family as the roster lists it now: its own id and its active students'. A club that doesn't list students has none. */
export type FamilyRoster = { familyId: AppFamilyId; students: readonly { id: AppStudentId; name: string }[] };

/** How a requirement stands for one family or student, as its kind judges it (./kinds.ts), in the words a parent reads. */
export type Standing = { met: boolean; words: string };

/** What is recorded, as the rules ask for it. */
export type Facts = {
  standing(requirement: Requirement, subject: SubjectId): Standing;
  waived(requirementId: string, subject: SubjectId): boolean;
};

export type LineState = "done" | "waived" | "todo";
/** One requirement as it stands for one family or student. */
export type Line = {
  requirementId: string; title: string; kind: RequirementKind; required: boolean;
  state: LineState;
  /** "Done", "Waived", "Not done yet": the state in words, never a color alone. */
  words: string;
  /** Only while there is still something to do. */
  dueOn: string | null;
};

export type StudentStanding = { id: AppStudentId; name: string; lines: Line[]; /** Every required item asked of this student is met or waived. */ done: boolean };
export type StepStanding = {
  id: string; name: string; startsOn: string | null; endsOn: string | null;
  /** The requirements asked once of the family. */
  family: Line[];
  students: StudentStanding[];
  /** Done by everyone: the family's own required items, and every student's. */
  done: boolean;
};
export type SeasonStanding = {
  steps: StepStanding[];
  /** The step the ruler marks, or null when there are no steps, or no dates and nothing left to do. */
  currentIndex: number | null;
  /** Required items still to do in steps before the current one. Only a season with dates can have any. */
  leftBefore: number;
};

export const WAIVED_WORDS = "Waived";

/** Whether a requirement is asked of this family (per family) or this student (per student). */
export function isCovered(requirement: Pick<Requirement, "covers" | "coveredIds">, subject: SubjectId): boolean {
  return requirement.covers === "everyone" || requirement.coveredIds.includes(subject);
}

/**
 * Who in one family a requirement is tracked for: the family itself, once, for a per-family requirement; each of its
 * active students for a per-student one. Only those it covers. A student who joins mid-season is simply in the list
 * from then on, with nothing recorded yet.
 */
export function subjectsOf(requirement: Requirement, family: FamilyRoster): SubjectId[] {
  const all: SubjectId[] = requirement.appliesTo === "family" ? [family.familyId] : family.students.map((s) => s.id);
  return all.filter((id) => isCovered(requirement, id));
}

/** How a requirement stands for one family or student. Met comes first: a waiver on something that was done anyway changes nothing. */
export function lineFor(requirement: Requirement, subject: SubjectId, facts: Facts): Line {
  const standing = facts.standing(requirement, subject);
  const state: LineState = standing.met ? "done" : facts.waived(requirement.id, subject) ? "waived" : "todo";
  return {
    requirementId: requirement.id, title: requirement.title, kind: requirement.kind, required: requirement.required,
    state, words: state === "waived" ? WAIVED_WORDS : standing.words, dueOn: state === "todo" ? requirement.dueOn : null,
  };
}

/** Done: every required item is met or waived. An optional item never holds anything open; nothing asked is done. */
export const linesDone = (lines: readonly Line[]): boolean => lines.every((l) => !l.required || l.state !== "todo");
/** The required items still to do. */
export const linesLeft = (lines: readonly Line[]): number => lines.filter((l) => l.required && l.state === "todo").length;

/**
 * One step as it stands for one family. A student's own standing counts only what is asked of that student; the
 * family's own items are the family's. The step is done when all of it is.
 */
export function stepStanding(step: Step, family: FamilyRoster, facts: Facts): StepStanding {
  const forSubject = (applies: AppliesTo, subject: SubjectId) =>
    step.requirements.filter((r) => r.appliesTo === applies && isCovered(r, subject)).map((r) => lineFor(r, subject, facts));
  const own = forSubject("family", family.familyId);
  const students = family.students.map((s) => {
    const lines = forSubject("student", s.id);
    return { id: s.id, name: s.name, lines, done: linesDone(lines) };
  });
  return { id: step.id, name: step.name, startsOn: step.startsOn, endsOn: step.endsOn, family: own, students, done: linesDone(own) && students.every((s) => s.done) };
}

const hasDate = (s: Pick<Step, "startsOn" | "endsOn">) => s.startsOn !== null || s.endsOn !== null;

/**
 * Which step the ruler marks (v1 spec §10.3).
 *
 * When any step has a date, it is the club's current step by date: the first step, in order, that hasn't ended. A step
 * has ended when its end date has passed or, if it has none, when a later step has started or has itself ended: the
 * steps come in order, so once the club is on a later step, or past it, the ones before it are over. So with start
 * dates only, each step runs until the next one starts; with end dates only, each runs until its end; where two ranges
 * overlap, the earlier step stays current until it ends; in a gap between two steps, the one coming up is current; and
 * once every step has ended, the last one stays. A step with no dates among dated ones runs until a later step starts
 * or ends: a first step left without dates, before steps that have only end dates, gives way when the next one ends.
 *
 * When no step has a date, it is the first step not yet done by everyone in the family, and null once all are done.
 *
 * `doneByEveryone[i]` is whether step i is done by the family and all its students; `today` is the club's date.
 */
export function currentStepIndex(steps: readonly Pick<Step, "startsOn" | "endsOn">[], doneByEveryone: readonly boolean[], today: string): number | null {
  if (steps.length === 0) return null;
  if (!steps.some(hasDate)) {
    const first = doneByEveryone.findIndex((done) => !done);
    return first < 0 ? null : first;
  }
  const ended = (i: number) => {
    const step = steps[i]!;
    if (step.endsOn !== null) return step.endsOn < today;
    return steps.some((later, j) => j > i && ((later.startsOn !== null && later.startsOn <= today) || (later.endsOn !== null && later.endsOn < today)));
  };
  const first = steps.findIndex((_step, i) => !ended(i));
  return first < 0 ? steps.length - 1 : first;
}

/**
 * The steps whose dates run against their order, by position: a step that starts before an earlier step starts, ends
 * before an earlier step ends, or ends before an earlier step starts. The current step follows the order of the steps
 * (currentStepIndex), so a step dated out of turn counts as over before its own dates come, and is never the current
 * one. Nothing refuses such dates, since steps are dated and moved one at a time; the staff season page says so
 * instead. Starting before an earlier step ends is an overlap, which is allowed.
 */
export function stepsOutOfOrder(steps: readonly Pick<Step, "startsOn" | "endsOn">[]): number[] {
  const before = (a: string | null, b: string | null) => a !== null && b !== null && a < b;
  return steps.flatMap((step, j) =>
    steps.some((earlier, i) => i < j && (before(step.startsOn, earlier.startsOn) || before(step.endsOn, earlier.endsOn) || before(step.endsOn, earlier.startsOn))) ? [j] : []);
}

/** A whole season as it stands for one family on the club's `today`. */
export function seasonStanding(steps: readonly Step[], family: FamilyRoster, facts: Facts, today: string): SeasonStanding {
  const standings = steps.map((step) => stepStanding(step, family, facts));
  const currentIndex = currentStepIndex(steps, standings.map((s) => s.done), today);
  const before = currentIndex === null ? [] : standings.slice(0, currentIndex);
  const leftBefore = before.reduce((sum, s) => sum + linesLeft(s.family) + s.students.reduce((n, student) => n + linesLeft(student.lines), 0), 0);
  return { steps: standings, currentIndex, leftBefore };
}

/** A calendar date as the portal stores it: YYYY-MM-DD, and a day that exists. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return y >= 1900 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
