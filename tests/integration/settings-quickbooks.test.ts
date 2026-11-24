import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

const who = vi.hoisted(() => ({ staff: null as null | { door: "staff"; staffUserId: string; name: string; email: string }, sessionOnly: false }));
vi.mock("@/lib/auth/identity", () => ({
  getStaffIdentity: async () => who.staff, hasStaffSession: async () => who.sessionOnly || Boolean(who.staff),
  getParentIdentity: async () => null, getParentState: async () => ({ status: "none" }), hasParentSession: async () => false,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.40" }), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw Object.assign(new Error("NEXT_NOT_FOUND"), { notFound: true }); },
}));

import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { ShapeForm, shapeFormData, disconnectedNote } from "@/app/staff/(app)/settings/quickbooks/forms";
import { db } from "@/lib/db/client";
import { eq } from "drizzle-orm";
import { accountingLink, auditLog, family, qboConnection, qboCustomer, role, roleRule, roleAssignment, setting } from "@/lib/db/schema";
import { saveQboAppAction, beginConnectAction, switchConnectAction, disconnectAction, previewShapeAction, saveShapeAction } from "@/app/staff/(app)/settings/quickbooks/actions";
import QuickBooksSettingsPage from "@/app/staff/(app)/settings/quickbooks/page";
import QuickBooksSetupPage from "@/app/staff/(app)/settings/quickbooks/setup/page";
import SwitchCompanyPage from "@/app/staff/(app)/settings/quickbooks/switch/page";
import { GET as callback } from "@/app/api/quickbooks/callback/route";
import { AccessDenied } from "@/lib/guards";
import { getShape } from "@/lib/roster/shape";
import { refreshRoster } from "@/lib/roster/refresh";
import { resetDb, seedStaff } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const form = (o: Record<string, string | string[]>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) f.append(k, x); return f; };
const keys = { clientId: "ABclientid1234567890", clientSecret: "s3cret-value-1234567890", environment: "sandbox" };
const redirectOf = async (p: Promise<unknown>) => ((await p.catch((e: { url?: string }) => e)) as { url?: string }).url;
const audits = async (action: string) => (await db.select().from(auditLog)).filter((r) => r.action === action);
const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
const setupHtml = async (step?: string, error?: string) => renderToStaticMarkup(await QuickBooksSetupPage({ searchParams: Promise.resolve({ ...(step ? { step } : {}), ...(error ? { error } : {}) }) }));

