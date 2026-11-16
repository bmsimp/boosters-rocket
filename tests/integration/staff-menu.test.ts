import { describe, it, expect, beforeEach } from "vitest";
import { asStaff, renderPage } from "../helpers/signed-in";

import { db } from "@/lib/db/client";
import { role, roleAssignment, roleRule } from "@/lib/db/schema";
import StaffLayout from "@/app/staff/(app)/layout";
import { resetDb, seedStaff } from "../helpers/db";

/** The staff menu's entries for the pages step 3 added: each is shown only to someone who can open the page it leads to. */
const SEASONS = 'href="/staff/seasons"', PROGRESS = 'href="/staff/seasons/progress"', HEALTH = 'href="/staff/health"';

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

  it("shows none of them to someone with no season permission", async () => {
    await staffWith("Roster.Read");
    const html = await menu();
    for (const entry of [SEASONS, PROGRESS, HEALTH]) expect(html).not.toContain(entry);
    expect(html).toContain('href="/staff/roster"');
  });
});
