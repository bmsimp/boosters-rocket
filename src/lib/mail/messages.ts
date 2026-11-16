import type { MailMessage } from "./types";

export type Brand = { clubName: string; color: string };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const COLOR = /^#[0-9a-f]{6}$/i;

/** Simple HTML: a colored bar with the club name, then paragraphs. No images, no remote content. */
function html(b: Brand, paragraphs: string[], big?: string): string {
  const color = COLOR.test(b.color) ? b.color : "#5b2a86";
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${esc(p)}</p>`).join("");
  const code = big ? `<p style="margin:0 0 16px;font-size:32px;letter-spacing:6px;font-weight:bold">${esc(big)}</p>` : "";
  return `<!doctype html><html><body style="margin:0;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">`
    + `<div style="background:${color};color:#ffffff;padding:16px 24px;font-size:18px;font-weight:bold">${esc(b.clubName)}</div>`
    + `<div style="padding:24px">${code}${body}</div></body></html>`;
}
const text = (lines: string[]) => `${lines.join("\n\n")}\n`;

export function signinCodeMessage(b: Brand, to: string, code: string): MailMessage {
  const lines = [
    `Your ${b.clubName} sign-in code is ${code}.`,
    "It expires in 10 minutes.",
    "If you didn't ask for this code, you can ignore this email. Nobody can sign in without it.",
  ];
  return { to, subject: `Your ${b.clubName} sign-in code: ${code}`, text: text(lines), html: html(b, lines, code) };
}

/** The welcome (parents spec §3). It holds no family details: the address alone decides what the person sees after signing in. */
export function welcomeMessage(b: Brand, to: string, o: { appUrl: string; contact: string | null }): MailMessage {
  const lines = [
    `You can now sign in to ${b.clubName} at ${o.appUrl} with this email address. We'll email you a code each time, so there is no password.`,
    ...(o.contact ? [`Questions? Write to ${o.contact}.`] : []),
  ];
  return { to, subject: `You can now sign in to ${b.clubName}`, text: text(lines), html: html(b, lines) };
}

/** To staff who can decide held addresses (parents spec §5). Two numbers and a link: no family, person or address. */
export function reviewNoticeMessage(b: Brand, to: string, o: { newCount: number; waiting: number; link: string }): MailMessage {
  const items = (n: number) => `${n} parent ${n === 1 ? "sign-in" : "sign-ins"}`;
  const lines = [
    `${o.newCount} new, ${o.waiting} waiting in all: some email addresses in QuickBooks are under more than one family, so the people at those addresses can't sign in until someone reviews them.`,
    `Review them here: ${o.link}`,
    "You won't be reminded about these again. They stay on the staff home page until they are decided.",
  ];
  return { to, subject: `${b.clubName}: ${items(o.newCount)} to review`, text: text(lines), html: html(b, lines) };
}

export function emailChangeConfirmMessage(b: Brand, to: string, o: { link: string }): MailMessage {
  const lines = [
    `Someone asked to use this address to sign in to ${b.clubName}. If it was you, open this link within 24 hours to confirm:`,
    o.link,
    "If it wasn't you, ignore this email and nothing changes.",
  ];
  return { to, subject: `Confirm your new email for ${b.clubName}`, text: text(lines), html: html(b, lines) };
}

export function emailChangeNoticeMessage(b: Brand, to: string, o: { byStaff: boolean }): MailMessage {
  const lines = o.byStaff
    ? [`The club changed the email address you sign in to ${b.clubName} with. This address no longer works for signing in.`, "If this is a surprise, contact the club."]
    : [`Someone asked to change the email address you sign in to ${b.clubName} with. Nothing changes until the new address is confirmed.`, "If it wasn't you, contact the club."];
  return { to, subject: `Your ${b.clubName} sign-in email`, text: text(lines), html: html(b, lines) };
}

