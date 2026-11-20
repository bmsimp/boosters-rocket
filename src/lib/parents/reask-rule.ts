// Asking again (the sign-in release, slice SI-5a; open question 28 of the app-owned families spec): the one rule that
// decides whether a session proved itself recently enough to change how its person signs in. Pure: no imports, so the
// page, the actions and a unit test read the same rule.

/**
 * How recently a session must have proved the password and the second step (`parent_auth_session.strong_at`) for a
 * change of how its person signs in (the password, the sign-in email; later a passkey or the authenticator app) to go
 * ahead without asking again: 10 minutes (open question 28). A sign-in that proved the password and a second step itself
 * stamps `strong_at` (recordStrongSignin(), devices.ts: the emailed code, or a set-up link), and so does asking again
 * (askAgainCode(), asking-again.ts); a sign-in on a remembered device stamps nothing, since there the device stood in
 * for the second step.
 */
export const REASK_WINDOW_MS = 10 * 60 * 1000;

/**
 * Whether a session that last proved itself at `strongAt` is within the window at `now`: proved, no longer ago than
 * REASK_WINDOW_MS, and not in the future (a time ahead of the server's clock is no proof). A session made before the
 * password release has none (`strongAt` null) and is asked like any other.
 */
export function provedRecently(strongAt: Date | null, now: Date): boolean {
  if (strongAt === null) return false;
  const age = now.getTime() - strongAt.getTime();
  return age >= 0 && age <= REASK_WINDOW_MS;
}

/**
 * Whether a session's proof at `strongAt` still counts beside the person's authenticator app, in force since `appSince`
 * (null with none): a proof made before the app came into force does not (the sign-in release, slice SI-6b's second
 * read, the lead's decision 1). It may have been made with the emailed code, which the app has since replaced, in
 * another session minutes before the app was set up; the session is asked again, and for an app holder that asks for
 * the app's code. A proof made at the very moment the app came into force counts. Every reader of a session's proof
 * goes through this, by sessionStrongAt() (asking-again.ts), before provedRecently().
 */
export function proofCountsBesideApp(strongAt: Date, appSince: Date | null): boolean {
  return appSince === null || strongAt.getTime() >= appSince.getTime();
}
