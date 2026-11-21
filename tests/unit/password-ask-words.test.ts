import { describe, it, expect } from "vitest";
import { askWords, PASSWORD_COPY } from "@/lib/parents/password-copy";

/**
 * The words of "Set up or reset my password" at each level (the sign-in release, slice SI-3a; Strict's words since
 * SI-10b). Under Strict no set-up link is mailed on request and a reset only to a holder of a passkey or an app
 * (whichLinkToMail()), so what the form shows, before and after an ask, promises a link only to such a holder, the same
 * for every address, and tells everyone else to ask the club.
 */
describe("the request form's words", () => {
  it("at Standard: the lede says a link is emailed, and the answer is the action's own", () => {
    expect(askWords(false)).toEqual({ lede: PASSWORD_COPY.askLede, note: null, answer: null });
  });

  it("under Strict: a link promised only to a holder of a passkey or an app, and the note to ask the club", () => {
    // Changed on purpose by slice SI-10b: SI-6a mails a factor holder a reset at Strict, so "no link is emailed" was untrue.
    const w = askWords(true);
    expect(w).toEqual({ lede: PASSWORD_COPY.askLedeStrict, note: PASSWORD_COPY.askStrict, answer: PASSWORD_COPY.askAnswerStrict });
    expect(w.lede).toBe("Enter the email address you sign in with. If you have a passkey or an authenticator app, we'll email you a link to choose a new password.");
    expect(w.note).toBe("If you don't have a passkey or an authenticator app yet, or you've lost yours, please ask the club. They'll help you set up or reset your sign-in.");
    expect(w.answer).toBe("If that address can reset its password here, we've emailed it a link. It can take a minute, and the link works once. Check your spam folder too. If no email comes, please ask the club.");
    // Nothing promises a link to set up a password: none is mailed on request at Strict.
    for (const words of [w.lede, w.note!, w.answer!]) expect(words).not.toMatch(/link to set up|set up your password/i);
  });
});
