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
import { ShapeForm, shapeFormData } from "@/app/staff/(app)/settings/quickbooks/forms";
import { db } from "@/lib/db/client";
import { auditLog, qboConnection, qboCustomer, role, roleRule, roleAssignment } from "@/lib/db/schema";
import { saveQboAppAction, beginConnectAction, disconnectAction, previewShapeAction, saveShapeAction } from "@/app/staff/(app)/settings/quickbooks/actions";
import QuickBooksSettingsPage from "@/app/staff/(app)/settings/quickbooks/page";
import QuickBooksSetupPage from "@/app/staff/(app)/settings/quickbooks/setup/page";
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
    for (const call of [() => saveQboAppAction(form(keys)), () => beginConnectAction(), () => disconnectAction(), () => previewShapeAction(form({ kind: "flat", members: "3" })), () => saveShapeAction(form({ kind: "flat", members: "3" }))]) {
      await expect(call()).rejects.toBeInstanceOf(AccessDenied);
    }
    expect((await audits("access.refused")).map((a) => a.permission)).toEqual(Array(5).fill("Settings.QuickBooks.ReadWrite"));
    expect(await redirectOf(QuickBooksSettingsPage())).toBe("/refused");
    expect(await redirectOf(QuickBooksSetupPage({ searchParams: Promise.resolve({}) }))).toBe("/refused");
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
    expect(await setupHtml("connect")).toContain(">Sign in to Intuit</button>");
    expect(await setupHtml()).toContain(">Sign in to Intuit</button>"); // no step asked for: the first one not done yet
    expect(await setupHtml("app")).not.toContain(">Sign in to Intuit</button>");
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
    expect(emptyHtml).toContain("QuickBooks has no customer types yet. Create them there first (Sales, Customers, Customer types), then select Refresh now on the Roster page.");
    expect(emptyHtml).not.toContain("couldn&#x27;t read QuickBooks");
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
    expect(renderToStaticMarkup(await QuickBooksSettingsPage())).toContain("QuickBooks isn&#x27;t set up yet.");
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
    expect(await disconnectAction()).toEqual({ ok: true });
    expect(await disconnectAction()).toEqual({ ok: false, error: "QuickBooks isn't connected." });
    expect((await audits("quickbooks.disconnect"))[0]).toMatchObject({ actorId: admin.id, permission: "Settings.QuickBooks.ReadWrite" });
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
