import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { ADMIN_ONLY, GRANTABLE, PERMISSIONS, type Permission } from "@/lib/permissions/registry";
import { expandRules } from "@/lib/permissions/rules";
import type { Effective } from "@/lib/permissions/effective";
import { SETTINGS_GROUPS, SETTINGS_ITEMS, integrationItems, railItems, settingsHome, settingsItems } from "@/app/staff/(app)/settings/sections";
import { groupLinks, staffMenu, staffTabs, menuHrefs, type MenuEntry } from "@/app/staff/(app)/staff-menu";

const only = (...permissions: Permission[]): Effective => ({ isAdmin: false, permissions: new Set(permissions) });
const ADMIN: Effective = { isAdmin: true, permissions: new Set(PERMISSIONS) };
const WIDEST = only(...expandRules({ include: ["*"], exclude: [] }));
const keys = (e: Effective) => settingsItems(e).map((s) => s.key);
const rail = (e: Effective) => railItems(e).map((s) => s.key);

describe("the Settings items", () => {
  it("has one page for each settings permission, and each item leads to a page under /staff/settings that it owns", () => {
    const seen = new Set<Permission>(SETTINGS_ITEMS.flatMap((s) => [s.see, ...(s.change ? [s.change] : [])]));
    for (const p of PERMISSIONS.filter((x) => x.startsWith("Settings."))) expect(seen, p).toContain(p);
    for (const s of SETTINGS_ITEMS) {
      expect(s.href.startsWith("/staff/settings/"), s.key).toBe(true);
      expect(s.owns, s.key).toContain(s.href);
      // The page is there: src/app/staff/(app)/settings/<key>/page.tsx.
      expect(existsSync(`src/app/staff/(app)${s.href.replace("/staff", "")}/page.tsx`), s.href).toBe(true);
    }
    expect(new Set(SETTINGS_ITEMS.map((s) => s.key)).size).toBe(SETTINGS_ITEMS.length);
  });

  it("draws the rail in its four groups, in sentence case, each item in its group's order", () => {
    expect(SETTINGS_GROUPS).toEqual(["Club", "People and access", "Connections", "Administration"]);
    for (const g of SETTINGS_GROUPS) expect(g.slice(1), g).toBe(g.slice(1).toLowerCase());
    const order = railItems(ADMIN).map((s) => SETTINGS_GROUPS.indexOf(s.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(rail(ADMIN)).toEqual(["club", "messages", "staff", "roles", "parents", "integrations", "audit", "health", "backups", "design-system"]);
    expect(integrationItems(ADMIN).map((s) => s.key)).toEqual(["quickbooks", "forms", "mail", "sign-in"]);
  });

  it("marks Integrations current on each integration's pages", () => {
    const integrations = SETTINGS_ITEMS.find((s) => s.key === "integrations")!;
    for (const s of integrationItems(ADMIN)) expect(integrations.owns, s.key).toContain(s.href);
  });

  it("shows each item only to someone holding its permission", () => {
    for (const s of SETTINGS_ITEMS) expect(keys(only(s.see)), s.see).toContain(s.key);
    expect(keys(only("Settings.Club.Read"))).toEqual(["club", "messages", "design-system"]);
    expect(keys(only("Staff.Users.Read"))).toEqual(["staff"]);
    expect(keys(only())).toEqual([]);
    expect(keys(only(...GRANTABLE.filter((p) => !p.startsWith("Settings.") && p !== "Staff.Users.Read")))).toEqual([]);
    expect(keys(ADMIN)).toEqual(SETTINGS_ITEMS.map((s) => s.key));
  });

  it("keeps every Admin-only item Admin only: the widest custom role sees the Club, Messages, Staff and the design system", () => {
    expect(rail(WIDEST)).toEqual(["club", "messages", "staff", "design-system"]);
    for (const s of SETTINGS_ITEMS.filter((x) => !["club", "messages", "staff", "design-system"].includes(x.key))) expect(ADMIN_ONLY, s.key).toContain(s.see);
    // Messages is seen with the Club's read, but only an Admin may switch emailing on (club messages, spec section 10).
    const messages = SETTINGS_ITEMS.find((x) => x.key === "messages")!;
    expect(messages.see).toBe("Settings.Club.Read");
    expect(ADMIN_ONLY).toContain(messages.change);
    expect(WIDEST.permissions.has("Settings.Messages.ReadWrite")).toBe(false);
  });

  it("finds QuickBooks by the words of connecting through Boosters Rocket, under its own permission", () => {
    const qb = SETTINGS_ITEMS.find((s) => s.key === "quickbooks")!;
    for (const k of ["Boosters Rocket", "connect", "relay", "register"]) expect(qb.keywords).toContain(k);
    expect(qb.see).toBe("Settings.QuickBooks.ReadWrite");
    expect(qb.change).toBe("Settings.QuickBooks.ReadWrite");
  });

  it("guards Integrations with the QuickBooks permission, the same as holding any integration's, since all four are Admin only", () => {
    const integrations = SETTINGS_ITEMS.find((s) => s.key === "integrations")!;
    expect(integrations.see).toBe("Settings.QuickBooks.ReadWrite");
    for (const s of integrationItems(ADMIN)) expect(ADMIN_ONLY, s.key).toContain(s.see);
  });

  it("splits seeing from changing only for the Club, Messages and Staff", () => {
    const split = SETTINGS_ITEMS.filter((s) => s.change !== null && s.change !== s.see).map((s) => s.key);
    expect(split).toEqual(["club", "messages", "staff"]);
    // A role that gives Settings.Club.ReadWrite gives Settings.Club.Read with it.
    expect(expandRules({ include: ["Settings.Club.ReadWrite"], exclude: [] }).has("Settings.Club.Read")).toBe(true);
  });

  it("sends Settings to the Overview for anyone who may read the club, and straight to Staff for someone who may only read the staff list", () => {
    expect(settingsHome(ADMIN)).toBe("/staff/settings");
    expect(settingsHome(only("Settings.Club.Read"))).toBe("/staff/settings");
    expect(settingsHome(only("Staff.Users.Read"))).toBe("/staff/settings/staff");
    expect(settingsHome(only("Roster.Read"))).toBeNull();
  });
});

/** The menu as words: "Home", "Settings", or "Group: Link, Link". */
const shape = (menu: MenuEntry[]) => menu.map((m) => (m.kind === "link" ? m.label : `${m.label}: ${m.links.map((l) => l.label).join(", ")}`));

describe("the staff menu", () => {
  it("groups an Admin's entries, with Settings as the one entry for everything that sets the portal up", () => {
    expect(shape(staffMenu(ADMIN))).toEqual([
      "Home",
      "Families: Roster, Parents, Accounting links, Messages",
      "Season: Seasons, Progress, Signed forms, Volunteering, Volunteer credit",
      "Money: Balances, Reconciliation",
      "Settings",
    ]);
  });

  it("has no settings page as an entry of its own: Parents and Parent sign-ins are not side by side, and there is no Admin group", () => {
    const hrefs = menuHrefs(staffMenu(ADMIN));
    expect(hrefs.filter((h) => h.startsWith("/staff/settings"))).toEqual(["/staff/settings"]);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(staffMenu(ADMIN).some((m) => m.label === "Admin")).toBe(false);
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
      [["Staff.Users.Read"], ["Home", "Settings"]],
      [["Settings.Club.Read"], ["Home", "Settings"]],
    ];
    for (const [held, menu] of cases) expect(shape(staffMenu(only(...held))), held.join(", ")).toEqual(menu);
  });

  it("leads someone who may only read the staff list straight to Staff, with Settings still current on every settings page", () => {
    const settings = staffMenu(only("Staff.Users.Read")).find((m) => m.label === "Settings")!;
    expect(settings).toEqual({ kind: "link", href: "/staff/settings/staff", label: "Settings", section: "/staff/settings" });
    expect(staffMenu(ADMIN).find((m) => m.label === "Settings")).toEqual({ kind: "link", href: "/staff/settings", label: "Settings" });
  });

  it("never shows Roles, the audit log or Health to a custom role, however wide", () => {
    for (const h of ["/staff/settings/roles", "/staff/settings/audit", "/staff/settings/health"]) expect(menuHrefs(staffMenu(WIDEST))).not.toContain(h);
    expect(shape(staffMenu(WIDEST)).at(-1)).toBe("Settings");
  });
});

describe("the staff tab bar on a phone", () => {
  it("has Home, each group the person has an entry in, and Settings, read from the same menu", () => {
    expect(staffTabs(ADMIN).map((t) => t.label)).toEqual(["Home", "Families", "Season", "Money", "Settings"]);
    expect(staffTabs(only()).map((t) => t.label)).toEqual(["Home"]);
    expect(staffTabs(only("Finance.Balance.Read")).map((t) => t.label)).toEqual(["Home", "Money"]);
  });

  it("opens a group's hub, or its one page straight away, and Settings where the menu's entry leads", () => {
    const href = (e: Effective, label: string) => staffTabs(e).find((t) => t.label === label)!.href;
    expect(href(ADMIN, "Families")).toBe("/staff/families");
    expect(href(ADMIN, "Season")).toBe("/staff/season");
    expect(href(ADMIN, "Money")).toBe("/staff/money");
    expect(href(only("Finance.Balance.Read"), "Money")).toBe("/staff/balances");
    expect(href(only("Roster.Read"), "Families")).toBe("/staff/roster");
    expect(href(ADMIN, "Settings")).toBe("/staff/settings");
    expect(href(only("Staff.Users.Read"), "Settings")).toBe("/staff/settings/staff");
  });

  it("is current on its hub and every page of its group, Settings on every settings page, Home only on the staff home", () => {
    const tabs = staffTabs(ADMIN);
    expect(tabs.find((t) => t.key === "families")!.owns).toEqual(["/staff/families", "/staff/roster", "/staff/parents", "/staff/links", "/staff/messages"]);
    expect(tabs.find((t) => t.key === "settings")!.owns).toEqual(["/staff/settings"]);
    expect(tabs.find((t) => t.key === "home")).toMatchObject({ owns: ["/staff"], exact: true });
    expect(groupLinks(ADMIN, "Money").map((l) => l.href)).toEqual(["/staff/balances", "/staff/reconciliation"]);
    expect(groupLinks(only(), "Money")).toEqual([]);
  });
});
