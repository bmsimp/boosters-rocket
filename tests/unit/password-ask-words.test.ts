import { describe, it, expect } from "vitest";
import { askWords, PASSWORD_COPY } from "@/lib/parents/password-copy";

/**
 * The words of "Set up or reset my password" at each level (the sign-in release, slice SI-3a). Under Strict nothing is
 * mailed on request (whichLinkToMail(), until SI-6 and SI-7), so nothing the form shows, before or after an ask, says a
 * link was or will be emailed, and it tells everyone to ask the club.
 */
const PROMISES = [/we'll email/i, /we've emailed/i, /spam/i];

describe("the request form's words", () => {
  it("at Standard: the lede says a link is emailed, and the answer is the action's own", () => {
    expect(askWords(false)).toEqual({ lede: PASSWORD_COPY.askLede, note: null, answer: null });
  });

  it("under Strict: no promise of an email before or after asking, and the note to ask the club", () => {
    const w = askWords(true);
    expect(w).toEqual({ lede: PASSWORD_COPY.askLedeStrict, note: PASSWORD_COPY.askStrict, answer: PASSWORD_COPY.askAnswerStrict });
    for (const words of [w.lede, w.note!, w.answer!]) for (const p of PROMISES) expect(words).not.toMatch(p);
    // The action's own answer, which the Strict answer replaces after an ask, is the one that promises a mail.
    expect(PASSWORD_COPY.askAnswer).toMatch(PROMISES[1]!);
  });
});
