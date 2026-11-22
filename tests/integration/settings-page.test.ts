import { describe, it, expect, beforeEach } from "vitest";
import { asStaff, asParent, renderPage, pageOutcome, signedOut } from "../helpers/signed-in";

import { db } from "@/lib/db/client";
import { role, roleAssignment, roleRule } from "@/lib/db/schema";
import { saveClubSettings } from "@/lib/settings/club";
import SettingsPage from "@/app/staff/(app)/settings/page";
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

const SECTIONS = { club: "Club", "sign-in": "Staff sign-in", mail: "Outgoing mail", quickbooks: "QuickBooks", parents: "Parent sign-ins", forms: "Forms (Documenso)" };
/** The sections the Settings page shows, by key, in order. */
const shown = (html: string) => [...html.matchAll(/data-settings="([^"]+)"/g)].map((m) => m[1]);
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
async function staffWith(...patterns: string[]) {
  const s = await seedStaff({ email: "helper@club.org", name: "Hal Helper" });
  const [r] = await db.insert(role).values({ key: "helper", name: "Helper" }).returning();
  await db.insert(roleRule).values(patterns.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  asStaff(s);
}
const asAdmin = async () => asStaff(await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true }));

describe("the Settings page", () => {
  beforeEach(resetDb);

  it("shows an Admin every section, in order, each saying in words whether it works and leading to its own page", async () => {
    await asAdmin();
    const html = await renderPage(SettingsPage);
    expect(shown(html)).toEqual(Object.keys(SECTIONS));
    for (const [key, title] of Object.entries(SECTIONS)) {
      const box = new RegExp(`data-settings="${key}">(.*?)</section>`).exec(html)![1]!;
      expect(box).toContain(`>${title}</h2>`);
      expect(box).toMatch(/<span class="state (done|todo)"><svg/);
      expect(box).toContain(`href="/staff/settings/${key}"`);
    }
    // A new installation: nothing set up, so each says so.
    expect(textOf(html)).toContain("Not set yet: the portal still shows the name Boosters Rocket");
    expect(textOf(html)).toContain("Nobody can sign in as staff yet");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<form");
  });

  it("says what works once it does, and never shows a secret", async () => {
    await asAdmin();
    await saveClubSettings({ name: "Lakeside Band", shortName: "LB", color: "#225588", treasurerEmail: "", timeZone: "America/Chicago" }, { door: "system", id: null, label: "t" }, null);
    await seedProvider("staff-google", { clientId: "x.apps.googleusercontent.com" }, "google-secret-do-not-show");
    await seedWorkingMail({ method: "graph", mailbox: "webmaster@example.org" });
    const html = await renderPage(SettingsPage);
    const text = textOf(html);
    expect(text).toContain("Club Set Name Lakeside Band");
    expect(text).toContain("Time zone America/Chicago");
    expect(text).toContain("Staff sign in with Google");
    expect(text).toContain("Outgoing mail Working");
    expect(html).not.toContain("google-secret-do-not-show");
  });

  it("never calls a sign-in whose secret has expired working", async () => {
    await asAdmin();
    await seedProvider("staff-google", { clientId: "x.apps.googleusercontent.com" }, "google-secret", new Date(Date.now() - 86_400_000));
    const html = await renderPage(SettingsPage);
    const box = new RegExp(`data-settings="sign-in">(.*?)</section>`).exec(html)![1]!;
    expect(box).toMatch(/<span class="state todo">/);
    expect(textOf(box)).toContain("Nobody can sign in as staff yet");
    expect(textOf(box)).toContain("Its secret expired on");
    expect(textOf(box)).not.toContain("Working");
  });

  it("shows someone who may read the club settings the Club section alone, and an Admin-only section to nobody else", async () => {
    for (const patterns of [["Settings.Club.Read"], ["Settings.Club.ReadWrite"], ["*"], ["Settings.*", "Settings.Mail.ReadWrite", "Settings.Forms.ReadWrite"]]) {
      await resetDb();
      await staffWith(...patterns);
      expect(shown(await renderPage(SettingsPage)), patterns.join(", ")).toEqual(["club"]);
    }
  });

  it("refuses someone with no settings permission, a parent session and no session", async () => {
    await staffWith("Roster.Read", "Season.Steps.ReadWrite", "Finance.Balance.Read", "Staff.Users.Read");
    expect(await pageOutcome(SettingsPage)).toEqual({ redirect: "/refused" });
    await resetDb(); signedOut();
    expect(await pageOutcome(SettingsPage)).toEqual({ redirect: "/staff/sign-in" });
    asParent((await seedSignedInParent()).identity);
    expect(await pageOutcome(SettingsPage)).toEqual({ redirect: "/staff/sign-in" });
  });

  it("refuses a parent session on every settings page", async () => {
    asParent((await seedSignedInParent()).identity);
    for (const page of [SettingsPage, ClubSettingsPage, ClubEditPage, SignInSettingsPage, SignInSetupPage, MailSettingsPage, MailSetupPage,
      QuickBooksSettingsPage, ParentSettingsPage, FormsSettingsPage, FormsSetupPage]) {
      expect(await pageOutcome(page)).toEqual({ redirect: "/staff/sign-in" });
    }
    await expect(saveClubAction({ name: "X", shortName: "X", color: "#000000", timeZone: "UTC" })).rejects.toBeInstanceOf(AccessDenied);
  });

  it("gives every settings page a way back to Settings", async () => {
    await asAdmin();
    for (const page of [ClubSettingsPage, SignInSettingsPage, MailSettingsPage, QuickBooksSettingsPage, ParentSettingsPage, FormsSettingsPage]) {
      expect(await renderPage(page)).toContain('<p class="back-to-settings"><a href="/staff/settings">Back to Settings</a></p>');
    }
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
