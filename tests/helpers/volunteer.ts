import { db } from "@/lib/db/client";
import { requirement, volunteerCredit, volunteerEvent, volunteerShift, volunteerShiftRequirement, volunteerSignup } from "@/lib/db/schema";
import { calendarDayIn } from "@/lib/settings/club";
import type { ParentFamilySpec } from "./parent";
import type { SeededSeason } from "./season";

/**
 * Volunteer events for tests, written straight into the tables as the staff pages would have left them. Dates are
 * counted from today in UTC (the club's zone until a test sets one), so an event `inDays` ahead is still to come
 * whenever the test runs.
 */
export const dayFromNow = (inDays: number) => calendarDayIn("UTC", new Date(Date.now() + inDays * 86_400_000));

export type SeedShift = { startsAt?: string; endsAt?: string; places?: number; role?: string | null; requirementIds?: string[]; cancelled?: boolean; checkinCode?: string };
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
    cancelledAt: s.cancelled ? new Date() : null, ...(s.checkinCode ? { checkinCode: s.checkinCode } : {}) }).returning();
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

/**
 * Confirmed credit, as a check-in or staff leave it: a check-in of one sign-up (by the guardian, or `staff_checkin`),
 * or volunteering done outside the portal toward one requirement, with a note only staff see.
 */
export async function seedCheckIn(o: { signupId: string; familyQboId: string; by: string; minutes?: number; kind?: "checkin" | "staff_checkin"; removed?: { by: string; reason: string } }) {
  const [row] = await db.insert(volunteerCredit).values({ kind: o.kind ?? "checkin", signupId: o.signupId, familyQboId: o.familyQboId, minutes: o.minutes ?? 180, shifts: 1,
    createdByDoor: (o.kind ?? "checkin") === "checkin" ? "parent" : "staff", createdBy: o.by,
    ...(o.removed ? { removedAt: new Date(), removedBy: o.removed.by, removedReason: o.removed.reason } : {}) }).returning();
  return row!;
}
export async function seedOutsideCredit(o: { familyQboId: string; requirementId: string; studentQboId?: string; minutes?: number; shifts?: number; note?: string; by?: string }) {
  const [row] = await db.insert(volunteerCredit).values({ kind: "outside", familyQboId: o.familyQboId, studentQboId: o.studentQboId ?? null, requirementId: o.requirementId,
    minutes: o.minutes ?? 0, shifts: o.shifts ?? 0, note: o.note ?? "Helped at the spring concert", createdByDoor: "staff", createdBy: o.by ?? "00000000-0000-4000-8000-00000000c0de" }).returning();
  return row!;
}

/** The event seedTwoFamilies() gives the club: its name and shift are the club's, shown to everyone. */
export const TWO_FAMILY_EVENT = "Marching band car wash";
/** The optional volunteer requirement seedTwoFamilies() adds to its season's last step, in hours: the shared shift counts toward it. */
export const TWO_FAMILY_HOURS = "Spring volunteer hours";

export type FamilyVolunteer = {
  /** The shift both families are signed up for, and its check-in code. */
  shiftId: string; code: string;
  /** Strings that belong to this family's sign-up and credit alone: their ids, a staff note. */
  markers: string[];
  /** What this family's parent must find on the Volunteer page: the event, the count every family sees, and their own sign-up and credit. */
  page: string[];
  /** What this family's parent must find on the shift's check-in page: their own person on it, and whether checked in. */
  checkIn: string[];
  /** What staff wrote for staff (an outside credit's note): no parent page shows it, the family's own included. */
  staffOnly: string[];
};

/**
 * One event with one shift of four places, and both families signed up for it (v1 spec §12 invariant 7): family A
 * signs up its first student, family B its parent. Each parent must see the count, "2 of 4 places filled", and their
 * own sign-up, and nothing of the other's. With the season (seedTwoFamilySeason), the shift counts toward an optional
 * volunteer requirement in its last step (TWO_FAMILY_HOURS, six hours each family); A's student is checked in, and B
 * has two hours done outside the portal, credited by staff with a note only staff see (v1 spec §12 invariant 8).
 */
export async function seedTwoFamilyVolunteering(a: { spec: ParentFamilySpec; parentId: string }, b: { spec: ParentFamilySpec; parentId: string }, season?: SeededSeason): Promise<{ a: FamilyVolunteer; b: FamilyVolunteer }> {
  const stepId = season ? Object.values(season.stepIds).at(-1) : undefined;
  const [hours] = stepId ? await db.insert(requirement).values({ stepId, kind: "volunteer", title: TWO_FAMILY_HOURS, required: false, appliesTo: "family", amount: 6, amountUnit: "hours",
    covers: "everyone", position: 99 }).returning() : [];
  const { shifts: [shift] } = await seedEvent({ name: TWO_FAMILY_EVENT, inDays: 20, location: "Bandroom parking lot",
    shifts: [{ startsAt: "09:00", endsAt: "12:00", places: 4, role: "Rinse crew", requirementIds: hours ? [hours.id] : [] }] });
  const student = a.spec.students[0]!;
  const forA = await seedSignup({ shiftId: shift!.id, familyQboId: a.spec.family.qboId, signedUpBy: a.parentId, student });
  const forB = await seedSignup({ shiftId: shift!.id, familyQboId: b.spec.family.qboId, signedUpBy: b.parentId, guardianName: b.spec.parent.name });
  const checkedIn = await seedCheckIn({ signupId: forA.id, familyQboId: a.spec.family.qboId, by: a.parentId });
  const note = "Drove the instrument trailer to state QB91";
  const outside = hours ? await seedOutsideCredit({ familyQboId: b.spec.family.qboId, requirementId: hours.id, minutes: 120, note }) : null;
  const page = [TWO_FAMILY_EVENT, "2 of 4 places filled"];
  return {
    a: { shiftId: shift!.id, code: shift!.checkinCode, markers: [forA.id, checkedIn.id], page: [...page, `${student.name} is doing this one`, "Checked in"],
      checkIn: [student.name, "Checked in"], staffOnly: [] },
    b: { shiftId: shift!.id, code: shift!.checkinCode, markers: [forB.id, ...(outside ? [outside.id, note, "Added by the club"] : [])],
      page: [...page, "You&#x27;re doing this one", ...(outside ? ["Added by the club", `2 hours toward ${TWO_FAMILY_HOURS}`] : [])],
      checkIn: ["You", "Not checked in yet"], staffOnly: outside ? [note] : [] },
  };
}
