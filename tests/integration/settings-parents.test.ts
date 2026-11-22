import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

const who = vi.hoisted(() => ({ staff: null as null | { door: "staff"; staffUserId: string; name: string; email: string } }));
vi.mock("@/lib/auth/identity", () => ({
  getStaffIdentity: async () => who.staff, hasStaffSession: async () => Boolean(who.staff),
  getParentIdentity: async () => null, getParentState: async () => ({ status: "none" }), hasParentSession: async () => false,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.40" }), cookies: async () => ({ get: () => undefined }) }));
// A staff member who may open Parent sign-ins but doesn't hold the reset's permission (slice SI-9b). No role can be made
// so (both are Admin-only), so it is made from outside src/: while `withoutReset` is set, the viewer's permissions are
// every one but Parents.SignInReset.ReadWrite, and not an Admin's.
const narrow = vi.hoisted(() => ({ withoutReset: false }));
vi.mock("@/lib/permissions/effective", async (original) => {
  const m = await original<typeof import("@/lib/permissions/effective")>();
  const { PERMISSIONS } = await import("@/lib/permissions/registry");
  return { ...m, effectivePermissions: async (id: string) => {
    const e = await m.effectivePermissions(id);
    if (!narrow.withoutReset) return e;
    return { isAdmin: false, permissions: new Set([...(e.isAdmin ? PERMISSIONS : e.permissions)].filter((x) => x !== "Parents.SignInReset.ReadWrite")) };
  } };
});
const revalidated = vi.hoisted(() => ({ count: 0 }));
vi.mock("next/cache", () => ({ revalidatePath: () => { revalidated.count += 1; } }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw Object.assign(new Error("NEXT_NOT_FOUND"), { notFound: true }); },
  usePathname: () => "/staff",                                                  // the staff menu, rendered to check its entry
}));

import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, jobRun, parent, parentSigninToken, qboConnection, role, roleAssignment, roleRule, setting, student } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import { getParentSettings, PARENTS_KEY } from "@/lib/parents/settings";
import { ROSTER_JOB, setRosterSource } from "@/lib/roster/source";
import ParentSettingsPage from "@/app/staff/(app)/settings/parents/page";
import ParentSetupPage from "@/app/staff/(app)/settings/parents/setup/page";
import QuickBooksSettingsPage from "@/app/staff/(app)/settings/quickbooks/page";
import StaffLayout from "@/app/staff/(app)/layout";
import { SETTINGS_ITEMS } from "@/app/staff/(app)/settings/sections";
import { oweSetupMailsAction, removeOldAddressPasskeysAction, setLevelAction, setSigninsAction, setWelcomeAction, setRequireStudentsAction } from "@/app/staff/(app)/settings/parents/actions";
import { OLD_PASSKEYS_CHANGED, OLD_PASSKEYS_COPY as OLD } from "@/lib/parents/old-passkeys-copy";
import { LEVEL_COUNT_CHANGED, LEVEL_UNREADABLE } from "@/lib/parents/switches";
import { resetDb, seedGuardian, seedParent, seedParentSession, seedStaff, seedWorkingMail } from "../helpers/db";
import { seedCache, seedParentSettings, seedShape, storeShape, fam, par, stu } from "../helpers/roster-cache";
import { startQboStub, seedConnected, type QboStub } from "../helpers/qbo-stub";
import { syncAppRecords } from "../helpers/app-records";
import { seedPassword } from "../helpers/signin-links";
import { ORIGIN, passkeyRows, seedPasskey } from "../helpers/passkey";
import { seedAuthenticator } from "../helpers/authenticator";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const thrown = async (p: Promise<unknown>) => (await p.catch((e: { url?: string; notFound?: boolean }) => e)) as { url?: string; notFound?: boolean };

const ROSTER = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), stu("12", "Leo Rivera", "10"), par("13", "No Mail", "10", null),
  fam("20", "Chen Family"), par("21", "Shared Sam", "20", "sam@example.com"), fam("30", "Lee Family"), par("31", "Shared Sam", "30", "sam@example.com")];
const view = async () => renderToStaticMarkup(await ParentSettingsPage());
const setup = async (step?: string) => renderToStaticMarkup(await ParentSetupPage({ searchParams: Promise.resolve(step ? { step } : {}) }));
const BROWSER = "That didn't go through. Reload the page and try again.";

