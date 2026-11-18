// Privacy: checking in at a volunteer shift (v1 spec §11.4, §12 invariant 8). A check-in code credits only the
// signed-in family's own sign-up, and only inside its window. The family is the session's (ctx.familyQboId) and
// nothing else, found as the app's own active family through its link (activeFamilyOf()): the code finds the shift,
// and on that shift only the family's own live sign-ups are read. The code and
// the sign-up id come from the browser and are untrusted; the window is checked again at the moment of writing. It
// imports no staff-only module (tests/integration/page-guards.test.ts scans this file).
import "server-only";
import { randomBytes } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { volunteerCredit, volunteerEvent, volunteerShift, volunteerSignup } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import type { ParentCtx } from "@/lib/guards";
import { activeFamilyOf, studentsStillIn } from "@/lib/families/session-family";
import type { AppFamilyId } from "@/lib/families/ids";
import { takeRateLimit } from "@/lib/parents/rate-limit";
import { parentActor } from "@/lib/parents/sessions";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { isUuid } from "@/lib/seasons/ids";
import { getClubSettings } from "@/lib/settings/club";
import { checkInWindow, clockOf, dateWords, instantWords, shiftInstants, shiftMinutes, shiftTimeWords } from "./clock";
import { correctedSignups, creditedSignups } from "./credit";
import { ROSTER_BUSY, takePlace, type Result } from "./my-volunteer";
import { contactWords } from "./notices";

/** A check-in code: 32 to 64 URL-safe characters. Made by newCheckInCode(), or by the database for a new shift. */
export const isCheckInCode = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(value);
/** A new check-in code: 192 random bits, URL-safe. Never the shift's id, which parents see in addresses. */
export const newCheckInCode = (): string => randomBytes(24).toString("base64url");
/** The address a shift's code opens, as staff print it: the portal's address, then /volunteer/check-in/ and the code. */
export const checkInAddress = (appUrl: string, code: string): string => `${appUrl.replace(/\/+$/, "")}/volunteer/check-in/${code}`;

/** `corrected`: staff removed this place's check-in, so the guardian can't check it in again; only staff can. */
export type CheckInPerson = { signupId: string; who: string; checkedIn: boolean; corrected: boolean };
/** before / open / closed: the window (30 minutes before the start until the end); cancelled: the club cancelled the shift or its event. */
export type CheckInState = "before" | "open" | "closed" | "cancelled";
export type CheckInView = {
  event: string; role: string | null; dateWords: string; timeWords: string; location: string;
  state: CheckInState;
  /** When check-in opens, in words, while it hasn't yet. */
  opensWords: string | null;
  /** The family's own people on this shift, and nobody else. */
  people: CheckInPerson[];
  /** Who to tell about a check-in that went wrong: the event's contact, as the club wrote it. */
  contact: string;
};

const whoOf = (ctx: Pick<ParentCtx, "parentId">, s: typeof volunteerSignup.$inferSelect) => (s.fillerKind === "guardian" && s.fillerParentId === ctx.parentId ? "You" : s.fillerName);

/** The family's own live sign-ups on a shift, whose student (if any) is still active and in the family. */
async function ourSignups(familyId: AppFamilyId, shiftId: string, only: string | null, tx?: Tx) {
  const rows = await (tx ?? db).select().from(volunteerSignup)
    .where(and(eq(volunteerSignup.shiftId, shiftId), eq(volunteerSignup.familyId, familyId), isNull(volunteerSignup.cancelledAt), only ? eq(volunteerSignup.id, only) : undefined))
    .orderBy(asc(volunteerSignup.createdAt));
  const stillOurs = await studentsStillIn(familyId, rows.flatMap((s) => (s.studentId ? [s.studentId] : [])), tx);
  return rows.filter((s) => s.studentId === null || stillOurs.has(String(s.studentId)));
}

/**
 * The shift a check-in code opens, as the signed-in family sees it: the event and the time, whether check-in is open,
 * and the family's own people on the shift with whether each is checked in. Null for a code that opens nothing (never
 * made, or replaced by a new one), which the page answers with a 404. Reading it records nothing.
 */
export async function loadCheckInForMe(ctx: Pick<ParentCtx, "familyQboId" | "parentId">, code: string, now: Date = new Date()): Promise<CheckInView | null> {
  if (!isCheckInCode(code)) return null;
  const [row] = await db.select({ shift: volunteerShift, event: volunteerEvent }).from(volunteerShift).innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
    .where(eq(volunteerShift.checkinCode, code));
  if (!row) return null;
  const { shift, event } = row;
  const zone = (await getClubSettings()).timeZone;
  const window = checkInWindow(shiftInstants(event.onDate, shift.startsAt, shift.endsAt, zone), now);
  const state: CheckInState = shift.cancelledAt || event.cancelledAt ? "cancelled" : window.state;
  const familyId = await activeFamilyOf(ctx.familyQboId);
  const mine = familyId === null ? [] : await ourSignups(familyId, shift.id, null);
  const credited = await creditedSignups(mine.map((s) => s.id));
  const corrected = await correctedSignups(mine.map((s) => s.id));
  return {
    event: event.name, role: shift.role, dateWords: dateWords(event.onDate), timeWords: shiftTimeWords(clockOf(shift.startsAt), clockOf(shift.endsAt)), location: event.location,
    state, opensWords: state === "before" ? instantWords(window.opensAt, zone) : null,
    people: mine.map((s) => ({ signupId: s.id, who: whoOf(ctx, s), checkedIn: credited.has(s.id), corrected: !credited.has(s.id) && corrected.has(s.id) })),
    contact: contactWords(event),
  };
}

