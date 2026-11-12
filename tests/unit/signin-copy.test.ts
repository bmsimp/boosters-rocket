import { describe, it, expect } from "vitest";
import { signinFailure, TOO_MANY_TRIES, SIGNIN_NETWORK_FAILED } from "@/lib/parents/signin-copy";

describe("what the sign-in page says when a request fails", () => {
  it("says too many tries for a 429, which is the portal's own limit and not a network fault", () => {
    expect(signinFailure(429)).toBe(TOO_MANY_TRIES);
  });
  it("says the portal couldn't be reached for anything else, or when nothing came back", () => {
    for (const status of [null, 500, 502, 503, 404, 400]) expect(signinFailure(status)).toBe(SIGNIN_NETWORK_FAILED);
  });
});
