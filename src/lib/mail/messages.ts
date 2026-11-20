import type { MailMessage } from "./types";

export type Brand = { clubName: string; color: string };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const COLOR = /^#[0-9a-f]{6}$/i;

/**
 * A line of a mail: a sentence, or a link alone on its line (`{ link }`: a set-up, reset or confirm link). The plain
 * text holds the link's address alone on its line, never wrapped; the HTML holds it as an anchor whose text is the whole
 * address and whose href is the same address, escaped once, with nothing added, in a paragraph of its own.
 */
type Line = string | { link: string };
const PARAGRAPH = `<p style="margin:0 0 16px">`;

/** Simple HTML: a colored bar with the club name, then paragraphs. No images, no remote content. */
function html(b: Brand, paragraphs: Line[], big?: string): string {
  const color = COLOR.test(b.color) ? b.color : "#5b2a86";
  const body = paragraphs.map((p) => (typeof p === "string" ? `${PARAGRAPH}${esc(p)}</p>` : `${PARAGRAPH}<a href="${esc(p.link)}">${esc(p.link)}</a></p>`)).join("");
  const code = big ? `<p style="margin:0 0 16px;font-size:32px;letter-spacing:6px;font-weight:bold">${esc(big)}</p>` : "";
  return `<!doctype html><html><body style="margin:0;font-family:Arial,Helvetica,sans-serif;color:#1a1a1a">`
    + `<div style="background:${color};color:#ffffff;padding:16px 24px;font-size:18px;font-weight:bold">${esc(b.clubName)}</div>`
    + `<div style="padding:24px">${code}${body}</div></body></html>`;
}
const text = (lines: Line[]) => `${lines.map((l) => (typeof l === "string" ? l : l.link)).join("\n\n")}\n`;

/**
 * The second step of a sign-in on a new device (the sign-in release, slice SI-3b): the code is sent only after the right
 * password, so a reader who didn't just sign in is told someone may know their password, and where to set a new one
 * (`passwordPage`: APP_URL and /sign-in/password). The subject carries the code (tests/e2e/journey-helpers.ts reads it).
 * `minutes` is how long the code works, in whole minutes: 10 for a first code, fewer for one resent late in its
 * pending step, which it never outlives (sendSecondStepCode(), src/lib/parents/signin-codes.ts).
 */
export function signinCodeMessage(b: Brand, to: string, code: string, o: { passwordPage: string; minutes: number }): MailMessage {
  const lines = [
    `Your ${b.clubName} sign-in code is ${code}.`,
    `It expires in ${o.minutes === 1 ? "1 minute" : `${o.minutes} minutes`}. We send it after your password was entered correctly on a device we don't know yet. Nobody can sign in there without it.`,
    `If you didn't just sign in, don't share this code: someone may know your password. Set a new one from "Set up or reset my password" at ${o.passwordPage}`,
  ];
  return { to, subject: `Your ${b.clubName} sign-in code: ${code}`, text: text(lines), html: html(b, lines, code) };
}

/**
 * A set-up link as the welcome and the press's mail carry it (the sign-in release, slice SI-4): its address, how long it
 * works in words (lifeWords() of LINK_LIFE_MS.setup), and whether the club is at Strict, where "Set up or reset my
 * password" mails no set-up link (whichLinkToMail(), `strict_no_setup`), so the mail says to ask the club instead.
 */
export type SetupLinkWords = { url: string; life: string; strict: boolean };

/** What to do once a set-up link has run out: ask for a new one on the request page (Standard), or ask the club (Strict). */
const afterItRunsOut = (appUrl: string, link: SetupLinkWords) => (link.strict
  ? "If the link runs out before you use it, please ask the club to send this email again."
  : `If the link runs out before you use it, you can ask for a new one at ${appUrl}/sign-in/password`);

/**
 * A welcome to a person who holds a set-up link that still works (unused and not expired, whoever sent it): it carries
 * no new link, since one would stop that one working, and says where to ask for another if they can't find it (the
 * request page at Standard, the club at Strict).
 */
export type EarlierLinkWords = { earlier: true; strict: boolean };

