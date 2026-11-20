import { describe, it, expect } from "vitest";
import { signinFailure, TOO_MANY_TRIES, SIGNIN_NETWORK_FAILED, SIGNIN_LEDE, PASSWORD_REJECTED, CODE_SENT, CODE_REJECTED, CODE_STEP_ENDED, APP_STEP_ENDED } from "@/lib/parents/signin-copy";

describe("what the sign-in page says when a request fails", () => {
  it("says too many tries for a 429, which is the portal's own limit and not a network fault", () => {
    expect(signinFailure(429)).toBe(TOO_MANY_TRIES);
  });
  it("says the portal couldn't be reached for anything else, or when nothing came back", () => {
    for (const status of [null, 500, 502, 503, 404, 400]) expect(signinFailure(status)).toBe(SIGNIN_NETWORK_FAILED);
  });
});

describe("the sign-in page's words (the sign-in release, slice SI-3b)", () => {
  it("asks for the email and password, and promises a code only on a device the portal doesn't know", () => {
    expect(SIGNIN_LEDE).toMatch(/email and password/);
    expect(SIGNIN_LEDE).toMatch(/On a device we don't know yet, we'll also ask for a code\./);
    // Said before anyone is known: true for a guardian with an authenticator app too, so it never says the code is emailed.
    expect(SIGNIN_LEDE).not.toMatch(/email(?:ed)? (?:you )?a code|authenticator/i);
    expect(SIGNIN_LEDE).not.toMatch(/6-digit code\.$/);
  });
  it("gives every refusal at the password step one answer, which names no reason and points to setting up or resetting a password", () => {
    expect(PASSWORD_REJECTED).toBe("That email and password didn't work. Check them and try again. If you haven't set up a password yet, or you've forgotten it, you can set up or reset it.");
    for (const tell of [/blocked/i, /not on file/i, /no account/i, /isn't (?:a|in)/i, /club doesn't/i]) expect(PASSWORD_REJECTED).not.toMatch(tell);
  });
  it("asks for the code on this device without saying whether the mail went, and refuses a code in words that lead back to the start", () => {
    expect(CODE_SENT).toMatch(/6-digit code/);
    expect(CODE_SENT).toMatch(/this device/);
    expect(CODE_SENT).not.toMatch(/If this email belongs/);
    expect(CODE_REJECTED).toMatch(/start again with your email and password/);
  });
  it("says a code step's time ran out without saying whether a code was sent, and leads back to the password", () => {
    expect(CODE_STEP_ENDED).toBe("Time ran out for that code. Enter your email and password again to get a new one.");
    expect(CODE_STEP_ENDED).not.toMatch(/sent|didn't|never/i);
  });
  it("says an app step's time ran out without promising a new code, since nothing is emailed at the app step", () => {
    expect(APP_STEP_ENDED).toBe("Time ran out. Enter your email and password again, then the code from your authenticator app.");
    expect(APP_STEP_ENDED).not.toMatch(/new one|email(?!\s+and)|sent/i);
  });
  it("says too many tries without promising a new code, since the password step meets it too", () => {
    expect(TOO_MANY_TRIES).toBe("Too many tries. Wait a few minutes and try again.");
    // Nor a reset: the password step shows it over a limit, and a reset ends every session and doesn't shorten the wait.
    expect(TOO_MANY_TRIES).not.toMatch(/reset|password|code/i);
  });
});
