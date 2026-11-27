import { describe, it, expect, beforeEach } from "vitest";
import { asStaff, atPath, pageOutcome, renderPage } from "../helpers/signed-in";

import { db } from "@/lib/db/client";
import { role, roleAssignment, roleRule } from "@/lib/db/schema";
import StaffLayout from "@/app/staff/(app)/layout";
import FamiliesHub from "@/app/staff/(app)/families/page";
import SeasonHub from "@/app/staff/(app)/season/page";
import MoneyHub from "@/app/staff/(app)/money/page";
import { resetDb, seedStaff } from "../helpers/db";

/** Each entry is shown only to someone who can open the page it leads to. */
const SEASONS = 'href="/staff/seasons"', PROGRESS = 'href="/staff/seasons/progress"', HEALTH = 'href="/staff/settings/health"';
const BALANCES = 'href="/staff/balances"', VOLUNTEERING = 'href="/staff/volunteer"', SETTINGS = 'href="/staff/settings"';
const RECONCILIATION = 'href="/staff/reconciliation"', CREDIT = 'href="/staff/volunteer/credit"', SIGNED = 'href="/staff/forms"';
const ROLES = 'href="/staff/settings/roles"', AUDIT = 'href="/staff/settings/audit"', STAFF = 'href="/staff/settings/staff"';
const LINKS = 'href="/staff/links"', DESIGN = 'href="/staff/settings/design-system"';

async function staffWith(...patterns: string[]) {
  const s = await seedStaff({ email: "helper@club.org", name: "Hal Helper" });
  const [r] = await db.insert(role).values({ key: "helper", name: "Helper" }).returning();
  await db.insert(roleRule).values(patterns.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  asStaff(s);
}
const asAdmin = async () => asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));
/** The desktop menu: the rail (`<nav class="staff-rail">`), every group's pages in the open under its heading. */
const menu = async () => /<nav class="staff-rail"[^>]*>(.*?)<\/nav>/.exec(await renderPage(StaffLayout))![1]!;
/** The menu's entries in words: "Home", "Settings", or "Families: Roster, Parents". */
async function entries(): Promise<string[]> {
  const nav = await menu();
  const out: string[] = [];
  const label = /<a\b[^>]*>(?:<svg.*?<\/svg>)?([^<]*)<\/a>/g;
  for (const m of nav.matchAll(/<div role="group"[^>]*><h2[^>]*>([^<]*)<\/h2>(.*?)<\/div>|<a\b[^>]*>(?:<svg.*?<\/svg>)?([^<]*)<\/a>/g)) {
    if (m[3] !== undefined) out.push(m[3]);
    else out.push(`${m[1]}: ${[...m[2]!.matchAll(label)].map((a) => a[1]).join(", ")}`);
  }
  return out;
}
/** The addresses marked current, in the desktop menu. */
async function current(path: string) {
  atPath(path);
  return [...(await menu()).matchAll(/<a\b[^>]*>/g)].filter((a) => a[0].includes('aria-current="page"')).map((a) => /href="([^"]*)"/.exec(a[0])![1]);
}

