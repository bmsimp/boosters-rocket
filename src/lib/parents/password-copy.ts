import { PASSWORD_MAX, PASSWORD_MIN } from "./password-rule";

/**
 * The words of the pages a set-up or reset link opens (src/app/sign-in/set-up/[token], reset/[token]) and of their
 * form's answers. Plain strings, so the form (a client component) and the action share them. A link that can't be used
 * gets one sentence whatever the reason, and an answer over a limit gets the same one: nothing here tells a visitor
 * whose link it was, or why it was refused. The rule is said in "characters" and never promises a person's count
 * (./password-rule.ts counts code points).
 */
export const PASSWORD_COPY = {
  linkNoGood: "This link can't be used. A link works once, and only for a while.",
  linkNoGoodTitle: "This link can't be used",
  setupTitle: "Choose a password",
  resetTitle: "Choose a new password",
  rule: `Use ${PASSWORD_MIN} to ${PASSWORD_MAX} characters of any kind, spaces included. A few unrelated words make a password that's easy to remember and hard to guess.`,
  mismatch: "The two passwords don't match. Please type the same one in both.",
  tooShort: `That password is too short. Please use at least ${PASSWORD_MIN} characters.`,
  tooLong: `That password is too long. Please use at most ${PASSWORD_MAX} characters.`,
  breached: "That password has turned up in a data breach on another site, so it isn't safe here. Please choose another, like a few unrelated words you haven't used anywhere else.",
  set: "Your password is set.",
  /** A set-up that signed the parent in (the club's level is Standard): the form goes on to their page. */
  signingIn: "Your password is set. Signing you in…",
  /** The link to where a signed-in parent goes, should the page not move on by itself. */
  continueIn: "Continue",
  // The page "Set up or reset my password" (src/app/sign-in/password; slice SI-3a). Its answer is one sentence for
  // every address and every outcome: it never says whether an address is known, has a password, or was mailed.
  askTitle: "Set up or reset my password",
  askLede: "Enter the email you sign in with, and we'll send you a link to set up or reset your password.",
  askButton: "Email me a link",
  askAnswer: "If that address can sign in here, we've emailed it a link. It can take a minute, and the link works once. Check your spam folder too.",
  /**
   * Under Strict, to everyone, before and after asking: a guardian with no passkey or app, or who lost theirs, asks the
   * club (slice SI-10b's words).
   */
  askStrict: "No passkey or authenticator app yet, or lost yours? Please ask the club, and they'll help you sign in.",
  /**
   * Under Strict the lede and the answer promise a link only to a holder of a passkey or an app: no set-up link is sent
   * on request, and a reset only to a holder of a second factor (whichLinkToMail(), password-request-rule.ts). Still one
   * set of words for every address: the level is the club's, the same for every visitor.
   */
  askLedeStrict: "Enter the email you sign in with. If you have a passkey or an authenticator app, we'll email you a link to choose a new password.",
  askAnswerStrict: "If that address can reset its password here, we've emailed it a link. It can take a minute, and the link works once. Check your spam folder too. If no email comes, please ask the club.",
  /** What the form says when the action itself couldn't be reached or threw: try again, nothing about why. */
  failed: "That didn't go through. Please try again in a moment.",
} as const;

/**
 * What the request form shows at the club's level: its lede, the Strict note (or none), and the answer after an ask
 * (null: the action's own answer, PASSWORD_COPY.askAnswer). Under Strict a reset link is mailed only to a holder of a
 * passkey or an app, and the words say so. The same for every address.
 */
export function askWords(strict: boolean): { lede: string; note: string | null; answer: string | null } {
  return strict
    ? { lede: PASSWORD_COPY.askLedeStrict, note: PASSWORD_COPY.askStrict, answer: PASSWORD_COPY.askAnswerStrict }
    : { lede: PASSWORD_COPY.askLede, note: null, answer: null };
}
