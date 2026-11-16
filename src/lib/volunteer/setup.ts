// Staff only: volunteer events and shifts (v1 spec §11.1), and who has signed up for each shift. Every write is one
// transaction with its audit row; the emails a change calls for go after it is committed (./notices.ts). Never imported
// by parent code (tests/integration/page-guards.test.ts): a shift's list names people of every family.
import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { parent, qboCustomer, requirement, season, seasonStep, volunteerEvent, volunteerShift, volunteerShiftRequirement, volunteerSignup } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { isCalendarDate } from "@/lib/seasons/progress";
import { clubToday, getClubSettings } from "@/lib/settings/club";
import { normalizeEmail } from "@/lib/email";
import { clockOf, isClockTime, shiftInstants, shiftMinutes } from "./clock";
import { sendNotices, type Notice, type ShiftFacts, type SignupFacts } from "./notices";

export type VolunteerOp = { actor: Actor; ip: string | null; permission?: string };
export type Refused = { ok: false; errors: string[] };
type Done<T = object> = ({ ok: true } & T) | Refused;
const refuse = (...errors: string[]): Refused => ({ ok: false, errors });
const GONE = "That isn't there any more. Reload the page.";
const CANCELLED_EVENT = "This event is cancelled, so it can't be changed.";

export const NAME_MAX = 100, LOCATION_MAX = 200, DESCRIPTION_MAX = 2000, CONTACT_MAX = 100, ROLE_MAX = 60, PLACES_MAX = 500, SHIFTS_MAX = 30, LINKS_MAX = 20;

/* ---- Reading ---- */

export type EventSummary = { id: string; name: string; onDate: string; location: string; cancelled: boolean; shifts: number; places: number; filled: number };

/** Every event, those from the club's today on first (soonest first), then earlier ones (latest first). Counts leave out cancelled shifts. */
export async function listEvents(): Promise<{ upcoming: EventSummary[]; past: EventSummary[]; today: string }> {
  const [events, shifts, filled, today] = await Promise.all([
    db.select().from(volunteerEvent).orderBy(asc(volunteerEvent.onDate), asc(volunteerEvent.createdAt)),
    db.select({ eventId: volunteerShift.eventId, n: sql<number>`count(*)::int`, places: sql<number>`coalesce(sum(${volunteerShift.places}), 0)::int` })
      .from(volunteerShift).where(isNull(volunteerShift.cancelledAt)).groupBy(volunteerShift.eventId),
    db.select({ eventId: volunteerShift.eventId, n: sql<number>`count(*)::int` }).from(volunteerSignup)
      .innerJoin(volunteerShift, eq(volunteerShift.id, volunteerSignup.shiftId))
      .where(and(isNull(volunteerSignup.cancelledAt), isNull(volunteerShift.cancelledAt))).groupBy(volunteerShift.eventId),
    clubToday(),
  ]);
  const all = events.map((e) => ({ id: e.id, name: e.name, onDate: e.onDate, location: e.location, cancelled: e.cancelledAt !== null,
    shifts: shifts.find((s) => s.eventId === e.id)?.n ?? 0, places: shifts.find((s) => s.eventId === e.id)?.places ?? 0, filled: filled.find((f) => f.eventId === e.id)?.n ?? 0 }));
  return { upcoming: all.filter((e) => e.onDate >= today), past: all.filter((e) => e.onDate < today).reverse(), today };
}

export type StaffSignup = { id: string; fillerName: string; fillerKind: "guardian" | "student"; familyName: string; signedUpByName: string; signedUpAt: string };
export type StaffShift = {
  id: string; startsAt: string; endsAt: string; minutes: number; places: number; role: string | null; cancelled: boolean;
  requirementIds: string[]; signups: StaffSignup[];
};
export type EventSetup = {
  id: string; name: string; onDate: string; location: string; description: string; contactName: string; contactEmail: string | null; cancelled: boolean;
  copiedFrom: { id: string; name: string; onDate: string } | null; shifts: StaffShift[];
};

