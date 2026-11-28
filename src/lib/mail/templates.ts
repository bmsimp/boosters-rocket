import { bigCode, esc, lineHtml, lines, mailHtml, mailText, PARAGRAPH, type Block, type Brand, type Line } from "./frame";
import { checkTemplate, doc, field, fixedPart, para, renderBody, renderSubject, type TemplateDoc, type TemplateRules } from "./template-body";
import type { MailAttachment, MailMessage } from "./types";

/*
 * Every email the portal sends to a family, as a template (docs/superpowers/specs/2026-11-28-email-templates-design.md):
 * its fields, its fixed parts (what the portal always writes itself: links, codes, how long they work, the safety
 * lines, the lists, the lines about attachments), and its default words, which are the words the portal sent before
 * the club could change them, so an email the club never changed is the same, byte for byte, as before
 * (tests/unit/mail-templates.test.ts). Pure: the senders, the settings pages and the editor's live preview read it.
 */

export const EMAIL_GROUPS = ["Sign-in", "Forms", "Volunteering", "Season and messages"] as const;
export type EmailGroup = (typeof EMAIL_GROUPS)[number];

/** A field: its id in the body, its label in the editor and in a subject's braces, and the value a preview and a test use. */
export type FieldDef = { id: string; label: string; sample: string };
/** A fixed part: its label in the editor ("the reset link"), and the blocks it draws for one send. */
type FixedDef<D> = { id: string; label: string; render: (d: D, b: Brand) => Block[] };

export type EmailDef<D = never> = {
  key: string;
  group: EmailGroup;
  /** Its name on the list ("Reset your password"), and when it is sent, in one line. */
  title: string;
  sentWhen: string;
  fields: FieldDef[];
  values: (d: D, b: Brand) => Record<string, string | null>;
  fixed: FixedDef<D>[];
  /** Whether the club's words may hold links of their own: never in a Sign-in email. */
  links: boolean;
  /** The subject: one the club may change, written with fields in braces (and how a variant wraps it), or the portal's own. */
  subject: { default: string; wrap?: (d: D, s: string) => string } | { fixed: (d: D, b: Brand) => string };
  body: TemplateDoc;
  /** What a preview and a test send fill it with: plainly samples, a link that opens nothing. */
  sample: (b: Brand) => D;
  attachments?: (d: D) => MailAttachment[] | undefined;
};

/** The club's words for the emails it changed: the subject (null where the portal writes it) and the body, as saved. */
export type ClubTemplates = Partial<Record<string, { subject: string | null; body: unknown }>>;

const COMMON: FieldDef[] = [
  { id: "clubName", label: "Club name", sample: "Lakeside Band Boosters" },
  { id: "portal", label: "Portal address", sample: "https://portal.lakesideband.org" },
  { id: "contact", label: "Club contact", sample: "treasurer@lakesideband.org" },
];
const common = (b: Brand, contact?: string | null) => ({ clubName: b.clubName, portal: b.portal ?? null, contact: contact === undefined ? (b.contact ?? null) : contact });
const portalOf = (b: Brand) => b.portal ?? "https://portal.example.org";
const f = field;

/* ---- Shared words ---- */

const NEVER_ASKS = (b: Brand) => `${b.clubName} will never ask you for your password, by email or by phone. Don't share it with anyone.`;
const DID_NOT_ASK = "If you didn't ask for this, you can ignore this email: nothing changes unless the link is used. If these emails keep coming, please tell the club.";
const minutes = (m: number) => (m === 1 ? "1 minute" : `${m} minutes`);
const neverAsks = <D>(): FixedDef<D> => ({ id: "neverAsks", label: "the club never asks for a password", render: (_d, b) => lines([NEVER_ASKS(b)]) });

/** A set-up link as the welcome and the press's mail carry it: its address, its life in words, and whether the club is at Strict. */
export type SetupLinkWords = { url: string; life: string; strict: boolean };
/** A welcome to a person who holds a set-up link that still works: no new link. */
export type EarlierLinkWords = { earlier: true; strict: boolean };
const afterItRunsOut = (appUrl: string, link: SetupLinkWords) => (link.strict
  ? "If the link runs out before you use it, please ask the club to send you a new one."
  : `If the link runs out before you use it, you can ask for a new one at ${appUrl}/sign-in/password`);
const strictLinkLife = (life: string) =>
  `The link works once, for ${life}. Once you've chosen your password, the portal asks you to add a passkey or an authenticator app, which you'll use each time you sign in.`;

/* ---- Volunteering: a shift in words ---- */

