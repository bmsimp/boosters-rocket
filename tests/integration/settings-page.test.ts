import { describe, it, expect, beforeEach } from "vitest";
import { asStaff, asParent, renderPage, pageOutcome, signedOut } from "../helpers/signed-in";

import { db } from "@/lib/db/client";
import { role, roleAssignment, roleRule } from "@/lib/db/schema";
import { saveClubSettings } from "@/lib/settings/club";
import SettingsPage from "@/app/staff/(app)/settings/page";
import SettingsLayout from "@/app/staff/(app)/settings/layout";
import IntegrationsPage from "@/app/staff/(app)/settings/integrations/page";
import StaffPage from "@/app/staff/(app)/settings/staff/page";
import ClubSettingsPage from "@/app/staff/(app)/settings/club/page";
import ClubEditPage from "@/app/staff/(app)/settings/club/edit/page";
import SignInSettingsPage from "@/app/staff/(app)/settings/sign-in/page";
import SignInSetupPage from "@/app/staff/(app)/settings/sign-in/setup/page";
import MailSettingsPage from "@/app/staff/(app)/settings/mail/page";
import MailSetupPage from "@/app/staff/(app)/settings/mail/setup/page";
import QuickBooksSettingsPage from "@/app/staff/(app)/settings/quickbooks/page";
import ParentSettingsPage from "@/app/staff/(app)/settings/parents/page";
import FormsSettingsPage from "@/app/staff/(app)/settings/forms/page";
import FormsSetupPage from "@/app/staff/(app)/settings/forms/setup/page";
import { saveClubAction } from "@/app/staff/(app)/settings/club/actions";
import { AccessDenied } from "@/lib/guards";
import { resetDb, seedStaff, seedProvider, seedWorkingMail } from "../helpers/db";
import { seedSignedInParent } from "../helpers/parent";

const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
async function staffWith(...patterns: string[]) {
  const s = await seedStaff({ email: "helper@club.org", name: "Hal Helper" });
  const [r] = await db.insert(role).values({ key: "helper", name: "Helper" }).returning();
  await db.insert(roleRule).values(patterns.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  asStaff(s);
}
const asAdmin = async () => asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));
const layout = () => renderPage(SettingsLayout, { children: null });
/** The rail's entries, in order, as "title: status". */
async function rail(): Promise<string[]> {
  const nav = /<nav class="settings-rail[^"]*" aria-label="Settings">(.*?)<\/nav>/.exec(await layout())?.[1] ?? "";
  return [...nav.matchAll(/<span class="rail-name">([^<]*)<\/span><span class="status-dot[^"]*"><span class="dot" aria-hidden="true"><\/span>([^<]*)<\/span>/g)].map((m) => `${m[1]}: ${m[2]}`);
}
const titles = async () => (await rail()).map((r) => r.split(":")[0]);
const CLUB = { name: "Lakeside Band", shortName: "LB", color: "#225588", treasurerEmail: "", timeZone: "America/Chicago" };
const SYSTEM = { door: "system" as const, id: null, label: "t" };

describe("the Settings rail", () => {
  beforeEach(resetDb);

  it("shows an Admin every item in its group, each with its status in words, and no secret", async () => {
    await asAdmin();
    await seedProvider("staff-google", { clientId: "x.apps.googleusercontent.com" }, "google-secret-do-not-show");
    const html = await layout();
    expect(await titles()).toEqual(["Club", "Staff", "Roles", "Parent sign-ins", "Integrations", "Audit log", "Health", "Design system"]);
    for (const label of ["Club", "People and access", "Connections", "Administration"]) expect(html).toContain(`>${label}</p>`);
    // A new installation: the club isn't set, and the rail says so.
    expect(await rail()).toEqual(expect.arrayContaining(["Club: Not set yet", "Staff: 1 person", "Design system: Samples only"]));
    expect(html).not.toContain("google-secret-do-not-show");
    expect(html).not.toContain("<form");
  });

  it("says when the club is set, and counts the integrations that need attention or aren't set up", async () => {
    await asAdmin();
    await saveClubSettings(CLUB, SYSTEM, null);
    await seedWorkingMail({ method: "graph", mailbox: "webmaster@example.org" });
    // Mail works; QuickBooks and Documenso are not set up; nobody can sign in as staff, which needs attention.
    expect(await rail()).toEqual(expect.arrayContaining(["Club: Set", "Integrations: 1 needs attention"]));
    await seedProvider("staff-google", { clientId: "x.apps.googleusercontent.com" }, "google-secret", new Date(Date.now() + 90 * 86_400_000));
    expect(await rail()).toContain("Integrations: 2 not set up");
  });

  it("shows someone who may read the club settings the Club and the design system, and nobody else an Admin-only item", async () => {
    for (const patterns of [["Settings.Club.Read"], ["Settings.Club.ReadWrite"], ["Settings.*", "Settings.Mail.ReadWrite", "Settings.Forms.ReadWrite"]]) {
      await resetDb();
      await staffWith(...patterns);
      expect(await titles(), patterns.join(", ")).toEqual(["Club", "Design system"]);
    }
    await resetDb();
    await staffWith("*");
    expect(await titles()).toEqual(["Club", "Staff", "Design system"]);
    await resetDb();
    await staffWith("Staff.Users.Read");
    expect(await titles()).toEqual(["Staff"]);
  });

  it("is drawn for nobody without a settings item: it is navigation, and each page keeps its own guard", async () => {
    await staffWith("Roster.Read");
    expect(await layout()).not.toContain("settings-rail");
  });

  it("has Find a setting, labelled, and the rail's title is the page's h1 only on the Overview", async () => {
    await asAdmin();
    const html = await layout();
    expect(html).toContain('placeholder="Find a setting"');
    expect(html).toMatch(/<label for="[^"]+" class="visually-hidden">Find a setting<\/label>/);
  });
});