describe("QuickBooks settings", () => {
  let admin: Awaited<ReturnType<typeof seedStaff>>;
  beforeEach(async () => {
    who.sessionOnly = false;
    await resetDb(); stub.reset(); Object.assign(stub, fznCompany());
    admin = await seedStaff({ email: "admin@club.org", name: "Admin Person", admin: true });
    who.staff = { door: "staff", staffUserId: admin.id, name: admin.name, email: admin.email };
  });
  const asEverythingRole = async () => {
    const s = await seedStaff({ email: "treasurer@club.org" });
    const [r] = await db.insert(role).values({ key: "everything", name: "Everything" }).returning();
    await db.insert(roleRule).values({ roleId: r!.id, kind: "include", pattern: "*" });
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
    who.staff = { door: "staff", staffUserId: s.id, name: s.name, email: s.email };
  };
  const callbackUrl = (q: Record<string, string>) => new Request(`http://localhost:3100/api/quickbooks/callback?${new URLSearchParams(q)}`);
  const startConnect = async () => new URL((await redirectOf(beginConnectAction()))!).searchParams.get("state")!;

  it("refuses staff whose custom role includes everything, on every action, and audits it", async () => {
    await asEverythingRole();
    for (const call of [() => saveQboAppAction(form(keys)), () => beginConnectAction(), () => switchConnectAction(form({ confirm: "yes" })), () => disconnectAction(), () => previewShapeAction(form({ kind: "flat", members: "3" })), () => saveShapeAction(form({ kind: "flat", members: "3" }))]) {
      await expect(call()).rejects.toBeInstanceOf(AccessDenied);
    }
    expect((await audits("access.refused")).map((a) => a.permission)).toEqual(Array(6).fill("Settings.QuickBooks.ReadWrite"));
    expect(await redirectOf(QuickBooksSettingsPage())).toBe("/refused");
    expect(await redirectOf(QuickBooksSetupPage({ searchParams: Promise.resolve({}) }))).toBe("/refused");
    expect(await redirectOf(SwitchCompanyPage({ searchParams: Promise.resolve({}) }))).toBe("/refused");
  });

  it("step 1 saves the keys; a bad form comes back with its errors", async () => {
    expect(await saveQboAppAction(form({ ...keys, clientId: "bad id" }))).toMatchObject({ ok: false });
    expect(await saveQboAppAction(form(keys))).toEqual({ ok: true });
    expect((await audits("settings.quickbooks.save"))[0]).toMatchObject({ actorId: admin.id, permission: "Settings.QuickBooks.ReadWrite", ip: "203.0.113.40" });
  });

  it("step 2 sends the Admin to Intuit, or back to step 1 when there are no keys", async () => {
    expect(await redirectOf(beginConnectAction())).toBe("/staff/settings/quickbooks/setup?step=app&error=keys");
    await saveQboAppAction(form(keys));
    expect(await redirectOf(beginConnectAction())).toContain(`${stub.base}/authorize?client_id=ABclientid1234567890`);
  });

  it("the return from Intuit connects, reads the roster for the first time and goes to step 3", async () => {
    await saveQboAppAction(form(keys));
    const state = await startConnect();
    stub.codes.add("code-1");
    const res = await callback(callbackUrl({ code: "code-1", state, realmId: "9130000000000001" }));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search).toBe("/staff/settings/quickbooks/setup?step=shape");
    expect((await db.select().from(qboConnection))[0]).toMatchObject({ realmId: "9130000000000001", companyName: "Stub Boosters" });
    expect(await db.select().from(qboCustomer)).toHaveLength(9);
    expect((await audits("quickbooks.connect"))[0]).toMatchObject({ actorId: admin.id });
  });

  it.each([
    [{ code: "code-1", state: "wrong", realmId: "9130000000000001" }, "state"],
    [{ error: "access_denied", state: "REAL" }, "denied"],
  ])("a refused return %j goes back to step 2 with the reason %s", async (q, reason) => {
    await saveQboAppAction(form(keys));
    const state = await startConnect();
    const res = await callback(callbackUrl(Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v === "REAL" ? state : v]))));
    expect(new URL(res.headers.get("location")!).search).toBe(`?step=connect&error=${reason}`);
    expect((await db.select().from(qboConnection))[0]!.realmId).toBeNull();
  });

  it("the return from Intuit is refused for someone signed out or without the permission, and nothing is stored", async () => {
    await saveQboAppAction(form(keys));
    const state = await startConnect();
    stub.codes.add("code-1");
    const back = (q: Record<string, string>) => callback(new Request(`http://localhost:3100/api/quickbooks/callback?${new URLSearchParams(q)}`, { headers: { "cf-connecting-ip": "203.0.113.41" } }));
    const q = { code: "code-1", state, realmId: "9130000000000001" };
    who.staff = null;
    expect(new URL((await back(q)).headers.get("location")!).pathname).toBe("/staff/sign-in");
    expect(await audits("access.refused")).toHaveLength(0);
    await asEverythingRole();
    expect(new URL((await back(q)).headers.get("location")!).pathname).toBe("/refused");
    expect(await audits("access.refused")).toMatchObject([{ actorId: who.staff!.staffUserId, permission: "Settings.QuickBooks.ReadWrite", ip: "203.0.113.41" }]);
    expect((await db.select().from(qboConnection))[0]!.realmId).toBeNull();
    expect(stub.tokenCalls()).toHaveLength(0);
  });

  it("the return from Intuit sends someone with a live session who can't be resolved to the refusal page, not sign-in", async () => {
    await saveQboAppAction(form(keys));
    const state = await startConnect();
    who.staff = null; who.sessionOnly = true;
    const res = await callback(callbackUrl({ code: "code-1", state, realmId: "9130000000000001" }));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/refused");
    expect(stub.tokenCalls()).toHaveLength(0);
  });

  it("step 3 previews a shape, then saves it and refreshes so contact details follow", async () => {
    await seedConnected(stub);
    await refreshRoster(worker);
    const chosen = { kind: "layered", family: "1", student: "3", parent: "2" };
    expect(await previewShapeAction(form(chosen))).toMatchObject({ ok: true, preview: { families: 3, students: 1, parents: 2, outside: 2 } });
    expect(await getShape()).toBeNull();
    expect(await previewShapeAction(form({ kind: "layered", family: "1", student: "1" }))).toEqual({ ok: false, errors: ["A customer type can have only one role."] });
    expect(await saveShapeAction(form(chosen))).toEqual({ ok: true, refreshed: true });
    expect(await getShape()).toEqual({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" });
    expect((await db.select().from(qboCustomer)).find((c) => c.qboId === "11")!.email).toBe("ana@example.com");
    expect((await audits("settings.membership.save"))[0]).toMatchObject({ actorId: admin.id, permission: "Settings.QuickBooks.ReadWrite" });
    expect((await audits("roster.refresh")).at(-1)).toMatchObject({ actorId: admin.id });
  });

  it("saving the shape still succeeds when the refresh after it fails", async () => {
    await seedConnected(stub);
    await refreshRoster(worker);
    stub.failQueryFrom = 1;
    expect(await saveShapeAction(form({ kind: "flat", members: ["3", "2"] }))).toEqual({ ok: true, refreshed: false });
    expect(await getShape()).toEqual({ kind: "flat", memberTypeIds: ["3", "2"] });
  });

  it("a step can't be reached before the one before it is done", async () => {
    expect(await redirectOf(QuickBooksSetupPage({ searchParams: Promise.resolve({ step: "connect" }) }))).toBe("/staff/settings/quickbooks/setup?step=app");
    expect(await redirectOf(QuickBooksSetupPage({ searchParams: Promise.resolve({ step: "shape" }) }))).toBe("/staff/settings/quickbooks/setup?step=app");
    await saveQboAppAction(form(keys));
    expect(await redirectOf(QuickBooksSetupPage({ searchParams: Promise.resolve({ step: "shape" }) }))).toBe("/staff/settings/quickbooks/setup?step=connect");
    expect(await setupHtml("connect")).toContain(">Connect to QuickBooks</button>");
    expect(await setupHtml()).toContain(">Connect to QuickBooks</button>"); // no step asked for: the first one not done yet
    expect(await setupHtml("app")).not.toContain(">Connect to QuickBooks</button>");
  });

  it("a connected site opens on step 3 and can go back to any step; a step that doesn't exist is treated as none asked for", async () => {
    await seedConnected(stub);
    const current = async (step?: string) => /<li aria-current="step">.*?>(\d)\. /.exec(await setupHtml(step))?.[1];
    expect(await current()).toBe("3");
    expect(await current("shape")).toBe("3");
    expect(await current("connect")).toBe("2");
    expect(await current("app")).toBe("1");
    for (const junk of ["finish", "constructor", "__proto__", "SHAPE", "shape ", "4"]) expect(await current(junk)).toBe("3");
    await db.delete(qboConnection);
    expect(await current("constructor")).toBe("1"); // on a site with nothing set up, junk opens the first step
  });

  it("step 1 shows the redirect address to copy and never the saved secret", async () => {
    await saveQboAppAction(form(keys));
    const html = await setupHtml("app");
    expect(html).toContain("http://localhost:3000/api/quickbooks/callback"); // APP_URL in the Vitest environment
    expect(html).toContain("ABclientid1234567890");
    expect(html).not.toContain("s3cret");
  });

  it("step 2 says why a return was refused", async () => {
    await saveQboAppAction(form(keys));
    expect(await setupHtml("connect", "other_company")).toContain("That is a different QuickBooks company from the one already connected.");
    for (const bad of ["made-up", "constructor", "__proto__"]) {
      const html = await setupHtml("connect", bad);
      expect(html).not.toContain(bad);
      expect(html).not.toContain('class="errors"');
    }
  });

  it("step 2 says a different company was refused, and how to move the portal to it", async () => {
    await saveQboAppAction(form(keys));
    const html = await setupHtml("connect", "roster_company");
    expect(html).toContain("That is a different QuickBooks company from the one the portal&#x27;s families were read from, so nothing was connected and nothing was changed.");
    expect(html).toContain("To move the portal to this other company, choose Connect a different company first: it lists what a switch ends and keeps.");
  });

  it("step 2 offers Connect a different company only while the roster names a company", async () => {
    await saveQboAppAction(form(keys));
    expect(await setupHtml("connect")).not.toContain('href="/staff/settings/quickbooks/switch"');
    await db.delete(qboConnection);
    await seedConnected(stub);
    await refreshRoster(worker);
    expect(await setupHtml("connect")).toContain('href="/staff/settings/quickbooks/switch">Connect a different company</a>');
    expect(renderToStaticMarkup(await QuickBooksSettingsPage())).toContain('href="/staff/settings/quickbooks/switch">Connect a different company</a>');
  });

  // Stage 4's slice M8: the page an Admin says on, first, that they mean to connect a different company.
  const switchHtml = async (error?: string) => renderToStaticMarkup(await SwitchCompanyPage({ searchParams: Promise.resolve(error ? { error } : {}) }));
  const switchRow = async () => (await db.select().from(setting).where(eq(setting.key, "quickbooks.switch")))[0]?.value ?? null;
  /** One active family linked to a customer of the roster's company. */
  const linkedFamily = async () => {
    const [f] = await db.insert(family).values({ name: "Linked Family", active: true }).returning();
    await db.insert(accountingLink).values({ system: "quickbooks", realmId: "9130000000000001", customerId: "10", familyId: f!.id, origin: "carried_over" });
  };

  it("the switch page sends the visitor to step 2 while the roster names no company", async () => {
    await saveQboAppAction(form(keys));
    expect(await redirectOf(SwitchCompanyPage({ searchParams: Promise.resolve({}) }))).toBe("/staff/settings/quickbooks/setup?step=connect");
  });

  it("the switch page lists what a switch ends and keeps, and while connected says to disconnect first, with no press", async () => {
    await seedConnected(stub);
    await refreshRoster(worker);
    await linkedFamily();
    const html = await switchHtml();
    expect(html).toContain("<h1 class=\"page-title\">Connect a different QuickBooks company</h1>");
    const ends = html.slice(html.indexOf("What a switch ends"), html.indexOf("What is kept"));
    expect(ends).toContain("1 family link, 0 student links and 0 guardian links. You link them again on Accounting links.");
    expect(ends).toContain("0 requests still waiting to be sent to the earlier company.");
    expect(ends).toContain("0 unpaid volunteer buy-outs. Each one ends, and any that may leave something to settle is listed for the treasurer on Reconciliation; any invoice made for one stays in the earlier company&#x27;s books, to settle there.");
    expect(ends).toContain("The product or service chosen for each payment and buy-out requirement. You choose each one again from the new company&#x27;s list on the requirement&#x27;s page in Seasons; until then, a payment requirement has no invoice to show and families can&#x27;t choose to pay instead of volunteering.");
    expect(ends).toContain("The membership shape. You choose it again for the new company in step 3.");
    const kept = html.slice(html.indexOf("What is kept"), html.indexOf("Before you start"));
    expect(kept).toContain("Every family, student and guardian: 1 family, 0 students and 0 guardian rows.");
    expect(kept).toContain("Every signed form, still downloadable by its family and by staff.");
    expect(kept).toContain("0 paid volunteer buy-outs, which keep counting.");
    expect(html).toContain("docker compose run --rm backup --now");
    expect(html).toContain("QuickBooks is connected now. Disconnect it first, from QuickBooks settings, then come back here.");
    expect(html).not.toContain("<button");
    expect(html).not.toContain('name="confirm"');
    for (const hidden of ["9130000000000001", "Linked Family", "at-seed", "rt-seed"]) expect(html).not.toContain(hidden);
  });

  it("once disconnected, the switch page asks for its checkbox and offers the press", async () => {
    await seedConnected(stub);
    await refreshRoster(worker);
    await disconnectAction();
    const html = await switchHtml();
    expect(html).toContain('<input type="checkbox" required="" name="confirm" value="yes"/> I understand that every family&#x27;s link to the books ends');
    expect(html).toContain(">Switch companies: sign in to Intuit</button>");
    expect(html).not.toContain("Check the box to say you understand");
    expect(await switchHtml("confirm")).toContain("Check the box to say you understand what a switch ends, then try again.");
  });

  it("the switch press refuses an unchecked or malformed form, and otherwise asks and goes to Intuit", async () => {
    await seedConnected(stub);
    await refreshRoster(worker);
    await disconnectAction();
    const back = "/staff/settings/quickbooks/switch?error=confirm";
    for (const bad of [form({}), form({ confirm: "no" }), form({ confirm: ["yes", "yes"] }), "yes", null, { confirm: "yes" }]) {
      expect(await redirectOf(switchConnectAction(bad as FormData))).toBe(back);
    }
    expect(await switchRow()).toBeNull();
    expect(await audits("quickbooks.switch.asked")).toEqual([]);
    expect(await redirectOf(switchConnectAction(form({ confirm: "yes", realmId: "9130000000000002" })))).toContain(`${stub.base}/authorize?client_id=`);
    expect(await switchRow()).toMatchObject({ asked: { staffUserId: admin.id, fromRealmId: "9130000000000001" } });
    expect((await audits("quickbooks.switch.asked")).map((a) => [a.actorId, a.permission, a.ip])).toEqual([[admin.id, "Settings.QuickBooks.ReadWrite", "203.0.113.40"]]);
  });

  it("a switch through the callback lands on step 3, which sends staff to Accounting links", async () => {
    await seedConnected(stub);
    await refreshRoster(worker);
    await linkedFamily();
    await disconnectAction();
    const state = new URL((await redirectOf(switchConnectAction(form({ confirm: "yes" }))))!).searchParams.get("state")!;
    stub.codes.add("code-1");
    const res = await callback(callbackUrl({ code: "code-1", state, realmId: "9130000000000002" }));
    expect(new URL(res.headers.get("location")!).search).toBe("?step=shape");
    expect((await db.select().from(qboConnection))[0]).toMatchObject({ realmId: "9130000000000002" });
    expect(await getShape()).toBeNull();
    expect(await db.select().from(accountingLink)).toEqual([]);
    expect(await switchRow()).toBeNull();
    const html = await setupHtml("shape");
    expect(html).toContain("1 family has no link to this QuickBooks company&#x27;s customers yet. Link it on Accounting links, so its balance can be shown.");
    expect(html).toContain('href="/staff/links">Accounting links</a>');
  });

  it("step 3 lists the customer types found, and says so when there are none", async () => {
    await seedConnected(stub);
    expect(await setupHtml("shape")).toContain("The portal hasn&#x27;t read any customer types from QuickBooks yet.");
    await refreshRoster(worker);
    const html = await setupHtml("shape");
    for (const name of ["Family", "Parent", "Student", "School", "Vendor"]) expect(html).toContain(`>${name}</option>`);
  });

  it("step 3 says why there are no types: never read, read failed, or QuickBooks has none", async () => {
    await seedConnected(stub);
    expect(await setupHtml("shape")).toContain("hasn&#x27;t read any customer types");
    stub.failQueryFrom = 1;
    await refreshRoster(worker);
    const failedHtml = await setupHtml("shape");
    expect(failedHtml).toContain("The portal couldn&#x27;t read QuickBooks just now: ");
    expect(failedHtml).not.toContain("hasn&#x27;t read any customer types");
    stub.failQueryFrom = null; stub.types = [];
    await refreshRoster(worker);
    const emptyHtml = await setupHtml("shape");
    // Not a dead end: it says the types are made in QuickBooks, and where.
    expect(emptyHtml).toContain("QuickBooks has no customer types yet, so there is nothing to choose from. Customer types are made in QuickBooks, not here: in QuickBooks Online, open the gear menu, then All lists, then Customer types");
    expect(emptyHtml).not.toContain("<select");
    expect(emptyHtml).not.toContain("couldn&#x27;t read QuickBooks");
  });

  it("step 3 names the connected company first, as text, and says what to do if it is the wrong one", async () => {
    await seedConnected(stub);
    const html = await setupHtml("shape");
    const lead = "Connected to Stub Boosters. If that isn&#x27;t the club&#x27;s company, go back to QuickBooks settings and disconnect.";
    expect(html).toContain(lead);
    expect(html.indexOf(lead)).toBeLessThan(html.indexOf("Tell the portal which QuickBooks customer types"));
    expect(html.indexOf(lead)).toBeGreaterThan(html.indexOf("Step 3: The shape of your membership"));
    await db.update(qboConnection).set({ companyName: null });
    expect(await setupHtml("shape")).toContain("Connected to a QuickBooks company. If that isn&#x27;t");
    await db.update(qboConnection).set({ companyName: "<b>Evil</b> Books" });
    expect(await setupHtml("shape")).toContain("Connected to &lt;b&gt;Evil&lt;/b&gt; Books.");
  });

  it("step 3 says what Save does", async () => {
    await seedConnected(stub);
    expect(await setupHtml("shape")).toContain("When you save, the portal reads the roster again with the new shape.");
  });

  it("the progress list links each step that can be reached, and only those", async () => {
    const progress = async (step?: string) => [...(await setupHtml(step)).match(/<ol class="setup-progress">(.*?)<\/ol>/)![1]!.matchAll(/<li([^>]*)>(.*?)<\/li>/g)]
      .map((m) => ({ current: m[1]!.includes('aria-current="step"'), href: m[2]!.match(/href="([^"]*)"/)?.[1] ?? null }));
    const link = (n: string) => `/staff/settings/quickbooks/setup?step=${n}`;
    expect(await progress()).toEqual([{ current: true, href: link("app") }, { current: false, href: null }, { current: false, href: null }]);
    await saveQboAppAction(form(keys));
    expect(await progress("app")).toEqual([{ current: true, href: link("app") }, { current: false, href: link("connect") }, { current: false, href: null }]);
    await db.delete(qboConnection); await seedConnected(stub);
    expect(await progress("connect")).toEqual([{ current: false, href: link("app") }, { current: true, href: link("connect") }, { current: false, href: link("shape") }]);
  });

  it("the view shows what is set and holds no token, secret or company ID", async () => {
    // Not set up: the head says so, and the page offers the steps, with no Connection card restating it.
    expect(renderToStaticMarkup(await QuickBooksSettingsPage())).toContain("Three steps: how the portal connects");
    expect(renderToStaticMarkup(await QuickBooksSettingsPage())).not.toContain('id="qbo-conn-h"');
    await seedConnected(stub);
    await refreshRoster(worker);
    await saveShapeAction(form({ kind: "layered", family: "1", student: "3", parent: "2" }));
    const html = renderToStaticMarkup(await QuickBooksSettingsPage());
    expect(html).toContain("Stub Boosters");
    expect(html).toContain("Sandbox");
    expect(html).toContain("Layered: families are Family, students are Student, parents are Parent.");
    expect(html).toContain("3 families, 1 student, 2 parents; 2 customers outside the portal");
    for (const hidden of ["at-seed", "rt-seed", "stub-secret", "9130000000000001"]) expect(html).not.toContain(hidden);
    expect(html).not.toMatch(/<input(?![^>]*type="hidden")/);
  });

  it("offers the move to Boosters Rocket, linked to step 1, only while connected with the club's own Intuit app", async () => {
    const move = "You can move to Boosters Rocket&#x27;s connection";
    const link = 'href="/staff/settings/quickbooks/setup?step=app">Move to Boosters Rocket</a>';
    // Not connected: nothing to move.
    expect(renderToStaticMarkup(await QuickBooksSettingsPage())).not.toContain(move);
    await saveQboAppAction(form(keys));
    expect(renderToStaticMarkup(await QuickBooksSettingsPage())).not.toContain(move);
    // Connected with the club's own app: the notice, with its link straight to step 1.
    await db.delete(qboConnection); await seedConnected(stub);
    const own = renderToStaticMarkup(await QuickBooksSettingsPage());
    expect(own).toContain(move);
    expect(own).toContain("the club needs no Intuit app of its own");
    expect(own).toContain(link);
    // Step 1 is a plain link in setup's step list from any step, so a keyboard reaches it.
    expect((await setupHtml("shape")).match(/<ol class="setup-progress">(.*?)<\/ol>/)![1]).toContain('<a href="/staff/settings/quickbooks/setup?step=app">1. How to connect</a>');
    // Connected through Boosters Rocket: nothing to move to.
    await db.update(qboConnection).set({ connectMode: "relay", tokenMode: "relay", relayEnvironment: "sandbox" });
    const relay = renderToStaticMarkup(await QuickBooksSettingsPage());
    expect(relay).not.toContain(move);
    expect(relay).not.toContain(link);
  });

  it("what the shape form sends is what preview counted and what save stores", async () => {
    await seedConnected(stub);
    await refreshRoster(worker);
    const cases = [
      [{ kind: "layered", family: "1", student: "3", parent: "2", members: ["4"] }, { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" }],
      [{ kind: "layered", family: "1", student: "", parent: "", members: [] }, { kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: null }],
      [{ kind: "flat", family: "1", student: "3", parent: "2", members: ["3", "2"] }, { kind: "flat", memberTypeIds: ["3", "2"] }],
    ] as const;
    for (const [choice, stored] of cases) {
      const data = () => shapeFormData({ ...choice, members: [...choice.members] });
      expect((await previewShapeAction(data())).ok).toBe(true);
      expect(await saveShapeAction(data())).toMatchObject({ ok: true });
      expect(await getShape()).toEqual(stored);
    }
  });

  it("disconnects from the view", async () => {
    await seedConnected(stub);
    expect(await disconnectAction()).toEqual({ ok: true, revoked: true });
    expect(await disconnectAction()).toEqual({ ok: false, error: "QuickBooks isn't connected." });
    expect((await audits("quickbooks.disconnect"))[0]).toMatchObject({ actorId: admin.id, permission: "Settings.QuickBooks.ReadWrite" });
  });
});

describe("disconnecting when Intuit doesn't confirm", () => {
  it("tells the Admin Intuit didn't confirm it, since the access may still stand there", async () => {
    await resetDb(); stub.reset();
    const admin = await seedStaff({ email: "admin@club.org", name: "Admin Person", admin: true });
    who.staff = { door: "staff", staffUserId: admin.id, name: admin.name, email: admin.email };
    await seedConnected(stub);
    const real = stubBase.url;
    stubBase.url = "http://127.0.0.1:1"; // nothing listens there
    try {
      expect(await disconnectAction()).toEqual({ ok: true, revoked: false });
    } finally { stubBase.url = real; }
    expect(disconnectedNote(true)).toBe("Disconnected. The roster stays as it was last read, and is marked as no longer current.");
    expect(disconnectedNote(false)).toBe("Disconnected here, but Intuit didn't confirm that it canceled the portal's access. The roster stays as it was last read, and is marked as no longer current.");
  });
});

describe("ShapeForm starts from the saved shape", () => {
  const types = [{ qboId: "1", name: "Family", active: true }, { qboId: "2", name: "Parent", active: true }, { qboId: "3", name: "Student", active: true }];
  const render = (shape: Parameters<typeof ShapeForm>[0]["shape"]) => renderToStaticMarkup(createElement(ShapeForm, { types, shape,
    preview: async () => ({ ok: false as const, errors: [] }), save: async () => ({ ok: false as const, errors: [] }) }));
  const chosen = (html: string, name: string) => [...html.matchAll(new RegExp(`<select name="${name}"[^>]*>(.*?)</select>`, "g"))][0]![1]!
    .match(/<option value="([^"]*)"[^>]*selected/)?.[1];

  it("starts a saved layered shape with each select on that shape's type", () => {
    const html = render({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" });
    expect([chosen(html, "family"), chosen(html, "student"), chosen(html, "parent")]).toEqual(["1", "3", "2"]);
  });

  it("starts a saved flat shape with exactly its member types checked", () => {
    const html = render({ kind: "flat", memberTypeIds: ["3", "2"] });
    const boxes = (html.match(/<input type="checkbox" name="members"[^>]*>/g) ?? []).map((t) => [t.match(/value="(\d)"/)![1], t.includes("checked")]);
    expect(boxes).toEqual([["1", false], ["2", true], ["3", true]]);
  });
});
