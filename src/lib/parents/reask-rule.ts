// Asking again (the sign-in release, slice SI-5a; open question 28 of the app-owned families spec): the one rule that
// decides whether a session proved itself recently enough to change how its person signs in. Pure: no imports, so the
// page, the actions and a unit test read the same rule.

/**
 * How recently a session must have proved the password and the second step (`parent_auth_session.strong_at`) for a
 * change of how its person signs in (the password, the sign-in email; later a passkey or the authenticator app) to go
 * ahead without asking again: 10 minutes (open question 28). A sign-in stamps `strong_at` (recordStrongSignin(),
 * devices.ts), and so does asking again (askAgainCode(), asking-again.ts); a stamp a remembered device's sign-in made
 * is not taken as a proof (sessionStrongAt(), asking-again.ts), since there the device stood in for the second step.
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