const no = (...errors: string[]): Result => ({ ok: false, errors });
const NOT_FROM_PAGE = "That didn't go through. Reload the page and try again.";
const RATE_LIMITED = "That's a lot of check-ins in a few minutes. Please wait a little, then try again.";

/**
 * Checks in one of the family's own sign-ups on the shift this code opens (`which` is its id), or all of them
 * (`which` is "all"). The sign-up must be live, on that shift, and the session family's own; the shift and its event
 * must still be on; and it must be inside the window at this moment. Each sign-up is checked in at most once (a unique
 * index), so pressing twice gives one credit. The credit is the shift's length in minutes and one shift. Held beside
 * the roster lock, shared, so no change of company (which deletes every sign-up and credit) runs in between.
 */
export async function checkIn(ctx: ParentCtx, code: unknown, which: unknown, now: Date = new Date()): Promise<Result> {
  if (!isCheckInCode(code) || (which !== "all" && !isUuid(which))) return no(NOT_FROM_PAGE);
  const take = await takeRateLimit("volunteer_checkin_parent", ctx.parentId);
  if (take === "first_refusal") await writeAudit({ actor: parentActor({ id: ctx.parentId, email: ctx.email }), action: "volunteer.checkin.refused", targetType: "parent", targetId: ctx.parentId, after: { code: "rate_limited" }, ip: ctx.ip });
  if (take !== "taken") return no(RATE_LIMITED);
  const zone = (await getClubSettings()).timeZone;
  const done = await takePlace(async (tx): Promise<Result> => {
    await tx.execute(sql`set local lock_timeout = '10s'`);
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${ROSTER_LOCK})`);
    const [row] = await tx.select({ shift: volunteerShift, event: volunteerEvent }).from(volunteerShift).innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
      .where(eq(volunteerShift.checkinCode, code)).for("share", { of: volunteerShift });
    if (!row) return no(NOT_FROM_PAGE);
    const { shift, event } = row;
    if (shift.cancelledAt || event.cancelledAt) return no("The club cancelled this shift, so there's nothing to check in for.");
    const when = shiftInstants(event.onDate, shift.startsAt, shift.endsAt, zone);
    const window = checkInWindow(when, now);
    if (window.state === "before") return no(`Check-in for this shift opens ${instantWords(window.opensAt, zone)}, half an hour before it starts. Nothing was recorded.`);
    if (window.state === "closed") return no(`Check-in for this shift has closed: it's over. Nothing was recorded. If you helped and weren't checked in, please tell ${contactWords(event)}.`);
    // The session's family as its app record, read under the roster lock: no refresh moves anyone in between.
    const familyId = await activeFamilyOf(ctx.familyQboId, tx);
    if (familyId === null) return which === "all" ? no("Nobody in your family is signed up for this shift, so there's no one to check in.") : no(NOT_FROM_PAGE);
    const found = await ourSignups(familyId, shift.id, which === "all" ? null : which, tx);
    if (found.length === 0) return which === "all" ? no("Nobody in your family is signed up for this shift, so there's no one to check in.") : no(NOT_FROM_PAGE);
    // One at a time against anyone else checking in the same places, or cancelling them, then once each at most
    // (volunteer_credit_signup_uq). The locking read is the check: a place cancelled meanwhile is not checked in.
    const locked = await tx.select({ id: volunteerSignup.id }).from(volunteerSignup)
      .where(and(inArray(volunteerSignup.id, found.map((s) => s.id)), eq(volunteerSignup.familyId, familyId), isNull(volunteerSignup.cancelledAt))).for("update");
    const live = found.filter((s) => locked.some((l) => l.id === s.id));
    if (live.length === 0) return which === "all" ? no("Nobody in your family is signed up for this shift, so there's no one to check in.") : no(NOT_FROM_PAGE);
    // A place whose check-in staff removed stays as the club left it.
    const credited = await creditedSignups(live.map((s) => s.id), tx);
    const corrected = await correctedSignups(live.map((s) => s.id), tx);
    const ours = live.filter((s) => credited.has(s.id) || !corrected.has(s.id));
    if (ours.length === 0) return no(`The club has updated ${live.length === 1 ? "this check-in" : "these check-ins"}, so ${live.length === 1 ? "it can't" : "they can't"} be checked in again here. If something isn't right, please talk to ${contactWords(event)}.`);
    const minutes = shiftMinutes(when);
    const made = await tx.insert(volunteerCredit).values(ours.map((s) => ({
      kind: "checkin" as const, signupId: s.id, familyId, minutes, shifts: 1, createdByDoor: "parent" as const, createdBy: ctx.parentId,
    }))).onConflictDoNothing().returning();
    for (const c of made) {
      const s = ours.find((x) => x.id === c.signupId)!;
      await writeAudit({ actor: parentActor({ id: ctx.parentId, email: ctx.email }), action: "volunteer.checkin.create", targetType: "volunteer_credit", targetId: c.id, ip: ctx.ip,
        after: { familyId: String(familyId), signupId: s.id, shiftId: shift.id, event: event.name, onDate: event.onDate, fillerName: s.fillerName, minutes } }, tx);
    }
    if (made.length === 0) return { ok: true, message: ours.length === 1 ? "Already checked in. Thank you for helping!" : "Everyone here is checked in already. Thank you for helping!" };
    const names = made.map((c) => whoOf(ctx, ours.find((x) => x.id === c.signupId)!)).map((w) => (w === "You" ? "you" : w));
    return { ok: true, message: `Checked in: ${names.join(", ")}. Thank you for helping!` };
  });
  return done === "busy" ? no(ROSTER_BUSY) : done;
}
