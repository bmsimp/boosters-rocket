import { describe, it, expect } from "vitest";
import { ADMIN_ONLY, GRANTABLE, PERMISSIONS, type Permission } from "@/lib/permissions/registry";
import { expandRules } from "@/lib/permissions/rules";
import type { Effective } from "@/lib/permissions/effective";
import { SETTINGS_SECTIONS, settingsSections } from "@/app/staff/(app)/settings/sections";
import { staffMenu, menuHrefs, type MenuEntry } from "@/app/staff/(app)/staff-menu";

const only = (...permissions: Permission[]): Effective => ({ isAdmin: false, permissions: new Set(permissions) });
const ADMIN: Effective = { isAdmin: true, permissions: new Set(PERMISSIONS) };
const keys = (e: Effective) => settingsSections(e).map((s) => s.key);

describe("the Settings page's sections", () => {
  it("has one section for each settings permission, each leading to that part's own page", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.permission).sort()).toEqual(PERMISSIONS.filter((p) => p.startsWith("Settings.") && p !== "Settings.Club.ReadWrite").sort());
    for (const s of SETTINGS_SECTIONS) expect(s.href).toBe(`/staff/settings/${s.key}`);
  });

  it("shows each section to someone holding its permission alone, and no other", () => {
    for (const s of SETTINGS_SECTIONS) expect(keys(only(s.permission)), s.permission).toEqual([s.key]);
    expect(keys(only("Settings.Club.ReadWrite", "Settings.Club.Read"))).toEqual(["club"]);
  });

  it("shows none to someone with no settings permission, and every one to an Admin", () => {
    expect(keys(only())).toEqual([]);
    expect(keys(only(...GRANTABLE.filter((p) => !p.startsWith("Settings."))))).toEqual([]);
    expect(keys(ADMIN)).toEqual(["club", "sign-in", "mail", "quickbooks", "parents", "forms"]);
  });

  it("so the page's guard, Settings.Club.Read, is held by everyone who has a section: every other part is Admin only", () => {
    for (const s of SETTINGS_SECTIONS.filter((x) => x.key !== "club")) expect(ADMIN_ONLY, s.permission).toContain(s.permission);
    // A role that gives Settings.Club.ReadWrite gives Settings.Club.Read with it.
    expect(expandRules({ include: ["Settings.Club.ReadWrite"], exclude: [] }).has("Settings.Club.Read")).toBe(true);
    // The widest custom role there is reaches the Club section alone.
    expect(keys(only(...expandRules({ include: ["*"], exclude: [] })))).toEqual(["club"]);
  });
});

/** The menu as words: "Home", "Settings", or "Group: Link, Link". */
const shape = (menu: MenuEntry[]) => menu.map((m) => (m.kind === "link" ? m.label : `${m.label}: ${m.links.map((l) => l.label).join(", ")}`));

describe("the staff menu", () => {
  it("groups an Admin's entries, with Settings as one entry", () => {
    expect(shape(staffMenu(ADMIN))).toEqual([
      "Home",
      "Families: Roster, Parents",
      "Season: Seasons, Progress, Signed forms, Volunteering, Volunteer credit",
      "Money: Balances, Reconciliation",
      "Settings",
      "Admin: Staff, Roles, Audit, Health",
    ]);
  });

  it("no longer has the settings pages as entries of their own: Parents and Parent sign-ins are not side by side", () => {
    const hrefs = menuHrefs(staffMenu(ADMIN));
    expect(hrefs.filter((h) => h.startsWith("/staff/settings"))).toEqual(["/staff/settings"]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("shows someone with no permission Home alone", () => {
    expect(shape(staffMenu(only()))).toEqual(["Home"]);
  });

  it("shows each entry only to someone who holds its permission, and a group only when it has an entry", () => {
    const cases: [Permission[], string[]][] = [
      [["Roster.Read"], ["Home", "Families: Roster", "Money: Reconciliation"]],
      [["Parents.ReadWrite"], ["Home", "Families: Parents"]],
      [["Season.Steps.Read"], ["Home", "Season: Seasons"]],
      [["Season.Progress.ReadWrite", "Season.Progress.Read"], ["Home", "Season: Progress"]],
      [["Forms.Signature.Read"], ["Home", "Season: Signed forms"]],
      [["Volunteer.Event.Read"], ["Home", "Season: Volunteering"]],
      [["Volunteer.Credit.ReadWrite"], ["Home", "Season: Volunteer credit"]],
      [["Finance.Balance.Read"], ["Home", "Money: Balances"]],
      [["Staff.Users.Read"], ["Home", "Admin: Staff"]],
      [["Settings.Club.Read"], ["Home", "Settings"]],
    ];
    for (const [held, menu] of cases) expect(shape(staffMenu(only(...held))), held.join(", ")).toEqual(menu);
  });

  it("never shows Roles, Audit or Health to a custom role, however wide", () => {
    const widest = only(...expandRules({ include: ["*"], exclude: [] }));
    expect(shape(staffMenu(widest)).at(-1)).toBe("Admin: Staff");
    for (const h of ["/staff/roles", "/staff/audit", "/staff/health"]) expect(menuHrefs(staffMenu(widest))).not.toContain(h);
  });
});