export type VolunteerShiftWords = { event: string; role: string | null; when: string; location: string };
export type VolunteerWho = { self: true } | { self: false; name: string };
const helping = (who: VolunteerWho, s: VolunteerShiftWords) => `${who.self ? "You're" : `${who.name} is`} signed up to help at ${s.event}${s.role ? ` (${s.role})` : ""}.`;
const shiftLines = (s: VolunteerShiftWords) => [`When: ${s.when}`, `Where: ${s.location}`];
const calendarFile = (content: string, method: "PUBLISH" | "CANCEL" = "PUBLISH"): MailAttachment => ({ filename: "volunteer-shift.ics", contentType: `text/calendar; charset=utf-8; method=${method}`, content });
const SAMPLE_SHIFT: VolunteerShiftWords = { event: "Fall concert", role: "Ushers", when: "Friday, October 9, 6:00 pm to 8:30 pm", location: "Lakeside High auditorium" };
const SAMPLE_WHO: VolunteerWho = { self: false, name: "Maya Ortiz" };
const SAMPLE_CALENDAR = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Boosters Rocket//sample//EN\r\nEND:VCALENDAR\r\n";
const EVENT: FieldDef = { id: "event", label: "Event", sample: SAMPLE_SHIFT.event };
const HELPING: FieldDef = { id: "helping", label: "Who's helping, and where", sample: helping(SAMPLE_WHO, SAMPLE_SHIFT) };
const SHIFT_CONTACT: FieldDef = { id: "shiftContact", label: "Event contact", sample: "Dana Reyes (dana@lakesideband.org)" };

export type VolunteerDueWords = { title: string; whoMust: string; standing: string };
export type RequirementDueWords = { title: string; forName: string | null; standing: string };
/** A message's body as bodyMail() drew it (src/lib/messages/body.ts): plain text, and HTML with every piece of text escaped. */
export type ClubMessageBody = { text: string; html: string };

const SAMPLE_CODE = "123456";
const sampleLink = (b: Brand, path: string) => `${portalOf(b)}${path}`;

/* ---- The emails ---- */

type CodeData = { code: string; passwordPage?: string; settingsPage?: string; minutes: number };
export const signinCode: EmailDef<CodeData> = {
  key: "signin_code", group: "Sign-in", title: "Sign-in code", sentWhen: "After the right password on a new device.",
  fields: [...COMMON, { id: "code", label: "Sign-in code", sample: SAMPLE_CODE }],
  values: (d, b) => ({ ...common(b), code: d.code }),
  fixed: [
    { id: "bigCode", label: "the code, in large type", render: (d) => [bigCode(d.code)] },
    { id: "life", label: "how long the code works", render: (d) => lines([`It expires in ${minutes(d.minutes)}. We send it after your password was entered correctly on a new device. Nobody can sign in there without it.`]) },
    { id: "notYou", label: "if you didn't just sign in", render: (d) => lines([`If you didn't just sign in, don't share this code: someone may know your password. Set a new one from "Set up or reset my password" at ${d.passwordPage}`]) },
  ],
  links: false,
  subject: { fixed: (d, b) => `Your ${b.clubName} sign-in code: ${d.code}` },
  body: doc(fixedPart("bigCode"), para("Your ", f("clubName"), " sign-in code is ", f("code"), "."), fixedPart("life"), fixedPart("notYou")),
  sample: (b) => ({ code: SAMPLE_CODE, passwordPage: sampleLink(b, "/sign-in/password"), minutes: 10 }),
};

export const changeCode: EmailDef<CodeData> = {
  key: "change_code", group: "Sign-in", title: "Code to confirm a change", sentWhen: "When a parent changes how they sign in.",
  fields: [...COMMON, { id: "code", label: "Sign-in code", sample: SAMPLE_CODE }],
  values: (d, b) => ({ ...common(b), code: d.code }),
  fixed: [
    { id: "bigCode", label: "the code, in large type", render: (d) => [bigCode(d.code)] },
    { id: "what", label: "what the code confirms, and how long it works", render: (d, b) => lines([`Someone signed in to the ${b.clubName} portal as you has asked to change how you sign in. This code confirms that change. It expires in ${minutes(d.minutes)}.`]) },
    { id: "notYou", label: "if that wasn't you", render: (d) => lines([`If that wasn't you, don't share this code. Sign out everywhere from Sign-in settings at ${d.settingsPage}, or ask the club for help.`]) },
  ],
  links: false,
  subject: { fixed: (d, b) => `Your ${b.clubName} sign-in code: ${d.code}, to confirm a change` },
  body: doc(fixedPart("bigCode"), para("Your ", f("clubName"), " sign-in code is ", f("code"), "."), fixedPart("what"), fixedPart("notYou")),
  sample: (b) => ({ code: SAMPLE_CODE, settingsPage: sampleLink(b, "/family/sign-in"), minutes: 10 }),
};

