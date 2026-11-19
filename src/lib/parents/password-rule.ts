/**
 * The rule a parent's password must meet (the sign-in release; open question 27 of the app-owned families spec): at
 * least PASSWORD_MIN and at most PASSWORD_MAX characters, any characters at all. Nothing about symbols, digits, case or
 * mixing them. Characters are counted by Unicode code point, not by UTF-16 unit: an accented letter typed as one
 * character, or most single emoji, is one, but a combined emoji (a skin tone, a flag, a family joined by zero-width
 * joiners) or an accent typed as its own mark counts as its parts, so a page that puts the rule in words says
 * "characters" and never promises a person's count. A password is never trimmed or changed, since a space is a
 * character like any other.
 *
 * Pure. Called by choosePasswordFromLink() (./password-set.ts), the set-up and reset links' form, since slice SI-2.
 * It answers with a code, which that function turns into words (password-copy.ts), and never logs, keeps or returns the
 * password.
 */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/** Why a password can't be used; `not_text` is anything the browser sent that isn't a string. */
export type PasswordProblem = "not_text" | "too_short" | "too_long";
export type PasswordVerdict = { ok: true } | { ok: false; problem: PasswordProblem };

/** Whether `password` meets the rule. It comes from the browser, whatever the type says, so anything is accepted and checked. */
export function checkPasswordRule(password: unknown): PasswordVerdict {
  if (typeof password !== "string") return { ok: false, problem: "not_text" };
  // A code point is one or two UTF-16 units, so a string of more than twice the most is too long however it is made,
  // and is turned away before it is split.
  if (password.length > PASSWORD_MAX * 2) return { ok: false, problem: "too_long" };
  const length = [...password].length;
  if (length > PASSWORD_MAX) return { ok: false, problem: "too_long" };
  return length < PASSWORD_MIN ? { ok: false, problem: "too_short" } : { ok: true };
}