/** One event with its shifts, in order of their start, and each shift's sign-ups with names. Null when there is none. */
export async function getEventSetup(eventId: string): Promise<EventSetup | null> {
  const [e] = await db.select().from(volunteerEvent).where(eq(volunteerEvent.id, eventId));
  if (!e) return null;
  const [shifts, zone, [from]] = await Promise.all([
    db.select().from(volunteerShift).where(eq(volunteerShift.eventId, e.id)).orderBy(asc(volunteerShift.startsAt), asc(volunteerShift.createdAt)),
    getClubSettings().then((c) => c.timeZone),
    e.copiedFrom ? db.select({ id: volunteerEvent.id, name: volunteerEvent.name, onDate: volunteerEvent.onDate }).from(volunteerEvent).where(eq(volunteerEvent.id, e.copiedFrom)) : Promise.resolve([]),
  ]);
  const ids = shifts.map((s) => s.id);
  const [links, signups] = ids.length === 0 ? [[], []] : await Promise.all([
    db.select().from(volunteerShiftRequirement).where(inArray(volunteerShiftRequirement.shiftId, ids)),
    db.select({ s: volunteerSignup, familyName: qboCustomer.displayName, signerName: parent.name }).from(volunteerSignup)
      .leftJoin(qboCustomer, eq(qboCustomer.qboId, volunteerSignup.familyQboId))
      .leftJoin(parent, eq(parent.id, volunteerSignup.signedUpBy))
      .where(and(inArray(volunteerSignup.shiftId, ids), isNull(volunteerSignup.cancelledAt))).orderBy(asc(volunteerSignup.createdAt)),
  ]);
  return {
    id: e.id, name: e.name, onDate: e.onDate, location: e.location, description: e.description, contactName: e.contactName, contactEmail: e.contactEmail,
    cancelled: e.cancelledAt !== null, copiedFrom: from ?? null,
    shifts: shifts.map((s) => ({
      id: s.id, startsAt: clockOf(s.startsAt), endsAt: clockOf(s.endsAt), minutes: shiftMinutes(shiftInstants(e.onDate, s.startsAt, s.endsAt, zone)),
      places: s.places, role: s.role, cancelled: s.cancelledAt !== null,
      requirementIds: links.filter((l) => l.shiftId === s.id).map((l) => l.requirementId),
      signups: signups.filter((x) => x.s.shiftId === s.id).map((x) => ({ id: x.s.id, fillerName: x.s.fillerName, fillerKind: x.s.fillerKind,
        familyName: x.familyName ?? "A family no longer on the roster", signedUpByName: x.signerName ?? "A parent no longer in the portal", signedUpAt: x.s.createdAt.toISOString() })),
    })),
  };
}

export type RequirementChoice = { id: string; label: string; current: boolean; unit: "shifts" | "hours"; appliesTo: "family" | "student" };
/** Every volunteer requirement, the current season's first, for a shift to count toward: "Fall 2027 · Volunteer · Concessions". */
export async function volunteerRequirementChoices(): Promise<RequirementChoice[]> {
  const rows = await db.select({ id: requirement.id, title: requirement.title, unit: requirement.amountUnit, appliesTo: requirement.appliesTo, step: seasonStep.name, season: season.name, current: season.isCurrent })
    .from(requirement).innerJoin(seasonStep, eq(seasonStep.id, requirement.stepId)).innerJoin(season, eq(season.id, seasonStep.seasonId))
    .where(eq(requirement.kind, "volunteer")).orderBy(desc(season.isCurrent), desc(season.createdAt), asc(seasonStep.position), asc(requirement.position));
  return rows.map((r) => ({ id: r.id, label: `${r.season} · ${r.step} · ${r.title}`, current: r.current, unit: r.unit ?? "shifts", appliesTo: r.appliesTo }));
}