/**
 * The welcome (parents spec §3; since the sign-in release's slice SI-4 it carries a set-up link). It holds no family
 * details: the address alone decides what the person sees after signing in. `link` for a person with no password yet:
 * a new link chooses one, on a line of its own, or (EarlierLinkWords) the one emailed to them earlier still works. Null
 * for a person who has a password: no link, and where to sign in with it (`appUrl` and /sign-in, written out in full).
 */
export function welcomeMessage(b: Brand, to: string, o: { appUrl: string; contact: string | null; link: SetupLinkWords | EarlierLinkWords | null }): MailMessage {
  const lines: Line[] = [
    ...(o.link === null ? [`You can now sign in to ${b.clubName} with this email address and your password, at ${o.appUrl}/sign-in`]
      : "earlier" in o.link ? [
        `You can now sign in to ${b.clubName} at ${o.appUrl} with this email address.`,
        "A link to choose your password was emailed to you earlier, and it still works.",
        o.link.strict ? "If you can't find it, please ask the club to send you a new one." : `If you can't find it, you can ask for a new one at ${o.appUrl}/sign-in/password`,
      ] : [
        `You can now sign in to ${b.clubName} at ${o.appUrl} with this email address. First, choose your password with this link:`,
        { link: o.link.url },
        `The link works once, for ${o.link.life}. After that, you sign in with this email address and the password you chose.`,
        afterItRunsOut(o.appUrl, o.link),
      ]),
    NEVER_ASKS(b),
    ...(o.contact ? [`Questions? Write to ${o.contact}.`] : []),
  ];
  return { to, subject: `You can now sign in to ${b.clubName}`, text: text(lines), html: html(b, lines) };
}

/**
 * The set-up link an Admin's press on the parents' settings page mails to a person the club welcomed before, who has
 * no password (the sign-in release, slice SI-4): someone welcomed before the portal signed parents in with a password,
 * or someone whose welcome's link ran out unused. True for both, it says how they sign in, that the link chooses their
 * password, how long it works and what to do after, and that a device they are signed in on now stays signed in. Like
 * the welcome, it names no family, student or other person.
 */
export function choosePasswordMessage(b: Brand, to: string, o: { appUrl: string; contact: string | null; link: SetupLinkWords }): MailMessage {
  const lines: Line[] = [
    `You sign in to the ${b.clubName} portal at ${o.appUrl} with this email address and a password. To choose your password, open this link:`,
    { link: o.link.url },
    `The link works once, for ${o.link.life}.`,
    afterItRunsOut(o.appUrl, o.link),
    "If you're signed in to the portal on a phone or computer now, it stays signed in, and you'll need your password the next time you sign in.",
    NEVER_ASKS(b),
    ...(o.contact ? [`Questions? Write to ${o.contact}.`] : []),
  ];
  return { to, subject: `Choose your password for ${b.clubName}`, text: text(lines), html: html(b, lines) };
}

/**
 * A parent's change of sign-in address (src/lib/parents/email-change.ts), to the new address: the link that confirms it.
 * It says nothing about the person's family or anyone else, and nothing about whether the address is known already.
 */
export function emailChangeConfirmMessage(b: Brand, to: string, o: { link: string }): MailMessage {
  const lines: Line[] = [
    `Someone asked to use this address to sign in to ${b.clubName}. If it was you, open this link within 24 hours to confirm:`,
    { link: o.link },
    "You may be asked to sign in first. If you are, use the address you sign in with now, not this one: this one works once the change is confirmed.",
    "If it wasn't you, ignore this email and nothing changes.",
  ];
  return { to, subject: `Confirm your new email for ${b.clubName}`, text: text(lines), html: html(b, lines) };
}

/** The same change, to the old address: that it was asked for, and to tell the club if it wasn't them. No link, and not the new address. */
export function emailChangeNoticeMessage(b: Brand, to: string): MailMessage {
  const lines = [
    `Someone asked to change the email address you sign in to ${b.clubName} with. Nothing changes until the new address is confirmed.`,
    "If it wasn't you, please tell the club.",
  ];
  return { to, subject: `Your ${b.clubName} sign-in email`, text: text(lines), html: html(b, lines) };
}

