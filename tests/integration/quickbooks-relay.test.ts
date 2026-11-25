import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const qboBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${qboBase.url}/authorize`, token: `${qboBase.url}/token`, revoke: `${qboBase.url}/revoke`,
    api: { sandbox: qboBase.url, production: qboBase.url } }) };
});
const relayBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/relay-address", () => ({ qboRelayUrl: () => relayBase.url }));

const who = vi.hoisted(() => ({ staff: null as null | { door: "staff"; staffUserId: string; name: string; email: string }, sessionOnly: false }));
vi.mock("@/lib/auth/identity", () => ({
  getStaffIdentity: async () => who.staff, hasStaffSession: async () => who.sessionOnly || Boolean(who.staff),
  getParentIdentity: async () => null, getParentState: async () => ({ status: "none" }), hasParentSession: async () => false,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.44" }), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw Object.assign(new Error("NEXT_NOT_FOUND"), { notFound: true }); },
}));

import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, qboConnection, qboRelay, role, roleAssignment, roleRule, setting } from "@/lib/db/schema";
import { secretBox } from "@/lib/crypto/secret-box";
import { beginConnectAction, disconnectAction, saveConnectModeAction, switchConnectAction } from "@/app/staff/(app)/settings/quickbooks/actions";
import QuickBooksSetupPage from "@/app/staff/(app)/settings/quickbooks/setup/page";
import QuickBooksSettingsPage from "@/app/staff/(app)/settings/quickbooks/page";
import SwitchCompanyPage from "@/app/staff/(app)/settings/quickbooks/switch/page";
import { GET as relayCallback } from "@/app/api/quickbooks/relay/callback/route";
import { GET as intuitCallback } from "@/app/api/quickbooks/callback/route";
import { beginConnect, beginSwitchConnect, completeConnect, completeRelayConnect, connectionView } from "@/lib/quickbooks/connection";
import { accessToken } from "@/lib/quickbooks/client";
import { QboError } from "@/lib/quickbooks/endpoints";
import { readRelayMark } from "@/lib/quickbooks/relay";
import { setRosterSource, SWITCH_KEY } from "@/lib/roster/source";
import { resetDb, seedStaff } from "../helpers/db";
import { seedConnected, startQboStub, type QboStub } from "../helpers/qbo-stub";
import { seedRelayRegistration, startRelayStub, TEST_PORTAL_ID, type RelayStub } from "../helpers/relay-stub";

/**
 * Connect and refresh through Boosters Rocket Connect, the relay (slice 3 of
 * docs/superpowers/plans/2026-11-24-connect-through-boosters-rocket.md; spec §5 "Connect" and "Refresh", §8 "Connect" and
 * "Refresh"), against the fake relay (tests/helpers/relay-stub.ts) and the Intuit stub behind it for the company's name,
 * the roster and the own app's revoke.
 */
let qbo: QboStub, relay: RelayStub;
beforeAll(async () => {
  [qbo, relay] = await Promise.all([startQboStub(), startRelayStub()]);
  qboBase.url = qbo.base; relayBase.url = relay.base;
});
afterAll(async () => { await Promise.all([qbo.close(), relay.close()]); });

const A = "9130000000000001", B = "9130000000000002";
const OWN_KEYS = `Basic ${Buffer.from("stub-client-id:stub-secret").toString("base64")}`;
const form = (o: Record<string, string | string[]>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) f.append(k, x); return f; };
const redirectOf = async (p: Promise<unknown>) => ((await p.catch((e: { url?: string }) => e)) as { url?: string }).url;
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const row = async () => (await db.select().from(qboConnection))[0]!;
const relayCalls = (path: string) => relay.calls.filter((c) => c.path === path);
const intuitRevokes = () => qbo.calls.filter((c) => c.path === "/revoke");
const openRefresh = (c: { refreshTokenCiphertext: string | null; refreshTokenKeyId: string | null }) => secretBox().open({ ciphertext: c.refreshTokenCiphertext!, keyId: c.refreshTokenKeyId! }, "qbo:refresh-token");
const where = (res: Response) => { const u = new URL(res.headers.get("location")!); return u.pathname + u.search; };
const callbackUrl = (q: Record<string, string>) => new Request(`http://localhost:3100/api/quickbooks/relay/callback?${new URLSearchParams(q)}`, { headers: { "cf-connecting-ip": "203.0.113.44" } });
const setupHtml = async (q: Record<string, string>) => renderToStaticMarkup(await QuickBooksSetupPage({ searchParams: Promise.resolve(q) }));
const switchHtml = async (q: Record<string, string> = {}) => renderToStaticMarkup(await SwitchCompanyPage({ searchParams: Promise.resolve(q) }));
/** Disconnected, as the switch page requires, keeping the environment and the roster's company. */
const disconnectedKeepingEnvironment = () => db.update(qboConnection).set({ realmId: null, refreshTokenCiphertext: null, refreshTokenKeyId: null, accessTokenCiphertext: null, accessTokenKeyId: null, tokenMode: null, companyName: null });

