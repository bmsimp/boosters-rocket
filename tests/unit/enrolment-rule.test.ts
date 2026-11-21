import { describe, it, expect } from "vitest";
import { ENROL_WINDOW_MS, sessionStanding } from "@/lib/parents/enrolment-rule";

const SIGNED_IN = new Date("2026-11-20T18:00:00.000Z");
const UNTIL = new Date(SIGNED_IN.getTime() + ENROL_WINDOW_MS);
const at = (ms: number) => new Date(UNTIL.getTime() + ms);

describe("a session's standing under the club's level (the sign-in release, slice SI-10a)", () => {
  it("gives an enrolling session thirty minutes", () => {
    expect(ENROL_WINDOW_MS).toBe(30 * 60 * 1000);
  });

  it("is enrolling at Strict, with no factor, until the second its window ends, and ended from then on", () => {
    const strict = (now: Date) => sessionStanding({ level: "strict", enrolUntil: UNTIL, hasSecondFactor: false, now });
    expect(strict(SIGNED_IN)).toEqual({ standing: "enrolling" });
    expect(strict(at(-1000))).toEqual({ standing: "enrolling" });
    expect(strict(at(0))).toEqual({ standing: "ended", reason: "enrol_ended" });
    expect(strict(at(1000))).toEqual({ standing: "ended", reason: "enrol_ended" });
  });

  it("ends an enrolling session once the person has a factor, added through another session (it became whole then)", () => {
    for (const now of [SIGNED_IN, at(-1000), at(1000)]) {
      expect(sessionStanding({ level: "strict", enrolUntil: UNTIL, hasSecondFactor: true, now })).toEqual({ standing: "ended", reason: "enrol_ended" });
    }
  });

  it("ends an enrolling session once the club is back at Standard, within its window or after it, with a factor or without", () => {
    for (const now of [SIGNED_IN, at(-1000), at(1000)]) {
      for (const hasSecondFactor of [false, true]) {
        expect(sessionStanding({ level: "standard", enrolUntil: UNTIL, hasSecondFactor, now })).toEqual({ standing: "ended", reason: "enrol_ended" });
      }
    }
  });

  it.each([
    ["standard", false, { standing: "whole" }],
    ["standard", true, { standing: "whole" }],
    ["strict", true, { standing: "whole" }],
    ["strict", false, { standing: "ended", reason: "strict_no_factor" }],
  ] as const)("with no window, at %s, with a factor: %s", (level, hasSecondFactor, wanted) => {
    for (const now of [SIGNED_IN, at(-1000), at(1000)]) expect(sessionStanding({ level, enrolUntil: null, hasSecondFactor, now })).toEqual(wanted);
  });

  it("never lets a session of a person with no factor be whole under Strict, however it was made", () => {
    for (const enrolUntil of [null, UNTIL]) {
      for (const now of [SIGNED_IN, at(-1000), at(0), at(1000)]) {
        expect(sessionStanding({ level: "strict", enrolUntil, hasSecondFactor: false, now }).standing).not.toBe("whole");
      }
    }
  });
});