/*
 * The two links of the page "Set up or reset my password" (the sign-in release, slice SI-3a; src/lib/parents/
 * password-request.ts). Each goes to the address asked for, read under the person's lock, and to no other. Each holds
 * the link on a line of its own, how long it works (`life`, in words, from LINK_LIFE_MS), that the club never asks for a
 * password by email or phone, and what to do if the reader didn't ask. No family, student or other person is named.
 */
const NEVER_ASKS = (b: Brand) => `${b.clubName} will never ask you for your password, by email or by phone. Don't share it with anyone.`;
const DID_NOT_ASK = "If you didn't ask for this, you can ignore this email: nothing changes unless the link is used. If these emails keep coming, please tell the club.";

/** A set-up link: the person has no password yet, and chooses one with it. */
export function passwordSetupMessage(b: Brand, to: string, o: { link: string; life: string }): MailMessage {
  const lines: Line[] = [
    `We got a request to set up a password for signing in to ${b.clubName} with this email address. To choose your password, open this link:`,
    { link: o.link },
    `The link works once, for ${o.life}.`,
    NEVER_ASKS(b),
    DID_NOT_ASK,
  ];
  return { to, subject: `Set up your ${b.clubName} password`, text: text(lines), html: html(b, lines) };
}

/** A reset link: the person has a password, and chooses a new one with it. */
export function passwordResetMessage(b: Brand, to: string, o: { link: string; life: string }): MailMessage {
  const lines: Line[] = [
    `We got a request to reset the password you use to sign in to ${b.clubName} with this email address. To choose a new password, open this link:`,
    { link: o.link },
    `The link works once, for ${o.life}. Until you use it, your password stays as it is.`,
    NEVER_ASKS(b),
    DID_NOT_ASK,
  ];
  return { to, subject: `Reset your ${b.clubName} password`, text: text(lines), html: html(b, lines) };
}

/**
 * The notice after a parent changed their password in sign-in settings (the sign-in release, slice SI-5a;
 * changeMyPassword(), src/lib/parents/signin-settings.ts), to the address read under their lock: that it was changed
 * and every device signed out, what to do if it wasn't them (set a new one from "Set up or reset my password" at
 * `passwordPage`, APP_URL and /sign-in/password written out, and tell the club), and that the club never asks for a
 * password; and, when the club has a treasurer's address (`contact`), where to write, since the reader is signed out
 * everywhere and can't look it up in the portal. No link that acts, no token, and no family, student or other person
 * named.
 */
export function passwordChangedMessage(b: Brand, to: string, o: { passwordPage: string; contact: string | null }): MailMessage {
  const lines: Line[] = [
    `The password you use to sign in to ${b.clubName} with this email address was changed just now, and every phone and computer signed in to the portal was signed out.`,
    "If you changed it, there's nothing more to do. Sign in again with your new password.",
    `If you didn't change it, please set a new password straight away from "Set up or reset my password" at ${o.passwordPage}, and tell the club.`,
    ...(o.contact ? [`You can write to the club at ${o.contact}.`] : []),
    NEVER_ASKS(b),
  ];
  return { to, subject: `Your ${b.clubName} password was changed`, text: text(lines), html: html(b, lines) };
}

/* ---- Volunteering (v1 spec §11.3). Each goes to the guardian who took the place, and says only what is theirs: the
   person filling it, the event and the shift. Nothing about who else is signed up. ---- */