/** The shifts that count toward one requirement, with their events, for the staff requirement page. */
export async function shiftsCountingToward(requirementId: string): Promise<{ eventId: string; eventName: string; onDate: string; startsAt: string; endsAt: string; cancelled: boolean }[]> {
  const rows = await db.select({ eventId: volunteerEvent.id, eventName: volunteerEvent.name, onDate: volunteerEvent.onDate, startsAt: volunteerShift.startsAt, endsAt: volunteerShift.endsAt,
    shiftCancelled: volunteerShift.cancelledAt, eventCancelled: volunteerEvent.cancelledAt })
    .from(volunteerShiftRequirement).innerJoin(volunteerShift, eq(volunteerShift.id, volunteerShiftRequirement.shiftId)).innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
    .where(eq(volunteerShiftRequirement.requirementId, requirementId)).orderBy(asc(volunteerEvent.onDate), asc(volunteerShift.startsAt));
  return rows.map((r) => ({ eventId: r.eventId, eventName: r.eventName, onDate: r.onDate, startsAt: clockOf(r.startsAt), endsAt: clockOf(r.endsAt), cancelled: r.shiftCancelled !== null || r.eventCancelled !== null }));
}

/* ---- Checking what staff send ---- */

const clean = (raw: string, what: string, max: number, required = true): { ok: true; value: string } | Refused => {
  const value = raw.trim().replace(/[ \t]+/g, " ");
  if (!value && required) return refuse(`${what} is needed.`);
  if (value.length > max) return refuse(`${what} is too long (${max} characters at most).`);
  return { ok: true, value };
};

export type EventInput = { name: string; onDate: string; location: string; description: string; contactName: string; contactEmail: string };
type CleanEvent = { name: string; onDate: string; location: string; description: string; contactName: string; contactEmail: string | null };

function checkEvent(input: EventInput): { ok: true; value: CleanEvent } | Refused {
  const name = clean(input.name, "The event's name", NAME_MAX);
  const location = clean(input.location, "Where it is", LOCATION_MAX);
  const description = clean(input.description.replace(/\r\n/g, "\n"), "The description", DESCRIPTION_MAX, false);
  const contactName = clean(input.contactName, "Who to contact", CONTACT_MAX);
  const errors = [name, location, description, contactName].flatMap((r) => (r.ok ? [] : r.errors));
  if (!isCalendarDate(input.onDate)) errors.push("Enter the event's date as a day on the calendar.");
  const email = input.contactEmail.trim() === "" ? null : normalizeEmail(input.contactEmail);
  if (input.contactEmail.trim() !== "" && !email) errors.push("The contact's email address doesn't look right.");
  if (errors.length) return refuse(...errors);
  return { ok: true, value: { name: (name as { value: string }).value, onDate: input.onDate, location: (location as { value: string }).value,
    description: (description as { value: string }).value, contactName: (contactName as { value: string }).value, contactEmail: email } };
}

export type ShiftInput = { startsAt: string; endsAt: string; places: number; role: string; requirementIds: string[] };
type CleanShift = { startsAt: string; endsAt: string; places: number; role: string | null; requirementIds: string[] };

async function checkShift(input: ShiftInput, tx: Tx): Promise<{ ok: true; value: CleanShift } | Refused> {
  const errors: string[] = [];
  if (!isClockTime(input.startsAt) || !isClockTime(input.endsAt)) errors.push("Enter the start and the end as times of day.");
  else if (input.startsAt === input.endsAt) errors.push("The shift starts and ends at the same time. Check the two times.");
  if (!Number.isInteger(input.places) || input.places < 1 || input.places > PLACES_MAX) errors.push(`Say how many places: a whole number from 1 to ${PLACES_MAX}.`);
  const role = clean(input.role, "The role", ROLE_MAX, false);
  if (!role.ok) errors.push(...role.errors);
  const ids = [...new Set(input.requirementIds)];
  if (ids.length > LINKS_MAX) errors.push("That's too many requirements for one shift.");
  if (errors.length) return refuse(...errors);
  const found = ids.length === 0 ? [] : await tx.select({ id: requirement.id }).from(requirement).where(and(inArray(requirement.id, ids), eq(requirement.kind, "volunteer")));
  if (found.length !== ids.length) return refuse("A requirement in that list isn't there any more, or isn't a volunteering one. Reload the page and choose again.");
  return { ok: true, value: { startsAt: input.startsAt, endsAt: input.endsAt, places: input.places, role: (role as { value: string }).value || null, requirementIds: ids.sort() } };
}

