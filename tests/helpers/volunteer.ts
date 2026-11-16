import { db } from "@/lib/db/client";
import { volunteerEvent, volunteerShift, volunteerShiftRequirement, volunteerSignup } from "@/lib/db/schema";
import { calendarDayIn } from "@/lib/settings/club";
import type { ParentFamilySpec } from "./parent";

/**
 * Volunteer events for tests, written straight into the tables as the staff pages would have left them. Dates are
 * counted from today in UTC (the club's zone until a test sets one), so an event `inDays` ahead is still to come
 * whenever the test runs.
 */
export const dayFromNow = (inDays: number) => calendarDayIn("UTC", new Date(Date.now() + inDays * 86_400_000));

export type SeedShift = { startsAt?: string; endsAt?: string; places?: number; role?: string | null; requirementIds?: string[]; cancelled?: boolean };
export async function seedEvent(o: { name?: string; onDate?: string; inDays?: number; location?: string; description?: string; contactName?: string; contactEmail?: string | null; cancelled?: boolean; shifts?: SeedShift[] } = {}) {
  const [event] = await db.insert(volunteerEvent).values({
    name: o.name ?? "Home game concessions", onDate: o.onDate ?? dayFromNow(o.inDays ?? 30), location: o.location ?? "North stadium stand",
    description: o.description ?? "", contactName: o.contactName ?? "Pat Organizer", contactEmail: o.contactEmail === undefined ? "pat.organizer@club.example" : o.contactEmail,
    cancelledAt: o.cancelled ? new Date() : null,
  }).returning();
  const shifts = [];
  for (const s of o.shifts ?? [{}]) shifts.push(await seedShift(event!.id, s));
  return { event: event!, shifts };
}

export async function seedShift(eventId: string, s: SeedShift = {}) {
  const [shift] = await db.insert(volunteerShift).values({ eventId, startsAt: s.startsAt ?? "18:00", endsAt: s.endsAt ?? "21:00", places: s.places ?? 4, role: s.role === undefined ? "Concessions" : s.role,
    cancelledAt: s.cancelled ? new Date() : null }).returning();
  if (s.requirementIds?.length) await db.insert(volunteerShiftRequirement).values(s.requirementIds.map((requirementId) => ({ shiftId: shift!.id, requirementId })));
  return shift!;
}

/** A place on a shift, as a guardian's sign-up leaves it: for themselves (`parentId`) or for a student. */
export async function seedSignup(o: { shiftId: string; familyQboId: string; signedUpBy: string; student?: { qboId: string; name: string }; guardianName?: string; cancelled?: boolean }) {
  const [row] = await db.insert(volunteerSignup).values({
    shiftId: o.shiftId, familyQboId: o.familyQboId, signedUpBy: o.signedUpBy, fillerKind: o.student ? "student" : "guardian",
    fillerParentId: o.student ? null : o.signedUpBy, studentQboId: o.student?.qboId ?? null, fillerName: o.student?.name ?? o.guardianName ?? "A guardian",
    cancelledAt: o.cancelled ? new Date() : null, cancelledByDoor: o.cancelled ? "parent" : null,
  }).returning();
  return row!;
}

/** The event seedTwoFamilies() gives the club: its name and shift are the club's, shown to everyone. */
export const TWO_FAMILY_EVENT = "Marching band car wash";

export type FamilyVolunteer = {
  /** The shift both families are signed up for. */
  shiftId: string;
  /** Strings that belong to this family's sign-up alone: its id, and the name of who fills the place. */
  markers: string[];
  /** What this family's parent must find on the Volunteer page: the event, the count every family sees, and their own sign-up. */
  page: string[];
};

/**
 * One event with one shift of four places, and both families signed up for it (v1 spec §12 invariant 7): family A
 * signs up its first student, family B its parent. Each parent must see the count, "2 of 4 places filled", and their
 * own sign-up, and nothing of the other's.
 */
export async function seedTwoFamilyVolunteering(a: { spec: ParentFamilySpec; parentId: string }, b: { spec: ParentFamilySpec; parentId: string }): Promise<{ a: FamilyVolunteer; b: FamilyVolunteer }> {
  const { shifts: [shift] } = await seedEvent({ name: TWO_FAMILY_EVENT, inDays: 20, location: "Bandroom parking lot", shifts: [{ startsAt: "09:00", endsAt: "12:00", places: 4, role: "Rinse crew" }] });
  const student = a.spec.students[0]!;
  const forA = await seedSignup({ shiftId: shift!.id, familyQboId: a.spec.family.qboId, signedUpBy: a.parentId, student });
  const forB = await seedSignup({ shiftId: shift!.id, familyQboId: b.spec.family.qboId, signedUpBy: b.parentId, guardianName: b.spec.parent.name });
  const page = [TWO_FAMILY_EVENT, "2 of 4 places filled"];
  return {
    a: { shiftId: shift!.id, markers: [forA.id], page: [...page, `${student.name} is doing this one`] },
    b: { shiftId: shift!.id, markers: [forB.id], page: [...page, "You&#x27;re doing this one"] },
  };
}