type WelcomeData = { appUrl: string; contact: string | null; link: SetupLinkWords | EarlierLinkWords | null };
export const welcome: EmailDef<WelcomeData> = {
  key: "welcome", group: "Sign-in", title: "Welcome", sentWhen: "When the club welcomes a parent to the portal.",
  fields: COMMON,
  values: (d, b) => common(b, d.contact),
  fixed: [
    { id: "howToSignIn", label: "how to sign in, with the link to choose a password", render: (o, b) => lines(o.link === null
      ? [`You can now sign in to ${b.clubName} with this email address and your password, at ${o.appUrl}/sign-in`]
      : "earlier" in o.link ? [
        `You can now sign in to ${b.clubName} at ${o.appUrl} with this email address.`,
        "A link to choose your password was emailed to you earlier, and it still works.",
        o.link.strict ? "If you can't find it, please ask the club to send you a new one." : `If you can't find it, you can ask for a new one at ${o.appUrl}/sign-in/password`,
      ] : [
        `You can now sign in to ${b.clubName} at ${o.appUrl} with this email address. First, choose your password with this link:`,
        { link: o.link.url },
        o.link.strict ? strictLinkLife(o.link.life) : `The link works once, for ${o.link.life}. After that, you sign in with this email address and the password you chose.`,
        afterItRunsOut(o.appUrl, o.link),
      ]) },
    neverAsks(),
  ],
  links: false,
  subject: { default: "You can now sign in to {Club name}" },
  body: doc(fixedPart("howToSignIn"), fixedPart("neverAsks"), para("Questions? Write to ", f("contact"), ".")),
  sample: (b) => ({ appUrl: portalOf(b), contact: b.contact ?? null, link: { url: sampleLink(b, "/sign-in/set-up/sample"), life: "7 days", strict: false } }),
};

type ChooseData = { appUrl: string; contact: string | null; link: SetupLinkWords };
export const choosePassword: EmailDef<ChooseData> = {
  key: "choose_password", group: "Sign-in", title: "Choose your password", sentWhen: "When an Admin sends a set-up link to a parent welcomed before.",
  fields: COMMON,
  values: (d, b) => common(b, d.contact),
  fixed: [
    { id: "setUp", label: "how to sign in, with the link to choose a password", render: (o, b) => lines([
      `You sign in to the ${b.clubName} portal at ${o.appUrl} with this email address and a password. To choose your password, open this link:`,
      { link: o.link.url },
      o.link.strict ? strictLinkLife(o.link.life) : `The link works once, for ${o.link.life}.`,
      afterItRunsOut(o.appUrl, o.link),
      ...(o.link.strict ? [] : ["If you're signed in to the portal on a phone or computer now, it stays signed in, and you'll need your password the next time you sign in."]),
    ]) },
    neverAsks(),
  ],
  links: false,
  subject: { default: "Choose your password for {Club name}" },
  body: doc(fixedPart("setUp"), fixedPart("neverAsks"), para("Questions? Write to ", f("contact"), ".")),
  sample: (b) => ({ appUrl: portalOf(b), contact: b.contact ?? null, link: { url: sampleLink(b, "/sign-in/set-up/sample"), life: "7 days", strict: false } }),
};

type LinkData = { link: string; life: string };
const linkEmail = (o: { key: string; title: string; sentWhen: string; subject: string; lead: (b: Brand) => string; after: string; path: string; life: string }): EmailDef<LinkData> => ({
  key: o.key, group: "Sign-in", title: o.title, sentWhen: o.sentWhen,
  fields: COMMON,
  values: (_d, b) => common(b),
  fixed: [
    { id: "link", label: "the link, and how long it works", render: (d, b) => lines([o.lead(b), { link: d.link }, `The link works once, for ${d.life}.${o.after}`]) },
    neverAsks(),
    { id: "didNotAsk", label: "if you didn't ask for this", render: () => lines([DID_NOT_ASK]) },
  ],
  links: false,
  subject: { default: o.subject },
  body: doc(fixedPart("link"), fixedPart("neverAsks"), fixedPart("didNotAsk")),
  sample: (b) => ({ link: sampleLink(b, o.path), life: o.life }),
});
export const passwordSetup = linkEmail({
  key: "password_setup", title: "Set up your password", sentWhen: "When a parent with no password asks for one.", subject: "Set up your {Club name} password",
  lead: (b) => `We got a request to set up a password for signing in to ${b.clubName} with this email address. To choose your password, open this link:`,
  after: "", path: "/sign-in/set-up/sample", life: "7 days",
});
export const passwordReset = linkEmail({
  key: "password_reset", title: "Reset your password", sentWhen: "When a parent asks to reset their password.", subject: "Reset your {Club name} password",
  lead: (b) => `We got a request to reset the password you use to sign in to ${b.clubName} with this email address. To choose a new password, open this link:`,
  after: " Until you use it, your password stays as it is.", path: "/sign-in/reset/sample", life: "1 hour",
});

type ResetData = { link: string; life: string; contact: string | null; strict: boolean };
export const signinReset: EmailDef<ResetData> = {
  key: "signin_reset", group: "Sign-in", title: "Sign-in was reset", sentWhen: "When an Admin resets a parent's sign-in.",
  fields: COMMON,
  values: (d, b) => common(b, d.contact),
  fixed: [
    { id: "what", label: "what was reset", render: (_d, b) => lines([`Someone at ${b.clubName} reset how you sign in to the portal with this email address. Your password, passkeys, authenticator app and backup codes no longer work, and every phone and computer that was signed in has been signed out.`]) },
    { id: "link", label: "the link, and how long it works", render: (o) => lines(["To choose a new password, open this link:", { link: o.link },
      o.strict ? `The link works once, for ${o.life}. Once you've chosen your password, the portal asks you to add a passkey or an authenticator app before anything else.`
        : `The link works once, for ${o.life}. Once you've chosen your password, you can add a passkey or an authenticator app again under Sign-in settings.`]) },
    { id: "notYou", label: "if you didn't ask the club", render: () => lines(["If you didn't ask the club for this, please contact the club straight away: someone may be trying to get into your account."]) },
    neverAsks(),
  ],
  links: false,
  subject: { default: "Your {Club name} sign-in was reset" },
  body: doc(fixedPart("what"), fixedPart("link"), para("If you asked the club for this, that's all there is to do."), fixedPart("notYou"),
    para("You can write to the club at ", f("contact"), "."), fixedPart("neverAsks")),
  sample: (b) => ({ link: sampleLink(b, "/sign-in/set-up/sample"), life: "7 days", contact: b.contact ?? null, strict: false }),
};

