/**
 * A calendar file (iCalendar, RFC 5545) for one sign-up, as text: one event with the shift's start and end in UTC, so
 * every calendar shows it at the right moment wherever the reader is. Its UID is the sign-up's, and SEQUENCE the
 * shift's revision, so a later copy (sent when staff change the time or place) replaces the first in the reader's
 * calendar. Pure: the caller passes every value. Staff's words and names are escaped as iCalendar text.
 */
export type CalendarShift = {
  signupId: string; revision: number; start: Date; end: Date; stamp: Date;
  summary: string; location: string; description: string; cancelled?: boolean;
};

/** Text escaped for an iCalendar value: backslash, semicolon, comma and line breaks. */
export const icsText = (s: string): string => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");

/** An instant as iCalendar's UTC form: 20261121T000000Z. */
export const icsInstant = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Lines longer than 75 octets folded onto continuation lines that start with a space, never splitting a character. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = "", size = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, "utf8");
    if (size + n > (out.length === 0 ? 75 : 74)) { out.push(current); current = ""; size = 0; }
    current += ch; size += n;
  }
  out.push(current);
  return out.join("\r\n ");
}

export function calendarFile(s: CalendarShift): string {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Booster Rocket//Volunteer sign-up//EN", "CALSCALE:GREGORIAN", `METHOD:${s.cancelled ? "CANCEL" : "PUBLISH"}`,
    "BEGIN:VEVENT",
    `UID:volunteer-signup-${s.signupId}@booster-rocket`,
    `SEQUENCE:${s.revision}`,
    `DTSTAMP:${icsInstant(s.stamp)}`,
    `DTSTART:${icsInstant(s.start)}`,
    `DTEND:${icsInstant(s.end)}`,
    `SUMMARY:${icsText(s.summary)}`,
    `LOCATION:${icsText(s.location)}`,
    `DESCRIPTION:${icsText(s.description)}`,
    `STATUS:${s.cancelled ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT", "END:VCALENDAR",
  ];
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}
