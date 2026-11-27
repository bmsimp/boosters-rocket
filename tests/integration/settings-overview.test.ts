import { describe, it, expect, beforeEach } from "vitest";
import { asStaff, renderPage } from "../helpers/signed-in";

import { db } from "@/lib/db/client";
import { role, roleAssignment, roleRule } from "@/lib/db/schema";
import { saveClubSettings } from "@/lib/settings/club";
import SettingsPage from "@/app/staff/(app)/settings/page";
import { resetDb, seedProvider, seedStaff, seedWorkingMail } from "../helpers/db";

/**
 * The Settings Overview's status cards (the owner's approval of 2026-11-27): one for each area of the list pane the
 * person may open but the design system, each with its status in words, facts read from the portal, and one button,
 * filled when the area needs attention and tonal otherwise.
 */
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const CLUB = { name: "Lakeside Band", shortName: "LB", color: "#225588", treasurerEmail: "", timeZone: "America/Chicago" };
const SYSTEM = { door: "system" as const, id: null, label: "t" };

async function staffWith(...patterns: string[]) {
  const s = await seedStaff({ email: "helper@club.org", name: "Hal Helper" });
  const [r] = await db.insert(role).values({ key: "helper", name: "Helper" }).returning();
  await db.insert(roleRule).values(patterns.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  asStaff(s);
}
const asAdmin = async () => asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));

type Drawn = { key: string; html: string; text: string; button: { cls: string; href: string; words: string } };
/** The cards, in order, each with its words and its one button. */
async function cards(): Promise<Drawn[]> {
  const html = await renderPage(SettingsPage);
  return [...html.matchAll(/<section class="box" aria-labelledby="overview-([a-z-]+)-h">(.*?)<\/section>/g)].map((m) => {
    const buttons = [...m[2]!.matchAll(/<a class="([^"]+)" href="([^"]+)">([^<]*)<\/a>/g)];
    expect(buttons, m[1]).toHaveLength(1);
    const [, cls, href, words] = buttons[0]!;
    return { key: m[1]!, html: m[2]!, text: textOf(m[2]!), button: { cls: cls!, href: href!, words: words! } };
  });
}
const card = async (key: string) => (await cards()).find((c) => c.key === key)!;

describe("the Overview's status cards", () => {
  beforeEach(resetDb);

  it("gives an Admin a card for each area but the design system, in the list pane's order, each leading to its page", async () => {
    await asAdmin();
    const all = await cards();
    expect(all.map((c) => c.key)).toEqual(["club", "messages", "staff", "roles", "parents", "integrations", "audit", "health"]);
    expect(all.map((c) => `${c.button.words} ${c.button.href}`)).toEqual([
      "Open Club /staff/settings/club", "Open Messages /staff/settings/messages", "Open Staff /staff/settings/staff", "Open Roles /staff/settings/roles",
      "Open Parent sign-ins /staff/settings/parents", "Open Integrations /staff/settings/integrations", "Open the audit log /staff/settings/audit",
      "Open Health /staff/settings/health",
    ]);
  });

  it("shows someone only the cards for what they may open", async () => {
    await staffWith("Settings.Club.Read");
    expect((await cards()).map((c) => c.key)).toEqual(["club", "messages"]);
    await resetDb();
    // However wide a custom role, Roles, the audit log, Health and Integrations stay an Admin's.
    await staffWith("*", "Settings.*", "Admin.*", "Audit.Log.Read");
    expect((await cards()).map((c) => c.key)).toEqual(["club", "messages", "staff"]);
  });

  it("gives a card that needs attention a filled button, and one that doesn't a tonal one", async () => {
    await asAdmin();
    // A new installation: the club isn't set.
    let club = await card("club");
    expect(club.text).toContain("Not set yet");
    expect(club.button.cls).toBe("btn");
    expect(club.html).toContain('data-card-status="due"');
    await saveClubSettings(CLUB, SYSTEM, null);
    club = await card("club");
    expect(club.text).toContain("Set");
    expect(club.button.cls).toBe("btn btn-tonal");
    // Nobody can sign in as staff, so Integrations needs attention, and the notice at the top names it.
    const integrations = await card("integrations");
    expect(integrations.button.cls).toBe("btn");
    expect(textOf(await renderPage(SettingsPage))).toContain("Needs attention");
  });

  it("states real facts: the club's settings, counts of staff, roles and sign-ins, and each system's status", async () => {
    await asAdmin();
    await saveClubSettings(CLUB, SYSTEM, null);
    await seedWorkingMail({ method: "graph", mailbox: "webmaster@example.org" });
    await seedProvider("staff-google", { clientId: "x.apps.googleusercontent.com" }, "google-secret-do-not-show", new Date(Date.now() + 90 * 86_400_000));
    const all = await cards();
    const text = (key: string) => all.find((c) => c.key === key)!.text;
    expect(text("club")).toContain("Name Lakeside Band");
    expect(text("club")).toContain("Color #225588");
    expect(text("club")).toContain("Time zone America/Chicago");
    expect(text("messages")).toContain("Posted 0 messages");
    expect(text("messages")).toContain("Email to families Off");
    expect(text("staff")).toContain("Can sign in 1 person");
    expect(text("staff")).toContain("Admins 1");
    expect(text("roles")).toMatch(/Built in \d+/);
    expect(text("parents")).toContain("Can sign in 0 people, 0 families");
    expect(text("integrations")).toContain("QuickBooks Online Not set up");
    expect(text("integrations")).toContain("Outgoing mail Working");
    expect(text("integrations")).toContain("Staff sign-in Working");
    expect(text("audit")).toMatch(/In the last 7 days \d+ entr/);
    expect(text("health")).toMatch(/Checks working \d+ of \d+/);
    // Saving the club wrote an audit row; the card says when, in the viewer's own time.
    expect(all.find((c) => c.key === "audit")!.html).toContain("<time");
    const html = await renderPage(SettingsPage);
    expect(html).not.toContain("google-secret-do-not-show");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
  });
});