type ChangedData = { passwordPage: string; contact: string | null };
export const passwordChanged: EmailDef<ChangedData> = {
  key: "password_changed", group: "Sign-in", title: "Password was changed", sentWhen: "When a parent changes their password.",
  fields: COMMON,
  values: (d, b) => common(b, d.contact),
  fixed: [
    { id: "what", label: "what changed", render: (_d, b) => lines([`The password you use to sign in to ${b.clubName} with this email address was changed just now, and every phone and computer signed in to the portal was signed out.`]) },
    { id: "notYou", label: "if you didn't change it", render: (o) => lines([`If you didn't change it, please set a new password straight away from "Set up or reset my password" at ${o.passwordPage}, and tell the club.`]) },
    neverAsks(),
  ],
  links: false,
  subject: { default: "Your {Club name} password was changed" },
  body: doc(fixedPart("what"), para("If you changed it, there's nothing more to do. Sign in again with your new password."), fixedPart("notYou"),
    para("You can write to the club at ", f("contact"), "."), fixedPart("neverAsks")),
  sample: (b) => ({ passwordPage: sampleLink(b, "/sign-in/password"), contact: b.contact ?? null }),
};

export const emailChangeConfirm: EmailDef<{ link: string }> = {
  key: "email_change_confirm", group: "Sign-in", title: "Confirm your new email", sentWhen: "To the new address, when a parent changes it.",
  fields: COMMON,
  values: (_d, b) => common(b),
  fixed: [
    { id: "link", label: "the link to confirm, within 24 hours", render: (o, b) => lines([`Someone asked to use this address to sign in to ${b.clubName}. If it was you, open this link within 24 hours to confirm:`, { link: o.link }]) },
    { id: "notYou", label: "if it wasn't you", render: () => lines(["If it wasn't you, ignore this email and nothing changes."]) },
  ],
  links: false,
  subject: { default: "Confirm your new email for {Club name}" },
  body: doc(fixedPart("link"), para("You may be asked to sign in first. If you are, use the address you sign in with now, not this one: this one works once the change is confirmed."), fixedPart("notYou")),
  sample: (b) => ({ link: sampleLink(b, "/family/email/sample") }),
};

export const emailChangeNotice: EmailDef<Record<string, never>> = {
  key: "email_change_notice", group: "Sign-in", title: "Your sign-in email", sentWhen: "To the old address, when a parent changes it.",
  fields: COMMON,
  values: (_d, b) => common(b),
  fixed: [
    { id: "what", label: "what was asked", render: (_d, b) => lines([`Someone asked to change the email address you sign in to ${b.clubName} with. Nothing changes until the new address is confirmed.`]) },
    { id: "notYou", label: "if it wasn't you", render: () => lines(["If it wasn't you, please tell the club."]) },
  ],
  links: false,
  subject: { default: "Your {Club name} sign-in email" },
  body: doc(fixedPart("what"), fixedPart("notYou")),
  sample: () => ({}),
};

const FORM_NAME: FieldDef = { id: "formName", label: "Form name", sample: "Medical release 2026" };
type CopyData = { formTitle: string; forName: string; pdf: Buffer | null; link: string; parts?: number };
export const formCopy: EmailDef<CopyData> = {
  key: "form_copy", group: "Forms", title: "Signed copy", sentWhen: "When everyone has signed a form.",
  fields: [...COMMON, FORM_NAME, { id: "forName", label: "For", sample: "Maya Ortiz" }],
  values: (d, b) => ({ ...common(b), formName: d.formTitle, forName: d.forName }),
  fixed: [
    { id: "copy", label: "the signed copy: attached, or where to download it", render: (o) => lines([o.pdf ? "The signed form is attached to this email, for your own records."
      : (o.parts ?? 1) > 1 ? `The signed form has ${o.parts} parts. You can download each of them here, after signing in: ${o.link}`
        : `You can download the signed form here, after signing in: ${o.link}`]) },
  ],
  links: true,
  subject: { default: "Signed: {Form name}" },
  body: doc(para("Thank you for signing ", f("formName"), " for ", f("forName"), ". Everyone who needed to sign it has, and the club has kept the signed copy."),
    fixedPart("copy"), para("There's nothing more you need to do.")),
  sample: (b) => ({ formTitle: FORM_NAME.sample, forName: "Maya Ortiz", pdf: null, link: sampleLink(b, "/forms") }),
  attachments: (o) => (o.pdf ? [{ filename: "signed-form.pdf", contentType: "application/pdf", content: o.pdf }] : undefined),
};

