// Privacy: the one module a parent's Volunteer pages read and write through (v1 spec §11.2, §12 invariant 7). The
// family is the session's (ctx.familyId, the app's own family record) and nothing else, only while that record is
// active, with its own active students (sessionFamily(), src/lib/families/session-family.ts; stage 3 of the app-owned
// families spec), and every sign-up is read and written by those records. No link to the accounting system is needed. Of other families a parent gets
// one number per shift, the places filled, and never a name, a sign-up or a count of their own. Every id from the
// browser (a shift, a sign-up, the student who fills a place, by the app's own id) is looked up within the session's
// family, or refused. It never imports a staff-only module (./setup.ts, src/lib/roster/queries.ts, the seasons'
// set-up and progress modules): tests/integration/page-guards.test.ts scans this file.
import "server-only";
import { and, asc, count, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { requirement, season, seasonStep, volunteerEvent, volunteerShift, volunteerShiftRequirement, volunteerSignup } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import type { ParentCtx } from "@/lib/guards";
import { activeFamilyOf, sessionFamily, studentsStillIn, type SessionFamily } from "@/lib/families/session-family";
import { sendMail } from "@/lib/mail/send";
import { takeRateLimit } from "@/lib/parents/rate-limit";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { isUuid } from "@/lib/seasons/ids";
import { isCovered, type Requirement, type SubjectId, type SubjectsAsked } from "@/lib/seasons/progress";
import { loadFacts, toRequirement } from "@/lib/seasons/recorded";
import { loadCovers } from "@/lib/seasons/season-rows";
import { calendarDayIn, getClubSettings } from "@/lib/settings/club";
import { beforeCutoff, clockOf, dateWords, instantWords, shiftInstants, shiftMinutes, shiftTimeWords } from "./clock";
import { correctedSignups, creditedSignups } from "./credit";
import { contactWords, signupConfirmation } from "./notices";
import { amountWords, shiftCredit, whoMustWords } from "./rules";
import { getVolunteerSettings } from "./settings";

export type ShiftState = "open" | "full" | "started";
export type MyShift = { id: string; timeWords: string; role: string | null; places: number; filled: number; state: ShiftState };
export type MyEvent = { id: string; name: string; onDate: string; dateWords: string; location: string; description: string; contact: string; shifts: MyShift[] };
export type MySignup = {
  id: string; shiftId: string; eventName: string; dateWords: string; timeWords: string; role: string | null; location: string; contact: string;
  /** "You" for the guardian looking, otherwise the name of whoever in the family fills it. */
  who: string;
  /** open: they can cancel here until `cancelUntil`; closed: the cut-off has passed; cancelled: the club cancelled the shift or the event. */
  cancel: "open" | "closed" | "cancelled"; cancelUntil: string | null;
  /** Checked in with the shift's code, or added by staff: credit now, and no longer cancelled here. */
  checkedIn: boolean;
  /** The shift has begun (and not yet ended): what is left to do is check in there, not cancel. */
  started: boolean;
  /** Staff removed this place's check-in: scanning the code can't check it in again, only staff can (check-in.ts). */
  corrected: boolean;
};
export type MyVolunteering = { events: MyEvent[]; signups: MySignup[]; cutoffHours: number };

type EventRow = typeof volunteerEvent.$inferSelect;
type ShiftRow = typeof volunteerShift.$inferSelect;

/** How many places are taken on each of these shifts, by anyone: the one number about other families a parent is given. */
async function filledOn(shiftIds: string[], tx?: Tx): Promise<Map<string, number>> {
  if (shiftIds.length === 0) return new Map();
  const rows = await (tx ?? db).select({ shiftId: volunteerSignup.shiftId, n: count() }).from(volunteerSignup)
    .where(and(inArray(volunteerSignup.shiftId, shiftIds), isNull(volunteerSignup.cancelledAt))).groupBy(volunteerSignup.shiftId);
  return new Map(rows.map((r) => [r.shiftId, r.n]));
}

const stateOf = (start: Date, places: number, filled: number, now: Date): ShiftState => (start.getTime() <= now.getTime() ? "started" : filled >= places ? "full" : "open");
const myShift = (e: EventRow, s: ShiftRow, filled: number, zone: string, now: Date): MyShift => ({
  id: s.id, timeWords: shiftTimeWords(clockOf(s.startsAt), clockOf(s.endsAt)), role: s.role, places: s.places, filled,
  state: stateOf(shiftInstants(e.onDate, s.startsAt, s.endsAt, zone).start, s.places, filled, now),
});
const myEvent = (e: EventRow, shifts: MyShift[]): MyEvent => ({ id: e.id, name: e.name, onDate: e.onDate, dateWords: dateWords(e.onDate), location: e.location,
  description: e.description, contact: contactWords(e), shifts });
const whoWords = (ctx: Pick<ParentCtx, "parentId">, s: typeof volunteerSignup.$inferSelect) => (s.fillerKind === "guardian" && s.fillerParentId === ctx.parentId ? "You" : s.fillerName);

/**
 * The club's upcoming volunteer events, each with its shifts that haven't ended and how many places each has filled,
 * and the family's own sign-ups for shifts that haven't ended. An event shows while any of its shifts is still to
 * end; a cancelled event or shift is not offered, though a sign-up for one says the club cancelled it. A session whose
 * family has no active app record sees the events and no sign-ups.
 */
export async function loadMyVolunteering(ctx: Pick<ParentCtx, "familyId" | "parentId">, now: Date = new Date()): Promise<MyVolunteering> {
  const [{ timeZone: zone }, { cutoffHours }] = await Promise.all([getClubSettings(), getVolunteerSettings()]);
  // From the day before the club's today: a shift that started yesterday evening can still be going on.
  const from = calendarDayIn(zone, new Date(now.getTime() - 86_400_000));
  const events = await db.select().from(volunteerEvent).where(and(isNull(volunteerEvent.cancelledAt), gte(volunteerEvent.onDate, from)))
    .orderBy(asc(volunteerEvent.onDate), asc(volunteerEvent.createdAt));
  const shifts = events.length === 0 ? [] : await db.select().from(volunteerShift)
    .where(and(inArray(volunteerShift.eventId, events.map((e) => e.id)), isNull(volunteerShift.cancelledAt)))
    // Then by id: an event's copy makes all its shifts in one transaction, at one time, and two may start together.
    .orderBy(asc(volunteerShift.startsAt), asc(volunteerShift.createdAt), asc(volunteerShift.id));
  const ongoing = shifts.filter((s) => shiftInstants(events.find((e) => e.id === s.eventId)!.onDate, s.startsAt, s.endsAt, zone).end.getTime() > now.getTime());
  const filled = await filledOn(ongoing.map((s) => s.id));
  const listed = events.map((e) => myEvent(e, ongoing.filter((s) => s.eventId === e.id).map((s) => myShift(e, s, filled.get(s.id) ?? 0, zone, now)))).filter((e) => e.shifts.length > 0);

  // The family's own sign-ups, and only those: the session's family, as its app record, is the only one asked about.
  const familyId = await activeFamilyOf(ctx.familyId);
  if (familyId === null) return { events: listed, signups: [], cutoffHours };
  const mine = await db.select({ s: volunteerSignup, shift: volunteerShift, event: volunteerEvent }).from(volunteerSignup)
    .innerJoin(volunteerShift, eq(volunteerShift.id, volunteerSignup.shiftId)).innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
    .where(and(eq(volunteerSignup.familyId, familyId), isNull(volunteerSignup.cancelledAt), gte(volunteerEvent.onDate, from)))
    .orderBy(asc(volunteerEvent.onDate), asc(volunteerShift.startsAt), asc(volunteerSignup.createdAt));
  // A student who has moved to another family, or is no longer active, takes their sign-ups with them: the family
  // they were signed up from no longer sees or cancels them.
  const stillOurs = await studentsStillIn(familyId, mine.flatMap(({ s }) => (s.studentId ? [s.studentId] : [])));
  const credited = await creditedSignups(mine.map(({ s }) => s.id));
  const corrected = await correctedSignups(mine.map(({ s }) => s.id));
  const signups = mine.flatMap(({ s, shift, event }) => {
    const { start, end } = shiftInstants(event.onDate, shift.startsAt, shift.endsAt, zone);
    if (end.getTime() <= now.getTime() || (s.studentId !== null && !stillOurs.has(String(s.studentId)))) return [];
    const checkedIn = credited.has(s.id);
    const cancelled = shift.cancelledAt !== null || event.cancelledAt !== null, open = !cancelled && !checkedIn && beforeCutoff(start, cutoffHours, now);
    return [{ id: s.id, shiftId: shift.id, eventName: event.name, dateWords: dateWords(event.onDate), timeWords: shiftTimeWords(clockOf(shift.startsAt), clockOf(shift.endsAt)),
      role: shift.role, location: event.location, contact: contactWords(event), who: whoWords(ctx, s),
      cancel: cancelled ? "cancelled" as const : open ? "open" as const : "closed" as const,
      cancelUntil: open ? instantWords(new Date(start.getTime() - cutoffHours * 3_600_000), zone) : null, checkedIn, started: start.getTime() <= now.getTime(),
      corrected: !checkedIn && corrected.has(s.id) }];
  });
  return { events: listed, signups, cutoffHours };
}

/* ---- One shift, for signing up ---- */

/** One requirement a place would count toward, as a guardian reads it before confirming. */
export type CountsToward = { title: string; whoMust: string; counts: string; standing: string };
/** Someone who could fill the place: "me" (the guardian looking) or one of the family's students, by the app's own id. */
export type FillChoice = { value: string; label: string; taken: boolean; countsToward: CountsToward[] };
export type ShiftForMe = { event: MyEvent; shift: MyShift; minutes: number; mine: { who: string; checkedIn: boolean }[]; choices: FillChoice[] };

/**
 * One shift as the signed-in family sees it before signing up: the event, the places filled, who in the family is
 * already on it, and for each person who could fill a place, the requirements of the current season it would count
 * toward for them, with how much it counts and where they stand. Null for a shift that isn't offered (unknown,
 * cancelled, or its event cancelled), or a session whose family record is not active, which the page answers with a
 * 404. The students who could fill a place are the family's own active students (sessionFamily()).
 */
export async function loadShiftForMe(ctx: Pick<ParentCtx, "familyId" | "parentId" | "name">, shiftId: string, now: Date = new Date()): Promise<ShiftForMe | null> {
  if (!isUuid(shiftId)) return null;
  const [row] = await db.select({ shift: volunteerShift, event: volunteerEvent }).from(volunteerShift).innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
    .where(and(eq(volunteerShift.id, shiftId), isNull(volunteerShift.cancelledAt), isNull(volunteerEvent.cancelledAt)));
  if (!row) return null;
  const mineFamily = await sessionFamily(ctx.familyId);
  if (!mineFamily) return null;
  const zone = (await getClubSettings()).timeZone;
  const { shift, event } = row;
  const filled = (await filledOn([shift.id])).get(shift.id) ?? 0;
  const view = myShift(event, shift, filled, zone, now);
  const minutes = shiftMinutes(shiftInstants(event.onDate, shift.startsAt, shift.endsAt, zone));

  const { familyId, students } = mineFamily;
  const studentIds = students.map((s) => s.id);
  // The family's own places, and any place one of its students holds now: a student who moved in may already hold one
  // taken from their old family, which can't be taken twice. Of such a place nothing but that is said.
  const onShift = await db.select().from(volunteerSignup)
    .where(and(eq(volunteerSignup.shiftId, shift.id), isNull(volunteerSignup.cancelledAt),
      studentIds.length > 0 ? or(eq(volunteerSignup.familyId, familyId), inArray(volunteerSignup.studentId, studentIds)) : eq(volunteerSignup.familyId, familyId)))
    .orderBy(asc(volunteerSignup.createdAt));
  const ours = new Set(studentIds.map(String));
  const isOurs = (t: typeof volunteerSignup.$inferSelect) => String(t.familyId) === String(familyId) && (t.studentId === null || ours.has(String(t.studentId)));
  const counted = await countsTowardFor(mineFamily, shift.id, minutes);
  const choices: FillChoice[] = [
    { value: "me", label: `Me (${ctx.name})`, taken: onShift.some((t) => isOurs(t) && t.fillerKind === "guardian" && t.fillerParentId === ctx.parentId), countsToward: counted(null) },
    ...students.map((s) => ({ value: String(s.id), label: s.name, taken: onShift.some((t) => t.fillerKind === "student" && String(t.studentId) === String(s.id)), countsToward: counted(s) })),
  ];
  const mine = onShift.filter(isOurs);
  const credited = await creditedSignups(mine.map((t) => t.id));
  return { event: myEvent(event, [view]), shift: view, minutes, mine: mine.map((t) => ({ who: whoWords(ctx, t), checkedIn: credited.has(t.id) })), choices };
}

/**
 * For each person who could fill a place on this shift, the current season's requirements it counts toward for them:
 * the family's own (anyone in it can meet them) for everyone, and a student's own for that student. Only requirements
 * the club asks of this family or that student; a chosen list is read for them alone.
 */
async function countsTowardFor(family: SessionFamily, shiftId: string, minutes: number): Promise<(student: { id: SubjectId; name: string } | null) => CountsToward[]> {
  const rows = await db.select({ r: requirement }).from(volunteerShiftRequirement)
    .innerJoin(requirement, eq(requirement.id, volunteerShiftRequirement.requirementId)).innerJoin(seasonStep, eq(seasonStep.id, requirement.stepId)).innerJoin(season, eq(season.id, seasonStep.seasonId))
    .where(and(eq(volunteerShiftRequirement.shiftId, shiftId), eq(season.isCurrent, true), eq(requirement.kind, "volunteer")))
    .orderBy(asc(seasonStep.position), asc(requirement.position));
  if (rows.length === 0) return () => [];
  const asked: SubjectsAsked = { families: [family.familyId], students: family.students.map((s) => s.id) };
  const covers = await loadCovers(rows.filter((x) => x.r.covers === "chosen").map((x) => x.r.id), asked);
  const requirements: Requirement[] = rows.map((x) => toRequirement(x.r, covers.get(x.r.id) ?? []));
  const { facts } = await loadFacts(requirements, asked, { amounts: "fresh", parentId: null }); // volunteer requirements only
  const line = (r: Requirement, subject: SubjectId, studentName: string | null): CountsToward => ({
    title: r.title, whoMust: whoMustWords(r, studentName), counts: amountWords(r.amountUnit, shiftCredit(r, minutes)), standing: facts.standing(r, subject).words,
  });
  return (student) => {
    const own = requirements.filter((r) => r.appliesTo === "family" && isCovered(r, family.familyId)).map((r) => line(r, family.familyId, null));
    const theirs = student ? requirements.filter((r) => r.appliesTo === "student" && isCovered(r, student.id)).map((r) => line(r, student.id, student.name)) : [];
    return [...own, ...theirs];
  };
}

/* ---- Signing up and cancelling ---- */

export type Result = { ok: true; message: string } | { ok: false; errors: string[] };
const no = (...errors: string[]): Result => ({ ok: false, errors });
const NOT_OFFERED = "That shift isn't open for sign-up any more. Reload the page to see what's open.";
const NOT_FROM_PAGE = "That didn't go through. Reload the page and try again.";
const RATE_LIMITED = "That's a lot of sign-ups in a few minutes. Please wait a little, then try again.";
const NOT_SET_UP = "Your family isn't set up in the portal yet, so you can't sign up here. Please ask the club.";

/**
 * Takes one place on a shift for the signed-in guardian or one of the family's active students (`who`: "me", or the
 * student's app id as the page was given it, looked up among the family's own active students and checked again under
 * the lock: a student's id is the same in every family). The shift row is locked for the length of the transaction, so two people
 * taking the last place at the same moment are put one after the other: the first gets it, the second is told the
 * shift is full. The roster lock is held too, shared, so no staff roster write (which may change a student's record) or
 * change of QuickBooks company runs between the check that the family and the student are its own and the write.
 * After the write, the guardian gets a confirmation with a calendar file.
 */
export async function signUpForShift(ctx: ParentCtx, shiftId: unknown, who: unknown, now: Date = new Date()): Promise<Result> {
  if (!isUuid(shiftId) || (who !== "me" && !isUuid(who))) return no(NOT_FROM_PAGE);
  // Each place taken emails the guardian: a page pressed again and again would fill their mailbox.
  const take = await takeRateLimit("volunteer_signup_parent", ctx.parentId);
  if (take === "first_refusal") await writeAudit({ actor: { door: "parent", id: ctx.parentId, label: ctx.email }, action: "volunteer.signup.refused", targetType: "parent", targetId: ctx.parentId, after: { code: "rate_limited" }, ip: ctx.ip });
  if (take !== "taken") return no(RATE_LIMITED);
  const mineFamily = await sessionFamily(ctx.familyId);
  if (!mineFamily) return no(NOT_SET_UP);
  const student = who === "me" ? null : mineFamily.students.find((s) => String(s.id) === who) ?? null;
  if (who !== "me" && !student) return no(NOT_FROM_PAGE);
  const [{ timeZone: zone }, { cutoffHours }] = await Promise.all([getClubSettings(), getVolunteerSettings()]);
  const done = await takePlace(async (tx) => {
    // Beside the roster's writers, never between them: a refresh or a change of company holds this lock alone.
    await tx.execute(sql`set local lock_timeout = '10s'`);
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${ROSTER_LOCK})`);
    // Checked again under the lock: the family is still the session's own active record, and the student still in it.
    const familyId = await activeFamilyOf(ctx.familyId, tx);
    if (familyId === null || String(familyId) !== String(mineFamily.familyId)) return { r: no(NOT_FROM_PAGE) };
    if (student && !(await studentsStillIn(familyId, [student.id], tx)).has(String(student.id))) return { r: no(NOT_FROM_PAGE) };
    const [shift] = await tx.select().from(volunteerShift).where(eq(volunteerShift.id, shiftId)).for("update");
    const [event] = shift ? await tx.select().from(volunteerEvent).where(eq(volunteerEvent.id, shift.eventId)) : [];
    if (!shift || !event || shift.cancelledAt || event.cancelledAt) return { r: no(NOT_OFFERED) };
    const { start } = shiftInstants(event.onDate, shift.startsAt, shift.endsAt, zone);
    if (start.getTime() <= now.getTime()) return { r: no("That shift has started, so it's too late to sign up for it.") };
    const filled = (await filledOn([shift.id], tx)).get(shift.id) ?? 0;
    if (filled >= shift.places) return { r: no("Sorry, that shift is full now.") };
    const [already] = await tx.select({ id: volunteerSignup.id }).from(volunteerSignup).where(and(eq(volunteerSignup.shiftId, shift.id), isNull(volunteerSignup.cancelledAt),
      student ? eq(volunteerSignup.studentId, student.id) : and(eq(volunteerSignup.fillerKind, "guardian"), eq(volunteerSignup.fillerParentId, ctx.parentId))));
    if (already) return { r: no(student ? `${student.name} is signed up for this shift already.` : "You're signed up for this shift already.") };
    // One person can't be in two places at once: a place on another live shift whose time overlaps this one is refused.
    const { end } = shiftInstants(event.onDate, shift.startsAt, shift.endsAt, zone);
    const holding = await tx.select({ onDate: volunteerEvent.onDate, startsAt: volunteerShift.startsAt, endsAt: volunteerShift.endsAt }).from(volunteerSignup)
      .innerJoin(volunteerShift, eq(volunteerShift.id, volunteerSignup.shiftId)).innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
      .where(and(isNull(volunteerSignup.cancelledAt), isNull(volunteerShift.cancelledAt), isNull(volunteerEvent.cancelledAt),
        student ? eq(volunteerSignup.studentId, student.id) : and(eq(volunteerSignup.fillerKind, "guardian"), eq(volunteerSignup.fillerParentId, ctx.parentId))));
    const overlaps = holding.some((h) => { const other = shiftInstants(h.onDate, h.startsAt, h.endsAt, zone); return other.start.getTime() < end.getTime() && start.getTime() < other.end.getTime(); });
    if (overlaps) return { r: no(student ? `${student.name} is signed up for another shift at that time.` : "You're signed up for another shift at that time.") };
    const [made] = await tx.insert(volunteerSignup).values({
      shiftId: shift.id, familyId, signedUpBy: ctx.parentId, fillerKind: student ? "student" : "guardian",
      fillerParentId: student ? null : ctx.parentId, studentId: student?.id ?? null, fillerName: student?.name ?? ctx.name,
    }).returning();
    await writeAudit({ actor: { door: "parent", id: ctx.parentId, label: ctx.email }, action: "volunteer.signup.create", targetType: "volunteer_signup", targetId: made!.id, ip: ctx.ip,
      after: { familyId: String(familyId), shiftId: shift.id, event: event.name, onDate: event.onDate, startsAt: clockOf(shift.startsAt),
        filler: student ? { studentId: String(student.id), name: student.name } : { parentId: ctx.parentId, name: ctx.name } } }, tx);
    return { r: { ok: true as const, message: "" }, signupId: made!.id, event, shift };
  });
  if (done === "busy") return no(ROSTER_BUSY);
  if (!done.r.ok || !("signupId" in done)) return done.r;
  const mail = await signupConfirmation({ signupId: done.signupId!, to: ctx.email, who: student ? { self: false, name: student.name } : { self: true } },
    { event: done.event!, shift: { startsAt: clockOf(done.shift!.startsAt), endsAt: clockOf(done.shift!.endsAt), role: done.shift!.role, revision: done.shift!.revision } }, { zone, cutoffHours, now });
  const sent = await sendMail(mail, { purpose: "volunteer_confirm", actor: { door: "parent", id: ctx.parentId, label: ctx.email }, ip: ctx.ip });
  const whoDone = student ? `${student.name} is signed up` : "You're signed up";
  return { ok: true, message: sent.ok ? `${whoDone}. Thank you! We've emailed you the details, with a calendar file.` : `${whoDone}. Thank you! We couldn't send the email with the details just now; they're on this page.` };
}

export const ROSTER_BUSY = "The club is updating its list of families. Please try again in a minute.";
/** Postgres could not take a lock in time (lock_not_available). Drizzle wraps the driver's error, so its cause is read too. */
const lockNotAvailable = (e: unknown): boolean => {
  const code = (v: unknown) => (typeof v === "object" && v !== null ? (v as { code?: unknown }).code : undefined);
  return code(e) === "55P03" || code((e as { cause?: unknown } | null)?.cause) === "55P03";
};
/** The sign-up's transaction, or "busy" when the roster lock wasn't free in time: a refresh of the roster is reading QuickBooks. */
export async function takePlace<T>(work: (tx: Tx) => Promise<T>): Promise<T | "busy"> {
  try {
    return await db.transaction(work);
  } catch (e) {
    if (lockNotAvailable(e)) return "busy";
    throw e;
  }
}

/**
 * Cancels one of the family's own sign-ups, until the club's cut-off before the shift starts. A sign-up id that isn't
 * the session family's own is answered as one that isn't there, whoever it belongs to.
 */
export async function cancelMySignup(ctx: ParentCtx, signupId: unknown, now: Date = new Date()): Promise<Result> {
  if (!isUuid(signupId)) return no(NOT_FROM_PAGE);
  const [{ timeZone: zone }, { cutoffHours }] = await Promise.all([getClubSettings(), getVolunteerSettings()]);
  const GONE = "That sign-up isn't there any more. Reload the page.";
  return db.transaction(async (tx) => {
    const familyId = await activeFamilyOf(ctx.familyId, tx);
    if (familyId === null) return no(GONE);
    const [s] = await tx.select().from(volunteerSignup)
      .where(and(eq(volunteerSignup.id, signupId), eq(volunteerSignup.familyId, familyId), isNull(volunteerSignup.cancelledAt))).for("update");
    if (!s || (s.studentId !== null && !(await studentsStillIn(familyId, [s.studentId], tx)).has(String(s.studentId)))) return no(GONE);
    const [row] = await tx.select({ shift: volunteerShift, event: volunteerEvent }).from(volunteerShift).innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId)).where(eq(volunteerShift.id, s.shiftId));
    const { shift, event } = row!;
    if (shift.cancelledAt || event.cancelledAt) return no("The club has cancelled this shift, so there's nothing to cancel.");
    // A place checked in is volunteering done: it isn't given up here.
    if ((await creditedSignups([s.id], tx)).has(s.id)) return no("This place is checked in already, so it can't be cancelled. Thank you for helping!");
    const { start } = shiftInstants(event.onDate, shift.startsAt, shift.endsAt, zone);
    if (!beforeCutoff(start, cutoffHours, now)) {
      return no(`It's too late to cancel here: cancelling closes ${cutoffHours} ${cutoffHours === 1 ? "hour" : "hours"} before the shift. Please contact ${contactWords(event)}.`);
    }
    await tx.update(volunteerSignup).set({ cancelledAt: now, cancelledByDoor: "parent", cancelledBy: ctx.parentId }).where(eq(volunteerSignup.id, s.id));
    await writeAudit({ actor: { door: "parent", id: ctx.parentId, label: ctx.email }, action: "volunteer.signup.cancel", targetType: "volunteer_signup", targetId: s.id, ip: ctx.ip,
      before: { familyId: String(s.familyId), shiftId: s.shiftId, event: event.name, onDate: event.onDate, fillerName: s.fillerName }, after: { cancelled: true } }, tx);
    return { ok: true as const, message: `Cancelled, so ${s.fillerKind === "guardian" && s.fillerParentId === ctx.parentId ? "your" : `${s.fillerName}'s`} place is free for someone else. Thanks for letting us know! If it's in your calendar, you can delete it there.` };
  });
}
