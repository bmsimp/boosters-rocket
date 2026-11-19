// Which link the page "Set up or reset my password" mails (the sign-in release, slice SI-3a; open questions 23 and 34
// of the app-owned families spec). Pure: it imports nothing, so it can be read and tested alone, and a later slice
// extends it in this one place.

/** The club's sign-in level, as ParentSettings.level holds it (./settings.ts). */
export type RequestLevel = "standard" | "strict";

/** A link to mail, or none and why (the reason goes in the `parent.password.reset_asked` row only). */
export type LinkToMail = { mail: "setup" | "reset" } | { mail: null; reason: "strict_no_setup" | "strict_no_factor" };

/**
 * For a person the page may mail (a sign-in address, not blocked, a sign-in account, a row that counts, sign-ins on):
 * - Standard: a set-up link to a person with no password, and a reset link to one who has one.
 * - Strict (open questions 23 and 34): no set-up link is mailed on request, since under Strict a first password comes
 *   with a second factor the club sees set up (`strict_no_setup`); and a reset link only to a guardian who already has
 *   a second factor, a passkey or an authenticator app, so that a reset by email alone never opens an account
 *   (`strict_no_factor` otherwise). Until slices SI-6 and SI-7 build them nobody has one, so under Strict nothing is
 *   mailed, and the page tells everyone that a guardian who can't sign in asks the club.
 */
export function whichLinkToMail(o: { level: RequestLevel; hasPassword: boolean; hasSecondFactor: boolean }): LinkToMail {
  if (o.level === "standard") return { mail: o.hasPassword ? "reset" : "setup" };
  if (!o.hasPassword) return { mail: null, reason: "strict_no_setup" };
  return o.hasSecondFactor ? { mail: "reset" } : { mail: null, reason: "strict_no_factor" };
}