describe("the Overview", () => {
  beforeEach(resetDb);

  it("lists what needs attention, each a row that leads to it, an integration by its own name", async () => {
    await asAdmin();
    // Nobody can sign in as staff: one row, not one for each provider.
    await seedProvider("staff-google", { clientId: "x.apps.googleusercontent.com" }, "google-secret", new Date(Date.now() - 86_400_000));
    let html = await renderPage(SettingsPage);
    let rows = [...html.matchAll(/data-attention="([^"]+)"/g)].map((m) => m[1]);
    expect(rows).toEqual(expect.arrayContaining(["club", "sign-in"]));
    expect(rows).not.toContain("integrations");
    expect(rows).not.toContain("staff-google");
    expect(textOf(html)).toContain("Staff sign-in Nobody can sign in");
    // Microsoft works, so Google's expired secret is its own row.
    await seedProvider("staff-microsoft", { tenantId: "t", clientId: "c" }, "unused");
    html = await renderPage(SettingsPage);
    rows = [...html.matchAll(/data-attention="([^"]+)"/g)].map((m) => m[1]);
    expect(html).toContain('href="/staff/settings/sign-in#staff-google"');
    expect(textOf(html)).toContain("Google Expired");
    expect(html).not.toContain("<input");
  });

  it("says everything that is set up works when nothing needs attention", async () => {
    await staffWith("Settings.Club.ReadWrite");
    await saveClubSettings(CLUB, SYSTEM, null);
    expect(textOf(await renderPage(SettingsPage))).toContain("Everything that is set up is working.");
  });

  it("refuses someone who may not read the club settings, a parent session and no session", async () => {
    await staffWith("Roster.Read", "Season.Steps.ReadWrite", "Finance.Balance.Read", "Staff.Users.Read");
    expect(await pageOutcome(SettingsPage)).toEqual({ redirect: "/refused" });
    await resetDb(); signedOut();
    expect(await pageOutcome(SettingsPage)).toEqual({ redirect: "/staff/sign-in" });
    asParent((await seedSignedInParent()).identity);
    expect(await pageOutcome(SettingsPage)).toEqual({ redirect: "/staff/sign-in" });
  });
});

describe("the settings pages", () => {
  beforeEach(resetDb);

  it("refuses a parent session on every settings page", async () => {
    asParent((await seedSignedInParent()).identity);
    for (const page of [SettingsPage, IntegrationsPage, ClubSettingsPage, ClubEditPage, SignInSettingsPage, SignInSetupPage, MailSettingsPage, MailSetupPage,
      QuickBooksSettingsPage, ParentSettingsPage, FormsSettingsPage, FormsSetupPage]) {
      expect(await pageOutcome(page)).toEqual({ redirect: "/staff/sign-in" });
    }
    await expect(saveClubAction({ name: "X", shortName: "X", color: "#000000", timeZone: "UTC" })).rejects.toBeInstanceOf(AccessDenied);
  });

  it("gives every settings page a way back: Settings (drawn on a phone), or Integrations for an integration's page", async () => {
    await asAdmin();
    for (const page of [ClubSettingsPage, ParentSettingsPage, IntegrationsPage, StaffPage]) {
      expect(await renderPage(page)).toMatch(/<div class="page-head settings-head"><div><p class="page-back"><a href="\/staff\/settings">.*?Settings<\/a><\/p>/);
    }
    for (const page of [SignInSettingsPage, MailSettingsPage, QuickBooksSettingsPage, FormsSettingsPage]) {
      expect(await renderPage(page)).toMatch(/<p class="page-back"><a href="\/staff\/settings\/integrations">.*?Integrations<\/a><\/p>/);
    }
  });

  it("leaves the way back to Settings out for someone who may not open the Overview, and says who can change Staff", async () => {
    await staffWith("Staff.Users.Read");
    const html = await renderPage(StaffPage);
    expect(html).not.toContain('href="/staff/settings"');
    expect(textOf(html)).toContain("Only an Admin can add someone or change their roles.");
    expect(html).not.toMatch(/<button[^>]*>Save roles/);
  });

  it("shows each part plainly, with no inputs, and its steps on their own page", async () => {
    await asAdmin();
    for (const [view, steps, href] of [[ClubSettingsPage, ClubEditPage, "/staff/settings/club/edit"], [SignInSettingsPage, SignInSetupPage, "/staff/settings/sign-in/setup"],
      [MailSettingsPage, MailSetupPage, "/staff/settings/mail/setup"], [FormsSettingsPage, FormsSetupPage, "/staff/settings/forms/setup"]] as const) {
      const html = await renderPage(view);
      expect(html, href).not.toMatch(/<input(?![^>]*type="hidden")|<select|<textarea/);
      expect(html, href).toContain(`href="${href}"`);
      expect(await renderPage(steps), href).toMatch(/<input|<select/);
    }
  });

  it("gives each provider's card on Staff sign-in the anchor the Integrations page leads to, and never shows its secret", async () => {
    await asAdmin();
    await seedProvider("staff-google", { clientId: "x.apps.googleusercontent.com" }, "google-secret-do-not-show");
    const html = await renderPage(SignInSettingsPage);
    for (const key of ["staff-microsoft", "staff-google"]) expect(html).toContain(`<section id="${key}" class="box"`);
    expect(html).not.toContain("google-secret-do-not-show");
  });
});