/** A shift as a volunteer email states it, every part already in words. */
export type VolunteerShiftWords = { event: string; role: string | null; when: string; location: string };
/** Who fills the place: the guardian the email goes to ("You"), or one of their students by name. */
export type VolunteerWho = { self: true } | { self: false; name: string };
const helping = (who: VolunteerWho, s: VolunteerShiftWords) => `${who.self ? "You're" : `${who.name} is`} signed up to help at ${s.event}${s.role ? ` (${s.role})` : ""}.`;
const shiftLines = (s: VolunteerShiftWords) => [`When: ${s.when}`, `Where: ${s.location}`];
const calendarFile = (content: string, method: "PUBLISH" | "CANCEL" = "PUBLISH") => ({ filename: "volunteer-shift.ics", contentType: `text/calendar; charset=utf-8; method=${method}`, content });

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
export function volunteerCancelMessage(b: Brand, to: string, o: { who: VolunteerWho; shift: VolunteerShiftWords; whole: "event" | "shift"; contact: string; calendar: string }): MailMessage {
  const lines = [
    `The club has cancelled ${o.whole === "event" ? o.shift.event : `a shift at ${o.shift.event}`}, so ${o.who.self ? "you don't" : `${o.who.name} doesn't`} need to come.`,
    `The shift was: ${o.shift.when}${o.shift.role ? `, ${o.shift.role}` : ""}, at ${o.shift.location}.`,
    "If you added it to your calendar, opening the calendar file with this email takes it out again.",
    `There's nothing you need to do. Questions? Contact ${o.contact}. Thank you for offering your time.`,
  ];
  return { to, subject: `Cancelled: ${o.shift.event}`, text: text(lines), html: html(b, lines), attachments: [calendarFile(o.calendar, "CANCEL")] };
}

/* ---- Signed forms (v1 spec §9.2 step 6, §9.3). Each goes to one guardian of the family, about that family's own form:
   its title and who it is for. Nothing about any other family. ---- */

/**
 * A signed form's copy, to a guardian who signed it, once it is sealed and the portal has kept it. The sealed PDF goes
 * with it when there is one and it is small enough to attach; otherwise `link` is the signed-in download.
 */
export function signedFormCopyMessage(b: Brand, to: string, o: { formTitle: string; forName: string; pdf: Buffer | null; link: string; parts?: number }): MailMessage {
  const lines = [
    `Thank you for signing ${o.formTitle} for ${o.forName}. Everyone who needed to sign it has, and the club has kept the signed copy.`,
    o.pdf ? "The signed form is attached to this email, for your own records."
      : (o.parts ?? 1) > 1 ? `The signed form has ${o.parts} parts. You can download each of them here, after signing in: ${o.link}`
        : `You can download the signed form here, after signing in: ${o.link}`,
    "There's nothing more you need to do.",
  ];
  return { to, subject: `Signed: ${o.formTitle}`, text: text(lines), html: html(b, lines),
    ...(o.pdf ? { attachments: [{ filename: "signed-form.pdf", contentType: "application/pdf", content: o.pdf }] } : {}) };
}

/** A reminder that a form still needs this guardian's signature: the form, who it is for, when it is due, and the way to it. */
export function formReminderMessage(b: Brand, to: string, o: { formTitle: string; forNames: string[]; due: string | null; pastDue?: boolean; link: string }): MailMessage {
  const names = o.forNames.length <= 1 ? o.forNames.join("") : `${o.forNames.slice(0, -1).join(", ")} and ${o.forNames.at(-1)}`;
  const lines = [
    `A friendly reminder: ${o.formTitle} for ${names} still needs your signature.`,
    ...(o.due ? [o.pastDue ? `It was due ${o.due}. It's not too late to sign it.` : `It's due ${o.due}.`] : []),
    `You can read and sign it here: ${o.link}`,
    "If you've signed it in the last day or so, thank you, and you can ignore this email.",
  ];
  return { to, subject: `Please sign: ${o.formTitle}`, text: text(lines), html: html(b, lines) };
}

/** When the club gives up one place: staff removed the sign-up, or its student is no longer listed with the family. The calendar file takes it out again. */
export function volunteerRemovedMessage(b: Brand, to: string, o: { who: VolunteerWho; shift: VolunteerShiftWords; why: "staff" | "moved"; contact: string; link: string; calendar: string }): MailMessage {
  const where = `a shift at ${o.shift.event}${o.shift.role ? ` (${o.shift.role})` : ""}`;
  const lines = [
    o.why === "staff"
      ? `The club has taken ${o.who.self ? "your place" : `${o.who.name}'s place`} off ${where}, so ${o.who.self ? "you don't" : `${o.who.name} doesn't`} need to come.`
      : `${o.who.self ? "Your" : `${o.who.name}'s`} place on ${where} has been freed, because ${o.who.self ? "you're" : `${o.who.name} is`} no longer listed with your family in the club's records.`,
    `The shift was: ${o.shift.when}, at ${o.shift.location}.`,
    "If you added it to your calendar, opening the calendar file with this email takes it out again.",
    `If this is a surprise, please contact ${o.contact}. Your other sign-ups are here: ${o.link}`,
  ];
  return { to, subject: `Your place has been freed: ${o.shift.event}`, text: text(lines), html: html(b, lines), attachments: [calendarFile(o.calendar, "CANCEL")] };
}

