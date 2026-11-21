import { describe, it, expect } from "vitest";
import { whichLinkToMail } from "@/lib/parents/password-request-rule";

/** Which link "Set up or reset my password" mails (slice SI-3a; open questions 23 and 34), for every input. */
describe("which link to mail", () => {
  it.each([
    ["standard", false, false, { mail: "setup" }],
    ["standard", false, true, { mail: "setup" }],
    ["standard", true, false, { mail: "reset" }],
    ["standard", true, true, { mail: "reset" }],
    ["strict", false, false, { mail: null, reason: "strict_no_setup" }],
    ["strict", false, true, { mail: null, reason: "strict_no_setup" }],
    ["strict", true, false, { mail: null, reason: "strict_no_factor" }],
    ["strict", true, true, { mail: "reset" }],
  ] as const)("%s, a password %s, a second factor %s", (level, hasPassword, hasSecondFactor, want) => {
    expect(whichLinkToMail({ level, hasPassword, hasSecondFactor })).toEqual(want);
  });
});