type ReminderData = { formTitle: string; forNames: string[]; due: string | null; pastDue?: boolean; link: string };
const namesOf = (n: string[]) => (n.length <= 1 ? n.join("") : `${n.slice(0, -1).join(", ")} and ${n.at(-1)}`);
export const formReminder: EmailDef<ReminderData> = {
  key: "form_reminder", group: "Forms", title: "Please sign", sentWhen: "A reminder that a form still needs a signature.",
  fields: [...COMMON, FORM_NAME, { id: "forNames", label: "For", sample: "Maya Ortiz" }, { id: "due", label: "Due date", sample: "Friday, September 4" }],
  values: (d, b) => ({ ...common(b), formName: d.formTitle, forNames: namesOf(d.forNames), due: d.due }),
  fixed: [
    { id: "due", label: "when it's due", render: (o) => lines(o.due ? [o.pastDue ? `It was due ${o.due}. It's not too late to sign it.` : `It's due ${o.due}.`] : []) },
    { id: "link", label: "the link to the form", render: (o) => lines([`You can read and sign it here: ${o.link}`]) },
  ],
  links: true,
  subject: { default: "Please sign: {Form name}" },
  body: doc(para("A friendly reminder: ", f("formName"), " for ", f("forNames"), " still needs your signature."), fixedPart("due"), fixedPart("link"),
    para("If you've signed it in the last day or so, thank you, and you can ignore this email.")),
  sample: (b) => ({ formTitle: FORM_NAME.sample, forNames: ["Maya Ortiz"], due: "Friday, September 4", link: sampleLink(b, "/forms") }),
};

const calendarLine = <D>(words: string): FixedDef<D> => ({ id: "calendar", label: "the calendar file", render: () => lines([words]) });
const shiftFixed = <D extends { shift: VolunteerShiftWords }>(): FixedDef<D> => ({ id: "shift", label: "when and where", render: (o) => lines(shiftLines(o.shift)) });
const VOLUNTEER_FIELDS = [...COMMON, EVENT, HELPING, SHIFT_CONTACT];
const volunteerValues = (d: { who: VolunteerWho; shift: VolunteerShiftWords; contact: string }, b: Brand) => ({ ...common(b), event: d.shift.event, helping: helping(d.who, d.shift), shiftContact: d.contact });

type SignupData = { who: VolunteerWho; shift: VolunteerShiftWords; contact: string; cancelUntil: string | null; link: string; calendar: string };
export const volunteerSignup: EmailDef<SignupData> = {
  key: "volunteer_signup", group: "Volunteering", title: "Signed up", sentWhen: "When a parent takes a shift.",
  fields: VOLUNTEER_FIELDS, values: volunteerValues,
  fixed: [
    shiftFixed(),
    { id: "cancel", label: "how to cancel", render: (o) => lines([o.cancelUntil ? `Plans change? You can cancel on the portal until ${o.cancelUntil}: ${o.link}` : `If you can't make it after all, please let ${o.contact} know.`]) },
    calendarLine("The calendar file with this email adds the shift to your calendar."),
  ],
  links: true,
  subject: { default: "You're signed up: {Event}" },
  body: doc(para("Thank you! ", f("helping")), fixedPart("shift"), fixedPart("cancel"), para("Questions about the shift? Contact ", f("shiftContact"), "."), fixedPart("calendar")),
  sample: (b) => ({ who: SAMPLE_WHO, shift: SAMPLE_SHIFT, contact: SHIFT_CONTACT.sample, cancelUntil: "Wednesday, October 7", link: sampleLink(b, "/volunteer"), calendar: SAMPLE_CALENDAR }),
  attachments: (o) => [calendarFile(o.calendar)],
};

type ChangeData = { who: VolunteerWho; before: VolunteerShiftWords; after: VolunteerShiftWords; contact: string; link: string; calendar: string };
export const volunteerChange: EmailDef<ChangeData> = {
  key: "volunteer_change", group: "Volunteering", title: "Shift changed", sentWhen: "When staff change a shift's time or place.",
  fields: VOLUNTEER_FIELDS, values: (d, b) => volunteerValues({ who: d.who, shift: d.after, contact: d.contact }, b),
  fixed: [
    { id: "shift", label: "when and where, and what they were", render: (o) => {
      const moved = (label: string, was: string, now: string) => (was === now ? [`${label}: ${now}`] : [`${label}: ${now} (it was ${was})`]);
      return lines([...moved("When", o.before.when, o.after.when), ...moved("Where", o.before.location, o.after.location)]);
    } },
    { id: "link", label: "the link to their sign-ups", render: (o) => lines([`If the new time doesn't work for you, you can see your sign-ups here: ${o.link}. Or contact ${o.contact}.`]) },
    calendarLine("The calendar file with this email replaces the one you had."),
  ],
  links: true,
  subject: { default: "A volunteer shift has changed: {Event}" },
  body: doc(para("The club has changed a shift you signed up for. ", f("helping")), fixedPart("shift"), fixedPart("link"), fixedPart("calendar")),
  sample: (b) => ({ who: SAMPLE_WHO, before: { ...SAMPLE_SHIFT, when: "Friday, October 9, 5:30 pm to 8:00 pm" }, after: SAMPLE_SHIFT, contact: SHIFT_CONTACT.sample, link: sampleLink(b, "/volunteer"), calendar: SAMPLE_CALENDAR }),
  attachments: (o) => [calendarFile(o.calendar)],
};

