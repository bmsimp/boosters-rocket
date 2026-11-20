// What families and students are signed up for, counted toward volunteer requirements: the part of the volunteer kind's
// rule (src/lib/seasons/kinds.ts) that reads the database. Parent pages reach it through loadMySeason(), so it reads only
// the families and students it is asked about, and gives back amounts, never who else is on a shift. Every id is the
// app's own (stage 2 of the app-owned families spec). It imports no staff-only module
// (tests/integration/page-guards.test.ts scans this file).
import "server-only";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { student, volunteerCredit, volunteerEvent, volunteerShift, volunteerShiftRequirement, volunteerSignup } from "@/lib/db/schema";
import type { RequirementFields, SubjectId, SubjectsAsked } from "@/lib/seasons/progress";
import { getClubSettings } from "@/lib/settings/club";
import { shiftInstants, shiftMinutes } from "./clock";
import { countsFor, shiftCredit, type Filler } from "./rules";

/**
 * How much each family or student is signed up for toward each of these volunteer requirements, keyed by `pairKey`
 * (src/lib/seasons/kinds.ts passes its own in): every place they hold, on a shift and an event still on, that counts
 * toward the requirement for them, is not checked in yet and hasn't ended. A place a student fills counts only while
 * the student's own record is active and in the family the place was taken from (docs/agents/volunteering.md): a student
 * who left the roster, or moved, takes the place out of every count. With `asked` (a parent's own family and
 * students) only sign-ups made from that family are read; null is everyone, for staff.
 */
export async function signedUpAmounts(requirements: readonly RequirementFields[], asked: SubjectsAsked | null, pairKey: (requirementId: string, subject: SubjectId) => string,
  now: Date = new Date()): Promise<Map<string, number>> {
  const amounts = new Map<string, number>();
  // A sign-up is always made from a family: asked about no family, there is none to read.
  if (requirements.length === 0 || asked?.families.length === 0) return amounts;
  const rows = await db.select({
    requirementId: volunteerShiftRequirement.requirementId, familyId: volunteerSignup.familyId, fillerKind: volunteerSignup.fillerKind,
    studentId: volunteerSignup.studentId, onDate: volunteerEvent.onDate, startsAt: volunteerShift.startsAt, endsAt: volunteerShift.endsAt,
  }).from(volunteerShiftRequirement)
    .innerJoin(volunteerShift, eq(volunteerShift.id, volunteerShiftRequirement.shiftId))
    .innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
    .innerJoin(volunteerSignup, eq(volunteerSignup.shiftId, volunteerShift.id))
    // A place already checked in is credit now (./credit.ts), no longer something the family is signed up for.
    .leftJoin(volunteerCredit, and(eq(volunteerCredit.signupId, volunteerSignup.id), isNull(volunteerCredit.removedAt)))
    .leftJoin(student, eq(student.id, volunteerSignup.studentId))
    .where(and(
      isNull(volunteerCredit.id),
      // A guardian's own place, or a student's while the student is still active and in the place's own family.
      or(isNull(volunteerSignup.studentId), and(eq(student.active, true), eq(student.familyId, volunteerSignup.familyId))),
      inArray(volunteerShiftRequirement.requirementId, requirements.map((r) => r.id)),
      isNull(volunteerShift.cancelledAt), isNull(volunteerEvent.cancelledAt), isNull(volunteerSignup.cancelledAt),
      // A parent's own family's sign-ups alone: a place another family took for a student who has since moved in is theirs, not this family's.
      asked ? inArray(volunteerSignup.familyId, [...asked.families]) : undefined,
    ));
  if (rows.length === 0) return amounts;
  const zone = (await getClubSettings()).timeZone;
  const wanted = asked ? new Set([...asked.families, ...asked.students].map(String)) : null;
  for (const row of rows) {
    const r = requirements.find((x) => x.id === row.requirementId);
    if (!r) continue;
    const filler: Filler = row.fillerKind === "student" && row.studentId ? { kind: "student", studentId: row.studentId } : { kind: "guardian" };
    const subject: SubjectId | null = r.appliesTo === "family" ? row.familyId : filler.kind === "student" ? filler.studentId : null;
    if (subject === null || (wanted && !wanted.has(String(subject))) || !countsFor(r, filler, row.familyId, subject)) continue;
    const when = shiftInstants(row.onDate, row.startsAt, row.endsAt, zone);
    // A shift that is over and wasn't checked in can't become credit through the guardian any more (only staff can add
    // a missed check-in), so it isn't something the family is signed up for: the words and the nudges leave it out.
    if (when.end.getTime() <= now.getTime()) continue;
    const minutes = shiftMinutes(when);
    const key = pairKey(r.id, subject);
    amounts.set(key, (amounts.get(key) ?? 0) + shiftCredit(r, minutes));
  }
  return amounts;
}
