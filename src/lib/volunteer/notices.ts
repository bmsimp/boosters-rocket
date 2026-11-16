// The volunteer emails (v1 spec §11.3): built from one sign-up at a time, sent after the write they follow has been
// committed. Each goes to the guardian who took the place and says only what is theirs.
import "server-only";
import { env } from "@/env";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { sendMail, currentBrand } from "@/lib/mail/send";
import { volunteerCancelMessage, volunteerChangeMessage, volunteerSignupMessage, type VolunteerShiftWords, type VolunteerWho } from "@/lib/mail/messages";
import type { MailMessage } from "@/lib/mail/types";
import { calendarFile } from "./calendar";
import { beforeCutoff, dateWords, instantWords, shiftInstants, shiftTimeWords } from "./clock";

/** What an email needs of an event and one of its shifts. */
export type ShiftFacts = {
  event: { name: string; onDate: string; location: string; description: string; contactName: string; contactEmail: string | null };
  shift: { startsAt: string; endsAt: string; role: string | null; revision: number };
};
/** One sign-up as an email needs it: whose place it is and where the email goes. */
export type SignupFacts = { signupId: string; to: string; who: VolunteerWho };

export const contactWords = (e: Pick<ShiftFacts["event"], "contactName" | "contactEmail">) => (e.contactEmail ? `${e.contactName} (${e.contactEmail})` : e.contactName);
export const shiftWords = (f: ShiftFacts): VolunteerShiftWords => ({
  event: f.event.name, role: f.shift.role, location: f.event.location,
  when: `${dateWords(f.event.onDate)}, ${shiftTimeWords(f.shift.startsAt, f.shift.endsAt)}`,
});
const volunteerLink = () => `${env.APP_URL.replace(/\/+$/, "")}/volunteer`;

/** The calendar file for one sign-up on a shift as it is now. */
export function calendarFor(signupId: string, f: ShiftFacts, zone: string, now: Date): string {
  const { start, end } = shiftInstants(f.event.onDate, f.shift.startsAt, f.shift.endsAt, zone);
  return calendarFile({ signupId, revision: f.shift.revision, start, end, stamp: now,
    summary: `Volunteering: ${f.event.name}${f.shift.role ? ` (${f.shift.role})` : ""}`, location: f.event.location,
    description: [f.event.description, `Questions? Contact ${contactWords(f.event)}.`].filter(Boolean).join("\n\n") });
}

/** The confirmation of a new sign-up, with the calendar file, and the time until which it can be cancelled on the portal. */
export async function signupConfirmation(s: SignupFacts, f: ShiftFacts, o: { zone: string; cutoffHours: number; now: Date }): Promise<MailMessage> {
  const { start } = shiftInstants(f.event.onDate, f.shift.startsAt, f.shift.endsAt, o.zone);
  const cutoff = new Date(start.getTime() - o.cutoffHours * 3_600_000);
  return volunteerSignupMessage(await currentBrand(), s.to, { who: s.who, shift: shiftWords(f), contact: contactWords(f.event),
    cancelUntil: beforeCutoff(start, o.cutoffHours, o.now) ? instantWords(cutoff, o.zone) : null, link: volunteerLink(), calendar: calendarFor(s.signupId, f, o.zone, o.now) });
}

export type Notice = { kind: "change"; signup: SignupFacts; before: ShiftFacts; after: ShiftFacts } | { kind: "cancel"; signup: SignupFacts; facts: ShiftFacts; whole: "event" | "shift" };

const NOTICE_ACTOR: Actor = { door: "system", id: null, label: "volunteer notices" };

/**
 * Sends the notices a staff change or cancellation calls for, one email to each sign-up's guardian, after the change
 * is committed. A failed send is audited by sendMail() without its body; the counts are audited here.
 */
export async function sendNotices(notices: readonly Notice[], o: { zone: string; now?: Date; actor?: Actor; ip?: string | null; targetId?: string }): Promise<{ sent: number; failed: number }> {
  if (notices.length === 0) return { sent: 0, failed: 0 };
  const brand = await currentBrand(), now = o.now ?? new Date();
  let sent = 0, failed = 0;
  for (const n of notices) {
    const m = n.kind === "change"
      ? volunteerChangeMessage(brand, n.signup.to, { who: n.signup.who, before: shiftWords(n.before), after: shiftWords(n.after), contact: contactWords(n.after.event), link: volunteerLink(),
          calendar: calendarFor(n.signup.signupId, n.after, o.zone, now) })
      : volunteerCancelMessage(brand, n.signup.to, { who: n.signup.who, shift: shiftWords(n.facts), whole: n.whole, contact: contactWords(n.facts.event) });
    const r = await sendMail(m, { purpose: "volunteer_notice", actor: o.actor ?? NOTICE_ACTOR, ip: o.ip ?? null });
    if (r.ok) sent++; else failed++;
  }
  await writeAudit({ actor: o.actor ?? NOTICE_ACTOR, action: "volunteer.notice.sent", targetType: "volunteer_event", targetId: o.targetId, ip: o.ip ?? null,
    after: { kind: notices[0]!.kind, signups: notices.map((n) => n.signup.signupId), sent, failed } });
  return { sent, failed };
}
