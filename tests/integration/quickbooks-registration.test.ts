import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const relayBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/relay-address", () => ({ qboRelayUrl: () => relayBase.url }));

const who = vi.hoisted(() => ({ staff: null as null | { door: "staff"; staffUserId: string; name: string; email: string } }));
vi.mock("@/lib/auth/identity", () => ({
  getStaffIdentity: async () => who.staff, hasStaffSession: async () => Boolean(who.staff),
  getParentIdentity: async () => null, getParentState: async () => ({ status: "none" }), hasParentSession: async () => false,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.42" }), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw Object.assign(new Error("NEXT_NOT_FOUND"), { notFound: true }); },
}));

import { renderToStaticMarkup } from "react-dom/server";
import { isValidElement, type ReactNode } from "react";
import { env } from "@/env";
import { db } from "@/lib/db/client";
import { auditLog, qboConnection, qboRelay, role, roleAssignment, roleRule } from "@/lib/db/schema";
import { secretBox } from "@/lib/crypto/secret-box";
import { checkRegistrationAction, makeRelayKeyAction, saveConnectModeAction, savePortalIdAction, saveQboAppAction } from "@/app/staff/(app)/settings/quickbooks/actions";
import QuickBooksSetupPage from "@/app/staff/(app)/settings/quickbooks/setup/page";
import QuickBooksSettingsPage from "@/app/staff/(app)/settings/quickbooks/page";
import { AccessDenied } from "@/lib/guards";
import { connectionView } from "@/lib/quickbooks/connection";
import { addressFitsRelay, registrationMailto } from "@/lib/quickbooks/relay-registration";
import { readRelayMark } from "@/lib/quickbooks/relay";
import { resetDb, seedStaff } from "../helpers/db";
import { CHECK_NAME, startRelayStub, TEST_PORTAL_ID, type RelayStub } from "../helpers/relay-stub";

/**
 * Registration with Boosters Rocket Connect, setup step 1 in relay mode (slice 2 of
 * docs/superpowers/plans/2026-11-24-connect-through-boosters-rocket.md; spec §5 "Choosing a mode" and "Registration",
 * §8 "Registration"): the mode's choice, the three stages, the check's answers against the fake relay, and the private
 * key in no page, prop or audit row.
 */
let stub: RelayStub;
beforeAll(async () => { stub = await startRelayStub(); relayBase.url = stub.base; });
afterAll(() => stub.close());

const form = (o: Record<string, string | string[]>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) f.append(k, x); return f; };
const keys = { clientId: "ABclientid1234567890", clientSecret: "s3cret-value-1234567890", environment: "sandbox" };
const audits = async (action: string) => (await db.select().from(auditLog)).filter((r) => r.action === action);
const relayRow = async () => (await db.select().from(qboRelay))[0];
const privateKey = async () => { const r = (await relayRow())!; return secretBox().open({ ciphertext: r.privateKeyCiphertext, keyId: r.privateKeyKeyId }, "qbo:relay-key"); };
const OTHER_ID = "brp_another0portal01";

/** The page's element tree as text: every prop a client component is given (functions and React's own fields left out). */
function propsText(node: unknown): string {
  return JSON.stringify(node, (k, v: unknown) => (k.startsWith("_") || typeof v === "function" || typeof v === "symbol" ? undefined : v));
}
async function setup(step = "app"): Promise<{ html: string; tree: string }> {
  const el = (await QuickBooksSetupPage({ searchParams: Promise.resolve({ step }) })) as ReactNode;
  expect(isValidElement(el)).toBe(true);
  return { html: renderToStaticMarkup(el), tree: propsText(el) };
}
/** Makes the key, and registers its public half with the fake relay under `id`, as Boosters Rocket's owner would. */
async function makeAndRegister(id = TEST_PORTAL_ID) {
  expect(await makeRelayKeyAction(form({}))).toMatchObject({ ok: true });
  stub.portals.set(id, (await relayRow())!.publicKey);
}

