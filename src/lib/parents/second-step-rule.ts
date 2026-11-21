// Which second step a right password asks for on a device the portal doesn't remember (the sign-in release, slice SI-3b;
// open questions 21 and 24 of the app-owned families spec, and the table in its section 6). Pure: it imports nothing,
// so it can be read and tested alone (tests/unit/second-step-rule.test.ts), and later slices extend it in this one place.

/** The club's sign-in level, as ParentSettings.level holds it (./settings.ts). */
export type StepLevel = "standard" | "strict";

/**
 * The second step to ask for, or none and why (the reason goes in the `signin.password_refused` row only):
 * - `emailed_code`: a 6-digit code mailed to the person's sign-in address (signin_code, ./signin-codes.ts);
 * - `second_factor`: the person's own second factor: since slice SI-6a their authenticator app in force (its code or a
 *   backup code, /portal-app/check), and since slice SI-7a a passkey (/portal-passkey/check), which the password step
 *   reads (hasAuthenticator(), ./authenticator.ts, and hasPasskey(), ./passkeys.ts).
 */
export type SecondStep = { step: "emailed_code" | "second_factor" } | { step: null; reason: "strict_no_factor" };

/**
 * - A person with a second factor of their own is asked for it at either level, never for the emailed code (open
 *   question 24: a holder of an authenticator app or a passkey never gets the code).
 * - Standard: otherwise the emailed code.
 * - Strict: an emailed code is never a second step (it proves only the mailbox, which the password's reset proves
 *   too), so a person with no second factor has none and is not signed in by password (`strict_no_factor`). A device
 *   the portal remembers proved only the mailbox as well, so under Strict its caller asks this before it looks at one.
 */
export function secondStepFor(o: { level: StepLevel; hasSecondFactor: boolean }): SecondStep {
  if (o.hasSecondFactor) return { step: "second_factor" };
  return o.level === "standard" ? { step: "emailed_code" } : { step: null, reason: "strict_no_factor" };
}
