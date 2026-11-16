import { describe, it, expect } from "vitest";
import { matches, expandRules, validatePattern, validateRules } from "@/lib/permissions/rules";
import { GRANTABLE, ADMIN_ONLY, PERMISSIONS } from "@/lib/permissions/registry";

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
  it("never grants admin-only permissions when the universe includes them", () => {
    const got = expandRules({ include: ["*"], exclude: [] }, PERMISSIONS);
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
  it("rejects an exact admin-only permission as an include", () => {
    expect(validateRules({ include: ["Admin.Roles.ReadWrite"], exclude: [] }).length).toBeGreaterThan(0);
  });
});

describe("a permission's own name is a pattern", () => {
  it.each([...PERMISSIONS])("accepts %s as it is written in the registry", (p) => expect(validatePattern(p)).toBeNull());

  it("gives the two-part names by name, and nothing else with them", () => {
    expect(validateRules({ include: ["Roster.Read", "Parents.ReadWrite"], exclude: [] })).toEqual([]);
    expect(expandRules({ include: ["Roster.Read"], exclude: [] })).toEqual(new Set(["Roster.Read"]));
    expect(expandRules({ include: ["Parents.ReadWrite"], exclude: [] })).toEqual(new Set(["Parents.ReadWrite"]));
  });

  it("does not take in a permission added later, as a wildcard would", () => {
    const later = [...GRANTABLE, "Roster.Family.ReadWrite", "Roster.ReadWrite", "Parents.Notes.Read"];
    expect(expandRules({ include: ["Roster.Read", "Parents.ReadWrite"], exclude: [] }, later)).toEqual(new Set(["Roster.Read", "Parents.ReadWrite"]));
    expect(expandRules({ include: ["Roster.*"], exclude: [] }, later).has("Roster.Family.ReadWrite" as never)).toBe(true);
  });

  it("can be excluded by name", () => {
    expect(validateRules({ include: ["*"], exclude: ["Roster.Read"] })).toEqual([]);
    expect(expandRules({ include: ["*"], exclude: ["Roster.Read"] }).has("Roster.Read")).toBe(false);
  });

  it.each(["Roster.Reads", "roster.read", "Roster.Write", "Parents.Everything", "Nothing.Here", "Roster", "Read"])(
    "still rejects %j, which is no permission's name", (p) => expect(validatePattern(p)).not.toBeNull());
});

describe("an Admin-only permission cannot be given through any pattern", () => {
  /** Every way of writing a name with stars in place of parts, and the names themselves. */
  const starred = (name: string): string[] => {
    const parts = name.split(".");
    const out: string[] = [];
    for (let mask = 0; mask < 1 << parts.length; mask++) out.push(parts.map((part, i) => (mask & (1 << i) ? "*" : part)).join("."));
    return out;
  };
  const shapes = [...new Set([
    "*", "*.*", "*.*.*", "**", "*.Read", "*.ReadWrite", "*.Read*", "*Write", "*.*Write",
    ...PERMISSIONS.flatMap(starred),
    ...PERMISSIONS.flatMap((p) => [`${p.split(".")[0]}.*`, `${p}*`, `*${p}`, `${p.slice(0, -1)}*`, `*.${p.split(".").slice(1).join(".")}`]),
  ])];

  it("tries every name and every starred form of every name", () => {
    for (const p of ADMIN_ONLY) expect(shapes).toContain(p);
    expect(shapes).toEqual(expect.arrayContaining(["Admin.*", "Settings.*.ReadWrite", "*.Log.Read", "*.*.Read", "Audit.Log.*", "Admin.Health.Read*"]));
    expect(shapes.length).toBeGreaterThan(80);
  });

  it.each(shapes)("%s gives no Admin-only permission, alone or beside others", (pattern) => {
    for (const universe of [GRANTABLE, PERMISSIONS]) {
      const alone = expandRules({ include: [pattern], exclude: [] }, universe);
      const beside = expandRules({ include: ["Roster.Read", pattern, "*"], exclude: [] }, universe);
      for (const p of ADMIN_ONLY) {
        expect(alone.has(p), `${pattern} gave ${p}`).toBe(false);
        expect(beside.has(p), `${pattern} beside others gave ${p}`).toBe(false);
      }
    }
  });

  it.each([...ADMIN_ONLY])("%s by name is refused when a role is saved", (p) => {
    expect(validatePattern(p)).toBeNull(); // it is a name, so the pattern check passes it; the next check is what refuses it
    expect(validateRules({ include: [p], exclude: [] })).toContain(`“${p}” only matches Admin permissions, which can't be given to a role.`);
  });

  it("the audit log and the health page are Admin-only", () => {
    expect(ADMIN_ONLY).toEqual(expect.arrayContaining(["Audit.Log.Read", "Admin.Health.Read"]));
    expect(GRANTABLE).not.toContain("Audit.Log.Read");
    expect(expandRules({ include: ["Audit.*", "*.Read"], exclude: [] }).has("Audit.Log.Read")).toBe(false);
    expect(validateRules({ include: ["Audit.*"], exclude: [] })).toContain("“Audit.*” only matches Admin permissions, which can't be given to a role.");
  });
});
