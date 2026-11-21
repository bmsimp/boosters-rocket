"use server";
import { enrolmentAction } from "@/lib/guards";
import { confirmMyAuthenticator, startMyAuthenticator, type CodesAnswer, type SetupAnswer } from "@/lib/parents/authenticator-settings";
import { ENROLMENT_COPY } from "@/lib/parents/enrolment-copy";
import { SIGNIN_SETTINGS_COPY as COPY } from "@/lib/parents/signin-settings-copy";

/**
 * Strict's enrolment (/one-more-step; the sign-in release, slice SI-10a): setting up an authenticator app in two
 * presses, for an enrolling session alone (enrolmentAction, src/lib/guards.ts: the door "enrolment", allowed in this
 * file only). A passkey is added through the door's own /portal-passkey/add (SI-7b's add, unchanged), so it has no
 * action here. Neither takes an id: whose app it is comes from the session (`ctx`). Every argument comes from the
 * browser, whatever its type says, and the work (authenticator-settings.ts) checks each: the code a string of at most
 * 20, the stamp one this session was given. The work is SI-6b's, which since SI-10a takes an enrolling session where it
 * asked for a proof within the window (sessionMayAddFactor(), src/lib/parents/enrolment.ts), and whose confirm makes
 * the session whole. A refusal for want of a proof means here that the enrolment's window has passed (or the session
 * can't add one any more): answered in the enrolment's own words, with `signInAgain`, so the page offers Sign in.
 */
export type EnrolmentAppStart = SetupAnswer | { ok: false; errors: string[]; signInAgain: true };
export type EnrolmentAppConfirm = CodesAnswer | { ok: false; errors: string[]; signInAgain: true };

const SIGN_IN_AGAIN = { ok: false as const, errors: [ENROLMENT_COPY.windowPassed], signInAgain: true as const };
/** The work's answers that mean the session may no longer add a factor: Sign-in settings' "show it's you again" and "the 10 minutes ran out". */
const noLongerEnrolling = (errors: readonly string[]) => errors.length === 1 && (errors[0] === COPY.proveAgain || errors[0] === COPY.appSetupTimedOut);

export const startEnrolmentAppAction = enrolmentAction(async (ctx): Promise<EnrolmentAppStart> => {
  const r = await startMyAuthenticator(ctx);
  return !r.ok && noLongerEnrolling(r.errors) ? SIGN_IN_AGAIN : r;
});

export const confirmEnrolmentAppAction = enrolmentAction(async (ctx, code: unknown, stamp: unknown): Promise<EnrolmentAppConfirm> => {
  const r = await confirmMyAuthenticator(ctx, code, stamp);
  return !r.ok && noLongerEnrolling(r.errors) ? SIGN_IN_AGAIN : r;
});
