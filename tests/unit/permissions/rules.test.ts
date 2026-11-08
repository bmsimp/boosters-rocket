import { describe, it, expect } from "vitest";
import { matches, expandRules, validatePattern, validateRules } from "@/lib/permissions/rules";
import { GRANTABLE, ADMIN_ONLY } from "@/lib/permissions/registry";

const U = ["Roster.Family.Read", "Roster.Family.ReadWrite", "Roster.Student.Read", "Roster.Student.ReadWrite", "Finance.Balance.Read"] as const;

describe("matches", () => {
  it("matches exact strings and * wildcards across dots", () => {
    expect(matches("Roster.Family.Read", "Roster.Family.Read")).toBe(true);
    expect(matches("Roster.*", "Roster.Student.ReadWrite")).toBe(true);
    expect(matches("*.Read", "Finance.Balance.Read")).toBe(true);
    expect(matches("Roster.*", "Finance.Balance.Read")).toBe(false);
  });
  it("treats regex characters literally", () => {
    expect(matches("Roster.Family.Rea.", "Roster.Family.Read")).toBe(false);
  });
});

describe("expandRules", () => {
  it("includes matches", () => {
    expect(expandRules({ include: ["Roster.*"], exclude: [] }, U)).toEqual(
      new Set(["Roster.Family.Read", "Roster.Family.ReadWrite", "Roster.Student.Read", "Roster.Student.ReadWrite"]));
  });
  it("ReadWrite includes Read", () => {
    expect(expandRules({ include: ["Roster.Family.ReadWrite"], exclude: [] }, U)).toEqual(
      new Set(["Roster.Family.Read", "Roster.Family.ReadWrite"]));
  });
  it("exclude always wins", () => {
    expect(expandRules({ include: ["Roster.*"], exclude: ["Roster.Student.*"] }, U)).toEqual(
      new Set(["Roster.Family.Read", "Roster.Family.ReadWrite"]));
  });
  it("excluding ReadWrite keeps Read", () => {
    expect(expandRules({ include: ["Roster.Family.ReadWrite"], exclude: ["Roster.Family.ReadWrite"] }, U)).toEqual(
      new Set(["Roster.Family.Read"]));
  });
  it("a role excluding * grants nothing", () => {
    expect(expandRules({ include: ["*"], exclude: ["*"] }, U).size).toBe(0);
  });
  it("never grants admin-only permissions, even with *", () => {
    const got = expandRules({ include: ["*"], exclude: [] });
    for (const p of ADMIN_ONLY) expect(got.has(p)).toBe(false);
    expect(got.size).toBe(GRANTABLE.length);
  });
  it("covers permissions added later through wildcards", () => {
    const later = [...U, "Roster.Guardian.Read"] as const;
    expect(expandRules({ include: ["Roster.*"], exclude: [] }, later).has("Roster.Guardian.Read" as never)).toBe(true);
  });
});

describe("validation", () => {
  it.each(["", "   ", "Roster..Read", "*.*.Write", "Roster Family.Read", "Roster.Family.read", "Roster.Family.Read.Extra"])(
    "rejects %j", (p) => expect(validatePattern(p)).not.toBeNull());
  it.each(["*", "Roster.*", "*.Read", "Roster.Family.ReadWrite", "Roster.*.Read"])(
    "accepts %j", (p) => expect(validatePattern(p)).toBeNull());
  it("requires at least one include", () => {
    expect(validateRules({ include: [], exclude: ["*"] })).toContain("A role needs at least one include pattern.");
  });
  it("rejects patterns that only match admin-only permissions", () => {
    expect(validateRules({ include: ["Admin.*"], exclude: [] })).toContain("“Admin.*” only matches Admin permissions, which can't be given to a role.");
  });
});
