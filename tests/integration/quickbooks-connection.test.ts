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
const audits = async (action: string) => (await db.select().from(auditLog)).filter((r) => r.action === action);
const allAuditText = async () => JSON.stringify(await db.select().from(auditLog));
const row = async () => (await db.select().from(qboConnection))[0]!;

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
    return completeConnect({ code: "code-1", realmId: REALM, error: null, state, ...extra }, { staffUserId: admin.id, actor: op.actor, ip: op.ip });
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
    expect((await audits("quickbooks.connect"))[0]).toMatchObject({ after: { companyName: "Stub Boosters", realmId: REALM, environment: "sandbox" }, ip: "203.0.113.9" });
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
    expect((await audits("quickbooks.connect_refused"))[0]).toMatchObject({ after: { reason: "state" } });
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
    expect((await audits("quickbooks.connect_refused"))[0]).toMatchObject({ after: { reason: "denied" } });
  });

  it("refuses a different company than the one connected, and keeps the connection", async () => {
    await seedConnected(stub, { realmId: REALM });
    const before = await row();
    expect(await finish(await start(), { realmId: "9130000000000002" })).toEqual({ ok: false, reason: "other_company" });
    expect(await row()).toMatchObject({ realmId: REALM, accessTokenCiphertext: before.accessTokenCiphertext });
    expect(stub.tokenCalls()).toHaveLength(0);
  });

  it("refuses when Intuit won't take the code, with Intuit's code and none of its text", async () => {
    await app();
    const s = await start();
    stub.failToken = "invalid_client";
    expect(await finish(s)).toEqual({ ok: false, reason: "intuit" });
    expect((await audits("quickbooks.connect_refused"))[0]).toMatchObject({ after: { reason: "intuit", code: "invalid_client" } });
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
    expect(stub.calls.some((c) => c.path === "/revoke" && c.method === "POST" && JSON.parse(c.body).token === "rt-seed")).toBe(true);
    expect(await row()).toMatchObject({ clientId: "stub-client-id", realmId: null, accessTokenCiphertext: null, refreshTokenCiphertext: null, companyName: null });
    expect((await audits("quickbooks.disconnect"))[0]).toMatchObject({ before: { companyName: "Stub Boosters" }, after: { revoked: true } });
    expect(await connectionView()).toMatchObject({ configured: true, connected: false });
    expect(await disconnect(op)).toEqual({ ok: false, reason: "not_connected" });
  });
});
