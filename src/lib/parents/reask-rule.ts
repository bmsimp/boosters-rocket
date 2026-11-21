// Asking again (the sign-in release, slice SI-5a; open question 28 of the app-owned families spec): the one rule that
// decides whether a session proved itself recently enough to change how its person signs in. Pure: no imports, so the
// page, the actions and a unit test read the same rule.

/**
 * How recently a session must have proved the password and the second step (`parent_auth_session.strong_at`) for a
 * change of how its person signs in (the password, the sign-in email, the authenticator app; from SI-7b a passkey) to go
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
 * Whether a session's proof at `strongAt` still counts beside the person's second factors, the newest of which came
 * into force at `newestSince` (null with none; newestFactorSince()): a proof made before it does not (the sign-in
 * release, slice SI-6b's second read, the lead's decision 1, extended in slice SI-7a from the authenticator app to the
 * newest of the app and the person's passkeys). It may have been made with the emailed code, which the newer factor has
 * since replaced, in another session minutes before it was added; the session is asked again. A proof made at the very
 * moment the factor came into force counts. Every reader of a session's proof goes through this, by sessionStrongAt()
 * (asking-again.ts), before provedRecently().
 */
export function proofCountsBesideNewestFactor(strongAt: Date, newestSince: Date | null): boolean {
  return newestSince === null || strongAt.getTime() >= newestSince.getTime();
}

/**
 * When the person's newest second factor came into force, or null with none: the later of their authenticator app's
 * (`confirmed_at`, authenticatorInForceSince()) and their newest passkey's (`created_at`, newestPasskeySince(),
 * passkeys.ts; since slice SI-7a, where only a seeded passkey can be newer than a proof until SI-7b adds them).
 */
export function newestFactorSince(appSince: Date | null, passkeySince: Date | null): Date | null {
  if (appSince === null) return passkeySince;
  if (passkeySince === null) return appSince;
  return appSince.getTime() >= passkeySince.getTime() ? appSince : passkeySince;
}
