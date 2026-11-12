import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { db } from "@/lib/db/client";
import { auditLog, qboConnection } from "@/lib/db/schema";
import { parseQboAppForm, saveQboApp, beginConnect, completeConnect, disconnect, connectionView, qboRedirectUri } from "@/lib/quickbooks/connection";
import { resetDb, seedStaff } from "../helpers/db";
import { startQboStub, seedConnected, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const REALM = "9130000000000001";
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const allAuditText = async () => JSON.stringify(await db.select().from(auditLog));
const row = async () => (await db.select().from(qboConnection))[0]!;
const revokes = () => stub.calls.filter((c) => c.path === "/revoke");
const APP_KEYS = `Basic ${Buffer.from("ABclientid1234567890:s3cret-value-1234567890").toString("base64")}`;
/** The one revoke a refused connect sends: the refresh token Intuit had just issued, under the keys it was issued to. */
const expectIssuedTokenRevoked = () => {
  expect(revokes()).toHaveLength(1);
  expect(revokes()[0]).toMatchObject({ method: "POST", auth: APP_KEYS });
  expect(JSON.parse(revokes()[0]!.body)).toEqual({ token: "rt-1" });
  expect(stub.refreshTokens.has("rt-1")).toBe(false);
};

describe("connecting QuickBooks", () => {
  let admin: Awaited<ReturnType<typeof seedStaff>>;
  let op: { actor: { door: "staff"; id: string; label: string }; ip: string; permission: string };
  beforeEach(async () => {
    await resetDb(); stub.reset();
    admin = await seedStaff({ email: "admin@example.org", admin: true });
    op = { actor: { door: "staff", id: admin.id, label: admin.email }, ip: "203.0.113.9", permission: "Settings.QuickBooks.ReadWrite" };
  });
  const app = () => saveQboApp({ clientId: "ABclientid1234567890", clientSecret: "s3cret-value-1234567890", environment: "sandbox" }, op);
  const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
  const start = async () => { const r = await beginConnect(admin.id); if (!r.ok) throw new Error("not configured"); return stateOf(r.url); };
  const finish = (state: string | null, extra: Partial<{ code: string | null; realmId: string | null; error: string | null }> = {}) => {
    stub.codes.add("code-1");
    return completeConnect({ code: "code-1", realmId: REALM, error: null, state, ...extra }, { staffUserId: admin.id, actor: op.actor, ip: op.ip, permission: op.permission });
  };

  it("reads the Intuit app form", () => {
    expect(parseQboAppForm({ clientId: " ABclientid1234567890 ", clientSecret: " s ", environment: "sandbox" }, false))
      .toEqual({ ok: true, draft: { clientId: "ABclientid1234567890", clientSecret: "s", environment: "sandbox" } });
    expect(parseQboAppForm({ clientId: "ABclientid1234567890", clientSecret: "", environment: "production" }, true))
      .toEqual({ ok: true, draft: { clientId: "ABclientid1234567890", clientSecret: null, environment: "production" } });
    const bad = parseQboAppForm({ clientId: "no spaces allowed", clientSecret: "", environment: "live" }, false);
    expect(bad.ok).toBe(false);
    expect(bad.ok ? [] : bad.errors).toHaveLength(3);
  });

  it("saves the keys with the secret sealed, and audits without it", async () => {
    expect(await app()).toEqual({ ok: true });
    const c = await row();
    expect(c.clientId).toBe("ABclientid1234567890");
    expect(c.clientSecretCiphertext).not.toContain("s3cret");
    expect((await audits("settings.quickbooks.save"))[0]).toMatchObject({ after: { clientId: "ABclientid1234567890", environment: "sandbox", secretChanged: true } });
    expect(await allAuditText()).not.toContain("s3cret");
    expect(await saveQboApp({ clientId: "ABclientid1234567890", clientSecret: null, environment: "sandbox" }, op)).toEqual({ ok: true });
    expect((await row()).clientSecretCiphertext).toBe(c.clientSecretCiphertext);
  });

  it("sends the Admin to Intuit with a state it only keeps hashed", async () => {
    await app();
    const r = await beginConnect(admin.id);
    expect(r.ok).toBe(true);
    const url = new URL(r.ok ? r.url : "http://x");
    expect(`${url.origin}${url.pathname}`).toBe(`${stub.base}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "ABclientid1234567890", response_type: "code", scope: "com.intuit.quickbooks.accounting", redirect_uri: qboRedirectUri() });
    const state = url.searchParams.get("state")!;
    expect(state.length).toBeGreaterThanOrEqual(40);
    expect((await row()).stateHash).not.toBe(state);
  });

  it("refuses to start before the keys are saved", async () => {
    expect(await beginConnect(admin.id)).toEqual({ ok: false, reason: "not_configured" });
  });

  it("stores sealed tokens and the company on a good return", async () => {
    await app();
    expect(await finish(await start())).toEqual({ ok: true });
    const c = await row();
    expect(c).toMatchObject({ realmId: REALM, companyName: "Stub Boosters", connectedBy: admin.id, stateHash: null });
    expect(c.accessTokenCiphertext).not.toContain("at-1");
    expect(c.refreshExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 99 * 86_400_000);
    expect((await audits("quickbooks.connect"))[0]).toMatchObject({ after: { companyName: "Stub Boosters", realmId: REALM, environment: "sandbox" }, ip: "203.0.113.9", permission: "Settings.QuickBooks.ReadWrite" });
    const text = await allAuditText();
    for (const secret of ["at-1", "rt-1", "code-1", "s3cret"]) expect(text).not.toContain(secret);
    const token = stub.tokenCalls()[0]!;
    expect(token.auth).toBe(`Basic ${Buffer.from("ABclientid1234567890:s3cret-value-1234567890").toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(token.body))).toEqual({ grant_type: "authorization_code", code: "code-1", redirect_uri: qboRedirectUri() });
    expect(await connectionView()).toMatchObject({ configured: true, connected: true, companyName: "Stub Boosters", environment: "sandbox" });
  });

  it.each([
    ["a wrong state", async () => { await start(); return "not-the-state"; }],
    ["no state", async () => { await start(); return null; }],
    ["a state another Admin started", async () => { const other = await seedStaff({ email: "other@example.org", admin: true }); const r = await beginConnect(other.id); return r.ok ? stateOf(r.url) : null; }],
    ["a state more than 10 minutes old", async () => { const s = await start(); await db.update(qboConnection).set({ stateExpiresAt: new Date(Date.now() - 1000) }); return s; }],
  ])("refuses %s, stores nothing and audits it", async (_name, make) => {
    await app();
    expect(await finish(await make())).toEqual({ ok: false, reason: "state" });
    expect((await row()).realmId).toBeNull();
    expect(stub.tokenCalls()).toHaveLength(0);
    expect((await audits("quickbooks.connect_refused"))[0]!.after).toEqual({ reason: "state" }); // nothing was issued, so nothing to revoke
    expect(revokes()).toHaveLength(0);
  });

  it.each([
    ["the environment", { clientId: "ABclientid1234567890", clientSecret: null, environment: "production" as const }],
    ["the Client ID", { clientId: "ABotherclient1234567", clientSecret: "another-secret-value-123", environment: "sandbox" as const }],
  ])("a connect started before %s changed can no longer finish", async (_name, change) => {
    await app();
    const s = await start();
    expect(await saveQboApp(change, op)).toEqual({ ok: true });
    expect(await finish(s)).toEqual({ ok: false, reason: "state" });
    expect(stub.tokenCalls()).toHaveLength(0);
    expect((await row()).realmId).toBeNull();
    expect(revokes()).toHaveLength(0);
  });

  it("a secret-only change leaves a connect in progress alone", async () => {
    await app();
    const s = await start();
    expect(await saveQboApp({ clientId: "ABclientid1234567890", clientSecret: "a-new-secret-value-123", environment: "sandbox" }, op)).toEqual({ ok: true });
    expect(await finish(s)).toEqual({ ok: true });
  });

  it.each([
    ["environment", { environment: "production" as const }],
    ["Client ID", { clientId: "ABotherclient1234567" }],
  ])("stores no tokens when the %s changes while Intuit is answering", async (_name, change) => {
    await app();
    const s = await start();
    stub.tokenDelayMs = 400;
    const pending = finish(s);
    for (let i = 0; i < 200 && stub.tokenCalls().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(stub.tokenCalls()).toHaveLength(1);
    await db.update(qboConnection).set(change);
    expect(await pending).toEqual({ ok: false, reason: "state" });
    expect(await row()).toMatchObject({ realmId: null, accessTokenCiphertext: null, refreshTokenCiphertext: null });
    expect((await audits("quickbooks.connect_refused"))[0]!.after).toEqual({ reason: "state", revoked: true });
    expectIssuedTokenRevoked(); // with the keys the code was exchanged under, not the changed ones
  });

  const refusedAfterExchange = async () => {
    await app();
    const s = await start();
    stub.tokenDelayMs = 300;
    const pending = finish(s);
    for (let i = 0; i < 200 && stub.tokenCalls().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await db.update(qboConnection).set({ realmId: "9130000000000002" });
    return pending;
  };

  it("a refused connect whose revoke Intuit turns down is refused the same way, and audited as not revoked", async () => {
    stub.failRevoke = true;
    expect(await refusedAfterExchange()).toEqual({ ok: false, reason: "other_company" });
    expect(revokes()).toHaveLength(1);
    expect((await audits("quickbooks.connect_refused"))[0]!.after).toEqual({ reason: "other_company", revoked: false });
    expect(await allAuditText()).not.toContain("a revoke answer the portal must never store");
    for (const secret of ["at-1", "rt-1", "code-1", "s3cret"]) expect(await allAuditText()).not.toContain(secret);
  });

  it("a refused connect whose revoke times out is refused the same way, and audited as not revoked", async () => {
    stub.revokeDelayMs = 1500;
    // Only the revoke is slow here, so a short limit on every request to Intuit times out just that one.
    const real = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => real(ms === 15_000 ? 400 : ms));
    try {
      expect(await refusedAfterExchange()).toEqual({ ok: false, reason: "other_company" });
    } finally { spy.mockRestore(); }
    expect(revokes()).toHaveLength(1);
    expect((await audits("quickbooks.connect_refused"))[0]!.after).toEqual({ reason: "other_company", revoked: false });
    await new Promise((r) => setTimeout(r, 1300)); // let the stub finish its slow answer before the next test
  });

  it("revokes what Intuit issued when storing the connection fails, and lets the failure through", async () => {
    await app();
    const s = await start();
    const client = await import("@/lib/quickbooks/client");
    const spy = vi.spyOn(client, "sealTokens").mockImplementationOnce(() => { throw new Error("the database went away"); });
    try {
      await expect(finish(s)).rejects.toThrow("the database went away");
    } finally { spy.mockRestore(); }
    expectIssuedTokenRevoked();
    expect(await row()).toMatchObject({ realmId: null, refreshTokenCiphertext: null });
  });

  it.each(["..", "123/456", "12a", "1".repeat(40)])("refuses the company ID %j as denied, exchanging and storing nothing", async (realmId) => {
    await app();
    expect(await finish(await start(), { realmId })).toEqual({ ok: false, reason: "denied" });
    expect(stub.tokenCalls()).toHaveLength(0);
    expect((await row()).realmId).toBeNull();
    expect(revokes()).toHaveLength(0); // refused before any code was exchanged
  });

  it("a state works once", async () => {
    await app();
    const s = await start();
    expect(await finish(s)).toEqual({ ok: true });
    expect(await finish(s)).toEqual({ ok: false, reason: "state" });
    expect(stub.tokenCalls()).toHaveLength(1);
  });

  it("only the latest state works", async () => {
    await app();
    const first = await start(), second = await start();
    expect(await finish(first)).toEqual({ ok: false, reason: "state" });
    expect(await finish(second)).toEqual({ ok: true });
  });

  it("refuses when the Admin said no at Intuit", async () => {
    await app();
    expect(await finish(await start(), { code: null, error: "access_denied" })).toEqual({ ok: false, reason: "denied" });
    expect((await audits("quickbooks.connect_refused"))[0]).toMatchObject({ after: { reason: "denied" }, permission: "Settings.QuickBooks.ReadWrite" });
  });

  it("refuses a different company than the one connected, and keeps the connection", async () => {
    await seedConnected(stub, { realmId: REALM });
    const before = await row();
    expect(await finish(await start(), { realmId: "9130000000000002" })).toEqual({ ok: false, reason: "other_company" });
    expect(await row()).toMatchObject({ realmId: REALM, accessTokenCiphertext: before.accessTokenCiphertext });
    expect(stub.tokenCalls()).toHaveLength(0);
  });

  it("refuses when another company got connected while Intuit was answering, and keeps that connection", async () => {
    await app();
    const s = await start();
    stub.tokenDelayMs = 400;
    const pending = finish(s);
    for (let i = 0; i < 200 && stub.tokenCalls().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await db.update(qboConnection).set({ realmId: "9130000000000002" });
    expect(await pending).toEqual({ ok: false, reason: "other_company" });
    expect(await row()).toMatchObject({ realmId: "9130000000000002", accessTokenCiphertext: null, refreshTokenCiphertext: null });
    expect((await audits("quickbooks.connect_refused"))[0]!.after).toEqual({ reason: "other_company", revoked: true });
    expectIssuedTokenRevoked();
  });

  it("puts no company name on a connection that was disconnected while the name was being read", async () => {
    await app();
    const s = await start();
    stub.companyInfoDelayMs = 400;
    const pending = finish(s);
    for (let i = 0; i < 300 && stub.apiCalls().length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(stub.apiCalls()).toHaveLength(1);
    expect(await disconnect(op)).toMatchObject({ ok: true });
    expect(await pending).toEqual({ ok: true });
    expect(await row()).toMatchObject({ realmId: null, companyName: null });
  });

  it("a first save needs the Client secret", async () => {
    const r = await saveQboApp({ clientId: "ABclientid1234567890", clientSecret: null, environment: "sandbox" }, op);
    expect(r).toEqual({ ok: false, errors: ["Enter the Client secret from your Intuit app's Keys and credentials page."] });
    expect(await db.select().from(qboConnection)).toHaveLength(0);
    expect(await audits("settings.quickbooks.save")).toHaveLength(0);
  });

  it("refuses when Intuit won't take the code, with Intuit's code and none of its text", async () => {
    await app();
    const s = await start();
    stub.failToken = "invalid_client";
    expect(await finish(s)).toEqual({ ok: false, reason: "intuit" });
    expect((await audits("quickbooks.connect_refused"))[0]!.after).toEqual({ reason: "intuit", code: "invalid_client" });
    expect(revokes()).toHaveLength(0); // Intuit issued nothing
    expect(await allAuditText()).not.toContain("a description the portal must never store");
  });

  it("won't change the Client ID or the environment while connected", async () => {
    await seedConnected(stub);
    const r = await saveQboApp({ clientId: "ABotherclient1234567", clientSecret: null, environment: "sandbox" }, op);
    expect(r).toEqual({ ok: false, errors: ["Disconnect QuickBooks before changing the Client ID or the environment."] });
    expect(await saveQboApp({ clientId: "stub-client-id", clientSecret: "a-new-secret-value-123", environment: "sandbox" }, op)).toEqual({ ok: true });
  });

  it("disconnects: asks Intuit to revoke, forgets the tokens, keeps the keys", async () => {
    await seedConnected(stub);
    expect(await disconnect(op)).toEqual({ ok: true, revoked: true });
    const revoke = stub.calls.filter((c) => c.path === "/revoke");
    expect(revoke).toHaveLength(1);
    expect(revoke[0]).toMatchObject({ method: "POST", auth: `Basic ${Buffer.from("stub-client-id:stub-secret").toString("base64")}` });
    expect(JSON.parse(revoke[0]!.body)).toEqual({ token: "rt-seed" });
    expect(stub.refreshTokens.has("rt-seed")).toBe(false); // revoked at the stub, as at Intuit
    expect(await row()).toMatchObject({ clientId: "stub-client-id", realmId: null, accessTokenCiphertext: null, refreshTokenCiphertext: null, companyName: null });
    expect((await audits("quickbooks.disconnect"))[0]).toMatchObject({ before: { companyName: "Stub Boosters" }, after: { revoked: true } });
    expect(await connectionView()).toMatchObject({ configured: true, connected: false });
    expect(await disconnect(op)).toEqual({ ok: false, reason: "not_connected" });
  });

  it("disconnects here even when Intuit can't be reached, and records that nothing was revoked", async () => {
    await seedConnected(stub);
    const real = stubBase.url;
    stubBase.url = "http://127.0.0.1:1"; // nothing listens there
    try {
      expect(await disconnect(op)).toEqual({ ok: true, revoked: false });
    } finally { stubBase.url = real; }
    expect(await row()).toMatchObject({ clientId: "stub-client-id", realmId: null, accessTokenCiphertext: null, refreshTokenCiphertext: null });
    expect((await audits("quickbooks.disconnect"))[0]).toMatchObject({ after: { revoked: false } });
  });

  it("disconnects here when the saved keys can't be read, without asking Intuit", async () => {
    await seedConnected(stub);
    await db.update(qboConnection).set({ clientSecretKeyId: "00000000" });
    expect(await disconnect(op)).toEqual({ ok: true, revoked: false });
    expect(stub.calls).toHaveLength(0);
    expect(await row()).toMatchObject({ realmId: null, refreshTokenCiphertext: null });
    expect((await audits("quickbooks.disconnect"))[0]).toMatchObject({ after: { revoked: false } });
  });

  it("the stub, like Intuit, refuses a token or revoke request that doesn't carry an app's keys", async () => {
    const post = (path: string, authorization?: string) => fetch(`${stub.base}${path}`, { method: "POST", body: "grant_type=refresh_token&refresh_token=rt-seed", headers: authorization ? { authorization } : {} });
    stub.refreshTokens.add("rt-seed");
    for (const path of ["/token", "/revoke"]) {
      expect((await post(path)).status).toBe(401);
      expect((await post(path, "Bearer at-seed")).status).toBe(401);
      expect((await post(path, `Basic ${Buffer.from("no-secret:").toString("base64")}`)).status).toBe(401);
    }
    expect(stub.refreshTokens.has("rt-seed")).toBe(true);
  });
});
