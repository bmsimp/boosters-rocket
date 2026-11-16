import { describe, it, expect, beforeEach } from "vitest";
import { asStaff, atPath, renderPage } from "../helpers/signed-in";

import { db } from "@/lib/db/client";
import { role, roleAssignment, roleRule } from "@/lib/db/schema";
import StaffLayout from "@/app/staff/(app)/layout";
import { resetDb, seedStaff } from "../helpers/db";

/** Each entry is shown only to someone who can open the page it leads to. */
const SEASONS = 'href="/staff/seasons"', PROGRESS = 'href="/staff/seasons/progress"', HEALTH = 'href="/staff/health"';
const BALANCES = 'href="/staff/balances"', VOLUNTEERING = 'href="/staff/volunteer"', SETTINGS = 'href="/staff/settings"';
const RECONCILIATION = 'href="/staff/reconciliation"', CREDIT = 'href="/staff/volunteer/credit"', SIGNED = 'href="/staff/forms"';
const ROLES = 'href="/staff/roles"', AUDIT = 'href="/staff/audit"', STAFF = 'href="/staff/people"';

async function staffWith(...patterns: string[]) {
  const s = await seedStaff({ email: "helper@club.org", name: "Hal Helper" });
  const [r] = await db.insert(role).values({ key: "helper", name: "Helper" }).returning();
  await db.insert(roleRule).values(patterns.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  asStaff(s);
}
const asAdmin = async () => asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));
/** The desktop menu: the `<nav class="top-nav">` of the bar, groups and their hidden panels included. */
const menu = async () => /<nav class="top-nav"[^>]*>(.*?)<\/nav>/.exec(await renderPage(StaffLayout))![1]!;
/** The menu's entries in words: "Home", "Settings", or "Families: Roster, Parents". */
async function entries(): Promise<string[]> {
  const nav = await menu();
  const out: string[] = [];
  for (const m of nav.matchAll(/<div class="nav-group"[^>]*><button[^>]*>([^<]*).*?<\/button><div[^>]*>(.*?)<\/div><\/div>|<a\b[^>]*>([^<]*)<\/a>/g)) {
    if (m[3] !== undefined) out.push(m[3]);
    else out.push(`${m[1]}: ${[...m[2]!.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)].map((a) => a[1]).join(", ")}`);
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

  it("groups an Admin's entries: Home, Families, Season, Money, Settings as one entry, then Admin", async () => {
    await asAdmin();
    expect(await entries()).toEqual([
      "Home",
      "Families: Roster, Parents",
      "Season: Seasons, Progress, Signed forms, Volunteering, Volunteer credit",
      "Money: Balances, Reconciliation",
      "Settings",
      "Admin: Staff, Roles, Audit, Health",
    ]);
  });

  it("draws each group as a closed button that says what it controls, its links hidden until it opens", async () => {
    await asAdmin();
    const nav = await menu();
    const buttons = [...nav.matchAll(/<button\b([^>]*)>/g)].map((b) => b[1]!);
    expect(buttons).toHaveLength(4);
    for (const b of buttons) {
      expect(b).toContain('type="button"');
      expect(b).toContain('aria-expanded="false"');
      const controls = /aria-controls="([^"]+)"/.exec(b)![1];
      expect(nav).toContain(`<div id="${controls}" class="nav-panel" hidden="">`);
    }
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

  it("never shows Roles, Audit or Health to a custom role, however wide, and gives it Settings for the Club alone", async () => {
    await staffWith("*", "Admin.*", "Admin.Health.Read", "Audit.Log.Read", "Settings.*");
    const nav = await menu();
    for (const entry of [SEASONS, PROGRESS, STAFF, SETTINGS]) expect(nav).toContain(entry);
    for (const entry of [HEALTH, ROLES, AUDIT]) expect(nav).not.toContain(entry);
    expect((await entries()).at(-1)).toBe("Admin: Staff");
  });

  it("shows Settings to someone who may read the club settings, and to nobody without a settings permission", async () => {
    await staffWith("Settings.Club.Read");
    expect(await entries()).toEqual(["Home", "Settings"]);
    await resetDb();
    await staffWith("Roster.Read", "Season.Steps.ReadWrite", "Finance.Balance.Read");
    expect(await menu()).not.toContain(SETTINGS);
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

  it("shows the Staff entry to someone who may read the staff list, and Roles only to an Admin", async () => {
    await staffWith("Staff.Users.Read");
    expect(await entries()).toEqual(["Home", "Admin: Staff"]);
  });

  it("marks one entry current, and the group that holds it", async () => {
    await asAdmin();
    expect(await current("/staff/seasons")).toEqual(["/staff/seasons"]);
    expect(await current("/staff/seasons/0b0f2a8e-0000-4000-8000-000000000001")).toEqual(["/staff/seasons"]);
    expect(await current("/staff/seasons/progress")).toEqual(["/staff/seasons/progress"]);
    expect(await current("/staff/seasons/progress/family/10")).toEqual(["/staff/seasons/progress"]);
    expect(await current("/staff/health")).toEqual(["/staff/health"]);
    expect(await current("/staff")).toEqual(["/staff"]);
    expect(await current("/staff/parents/abc")).toEqual(["/staff/parents"]);
    expect(await current("/staff/balances/10")).toEqual(["/staff/balances"]);
    expect(await current("/staff/volunteer/0b0f2a8e-0000-4000-8000-000000000001")).toEqual(["/staff/volunteer"]);
    expect(await current("/staff/volunteer/credit/10")).toEqual(["/staff/volunteer/credit"]);
    expect(await current("/staff/forms/evidence/0b0f2a8e-0000-4000-8000-000000000001")).toEqual(["/staff/forms"]);
    expect(await current("/staff/reconciliation")).toEqual(["/staff/reconciliation"]);
    // Every settings page is under the one Settings entry.
    for (const path of ["/staff/settings", "/staff/settings/forms", "/staff/settings/parents/setup", "/staff/settings/club/edit"]) {
      expect(await current(path), path).toEqual(["/staff/settings"]);
    }
    atPath("/staff/volunteer/credit");
    const groups = [...(await menu()).matchAll(/<button\b[^>]*class="([^"]*)"[^>]*>([^<]*)/g)].map((b) => [b[2], b[1]]);
    expect(groups).toEqual([["Families", "nav-group-button"], ["Season", "nav-group-button here"], ["Money", "nav-group-button"], ["Admin", "nav-group-button"]]);
    expect(await menu()).toContain("Season<span class=\"visually-hidden\">, current section</span>");
  });
});