describe("the Parent sign-ins settings", () => {
  let admin: Awaited<ReturnType<typeof seedStaff>>;
  beforeEach(async () => {
    await resetDb(); stub.reset(); revalidated.count = 0;
    narrow.withoutReset = false;
    admin = await seedStaff({ email: "admin@club.org", name: "Ad Min", admin: true });
    who.staff = { door: "staff", staffUserId: admin.id, name: admin.name, email: admin.email };
  });
  /**
   * A club with QuickBooks connected and its roster read, working mail, and one guardian the portal holds: Ana, in
   * the Rivera family. Nobody else in the roster has a sign-in: QuickBooks gives none.
   */
  const ready = async () => {
    await seedConnected(stub); await seedShape(); await seedCache(ROSTER); await seedWorkingMail();
    await db.transaction((tx) => setRosterSource(tx, "9130000000000001"));
    await db.insert(jobRun).values({ job: ROSTER_JOB, startedBy: "worker", finishedAt: new Date(), outcome: "ok" });
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10", sourceQboId: "11", status: "invited" });
    await syncAppRecords();
    return ana;
  };

  it("is Admin only: a role with every grantable permission is refused, pages and actions alike", async () => {
    const other = await seedStaff({ email: "reg@club.org" });
    const [r] = await db.insert(role).values({ key: "all", name: "All" }).returning();
    await db.insert(roleRule).values({ roleId: r!.id, kind: "include", pattern: "*" });
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: other.id });
    who.staff = { door: "staff", staffUserId: other.id, name: other.name, email: other.email };
    expect((await thrown(ParentSettingsPage())).url).toBe("/refused");
    expect((await thrown(ParentSetupPage({ searchParams: Promise.resolve({}) }))).url).toBe("/refused");
    for (const call of [() => setSigninsAction(true), () => setWelcomeAction(true), () => setRequireStudentsAction(true), () => oweSetupMailsAction(),
      () => setLevelAction("strict", 0), () => setLevelAction("standard", null)]) {
      await expect(call()).rejects.toBeInstanceOf(AccessDenied);
    }
    expect(renderToStaticMarkup(await StaffLayout({ children: null }))).not.toContain('href="/staff/settings/parents"');
  });

  it("Parent sign-ins is a part of Settings for an Admin, under People and access, and not an entry of the staff menu beside Parents", async () => {
    const html = renderToStaticMarkup(await StaffLayout({ children: null }));
    expect(html).toContain('href="/staff/settings"');
    expect(html).not.toContain('href="/staff/settings/parents"');
    expect(SETTINGS_ITEMS.find((x) => x.key === "parents")).toMatchObject({ kind: "page", group: "People and access", title: "Parent sign-ins" });
  });

  it("the view shows what is set, plainly, with no inputs, and what switching on needs", async () => {
    await ready();
    const html = await view();
    expect(html).toContain("Off. Nobody can sign in, not even a guardian staff have added.");
    expect(html).toContain("Welcome emails");
    expect(html).toContain("Everything sign-ins need is ready: outgoing mail works.");
    expect(html).not.toMatch(/<textarea|<select|<input(?![^>]*type="hidden")/);   // React may add hidden fields to a form; nothing to type into
    expect(html).toContain('href="/staff/settings/parents/setup"');
    // The retired review and preview are gone from it.
    for (const gone of ["to review", "Emails to staff", "previous QuickBooks company", "/staff/settings/parents/matches"]) expect(html).not.toContain(gone);
  });

  it("asks only for working mail, with no QuickBooks connected, and says so on the view and the step", async () => {
    const html = await view();
    expect(html).toContain("Set up outgoing mail and send a test email first.");
    expect(html).not.toContain("QuickBooks first");
    expect(await setup("signins")).toContain("Set up outgoing mail and send a test email first.");
    expect(await setSigninsAction(true)).toEqual({ ok: false, errors: ["Set up outgoing mail and send a test email first."] });
    expect(await audits("settings.parents.save")).toEqual([]);
    await seedWorkingMail();
    expect(await setSigninsAction(true)).toEqual({ ok: true, message: "Parent sign-ins are on." });
  });

  it("has three steps, sign-ins, welcome emails and the sign-in level: the clean-up preview is gone", async () => {
    await ready();
    const html = await setup();
    expect(html).toContain("1. Parent sign-ins");
    expect(html).toContain("2. Welcome emails");
    expect(html).toContain("3. Sign-in level");
    expect(html).toContain('href="/staff/settings/parents/setup?step=level"');
    expect(await setup("level")).toContain("Step 3: Sign-in level");
    // Step 2 names step 3 first in its foot, as step 1 names step 2.
    expect(await setup("welcome")).toContain('<p class="box-foot"><a class="link-line" href="/staff/settings/parents/setup?step=level">Next: sign-in level</a>');
    expect(html).not.toContain("Clean-up preview");
    // An old link to the preview lands on the first step.
    expect(await setup("preview")).toContain("Step 1: Parent sign-ins");
    expect(await setup("signins")).toContain("Switching on lets 1 person sign in, to 1 family: the guardians the portal holds for each family.");
  });

  it("switching sign-ins on, then welcomes, through the actions", async () => {
    await ready();
    expect(await setSigninsAction(true)).toEqual({ ok: true, message: "Parent sign-ins are on." });
    expect(await view()).toContain("<dd>On</dd>");
    expect(await view()).toContain("1 person, to 1 family");
    expect((await audits("settings.parents.save"))[0]).toMatchObject({ actorId: admin.id, permission: "Settings.Parents.ReadWrite", ip: "203.0.113.40" });
    // QuickBooks' other parents were given nothing.
    expect(await db.select().from(guardian)).toHaveLength(1);
    const welcome = await setup("welcome");
    expect(welcome).toContain("1 person would be emailed now.");
    expect(welcome).toContain("You can now sign in to");
    // The sample's link is plainly a sample: no token's shape, and no link made, held or read for it.
    expect(welcome).toContain("/sign-in/set-up/(a link made for each person)");
    expect(welcome).not.toMatch(/\/sign-in\/set-up\/[A-Za-z0-9_-]{43}/);
    expect(welcome).toContain("It works once, for 7 days");
    expect(welcome).not.toContain("a code each time");
    expect(await db.select().from(parentSigninToken)).toEqual([]);
    expect(await setWelcomeAction(true)).toEqual({ ok: true, message: "Welcome emails are on. They go out a few each minute." });
    expect(await setSigninsAction(false)).toEqual({ ok: true, message: "Parent sign-ins are off. Every parent has been signed out, and welcome emails are off." });
    expect(await view()).toContain("Off: nobody can sign in");
  });

  it("each step says the state it is in after its button was pressed, since the button and its message are gone", async () => {
    await ready();
    const signins = await setup("signins");
    expect(signins).toContain("Switch parent sign-ins on");
    expect(signins).not.toContain("Switch parent sign-ins off");             // never on: nothing to switch off
    await setSigninsAction(true);
    const on = await setup("signins");
    expect(on).toContain("Parent sign-ins are on.");
    expect(on).toContain("Switch parent sign-ins off");
    expect(on).not.toContain(">Switch parent sign-ins on<");
    await setWelcomeAction(true);
    const welcomeOn = await setup("welcome");
    expect(welcomeOn).toContain("Welcome emails are on.");
    expect(welcomeOn).toContain("Switch welcome emails off");
    await setWelcomeAction(false);
    const welcomeOff = await setup("welcome");
    expect(welcomeOff).toContain("Welcome emails are off.");
    expect(welcomeOff).toContain("Switch welcome emails on");
    await setSigninsAction(false);
    const off = await setup("signins");
    expect(off).toContain("Parent sign-ins are off. Nobody can sign in.");
    expect(off).not.toContain("Switch parent sign-ins off");
    // Still said when something is missing before they can be switched on again.
    await db.delete(setting).where(eq(setting.key, "mail.status"));
    const noMail = await setup("signins");
    expect(noMail).toContain("Parent sign-ins are off. Nobody can sign in.");
    expect(noMail).toContain("Set up outgoing mail and send a test email first.");
  });

  it("switching sign-ins off switches welcomes off, so step 1's 'no email is sent' is true; and says so when they weren't on", async () => {
    await ready();
    expect(await setSigninsAction(false)).toEqual({ ok: true, message: "Parent sign-ins weren't on." });
    expect(await setWelcomeAction(true)).toEqual({ ok: false, errors: ["Switch parent sign-ins on first."] });
    await setSigninsAction(true);
    expect(await setup("signins")).toContain("Every parent is signed out at once and nobody can sign in until this is switched on again. Welcome emails are switched off too. Nothing is deleted.");
    await setWelcomeAction(true);
    await setSigninsAction(false);
    const off = await setup("signins");
    expect(off).toContain("No email is sent: welcome emails are step 2.");
    expect((await getParentSettings()).welcome).toBe(false);
    const welcome = await setup("welcome");
    expect(welcome).toContain("Switch parent sign-ins on first (step 1).");
    expect(welcome).not.toContain("Switch welcome emails on");
  });

  it("refuses arguments no page sends, and changes nothing", async () => {
    await ready();
    const loose = (f: unknown) => f as (...a: unknown[]) => Promise<unknown>;
    const refused = { ok: false, errors: [BROWSER] };
    for (const act of [setSigninsAction, setWelcomeAction, setRequireStudentsAction]) {
      for (const bad of ["true", 1, null, undefined, { valueOf: () => true }, [true]]) expect(await loose(act)(bad)).toEqual(refused);
    }
    // The level: exactly "standard" with null, or "strict" with a count the page could have shown.
    for (const [level, shown] of [["Strict", 1], ["STANDARD", null], ["relaxed", 0], [null, null], [undefined, undefined], [["strict"], 1], [{ valueOf: () => "strict" }, 1],
      ["strict", null], ["strict", undefined], ["strict", "1"], ["strict", 1.5], ["strict", -1], ["strict", 1_000_001], ["strict", Number.NaN], ["strict", Infinity],
      ["strict", { valueOf: () => 1 }], ["standard", 0], ["standard", undefined], ["standard", "null"], ["standard", false]] as [unknown, unknown][]) {
      expect(await loose(setLevelAction)(level, shown)).toEqual(refused);
    }
    expect(await getParentSettings()).toMatchObject({ signin: false, welcome: false, requireActiveStudents: false, level: "standard" });
    expect(await audits("settings.parents.save")).toEqual([]);
    expect(revalidated.count).toBe(0);
  });

  it("the active-students option is saved through its action, says what it would stop, and closes no row", async () => {
    await ready(); await setSigninsAction(true);
    // Leo is the Rivera family's active student: switching it on would stop nobody.
    expect(await view()).toContain("Switching this on would stop 0 people signing in, in 0 families with no active student");
    await db.update(student).set({ active: false });
    expect(await view()).toContain("Switching this on would stop 1 person signing in, in 1 family with no active student");
    const before = await db.select().from(guardian);
    expect(await setRequireStudentsAction(true)).toEqual({ ok: true, message: "Saved. Families with no active student can't sign in." });
    expect(await getParentSettings()).toMatchObject({ requireActiveStudents: true });
    expect(await db.select().from(guardian)).toEqual(before);
    expect(await view()).toContain("On: a family with no active student can&#x27;t sign in.");
  });

  it("the active-students option says it can't be used, and offers no button, while the shape names no students", async () => {
    await ready(); await setSigninsAction(true);
    await storeShape({ kind: "flat", memberTypeIds: ["F"] });
    const html = await view();
    expect(html).toContain("Off. The membership shape doesn&#x27;t say which customers are students, so this can&#x27;t be used.");
    expect(html).not.toContain("Require an active student");
    expect(await setRequireStudentsAction(true)).toEqual({ ok: false, errors: ["The membership shape doesn't say which customers are students, so this can't be used."] });
  });

  // An installation may hold it on beside such a shape from before stage 3's slice 7a: the page says it is not in use,
  // counts everyone who can sign in as the gate does (it lets them in), and offers switching it off.
  it("says the active-students option is on but not in use while the shape names no students, and counts as the gate does", async () => {
    await ready(); await setSigninsAction(true);
    await db.update(student).set({ active: false });
    const html = (await view()).replaceAll("&#x27;", "'");
    const canSignIn = /<dt>Who can sign in<\/dt><dd>([^<]*)<\/dd>/.exec(html)![1];
    await setRequireStudentsAction(true);
    await storeShape({ kind: "flat", memberTypeIds: ["F"] });
    const stale = (await view()).replaceAll("&#x27;", "'");
    expect(stale).toContain("On, but not in use: the membership shape doesn't say which customers are students, so students don't affect who can sign in.");
    expect(stale).not.toContain("On: a family with no active student can't sign in.");
    expect(/<dt>Who can sign in<\/dt><dd>([^<]*)<\/dd>/.exec(stale)![1]).toBe(canSignIn);
    expect(stale).toContain("Let those families sign in");
    expect(await getParentSettings()).toMatchObject({ requireActiveStudents: true });
  });

  it("says that sign-ins an earlier version ended for no active student stay ended", async () => {
    await ready();
    expect(await view()).not.toContain("an earlier version of the portal ended for this");
    const leo = await seedParent({ name: "Leo Closed", email: "leo.closed@example.com" });
    await seedGuardian({ parentId: leo.id, familyQboId: "10", sourceQboId: "11", status: "disabled", disabledReason: "no_active_students" });
    expect(await view()).toContain("1 sign-in an earlier version of the portal ended for this stays ended, whatever this is set to and whatever students the family has.");
  });

  it("the QuickBooks page warns before a disconnect when parents can sign in", async () => {
    await ready();
    const warning = "1 person can sign in to the portal now. Reconnecting this same QuickBooks company after a disconnect keeps everything as it is for them. Connecting a different company ends every family&#x27;s link to the books, until each is linked again.";
    expect(renderToStaticMarkup(await QuickBooksSettingsPage())).not.toContain("can sign in to the portal now");
    await setSigninsAction(true);
    const html = renderToStaticMarkup(await QuickBooksSettingsPage());
    expect(html).toContain(warning);
    expect(html.indexOf(warning)).toBeGreaterThan(html.indexOf("<summary>Disconnect</summary>"));
    expect(html.indexOf(warning)).toBeLessThan(html.indexOf("Disconnect QuickBooks</button>"));
    await db.delete(qboConnection);
    expect(renderToStaticMarkup(await QuickBooksSettingsPage())).not.toContain("can sign in to the portal now");   // nothing to disconnect
  });

  // The press for people welcomed before parents signed in with a password (the sign-in release, slice SI-4).
  it("offers to email a set-up link only while sign-ins and welcome emails are on and someone has no password, and answers how many", async () => {
    const ana = await ready();
    const section = 'id="ps-setup-h"';
    expect(await view()).not.toContain(section); // sign-ins off
    await setSigninsAction(true);
    expect(await view()).not.toContain(section); // welcome emails off
    await setWelcomeAction(true);
    // Ana was never welcomed, so switching welcomes on owed her the welcome already: nobody is left to ask for.
    expect(await view()).not.toContain(section);
    expect(await oweSetupMailsAction()).toEqual({ ok: true, message: "Nobody needs one now: everyone who can sign in has a password, has a link to choose one that still works, or is already waiting for theirs to be sent." });
    // Welcomed before this release, with no password: one to email.
    await db.update(parent).set({ welcomedAt: new Date("2026-01-01T00:00:00Z"), welcomeOwed: false }).where(eq(parent.id, ana.id));
    const html = (await view()).replaceAll("&#x27;", "'");
    expect(html).toContain(section);
    expect(html).toContain("1 person can sign in and hasn't chosen a password, with no link to choose one that still works");
    expect(html).toContain("Email a set-up link to everyone who can sign in and hasn't chosen a password (1)");
    // Beside the button, the mail it sends, as the worker writes it, with the welcome's sample link: no token's shape.
    expect(html).toContain("Choose your password for ");
    expect(html).toContain("with this email address and a password. To choose your password, open this link:");
    expect(html).toContain("/sign-in/set-up/(a link made for each person)");
    expect(html).not.toMatch(/\/sign-in\/set-up\/[A-Za-z0-9_-]{43}/);
    expect(await db.select().from(parentSigninToken)).toEqual([]);
    revalidated.count = 0;
    expect(await oweSetupMailsAction()).toEqual({ ok: true, message: "1 person is queued for a link to choose a password. They go out a few each minute." });
    expect(revalidated.count).toBe(1);
    expect((await audits("parent.setup_mail.owed")).at(-1)).toMatchObject({ actorId: admin.id, permission: "Settings.Parents.ReadWrite", ip: "203.0.113.40", after: { owed: 1 } });
    expect(await view()).not.toContain(section); // owed now
    // With a password, nobody is left to email.
    await db.update(parent).set({ welcomeOwed: false }).where(eq(parent.id, ana.id));
    await seedPassword(ana.authUserId, "a phrase Ana chose some time ago");
    expect(await view()).not.toContain(section);
    // Refused in words while a switch is off.
    await setWelcomeAction(false);
    expect(await oweSetupMailsAction()).toEqual({ ok: false, errors: ["Switch parent sign-ins and welcome emails on first."] });
  });

  describe("the sign-in level (slice SI-10b)", () => {
    const decoded = (html: string) => html.replaceAll("&#x27;", "'");
    /** Step 3's box, from its heading to the end of its section. */
    const stepThree = async () => {
      const html = decoded(await setup("level"));
      const at = html.indexOf('id="pl-h"');
      expect(at).toBeGreaterThan(-1);
      return html.slice(at, html.indexOf("</section>", at));
    };
    /** Sam, a second guardian who can sign in, in the Chen family. */
    const seedSam = async () => {
      const sam = await seedParent({ name: "Shared Sam", email: "sam@example.com" });
      await seedGuardian({ parentId: sam.id, familyQboId: "20", sourceQboId: "21", status: "invited" });
      await syncAppRecords();
      return sam;
    };

    it("says the level under What is set, in words, with Strict's lede and Strict's words beside the press", async () => {
      const ana = await ready();
      const standard = decoded(await view());
      expect(standard).toContain("<dt>Sign-in level</dt><dd>Standard: a password, and on a phone or computer the portal doesn't know yet, a code we email, or the guardian's own passkey or authenticator app</dd>");
      expect(standard).toContain("on a phone or computer the portal doesn't know yet, it emails them a code too.");
      await seedParentSettings({ level: "strict" });
      const strict = decoded(await view());
      expect(strict).toContain("<dt>Sign-in level</dt><dd>Strict: a password and a passkey or an authenticator app, every time. An emailed code never signs anyone in.</dd>");
      expect(strict).toContain("Parents sign in to the portal with their email address and a password, which they choose from a link the portal emails them, and then a passkey or an authenticator app, every time. Who can sign in is the portal's own list of each family's guardians: a change made in QuickBooks no longer gives anyone a sign-in or ends one. Only Admins can change this.");
      expect(strict).not.toContain("it emails them a code too");
      // Step 2's sample of the welcome is Strict's too (sampleWelcome() carries the level).
      const welcome = decoded(await setup("welcome"));
      expect(welcome).toContain("Once you've chosen your password, the portal asks you to add a passkey or an authenticator app, which you'll use each time you sign in.");
      expect(welcome).not.toContain("After that, you sign in with this email address and the password you chose.");
      // "Passwords not chosen yet" at Strict: what choosing a password leads to, not that a session stays.
      await seedParentSettings({ signin: true, welcome: true });
      await db.update(parent).set({ welcomedAt: new Date("2026-01-01T00:00:00Z"), welcomeOwed: false }).where(eq(parent.id, ana.id));
      const owed = decoded(await view());
      expect(owed).toContain("anyone welcomed before gets the email below. Once they've chosen a password, the portal asks them to add a passkey or an authenticator app before they see anything else. They go out a few each minute.");
      expect(owed).not.toContain("A phone or computer they are signed in on now stays signed in.");
      await seedParentSettings({ level: "standard" });
      expect(decoded(await view())).toContain("anyone welcomed before gets the email below. A phone or computer they are signed in on now stays signed in. They go out a few each minute.");
      // A stored value that can't be read, naming no level.
      await db.update(setting).set({ value: { signin: true, level: "relaxed" } }).where(eq(setting.key, PARENTS_KEY));
      const unknown = decoded(await view());
      expect(unknown).toContain("<dt>Sign-in level</dt><dd>Not known: the saved sign-in settings can't be read. Choose Standard or Strict under Change, step 3.</dd>");
      // The press those words name is drawn by that name, though the value read is the closed state (sign-ins off).
      expect(unknown).toContain(`<a class="btn" href="/staff/settings/parents/setup">Change</a>`);
      expect(unknown).not.toContain(">Set up</a>");
    });

    /** The presses a page draws (SwitchButton's `label` and `act`), found in the element tree it returns, not its markup. */
    type Press = { label: string; act: () => Promise<unknown> };
    const presses = (node: unknown): Press[] => {
      if (Array.isArray(node)) return node.flatMap(presses);
      if (!node || typeof node !== "object" || !("props" in node)) return [];
      const p = (node as { props: Record<string, unknown> }).props;
      const own = typeof p.act === "function" && typeof p.label === "string" ? [{ label: p.label, act: p.act as Press["act"] }] : [];
      return [...own, ...presses(p.children)];
    };
    /** Step 3 as drawn: its markup, decoded, and its presses. */
    const drawn = async () => {
      const page = await ParentSetupPage({ searchParams: Promise.resolve({ step: "level" }) });
      return { html: decoded(renderToStaticMarkup(page)), presses: presses(page) };
    };

    it("step 3 at Standard shows the counts, and the confirm for 1, for 2 or more and for 0 guardians with neither", async () => {
      const ana = await ready();
      // ready() leaves parent sign-ins off, whose words are the next test's (slice SI-11): these are the words with them on.
      await setSigninsAction(true);
      let html = await stepThree();
      expect(html).toContain("The club is at Standard: a password, and on a phone or computer the portal doesn't know yet, a code we email, or the guardian's own passkey or authenticator app.");
      expect(html).toContain("<dt>Can sign in</dt><dd>1 person</dd><dt>Have a passkey</dt><dd>0</dd><dt>Have an authenticator app</dt><dd>0</dd><dt>Have neither</dt><dd>1</dd>");
      expect(html).toContain("Strict asks every guardian for a passkey or an authenticator app each time they sign in, and an emailed code never signs anyone in. Switch once most guardians have one.");
      expect(html).toContain("<summary>Switch to Strict</summary>");
      expect(html).toContain("Switching to Strict signs out the 1 guardian who has neither a passkey nor an authenticator app. The next time they sign in, their password takes them to add one before they see their family's page. If they've forgotten their password, they'll need you to reset their sign-in from their page on Parents.");
      expect(html).toContain(">Switch to Strict</button>");
      expect(html).not.toContain("Switch back to Standard");
      const sam = await seedSam();
      html = await stepThree();
      expect(html).toContain("<dt>Can sign in</dt><dd>2 people</dd>");
      expect(html).toContain("Switching to Strict signs out the 2 guardians who have neither a passkey nor an authenticator app. The next time they sign in, their password takes them to add one before they see their family's page. Anyone who has forgotten their password will need you to reset their sign-in from their page on Parents.");
      await seedPasskey(ana.id); await seedAuthenticator(ana.id); await seedAuthenticator(sam.id);
      html = await stepThree();
      expect(html).toContain("<dt>Can sign in</dt><dd>2 people</dd><dt>Have a passkey</dt><dd>1</dd><dt>Have an authenticator app</dt><dd>2</dd><dt>Have neither</dt><dd>0</dd>");
      expect(html).toContain("Switching to Strict signs nobody out: every guardian who can sign in has a passkey or an authenticator app.");
      expect(html).toContain('<a class="link-line" href="/staff/settings/parents">Back to Parent sign-ins</a>');
    });

    it("step 3 with parent sign-ins off counts who could sign in once they are on, and its confirm signs nobody out, for 0, 1 and 2 with neither", async () => {
      const ana = await ready();
      expect((await getParentSettings()).signin).toBe(false);
      const off = "Parent sign-ins are off, so switching to Strict signs nobody out. Once they are on, a guardian with neither a passkey nor an authenticator app adds one after their password, before they see their family's page.";
      let html = await stepThree();
      expect(html).toContain("<dt>Could sign in once sign-ins are on</dt><dd>1 person</dd><dt>Have a passkey</dt><dd>0</dd><dt>Have an authenticator app</dt><dd>0</dd><dt>Have neither</dt><dd>1</dd>");
      expect(html).not.toContain("<dt>Can sign in</dt>");
      expect(html).toContain(off);
      expect(html).not.toContain("Switching to Strict signs out");
      const sam = await seedSam();
      html = await stepThree();
      expect(html).toContain("<dt>Could sign in once sign-ins are on</dt><dd>2 people</dd>");
      expect(html).toContain(off);
      expect(html).not.toContain("Switching to Strict signs out");
      await seedPasskey(ana.id); await seedAuthenticator(sam.id);
      html = await stepThree();
      expect(html).toContain("<dt>Could sign in once sign-ins are on</dt><dd>2 people</dd><dt>Have a passkey</dt><dd>1</dd><dt>Have an authenticator app</dt><dd>1</dd><dt>Have neither</dt><dd>0</dd>");
      expect(html).toContain("Parent sign-ins are off, so switching to Strict signs nobody out. Every guardian who could sign in once they are on has a passkey or an authenticator app.");
      expect(html).not.toContain("Switching to Strict signs nobody out:");
      // Switched on, every word is as it was.
      await setSigninsAction(true);
      html = await stepThree();
      expect(html).toContain("<dt>Can sign in</dt><dd>2 people</dd>");
      expect(html).toContain("Switching to Strict signs nobody out: every guardian who can sign in has a passkey or an authenticator app.");
      expect(html).not.toContain("Parent sign-ins are off");
    });

    it("the page's own Switch to Strict with parent sign-ins off answers that nobody was signed out, its audit row's after as with them on", async () => {
      await ready();
      await seedSam();
      const page = await drawn();
      expect(page.html).toContain("<dt>Have neither</dt><dd>2</dd>");
      const toStrict = page.presses.find((p) => p.label === "Switch to Strict");
      expect(toStrict).toBeDefined();
      expect(await toStrict!.act()).toEqual({ ok: true, message: "The club is at Strict. Parent sign-ins are off, so nobody was signed out." });
      expect((await getParentSettings()).level).toBe("strict");
      const row = (await audits("settings.parents.save")).find((r) => (r.after as { level?: unknown } | null)?.level === "strict")!;
      expect(row).toBeDefined();
      expect(row).toMatchObject({ actorId: admin.id, permission: "Settings.Parents.ReadWrite",
        after: { signin: false, level: "strict", signedOut: 0, sessionsEnded: 0, counts: { people: 2, passkey: 0, app: 0, neither: 2 } } });
      expect(Object.keys(row.after as Record<string, unknown>).sort()).toEqual(["counts", "level", "proofsCleared", "requireActiveStudents", "sessionsEnded", "signedOut", "signin", "welcome"]);
    });

    it("step 3 at Strict offers only switching back, and with the level unknown says so and offers both", async () => {
      await ready();
      await seedParentSettings({ level: "strict" });
      let html = await stepThree();
      expect(html).toContain("The club is at Strict: a password and a passkey or an authenticator app, every time. An emailed code never signs anyone in.");
      expect(html).toContain("<dt>Have neither</dt><dd>1</dd>");
      expect(html).toContain("<summary>Switch back to Standard</summary>");
      expect(html).toContain("Switching back to Standard lets guardians with no passkey or app sign in with their password and a code we email again. Nobody is signed out, and every passkey and app stays.");
      expect(html).toContain(">Switch back to Standard</button>");
      expect(html).not.toContain("Switch to Strict");
      expect(html).not.toContain("Switch once most guardians have one.");
      await db.update(setting).set({ value: { signin: true, level: "relaxed" } }).where(eq(setting.key, PARENTS_KEY));
      html = await stepThree();
      expect(html).toContain(decoded(LEVEL_UNREADABLE));
      expect(html).toContain("<dt>Have neither</dt><dd>1</dd>");
      expect(html).toContain("<summary>Switch to Strict</summary>");
      expect(html).toContain("<summary>Switch back to Standard</summary>");
      expect(html).not.toContain("The club is at");
    });

    it("switches through the action with each of its answers, and refuses a count that is stale", async () => {
      const ana = await ready();
      const sam = await seedSam();
      await setSigninsAction(true);
      revalidated.count = 0;
      expect(await setLevelAction("strict", 1)).toEqual({ ok: false, errors: [LEVEL_COUNT_CHANGED] });
      expect(revalidated.count).toBe(0);
      expect((await getParentSettings()).level).toBe("standard");
      // Ana and Sam each have a session, and neither a passkey nor an app: both are signed out.
      await seedParentSession(ana.authUserId); await seedParentSession(sam.authUserId);
      expect(await setLevelAction("strict", 2)).toEqual({ ok: true, message: "The club is at Strict. 2 guardians with neither a passkey nor an authenticator app were signed out." });
      expect(revalidated.count).toBe(1);
      expect((await audits("settings.parents.save")).at(-1)).toMatchObject({ actorId: admin.id, permission: "Settings.Parents.ReadWrite", ip: "203.0.113.40",
        after: { level: "strict", signedOut: 2, sessionsEnded: 2, counts: { people: 2, passkey: 0, app: 0, neither: 2 } } });
      expect(await setLevelAction("standard", null)).toEqual({ ok: true, message: "The club is at Standard. Nobody was signed out." });
      await seedParentSession(ana.authUserId);
      expect(await setLevelAction("strict", 2)).toEqual({ ok: true, message: "The club is at Strict. 1 guardian with neither a passkey nor an authenticator app was signed out." });
      await setLevelAction("standard", null);
      expect(await setLevelAction("strict", 2)).toEqual({ ok: true, message: "The club is at Strict. Nobody needed signing out." });
      expect((await getParentSettings()).level).toBe("strict");
    });

    it("binds the press to the count the step shows: the page's own Switch to Strict works, and so does its Switch back", async () => {
      const ana = await ready();
      const sam = await seedSam();
      await setSigninsAction(true);
      await seedParentSession(ana.authUserId); await seedParentSession(sam.authUserId);
      let page = await drawn();
      expect(page.html).toContain("<dt>Have neither</dt><dd>2</dd>");
      expect(page.html).toContain("Switching to Strict signs out the 2 guardians who have neither");
      const toStrict = page.presses.find((p) => p.label === "Switch to Strict");
      expect(toStrict).toBeDefined();
      expect(await toStrict!.act()).toEqual({ ok: true, message: "The club is at Strict. 2 guardians with neither a passkey nor an authenticator app were signed out." });
      expect((await getParentSettings()).level).toBe("strict");
      page = await drawn();
      expect(page.presses.map((p) => p.label)).toEqual(["Switch back to Standard"]);
      expect(await page.presses[0]!.act()).toEqual({ ok: true, message: "The club is at Standard. Nobody was signed out." });
      expect((await getParentSettings()).level).toBe("standard");
    });
  });

  describe("passkeys from an earlier address (slice SI-9b)", () => {
    const OLD_ORIGIN = "https://old.example.org";
    const decoded = (html: string) => html.replaceAll("&#x27;", "'");
    type Press = { label: string; act: () => Promise<unknown> };
    const presses = (node: unknown): Press[] => {
      if (Array.isArray(node)) return node.flatMap(presses);
      if (!node || typeof node !== "object" || !("props" in node)) return [];
      const p = (node as { props: Record<string, unknown> }).props;
      const own = typeof p.act === "function" && typeof p.label === "string" ? [{ label: p.label, act: p.act as Press["act"] }] : [];
      return [...own, ...presses(p.children)];
    };
    /** The view as drawn: its markup, decoded, the section's markup alone (from its heading to its end), and its presses. */
    const drawn = async () => {
      const page = await ParentSettingsPage();
      const html = decoded(renderToStaticMarkup(page));
      const at = html.indexOf(`<h2 id="ps-old-passkeys-h">`);
      return { html, section: at < 0 ? null : html.slice(at, html.indexOf("</section>", at)), presses: presses(page) };
    };
    /** A person with a sign-in account and nothing else. */
    const person = (name: string) => seedParent({ name, email: `${name.toLowerCase()}@example.com` });

    it("is drawn only while a passkey is from an earlier address, after What is set", async () => {
      const ana = await ready();
      await seedPasskey(ana.id);
      expect((await drawn()).section).toBeNull();
      await seedPasskey(ana.id, { origin: OLD_ORIGIN });
      const { html, section } = await drawn();
      expect(section).not.toBeNull();
      expect(html.indexOf("ps-status-h")).toBeLessThan(html.indexOf("ps-old-passkeys-h"));
    });

    it("sits before Passwords not chosen yet when both are drawn", async () => {
      const ana = await ready();
      await seedParentSettings({ signin: true, welcome: true });
      await db.update(parent).set({ welcomedAt: new Date("2026-01-01T00:00:00Z"), welcomeOwed: false }).where(eq(parent.id, ana.id));
      await seedPasskey(ana.id, { origin: OLD_ORIGIN });
      const { html } = await drawn();
      expect(html.indexOf("ps-old-passkeys-h")).toBeGreaterThan(html.indexOf("ps-status-h"));
      expect(html.indexOf(`<h2 id="ps-setup-h">`)).toBeGreaterThan(html.indexOf("ps-old-passkeys-h"));
    });

    it("counts a blocked holder left with nothing among nobody, and says only what the press does to them", async () => {
      await ready();
      // Cal, blocked, holds one passkey from the old address and nothing else: the press takes it and keeps the rest of
      // his (his codes; a block already ended his sessions), so nobody is left to warn about.
      const cal = await person("Cal");
      await seedPasskey(cal.id, { origin: OLD_ORIGIN });
      await db.update(parent).set({ blocked: true }).where(eq(parent.id, cal.id));
      const { section } = await drawn();
      expect(section).toContain(OLD.lede(ORIGIN, 1, 1));
      expect(section).toContain("Everyone with one of these passkeys who isn't blocked has an authenticator app or another passkey, so nobody is signed out and no backup codes go.");
    });

    it("is drawn only for a holder of the reset's permission, and its action refuses anyone else", async () => {
      const ana = await ready();
      await seedPasskey(ana.id, { origin: OLD_ORIGIN });
      narrow.withoutReset = true;
      const { html, section, presses: drawnPresses } = await drawn();
      expect(html).toContain(`<h1 class="page-title">Parent sign-ins</h1>`);
      expect(section).toBeNull();
      expect(html).not.toContain(OLD.heading);
      expect(drawnPresses.map((p) => p.label)).not.toContain(OLD.button(1));
      await expect(removeOldAddressPasskeysAction(1)).rejects.toBeInstanceOf(AccessDenied);
      expect(await passkeyRows(ana.id)).toHaveLength(1);
    });

    it("says each word, at both levels, for 0, 1 and 2 people left with no passkey and no app", async () => {
      await ready();
      const expectAt = async (passkeys: number, people: number, left: number, list: string) => {
        for (const strict of [false, true]) {
          await seedParentSettings({ level: strict ? "strict" : "standard" });
          const { section } = await drawn();
          expect(section).toContain(`<h2 id="ps-old-passkeys-h">Passkeys from an earlier address</h2>`);
          expect(section).toContain(`<p>${OLD.lede(ORIGIN, passkeys, people)}</p>`);
          expect(section).toContain(`<dl class="details">${list}</dl>`);
          expect(section).toContain(OLD.warning(strict, left));
          expect(section).toContain(`<p>Make sure ${ORIGIN} is the address families use now: passkeys made there are kept.</p>`);
          expect(section).toContain(`>${OLD.button(passkeys)}</button>`);
        }
      };
      // Ben: one passkey from the old address, beside an app: nobody left with neither yet.
      const ben = await person("Ben");
      await seedPasskey(ben.id, { origin: OLD_ORIGIN }); await seedAuthenticator(ben.id);
      await expectAt(1, 1, 0, `<dt>${OLD_ORIGIN}</dt><dd>1 passkey</dd>`);
      expect(OLD.lede(ORIGIN, 1, 1)).toBe(`A passkey works only at the address it was made at. The portal's address is now ${ORIGIN}. 1 passkey of 1 person was made at another address, so it no longer works, but the portal still asks that person for it.`);
      expect(OLD.warning(false, 0)).toBe("Everyone with one of these passkeys who isn't blocked has an authenticator app or another passkey, so nobody is signed out and no backup codes go.");
      expect(OLD.warning(true, 0)).toBe(OLD.warning(false, 0));
      expect(OLD.button(1)).toBe("Remove 1 passkey made at an earlier address");
      // Cal: one the portal never recorded, and nothing else.
      const cal = await person("Cal");
      await seedPasskey(cal.id, { origin: null });
      await expectAt(2, 2, 1, `<dt>${OLD_ORIGIN}</dt><dd>1 passkey</dd><dt>An address the portal didn't record</dt><dd>1 passkey</dd>`);
      expect(OLD.lede(ORIGIN, 2, 2)).toBe(`A passkey works only at the address it was made at. The portal's address is now ${ORIGIN}. 2 passkeys of 2 people were made at another address, so they no longer work, but the portal still asks those people for them.`);
      expect(OLD.warning(false, 1)).toBe("Removing them signs nobody out. 1 person has no authenticator app and no other passkey: their backup codes go too, and on a phone or computer the portal doesn't know yet they'll get an emailed code until they add a passkey again.");
      expect(OLD.warning(true, 1)).toBe("1 person has no authenticator app and no other passkey: their backup codes go too, they are signed out, and after their password they add a passkey or an authenticator app before they see their family's page.");
      // Dee: two from the old address, and nothing else.
      const dee = await person("Dee");
      await seedPasskey(dee.id, { origin: OLD_ORIGIN }); await seedPasskey(dee.id, { origin: OLD_ORIGIN });
      await expectAt(4, 3, 2, `<dt>${OLD_ORIGIN}</dt><dd>3 passkeys</dd><dt>An address the portal didn't record</dt><dd>1 passkey</dd>`);
      expect(OLD.warning(false, 2)).toBe("Removing them signs nobody out. 2 people have no authenticator app and no other passkey: their backup codes go too, and on a phone or computer the portal doesn't know yet they'll get an emailed code until they add a passkey again.");
      expect(OLD.warning(true, 2)).toBe("2 people have no authenticator app and no other passkey: their backup codes go too, they are signed out, and after their password they add a passkey or an authenticator app before they see their family's page.");
      expect(OLD.button(4)).toBe("Remove 4 passkeys made at an earlier address");
      expect(OLD.pending).toBe("Removing…");
    });

    it("the page's own press removes them and answers in words; a stale count, none left and anything else are refused", async () => {
      await ready();
      const cal = await person("Cal");
      const dee = await person("Dee");
      await seedPasskey(cal.id, { origin: null });
      await seedPasskey(dee.id, { origin: OLD_ORIGIN }); await seedPasskey(dee.id, { origin: OLD_ORIGIN });
      for (const bad of [0, -1, 1.5, 1_000_001, Number.NaN, "3", null, undefined, [3]]) {
        expect(await removeOldAddressPasskeysAction(bad as number)).toEqual({ ok: false, errors: [BROWSER] });
      }
      expect(await removeOldAddressPasskeysAction(2)).toEqual({ ok: false, errors: [OLD_PASSKEYS_CHANGED] });
      expect(OLD_PASSKEYS_CHANGED).toBe("The number of passkeys made at an earlier address changed while this page was open. Look at the new number and press again.");
      expect(await passkeyRows(dee.id)).toHaveLength(2);
      const press = (await drawn()).presses.find((p) => p.label === OLD.button(3));
      expect(press).toBeDefined();
      revalidated.count = 0;
      expect(await press!.act()).toEqual({ ok: true, message: "Removed 3 passkeys made at an earlier address, from 2 people." });
      expect(revalidated.count).toBe(1);
      expect(await passkeyRows(cal.id)).toEqual([]);
      expect(await passkeyRows(dee.id)).toEqual([]);
      expect((await audits("parent.passkeys.old_address_removed")).at(-1)).toMatchObject({ actorId: admin.id, permission: "Parents.SignInReset.ReadWrite", ip: "203.0.113.40",
        targetType: "setting", targetId: PARENTS_KEY });
      expect((await drawn()).section).toBeNull();
      expect(await press!.act()).toEqual({ ok: false, errors: ["There are no passkeys from an earlier address now."] });
    });

    it("at Strict says how many were signed out, one or more", async () => {
      await ready();
      await seedParentSettings({ level: "strict" });
      const cal = await person("Cal");
      const dee = await person("Dee");
      await seedPasskey(cal.id, { origin: OLD_ORIGIN }); await seedParentSession(cal.authUserId);
      expect(await removeOldAddressPasskeysAction(1)).toEqual({ ok: true, message: "Removed 1 passkey made at an earlier address, from 1 person. 1 person was signed out." });
      await seedPasskey(cal.id, { origin: OLD_ORIGIN }); await seedParentSession(cal.authUserId);
      await seedPasskey(dee.id, { origin: OLD_ORIGIN }); await seedParentSession(dee.authUserId);
      await seedPasskey(dee.id, { origin: OLD_ORIGIN });
      expect(await removeOldAddressPasskeysAction(3)).toEqual({ ok: true, message: "Removed 3 passkeys made at an earlier address, from 2 people. 2 people were signed out." });
      // Beside an app nobody is signed out, and the answer says nothing of it.
      await seedPasskey(cal.id, { origin: OLD_ORIGIN }); await seedAuthenticator(cal.id); await seedParentSession(cal.authUserId);
      expect(await removeOldAddressPasskeysAction(1)).toEqual({ ok: true, message: "Removed 1 passkey made at an earlier address, from 1 person." });
    });
  });
});
