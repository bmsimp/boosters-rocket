import "server-only";
import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { volunteerEvent, volunteerShift, volunteerSignup } from "@/lib/db/schema";
import { clubToday, getClubSettings } from "@/lib/settings/club";
import { formsWaiting } from "@/lib/forms/job";
import { evidenceHealth } from "@/lib/signed-forms/evidence-job";
import { loadMatrix } from "@/lib/signed-forms/matrix";
import { shiftInstants } from "@/lib/volunteer/clock";

/**
 * The counts on the staff home (what needs doing today). Each reads every family, so this module is for staff pages
 * only (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts), and it returns counts alone: no name, no id. Like
 * the other lists of many families, showing them is not audited.
 */

const DAY_MS = 86_400_000;
/** How far ahead "near" reaches: a form due within this many days, a shift starting within them. */
export const SOON_DAYS = 7;

/** A calendar day plus whole days, as a calendar day. */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Forms waiting too long: signed by everyone an hour ago and Documenso still hasn't sealed them (the Health page's
 * forms line counts the same), sealed an hour ago and the signed copy still not kept (evidence waiting), and this
 * season's forms due within a week, or already past due, that someone asked still hasn't signed.
 */
export async function formsToChase(now: Date = new Date()): Promise<{ sealingLate: number; evidenceLate: number; dueSoon: { forms: number; unsigned: number } }> {
  const [waiting, evidence, matrix, today] = await Promise.all([
    formsWaiting(now), evidenceHealth(now), loadMatrix({ formId: null, state: null, search: "" }), clubToday(now),
  ]);
  const horizon = addDays(today, SOON_DAYS);
  const due = matrix ? matrix.allForms.filter((f) => f.dueOn !== null && f.dueOn <= horizon && f.counts.needed > f.counts.signed) : [];
  return {
    sealingLate: waiting.sealingLate, evidenceLate: evidence.late,
    dueSoon: { forms: due.length, unsigned: due.reduce((sum, f) => sum + f.counts.needed - f.counts.signed, 0) },
  };
}

/**
 * Shifts that start within the next seven days and still have places to fill: the shifts and the places, counted as
 * the Volunteer page counts them (live sign-ups on a shift and event that aren't cancelled).
 */
export async function shiftsToFill(now: Date = new Date()): Promise<{ shifts: number; places: number }> {
  const [today, zone] = await Promise.all([clubToday(now), getClubSettings().then((c) => c.timeZone)]);
  // A shift can end the next morning, and a day in the club's zone is not the server's: a day either side, then instants.
  const shifts = await db.select({ id: volunteerShift.id, onDate: volunteerEvent.onDate, startsAt: volunteerShift.startsAt, endsAt: volunteerShift.endsAt, places: volunteerShift.places })
    .from(volunteerShift).innerJoin(volunteerEvent, eq(volunteerEvent.id, volunteerShift.eventId))
    .where(and(isNull(volunteerShift.cancelledAt), isNull(volunteerEvent.cancelledAt),
      gte(volunteerEvent.onDate, addDays(today, -1)), lte(volunteerEvent.onDate, addDays(today, SOON_DAYS + 1))));
  const soon = shifts.filter((s) => {
    const { start } = shiftInstants(s.onDate, s.startsAt, s.endsAt, zone);
    return start.getTime() > now.getTime() && start.getTime() <= now.getTime() + SOON_DAYS * DAY_MS;
  });
  if (soon.length === 0) return { shifts: 0, places: 0 };
  const filled = await db.select({ shiftId: volunteerSignup.shiftId, n: sql<number>`count(*)::int` }).from(volunteerSignup)
    .where(and(inArray(volunteerSignup.shiftId, soon.map((s) => s.id)), isNull(volunteerSignup.cancelledAt))).groupBy(volunteerSignup.shiftId);
  const open = soon.map((s) => Math.max(0, s.places - (filled.find((f) => f.shiftId === s.id)?.n ?? 0))).filter((n) => n > 0);
  return { shifts: open.length, places: open.reduce((a, b) => a + b, 0) };
}