/* ---- Who is told ---- */

type EventRow = typeof volunteerEvent.$inferSelect;
type ShiftRow = typeof volunteerShift.$inferSelect;
const factsOf = (e: Pick<EventRow, "name" | "onDate" | "location" | "description" | "contactName" | "contactEmail">, s: Pick<ShiftRow, "startsAt" | "endsAt" | "role" | "revision">): ShiftFacts => ({
  event: { name: e.name, onDate: e.onDate, location: e.location, description: e.description, contactName: e.contactName, contactEmail: e.contactEmail },
  shift: { startsAt: clockOf(s.startsAt), endsAt: clockOf(s.endsAt), role: s.role, revision: s.revision },
});

/** The live sign-ups on these shifts, each with the address of the guardian who took it and whose place it is. */
async function signupsOn(shiftIds: string[], tx: Tx): Promise<(SignupFacts & { shiftId: string })[]> {
  if (shiftIds.length === 0) return [];
  const rows = await tx.select({ id: volunteerSignup.id, shiftId: volunteerSignup.shiftId, fillerKind: volunteerSignup.fillerKind, fillerName: volunteerSignup.fillerName,
    fillerParentId: volunteerSignup.fillerParentId, signedUpBy: volunteerSignup.signedUpBy, email: parent.email })
    .from(volunteerSignup).innerJoin(parent, eq(parent.id, volunteerSignup.signedUpBy))
    .where(and(inArray(volunteerSignup.shiftId, shiftIds), isNull(volunteerSignup.cancelledAt)));
  return rows.map((r) => ({ shiftId: r.shiftId, signupId: r.id, to: r.email,
    who: r.fillerKind === "guardian" && r.fillerParentId === r.signedUpBy ? { self: true as const } : { self: false as const, name: r.fillerName } }));
}

const eventFacts = (e: EventRow) => ({ name: e.name, onDate: e.onDate, location: e.location, description: e.description, contactName: e.contactName, contactEmail: e.contactEmail });
const shiftFacts = (s: ShiftRow) => ({ startsAt: clockOf(s.startsAt), endsAt: clockOf(s.endsAt), places: s.places, role: s.role });

/** Sends what a committed change calls for, and says in a sentence who was told. */
async function tell(notices: Notice[], o: VolunteerOp, eventId: string): Promise<{ told: number; failed: number }> {
  if (notices.length === 0) return { told: 0, failed: 0 };
  const { sent, failed } = await sendNotices(notices, { zone: (await getClubSettings()).timeZone, actor: o.actor, ip: o.ip, targetId: eventId });
  return { told: sent, failed };
}

/* ---- Events ---- */

export async function createEvent(input: EventInput, o: VolunteerOp): Promise<Done<{ eventId: string }>> {
  const checked = checkEvent(input);
  if (!checked.ok) return checked;
  return db.transaction(async (tx) => {
    const [made] = await tx.insert(volunteerEvent).values(checked.value).returning();
    await writeAudit({ actor: o.actor, action: "volunteer.event.create", permission: o.permission, targetType: "volunteer_event", targetId: made!.id, ip: o.ip, after: eventFacts(made!) }, tx);
    return { ok: true as const, eventId: made!.id };
  });
}