/* ---- Volunteering (v1 spec §11.3). Each goes to the guardian who took the place, and says only what is theirs: the
   person filling it, the event and the shift. Nothing about who else is signed up. ---- */

/** A shift as a volunteer email states it, every part already in words. */
export type VolunteerShiftWords = { event: string; role: string | null; when: string; location: string };
/** Who fills the place: the guardian the email goes to ("You"), or one of their students by name. */
export type VolunteerWho = { self: true } | { self: false; name: string };
const helping = (who: VolunteerWho, s: VolunteerShiftWords) => `${who.self ? "You're" : `${who.name} is`} signed up to help at ${s.event}${s.role ? ` (${s.role})` : ""}.`;
const shiftLines = (s: VolunteerShiftWords) => [`When: ${s.when}`, `Where: ${s.location}`];
const calendarFile = (content: string) => ({ filename: "volunteer-shift.ics", contentType: "text/calendar; charset=utf-8; method=PUBLISH", content });

/** On signing up: the shift, until when it can be cancelled on the portal, and a calendar file for it. */
export function volunteerSignupMessage(b: Brand, to: string, o: { who: VolunteerWho; shift: VolunteerShiftWords; contact: string; cancelUntil: string | null; link: string; calendar: string }): MailMessage {
  const lines = [
    `Thank you! ${helping(o.who, o.shift)}`,
    ...shiftLines(o.shift),
    o.cancelUntil ? `Plans change? You can cancel on the portal until ${o.cancelUntil}: ${o.link}` : `If you can't make it after all, please let ${o.contact} know.`,
    `Questions about the shift? Contact ${o.contact}.`,
    "The calendar file with this email adds the shift to your calendar.",
  ];
  return { to, subject: `You're signed up: ${o.shift.event}`, text: text(lines), html: html(b, lines), attachments: [calendarFile(o.calendar)] };
}

/** When staff change a shift's time or place, or the event's day or place: what it was, what it is now, and the calendar file again. */
export function volunteerChangeMessage(b: Brand, to: string, o: { who: VolunteerWho; before: VolunteerShiftWords; after: VolunteerShiftWords; contact: string; link: string; calendar: string }): MailMessage {
  const moved = (label: string, was: string, now: string) => (was === now ? [`${label}: ${now}`] : [`${label}: ${now} (it was ${was})`]);
  const lines = [
    `The club has changed a shift you signed up for. ${helping(o.who, o.after)}`,
    ...moved("When", o.before.when, o.after.when),
    ...moved("Where", o.before.location, o.after.location),
    `If the new time doesn't work for you, you can see your sign-ups here: ${o.link}. Or contact ${o.contact}.`,
    "The calendar file with this email replaces the one you had.",
  ];
  return { to, subject: `A volunteer shift has changed: ${o.after.event}`, text: text(lines), html: html(b, lines), attachments: [calendarFile(o.calendar)] };
}

/** When staff cancel a shift or the whole event. Nothing needs doing: the place is simply gone. */
export function volunteerCancelMessage(b: Brand, to: string, o: { who: VolunteerWho; shift: VolunteerShiftWords; whole: "event" | "shift"; contact: string }): MailMessage {
  const lines = [
    `The club has cancelled ${o.whole === "event" ? o.shift.event : `a shift at ${o.shift.event}`}, so ${o.who.self ? "you don't" : `${o.who.name} doesn't`} need to come.`,
    `The shift was: ${o.shift.when}${o.shift.role ? `, ${o.shift.role}` : ""}, at ${o.shift.location}.`,
    `There's nothing you need to do. Questions? Contact ${o.contact}. Thank you for offering your time.`,
  ];
  return { to, subject: `Cancelled: ${o.shift.event}`, text: text(lines), html: html(b, lines) };
}

export function testMessage(b: Brand, to: string): MailMessage {
  const lines = [`This is a test from the ${b.clubName} portal. Outgoing mail works.`];
  return { to, subject: `Test email from ${b.clubName}`, text: text(lines), html: html(b, lines) };
}
