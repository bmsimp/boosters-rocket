import { describe, it, expect } from "vitest";
import { seesMailWarning } from "@/app/staff/(app)/mail-warning-rule";

const e = (perms: string[], isAdmin = false) => ({ isAdmin, permissions: new Set(perms) }) as Parameters<typeof seesMailWarning>[0];

describe("who sees the mail warning", () => {
  it("shows to Admins and to staff with any settings access, not to others", () => {
    expect(seesMailWarning(e([], true))).toBe(true);
    expect(seesMailWarning(e(["Settings.Club.Read"]))).toBe(true);
    expect(seesMailWarning(e(["Audit.Log.Read", "Staff.Users.Read"]))).toBe(false);
  });
});
