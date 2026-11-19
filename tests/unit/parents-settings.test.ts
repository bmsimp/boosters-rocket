import { describe, it, expect } from "vitest";
import { parentDoorClosed, CLOSED_PARENT_SETTINGS, DEFAULT_PARENT_SETTINGS, parseParentSettings } from "@/lib/parents/settings";

describe("the parents setting", () => {
  it("defaults to everything off", () => {
    expect(DEFAULT_PARENT_SETTINGS).toEqual({ signin: false, everEnabled: false, welcome: false, requireActiveStudents: false });
  });
  it("reads a stored value; with none stored gives the defaults; a stored value it can't read fails closed", () => {
    expect(parseParentSettings({ signin: true, everEnabled: true, welcome: false, requireActiveStudents: true }))
      .toEqual({ signin: true, everEnabled: true, welcome: false, requireActiveStudents: true });
    expect(parseParentSettings(undefined)).toEqual(DEFAULT_PARENT_SETTINGS);
    expect(CLOSED_PARENT_SETTINGS).toEqual({ signin: false, everEnabled: true, welcome: false, requireActiveStudents: false });
    for (const bad of [null, "on", 3, { signin: "yes" }, []]) {
      expect(parseParentSettings(bad)).toEqual(CLOSED_PARENT_SETTINGS);
      expect(parentDoorClosed(parseParentSettings(bad))).toBe(true);
    }
  });
  it("reads a value stored with the retired staff review switch as the same switches, with it or without it", () => {
    // Values stored before the held-address review went still hold `reviewEmails`: a parse that failed on it would
    // close the door to every parent at the deploy.
    for (const reviewEmails of [true, false]) {
      for (const signin of [true, false]) {
        const without = { signin, everEnabled: true, welcome: signin, requireActiveStudents: !signin };
        const before = { ...without, reviewEmails };
        expect(parseParentSettings(before)).toEqual(without);
        expect(parseParentSettings(without)).toEqual(without);
        expect(parentDoorClosed(parseParentSettings(before))).toBe(!signin);
      }
    }
    expect(parseParentSettings({ ...DEFAULT_PARENT_SETTINGS, reviewEmails: true })).toEqual(DEFAULT_PARENT_SETTINGS);
  });
  it("closes the parent door only after sign-ins were on and are now off", () => {
    expect(parentDoorClosed({ ...DEFAULT_PARENT_SETTINGS })).toBe(false);                               // never switched on: seeded sign-ins work
    expect(parentDoorClosed({ ...DEFAULT_PARENT_SETTINGS, signin: true, everEnabled: true })).toBe(false);
    expect(parentDoorClosed({ ...DEFAULT_PARENT_SETTINGS, signin: false, everEnabled: true })).toBe(true);
  });
});
