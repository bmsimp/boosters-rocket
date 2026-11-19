// The sign-in page's fixed sentences (spec §1, and the sign-in release, slice SI-3b). No imports: the client component uses this file.
/** The page's lede, above the form: what signing in is for, and that a new device takes a code too. */
export const SIGNIN_LEDE = "Sign in with your email and password to see your students, what's owed, the forms to sign and the volunteer shifts. On a device we don't know yet, we'll also email you a code.";
/**
 * One answer for every refusal at the password step (an address nobody holds, no password yet, a wrong password, a
 * blocked person, nobody the club lets in, sign-ins off, too many tries), so the page can't tell anyone whether an
 * address is on file. The page shows it with a link to "Set up or reset my password".
 */
export const PASSWORD_REJECTED = "That email and password didn't work. Check them and try again. If you haven't set up a password yet, or you've forgotten it, you can set up or reset it.";
/** The second step, once the password was right on a device the portal doesn't remember. It never says whether the mail went. */
export const CODE_SENT = "To finish signing in on this device, enter the 6-digit code we've emailed you. It can take a minute. Check your spam folder too.";
/** One answer for a wrong, expired, used-up or never-sent code, or a second step that has ended. */
export const CODE_REJECTED = "That code didn't work. Check the newest email from us and try again, or start again with your email and password.";
export const TOO_MANY_TRIES = "Too many tries. Wait a few minutes and try again.";
export const SIGNIN_UNAVAILABLE = "Parent sign-in isn't available yet.";
export const SIGNIN_NETWORK_FAILED = "We couldn't reach the portal just then. Please try again in a moment.";
/** What to say when a request came back without an answer to read. `status` is the HTTP status, or null when nothing came back. */
export function signinFailure(status: number | null): string {
  return status === 429 ? TOO_MANY_TRIES : SIGNIN_NETWORK_FAILED; // 429 is the portal turning the browser away, not a network fault
}
