import { describe, it, expect } from "vitest";
import { ADMIN_ONLY, GRANTABLE, PERMISSIONS } from "@/lib/permissions/registry";
import { expandRules, validateRules } from "@/lib/permissions/rules";

describe("Settings.Mail.ReadWrite", () => {
  it("exists, and only the built-in Admin can hold it", () => {
    expect(PERMISSIONS).toContain("Settings.Mail.ReadWrite");
    expect(ADMIN_ONLY).toContain("Settings.Mail.ReadWrite");
    expect(GRANTABLE).not.toContain("Settings.Mail.ReadWrite");
  });
  it("can't be put in a custom role, even by a wildcard", () => {
    expect(expandRules({ include: ["*"], exclude: [] }).has("Settings.Mail.ReadWrite")).toBe(false);
    expect(expandRules({ include: ["Settings.*"], exclude: [] }).has("Settings.Mail.ReadWrite")).toBe(false);
    expect(validateRules({ include: ["Settings.Mail.ReadWrite"], exclude: [] }))
      .toContain("“Settings.Mail.ReadWrite” only matches Admin permissions, which can't be given to a role.");
  });
});