/** The day before a shift: where and when, and who to contact. */
export function volunteerReminderMessage(b: Brand, to: string, o: { who: VolunteerWho; shift: VolunteerShiftWords; contact: string; link: string }): MailMessage {
  const lines = [
    `A friendly reminder: ${o.who.self ? "you're" : `${o.who.name} is`} helping at ${o.shift.event}${o.shift.role ? ` (${o.shift.role})` : ""} tomorrow.`,
    ...shiftLines(o.shift),
    `When you get there, scan the club's check-in code to be checked in. Questions, or can't make it? Contact ${o.contact}.`,
    "Scanning the code opens your phone's web browser. If you use the portal as an app on your home screen, sign in to the portal in your browser too before you go, so you're ready to check in.",
    `Your sign-ups are here: ${o.link}`,
    "Thank you for giving your time!",
  ];
  return { to, subject: `Tomorrow: ${o.shift.event}`, text: text(lines), html: html(b, lines) };
}

/** A volunteer requirement the family hasn't met yet, in a nudge's words: what, for whom, and where it stands. */
export type VolunteerDueWords = { title: string; whoMust: string; standing: string };
/** A nudge before a due date: what the family still has to do, kindly, with the date and the link. Nothing about any other family. */
export function volunteerDueMessage(b: Brand, to: string, o: { dueWords: string; daysLeft: number; items: VolunteerDueWords[]; link: string }): MailMessage {
  const lines = [
    `Just a heads-up: some of the volunteering the club asks of your family is due ${o.dueWords}, ${o.daysLeft} days from now.`,
    ...o.items.map((i) => `${i.title}: ${i.standing}. ${i.whoMust}.`),
    `You can pick a shift here: ${o.link}`,
    "Thank you for everything you do for the club!",
  ];
  return { to, subject: `Volunteering due ${o.dueWords}`, text: text(lines), html: html(b, lines) };
}

/* ---- Due dates of payments and checklist items (v1 spec §10.1.9). Each goes to one guardian of the family, about that
   family's own requirements due on one day: titles, who each is for, and where each stands. Nothing about any other
   family, and no note staff wrote. ---- */

/** One requirement in a due-date reminder, its parts already in words: the title, the student it is for (null: the family), and how it stands. */
export type RequirementDueWords = { title: string; forName: string | null; standing: string };
/**
 * A reminder before a due date: what the family still has to do, kindly, with the date and the way to it. `payments`
 * is the Payments page, given when a payment is among them; `season` is the Season page.
 */
export function requirementDueMessage(b: Brand, to: string, o: { dueWords: string; daysLeft: number; items: RequirementDueWords[]; season: string; payments: string | null }): MailMessage {
  const one = o.items.length === 1;
  const lines = [
    `A friendly reminder: ${one ? "something" : "a few things"} the club asks of your family ${one ? "is" : "are"} due ${o.dueWords}, ${o.daysLeft} days from now.`,
    ...o.items.map((i) => `${i.title}${i.forName ? ` for ${i.forName}` : ""}: ${i.standing}.`),
    ...(o.payments ? [`You can see what's owed and pay on the Payments page: ${o.payments}`] : []),
    `Everything the club asks this season is here: ${o.season}`,
    "If you've taken care of this in the last day or so, thank you, and you can ignore this email.",
  ];
  return { to, subject: one ? `Due ${o.dueWords}: ${o.items[0]!.title}` : `Due ${o.dueWords}: ${o.items.length} things for the club`, text: text(lines), html: html(b, lines) };
}

export function testMessage(b: Brand, to: string): MailMessage {
  const lines = [`This is a test from the ${b.clubName} portal. Outgoing mail works.`];
  return { to, subject: `Test email from ${b.clubName}`, text: text(lines), html: html(b, lines) };
}