describe("connecting through Boosters Rocket", () => {
  let admin: Awaited<ReturnType<typeof seedStaff>>;
  let op: { actor: { door: "staff"; id: string; label: string }; ip: string; permission: string };
  const connectOp = () => ({ staffUserId: admin.id, actor: op.actor, ip: op.ip, permission: op.permission });
  beforeEach(async () => {
    who.sessionOnly = false;
    await resetDb(); qbo.reset(); relay.reset();
    // The tokens the fake relay issues are the ones the Intuit stub's API accepts.
    for (let i = 1; i <= 8; i++) qbo.accessTokens.add(`relay-at-${i}`);
    admin = await seedStaff({ email: "admin@club.org", name: "Admin Person", admin: true });
    who.staff = { door: "staff", staffUserId: admin.id, name: admin.name, email: admin.email };
    op = { actor: { door: "staff", id: admin.id, label: admin.email }, ip: "203.0.113.44", permission: "Settings.QuickBooks.ReadWrite" };
  });

  /** Connect pressed with this QuickBooks: answers the relay's go address, or the redirect back to the steps. */
  const press = (environment: string | null = "sandbox") => redirectOf(beginConnectAction(environment === null ? form({}) : form({ environment })));
  /** The state the portal sent the relay with the latest start: the relay returns it with the browser. */
  const sentState = () => relayCalls("/v1/connect/start").at(-1)!.body!.portal_state as string;
  /** Connect, then the relay's return for this company, through the callback route. */
  const connect = async (realmId = A, o: { environment?: string } = {}) => {
    expect(await press(o.environment ?? "sandbox")).toMatch(new RegExp(`^${relay.base}/v1/connect/go/`));
    const state = sentState();
    return relayCallback(callbackUrl({ code: relay.grantFor(state, realmId, { environment: o.environment ?? "sandbox" }), state }));
  };

  it("a first connect starts at the relay, redeems the return server to server and stores the tokens as the relay's", async () => {
    await seedRelayRegistration(relay);
    const go = await press("sandbox");
    expect(go).toMatch(new RegExp(`^${relay.base}/v1/connect/go/[A-Za-z0-9_-]{43}$`));
    // The state is made for the relay, and sent to it signed, with the QuickBooks chosen (saved on the row with the press).
    const start = relayCalls("/v1/connect/start");
    expect(start.map((c) => [c.portal, c.status, Object.keys(c.body!).sort()])).toEqual([[TEST_PORTAL_ID, 200, ["environment", "portal_state"]]]);
    expect(start[0]!.body!.environment).toBe("sandbox");
    expect(await row()).toMatchObject({ connectMode: "relay", stateMode: "relay", relayEnvironment: "sandbox", environment: null, stateStaffUserId: admin.id, tokenMode: null });
    expect((await row()).stateHash).not.toBe(sentState());

    const state = sentState(), code = relay.grantFor(state, A);
    const res = await relayCallback(callbackUrl({ code, state }));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(where(res)).toBe("/staff/settings/quickbooks/setup?step=shape");
    const c = await row();
    expect(c).toMatchObject({ realmId: A, tokenMode: "relay", connectMode: "relay", companyName: "Stub Boosters", connectedBy: admin.id, stateHash: null, stateMode: null, clientId: null });
    expect(openRefresh(c)).toBe("relay-rt-1");
    expect(c.accessTokenCiphertext).not.toContain("relay-at-1");
    expect(relayCalls("/v1/connect/redeem").map((x) => x.body)).toEqual([{ code }]);
    expect((await audits("quickbooks.relay.connect"))).toMatchObject([{ actorId: admin.id, ip: "203.0.113.44", permission: "Settings.QuickBooks.ReadWrite",
      after: { companyName: "Stub Boosters", realmId: A, environment: "sandbox", movedFromOwnApp: false } }]);
    expect(await audits("quickbooks.connect")).toHaveLength(0);
    // Nothing revoked or forgotten; the roster read for the first time.
    expect(intuitRevokes()).toHaveLength(0);
    expect(relay.revoked).toEqual([]); expect(relay.forgotten).toEqual([]);
    expect((await audits("roster.refresh")).at(-1)).toMatchObject({ actorId: admin.id });
    // No token in any address, the portal's or the relay's; none in the audit log.
    const text = JSON.stringify(await db.select().from(auditLog));
    for (const secret of ["relay-at-1", "relay-rt-1", code, state]) { expect(text).not.toContain(secret); expect(res.headers.get("location")).not.toContain(secret); expect(go).not.toContain(secret); }
    expect(await connectionView()).toMatchObject({ connected: true, tokenMode: "relay", environment: "sandbox" });
  });

  it("makes the connection row for a club that has none yet, with the QuickBooks chosen", async () => {
    await seedRelayRegistration(relay);
    expect(await db.select().from(qboConnection)).toHaveLength(0);
    await press("production");
    expect(await row()).toMatchObject({ relayEnvironment: "production", environment: null, connectMode: "relay", stateMode: "relay", clientId: null });
    expect(relayCalls("/v1/connect/start")[0]!.body!.environment).toBe("production");
  });

  it.each([
    ["a wrong state", async () => "x".repeat(43)],
    ["no state", async () => null],
    ["a state more than 10 minutes old", async (s: string) => { await db.update(qboConnection).set({ stateExpiresAt: new Date(Date.now() - 1000) }); return s; }],
    ["a state another Admin started", async () => {
      const other = await seedStaff({ email: "other@club.org", admin: true });
      await beginConnect(other.id, { environment: "sandbox" });
      return relayCalls("/v1/connect/start").at(-1)!.body!.portal_state as string;
    }],
    ["a state made for the club's own Intuit app", async (s: string) => { await db.update(qboConnection).set({ stateMode: "own_app" }); return s; }],
  ])("refuses %s, redeems nothing and stores nothing", async (_name, make) => {
    await seedRelayRegistration(relay);
    await press();
    const s = await make(sentState());
    const res = await relayCallback(callbackUrl({ code: relay.grantFor(s ?? "none", A), ...(s ? { state: s } : {}) }));
    expect(where(res)).toBe("/staff/settings/quickbooks/setup?step=connect&error=state");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(relayCalls("/v1/connect/redeem")).toHaveLength(0);
    expect((await row()).realmId).toBeNull();
    expect((await audits("quickbooks.relay.connect_refused")).map((a) => a.after)).toEqual([{ reason: "state" }]);
  });

  it("a state works once", async () => {
    await seedRelayRegistration(relay);
    await press();
    const state = sentState();
    expect(where(await relayCallback(callbackUrl({ code: relay.grantFor(state, A), state })))).toBe("/staff/settings/quickbooks/setup?step=shape");
    expect(where(await relayCallback(callbackUrl({ code: relay.grantFor(state, A), state })))).toBe("/staff/settings/quickbooks/setup?step=connect&error=state");
    expect(relayCalls("/v1/connect/redeem")).toHaveLength(1);
  });

  it("a state made for the relay doesn't finish at Intuit's own callback, and an own-app state doesn't finish at the relay's", async () => {
    await seedRelayRegistration(relay);
    await press();
    expect(await completeConnect({ code: "code-1", state: sentState(), realmId: A, error: null }, connectOp())).toEqual({ ok: false, reason: "state" });
    expect(qbo.tokenCalls()).toHaveLength(0);

    await resetDb(); relay.reset();
    await seedConnected(qbo, { realmId: A });
    const r = await beginConnect(admin.id);
    expect(r.ok && new URL(r.url).origin).toBe(new URL(qbo.base).origin);
    const ownState = r.ok ? new URL(r.url).searchParams.get("state")! : "";
    expect((await row()).stateMode).toBe("own_app");
    expect(await completeRelayConnect({ code: relay.grantFor(ownState, A), state: ownState, error: null }, connectOp())).toEqual({ ok: false, reason: "state" });
    expect(relay.calls).toHaveLength(0);
  });

  it.each([
    ["access_denied", "denied"],
    ["denied", "denied"],
    ["intuit", "intuit"],
  ])("Intuit's or the relay's error=%s comes back as %s, spends the state and redeems nothing", async (error, reason) => {
    await seedRelayRegistration(relay);
    await press();
    const state = sentState();
    const res = await relayCallback(callbackUrl({ error, state }));
    expect(where(res)).toBe(`/staff/settings/quickbooks/setup?step=connect&error=${reason}`);
    expect((await row()).stateHash).toBeNull();
    expect(relayCalls("/v1/connect/redeem")).toHaveLength(0);
    expect((await audits("quickbooks.relay.connect_refused")).map((a) => a.after)).toEqual([{ reason }]);
    const html = await setupHtml({ step: "connect", error: reason });
    expect(html).toContain(reason === "intuit" ? "Intuit didn&#x27;t finish the connection with Boosters Rocket." : "Intuit didn&#x27;t give the portal access.");
    // A code sent beside an error is never redeemed either.
    await press();
    const again = sentState();
    expect(where(await relayCallback(callbackUrl({ error, state: again, code: relay.grantFor(again, A) })))).toContain("error=");
    expect(relayCalls("/v1/connect/redeem")).toHaveLength(0);
  });

  it.each([
    ["is for another attempt", (state: string) => relay.grantFor(`${state.slice(0, -1)}x`, A)],
    ["is for the other QuickBooks", (state: string) => relay.grantFor(state, A, { environment: "production" })],
    ["is late", (state: string) => relay.grantFor(state, A, { expiresInMs: -1 })],
    ["is another portal's", (state: string) => relay.grantFor(state, A, { portalId: "brp_another0portal01" })],
    ["isn't a code", () => "not a code!"],
  ])("refuses a redemption that %s as relay_code, storing nothing and forgetting nothing", async (_name, codeFor) => {
    await seedRelayRegistration(relay);
    await press();
    const state = sentState();
    const res = await relayCallback(callbackUrl({ code: codeFor(state), state }));
    expect(where(res)).toBe("/staff/settings/quickbooks/setup?step=connect&error=relay_code");
    expect(await row()).toMatchObject({ realmId: null, tokenMode: null, refreshTokenCiphertext: null });
    expect(relay.forgotten).toEqual([]);
    expect((await audits("quickbooks.relay.connect_refused"))[0]!.after).toEqual({ reason: "relay_code", code: "relay_code" });
    expect(await setupHtml({ step: "connect", error: "relay_code" })).toContain("That connection took too long to finish. Press Connect to QuickBooks again.");
  });

  it("another company than the one connected is other_company: the tokens are dropped, nothing is revoked, and the relay forgets it", async () => {
    await seedRelayRegistration(relay);
    await connect(A);
    const before = await row();
    const res = await connect(B);
    expect(where(res)).toBe("/staff/settings/quickbooks/setup?step=connect&error=other_company");
    expect(await row()).toMatchObject({ realmId: A, refreshTokenCiphertext: before.refreshTokenCiphertext, tokenMode: "relay" });
    expect(intuitRevokes()).toHaveLength(0);
    expect(relayCalls("/v1/token/revoke")).toHaveLength(0);
    expect(relay.revoked).toEqual([]);
    expect(relay.forgotten).toEqual([`sandbox:${B}`]);
    expect(relayCalls("/v1/connection/forget").map((c) => c.body)).toEqual([{ environment: "sandbox", realm_id: B }]);
    expect((await audits("quickbooks.relay.connect_refused")).map((a) => a.after)).toEqual([{ reason: "other_company", revoked: false, why: "shared_grant", forgotten: true }]);
  });

  describe("a registration changed while the code was being redeemed", () => {
    const OTHER_ID = "brp_another0portal01";

    it("a new portal id: the tokens are thrown away, nothing revoked, and the forget is sent under the id that redeemed them", async () => {
      await seedRelayRegistration(relay);
      await press();
      const state = sentState();
      relay.portals.set(OTHER_ID, relay.portals.get(TEST_PORTAL_ID)!); // the same key, registered again under a new id
      relay.beforeAnswer = { path: "/v1/connect/redeem", run: async () => { await db.update(qboRelay).set({ portalId: OTHER_ID }); } };
      const res = await relayCallback(callbackUrl({ code: relay.grantFor(state, A), state }));
      expect(where(res)).toBe("/staff/settings/quickbooks/setup?step=connect&error=state");
      expect(await row()).toMatchObject({ realmId: null, tokenMode: null, refreshTokenCiphertext: null });
      expect(relayCalls("/v1/token/revoke")).toHaveLength(0);
      expect(intuitRevokes()).toHaveLength(0);
      expect(relayCalls("/v1/connection/forget").map((c) => [c.portal, c.body])).toEqual([[TEST_PORTAL_ID, { environment: "sandbox", realm_id: A }]]);
      expect((await audits("quickbooks.relay.connect_refused")).map((a) => a.after)).toEqual([{ reason: "state", revoked: false, why: "shared_grant", forgotten: true, registrationChanged: true }]);
    });

    it("a new key: the tokens are thrown away and nothing is sent, since nothing here can sign for the old key", async () => {
      await seedRelayRegistration(relay);
      await press();
      const state = sentState();
      const { newRelayKey } = await import("@/lib/quickbooks/relay-sign");
      const key = await newRelayKey(), sealed = secretBox().seal(key.privateKeyPkcs8, "qbo:relay-key");
      relay.beforeAnswer = { path: "/v1/connect/redeem", run: async () => {
        await db.update(qboRelay).set({ publicKey: key.publicKey, privateKeyCiphertext: sealed.ciphertext, privateKeyKeyId: sealed.keyId });
      } };
      const res = await relayCallback(callbackUrl({ code: relay.grantFor(state, A), state }));
      expect(where(res)).toBe("/staff/settings/quickbooks/setup?step=connect&error=state");
      expect(await row()).toMatchObject({ realmId: null, tokenMode: null, refreshTokenCiphertext: null });
      expect(relay.calls.map((c) => c.path)).toEqual(["/v1/connect/start", "/v1/connect/redeem"]);
      expect(intuitRevokes()).toHaveLength(0);
      expect((await audits("quickbooks.relay.connect_refused")).map((a) => a.after)).toEqual([{ reason: "state", revoked: false, why: "shared_grant", forgotten: false, registrationChanged: true }]);
    });
  });

  it("another company than the roster's, with no switch asked for, is roster_company, and the relay forgets it", async () => {
    await seedRelayRegistration(relay);
    await db.transaction((tx) => setRosterSource(tx, A));
    await press();
    const state = sentState();
    const res = await relayCallback(callbackUrl({ code: relay.grantFor(state, B), state }));
    expect(where(res)).toBe("/staff/settings/quickbooks/setup?step=connect&error=roster_company");
    expect(await row()).toMatchObject({ realmId: null, refreshTokenCiphertext: null, tokenMode: null });
    expect(relay.forgotten).toEqual([`sandbox:${B}`]);
    expect(intuitRevokes()).toHaveLength(0);
    expect(relay.revoked).toEqual([]);
    expect((await audits("quickbooks.relay.connect_refused")).map((a) => a.after)).toEqual([{ reason: "roster_company", revoked: false, why: "shared_grant", forgotten: true }]);
  });

  it("a switch through the relay, asked for on the switch page, connects the other company and clears the old one's", async () => {
    await seedRelayRegistration(relay);
    await connect(A);
    expect((await db.select().from(setting).where(eq(setting.key, "roster.source")))[0]?.value).toEqual({ realmId: A });
    await disconnectedKeepingEnvironment();
    const go = await redirectOf(switchConnectAction(form({ confirm: "yes", environment: "sandbox" })));
    expect(go).toMatch(new RegExp(`^${relay.base}/v1/connect/go/`));
    expect(await audits("quickbooks.switch.asked")).toMatchObject([{ after: { fromRealmId: A } }]);
    const state = sentState();
    const res = await relayCallback(callbackUrl({ code: relay.grantFor(state, B), state }));
    expect(where(res)).toBe("/staff/settings/quickbooks/setup?step=shape");
    expect(await row()).toMatchObject({ realmId: B, tokenMode: "relay" });
    expect((await audits("quickbooks.relay.connect")).at(-1)!.after).toMatchObject({ realmId: B, switchedFrom: A, movedFromOwnApp: false });
    // The clear ran and spent the switch: nothing of it is left.
    expect(await db.select().from(setting).where(eq(setting.key, SWITCH_KEY))).toHaveLength(0);
    expect(relay.forgotten).toEqual([]);
  });

  // The owner's finding of 2026-11-25: a switch through the relay silently reused the saved QuickBooks, so a move from a
  // sandbox to the club's real books started a sandbox connect. The switch page now asks, as step 2 does.
  describe("which QuickBooks a switch connects to", () => {
    const SWITCH = "/staff/settings/quickbooks/switch";
    beforeEach(async () => {
      await seedRelayRegistration(relay);
      await connect(A); // the sandbox, saved
      await disconnectedKeepingEnvironment();
    });

    it("the switch page asks which QuickBooks, step 2's choice in step 2's words, the saved one chosen first", async () => {
      const html = await switchHtml();
      expect(html).toContain("<legend>Which QuickBooks</legend>");
      expect(html).toContain("The club&#x27;s real books");
      expect(html).toContain("An Intuit sandbox (test) company");
      expect(html).toContain(`name="environment" checked="" value="sandbox"`);
      expect(html).not.toContain(`name="environment" checked="" value="production"`);
      expect(html).not.toContain("disconnect first, from QuickBooks settings."); // not locked: nothing is connected
      expect(html).not.toContain("The club&#x27;s Intuit app is set to");
      expect(await switchHtml({ error: "environment" })).toContain("Choose which QuickBooks to connect: the club&#x27;s real books or an Intuit sandbox (test) company.");
    });

    it("takes the real books while the sandbox is saved, saves it for this connect, and the ask still holds", async () => {
      const go = await redirectOf(switchConnectAction(form({ confirm: "yes", environment: "production" })));
      expect(go).toMatch(new RegExp(`^${relay.base}/v1/connect/go/`));
      expect(relayCalls("/v1/connect/start").at(-1)!.body!.environment).toBe("production");
      expect(await row()).toMatchObject({ relayEnvironment: "production", stateMode: "relay", stateStaffUserId: admin.id });
      expect(await audits("quickbooks.switch.asked")).toMatchObject([{ actorId: admin.id, after: { fromRealmId: A } }]);
      // The relay returns a grant for the real books' company; the ask lets it store another company, and the clear runs.
      const state = sentState();
      const res = await relayCallback(callbackUrl({ code: relay.grantFor(state, B, { environment: "production" }), state }));
      expect(where(res)).toBe("/staff/settings/quickbooks/setup?step=shape");
      expect(await row()).toMatchObject({ realmId: B, tokenMode: "relay", relayEnvironment: "production" });
      expect((await audits("quickbooks.relay.connect")).at(-1)!.after).toMatchObject({ realmId: B, environment: "production", switchedFrom: A });
      expect(await db.select().from(setting).where(eq(setting.key, SWITCH_KEY))).toHaveLength(0);
      expect(await connectionView()).toMatchObject({ connected: true, environment: "production" });
    });

    it("refuses a choice missing, sent twice or not one of the two, back to the switch page, changing nothing", async () => {
      const starts = relayCalls("/v1/connect/start").length, before = await row();
      for (const bad of [form({ confirm: "yes" }), form({ confirm: "yes", environment: "staging" }), form({ confirm: "yes", environment: ["production", "sandbox"] }), form({ confirm: "yes", environment: "x".repeat(21) })]) {
        expect(await redirectOf(switchConnectAction(bad))).toBe(`${SWITCH}?error=environment`);
      }
      expect(relayCalls("/v1/connect/start")).toHaveLength(starts);
      expect(await row()).toMatchObject({ relayEnvironment: "sandbox", stateHash: before.stateHash, stateMode: before.stateMode });
      expect(await db.select().from(setting).where(eq(setting.key, SWITCH_KEY))).toHaveLength(0);
      expect(await audits("quickbooks.switch.asked")).toEqual([]);
      // Called with a value that isn't one of the two, the start itself refuses it, as step 2's does.
      expect(await beginSwitchConnect(admin.id, op, "staging" as never)).toEqual({ ok: false, reason: "environment" });
      expect(await beginConnect(admin.id, { environment: "staging" as never, op })).toEqual({ ok: false, reason: "environment" });
      expect(relayCalls("/v1/connect/start")).toHaveLength(starts);
      expect((await row()).relayEnvironment).toBe("sandbox");
      expect(await audits("quickbooks.switch.asked")).toEqual([]);
    });

    it("an unchecked box is still refused first, whatever QuickBooks is chosen", async () => {
      expect(await redirectOf(switchConnectAction(form({ environment: "production" })))).toBe(`${SWITCH}?error=confirm`);
      expect((await row()).relayEnvironment).toBe("sandbox");
    });
  });

  it("renewing through the relay replaces the tokens and revokes nothing anywhere", async () => {
    await seedRelayRegistration(relay);
    await connect(A);
    expect(where(await connect(A))).toBe("/staff/settings/quickbooks/setup?step=shape");
    const c = await row();
    expect(c).toMatchObject({ realmId: A, tokenMode: "relay" });
    expect(openRefresh(c)).not.toBe("relay-rt-1");
    expect(intuitRevokes()).toHaveLength(0);
    expect(relayCalls("/v1/token/revoke")).toHaveLength(0);
    expect(relay.forgotten).toEqual([]);
    expect(await audits("quickbooks.relay.old_grant_revoked")).toHaveLength(0);
    expect((await audits("quickbooks.relay.connect")).map((a) => (a.after as { movedFromOwnApp: boolean }).movedFromOwnApp)).toEqual([false, false]);
  });

  it("a relay connect started for the sandbox and left never changes the QuickBooks the club's own app's keys are for", async () => {
    const { saveQboApp } = await import("@/lib/quickbooks/connection");
    await saveQboApp({ clientId: "ABclientid1234567890", clientSecret: "s3cret-value-1234567890", environment: "production" }, op);
    await seedRelayRegistration(relay);
    expect(await saveConnectModeAction(form({ mode: "relay" }))).toMatchObject({ ok: true });
    expect(await press("sandbox")).toMatch(new RegExp(`^${relay.base}/v1/connect/go/`));
    // The relay's choice is kept in its own column; the own app's stays as its keys were saved.
    expect(await row()).toMatchObject({ environment: "production", relayEnvironment: "sandbox", stateMode: "relay" });
    // Left unfinished, and back to the club's own app.
    expect(await saveConnectModeAction(form({ mode: "own_app" }))).toMatchObject({ ok: true });
    expect(await row()).toMatchObject({ connectMode: "own_app", environment: "production", stateMode: null });
    expect(await connectionView()).toMatchObject({ connectMode: "own_app", environment: "production", ownAppEnvironment: "production" });
    const html = await setupHtml({ step: "app" });
    expect(html).toContain(`name="environment" checked="" value="production"`);
    expect((await beginConnect(admin.id)).ok).toBe(true);
    expect(await row()).toMatchObject({ environment: "production", stateMode: "own_app" });
  });

  describe("moving from the club's own Intuit app", () => {
    beforeEach(async () => {
      await seedConnected(qbo, { realmId: A }); // own-app tokens (rt-seed) under the app's keys
      await seedRelayRegistration(relay);
      expect(await saveConnectModeAction(form({ mode: "relay" }))).toMatchObject({ ok: true });
    });

    it("stores the relay's tokens first, then revokes the old grant at Intuit with the old keys", async () => {
      // Until the Admin connects again, the own app keeps refreshing.
      expect(await connectionView()).toMatchObject({ connectMode: "relay", tokenMode: "own_app" });
      expect(await setupHtml({ step: "connect" })).toContain("Connecting through Boosters Rocket to the same company moves it over");
      const res = await connect(A);
      expect(where(res)).toBe("/staff/settings/quickbooks/setup?step=shape");
      const c = await row();
      expect(c).toMatchObject({ realmId: A, tokenMode: "relay", connectMode: "relay", clientId: "stub-client-id" }); // the keys stay, to move back
      expect(openRefresh(c)).toBe("relay-rt-1");
      expect(intuitRevokes()).toHaveLength(1);
      expect(intuitRevokes()[0]).toMatchObject({ method: "POST", auth: OWN_KEYS });
      expect(JSON.parse(intuitRevokes()[0]!.body)).toEqual({ token: "rt-seed" });
      expect(qbo.refreshTokens.has("rt-seed")).toBe(false);
      expect(relay.forgotten).toEqual([]);
      expect((await audits("quickbooks.relay.old_grant_revoked")).map((a) => a.after)).toEqual([{ realmId: A, revoked: true }]);
      expect((await audits("quickbooks.relay.connect")).at(-1)!.after).toMatchObject({ realmId: A, movedFromOwnApp: true });
      // The old grant's revoke came after the store: the audit rows are in that order.
      const order = (await db.select().from(auditLog).orderBy(auditLog.id)).map((a) => a.action).filter((a) => a.startsWith("quickbooks.relay."));
      expect(order).toEqual(["quickbooks.relay.old_grant_revoked", "quickbooks.relay.connect"]);
    });

    it("when Intuit doesn't confirm the old grant's revoke, the connection stands and step 3 says the old app may still be listed", async () => {
      qbo.failRevoke = true;
      const res = await connect(A);
      expect(where(res)).toBe("/staff/settings/quickbooks/setup?step=shape&moved=old_access_kept");
      expect(await row()).toMatchObject({ realmId: A, tokenMode: "relay" });
      expect((await audits("quickbooks.relay.old_grant_revoked")).map((a) => a.after)).toEqual([{ realmId: A, revoked: false }]);
      expect(await setupHtml({ step: "shape", moved: "old_access_kept" })).toContain("That app may still be listed in QuickBooks&#x27; Apps list");
      expect(await setupHtml({ step: "shape", moved: "something" })).not.toContain("Apps list");
    });

    it("a failed store revokes nothing anywhere and forgets nothing, so the own app's connection carries on", async () => {
      expect(await press()).toMatch(new RegExp(`^${relay.base}/`));
      const state = sentState();
      const client = await import("@/lib/quickbooks/client");
      const spy = vi.spyOn(client, "sealTokens").mockImplementationOnce(() => { throw new Error("the database went away"); });
      try {
        await expect(completeRelayConnect({ code: relay.grantFor(state, A), state, error: null }, connectOp())).rejects.toThrow("the database went away");
      } finally { spy.mockRestore(); }
      expect(intuitRevokes()).toHaveLength(0);
      expect(relayCalls("/v1/token/revoke")).toHaveLength(0);
      expect(relay.forgotten).toEqual([]);
      const c = await row();
      expect(c).toMatchObject({ realmId: A, tokenMode: "own_app" });
      expect(openRefresh(c)).toBe("rt-seed");
      expect((await audits("quickbooks.relay.connect_refused")).map((a) => a.after)).toEqual([{ reason: "store_failed", revoked: false, why: "shared_grant" }]);
    });
  });

  it("a failed store on a first connect revokes nothing, and forgets the company at the relay", async () => {
    await seedRelayRegistration(relay);
    await press();
    const state = sentState();
    const client = await import("@/lib/quickbooks/client");
    const spy = vi.spyOn(client, "sealTokens").mockImplementationOnce(() => { throw new Error("the database went away"); });
    try {
      await expect(completeRelayConnect({ code: relay.grantFor(state, A), state, error: null }, connectOp())).rejects.toThrow("the database went away");
    } finally { spy.mockRestore(); }
    expect(intuitRevokes()).toHaveLength(0);
    expect(relay.revoked).toEqual([]);
    expect(relay.forgotten).toEqual([`sandbox:${A}`]);
    expect((await audits("quickbooks.relay.connect_refused")).map((a) => a.after)).toEqual([{ reason: "store_failed", revoked: false, why: "shared_grant", forgotten: true }]);
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain("the database went away");
  });

  describe("the start", () => {
    beforeEach(async () => { await seedRelayRegistration(relay); });

    it.each([
      ["a go address off the relay", () => { relay.oddAnswer = { path: "/v1/connect/start", body: { url: "https://evil.example/v1/connect/go/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG" } }; }, "relay_refused", "relay_refused"],
      ["a go address with a query", () => { relay.oddAnswer = { path: "/v1/connect/start", body: { url: `${relay.base}/v1/connect/go/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG?next=x` } }; }, "relay_refused", "relay_refused"],
      ["a 401", () => { relay.refuseNext = 1; }, "relay_refused", "relay_unauthorized"],
      ["a 429", () => { relay.busyNext = 1; }, "relay_busy", "relay_busy"],
      ["a 502", () => { relay.failNext = 1; }, "relay_unreachable", "relay_unreachable"],
    ])("refuses %s on step 2, audited, and sends the browser nowhere else", async (_name, knob, reason, code) => {
      knob();
      expect(await press()).toBe(`/staff/settings/quickbooks/setup?step=connect&error=${reason}`);
      expect((await audits("quickbooks.relay.connect_refused")).map((a) => a.after)).toEqual([{ reason, step: "start", code, environment: "sandbox" }]);
      expect(await setupHtml({ step: "connect", error: reason })).toContain("Boosters Rocket");
    });

    it("needs the QuickBooks chosen, refuses a value that isn't one, and keeps it while connected", async () => {
      expect(await press(null)).toBe("/staff/settings/quickbooks/setup?step=connect&error=environment");
      expect(await press("staging")).toBe("/staff/settings/quickbooks/setup?step=connect&error=environment");
      expect(await redirectOf(beginConnectAction(form({ environment: ["sandbox", "production"] })))).toBe("/staff/settings/quickbooks/setup?step=connect&error=environment");
      expect(relay.calls).toHaveLength(0);
      await connect(A);
      expect(await press("production")).toBe("/staff/settings/quickbooks/setup?step=connect&error=environment_locked");
      expect((await row()).relayEnvironment).toBe("sandbox");
      // With no choice sent, the one saved.
      expect(await press(null)).toMatch(new RegExp(`^${relay.base}/v1/connect/go/`));
      expect(relayCalls("/v1/connect/start").at(-1)!.body!.environment).toBe("sandbox");
    });
  });

  it("before the portal is registered, Connect goes back to step 1, asking the relay nothing", async () => {
    expect(await press()).toBe("/staff/settings/quickbooks/setup?step=app&error=keys");
    await seedRelayRegistration(relay, { portalId: null });
    expect(await press()).toBe("/staff/settings/quickbooks/setup?step=app&error=keys");
    expect(relay.calls).toHaveLength(0);
    expect(await db.select().from(qboConnection)).toHaveLength(0);
    expect(await setupHtml({ step: "app", error: "keys" })).toContain("Register the portal with Boosters Rocket in step 1 first.");
  });

  describe("the callback route", () => {
    it("sends someone with no staff session to sign in, and a disabled one to /refused, touching nothing", async () => {
      await seedRelayRegistration(relay);
      await press();
      const state = sentState(), code = relay.grantFor(state, A);
      who.staff = null;
      const res = await relayCallback(callbackUrl({ code, state }));
      expect(where(res)).toBe("/staff/sign-in");
      expect(res.headers.get("cache-control")).toBe("no-store");
      who.sessionOnly = true;
      expect(where(await relayCallback(callbackUrl({ code, state })))).toBe("/refused");
      expect(relayCalls("/v1/connect/redeem")).toHaveLength(0);
      expect((await row()).stateHash).not.toBeNull();
    });

    it("refuses staff whose custom role includes everything, audits it, and redeems nothing", async () => {
      await seedRelayRegistration(relay);
      await press();
      const state = sentState();
      const s = await seedStaff({ email: "treasurer@club.org" });
      const [r] = await db.insert(role).values({ key: "everything", name: "Everything" }).returning();
      await db.insert(roleRule).values({ roleId: r!.id, kind: "include", pattern: "*" });
      await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
      who.staff = { door: "staff", staffUserId: s.id, name: s.name, email: s.email };
      const res = await relayCallback(callbackUrl({ code: relay.grantFor(state, A), state }));
      expect(where(res)).toBe("/refused");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect((await audits("access.refused")).map((a) => a.permission)).toEqual(["Settings.QuickBooks.ReadWrite"]);
      expect(relayCalls("/v1/connect/redeem")).toHaveLength(0);
      expect((await row()).realmId).toBeNull();
    });

    it("takes each value once: a code or state sent twice is no code or state", async () => {
      await seedRelayRegistration(relay);
      await press();
      const state = sentState(), code = relay.grantFor(state, A);
      const res = await relayCallback(new Request(`http://localhost:3100/api/quickbooks/relay/callback?code=${code}&code=${code}&state=${state}`));
      expect(where(res)).toBe("/staff/settings/quickbooks/setup?step=connect&error=denied");
      expect(relayCalls("/v1/connect/redeem")).toHaveLength(0);
    });

    it("the Intuit callback still answers an own-app connect as before", async () => {
      const { saveQboApp } = await import("@/lib/quickbooks/connection");
      await saveQboApp({ clientId: "ABclientid1234567890", clientSecret: "s3cret-value-1234567890", environment: "sandbox" }, op);
      const r = await beginConnect(admin.id);
      const state = r.ok ? new URL(r.url).searchParams.get("state")! : "";
      qbo.codes.add("code-1"); qbo.accessTokens.add("at-1");
      const res = await intuitCallback(new Request(`http://localhost:3100/api/quickbooks/callback?${new URLSearchParams({ code: "code-1", state, realmId: A })}`));
      expect(where(res)).toBe("/staff/settings/quickbooks/setup?step=shape");
      expect(await row()).toMatchObject({ realmId: A, tokenMode: "own_app" });
      expect(relay.calls).toHaveLength(0);
    });
  });

  it("step 2 in relay mode asks which QuickBooks and shows the full logo, black and white, as text-free images", async () => {
    await seedRelayRegistration(relay);
    const html = await setupHtml({ step: "connect" });
    expect(html).toContain('<h2 id="qbo-connect-h">Step 2: Connect to QuickBooks</h2>');
    expect(html).toContain(">2. Connect to QuickBooks</a>");
    expect(html).not.toContain("Sign in to Intuit");
    expect(html).toContain("<legend>Which QuickBooks</legend>");
    expect(html).toContain("The club&#x27;s real books");
    expect(html).toContain("An Intuit sandbox (test) company");
    expect(html).toMatch(/<button type="submit"[^>]*>Connect to QuickBooks<\/button>/);
    expect(html).toContain('src="/integrations/quickbooks/qb-logo-black.png"');
    expect(html).toContain('src="/integrations/quickbooks/qb-logo-white.png"');
    expect(html).toContain('class="qb-full-logo"');
    // Connected: the other QuickBooks can't be chosen.
    await connect(A);
    const connected = await setupHtml({ step: "connect" });
    expect(connected).toMatch(/disabled="" name="environment" value="production"/);
    expect(connected).not.toMatch(/disabled="" name="environment" value="sandbox"/);
    expect(connected).toContain("To connect the other, disconnect first");
  });

  it("the QuickBooks page shows a fixed notice for each visit from QuickBooks, and nothing for anything else", async () => {
    const page = async (intuit?: string | string[]) => renderToStaticMarkup(await QuickBooksSettingsPage({ searchParams: Promise.resolve(intuit === undefined ? {} : { intuit }) }));
    expect(await page("disconnected")).toContain("QuickBooks says the portal was disconnected there. Connect again to carry on.");
    expect(await page("connect")).toContain("Connect QuickBooks from the steps below.");
    for (const other of ["<b>x</b>", "toString", "__proto__", ["connect", "connect"]]) {
      const html = await page(other);
      expect(html).not.toContain("QuickBooks says the portal");
      expect(html).not.toContain("Connect QuickBooks from the steps below.");
      expect(html).not.toContain("<b>x</b>");
    }
    expect(await page()).not.toContain("QuickBooks says the portal");
  });
});

