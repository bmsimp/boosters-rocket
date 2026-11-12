import { describe, it, expect } from "vitest";
import { parentDoorClosed, CLOSED_PARENT_SETTINGS, DEFAULT_PARENT_SETTINGS, parseParentSettings } from "@/lib/parents/settings";

describe("the parents setting", () => {
  it("defaults to everything off except staff review emails", () => {
    expect(DEFAULT_PARENT_SETTINGS).toEqual({ signin: false, everEnabled: false, welcome: false, requireActiveStudents: false, reviewEmails: true });
  });
  it("reads a stored value; with none stored gives the defaults; a stored value it can't read fails closed", () => {
    expect(parseParentSettings({ signin: true, everEnabled: true, welcome: false, requireActiveStudents: true, reviewEmails: false }))
      .toEqual({ signin: true, everEnabled: true, welcome: false, requireActiveStudents: true, reviewEmails: false });
    expect(parseParentSettings(undefined)).toEqual(DEFAULT_PARENT_SETTINGS);
    expect(CLOSED_PARENT_SETTINGS).toEqual({ signin: false, everEnabled: true, welcome: false, requireActiveStudents: false, reviewEmails: false });
    for (const bad of [null, "on", 3, { signin: "yes" }, []]) {
      expect(parseParentSettings(bad)).toEqual(CLOSED_PARENT_SETTINGS);
      expect(parentDoorClosed(parseParentSettings(bad))).toBe(true);
    }
  });
  it("closes the parent door only after sign-ins were on and are now off", () => {
    expect(parentDoorClosed({ ...DEFAULT_PARENT_SETTINGS })).toBe(false);                               // never switched on: seeded sign-ins work
    expect(parentDoorClosed({ ...DEFAULT_PARENT_SETTINGS, signin: true, everEnabled: true })).toBe(false);
    expect(parentDoorClosed({ ...DEFAULT_PARENT_SETTINGS, signin: false, everEnabled: true })).toBe(true);
  });
});
