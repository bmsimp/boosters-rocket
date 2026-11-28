import { frame, lineHtml, mailText, type Brand } from "@/lib/email-templates/frame";
import * as T from "@/lib/email-templates/catalog";
import {
  renderEmail,
  type ClubMessageBody, type EarlierLinkWords, type RequirementDueWords, type SetupLinkWords, type VolunteerDueWords, type VolunteerShiftWords, type VolunteerWho,
} from "@/lib/email-templates/catalog";
import type { MailMessage } from "./types";

/*
 * The mails the portal sends, one function each, as the senders call them. Since the email templates
 * (docs/superpowers/specs/2026-11-28-email-templates-design.md) each is drawn from its template in @/lib/email-templates/catalog.ts: the
 * club's own words where it saved some (`Brand.templates`, read by currentBrand()), else the default words, which are
 * the words each sent before, byte for byte (tests/unit/mail-templates.test.ts). The links, codes and safety lines are
 * the templates' fixed parts, written by the portal whatever the words around them.
 */

export { esc, POWERED_BY, type Brand } from "@/lib/email-templates/frame";
export type { ClubMessageBody, EarlierLinkWords, RequirementDueWords, SetupLinkWords, VolunteerDueWords, VolunteerShiftWords, VolunteerWho };


/** The second step of a sign-in on a new device: the code, sent only after the right password. The subject carries the code (tests/e2e/journey-helpers.ts reads it). */
export const signinCodeMessage = (b: Brand, to: string, code: string, o: { passwordPage: string; minutes: number }): MailMessage =>
  renderEmail(T.signinCode, b, to, { code, ...o });
/** The code that confirms a change to how a parent signs in, asked for in a session that is already signed in. */
export const changeCodeMessage = (b: Brand, to: string, code: string, o: { settingsPage: string; minutes: number }): MailMessage =>
  renderEmail(T.changeCode, b, to, { code, ...o });
/** The welcome: a new set-up link, the earlier one that still works, or (null) where to sign in with a password. It names no family. */
export const welcomeMessage = (b: Brand, to: string, o: { appUrl: string; contact: string | null; link: SetupLinkWords | EarlierLinkWords | null }): MailMessage =>
  renderEmail(T.welcome, b, to, o);
/** The set-up link an Admin's press mails to a person the club welcomed before, who has no password. */
export const choosePasswordMessage = (b: Brand, to: string, o: { appUrl: string; contact: string | null; link: SetupLinkWords }): MailMessage =>
  renderEmail(T.choosePassword, b, to, o);
/** A parent's change of sign-in address, to the new address: the link that confirms it. */
export const emailChangeConfirmMessage = (b: Brand, to: string, o: { link: string }): MailMessage => renderEmail(T.emailChangeConfirm, b, to, o);
/** The same change, to the old address: that it was asked for. No link, and not the new address. */
export const emailChangeNoticeMessage = (b: Brand, to: string): MailMessage => renderEmail(T.emailChangeNotice, b, to, {});
/** A set-up link from "Set up or reset my password": the person has no password yet. */
export const passwordSetupMessage = (b: Brand, to: string, o: { link: string; life: string }): MailMessage => renderEmail(T.passwordSetup, b, to, o);
/** A reset link from "Set up or reset my password": the person has a password, and chooses a new one with it. */
export const passwordResetMessage = (b: Brand, to: string, o: { link: string; life: string }): MailMessage => renderEmail(T.passwordReset, b, to, o);
/** The mail of an Admin's reset of a parent's sign-in. It names no family, student, other person or Admin. */
export const signinResetMessage = (b: Brand, to: string, o: { link: string; life: string; contact: string | null; strict: boolean }): MailMessage =>
  renderEmail(T.signinReset, b, to, o);
/** The notice after a parent changed their password in sign-in settings. No link that acts. */
export const passwordChangedMessage = (b: Brand, to: string, o: { passwordPage: string; contact: string | null }): MailMessage =>
  renderEmail(T.passwordChanged, b, to, o);

/** On signing up for a shift: the shift, until when it can be cancelled, and a calendar file. */
export const volunteerSignupMessage = (b: Brand, to: string, o: { who: VolunteerWho; shift: VolunteerShiftWords; contact: string; cancelUntil: string | null; link: string; calendar: string }): MailMessage =>
  renderEmail(T.volunteerSignup, b, to, o);
/** When staff change a shift's time or place: what it was, what it is now, and the calendar file again. */
export const volunteerChangeMessage = (b: Brand, to: string, o: { who: VolunteerWho; before: VolunteerShiftWords; after: VolunteerShiftWords; contact: string; link: string; calendar: string }): MailMessage =>
  renderEmail(T.volunteerChange, b, to, o);
/** When staff cancel a shift or the whole event. */
export const volunteerCancelMessage = (b: Brand, to: string, o: { who: VolunteerWho; shift: VolunteerShiftWords; whole: "event" | "shift"; contact: string; calendar: string }): MailMessage =>
  renderEmail(T.volunteerCancel, b, to, o);
/** A signed form's copy, to a guardian who signed it, with the sealed PDF when it is small enough, else the download link. */
export const signedFormCopyMessage = (b: Brand, to: string, o: { formTitle: string; forName: string; pdf: Buffer | null; link: string; parts?: number }): MailMessage =>
  renderEmail(T.formCopy, b, to, o);
/** A reminder that a form still needs this guardian's signature. */
export const formReminderMessage = (b: Brand, to: string, o: { formTitle: string; forNames: string[]; due: string | null; pastDue?: boolean; link: string }): MailMessage =>
  renderEmail(T.formReminder, b, to, o);
/** When the club gives up one place: staff removed the sign-up, or its student is no longer listed with the family. */
export const volunteerRemovedMessage = (b: Brand, to: string, o: { who: VolunteerWho; shift: VolunteerShiftWords; why: "staff" | "moved"; contact: string; link: string; calendar: string }): MailMessage =>
  renderEmail(T.volunteerRemoved, b, to, o);
/** The day before a shift: where and when, and who to contact. */
export const volunteerReminderMessage = (b: Brand, to: string, o: { who: VolunteerWho; shift: VolunteerShiftWords; contact: string; link: string }): MailMessage =>
  renderEmail(T.volunteerReminder, b, to, o);
/** A nudge before a due date: what the family still has to do. Nothing about any other family. */
export const volunteerDueMessage = (b: Brand, to: string, o: { dueWords: string; daysLeft: number; items: VolunteerDueWords[]; link: string }): MailMessage =>
  renderEmail(T.volunteerDue, b, to, o);
/** A reminder before a due date of payments and checklist items. Nothing about any other family, and no note staff wrote. */
export const requirementDueMessage = (b: Brand, to: string, o: { dueWords: string; daysLeft: number; items: RequirementDueWords[]; season: string; payments: string | null }): MailMessage =>
  renderEmail(T.requirementDue, b, to, o);
/** A club message, or an edit of one, to one parent's sign-in address. Nothing is attached and nothing is loaded. */
export const clubMessageMail = (b: Brand, to: string, o: { poster: string; title: string; update: boolean; body: ClubMessageBody; files: string[]; link: string }): MailMessage =>
  renderEmail(T.clubMessage, b, to, o);

/** Outgoing mail's test: not a template, since it proves the connection. */
export function testMessage(b: Brand, to: string): MailMessage {
  const line = `This is a test from the ${b.clubName} portal. Outgoing mail works.`;
  return { to, subject: `Test email from ${b.clubName}`, text: mailText([{ text: line, html: "" }]), html: frame(b, lineHtml(line)) };
}
