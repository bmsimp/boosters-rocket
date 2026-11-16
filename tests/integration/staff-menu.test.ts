import { describe, it, expect, beforeEach } from "vitest";
import { asStaff, atPath, renderPage } from "../helpers/signed-in";

import { db } from "@/lib/db/client";
import { role, roleAssignment, roleRule } from "@/lib/db/schema";
import StaffLayout from "@/app/staff/(app)/layout";
import { resetDb, seedStaff } from "../helpers/db";

/** The staff menu's entries for the pages step 3 added: each is shown only to someone who can open the page it leads to. */
const SEASONS = 'href="/staff/seasons"', PROGRESS = 'href="/staff/seasons/progress"', HEALTH = 'href="/staff/health"';
/** Step 4's entries: Balances, Volunteering and the Forms settings. */
const BALANCES = 'href="/staff/balances"', VOLUNTEERING = 'href="/staff/volunteer"', FORMS = 'href="/staff/settings/forms"';
/** Step 5's entries: Reconciliation, the volunteer credit pages and the signed forms' matrix. */
const RECONCILIATION = 'href="/staff/reconciliation"', CREDIT = 'href="/staff/volunteer/credit"', SIGNED = 'href="/staff/forms"';

async function staffWith(...patterns: string[]) {
  const s = await seedStaff({ email: "helper@club.org", name: "Hal Helper" });
  const [r] = await db.insert(role).values({ key: "helper", name: "Helper" }).returning();
  await db.insert(roleRule).values(patterns.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  asStaff(s);
}
const menu = () => renderPage(StaffLayout);

describe("the staff menu", () => {
  beforeEach(resetDb);

  it("shows an Admin Seasons, Progress and Health", async () => {
    asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));
    const html = await menu();
    for (const entry of [SEASONS, PROGRESS, HEALTH]) expect(html).toContain(entry);
  });

  it("shows someone who only ticks names off the Progress entry, and not the set-up pages they can't open", async () => {
    await staffWith("Season.Progress.ReadWrite");
    const html = await menu();
    expect(html).toContain(PROGRESS);
    expect(html).not.toContain(SEASONS);
    expect(html).not.toContain(HEALTH);
  });

  it("shows someone who sets seasons up the Seasons entry alone", async () => {
    await staffWith("Season.Steps.Read");
    const html = await menu();
    expect(html).toContain(SEASONS);
    expect(html).not.toContain(PROGRESS);
    expect(html).not.toContain(HEALTH);
  });

  it("never shows Health to a custom role, however wide", async () => {
    await staffWith("*", "Admin.*", "Admin.Health.Read");
    const html = await menu();
    expect(html).toContain(SEASONS);
    expect(html).toContain(PROGRESS);
    expect(html).not.toContain(HEALTH);
  });

  it("marks one entry current: on a Progress page that is Progress, not the Seasons section its address sits under", async () => {
    asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));
    const current = async (path: string) => {
      atPath(path);
      const nav = /<nav class="top-nav"[^>]*>(.*?)<\/nav>/.exec(await menu())![1]!;
      return [...nav.matchAll(/<a\b[^>]*>/g)].filter((a) => a[0].includes('aria-current="page"')).map((a) => /href="([^"]*)"/.exec(a[0])![1]);
    };
    expect(await current("/staff/seasons")).toEqual(["/staff/seasons"]);
    expect(await current("/staff/seasons/0b0f2a8e-0000-4000-8000-000000000001")).toEqual(["/staff/seasons"]);
    expect(await current("/staff/seasons/progress")).toEqual(["/staff/seasons/progress"]);
    expect(await current("/staff/seasons/progress/family/10")).toEqual(["/staff/seasons/progress"]);
    expect(await current("/staff/health")).toEqual(["/staff/health"]);
    expect(await current("/staff")).toEqual(["/staff"]);
    expect(await current("/staff/settings/parents/setup")).toEqual(["/staff/settings/parents"]);
    expect(await current("/staff/parents/abc")).toEqual(["/staff/parents"]);
  });

  it("shows an Admin Balances, Volunteering and Forms", async () => {
    asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));
    const html = await menu();
    for (const entry of [BALANCES, VOLUNTEERING, FORMS]) expect(html).toContain(entry);
  });

  it("shows Balances only to someone who may read balances", async () => {
    await staffWith("Finance.Balance.Read");
    const html = await menu();
    expect(html).toContain(BALANCES);
    for (const entry of [VOLUNTEERING, FORMS, SEASONS]) expect(html).not.toContain(entry);
  });

  it("shows Volunteering to someone who may read the events, and to someone who may change them", async () => {
    for (const permission of ["Volunteer.Event.Read", "Volunteer.Event.ReadWrite"]) {
      await resetDb();
      await staffWith(permission);
      const html = await menu();
      expect(html).toContain(VOLUNTEERING);
      for (const entry of [BALANCES, FORMS]) expect(html).not.toContain(entry);
    }
  });

  it("never shows the Forms settings to a custom role, however wide", async () => {
    await staffWith("*", "Settings.*", "Settings.Forms.ReadWrite");
    const html = await menu();
    expect(html).toContain(BALANCES);
    expect(html).toContain(VOLUNTEERING);
    expect(html).not.toContain(FORMS);
  });

  it("marks Balances and Volunteering current on the pages under them", async () => {
    asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));
    const current = async (path: string) => {
      atPath(path);
      const nav = /<nav class="top-nav"[^>]*>(.*?)<\/nav>/.exec(await menu())![1]!;
      return [...nav.matchAll(/<a\b[^>]*>/g)].filter((a) => a[0].includes('aria-current="page"')).map((a) => /href="([^"]*)"/.exec(a[0])![1]);
    };
    expect(await current("/staff/balances/10")).toEqual(["/staff/balances"]);
    expect(await current("/staff/volunteer/0b0f2a8e-0000-4000-8000-000000000001")).toEqual(["/staff/volunteer"]);
    expect(await current("/staff/settings/forms")).toEqual(["/staff/settings/forms"]);
  });

  it("shows none of them to someone with no season permission", async () => {
    await staffWith("Roster.Read");
    const html = await menu();
    for (const entry of [SEASONS, PROGRESS, HEALTH, BALANCES, VOLUNTEERING, FORMS, CREDIT, SIGNED]) expect(html).not.toContain(entry);
    expect(html).toContain('href="/staff/roster"');
  });

  it("shows an Admin Reconciliation, Volunteer credit and Signed forms", async () => {
    asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));
    const html = await menu();
    for (const entry of [RECONCILIATION, CREDIT, SIGNED]) expect(html).toContain(entry);
  });

  it("shows Reconciliation with the roster, to anyone who may read it", async () => {
    await staffWith("Roster.Read");
    expect(await menu()).toContain(RECONCILIATION);
  });

  it("shows Volunteer credit only to someone who may change credit, even without the events", async () => {
    await staffWith("Volunteer.Credit.ReadWrite");
    const html = await menu();
    expect(html).toContain(CREDIT);
    for (const entry of [VOLUNTEERING, RECONCILIATION, SIGNED]) expect(html).not.toContain(entry);
    await resetDb();
    await staffWith("Volunteer.Event.ReadWrite");
    expect(await menu()).not.toContain(CREDIT);
  });

  it("shows Signed forms to someone who may read them, or remind and start again, and never the Forms settings", async () => {
    for (const permission of ["Forms.Signature.Read", "Forms.Signature.ReadWrite"]) {
      await resetDb();
      await staffWith(permission);
      const html = await menu();
      expect(html).toContain(SIGNED);
      for (const entry of [FORMS, CREDIT, RECONCILIATION]) expect(html).not.toContain(entry);
    }
  });

  it("marks Volunteer credit, not Volunteering, current on the credit pages, and Signed forms on the matrix's pages", async () => {
    asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));
    const current = async (path: string) => {
      atPath(path);
      const nav = /<nav class="top-nav"[^>]*>(.*?)<\/nav>/.exec(await menu())![1]!;
      return [...nav.matchAll(/<a\b[^>]*>/g)].filter((a) => a[0].includes('aria-current="page"')).map((a) => /href="([^"]*)"/.exec(a[0])![1]);
    };
    expect(await current("/staff/volunteer/credit/10")).toEqual(["/staff/volunteer/credit"]);
    expect(await current("/staff/volunteer")).toEqual(["/staff/volunteer"]);
    expect(await current("/staff/forms/evidence/0b0f2a8e-0000-4000-8000-000000000001")).toEqual(["/staff/forms"]);
    expect(await current("/staff/settings/forms")).toEqual(["/staff/settings/forms"]);
    expect(await current("/staff/reconciliation")).toEqual(["/staff/reconciliation"]);
  });
});