describe("the staff menu", () => {
  beforeEach(resetDb);

  it("groups an Admin's entries: Home, Families, Season, Money, and Settings as one entry, with no Admin group", async () => {
    await asAdmin();
    expect(await entries()).toEqual([
      "Home",
      "Families: Roster, Parents, Accounting links, Messages",
      "Season: Seasons, Progress, Signed forms, Volunteering, Volunteer credit",
      "Money: Balances, Reconciliation",
      "Settings",
    ]);
  });

  it("draws each group as a heading over its pages, always open, with nothing to open or close", async () => {
    await asAdmin();
    const nav = await menu();
    // Each group is named by its heading (role="group", aria-labelledby), its pages drawn under it.
    for (const m of nav.matchAll(/<div role="group" aria-labelledby="([^"]+)"[^>]*><h2 id="([^"]+)"/g)) expect(m[1]).toBe(m[2]);
    expect([...nav.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((h) => h[1])).toEqual(["Families", "Season", "Money"]);
    // Nothing to open or close: no button, no disclosure, nothing hidden.
    expect(nav).not.toMatch(/<button|aria-expanded|hidden=""|<details/);
  });

  it("no longer lists the settings pages one by one, so Parents and Parent sign-ins are not side by side", async () => {
    await asAdmin();
    const nav = await menu();
    expect([...nav.matchAll(/href="(\/staff\/settings[^"]*)"/g)].map((m) => m[1])).toEqual(["/staff/settings"]);
    expect(nav).not.toContain("Parent sign-ins");
  });

  it("shows someone who only ticks names off the Progress entry, and not the set-up pages they can't open", async () => {
    await staffWith("Season.Progress.ReadWrite");
    expect(await entries()).toEqual(["Home", "Season: Progress"]);
  });

  it("shows someone who sets seasons up the Seasons entry alone", async () => {
    await staffWith("Season.Steps.Read");
    expect(await entries()).toEqual(["Home", "Season: Seasons"]);
  });

  it("never shows Roles, the audit log or Health to a custom role, however wide, and gives it Settings", async () => {
    await staffWith("*", "Admin.*", "Admin.Health.Read", "Audit.Log.Read", "Settings.*");
    const nav = await menu();
    for (const entry of [SEASONS, PROGRESS, SETTINGS]) expect(nav).toContain(entry);
    for (const entry of [HEALTH, ROLES, AUDIT, STAFF, DESIGN]) expect(nav).not.toContain(entry);
    expect((await entries()).at(-1)).toBe("Settings");
  });

  it("shows Settings to someone who may read the club settings, and to nobody without a settings permission", async () => {
    await staffWith("Settings.Club.Read");
    // The design system gallery is for anyone who may read the club's settings: it is under Settings, not in the menu.
    expect(await entries()).toEqual(["Home", "Settings"]);
    expect(await menu()).not.toContain(DESIGN);
    await resetDb();
    await staffWith("Roster.Read", "Season.Steps.ReadWrite", "Finance.Balance.Read");
    expect(await menu()).not.toContain(SETTINGS);
    expect(await menu()).not.toContain(DESIGN);
  });

  it("shows Balances only to someone who may read balances", async () => {
    await staffWith("Finance.Balance.Read");
    expect(await entries()).toEqual(["Home", "Money: Balances"]);
  });

  it("shows Volunteering to someone who may read the events, and to someone who may change them", async () => {
    for (const permission of ["Volunteer.Event.Read", "Volunteer.Event.ReadWrite"]) {
      await resetDb();
      await staffWith(permission);
      expect(await entries()).toEqual(["Home", "Season: Volunteering"]);
    }
  });

  it("shows Reconciliation with the roster, to anyone who may read it, and nothing of the seasons", async () => {
    await staffWith("Roster.Read");
    const nav = await menu();
    expect(await entries()).toEqual(["Home", "Families: Roster", "Money: Reconciliation"]);
    for (const entry of [SEASONS, PROGRESS, HEALTH, BALANCES, VOLUNTEERING, CREDIT, SIGNED, SETTINGS]) expect(nav).not.toContain(entry);
    expect(nav).toContain(RECONCILIATION);
  });

  it("shows Accounting links only to someone who holds both the linking permission and Roster.Read, as the page asks", async () => {
    await staffWith("Accounting.Link.ReadWrite", "Roster.Read");
    expect(await entries()).toEqual(["Home", "Families: Roster, Accounting links", "Money: Reconciliation"]);
    await resetDb();
    await staffWith("Accounting.Link.ReadWrite");
    expect(await menu()).not.toContain(LINKS);
    await resetDb();
    await staffWith("Roster.Read");
    expect(await menu()).not.toContain(LINKS);
  });

  it("shows Messages, in Families, only to someone who may post messages", async () => {
    await staffWith("Messages.Post.ReadWrite");
    expect(await entries()).toEqual(["Home", "Families: Messages"]);
    const hub = await renderPage(FamiliesHub);
    expect([...hub.matchAll(/<a class="list-link" href="([^"]+)"/g)].map((m) => m[1])).toEqual(["/staff/messages"]);
    expect(hub).toContain("News posted to every family, read in the portal.");
    await resetDb();
    await staffWith("Roster.Read", "Parents.ReadWrite");
    expect(await menu()).not.toContain('href="/staff/messages"');
  });

  it("shows Volunteer credit only to someone who may change credit, even without the events", async () => {
    await staffWith("Volunteer.Credit.ReadWrite");
    expect(await entries()).toEqual(["Home", "Season: Volunteer credit"]);
    await resetDb();
    await staffWith("Volunteer.Event.ReadWrite");
    expect(await menu()).not.toContain(CREDIT);
  });

  it("shows Signed forms to someone who may read them, or remind and start again, and never Settings for that", async () => {
    for (const permission of ["Forms.Signature.Read", "Forms.Signature.ReadWrite"]) {
      await resetDb();
      await staffWith(permission);
      expect(await entries()).toEqual(["Home", "Season: Signed forms"]);
    }
  });

  it("leads someone who may only read the staff list from Settings straight to Staff, which is current there", async () => {
    await staffWith("Staff.Users.Read");
    expect(await entries()).toEqual(["Home", "Settings"]);
    expect(await menu()).toContain('href="/staff/settings/staff"');
    expect(await menu()).not.toContain(SETTINGS);
    expect(await current("/staff/settings/staff")).toEqual(["/staff/settings/staff"]);
  });

  it("marks one entry current, and the group that holds it", async () => {
    await asAdmin();
    expect(await current("/staff/seasons")).toEqual(["/staff/seasons"]);
    expect(await current("/staff/seasons/0b0f2a8e-0000-4000-8000-000000000001")).toEqual(["/staff/seasons"]);
    expect(await current("/staff/seasons/progress")).toEqual(["/staff/seasons/progress"]);
    expect(await current("/staff/seasons/progress/family/10")).toEqual(["/staff/seasons/progress"]);
    expect(await current("/staff")).toEqual(["/staff"]);
    expect(await current("/staff/parents/abc")).toEqual(["/staff/parents"]);
    expect(await current("/staff/balances/10")).toEqual(["/staff/balances"]);
    expect(await current("/staff/volunteer/0b0f2a8e-0000-4000-8000-000000000001")).toEqual(["/staff/volunteer"]);
    expect(await current("/staff/volunteer/credit/10")).toEqual(["/staff/volunteer/credit"]);
    expect(await current("/staff/forms/evidence/0b0f2a8e-0000-4000-8000-000000000001")).toEqual(["/staff/forms"]);
    expect(await current("/staff/reconciliation")).toEqual(["/staff/reconciliation"]);
    expect(await current("/staff/links")).toEqual(["/staff/links"]);
    // Every settings page is under the one Settings entry: Staff, Roles, the audit log, Health and the design system too.
    for (const path of ["/staff/settings", "/staff/settings/forms", "/staff/settings/parents/setup", "/staff/settings/club/edit", "/staff/settings/health",
      "/staff/settings/audit", "/staff/settings/staff", "/staff/settings/roles", "/staff/settings/design-system", "/staff/settings/integrations"]) {
      expect(await current(path), path).toEqual(["/staff/settings"]);
    }
    atPath("/staff/volunteer/credit");
  });
});

describe("the phone's tab bar and the group hubs", () => {
  beforeEach(resetDb);
  /** The tab bar's links, as "label href". */
  const tabBar = async () => {
    const html = await renderPage(StaffLayout);
    const nav = /<nav class="tabs staff-tabs"[^>]*>(.*?)<\/nav>/.exec(html)?.[1] ?? "";
    return [...nav.matchAll(/<a href="([^"]+)"[^>]*>.*?<\/svg>([^<]*)<\/a>/g)].map((m) => `${m[2]} ${m[1]}`);
  };

  it("draws an Admin's tabs, each group opening its hub, and Settings", async () => {
    await asAdmin();
    expect(await tabBar()).toEqual(["Home /staff", "Families /staff/families", "Season /staff/season", "Money /staff/money", "Settings /staff/settings"]);
  });

  it("draws a group's tab only for someone with a page in it, straight to the page when there is one", async () => {
    await staffWith("Finance.Balance.Read");
    expect(await tabBar()).toEqual(["Home /staff", "Money /staff/balances"]);
  });

  it("lists on each hub only the pages of its group the person may open, and refuses someone with none", async () => {
    await staffWith("Season.Progress.Read", "Volunteer.Credit.ReadWrite");
    const html = await renderPage(SeasonHub);
    expect([...html.matchAll(/<a class="list-link" href="([^"]+)"/g)].map((m) => m[1])).toEqual(["/staff/seasons/progress", "/staff/volunteer/credit"]);
    expect(html).toContain('<h1 class="page-title">Season</h1>');
    expect(await pageOutcome(MoneyHub)).toEqual({ redirect: "/refused" });
    expect(await pageOutcome(FamiliesHub)).toEqual({ redirect: "/refused" });
  });
});
