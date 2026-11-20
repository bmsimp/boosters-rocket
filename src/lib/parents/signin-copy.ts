// The sign-in page's fixed sentences (spec §1, and the sign-in release, slice SI-3b). No imports: the client component uses this file.
/** The page's lede, above the form: what signing in is for, and that a new device takes a code too. */
export const SIGNIN_LEDE = "Sign in with your email and password to see your students, what's owed, the forms to sign and the volunteer shifts. On a device we don't know yet, we'll also email you a code.";
/**
 * One answer for every refusal at the password step but too many tries (an address nobody holds, no password yet, a
 * wrong password, a blocked person, nobody the club lets in, sign-ins off), so the page can't tell anyone whether an
 * address is on file. The page shows it with a link to "Set up or reset my password". Too many tries is TOO_MANY_TRIES,
 * with no link: the count is taken by what was typed before anything is read, so it is the same for any address.
 */
export const PASSWORD_REJECTED = "That email and password didn't work. Check them and try again. If you haven't set up a password yet, or you've forgotten it, you can set up or reset it.";
/** The second step, once the password was right on a device the portal doesn't remember. It never says whether the mail went. */
export const CODE_SENT = "To finish signing in on this device, enter the 6-digit code we've emailed you. It can take a minute. Check your spam folder too.";
/**
 * The second step for a guardian with an authenticator app (the sign-in release, slice SI-6a; open question 24): the
 * code comes from their app, a backup code works in its place, and with neither the club can help. Nothing is emailed.
 */
export const APP_ASKED = "To finish signing in on this device, enter the 6-digit code from your authenticator app. If you don't have your phone with you, enter one of your backup codes instead. If you have neither, ask the club for help.";
/** The app step's one field: the app's code, or a backup code. */
export const APP_CODE_LABEL = "Code from your authenticator app, or a backup code";
/** One answer for a wrong or used code at the app step, or a second step that has ended. */
export const APP_REJECTED = "That code didn't work. Enter the newest code from your authenticator app, or a backup code you haven't used yet, or start again with your email and password.";
/** One answer for a wrong, expired, used-up or never-sent code, or a second step that has ended. */
export const CODE_REJECTED = "That code didn't work. Check the newest email from us and try again, or start again with your email and password.";
/**
 * Shown on the password step when an open code step's time ran out (a code works only while its step lasts, 10 minutes
 * from the right password, however late it was resent). It never says whether a code was sent.
 */
export const CODE_STEP_ENDED = "Time ran out for that code. Enter your email and password again to get a new one.";
/**
 * Shown on the password step when an open app step's time ran out (slice SI-6a): nothing is ever emailed at the app
 * step, so it promises no new code, only the app's again.
 */
export const APP_STEP_ENDED = "Time ran out. Enter your email and password again, then the code from your authenticator app.";
/** Over a limit at either step (and, at the password step, the portal too busy to check a password just then). */
export const TOO_MANY_TRIES ="Too many tries. Wait a few minutes and try again.";
export const SIGNIN_UNAVAILABLE = "Parent sign-in isn't available yet.";
export const SIGNIN_NETWORK_FAILED = "We couldn't reach the portal just then. Please try again in a moment.";
/** What to say when a request came back without an answer to read. `status` is the HTTP status, or null when nothing came back. */
export function signinFailure(status: number | null): string {
  return status === 429 ? TOO_MANY_TRIES : SIGNIN_NETWORK_FAILED; // 429 is the portal turning the browser away, not a network fault
}
