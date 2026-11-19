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
  rule: `Use at least ${PASSWORD_MIN} characters, and at most ${PASSWORD_MAX}. Any characters count, spaces too. A few unrelated words together are easy to remember and hard to guess.`,
  mismatch: "The two passwords don't match. Please type the same password in both boxes.",
  tooShort: `That password is too short. Please use at least ${PASSWORD_MIN} characters: a few unrelated words together make a long one that's easy to remember.`,
  tooLong: `That password is too long. Please use at most ${PASSWORD_MAX} characters.`,
  breached: "That password has appeared in a known data breach on another site, so it isn't safe to use here. Please choose another: a few unrelated words together, ones you haven't used anywhere else, make a strong one.",
  set: "Your password is set.",
  /** A set-up that signed the parent in (the club's level is Standard): the form goes on to their page. */
  signingIn: "Your password is set. Signing you in…",
  /** The link to where a signed-in parent goes, should the page not move on by itself. */
  continueIn: "Continue",
  // The page "Set up or reset my password" (src/app/sign-in/password; slice SI-3a). Its answer is one sentence for
  // every address and every outcome: it never says whether an address is known, has a password, or was mailed.
  askTitle: "Set up or reset my password",
  askLede: "Enter the email address you sign in with. We'll email you a link to set up your password, or to choose a new one if you've forgotten it.",
  askButton: "Email me a link",
  askAnswer: "If that address can sign in here, we've emailed it a link. It can take a minute, and the link works once. Check your spam folder too.",
  /** Under Strict, to everyone, before and after asking: nothing is mailed on request for now, so a guardian asks the club. */
  askStrict: "If you can't sign in, please ask the club. They'll help you set up or reset your password.",
  /**
   * Under Strict the lede and the answer promise no email, since none is sent on request (whichLinkToMail(),
   * password-request-rule.ts, until SI-6 and SI-7 give a guardian a second factor; those slices change these words).
   * Still one set of words for every address: the level is the club's, the same for every visitor.
   */
  askLedeStrict: "Enter the email address you sign in with. For now, links to set up or reset a password aren't emailed from here.",
  askAnswerStrict: "Thank you. For now, no link is emailed from here.",
  /** What the form says when the action itself couldn't be reached or threw: try again, nothing about why. */
  failed: "That didn't go through. Please try again in a moment.",
} as const;

/**
 * What the request form shows at the club's level: its lede, the Strict note (or none), and the answer after an ask
 * (null: the action's own answer, PASSWORD_COPY.askAnswer). Under Strict nothing is mailed on request, so neither the
 * lede nor the answer says a link was or will be emailed. The same for every address.
 */
export function askWords(strict: boolean): { lede: string; note: string | null; answer: string | null } {
  return strict
    ? { lede: PASSWORD_COPY.askLedeStrict, note: PASSWORD_COPY.askStrict, answer: PASSWORD_COPY.askAnswerStrict }
    : { lede: PASSWORD_COPY.askLede, note: null, answer: null };
}
