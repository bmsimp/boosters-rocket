"use server";
import { enrolmentAction } from "@/lib/guards";
import { confirmMyAuthenticator, startMyAuthenticator, type CodesAnswer, type SetupAnswer } from "@/lib/parents/authenticator-settings";
import { ENROLMENT_COPY } from "@/lib/parents/enrolment-copy";
import { enrolWindowPassed } from "@/lib/parents/enrolment";
import { SIGNIN_SETTINGS_COPY as COPY } from "@/lib/parents/signin-settings-copy";

/**
 * Strict's enrolment (/one-more-step; the sign-in release, slice SI-10a): setting up an authenticator app in two
 * presses, for an enrolling session alone (enrolmentAction, src/lib/guards.ts: the door "enrolment", allowed in this
 * file only). A passkey is added through the door's own /portal-passkey/add (SI-7b's add, unchanged), so it has no
 * action here. Neither takes an id: whose app it is comes from the session (`ctx`). Every argument comes from the
 * browser, whatever its type says, and the work (authenticator-settings.ts) checks each: the code a string of at most
 * 20, the stamp one this session was given. The work is SI-6b's, which since SI-10a takes an enrolling session where it
 * asked for a proof within the window (sessionMayAddFactor(), src/lib/parents/enrolment.ts), and whose confirm makes
 * the session whole. A refusal for want of a proof means here that the session may no longer add one: answered in
 * the enrolment's own words, with `signInAgain`, so the page offers Sign in; the words say the 30 minutes have passed
 * only when the window has (enrolWindowPassed()), and otherwise only to sign in again (a factor added through another
 * session, the club's level changed), and after a refused confirm add that the entry the app saved is dead. The
 * confirm's answers for a set-up that is over are put in the enrolment's words too, whose advice is what this page can
 * do (Sign-in settings' offer to turn the app off there is not).
 */
export type EnrolmentAppStart = SetupAnswer | { ok: false; errors: string[]; signInAgain: true };
export type EnrolmentAppConfirm = CodesAnswer | { ok: false; errors: string[]; signInAgain: true };

/** The work's answers that mean the session may no longer add a factor: Sign-in settings' "show it's you again" and "the 10 minutes ran out". */
const noLongerEnrolling = (errors: readonly string[]) => errors.length === 1 && (errors[0] === COPY.proveAgain || errors[0] === COPY.appSetupTimedOut);
/** The refusal for a session that may no longer add one, in words true of why; `setupShown` for a confirm, whose QR code the app may have saved. */
async function signInAgain(ctx: { parentId: string; sessionId: string }, setupShown: boolean) {
  const why = (await enrolWindowPassed(ctx)) ? ENROLMENT_COPY.windowPassed : ENROLMENT_COPY.signInAgain;
  return { ok: false as const, errors: setupShown ? [why, ENROLMENT_COPY.appEntryDead] : [why], signInAgain: true as const };
}
/** Sign-in settings' words for a set-up that is over, and this page's for each. */
const SETUP_OVER: ReadonlyMap<string, string> = new Map([
  [COPY.appSetupGone, ENROLMENT_COPY.appSetupGone],
  [COPY.appSetupReplaced, ENROLMENT_COPY.appSetupReplaced],
  [COPY.appSetupDoneElsewhere, ENROLMENT_COPY.appSetupDoneElsewhere],
]);

export const startEnrolmentAppAction = enrolmentAction(async (ctx): Promise<EnrolmentAppStart> => {
  const r = await startMyAuthenticator(ctx);
  return !r.ok && noLongerEnrolling(r.errors) ? signInAgain(ctx, false) : r;
});

export const confirmEnrolmentAppAction = enrolmentAction(async (ctx, code: unknown, stamp: unknown): Promise<EnrolmentAppConfirm> => {
  const r = await confirmMyAuthenticator(ctx, code, stamp);
  if (r.ok) return r;
  if (noLongerEnrolling(r.errors)) return signInAgain(ctx, true);
  return { ...r, errors: r.errors.map((e) => SETUP_OVER.get(e) ?? e) };
});