/**
 * An event's details. A new date or place changes every shift's time or place, so everyone signed up for any of its
 * shifts is told by email, once the change is saved; the shifts' revisions go up for their calendar files.
 */
export async function updateEvent(eventId: string, input: EventInput, o: VolunteerOp): Promise<Done<{ told: number; failed: number }>> {
  const checked = checkEvent(input);
  if (!checked.ok) return checked;
  const r = await db.transaction(async (tx) => {
    const [e] = await tx.select().from(volunteerEvent).where(eq(volunteerEvent.id, eventId)).for("update");
    if (!e) return refuse(GONE);
    if (e.cancelledAt) return refuse(CANCELLED_EVENT);
    const moved = e.onDate !== checked.value.onDate || e.location !== checked.value.location;
    const [after] = await tx.update(volunteerEvent).set({ ...checked.value, updatedAt: new Date() }).where(eq(volunteerEvent.id, e.id)).returning();
    let notices: Notice[] = [];
    if (moved) {
      const shifts = await tx.select().from(volunteerShift).where(and(eq(volunteerShift.eventId, e.id), isNull(volunteerShift.cancelledAt))).for("update");
      const bumped = shifts.length === 0 ? [] : await tx.update(volunteerShift).set({ revision: sql`${volunteerShift.revision} + 1`, updatedAt: new Date() })
        .where(inArray(volunteerShift.id, shifts.map((s) => s.id))).returning();
      const signups = await signupsOn(shifts.map((s) => s.id), tx);
      notices = signups.map((s) => ({ kind: "change" as const, signup: s, before: factsOf(e, shifts.find((x) => x.id === s.shiftId)!), after: factsOf(after!, bumped.find((x) => x.id === s.shiftId)!) }));
    }
    await writeAudit({ actor: o.actor, action: "volunteer.event.update", permission: o.permission, targetType: "volunteer_event", targetId: e.id, ip: o.ip,
      before: eventFacts(e), after: { ...eventFacts(after!), ...(moved ? { signupsTold: notices.length } : {}) } }, tx);
    return { ok: true as const, notices };
  });
  if (!r.ok) return r;
  return { ok: true, ...(await tell(r.notices, o, eventId)) };
}

/** A copy of an event on another date ("every home game"): its details and its shifts that are still on, with their requirements. No sign-up is copied. */
export async function copyEvent(eventId: string, onDate: string, o: VolunteerOp): Promise<Done<{ eventId: string }>> {
  if (!isCalendarDate(onDate)) return refuse("Enter the new event's date as a day on the calendar.");
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(volunteerEvent).where(eq(volunteerEvent.id, eventId));
    if (!e) return refuse(GONE);
    const [made] = await tx.insert(volunteerEvent).values({ name: e.name, onDate, location: e.location, description: e.description, contactName: e.contactName, contactEmail: e.contactEmail, copiedFrom: e.id }).returning();
    const shifts = await tx.select().from(volunteerShift).where(and(eq(volunteerShift.eventId, e.id), isNull(volunteerShift.cancelledAt))).orderBy(asc(volunteerShift.startsAt));
    const links = shifts.length === 0 ? [] : await tx.select().from(volunteerShiftRequirement).where(inArray(volunteerShiftRequirement.shiftId, shifts.map((s) => s.id)));
    for (const s of shifts) {
      const [copy] = await tx.insert(volunteerShift).values({ eventId: made!.id, startsAt: s.startsAt, endsAt: s.endsAt, places: s.places, role: s.role }).returning({ id: volunteerShift.id });
      const mine = links.filter((l) => l.shiftId === s.id);
      if (mine.length) await tx.insert(volunteerShiftRequirement).values(mine.map((l) => ({ shiftId: copy!.id, requirementId: l.requirementId })));
    }
    await writeAudit({ actor: o.actor, action: "volunteer.event.copy", permission: o.permission, targetType: "volunteer_event", targetId: made!.id, ip: o.ip,
      after: { ...eventFacts(made!), copiedFrom: { id: e.id, name: e.name, onDate: e.onDate }, shifts: shifts.length } }, tx);
    return { ok: true as const, eventId: made!.id };
  });
}

