import { describe, it, expect } from "vitest";
import { parentDoorClosed, CLOSED_PARENT_SETTINGS, DEFAULT_PARENT_SETTINGS, parseParentSettings, storedLevel } from "@/lib/parents/settings";

describe("the parents setting", () => {
  it("defaults to everything off, at the Standard level", () => {
    expect(DEFAULT_PARENT_SETTINGS).toEqual({ signin: false, welcome: false, requireActiveStudents: false, level: "standard" });
  });
  it("reads a stored value; with none stored gives the defaults; a stored value it can't read fails closed", () => {
    expect(parseParentSettings({ signin: true, welcome: false, requireActiveStudents: true, level: "standard" }))
      .toEqual({ signin: true, welcome: false, requireActiveStudents: true, level: "standard" });
    expect(parseParentSettings({ signin: true, welcome: false, requireActiveStudents: true, level: "strict" }))
      .toEqual({ signin: true, welcome: false, requireActiveStudents: true, level: "strict" });
    expect(parseParentSettings(undefined)).toEqual(DEFAULT_PARENT_SETTINGS);
    expect(CLOSED_PARENT_SETTINGS).toEqual({ signin: false, welcome: false, requireActiveStudents: false, level: "standard" });
    for (const bad of [null, "on", 3, { signin: "yes" }, []]) {
      expect(parseParentSettings(bad)).toEqual(CLOSED_PARENT_SETTINGS);
      expect(parentDoorClosed(parseParentSettings(bad))).toBe(true);
    }
  });
  it("reads a value stored with a retired key (the staff review switch, everEnabled) as the same switches, with it or without it", () => {
    // Values stored before the held-address review went still hold `reviewEmails`, and those stored before stage 3's
    // slice 7b `everEnabled`: a parse that failed on either would close the door to every parent at the deploy.
    for (const retired of [{ reviewEmails: true }, { reviewEmails: false }, { everEnabled: true }, { everEnabled: false }, { reviewEmails: true, everEnabled: true }]) {
      for (const signin of [true, false]) {
        const without = { signin, welcome: signin, requireActiveStudents: !signin, level: "standard" };
        const before = { ...without, ...retired };
        expect(parseParentSettings(before)).toEqual(without);
        expect(parseParentSettings(without)).toEqual(without);
        expect(parentDoorClosed(parseParentSettings(before))).toBe(!signin);
      }
    }
    expect(parseParentSettings({ ...DEFAULT_PARENT_SETTINGS, reviewEmails: true })).toEqual(DEFAULT_PARENT_SETTINGS);
  });
  it("reads every value stored before the sign-in level existed as the same switches at the Standard level", () => {
    // Every shape stored before slice SI-1 holds no `level`: one with `everEnabled`, one with `reviewEmails`, one with
    // both, one with neither, and what scripts/seed-e2e.ts stores. A parse that refused any of them would close the door
    // to every parent at the deploy.
    const switches = [
      { signin: true, welcome: false, requireActiveStudents: false }, // scripts/seed-e2e.ts
      { signin: true, welcome: true, requireActiveStudents: true },
      { signin: false, welcome: false, requireActiveStudents: false },
      { signin: false, welcome: true, requireActiveStudents: true },
    ];
    for (const s of switches) {
      for (const retired of [{}, { everEnabled: true }, { everEnabled: false }, { reviewEmails: true }, { reviewEmails: false }, { everEnabled: true, reviewEmails: false }]) {
        const read = parseParentSettings({ ...s, ...retired });
        expect(read).toEqual({ ...s, level: "standard" });
        expect(parentDoorClosed(read)).toBe(!s.signin);
      }
    }
    // The e2e specs that switch sign-ins on store this shape (tests/e2e/family-email.spec.ts, keyboard-journeys.spec.ts).
    expect(parseParentSettings({ signin: true, everEnabled: true, welcome: false, requireActiveStudents: false }))
      .toEqual({ signin: true, welcome: false, requireActiveStudents: false, level: "standard" });
  });
  it("closes the door for a level that is neither Standard nor Strict, rather than reading it as either", () => {
    for (const level of ["Standard", "STRICT", "relaxed", "", null, 1, true, {}, ["strict"]]) {
      const read = parseParentSettings({ signin: true, welcome: true, requireActiveStudents: false, level });
      expect(read).toEqual(CLOSED_PARENT_SETTINGS);
      expect(parentDoorClosed(read)).toBe(true);
    }
  });
  it("reads the level a stored value names, whether or not the rest of it parses (storedLevel())", () => {
    // Slice SI-10b: a save after a value that fails to parse keeps the level it names, or refuses until one is chosen.
    expect(storedLevel({ signin: true, welcome: false, requireActiveStudents: false, level: "standard" })).toBe("standard");
    expect(storedLevel({ signin: true, welcome: false, requireActiveStudents: false, level: "strict" })).toBe("strict");
    expect(storedLevel({ signin: true, welcome: 1, level: "strict" })).toBe("strict");
    expect(storedLevel({ signin: "yes", level: "standard" })).toBe("standard");
    // A plain object with no `level` key: every value stored before slice SI-1, readable or not.
    expect(storedLevel({ signin: true, welcome: false, requireActiveStudents: false })).toBe("standard");
    expect(storedLevel({ signin: "yes" })).toBe("standard");
    expect(storedLevel({})).toBe("standard");
    // Not a plain object, or a level that is neither word.
    for (const value of [null, undefined, "strict", 3, true, [], ["strict"], [{ level: "strict" }]]) expect(storedLevel(value)).toBeNull();
    for (const level of ["Standard", "STRICT", "relaxed", "", null, 1, true, {}, ["strict"]]) expect(storedLevel({ signin: true, level })).toBeNull();
  });
  it("closes the parent door unless sign-ins are on, before they were ever switched on as after", () => {
    expect(parentDoorClosed({ ...DEFAULT_PARENT_SETTINGS })).toBe(true); // never switched on: nobody signs in
    expect(parentDoorClosed({ ...DEFAULT_PARENT_SETTINGS, signin: true })).toBe(false);
    for (const everEnabled of [true, false]) {
      expect(parentDoorClosed(parseParentSettings({ signin: false, everEnabled, welcome: false, requireActiveStudents: false }))).toBe(true);
      expect(parentDoorClosed(parseParentSettings({ signin: true, everEnabled, welcome: false, requireActiveStudents: false }))).toBe(false);
    }
  });
});