describe("refreshing through Boosters Rocket", () => {
  beforeEach(async () => {
    await resetDb(); qbo.reset(); relay.reset();
    await seedRelayRegistration(relay);
  });
  /** A connection through the relay, its access token expired, its refresh token one the relay accepts. */
  const seedRelayConnected = async () => {
    const box = secretBox();
    const access = box.seal("relay-at-old", "qbo:access-token"), refresh = box.seal("relay-rt-old", "qbo:refresh-token");
    relay.refreshTokens.add("relay-rt-old");
    await db.insert(qboConnection).values({ relayEnvironment: "sandbox", connectMode: "relay", tokenMode: "relay", realmId: A, companyName: "Stub Boosters",
      accessTokenCiphertext: access.ciphertext, accessTokenKeyId: access.keyId, accessExpiresAt: new Date(Date.now() - 1000),
      refreshTokenCiphertext: refresh.ciphertext, refreshTokenKeyId: refresh.keyId, refreshExpiresAt: new Date(Date.now() + 86_400_000), connectedAt: new Date() });
  };

  it("stores the relay's new refresh token before the token is used, and asks Intuit nothing", async () => {
    await seedRelayConnected();
    const a = await accessToken();
    expect(a).toEqual({ token: "relay-at-1", realmId: A, environment: "sandbox" });
    expect(relayCalls("/v1/token/refresh").map((c) => c.body)).toEqual([{ environment: "sandbox", refresh_token: "relay-rt-old" }]);
    const c = await row();
    expect(openRefresh(c)).toBe("relay-rt-1");
    expect(relay.refreshTokens.has("relay-rt-old")).toBe(false);
    expect(c.lastTokenRefreshAt).not.toBeNull();
    expect(qbo.tokenCalls()).toHaveLength(0);
    // The token stored is the one used next: the saved access token, with no second refresh.
    expect((await accessToken()).token).toBe("relay-at-1");
    expect(relayCalls("/v1/token/refresh")).toHaveLength(1);
  });

  it("keeps the new refresh token even when the call that asked for it gives up waiting", async () => {
    await seedRelayConnected();
    relay.delayMs = 200;
    const ctrl = new AbortController();
    const { qboGet } = await import("@/lib/quickbooks/client");
    qbo.accessTokens.add("relay-at-1");
    const read = qboGet("companyinfo/1", {}, { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 20);
    await expect(read).rejects.toBeInstanceOf(QboError);
    await vi.waitFor(async () => expect(openRefresh(await row())).toBe("relay-rt-1"), { timeout: 3000 });
    relay.delayMs = 0;
  });

  it("invalid_grant from the relay is Intuit's own: only an Admin can fix it, audited once", async () => {
    await seedRelayConnected();
    relay.refreshError = "invalid_grant";
    await expect(accessToken()).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(accessToken()).rejects.toMatchObject({ code: "invalid_grant" });
    expect(await connectionView()).toMatchObject({ needsAdmin: true, lastError: "Intuit no longer accepts this connection. Connect QuickBooks again. (invalid_grant)" });
    expect((await audits("quickbooks.relay.token_refresh.failed")).map((a) => a.after)).toEqual([{ code: "invalid_grant" }]);
    expect(await audits("quickbooks.token_refresh.failed")).toHaveLength(0);
    expect(openRefresh(await row())).toBe("relay-rt-old");
  });

  it.each([
    ["a 401", () => { relay.refuseNext = 1; }, "relay_unauthorized", "unauthorized"],
    ["a 429", () => { relay.busyNext = 1; }, "relay_busy", "busy"],
    ["a 502", () => { relay.failNext = 1; }, "relay_unreachable", "unreachable"],
  ])("%s doesn't need an Admin, keeps the refresh token, and marks the relay", async (_name, knob, code, word) => {
    await seedRelayConnected();
    knob();
    await expect(accessToken()).rejects.toMatchObject({ code });
    expect((await connectionView()).needsAdmin).toBe(false);
    expect((await readRelayMark())?.lastFailWord).toBe(word);
    expect((await audits("quickbooks.relay.token_refresh.failed")).map((a) => a.after)).toEqual([{ code }]);
    expect(openRefresh(await row())).toBe("relay-rt-old");
    // The next try goes through, and clears the error.
    expect((await accessToken()).token).toBe("relay-at-1");
    expect((await row()).lastError).toBeNull();
    expect((await readRelayMark())?.lastOkAt).not.toBeNull();
  });

  it("an own-app connection with relay chosen for the next Connect still refreshes at Intuit with its own keys", async () => {
    await seedConnected(qbo, { realmId: A, accessExpiresInMs: -1000 });
    await db.update(qboConnection).set({ connectMode: "relay" });
    expect((await accessToken()).token).toBe("at-1");
    expect(qbo.tokenCalls()).toHaveLength(1);
    expect(qbo.tokenCalls()[0]).toMatchObject({ auth: OWN_KEYS });
    expect(relay.calls).toHaveLength(0);
    expect(openRefresh(await row())).toBe("rt-1");
  });
});

/**
 * Disconnect through Boosters Rocket (slice 4; spec §5 "Disconnect", §8 "Disconnect"): every portal on one QuickBooks
 * company through the relay shares one grant, so the Admin must acknowledge that disconnecting may end the others, on
 * the page and on the server; the revoke goes through the relay with the company; the tokens are forgotten whatever it
 * answers.
 */
describe("disconnecting through Boosters Rocket", () => {
  let admin: Awaited<ReturnType<typeof seedStaff>>;
  beforeEach(async () => {
    await resetDb(); qbo.reset(); relay.reset();
    await seedRelayRegistration(relay);
    admin = await seedStaff({ email: "admin@club.org", name: "Admin Person", admin: true });
    who.staff = { door: "staff", staffUserId: admin.id, name: admin.name, email: admin.email };
  });
  const seedRelayConnected = async () => {
    const box = secretBox();
    const access = box.seal("relay-at-held", "qbo:access-token"), refresh = box.seal("relay-rt-held", "qbo:refresh-token");
    relay.refreshTokens.add("relay-rt-held");
    await db.insert(qboConnection).values({ relayEnvironment: "sandbox", connectMode: "relay", tokenMode: "relay", realmId: A, companyName: "Stub Boosters",
      accessTokenCiphertext: access.ciphertext, accessTokenKeyId: access.keyId, accessExpiresAt: new Date(Date.now() + 3_600_000),
      refreshTokenCiphertext: refresh.ciphertext, refreshTokenKeyId: refresh.keyId, refreshExpiresAt: new Date(Date.now() + 86_400_000), connectedAt: new Date() });
  };
  const page = async () => renderToStaticMarkup(await QuickBooksSettingsPage({ searchParams: Promise.resolve({}) }));

  const TICK = "Tick the box to say you understand, then try again.", STALE = "This page is out of date. Reload it and try again.";
  it.each([
    ["no field", form({ drawnFor: "relay" }), TICK],
    ["the box sent twice", form({ ack: ["yes", "yes"], drawnFor: "relay" }), TICK],
    ["another value", form({ ack: "on", drawnFor: "relay" }), TICK],
    // A page drawn while the club's own app held the tokens showed no box: it is out of date, whatever it sends.
    ["a page drawn for the club's own app", form({ drawnFor: "own_app" }), STALE],
    ["a page drawn for the own app, with the box sent anyway", form({ ack: "yes", drawnFor: "own_app" }), STALE],
    ["a page drawn while nothing was connected", form({ ack: "yes", drawnFor: "none" }), STALE],
    ["no page mode", form({ ack: "yes" }), STALE],
    ["the page mode sent twice", form({ ack: "yes", drawnFor: ["relay", "relay"] }), STALE],
    ["nothing at all", undefined, STALE],
  ])("without the acknowledgement (%s) changes nothing and sends nothing", async (_name, f, words) => {
    await seedRelayConnected();
    const before = await row();
    expect(await disconnectAction(f)).toEqual({ ok: false, error: words });
    expect(await row()).toEqual(before);
    expect(relay.calls).toHaveLength(0);
    expect(qbo.calls).toHaveLength(0);
    expect(await audits("quickbooks.relay.disconnect")).toHaveLength(0);
    expect(await audits("quickbooks.disconnect")).toHaveLength(0);
  });

  it("with it, revokes through the relay with the company, forgets the tokens and audits the acknowledgement", async () => {
    await seedRelayConnected();
    expect(await disconnectAction(form({ ack: "yes", drawnFor: "relay" }))).toEqual({ ok: true, revoked: true });
    expect(relayCalls("/v1/token/revoke").map((c) => [c.portal, c.status, c.body])).toEqual([[TEST_PORTAL_ID, 200, { environment: "sandbox", token: "relay-rt-held", realm_id: A }]]);
    expect(relay.revoked).toEqual(["relay-rt-held"]);
    expect(intuitRevokes()).toHaveLength(0); // never with the club's own keys
    expect(await row()).toMatchObject({ realmId: null, tokenMode: null, refreshTokenCiphertext: null, accessTokenCiphertext: null, connectMode: "relay", relayEnvironment: "sandbox" });
    expect(await audits("quickbooks.relay.disconnect")).toMatchObject([{ actorId: admin.id, permission: "Settings.QuickBooks.ReadWrite", ip: "203.0.113.44",
      before: { companyName: "Stub Boosters", realmId: A }, after: { acknowledged: true, revoked: true, environment: "sandbox" } }]);
    expect(await audits("quickbooks.disconnect")).toHaveLength(0);
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain("relay-rt-held");
    // The registration stays: the portal can connect again.
    expect((await connectionView()).relayStage).toBe("ready");
    expect(await disconnectAction(form({ ack: "yes", drawnFor: "relay" }))).toEqual({ ok: false, error: "QuickBooks isn't connected." });
  });

  it.each([
    ["Intuit doesn't confirm", () => { relay.revokeConfirmed = false; }],
    ["the relay refuses", () => { relay.refuseNext = 1; }],
    ["the relay is down", () => { relay.failNext = 1; }],
  ])("forgets the tokens whatever the relay answers: %s", async (_name, knob) => {
    await seedRelayConnected();
    knob();
    expect(await disconnectAction(form({ ack: "yes", drawnFor: "relay" }))).toEqual({ ok: true, revoked: false });
    expect(await row()).toMatchObject({ realmId: null, tokenMode: null, refreshTokenCiphertext: null });
    expect((await audits("quickbooks.relay.disconnect")).map((a) => a.after)).toEqual([{ acknowledged: true, revoked: false, environment: "sandbox" }]);
  });

  it("the page warns and asks for the box through Boosters Rocket, and gives the club's own app one line and no box", async () => {
    await seedRelayConnected();
    const relayHtml = await page();
    expect(relayHtml).toContain("Every portal connected to this QuickBooks company through Boosters Rocket shares one connection. Disconnecting here may disconnect the others too, such as a trial copy of this portal.");
    expect(relayHtml).toMatch(/<input type="checkbox" id="qbo-disconnect-ack"[^>]*name="ack" value="yes"/);
    expect(relayHtml).toContain("I understand that disconnecting may also disconnect any other portal connected to this company through Boosters Rocket.");
    // Unusable until the box is ticked: aria-disabled, never disabled, which would drop the focus.
    expect(relayHtml).toMatch(/<button type="button" class="btn btn-line" aria-disabled="true">Disconnect QuickBooks<\/button>/);
    expect(relayHtml).not.toContain("If another portal uses this same Intuit app");

    await db.delete(qboConnection);
    await seedConnected(qbo, { realmId: A });
    const own = await page();
    expect(own).toContain("If another portal uses this same Intuit app&#x27;s keys for this company, it is disconnected too.");
    expect(own).not.toContain("qbo-disconnect-ack");
    expect(own).not.toContain("through Boosters Rocket shares one connection");
    expect(own).toMatch(/<button type="button" class="btn btn-line">Disconnect QuickBooks<\/button>/);
  });

  it("the club's own app reads no field: it disconnects with or without the box, revoking with its own keys", async () => {
    await db.delete(qboConnection);
    await seedConnected(qbo, { realmId: A });
    expect(await disconnectAction(form({ ack: ["no", "maybe"] }))).toEqual({ ok: true, revoked: true });
    expect(intuitRevokes()).toHaveLength(1);
    expect(relay.calls).toHaveLength(0);
    expect((await audits("quickbooks.disconnect")).map((a) => a.after)).toEqual([{ revoked: true }]);
    expect(await audits("quickbooks.relay.disconnect")).toHaveLength(0);
  });
});
