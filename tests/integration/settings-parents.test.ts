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
import { getParentSettings } from "@/lib/parents/settings";
import { ROSTER_JOB, setRosterSource } from "@/lib/roster/source";
import ParentSettingsPage from "@/app/staff/(app)/settings/parents/page";
import ParentSetupPage from "@/app/staff/(app)/settings/parents/setup/page";
import QuickBooksSettingsPage from "@/app/staff/(app)/settings/quickbooks/page";
import StaffLayout from "@/app/staff/(app)/layout";
import { SETTINGS_SECTIONS } from "@/app/staff/(app)/settings/sections";
import { oweSetupMailsAction, setSigninsAction, setWelcomeAction, setRequireStudentsAction } from "@/app/staff/(app)/settings/parents/actions";
import { resetDb, seedGuardian, seedParent, seedStaff, seedWorkingMail } from "../helpers/db";
import { seedCache, seedShape, storeShape, fam, par, stu } from "../helpers/roster-cache";
import { startQboStub, seedConnected, type QboStub } from "../helpers/qbo-stub";
import { syncAppRecords } from "../helpers/app-records";
import { seedPassword } from "../helpers/signin-links";

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
    for (const call of [() => setSigninsAction(true), () => setWelcomeAction(true), () => setRequireStudentsAction(true), () => oweSetupMailsAction()]) {
      await expect(call()).rejects.toBeInstanceOf(AccessDenied);
    }
    expect(renderToStaticMarkup(await StaffLayout({ children: null }))).not.toContain('href="/staff/settings/parents"');
  });

  it("Parent sign-ins is a part of Settings for an Admin, after QuickBooks, and not an entry of the staff menu beside Parents", async () => {
    const html = renderToStaticMarkup(await StaffLayout({ children: null }));
    expect(html).toContain('href="/staff/settings"');
    expect(html).not.toContain('href="/staff/settings/parents"');
    const keys = SETTINGS_SECTIONS.map((x) => x.key);
    expect(keys.indexOf("parents")).toBe(keys.indexOf("quickbooks") + 1);
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

  it("has two steps, sign-ins and welcome emails: the clean-up preview is gone", async () => {
    await ready();
    const html = await setup();
    expect(html).toContain("1. Parent sign-ins");
    expect(html).toContain("2. Welcome emails");
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
    expect(await getParentSettings()).toMatchObject({ signin: false, welcome: false, requireActiveStudents: false });
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
    const warning = "1 person can sign in to the portal now. Until families can be linked to another company&#x27;s customers, only this same QuickBooks company can be connected again";
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
    expect(await oweSetupMailsAction()).toEqual({ ok: true, message: "Nobody needs one now: everyone who can sign in has a password, or was sent a link a moment ago." });
    // Welcomed before this release, with no password: one to email.
    await db.update(parent).set({ welcomedAt: new Date("2026-01-01T00:00:00Z"), welcomeOwed: false }).where(eq(parent.id, ana.id));
    const html = (await view()).replaceAll("&#x27;", "'");
    expect(html).toContain(section);
    expect(html).toContain("1 person can sign in and hasn't chosen a password.");
    expect(html).toContain("Email a set-up link to everyone who can sign in and hasn't chosen a password (1)");
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
});