/** Cancels an event and so every shift in it. Everyone signed up is told by email. It stays listed for staff, marked cancelled; parents no longer see it. */
export async function cancelEvent(eventId: string, o: VolunteerOp): Promise<Done<{ told: number; failed: number }>> {
  const r = await db.transaction(async (tx) => {
    const [e] = await tx.select().from(volunteerEvent).where(eq(volunteerEvent.id, eventId)).for("update");
    if (!e) return refuse(GONE);
    if (e.cancelledAt) return refuse("This event is cancelled already.");
    await tx.update(volunteerEvent).set({ cancelledAt: new Date(), cancelledBy: o.actor.id, updatedAt: new Date() }).where(eq(volunteerEvent.id, e.id));
    const shifts = await tx.select().from(volunteerShift).where(and(eq(volunteerShift.eventId, e.id), isNull(volunteerShift.cancelledAt))).for("update");
    const signups = await signupsOn(shifts.map((s) => s.id), tx);
    await writeAudit({ actor: o.actor, action: "volunteer.event.cancel", permission: o.permission, targetType: "volunteer_event", targetId: e.id, ip: o.ip,
      before: { ...eventFacts(e), cancelled: false }, after: { cancelled: true, shiftsOn: shifts.length, signupsTold: signups.length } }, tx);
    const notices: Notice[] = signups.map((s) => ({ kind: "cancel", signup: s, facts: factsOf(e, shifts.find((x) => x.id === s.shiftId)!), whole: "event" }));
    return { ok: true as const, notices };
  });
  if (!r.ok) return r;
  return { ok: true, ...(await tell(r.notices, o, eventId)) };
}

/* ---- Shifts ---- */

export async function addShift(eventId: string, input: ShiftInput, o: VolunteerOp): Promise<Done<{ shiftId: string }>> {
  return db.transaction(async (tx) => {
    const [e] = await tx.select().from(volunteerEvent).where(eq(volunteerEvent.id, eventId)).for("update");
    if (!e) return refuse(GONE);
    if (e.cancelledAt) return refuse(CANCELLED_EVENT);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(volunteerShift).where(eq(volunteerShift.eventId, e.id)) as [{ n: number }];
    if (n >= SHIFTS_MAX) return refuse(`An event can have ${SHIFTS_MAX} shifts at most.`);
    const checked = await checkShift(input, tx);
    if (!checked.ok) return checked;
    const { requirementIds, ...values } = checked.value;
    const [made] = await tx.insert(volunteerShift).values({ eventId: e.id, ...values }).returning();
    if (requirementIds.length) await tx.insert(volunteerShiftRequirement).values(requirementIds.map((requirementId) => ({ shiftId: made!.id, requirementId })));
    await writeAudit({ actor: o.actor, action: "volunteer.shift.add", permission: o.permission, targetType: "volunteer_shift", targetId: made!.id, ip: o.ip,
      after: { event: e.name, ...shiftFacts(made!), requirementIds } }, tx);
    return { ok: true as const, shiftId: made!.id };
  });
}

/**
 * A shift's times, places, role and requirements. Places can't go below the number already signed up: a shift is
 * never fuller than its places. A new start or end is emailed to everyone signed up for it, once saved.
 */