describe("the Integrations page", () => {
  beforeEach(resetDb);

  it("groups an Admin's integrations by kind, each with its rule, a row for each system leading to its page", async () => {
    await asAdmin();
    await seedWorkingMail({ method: "graph", mailbox: "webmaster@example.org" });
    const html = await renderPage(IntegrationsPage);
    expect([...html.matchAll(/data-kind="([^"]+)"/g)].map((m) => m[1])).toEqual(["accounting", "forms", "mail", "staff-sign-in"]);
    expect([...html.matchAll(/data-integration="([^"]+)"/g)].map((m) => m[1])).toEqual(["quickbooks", "documenso", "mail-graph", "mail-smtp", "staff-microsoft", "staff-google"]);
    for (const rule of ["One QuickBooks company is connected at a time.", "One way of sending is used at a time.", "Staff can sign in with either or both."]) expect(textOf(html)).toContain(rule);
    for (const href of ["/staff/settings/quickbooks", "/staff/settings/forms", "/staff/settings/mail", "/staff/settings/sign-in#staff-microsoft", "/staff/settings/sign-in#staff-google"]) {
      expect(html).toContain(`<a class="list-link" href="${href}">`);
    }
    const text = textOf(html);
    expect(text).toContain("Microsoft 365 Sends as webmaster@example.org. Working");
    expect(text).toContain("SMTP Sends through any mail server that takes a user name and password. Not in use");
    expect(text).toContain("QuickBooks Online Reads families, students and invoices; sends the names and changes staff make on the roster. Not set up");
    // The vendors' own marks, small, from the app: nothing is fetched from outside.
    expect(html).toContain('src="/integrations/microsoft.svg"');
    expect(html).toContain('src="/integrations/google.svg"');
    expect(html).not.toMatch(/src="https?:/);
  });

  it("refuses anyone but an Admin, however wide their role", async () => {
    await staffWith("*", "Settings.*");
    expect(await pageOutcome(IntegrationsPage)).toEqual({ redirect: "/refused" });
  });
});

describe("the Club pages", () => {
  beforeEach(resetDb);

  it("shows the club settings plainly to someone who may read them, without the way to change them", async () => {
    await staffWith("Settings.Club.Read");
    const html = await renderPage(ClubSettingsPage);
    expect(html).not.toContain('href="/staff/settings/club/edit"');
    expect(await pageOutcome(ClubEditPage)).toEqual({ redirect: "/refused" });
    await expect(saveClubAction({ name: "X", shortName: "X", color: "#000000", timeZone: "UTC" })).rejects.toBeInstanceOf(AccessDenied);
  });

  it("saves a change by the Club settings' rules, refusing what no page sends", async () => {
    await staffWith("Settings.Club.ReadWrite");
    expect(await renderPage(ClubSettingsPage)).toContain('href="/staff/settings/club/edit"');
    expect(await saveClubAction({ name: "Lakeside Band", shortName: "LB", color: "#225588", treasurerEmail: "money@club.org", timeZone: "America/Chicago" }))
      .toEqual({ ok: true, message: "Saved. Every page now uses these." });
    expect(await saveClubAction({ name: "", shortName: "LB", color: "#225588", timeZone: "UTC" })).toEqual({ ok: false, errors: ["Club name is required."] });
    expect(await saveClubAction({ name: ["x"], shortName: "LB", color: "#225588", timeZone: "UTC" })).toMatchObject({ ok: false });
    expect(await saveClubAction(null)).toMatchObject({ ok: false });
    expect(textOf(await renderPage(ClubSettingsPage))).toContain("Club name Lakeside Band Short name LB");
  });
});
