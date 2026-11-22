// The sign-in page's fixed sentences (spec §1, and the sign-in release, slice SI-3b). No imports: the client component uses this file.
/**
 * The page's lede, above the form: what signing in is for, and that a new device takes one more step. Drawn before
 * anyone is known, so it says nothing of what that step is (an emailed code, since slice SI-6b a guardian's
 * authenticator app, since SI-7a their passkey): the step after the password says which.
 */
export const SIGNIN_LEDE = "Sign in with your email and password. On a new device, we'll ask for one more thing to be sure it's you.";
/**
 * The passkey's way in on the first screen (the sign-in release, slice SI-7a; open question 30): the same for every
 * visitor, with no address asked, since the browser offers the passkey. The sentence says what a passkey is, for a
 * parent who has never heard the word, and promises nothing about adding one.
 */
export const PASSKEY_BUTTON = "Sign in with a passkey";
export const PASSKEY_EXPLAINED = "A passkey signs you in with your face, fingerprint or PIN instead of a password.";
/** Said in the button's place where the browser can't use passkeys at all. */
export const PASSKEY_UNSUPPORTED = "This browser can't use passkeys. You can still sign in with your email and password.";
/** Said in the button's place when the page was reached at an address other than the portal's own. */
export const passkeyElsewhere = (origin: string) => `Passkeys work only at ${origin}. You can still sign in here with your email and password.`;
/** The person cancelled the browser's passkey prompt, or the browser refused it: words, never an error. */
export const PASSKEY_CANCELLED = "Your passkey wasn't used. You can try again, or sign in with your email and password.";
/** One answer for a passkey that didn't sign in, whatever the reason. */
export const PASSKEY_REJECTED = "That passkey didn't work. Try it again, or sign in with your email and password.";
/**
 * The passkey step, once a passkey holder's password was right on a device the portal doesn't remember: never "we
 * emailed you", since nothing is. Beside it, for a guardian with an authenticator app too, the app's code or a backup
 * code (PASSKEY_OR_APP); with nothing beside it, that the club can help (PASSKEY_ONLY).
 */
export const PASSKEY_ASKED = "Use your passkey to finish signing in on this device.";
export const PASSKEY_OR_APP = "Or enter the 6-digit code from your authenticator app, or one of your backup codes.";
export const PASSKEY_ONLY = "If you don't have your passkey with you, ask the club for help.";
/**
 * Beside the passkey for a guardian with no authenticator app who holds unspent backup codes (slice SI-7b: they get ten
 * with their first passkey), in one field labelled BACKUP_CODE_LABEL; every refusal there is BACKUP_REJECTED.
 */
export const PASSKEY_OR_BACKUP = "No passkey with you? Use one of your backup codes. If you have neither, ask the club for help.";
export const BACKUP_CODE_LABEL = "Backup code";
/** One answer for a wrong or used backup code beside a passkey alone, or a second step that has ended. */
export const BACKUP_REJECTED = "That code didn't work. Enter a backup code you haven't used yet, use your passkey, or start again with your email and password.";
export const PASSKEY_USE = "Use your passkey";
/**
 * The passkey step's own words where it can't go on or didn't: never "sign in with your email and password", since the
 * password is already right and leads back to this same step (the emailed code is never a passkey holder's). The way
 * on is what the step's status line offers beside it (PASSKEY_OR_APP, or PASSKEY_ONLY), or another browser or device.
 */
export const PASSKEY_STEP_UNSUPPORTED = "This browser can't use passkeys. Try a phone, computer or browser that has your passkey.";
export const passkeyStepElsewhere = (origin: string) => `Passkeys work only at ${origin}. Go there to use yours.`;
export const PASSKEY_STEP_CANCELLED = "Your passkey wasn't used. You can try it again.";
export const PASSKEY_STEP_REJECTED = "That passkey didn't work. You can try it again.";
/** A passkey refused in a way that ended the step: the page goes back to the password step and says to start over. */
export const PASSKEY_STEP_FAILED = "That passkey didn't work.";
/** Shown on the password step when an open passkey step's time ran out: it promises no code, since none is emailed. */
export const PASSKEY_STEP_ENDED = "Time ran out. Enter your email and password again, then use your passkey.";
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
export const APP_ASKED = "Enter the 6-digit code from your authenticator app, or one of your backup codes. If you have neither, ask the club for help.";
/** The app step's one field: the app's code, or a backup code. */
export const APP_CODE_LABEL = "Code from your authenticator app, or a backup code";
/** One answer for a wrong or used code at the app step, or a second step that has ended. */
export const APP_REJECTED = "That code didn't work. Enter the newest code from your authenticator app, or a backup code you haven't used yet, or start again with your email and password.";
/**
 * Said after APP_REJECTED when the app step's refusal ended the step (slice SI-6b): the page is back at the password,
 * whatever ended it (the answer never says why).
 */
export const APP_STEP_OVER = "Please enter your email and password again to start over.";
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