export async function updateShift(shiftId: string, input: ShiftInput, o: VolunteerOp): Promise<Done<{ told: number; failed: number }>> {
  const r = await db.transaction(async (tx) => {
    const [s] = await tx.select().from(volunteerShift).where(eq(volunteerShift.id, shiftId)).for("update");
    if (!s) return refuse(GONE);
    const [e] = await tx.select().from(volunteerEvent).where(eq(volunteerEvent.id, s.eventId));
    if (e!.cancelledAt) return refuse(CANCELLED_EVENT);
    if (s.cancelledAt) return refuse("This shift is cancelled, so it can't be changed.");
    const checked = await checkShift(input, tx);
    if (!checked.ok) return checked;
    const { requirementIds, ...values } = checked.value;
    const [{ n: taken }] = await tx.select({ n: sql<number>`count(*)::int` }).from(volunteerSignup).where(and(eq(volunteerSignup.shiftId, s.id), isNull(volunteerSignup.cancelledAt))) as [{ n: number }];
    if (values.places < taken) return refuse(`${taken} ${taken === 1 ? "person is" : "people are"} signed up for this shift, so it needs at least ${taken} ${taken === 1 ? "place" : "places"}.`);
    const moved = clockOf(s.startsAt) !== values.startsAt || clockOf(s.endsAt) !== values.endsAt;
    const [after] = await tx.update(volunteerShift).set({ ...values, revision: moved ? s.revision + 1 : s.revision, updatedAt: new Date() }).where(eq(volunteerShift.id, s.id)).returning();
    const beforeLinks = (await tx.select({ id: volunteerShiftRequirement.requirementId }).from(volunteerShiftRequirement).where(eq(volunteerShiftRequirement.shiftId, s.id))).map((l) => l.id).sort();
    await tx.delete(volunteerShiftRequirement).where(eq(volunteerShiftRequirement.shiftId, s.id));
    if (requirementIds.length) await tx.insert(volunteerShiftRequirement).values(requirementIds.map((requirementId) => ({ shiftId: s.id, requirementId })));
    const signups = moved ? await signupsOn([s.id], tx) : [];
    await writeAudit({ actor: o.actor, action: "volunteer.shift.update", permission: o.permission, targetType: "volunteer_shift", targetId: s.id, ip: o.ip,
      before: { ...shiftFacts(s), requirementIds: beforeLinks }, after: { ...shiftFacts(after!), requirementIds, ...(moved ? { signupsTold: signups.length } : {}) } }, tx);
    const notices: Notice[] = signups.map((x) => ({ kind: "change", signup: x, before: factsOf(e!, s), after: factsOf(e!, after!) }));
    return { ok: true as const, notices, eventId: e!.id };
  });
  if (!r.ok) return r;
  return { ok: true, ...(await tell(r.notices, o, r.eventId)) };
}

/** Cancels one shift. Everyone signed up for it is told by email; its places are no longer offered. */
export async function cancelShift(shiftId: string, o: VolunteerOp): Promise<Done<{ told: number; failed: number }>> {
  const r = await db.transaction(async (tx) => {
    const [s] = await tx.select().from(volunteerShift).where(eq(volunteerShift.id, shiftId)).for("update");
    if (!s) return refuse(GONE);
    const [e] = await tx.select().from(volunteerEvent).where(eq(volunteerEvent.id, s.eventId));
    if (e!.cancelledAt) return refuse("This event is cancelled already, and its shifts with it.");
    if (s.cancelledAt) return refuse("This shift is cancelled already.");
    await tx.update(volunteerShift).set({ cancelledAt: new Date(), cancelledBy: o.actor.id, updatedAt: new Date() }).where(eq(volunteerShift.id, s.id));
    const signups = await signupsOn([s.id], tx);
    await writeAudit({ actor: o.actor, action: "volunteer.shift.cancel", permission: o.permission, targetType: "volunteer_shift", targetId: s.id, ip: o.ip,
      before: { event: e!.name, ...shiftFacts(s), cancelled: false }, after: { cancelled: true, signupsTold: signups.length } }, tx);
    const notices: Notice[] = signups.map((x) => ({ kind: "cancel", signup: x, facts: factsOf(e!, s), whole: "shift" }));
    return { ok: true as const, notices, eventId: e!.id };
  });
  if (!r.ok) return r;
  return { ok: true, ...(await tell(r.notices, o, r.eventId)) };
}
