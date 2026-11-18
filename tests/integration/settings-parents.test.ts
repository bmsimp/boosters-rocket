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
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, familyMatch, heldAddress, jobRun, qboConnection, qboCustomer, qboCustomerType, role, roleAssignment, roleRule, setting } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import * as reconcileModule from "@/lib/parents/reconcile";
import { runReconcile } from "../helpers/reconcile";
import { getParentSettings } from "@/lib/parents/settings";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { clearRosterOfOtherCompany, ROSTER_JOB, setRosterSource } from "@/lib/roster/source";
import ParentSettingsPage from "@/app/staff/(app)/settings/parents/page";
import ParentSetupPage from "@/app/staff/(app)/settings/parents/setup/page";
import MatchesPage from "@/app/staff/(app)/settings/parents/matches/page";
import QuickBooksSettingsPage from "@/app/staff/(app)/settings/quickbooks/page";
import StaffLayout from "@/app/staff/(app)/layout";
import { SETTINGS_SECTIONS } from "@/app/staff/(app)/settings/sections";
import { setSigninsAction, setWelcomeAction, setRequireStudentsAction, setReviewEmailsAction, decideMatchAction, acceptStrongMatchesAction, deletePreviousCompanyAction } from "@/app/staff/(app)/settings/parents/actions";
import { resetDb, seedGuardian, seedParent, seedStaff, seedWorkingMail } from "../helpers/db";
import { seedCache, seedShape, fam, par, stu } from "../helpers/roster-cache";
import { startQboStub, seedConnected, type QboStub } from "../helpers/qbo-stub";

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
  const ready = async () => {
    await seedConnected(stub); await seedShape(); await seedCache(ROSTER); await seedWorkingMail();
    await db.transaction((tx) => setRosterSource(tx, "9130000000000001"));
    await db.insert(jobRun).values({ job: ROSTER_JOB, startedBy: "worker", finishedAt: new Date(), outcome: "ok" });
  };

  it("is Admin only: a role with every grantable permission is refused, pages and actions alike", async () => {
    const other = await seedStaff({ email: "reg@club.org" });
    const [r] = await db.insert(role).values({ key: "all", name: "All" }).returning();
    await db.insert(roleRule).values({ roleId: r!.id, kind: "include", pattern: "*" });
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: other.id });
    who.staff = { door: "staff", staffUserId: other.id, name: other.name, email: other.email };
    expect((await thrown(ParentSettingsPage())).url).toBe("/refused");
    expect((await thrown(ParentSetupPage({ searchParams: Promise.resolve({}) }))).url).toBe("/refused");
    expect((await thrown(MatchesPage())).url).toBe("/refused");
    for (const call of [() => setSigninsAction(true), () => setWelcomeAction(true), () => setRequireStudentsAction(true), () => setReviewEmailsAction(false),
      () => decideMatchAction("12", "87"), () => acceptStrongMatchesAction(), () => deletePreviousCompanyAction()]) {
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

  it("the view shows what is set, plainly, with no inputs", async () => {
    await ready();
    const html = await view();
    expect(html).toContain("Not switched on yet");
    expect(html).toContain("Welcome emails");
    expect(html).not.toMatch(/<textarea|<select|<input(?![^>]*type="hidden")/);   // React may add hidden fields to a form; nothing to type into
    expect(html).toContain('href="/staff/settings/parents/setup"');
  });

  it("step 1 previews the numbers and what needs fixing, and says what is missing before anything can be switched on", async () => {
    expect(await setup()).toContain("Connect QuickBooks first.");
    await ready();
    const html = await setup("preview");
    expect(html).toContain("1 person would be able to sign in, to 1 family.");
    expect(html).toContain("sam@example.com");
    expect(html).toContain("No Mail");
    expect(html).toContain("Chen Family");
    expect(await audits("settings.parents.save")).toEqual([]);
  });

  it("step 1 lists each problem as a table, folds a long one behind Show all, and says None for an empty one", async () => {
    await ready();
    const many = Array.from({ length: 11 }, (_, i) => par(`5${i}`, `Quiet Parent ${i}`, "10", null));
    await seedCache([...ROSTER, ...many]);
    const html = await setup("preview");
    // Twelve with no email (No Mail and the eleven): more than ten, so the table opens only when asked.
    expect(html).toMatch(/<h3 class="table-head">No email address \(12\)<\/h3><details class="more"><summary>Show all 12 people<\/summary><table role="table" class="table"><caption class="visually-hidden">No email address: 12 people<\/caption>/);
    for (const p of many) expect(html).toContain(`<th role="rowheader" scope="row">${p.displayName}</th>`);
    // One held address: a table shown as it is, with the families it is under.
    expect(html).toMatch(/Addresses under more than one family \(1\)<\/h3><table role="table" class="table">/);
    expect(html).toContain("Chen Family, Lee Family");
    expect(html).toMatch(/More than one address on a person&#x27;s record \(0\)<\/h3><div class="notice notice-done">.*?None\.<\/div><\/div>/);
  });

  it("the steps name the real cause from the switch's own check: a shape the roster can't be used with", async () => {
    await ready();
    await db.delete(qboCustomer); await db.delete(qboCustomerType);            // a shape is chosen, but nothing has been read
    const html = await setup("signins");
    expect(html).toContain("The roster can&#x27;t be used yet: refresh it, and check the membership shape under QuickBooks.");
    expect(html).not.toContain("Choose the membership shape first.");
  });

  it("step 1 says the ending list is being worked out while a roster refresh holds the lock", async () => {
    await ready();
    const seeded = await seedParent({ name: "Hand Seeded", email: "seeded@example.com" });
    await seedGuardian({ parentId: seeded.id, familyQboId: "POC-FAMILY-1" });
    const busyText = "This list is being worked out while the roster refreshes. Reload the page in a minute.";
    let busy = "";
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
      busy = await setup("preview");
    });
    expect(busy).toContain(busyText);
    expect(busy).not.toContain("QuickBooks no longer backs these");           // the busy sentence stands alone
    expect(busy).not.toContain("seeded@example.com");
    const free = await setup("preview");
    expect(free).not.toContain(busyText);
    // A row of the table of sign-ins that would end: the person, then the address.
    expect(free).toMatch(/<th role="rowheader" scope="row">Hand Seeded<\/th><td role="cell">.*?seeded@example\.com<\/div><\/td>/);
    expect(free).toContain("QuickBooks no longer backs these, so they stop working when sign-ins are switched on.");
  });

  it("runs the dry run only on the steps that show its list, and only while sign-ins are off", async () => {
    await ready();
    const spy = vi.spyOn(reconcileModule, "reconcileAccess");
    try {
      await view(); await setup("welcome");
      expect(spy).not.toHaveBeenCalled();                                     // the overview and step 3 never show the list
      await setup("preview"); await setup("signins");
      expect(spy).toHaveBeenCalledTimes(2);
      await setSigninsAction(true);
      spy.mockClear();
      await view(); await setup(); await setup("preview"); await setup("signins");
      expect(spy).not.toHaveBeenCalled();                                     // sign-ins are on: the reconcile itself keeps them in line
    } finally { spy.mockRestore(); }
  });

  it("switching sign-ins on, then welcomes, through the actions", async () => {
    await ready();
    expect(await setSigninsAction(true)).toEqual({ ok: true, message: "Parent sign-ins are on." });
    expect(await view()).toContain("<dd>On</dd>");
    expect((await audits("settings.parents.save"))[0]).toMatchObject({ actorId: admin.id, permission: "Settings.Parents.ReadWrite", ip: "203.0.113.40" });
    const welcome = await setup("welcome");
    expect(welcome).toContain("1 person would be emailed now.");
    expect(welcome).toContain("You can now sign in to");
    expect(await setWelcomeAction(true)).toEqual({ ok: true, message: "Welcome emails are on. They go out a few each minute." });
    expect(await setSigninsAction(false)).toEqual({ ok: true, message: "Parent sign-ins are off. Every parent has been signed out, and welcome emails are off." });
    expect(await view()).toContain("Switched off");
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
    await db.update(jobRun).set({ finishedAt: new Date(Date.now() - 49 * 3_600_000) });
    const stale = await setup("signins");
    expect(stale).toContain("Parent sign-ins are off. Nobody can sign in.");
    expect(stale).toContain("Refresh the roster first");
  });

  it("switching sign-ins off switches welcomes off, so step 2's 'no email is sent' is true; and says so when they weren't on", async () => {
    await ready();
    expect(await setSigninsAction(false)).toEqual({ ok: true, message: "Parent sign-ins weren't on." });
    expect(await setWelcomeAction(true)).toEqual({ ok: false, errors: ["Switch parent sign-ins on first."] });
    await setSigninsAction(true);
    expect(await setup("signins")).toContain("Every parent is signed out at once and nobody can sign in until this is switched on again. Welcome emails are switched off too. Nothing is deleted.");
    await setWelcomeAction(true);
    await setSigninsAction(false);
    const off = await setup("signins");
    expect(off).toContain("No email is sent: welcome emails are step 3.");
    expect((await getParentSettings()).welcome).toBe(false);
    const welcome = await setup("welcome");
    expect(welcome).toContain("Switch parent sign-ins on first (step 2).");
    expect(welcome).not.toContain("Switch welcome emails on");
  });

  it("refuses to switch on with the reasons, and changes nothing", async () => {
    expect(await setSigninsAction(true)).toMatchObject({ ok: false, errors: expect.arrayContaining(["Connect QuickBooks first."]) });
    expect(await audits("settings.parents.save")).toEqual([]);
  });

  it("refuses arguments no page sends, and changes nothing", async () => {
    await ready();
    const loose = (f: unknown) => f as (...a: unknown[]) => Promise<unknown>;
    const refused = { ok: false, errors: [BROWSER] };
    for (const act of [setSigninsAction, setWelcomeAction, setRequireStudentsAction, setReviewEmailsAction]) {
      for (const bad of ["true", 1, null, undefined, { valueOf: () => true }, [true]]) expect(await loose(act)(bad)).toEqual(refused);
    }
    for (const args of [[12, "87"], ["x".repeat(65), null], ["12", 87], ["12", undefined], ["12", ["87"]], ["12", "x".repeat(65)], [{ toString: () => "12" }, "87"]]) {
      expect(await loose(decideMatchAction)(...args)).toEqual(refused);
    }
    expect(await getParentSettings()).toMatchObject({ signin: false, welcome: false, requireActiveStudents: false, reviewEmails: true });
    expect(await audits("settings.parents.save")).toEqual([]);
    expect(await audits("parent.match.decided")).toEqual([]);
    expect(revalidated.count).toBe(0);
  });

  it("the active-students and review-email options are saved through their actions", async () => {
    await ready(); await setSigninsAction(true);
    expect(await setRequireStudentsAction(true)).toEqual({ ok: true, message: "Saved. Families with no active student can't sign in." });
    expect(await setReviewEmailsAction(false)).toEqual({ ok: true, message: "Saved. Staff won't be emailed; the notice on the staff home stays." });
    expect(await getParentSettings()).toMatchObject({ requireActiveStudents: true, reviewEmails: false });
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

  it("the match review lists suggestions, and its actions decide them", async () => {
    await ready(); await setSigninsAction(true);
    await db.insert(heldAddress).values({ email: "sam@example.com", approvedFamilyQboIds: ["20", "30"] }).onConflictDoUpdate({ target: heldAddress.email, set: { approvedFamilyQboIds: ["20", "30"] } });
    await runReconcile({ cause: "test" });
    await clearRosterOfOtherCompany("2222", { actor: { door: "staff", id: admin.id, label: admin.email }, ip: null });
    expect((await thrown(MatchesPage())).url).toBe("/staff/settings/parents");          // nothing to review until the new roster is read
    await db.update(qboConnection).set({ realmId: "2222" });
    // The clear already recorded the cache as the new company's (it sets the roster source); set it again as a refresh would.
    await db.transaction((tx) => setRosterSource(tx, "2222"));
    await seedShape(); await seedCache([fam("87", "Rivera Family"), par("88", "Ana Rivera", "87", "ana@example.com"), fam("90", "Chen Family"), par("91", "Shared Sam", "90", "sam@example.com")]);
    const html = renderToStaticMarkup(await MatchesPage());
    expect(html).toContain("Rivera Family");
    expect(html).toContain("name matches, 1 of 1 addresses match");
    expect(html).toContain(">Accept the strong matches</button>");
    expect(html).toContain("Strong matches (2)");
    expect(html).not.toMatch(/1111|2222|9130000000000001/);                                  // company IDs are on no page
    const before = await view();
    expect(before).toContain('href="/staff/settings/parents/matches"');
    expect(before).toContain("3 families");                                                  // the snapshot's count and date only
    expect(before).not.toMatch(/1111|2222|9130000000000001|Lee Family|sam@example\.com|Shared Sam/);
    expect(await acceptStrongMatchesAction()).toEqual({ ok: true, message: "Accepted 2 matches." });
    expect(await decideMatchAction("30", null)).toEqual({ ok: true, message: "Saved." });
    expect(await db.select().from(familyMatch)).toHaveLength(2);
    expect(await deletePreviousCompanyAction()).toEqual({ ok: true, message: "Deleted." });
    expect((await thrown(MatchesPage())).url).toBe("/staff/settings/parents");
    expect(await view()).not.toContain("/staff/settings/parents/matches");
    expect((await db.select().from(setting)).some((s) => s.key === "parents.previous_company")).toBe(false);
  });
});
