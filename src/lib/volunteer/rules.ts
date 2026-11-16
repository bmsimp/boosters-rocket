/**
 * How volunteering counts toward a requirement (v1 spec §10.2, §11), as pure functions. A shift counts its length in
 * hours, or as one shift, as the requirement counts; a per-family requirement is met by anyone in the family, a
 * per-student one by that student alone. A requirement is met by confirmed volunteering (check-in, a later slice)
 * reaching its amount; until then a parent reads how much is needed, how much is done and how much they are signed up
 * for. Nothing here reads the database or the clock.
 */
import type { Requirement, Standing } from "@/lib/seasons/progress";

/** Who fills a place: the guardian who signed up, or one of the family's students. */
export type Filler = { kind: "guardian" } | { kind: "student"; studentQboId: string };

/** How much one shift of this length counts toward a requirement: 1 for one counted in shifts, its hours for one counted in hours. */
export const shiftCredit = (requirement: Pick<Requirement, "amountUnit">, minutes: number): number =>
  requirement.amountUnit === "hours" ? minutes / 60 : 1;

/** A count in the requirement's unit, in words: "1 shift", "2 shifts", "2.5 hours". */
export function amountWords(unit: Requirement["amountUnit"], n: number): string {
  const shown = String(Math.round(n * 100) / 100);
  const word = unit === "hours" ? "hour" : "shift";
  return `${shown} ${n === 1 ? word : `${word}s`}`;
}
const figure = (n: number) => String(Math.round(n * 100) / 100);

/** Whether a place filled by `filler` of `familyQboId` counts toward this requirement for `subjectQboId` (the family for a per-family requirement, a student for a per-student one). */
export function countsFor(requirement: Pick<Requirement, "appliesTo">, filler: Filler, familyQboId: string, subjectQboId: string): boolean {
  if (requirement.appliesTo === "family") return subjectQboId === familyQboId;
  return filler.kind === "student" && filler.studentQboId === subjectQboId;
}

/**
 * How a volunteer requirement stands for one family or student: met once confirmed volunteering reaches the amount.
 * `confirmed` is credit from check-ins and staff (none yet: the check-in slice supplies it), `signedUp` is what the
 * family is signed up for and not yet credited with. "0 of 2 shifts done, signed up for 1".
 */
export function volunteerStanding(requirement: Pick<Requirement, "amount" | "amountUnit">, o: { confirmed: number; signedUp: number }): Standing {
  const amount = requirement.amount ?? 0;
  const done = `${figure(o.confirmed)} of ${amountWords(requirement.amountUnit, amount)} done`;
  return { met: amount > 0 && o.confirmed >= amount, words: o.signedUp > 0 ? `${done}, signed up for ${figure(o.signedUp)}` : done };
}

/** Who must do a requirement, in a parent's words. */
export const whoMustWords = (requirement: Pick<Requirement, "appliesTo">, studentName: string | null): string =>
  requirement.appliesTo === "family" ? "Anyone in your family can do it" : `${studentName ?? "Each student"} must do it`;

/** "3 of 5 places filled": the one thing about other families a parent is told, and never who. */
export const placesWords = (s: { filled: number; places: number }): string => `${s.filled} of ${s.places} ${s.places === 1 ? "place" : "places"} filled`;
