import { describe, it, expect } from "vitest";
import { parentDoorClosed, CLOSED_PARENT_SETTINGS, DEFAULT_PARENT_SETTINGS, parseParentSettings } from "@/lib/parents/settings";

describe("the parents setting", () => {
  it("defaults to everything off", () => {
    expect(DEFAULT_PARENT_SETTINGS).toEqual({ signin: false, welcome: false, requireActiveStudents: false });
  });
  it("reads a stored value; with none stored gives the defaults; a stored value it can't read fails closed", () => {
    expect(parseParentSettings({ signin: true, welcome: false, requireActiveStudents: true }))
      .toEqual({ signin: true, welcome: false, requireActiveStudents: true });
    expect(parseParentSettings(undefined)).toEqual(DEFAULT_PARENT_SETTINGS);
    expect(CLOSED_PARENT_SETTINGS).toEqual({ signin: false, welcome: false, requireActiveStudents: false });
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
        const without = { signin, welcome: signin, requireActiveStudents: !signin };
        const before = { ...without, ...retired };
        expect(parseParentSettings(before)).toEqual(without);
        expect(parseParentSettings(without)).toEqual(without);
        expect(parentDoorClosed(parseParentSettings(before))).toBe(!signin);
      }
    }
    expect(parseParentSettings({ ...DEFAULT_PARENT_SETTINGS, reviewEmails: true })).toEqual(DEFAULT_PARENT_SETTINGS);
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
