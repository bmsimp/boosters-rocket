import { describe, it, expect } from "vitest";
import { secondStepFor } from "@/lib/parents/second-step-rule";

describe("the second step a right password asks for", () => {
  it.each([
    ["standard", false, { step: "emailed_code" }],
    ["standard", true, { step: "second_factor" }],
    ["strict", false, { step: null, reason: "strict_no_factor" }],
    ["strict", true, { step: "second_factor" }],
  ] as const)("at %s, with a second factor: %s", (level, hasSecondFactor, wanted) => {
    expect(secondStepFor({ level, hasSecondFactor })).toEqual(wanted);
  });

  it("never asks an authenticator app holder for the emailed code, at either level (open question 24; slice SI-6a)", () => {
    for (const level of ["standard", "strict"] as const) expect(secondStepFor({ level, hasSecondFactor: true })).toEqual({ step: "second_factor" });
  });

  it("never asks for the emailed code under Strict", () => {
    for (const hasSecondFactor of [false, true]) expect(secondStepFor({ level: "strict", hasSecondFactor }).step).not.toBe("emailed_code");
  });
});
