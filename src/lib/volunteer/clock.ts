/**
 * Volunteer time, as pure functions. An event's date and a shift's times are the club's own wall-clock time ("Saturday,
 * 6:00 pm"), stored as a calendar date and two clock times and read in the club's time zone (src/lib/settings/club.ts)
 * whenever an instant is needed: whether a shift has started, the cancelling cut-off, a calendar file. Nothing here
 * reads the clock or the database: callers pass the zone and the time it is.
 */

/** A clock time as the portal keeps it: "HH:MM", 24-hour. */
export function isClockTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** "18:00:00" (as Postgres gives a time) or "18:00" read as "18:00". */
export const clockOf = (value: string): string => value.slice(0, 5);

const wallParts = (zone: string, at: number) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(at));
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { y: part("year"), m: part("month"), d: part("day"), h: part("hour"), mi: part("minute"), s: part("second") };
};
/** How far the zone's clocks are ahead of UTC at an instant, in milliseconds. */
const offsetAt = (zone: string, at: number): number => {
  const w = wallParts(zone, at);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(at / 1000) * 1000;
};

/**
 * The instant a wall-clock time on a calendar date happens in a time zone. On the night clocks go back, a time that
 * happens twice is the first of the two; on the night they go forward, a time that never happens is read as the same
 * number of minutes past the jump (2:30 becomes 3:30).
 */
export function wallTimeToInstant(onDate: string, clock: string, zone: string): Date {
  const [y, m, d] = onDate.split("-").map(Number) as [number, number, number];
  const [h, mi] = clockOf(clock).split(":").map(Number) as [number, number];
  const asUtc = Date.UTC(y, m - 1, d, h, mi);
  const candidates = [...new Set([asUtc - offsetAt(zone, asUtc - 14 * 3_600_000), asUtc - offsetAt(zone, asUtc + 14 * 3_600_000)])].sort((a, b) => a - b);
  const exact = candidates.find((t) => { const w = wallParts(zone, t); return w.y === y && w.m === m && w.d === d && w.h === h && w.mi === mi; });
  return new Date(exact ?? candidates[candidates.length - 1]!);
}

/** The calendar day after `onDate` (YYYY-MM-DD). */
export function nextDay(onDate: string): string {
  const [y, m, d] = onDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** True when a shift that starts and ends at these clock times ends the next morning (an end at or before its start). */
export const endsNextDay = (startsAt: string, endsAt: string): boolean => clockOf(endsAt) <= clockOf(startsAt);

/** When a shift begins and ends, as instants: on the event's date in the club's zone, the end the next day when it is at or before the start. */
export function shiftInstants(onDate: string, startsAt: string, endsAt: string, zone: string): { start: Date; end: Date } {
  return { start: wallTimeToInstant(onDate, startsAt, zone), end: wallTimeToInstant(endsNextDay(startsAt, endsAt) ? nextDay(onDate) : onDate, endsAt, zone) };
}

/** A shift's length in minutes, as it is lived: across a change of the clocks, the real time between start and end. */
export const shiftMinutes = (when: { start: Date; end: Date }): number => Math.round((when.end.getTime() - when.start.getTime()) / 60_000);

/** "18:30" as "6:30 pm", "12:00" as "noon", "00:00" as "midnight". */
export function clockWords(clock: string): string {
  const [h, mi] = clockOf(clock).split(":").map(Number) as [number, number];
  if (mi === 0 && h === 12) return "noon";
  if (mi === 0 && h === 0) return "midnight";
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mi).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/** A shift's times in words: "6:00 pm to 9:00 pm", with "the next day" when it runs past midnight. */
export const shiftTimeWords = (startsAt: string, endsAt: string): string =>
  `${clockWords(startsAt)} to ${clockWords(endsAt)}${endsNextDay(startsAt, endsAt) && clockOf(endsAt) !== "00:00" ? " the next day" : ""}`;

/** A calendar date in words, the same for every reader: "Saturday, November 21, 2026". */
export function dateWords(onDate: string): string {
  const [y, m, d] = onDate.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** An instant in words as the club's clocks show it: "Thursday, November 19, 6:00 pm". */
export function instantWords(at: Date, zone: string): string {
  const w = wallParts(zone, at.getTime());
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(new Date(Date.UTC(w.y, w.m - 1, w.d)));
  return `${day}, ${clockWords(`${String(w.h).padStart(2, "0")}:${String(w.mi).padStart(2, "0")}`)}`;
}

/** Hours from minutes, in words a parent reads: 180 is "3", 150 is "2.5", 100 is "1.67". */
export const hoursWords = (minutes: number): string => String(Math.round((minutes / 60) * 100) / 100);

/** How long before a shift starts check-in opens (v1 spec §11.4). */
export const CHECK_IN_OPENS_MINUTES = 30;
export type CheckInWindow = { state: "before" | "open" | "closed"; opensAt: Date; closesAt: Date };
/**
 * Whether a shift can be checked in for at an instant: from 30 minutes before it starts until it ends. At the opening
 * instant it is open; at the end itself it has closed.
 */
export function checkInWindow(when: { start: Date; end: Date }, now: Date): CheckInWindow {
  const opensAt = new Date(when.start.getTime() - CHECK_IN_OPENS_MINUTES * 60_000), closesAt = when.end;
  const state = now.getTime() < opensAt.getTime() ? "before" : now.getTime() < closesAt.getTime() ? "open" : "closed";
  return { state, opensAt, closesAt };
}

/**
 * Whether a guardian may still cancel a sign-up themselves: until `cutoffHours` before the shift starts. At the
 * cut-off itself, and after it, they are asked to contact the event's contact instead.
 */
export const beforeCutoff = (start: Date, cutoffHours: number, now: Date): boolean => now.getTime() < start.getTime() - cutoffHours * 3_600_000;

/** The club's hour from which the day's volunteer reminders go (./reminders.ts): nobody is emailed in the night. */
export const REMINDER_HOUR = 9;
/** The calendar date (YYYY-MM-DD) in a zone at an instant. */
const dayIn = (zone: string, at: Date): string => { const w = wallParts(zone, at.getTime()); return `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`; };
/** The club's today and tomorrow when it is 9:00 or later on the club's clock; null before that. Pure. */
export function reminderDay(zone: string, now: Date): { today: string; tomorrow: string } | null {
  if (wallParts(zone, now.getTime()).h < REMINDER_HOUR) return null;
  const today = dayIn(zone, now);
  return { today, tomorrow: nextDay(today) };
}

/** The calendar day `days` after `onDate` (YYYY-MM-DD). */
export function daysAfter(onDate: string, days: number): string {
  const [y, m, d] = onDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
