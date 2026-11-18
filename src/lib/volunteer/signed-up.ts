// What families and students are signed up for, counted toward volunteer requirements: the part of the volunteer kind's
// rule (src/lib/seasons/kinds.ts) that reads the database. Parent pages reach it through loadMySeason(), so it reads only
// the families and students it is asked about, and gives back amounts, never who else is on a shift. It imports no
// staff-only module (tests/integration/page-guards.test.ts scans this file).
import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { volunteerCredit, volunteerEvent, volunteerShift, volunteerShiftRequirement, volunteerSignup } from "@/lib/db/schema";
import type { RequirementFields } from "@/lib/seasons/progress";
import { getClubSettings } from "@/lib/settings/club";
import { shiftInstants, shiftMinutes } from "./clock";
import { countsFor, shiftCredit, type Filler } from "./rules";

/**
 * How much each family or student is signed up for toward each of these volunteer requirements, keyed by `pairKey`
 * (src/lib/seasons/kinds.ts passes its own in): every place they hold, on a shift and an event still on, that counts
 * toward the requirement for them, is not checked in yet and hasn't ended. With `subjectQboIds` (a parent's own
 * family and students) only sign-ups made from that family are read; null is everyone, for staff.
 */
export async function signedUpAmounts(requirements: readonly RequirementFields[], subjectQboIds: readonly string[] | null, pairKey: (requirementId: string, subjectQboId: string) => string,
  now: Date = new Date()): Promise<Map<string, number>> {
  const amounts = new Map<string, number>();
  if (requirements.length === 0 || subjectQboIds?.length === 0) return amounts;
  const rows = await db.select({
    requirementId: volunteerShiftRequirement.requirementId, familyQboId: volunteerSignup.familyQboId, fillerKind: volunteerSignup.fillerKind,
    studentQboId: volunteerSignup.studentQboId, onDate: volunteerEvent.onDate, startsAt: volunteerShift.startsAt, endsAt: volunteerShift.endsAt,
  }).from(volunteerShiftRequirement)
    .innerJoin(volunteerShift, eq(volunteerShift.id, volunteerShiftRequirement.shiftId))
    .innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
    .innerJoin(volunteerSignup, eq(volunteerSignup.shiftId, volunteerShift.id))
    // A place already checked in is credit now (./credit.ts), no longer something the family is signed up for.
    .leftJoin(volunteerCredit, and(eq(volunteerCredit.signupId, volunteerSignup.id), isNull(volunteerCredit.removedAt)))
    .where(and(
      isNull(volunteerCredit.id),
      inArray(volunteerShiftRequirement.requirementId, requirements.map((r) => r.id)),
      isNull(volunteerShift.cancelledAt), isNull(volunteerEvent.cancelledAt), isNull(volunteerSignup.cancelledAt),
      // A parent's own family's sign-ups alone: a place another family took for a student who has since moved in is theirs, not this family's.
      subjectQboIds ? inArray(volunteerSignup.familyQboId, [...subjectQboIds]) : undefined,
    ));
  if (rows.length === 0) return amounts;
  const zone = (await getClubSettings()).timeZone;
  const asked = subjectQboIds ? new Set(subjectQboIds) : null;
  for (const row of rows) {
    const r = requirements.find((x) => x.id === row.requirementId);
    if (!r) continue;
    const filler: Filler = row.fillerKind === "student" && row.studentQboId ? { kind: "student", studentQboId: row.studentQboId } : { kind: "guardian" };
    const subject = r.appliesTo === "family" ? row.familyQboId : filler.kind === "student" ? filler.studentQboId : null;
    if (subject === null || (asked && !asked.has(subject)) || !countsFor(r, filler, row.familyQboId, subject)) continue;
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