type CancelData = { who: VolunteerWho; shift: VolunteerShiftWords; whole: "event" | "shift"; contact: string; calendar: string };
export const volunteerCancel: EmailDef<CancelData> = {
  key: "volunteer_cancel", group: "Volunteering", title: "Shift cancelled", sentWhen: "When staff cancel a shift or an event.",
  fields: VOLUNTEER_FIELDS, values: volunteerValues,
  fixed: [
    { id: "cancelled", label: "what was cancelled", render: (o) => lines([`The club has cancelled ${o.whole === "event" ? o.shift.event : `a shift at ${o.shift.event}`}, so ${o.who.self ? "you don't" : `${o.who.name} doesn't`} need to come.`]) },
    { id: "shift", label: "the shift it was", render: (o) => lines([`The shift was: ${o.shift.when}${o.shift.role ? `, ${o.shift.role}` : ""}, at ${o.shift.location}.`]) },
    calendarLine("If you added it to your calendar, opening the calendar file with this email takes it out again."),
  ],
  links: true,
  subject: { default: "Cancelled: {Event}" },
  body: doc(fixedPart("cancelled"), fixedPart("shift"), fixedPart("calendar"), para("There's nothing you need to do. Questions? Contact ", f("shiftContact"), ". Thank you for offering your time.")),
  sample: () => ({ who: SAMPLE_WHO, shift: SAMPLE_SHIFT, whole: "shift", contact: SHIFT_CONTACT.sample, calendar: SAMPLE_CALENDAR }),
  attachments: (o) => [calendarFile(o.calendar, "CANCEL")],
};

type RemovedData = { who: VolunteerWho; shift: VolunteerShiftWords; why: "staff" | "moved"; contact: string; link: string; calendar: string };
export const volunteerRemoved: EmailDef<RemovedData> = {
  key: "volunteer_removed", group: "Volunteering", title: "Place freed", sentWhen: "When staff take someone off a shift.",
  fields: VOLUNTEER_FIELDS, values: volunteerValues,
  fixed: [
    { id: "removed", label: "why the place was freed", render: (o) => {
      const where = `a shift at ${o.shift.event}${o.shift.role ? ` (${o.shift.role})` : ""}`;
      return lines([o.why === "staff"
        ? `The club has taken ${o.who.self ? "your place" : `${o.who.name}'s place`} off ${where}, so ${o.who.self ? "you don't" : `${o.who.name} doesn't`} need to come.`
        : `${o.who.self ? "Your" : `${o.who.name}'s`} place on ${where} has been freed, because ${o.who.self ? "you're" : `${o.who.name} is`} no longer listed with your family in the club's records.`]);
    } },
    { id: "shift", label: "the shift it was", render: (o) => lines([`The shift was: ${o.shift.when}, at ${o.shift.location}.`]) },
    calendarLine("If you added it to your calendar, opening the calendar file with this email takes it out again."),
    { id: "link", label: "who to contact, and their other sign-ups", render: (o) => lines([`If this is a surprise, please contact ${o.contact}. Your other sign-ups are here: ${o.link}`]) },
  ],
  links: true,
  subject: { default: "Your place has been freed: {Event}" },
  body: doc(fixedPart("removed"), fixedPart("shift"), fixedPart("calendar"), fixedPart("link")),
  sample: (b) => ({ who: SAMPLE_WHO, shift: SAMPLE_SHIFT, why: "staff", contact: SHIFT_CONTACT.sample, link: sampleLink(b, "/volunteer"), calendar: SAMPLE_CALENDAR }),
  attachments: (o) => [calendarFile(o.calendar, "CANCEL")],
};

type TomorrowData = { who: VolunteerWho; shift: VolunteerShiftWords; contact: string; link: string };
export const volunteerReminder: EmailDef<TomorrowData> = {
  key: "volunteer_reminder", group: "Volunteering", title: "Shift tomorrow", sentWhen: "The day before a shift.",
  fields: VOLUNTEER_FIELDS, values: volunteerValues,
  fixed: [
    { id: "tomorrow", label: "who is helping tomorrow, and where", render: (o) => lines([`A friendly reminder: ${o.who.self ? "you're" : `${o.who.name} is`} helping at ${o.shift.event}${o.shift.role ? ` (${o.shift.role})` : ""} tomorrow.`]) },
    shiftFixed(),
    { id: "link", label: "the link to their sign-ups", render: (o) => lines([`Your sign-ups are here: ${o.link}`]) },
  ],
  links: true,
  subject: { default: "Tomorrow: {Event}" },
  body: doc(fixedPart("tomorrow"), fixedPart("shift"),
    para("When you get there, scan the club's check-in code to be checked in. Questions, or can't make it? Contact ", f("shiftContact"), "."),
    para("Scanning the code opens your phone's web browser. If you use the portal as an app on your home screen, sign in to the portal in your browser too before you go, so you're ready to check in."),
    fixedPart("link"), para("Thank you for giving your time!")),
  sample: (b) => ({ who: SAMPLE_WHO, shift: SAMPLE_SHIFT, contact: SHIFT_CONTACT.sample, link: sampleLink(b, "/volunteer") }),
};

const DUE: FieldDef = { id: "due", label: "Due date", sample: "Friday, September 4" };
const DAYS_LEFT: FieldDef = { id: "daysLeft", label: "Days left", sample: "7" };
type VolunteerDueData = { dueWords: string; daysLeft: number; items: VolunteerDueWords[]; link: string };
export const volunteerDue: EmailDef<VolunteerDueData> = {
  key: "volunteer_due", group: "Volunteering", title: "Volunteering due", sentWhen: "Before a family's volunteering is due.",
  fields: [...COMMON, DUE, DAYS_LEFT],
  values: (d, b) => ({ ...common(b), due: d.dueWords, daysLeft: String(d.daysLeft) }),
  fixed: [
    { id: "items", label: "what the family still has to do", render: (o) => lines(o.items.map((i) => `${i.title}: ${i.standing}. ${i.whoMust}.`)) },
    { id: "link", label: "the link to pick a shift", render: (o) => lines([`You can pick a shift here: ${o.link}`]) },
  ],
  links: true,
  subject: { default: "Volunteering due {Due date}" },
  body: doc(para("Just a heads-up: some of the volunteering the club asks of your family is due ", f("due"), ", ", f("daysLeft"), " days from now."),
    fixedPart("items"), fixedPart("link"), para("Thank you for everything you do for the club!")),
  sample: (b) => ({ dueWords: DUE.sample, daysLeft: 7, items: [{ title: "Volunteer 6 hours", standing: "2 of 6 hours done", whoMust: "Any guardian can help" }], link: sampleLink(b, "/volunteer") }),
};

type RequirementDueData = { dueWords: string; daysLeft: number; items: RequirementDueWords[]; season: string; payments: string | null };
export const requirementDue: EmailDef<RequirementDueData> = {
  key: "requirement_due", group: "Season and messages", title: "Something's due", sentWhen: "Before a payment or checklist item is due.",
  fields: [...COMMON, DUE, DAYS_LEFT, { id: "whatsDue", label: "What's due", sample: "Band fee" }],
  values: (d, b) => ({ ...common(b), due: d.dueWords, daysLeft: String(d.daysLeft), whatsDue: d.items.length === 1 ? d.items[0]!.title : `${d.items.length} things for the club` }),
  fixed: [
    { id: "intro", label: "what is due, and when", render: (o) => {
      const one = o.items.length === 1;
      return lines([`A friendly reminder: ${one ? "something" : "a few things"} the club asks of your family ${one ? "is" : "are"} due ${o.dueWords}, ${o.daysLeft} days from now.`]);
    } },
    { id: "items", label: "the list of what's due", render: (o) => lines(o.items.map((i) => `${i.title}${i.forName ? ` for ${i.forName}` : ""}: ${i.standing}.`)) },
    { id: "links", label: "the links to Payments and the season", render: (o) => lines([
      ...(o.payments ? [`You can see what's owed and pay on the Payments page: ${o.payments}`] : []),
      `Everything the club asks this season is here: ${o.season}`,
    ]) },
  ],
  links: true,
  subject: { default: "Due {Due date}: {What's due}" },
  body: doc(fixedPart("intro"), fixedPart("items"), fixedPart("links"), para("If you've taken care of this in the last day or so, thank you, and you can ignore this email.")),
  sample: (b) => ({ dueWords: DUE.sample, daysLeft: 7, items: [{ title: "Band fee", forName: "Maya Ortiz", standing: "Not paid yet" }], season: sampleLink(b, "/season"), payments: sampleLink(b, "/payments") }),
};

type ClubMessageData = { poster: string; title: string; update: boolean; body: ClubMessageBody; files: string[]; link: string };
export const clubMessage: EmailDef<ClubMessageData> = {
  key: "club_message", group: "Season and messages", title: "Club message", sentWhen: "When staff post or update a message and email families.",
  fields: [...COMMON, { id: "poster", label: "Posted by", sample: "Dana Reyes" }, { id: "title", label: "Message title", sample: "Uniform fittings on Saturday" }],
  values: (d, b) => ({ ...common(b), poster: d.poster, title: d.title }),
  fixed: [
    { id: "lead", label: "who posted it", render: (o, b) => lines([`${o.poster} ${o.update ? "updated a message" : "posted a message"} for the families of ${b.clubName}.`]) },
    { id: "message", label: "the message, with its title and files", render: (o) => {
      const download = "Open the message in the portal to download them.";
      return [
        { text: o.title, html: `<h1 style="margin:0 0 16px;font-size:22px">${esc(o.title)}</h1>` },
        { text: o.body.text ? o.body.text : null, html: o.body.html },
        ...(o.files.length ? [{ text: `Files with this message:\n${o.files.map((x) => `- ${x}`).join("\n")}\n${download}`,
          html: `${PARAGRAPH}Files with this message:</p><ul style="margin:0 0 16px">${o.files.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>${PARAGRAPH}${download}</p>` }] : []),
      ];
    } },
    { id: "link", label: "the link to the message", render: (o) => {
      const open = o.update ? "Read it, and its earlier versions, in the portal:" : "Read it in the portal:";
      return [{ text: open, html: lineHtml(open) }, { text: o.link, html: lineHtml({ link: o.link }) }];
    } },
  ],
  links: true,
  subject: { default: "{Message title}", wrap: (d, s) => (d.update ? `Updated: ${s}` : s) },
  body: doc(fixedPart("lead"), fixedPart("message"), fixedPart("link")),
  sample: (b) => ({ poster: "Dana Reyes", title: "Uniform fittings on Saturday", update: false, files: [], link: sampleLink(b, "/messages"),
    body: { text: "Fittings are in the band room from 9 to noon. Bring the shoes you'll march in.",
      html: `${PARAGRAPH}Fittings are in the band room from 9 to noon. Bring the shoes you&#39;ll march in.</p>` } }),
};

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Every email, in the list's order. */
export const EMAILS = [
  signinCode, changeCode, welcome, choosePassword, passwordSetup, passwordReset, signinReset, passwordChanged, emailChangeConfirm, emailChangeNotice,
  formReminder, formCopy,
  volunteerSignup, volunteerChange, volunteerCancel, volunteerRemoved, volunteerReminder, volunteerDue,
  requirementDue, clubMessage,
] as const satisfies readonly EmailDef<any>[];
/* eslint-enable @typescript-eslint/no-explicit-any */
type AnyEmail = EmailDef<unknown>;

export const emailByKey = (key: unknown): AnyEmail | null =>
  typeof key === "string" ? ((EMAILS as readonly unknown[]).find((e) => (e as AnyEmail).key === key) as AnyEmail | undefined) ?? null : null;

/** What checkTemplate() needs of an email. */
export const rulesOf = (e: Pick<AnyEmail, "fields" | "fixed" | "links" | "subject">): TemplateRules =>
  ({ fields: e.fields, fixed: e.fixed, links: e.links, subjectFixed: "fixed" in e.subject });

/** The email's default words, as a template: what "Use the default words" saves. */
export const defaultTemplate = (e: AnyEmail): { subject: string | null; body: TemplateDoc } =>
  ({ subject: "default" in e.subject ? e.subject.default : null, body: e.body });

/**
 * The words one email is sent with: the club's, when it saved some that still pass this release's rules, or the
 * default. `usable` is false when the club's saved words no longer pass (a release changed the email's fields or
 * fixed parts): the email is then sent with its default, and the settings page says the club's words need a look.
 */
export function wordsFor(e: AnyEmail, saved: { subject: string | null; body: unknown } | undefined): { subject: string | null; body: TemplateDoc; club: boolean; usable: boolean } {
  if (saved) {
    const c = checkTemplate(rulesOf(e), saved);
    if (c.ok) return { subject: c.subject, body: c.body, club: true, usable: true };
    return { ...defaultTemplate(e), club: false, usable: false };
  }
  return { ...defaultTemplate(e), club: false, usable: true };
}

/** One email, drawn for one send from the given words (the club's or the default) and this send's data. */
export function renderEmail<D>(e: EmailDef<D>, b: Brand, to: string, d: D, words?: { subject: string | null; body: TemplateDoc }): MailMessage {
  const w = words ?? wordsFor(e as unknown as AnyEmail, b.templates?.[e.key]);
  const values = e.values(d, b);
  const blocks = renderBody(w.body, values, (id) => e.fixed.find((x) => x.id === id)?.render(d, b) ?? []);
  const subject = "fixed" in e.subject ? e.subject.fixed(d, b)
    : (e.subject.wrap ?? ((_d: D, s: string) => s))(d, renderSubject(w.subject ?? e.subject.default, e.fields, values));
  const attachments = e.attachments?.(d);
  return { to, subject, text: mailText(blocks), html: mailHtml(b, blocks), ...(attachments ? { attachments } : {}) };
}

/** One email filled with its samples: the preview, and Send me a test. */
export const sampleEmail = (e: AnyEmail, b: Brand, to: string, words: { subject: string | null; body: TemplateDoc }): MailMessage =>
  renderEmail(e, b, to, e.sample(b), words);

/** Each field's sample, with the club's own name, address and contact where the page knows them. */
export function sampleValues(e: AnyEmail, b: Brand): FieldDef[] {
  const v = e.values(e.sample(b), b);
  return e.fields.map((x) => ({ ...x, sample: v[x.id] ?? x.sample }));
}

export type { Line };