describe("Registering the portal with Boosters Rocket", () => {
  let admin: Awaited<ReturnType<typeof seedStaff>>;
  beforeEach(async () => {
    await resetDb(); stub.reset();
    admin = await seedStaff({ email: "admin@club.org", name: "Admin Person", admin: true });
    who.staff = { door: "staff", staffUserId: admin.id, name: admin.name, email: admin.email };
  });

  it("a new club starts in relay mode, not registered yet, with step 1 not done", async () => {
    expect(await connectionView()).toMatchObject({ connectMode: "relay", tokenMode: null, relayStage: "not_registered", configured: false });
    const { html } = await setup();
    expect(html).toContain("1. How to connect");
    expect(html).toMatch(/name="mode" checked="" value="relay"/);
    expect(html).toContain("Not registered yet");
    expect(html).toContain("Make this portal&#x27;s key");
    expect(html).not.toContain(`name="clientId"`);
    expect(await QuickBooksSetupPage({ searchParams: Promise.resolve({ step: "connect" }) }).catch((e: { url?: string }) => e.url)).toBe("/staff/settings/quickbooks/setup?step=app");
  });

  it("makes the key once, sealed, and waits for the id with the address, the public key and the email to write", async () => {
    expect(await makeRelayKeyAction(form({}))).toEqual({ ok: true, message: "This portal's key is made." });
    const r = (await relayRow())!;
    expect(r.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r).toMatchObject({ keyMadeBy: admin.id, portalId: null });
    expect(r.privateKeyCiphertext).not.toContain(await privateKey());
    // Pressed again, nothing changes.
    expect(await makeRelayKeyAction(form({}))).toEqual({ ok: true, message: "This portal's key is already made." });
    expect((await relayRow())!.publicKey).toBe(r.publicKey);
    expect(await audits("settings.quickbooks.relay.key_made")).toMatchObject([
      { actorId: admin.id, permission: "Settings.QuickBooks.ReadWrite", ip: "203.0.113.42", before: null, after: { publicKey: r.publicKey.slice(0, 8), portalId: null } }]);

    expect((await connectionView()).relayStage).toBe("waiting");
    const { html } = await setup();
    expect(html).toContain("Waiting for the id");
    expect(html).toContain(`value="${r.publicKey}"`);
    expect(html).toContain('value="http://localhost:3000"'); // APP_URL in the Vitest environment
    expect(html).toContain("Email these to support@boostersrocket.com.");
    expect(html).toContain(">Write the email</a>");
    expect(html).toContain('href="mailto:support@boostersrocket.com?subject=');
    expect(html).toContain(">Portal id</label>");
  });

  it("the email names the club, the address and the public key, encoded, and nothing else", () => {
    const m = registrationMailto({ clubName: "Lakeside & Co Boosters", address: "https://portal.lakeside.org", publicKey: "gbltJgDOnRxjmYnR45vZLQksg_FU67qiHffLEm4zqcY" });
    const u = new URL(m);
    expect(u.protocol).toBe("mailto:");
    expect(u.pathname).toBe("support@boostersrocket.com");
    expect(u.searchParams.get("subject")).toBe("Register a Boosters Rocket portal: Lakeside & Co Boosters");
    expect(u.searchParams.get("body")).toContain("Portal address: https://portal.lakeside.org");
    expect(u.searchParams.get("body")).toContain("Public key: gbltJgDOnRxjmYnR45vZLQksg_FU67qiHffLEm4zqcY");
    expect([...u.searchParams.keys()]).toEqual(["subject", "body"]);
  });

  it("refuses a portal id that isn't one, and one before the key, saving nothing", async () => {
    expect(await savePortalIdAction(form({ portalId: TEST_PORTAL_ID }))).toEqual({ ok: false, errors: ["Make this portal's key first."] });
    await makeAndRegister();
    for (const bad of ["", "brp_short", "BRP_TEST0PORTAL0ID01", "brp_test0portal0id01x", "brp_test-portal0id01", "<b>brp_test0portal0id01</b>", "x".repeat(300)]) {
      expect(await savePortalIdAction(form({ portalId: bad }))).toMatchObject({ ok: false });
    }
    // Not from the page: no field, a field twice, a file, not a form at all.
    expect(await savePortalIdAction(form({}))).toMatchObject({ ok: false, errors: ["That didn't go through. Reload the page and try again."] });
    expect(await savePortalIdAction(form({ portalId: [TEST_PORTAL_ID, TEST_PORTAL_ID] }))).toMatchObject({ ok: false });
    const f = new FormData(); f.append("portalId", new Blob([TEST_PORTAL_ID]));
    expect(await savePortalIdAction(f)).toMatchObject({ ok: false });
    expect(await savePortalIdAction(TEST_PORTAL_ID as unknown as FormData)).toMatchObject({ ok: false });
    expect((await relayRow())!.portalId).toBeNull();
    expect(await audits("settings.quickbooks.relay.portal_id")).toHaveLength(0);
    expect(stub.calls).toHaveLength(0);
  });

  it("saving the id checks it: registered, with the relay's name and environments, and ready to connect", async () => {
    await makeAndRegister();
    stub.checkEnvironments = ["sandbox", "staging"];
    const r = await savePortalIdAction(form({ portalId: `  ${TEST_PORTAL_ID} ` }));
    expect(r).toEqual({ ok: true, message: "The portal id is saved.", check: { answer: "registered", name: CHECK_NAME, environments: ["sandbox"] } });
    expect(stub.calls.map((c) => [c.path, c.portal, c.status, c.body])).toEqual([["/v1/portal/check", TEST_PORTAL_ID, 200, {}]]);
    expect((await relayRow())!).toMatchObject({ portalId: TEST_PORTAL_ID, portalIdSavedBy: admin.id });
    expect(await audits("settings.quickbooks.relay.portal_id")).toMatchObject([
      { actorId: admin.id, permission: "Settings.QuickBooks.ReadWrite", before: { portalId: null }, after: { portalId: TEST_PORTAL_ID } }]);
    expect((await readRelayMark())?.lastOkAt).not.toBeNull();
    expect(await connectionView()).toMatchObject({ relayStage: "ready", configured: true, connected: false });
    const { html } = await setup();
    expect(html).toContain("Ready to connect");
    expect(html).toContain(`<code>${TEST_PORTAL_ID}</code>`);
    expect(html).toContain("Check the registration");
    expect(html).toContain("<summary>Change the portal id</summary>");
    expect(html).toContain("<summary>Make a new key</summary>");
    // Step 1 is done, so step 2 opens.
    expect(await setup("connect")).toBeTruthy();
  });

  it("the check says when the id and key don't match, and when the relay can't be reached; the id is kept either way", async () => {
    await makeAndRegister(OTHER_ID); // registered under another id: the relay doesn't know this one
    expect(await savePortalIdAction(form({ portalId: TEST_PORTAL_ID }))).toMatchObject({ ok: true, check: { answer: "not_matching" } });
    expect((await relayRow())!.portalId).toBe(TEST_PORTAL_ID);
    expect((await readRelayMark())?.lastFailWord).toBe("unauthorized");

    stub.portals.set(TEST_PORTAL_ID, (await relayRow())!.publicKey);
    stub.failNext = 1;
    expect(await checkRegistrationAction()).toEqual({ ok: true, check: { answer: "unreachable" } });
    stub.busyNext = 1;
    expect(await checkRegistrationAction()).toEqual({ ok: true, check: { answer: "unreachable" } });
    stub.oddAnswer = { path: "/v1/portal/check", body: { status: "ok", portal: { name: 42 } } };
    expect(await checkRegistrationAction()).toEqual({ ok: true, check: { answer: "unreachable" } });
    stub.oddAnswer = null;
    // Check again: now it holds. The relay's name is its text, kept as text.
    stub.checkName = "<b>Lakeside</b> Boosters";
    expect(await checkRegistrationAction()).toEqual({ ok: true, check: { answer: "registered", name: "<b>Lakeside</b> Boosters", environments: ["production", "sandbox"] } });
    expect((await relayRow())!.portalId).toBe(TEST_PORTAL_ID);
    // The check is a read: no audit row of its own.
    expect((await db.select().from(auditLog)).map((a) => a.action).sort()).toEqual(["settings.quickbooks.relay.key_made", "settings.quickbooks.relay.portal_id"]);
  });

  it("the check's answer is drawn in words, the relay's name as text", async () => {
    const { CheckAnswer } = await import("@/app/staff/(app)/settings/quickbooks/forms");
    const draw = (check: Parameters<typeof CheckAnswer>[0]["check"]) => renderToStaticMarkup(CheckAnswer({ check, again: () => {}, checking: false }));
    expect(draw({ answer: "registered", name: "<b>Lakeside</b>", environments: ["production"] })).toContain("Registered as &lt;b&gt;Lakeside&lt;/b&gt;. It may connect to the club&#x27;s real books.");
    expect(draw({ answer: "not_matching" })).toContain("That portal id and this portal&#x27;s key don&#x27;t match what Boosters Rocket registered.");
    expect(draw({ answer: "unreachable" })).toContain("Boosters Rocket couldn&#x27;t be reached just now");
    expect(draw({ answer: "unreachable" })).toContain("Check again");
  });

  it("with no id saved the check asks the relay nothing", async () => {
    expect(await checkRegistrationAction()).toEqual({ ok: true, check: null });
    await makeRelayKeyAction(form({}));
    expect(await checkRegistrationAction()).toEqual({ ok: true, check: null });
    expect(stub.calls).toHaveLength(0);
  });

  it("a new key replaces both halves and clears the id, audited; refused while connected through the relay", async () => {
    await makeAndRegister();
    await savePortalIdAction(form({ portalId: TEST_PORTAL_ID }));
    const old = (await relayRow())!;
    expect(await makeRelayKeyAction(form({ replace: "nope" }))).toMatchObject({ ok: false });
    expect(await makeRelayKeyAction(form({ replace: ["yes", "yes"] }))).toMatchObject({ ok: false });

    // Connected through the relay: the key signs every refresh, so it stays, and the page doesn't offer a new one.
    await db.insert(qboConnection).values({ relayEnvironment: "sandbox", connectMode: "relay", tokenMode: "relay" });
    expect(await makeRelayKeyAction(form({ replace: "yes" }))).toMatchObject({ ok: false, errors: [expect.stringContaining("Disconnect first")] });
    expect((await relayRow())!.publicKey).toBe(old.publicKey);
    expect((await setup()).html).not.toContain("Make a new key");
    await db.delete(qboConnection);

    expect(await makeRelayKeyAction(form({ replace: "yes" }))).toMatchObject({ ok: true });
    const now = (await relayRow())!;
    expect(now.publicKey).not.toBe(old.publicKey);
    expect(now.privateKeyCiphertext).not.toBe(old.privateKeyCiphertext);
    expect(now).toMatchObject({ portalId: null, portalIdSavedAt: null, portalIdSavedBy: null });
    expect((await audits("settings.quickbooks.relay.key_made"))[1]).toMatchObject({
      before: { publicKey: old.publicKey.slice(0, 8), portalId: TEST_PORTAL_ID }, after: { publicKey: now.publicKey.slice(0, 8), portalId: null } });
    expect((await connectionView()).relayStage).toBe("waiting");
  });

  it("the portal id can't change while connected through the relay, which knows the connection by it; the same id changes nothing", async () => {
    await makeAndRegister();
    await savePortalIdAction(form({ portalId: TEST_PORTAL_ID }));
    stub.calls.length = 0;
    await db.insert(qboConnection).values({ relayEnvironment: "sandbox", connectMode: "relay", tokenMode: "relay", realmId: "9130000000000001", refreshTokenCiphertext: "x", refreshTokenKeyId: "k" });
    const before = await audits("settings.quickbooks.relay.portal_id");
    expect(await savePortalIdAction(form({ portalId: OTHER_ID }))).toEqual({ ok: false, errors: [expect.stringContaining("Disconnect first")] });
    expect((await relayRow())!.portalId).toBe(TEST_PORTAL_ID);
    expect(await savePortalIdAction(form({ portalId: TEST_PORTAL_ID }))).toMatchObject({ ok: true, message: "Nothing changed." });
    expect(await audits("settings.quickbooks.relay.portal_id")).toHaveLength(before.length);
    const { html } = await setup();
    expect(html).not.toContain("Change the portal id");
    expect(html).not.toContain("Make a new key");
    // Disconnected (no relay tokens held), it may change again.
    await db.update(qboConnection).set({ tokenMode: null, realmId: null, refreshTokenCiphertext: null, refreshTokenKeyId: null });
    expect(await savePortalIdAction(form({ portalId: OTHER_ID }))).toMatchObject({ ok: true, message: "The portal id is saved." });
    expect((await relayRow())!.portalId).toBe(OTHER_ID);
  });

  it("an http address on another host can't be registered: the stage says so and offers no id form", async () => {
    await makeRelayKeyAction(form({}));
    expect(addressFitsRelay("https://portal.club.org")).toBe(true);
    expect(addressFitsRelay("http://localhost:3000")).toBe(true);
    expect(addressFitsRelay("http://portal.club.org")).toBe(false);
    const was = env.APP_URL;
    try {
      env.APP_URL = "http://portal.club.org";
      const { html } = await setup();
      expect(html).toContain("Boosters Rocket can register only a portal with an https address, and this one is http://portal.club.org.");
      expect(html).not.toContain(">Portal id</label>");
    } finally {
      env.APP_URL = was;
    }
  });

  it("the private key is in no page, client prop or audit row, at any stage", async () => {
    const stages: string[] = [];
    const look = async () => {
      const key = await privateKey().catch(() => null);
      for (const step of ["app", "connect"]) {
        const page = await setup(step).catch(() => null);
        if (!page) continue;
        stages.push(step);
        if (key) { expect(page.html).not.toContain(key); expect(page.tree).not.toContain(key); }
        expect(page.tree).not.toContain("privateKey");
      }
      const settings = renderToStaticMarkup(await QuickBooksSettingsPage());
      if (key) expect(settings).not.toContain(key);
    };
    await look();
    await makeAndRegister();
    await look();
    await savePortalIdAction(form({ portalId: TEST_PORTAL_ID }));
    await look();
    await makeRelayKeyAction(form({ replace: "yes" }));
    await look();
    const key = await privateKey();
    const rows = JSON.stringify(await db.select().from(auditLog));
    expect(rows).not.toContain(key);
    expect(rows).not.toContain(key.slice(-40));
    expect(stages).toContain("connect");
    expect(JSON.stringify(await connectionView())).not.toContain(key);
  });

  describe("the choice of mode", () => {
    it("own-app needs the app's keys first, and saving them is the choice, audited", async () => {
      expect(await saveConnectModeAction(form({ mode: "own_app" }))).toMatchObject({ ok: false, errors: [expect.stringContaining("Save the Intuit app's keys below")] });
      expect(await saveConnectModeAction(form({ mode: "relay" }))).toEqual({ ok: true, message: "Nothing changed." });
      expect(await audits("settings.quickbooks.mode")).toHaveLength(0);
      expect(await saveQboAppAction(form(keys))).toEqual({ ok: true });
      expect(await connectionView()).toMatchObject({ connectMode: "own_app", configured: true });
      expect(await audits("settings.quickbooks.mode")).toMatchObject([{ actorId: admin.id, before: { connectMode: "relay" }, after: { connectMode: "own_app" } }]);
      const { html } = await setup();
      expect(html).toMatch(/name="mode" checked="" value="own_app"/);
      expect(html).toContain("ABclientid1234567890");
      expect(html).not.toContain("Not registered yet");
    });

    it("moves from own-app to relay at any time, even while connected with the own app, audited; and back", async () => {
      await saveQboAppAction(form(keys));
      await db.update(qboConnection).set({ realmId: "9130000000000001", tokenMode: "own_app", refreshTokenCiphertext: "x", refreshTokenKeyId: "k" });
      expect(await saveConnectModeAction(form({ mode: "relay" }))).toMatchObject({ ok: true });
      expect(await connectionView()).toMatchObject({ connectMode: "relay", tokenMode: "own_app", connected: true, configured: true });
      expect((await audits("settings.quickbooks.mode")).at(-1)).toMatchObject({ before: { connectMode: "own_app" }, after: { connectMode: "relay" } });
      expect(renderToStaticMarkup(await QuickBooksSettingsPage())).toContain("Through Boosters Rocket from the next Connect. With the club&#x27;s own Intuit app until then.");
      expect(await saveConnectModeAction(form({ mode: "own_app" }))).toMatchObject({ ok: true });
      expect((await connectionView()).connectMode).toBe("own_app");
    });

    it("refuses relay to own-app while connected through the relay, changing nothing", async () => {
      await saveQboAppAction(form(keys));
      await saveConnectModeAction(form({ mode: "relay" }));
      await db.update(qboConnection).set({ tokenMode: "relay", relayEnvironment: "sandbox", realmId: "9130000000000001", refreshTokenCiphertext: "x", refreshTokenKeyId: "k" });
      const before = await audits("settings.quickbooks.mode");
      expect(await saveConnectModeAction(form({ mode: "own_app" }))).toMatchObject({ ok: false, errors: [expect.stringContaining("Disconnect first")] });
      expect(await saveQboAppAction(form(keys))).toMatchObject({ ok: false, errors: [expect.stringContaining("Disconnect first")] });
      expect((await connectionView()).connectMode).toBe("relay");
      expect(await audits("settings.quickbooks.mode")).toHaveLength(before.length);
    });

    it("refuses a mode that isn't one", async () => {
      for (const bad of [form({}), form({ mode: "both" }), form({ mode: ["relay", "own_app"] }), "relay" as unknown as FormData]) {
        expect(await saveConnectModeAction(bad)).toMatchObject({ ok: false, errors: ["That didn't go through. Reload the page and try again."] });
      }
    });

    it("the QuickBooks page says it connects through Boosters Rocket, with the relay's address", async () => {
      await makeAndRegister();
      await savePortalIdAction(form({ portalId: TEST_PORTAL_ID }));
      const html = renderToStaticMarkup(await QuickBooksSettingsPage());
      expect(html).toContain("How it connects");
      expect(html).toContain("Through Boosters Rocket");
      expect(html).toContain(`<code>${stub.base}</code>`);
      expect(html).toContain("Chosen when you connect");
      expect(html).not.toContain(`name="clientId"`);
    });
  });

  it("refuses staff whose custom role includes everything, on every registration action, and audits it", async () => {
    const s = await seedStaff({ email: "treasurer@club.org" });
    const [r] = await db.insert(role).values({ key: "everything", name: "Everything" }).returning();
    await db.insert(roleRule).values({ roleId: r!.id, kind: "include", pattern: "*" });
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
    who.staff = { door: "staff", staffUserId: s.id, name: s.name, email: s.email };
    for (const call of [() => saveConnectModeAction(form({ mode: "relay" })), () => makeRelayKeyAction(form({})), () => savePortalIdAction(form({ portalId: TEST_PORTAL_ID })), () => checkRegistrationAction()]) {
      await expect(call()).rejects.toBeInstanceOf(AccessDenied);
    }
    expect((await audits("access.refused")).map((a) => a.permission)).toEqual(Array(4).fill("Settings.QuickBooks.ReadWrite"));
    expect(await relayRow()).toBeUndefined();
    expect(stub.calls).toHaveLength(0);
  });
});
