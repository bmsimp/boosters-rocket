// Strict's enrolment, as a rule (the sign-in release, slice SI-10a; section 6 of the app-owned families spec, "Signing
// in", and open questions 21, 22 and 34): what a parent session may reach, given the club's level, the session's
// `enrol_until` (parent_auth_session, migration 0054) and whether its person has a second factor in force. Pure: no
// imports, so a unit test reads every answer (tests/unit/enrolment-rule.test.ts).

/**
 * How long a session made under Strict by a password alone may stay enrolling: 30 minutes from the sign-in, long enough
 * to install an authenticator app and scan its code, short enough that a session a password alone made holds that power
 * only briefly. The one finish sets `enrol_until` to the sign-in's time plus this (src/lib/auth/parent-signin-finish.ts).
 */
export const ENROL_WINDOW_MS = 30 * 60 * 1000;

/** Why a session can't go on: its window passed, the club is back at Standard or a factor came another way (`enrol_ended`), or Strict with no factor (`strict_no_factor`). */
export type StandingReason = "enrol_ended" | "strict_no_factor";
/**
 * What a session may reach: `whole` (whatever the gate's other checks allow: a family's pages, the chooser), `enrolling`
 * (only /one-more-step, where the person adds a passkey or an authenticator app), or `ended` (signed out at this
 * request, with the reason for its `signin.refused` row).
 */
export type SessionStanding = { standing: "whole" } | { standing: "enrolling" } | { standing: "ended"; reason: StandingReason };

/**
 * The standing of a session (the lead's decision 3 of SI-10a). A session with `enrolUntil` set is enrolling only while
 * the club is at Strict, the person has no second factor in force and `now` is before `enrolUntil`; otherwise it is
 * ended (`enrol_ended`: the window passed, the club went back to Standard, or the person added a factor through another
 * session, which became whole then, so this one signs in again). A session with no `enrolUntil` is whole at Standard,
 * and at Strict whole for a person with a factor and ended (`strict_no_factor`) for one with none: under Strict a
 * session of a person with no second factor that is not enrolling is signed out at its next request, whenever and
 * however it was made (an emailed code's at Standard, one from before the release, one a race let through), so no path
 * through email alone reaches a family's page.
 */
export function sessionStanding(o: { level: "standard" | "strict"; enrolUntil: Date | null; hasSecondFactor: boolean; now: Date }): SessionStanding {
  if (o.enrolUntil !== null) {
    return o.level === "strict" && !o.hasSecondFactor && o.now.getTime() < o.enrolUntil.getTime()
      ? { standing: "enrolling" } : { standing: "ended", reason: "enrol_ended" };
  }
  if (o.level === "standard" || o.hasSecondFactor) return { standing: "whole" };
  return { standing: "ended", reason: "strict_no_factor" };
}
