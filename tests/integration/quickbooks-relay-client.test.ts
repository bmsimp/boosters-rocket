import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const relayBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/relay-address", () => ({ qboRelayUrl: () => relayBase.url }));

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { qboRelay, setting } from "@/lib/db/schema";
import { QboError } from "@/lib/quickbooks/endpoints";
import { readRelayMark, relayForget, relayGoAddress, relayRedeem, relayRefresh, relayRevoke, relayStart, RELAY_MARK } from "@/lib/quickbooks/relay";
import { importRelayKey, signedHeaders } from "@/lib/quickbooks/relay-sign";
import { resetDb } from "../helpers/db";
import { seedRelayRegistration, startRelayStub, TEST_PORTAL_ID, type RelayStub } from "../helpers/relay-stub";

/**
 * The portal's signed calls to Boosters Rocket Connect, against the fake relay (slices 1 and 3 of
 * docs/superpowers/plans/2026-11-24-connect-through-boosters-rocket.md): each one signed so the relay's own checks
 * accept it, the relay's answers read as untrusted, the error words of the spec's section 5 table, and the mark each
 * answer leaves for Health.
 */
let stub: RelayStub;
beforeAll(async () => { stub = await startRelayStub(); relayBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

const STATE = "portal-state-0123456789abcdefghij";
const code = (p: Promise<unknown>) => p.then(() => "none", (e: unknown) => (e instanceof QboError ? e.code : `threw ${String(e)}`));
const mark = () => readRelayMark();

describe("signing", () => {
  it("signs each call so the relay's checks accept it, with a fresh nonce each time", async () => {
    await seedRelayRegistration(stub);
    await relayStart("sandbox", STATE);
    await relayStart("production", STATE);
    expect(stub.calls.map((c) => [c.path, c.portal, c.status, c.refusal])).toEqual([
      ["/v1/connect/start", TEST_PORTAL_ID, 200, null], ["/v1/connect/start", TEST_PORTAL_ID, 200, null]]);
    expect(stub.calls.map((c) => c.body)).toEqual([{ environment: "sandbox", portal_state: STATE }, { environment: "production", portal_state: STATE }]);
  });

  it("is refused by the relay for another key, a clock more than 5 minutes off and a nonce already spent", async () => {
    const key = await seedRelayRegistration(stub);
    // Another key registered under the portal's id: the signature no longer holds.
    stub.portals.set(TEST_PORTAL_ID, "gbltJgDOnRxjmYnR45vZLQksg_FU67qiHffLEm4zqcY");
    expect(await code(relayStart("sandbox", STATE))).toBe("relay_unauthorized");
    stub.portals.set(TEST_PORTAL_ID, key.publicKey);
    stub.clockAheadMs = 6 * 60_000;
    expect(await code(relayStart("sandbox", STATE))).toBe("relay_unauthorized");
    stub.clockAheadMs = -6 * 60_000;
    expect(await code(relayStart("sandbox", STATE))).toBe("relay_unauthorized");
    stub.clockAheadMs = 4 * 60_000; // within the window
    expect(await code(relayStart("sandbox", STATE))).toBe("none");
    // The same signed request sent twice: the second is a replay.
    const body = JSON.stringify({ environment: "sandbox", portal_state: STATE });
    const headers = await signedHeaders({ portalId: TEST_PORTAL_ID, privateKey: await importRelayKey(key.privateKeyPkcs8), verb: "POST", path: "/v1/connect/start", body });
    expect((await fetch(`${stub.base}/v1/connect/start`, { method: "POST", body, headers })).status).toBe(200);
    expect((await fetch(`${stub.base}/v1/connect/start`, { method: "POST", body, headers })).status).toBe(401);
    // A body changed after signing.
    const again = await signedHeaders({ portalId: TEST_PORTAL_ID, privateKey: await importRelayKey(key.privateKeyPkcs8), verb: "POST", path: "/v1/connect/start", body });
    expect((await fetch(`${stub.base}/v1/connect/start`, { method: "POST", body: body.replace("sandbox", "production"), headers: again })).status).toBe(401);
    expect(stub.calls.map((c) => c.refusal)).toEqual(["signature", "clock", "clock", null, null, "replay", "signature"]);
  });

  it("sends nothing while the portal has no key, or a key and no id yet", async () => {
    expect(await code(relayStart("sandbox", STATE))).toBe("relay_not_registered");
    await seedRelayRegistration(stub, { portalId: null });
    expect(await code(relayRefresh("sandbox", "rt"))).toBe("relay_not_registered");
    expect(await relayRevoke("sandbox", "rt", "9130000000000001")).toBe(false);
    expect(stub.calls).toEqual([]);
    expect(await mark()).toBeNull();
  });

  it("can't sign with a key sealed under another server's encryption key", async () => {
    await seedRelayRegistration(stub);
    await db.update(qboRelay).set({ privateKeyKeyId: "00000000" });
    expect(await code(relayStart("sandbox", STATE))).toBe("unreadable");
    expect(stub.calls).toEqual([]);
  });
});

describe("connect: start", () => {
  it("answers the relay's one-time go address", async () => {
    await seedRelayRegistration(stub);
    const url = await relayStart("sandbox", STATE);
    expect(url).toMatch(new RegExp(`^${stub.base}/v1/connect/go/[A-Za-z0-9_-]{43}$`));
  });

  it.each([
    ["another site", "https://evil.example/v1/connect/go/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"],
    ["the relay's address as part of another host", "BASE.evil.example/v1/connect/go/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG"],
    ["another path on the relay", "BASE/v1/token/refresh"],
    ["a ticket that climbs out of the go path", "BASE/v1/connect/go/../../evil/abcdefghijklmnopqrstuvwxyz"],
    ["a query after the ticket", "BASE/v1/connect/go/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG?next=https://evil.example"],
    ["no ticket", "BASE/v1/connect/go/"],
    ["not a string", 42],
  ])("refuses a go address that is %s, as relay_refused", async (_what, url) => {
    await seedRelayRegistration(stub);
    stub.oddAnswer = { path: "/v1/connect/start", body: { url: typeof url === "string" ? url.replace("BASE", stub.base) : url, expires_in: 600 } };
    expect(await code(relayStart("sandbox", STATE))).toBe("relay_refused");
  });

  it("refuses an environment the relay won't start, as relay_refused", async () => {
    await seedRelayRegistration(stub);
    expect(await code(relayStart("staging" as "sandbox", STATE))).toBe("relay_refused");
  });

  it("checks a go address against QBO_RELAY_URL alone", () => {
    expect(relayGoAddress(`${stub.base}/v1/connect/go/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG`)).not.toBeNull();
    expect(relayGoAddress(`${stub.base}/v1/connect/go/short`)).toBeNull();
    expect(relayGoAddress(`${stub.base}/v1/connect/go/abcdefghijklmnopqrstuvwxyz#frag`)).toBeNull();
    expect(relayGoAddress(null)).toBeNull();
  });
});

describe("connect: redeem", () => {
  it("answers the tokens, the company and the environment for this attempt, once", async () => {
    await seedRelayRegistration(stub);
    const grant = stub.grantFor(STATE, "9130000000000001");
    const r = await relayRedeem(grant, { portalState: STATE, environment: "sandbox" });
    expect(r.realmId).toBe("9130000000000001");
    expect(r.environment).toBe("sandbox");
    expect(r.tokens.accessToken).toBe("relay-at-1");
    expect(r.tokens.refreshToken).toBe("relay-rt-1");
    expect(r.tokens.accessExpiresAt.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(stub.calls[0]!.body).toEqual({ code: grant });
    expect(await code(relayRedeem(grant, { portalState: STATE, environment: "sandbox" }))).toBe("relay_code");
  });

  it("refuses an unknown, late or another portal's code as relay_code", async () => {
    await seedRelayRegistration(stub);
    expect(await code(relayRedeem("x".repeat(43), { portalState: STATE, environment: "sandbox" }))).toBe("relay_code");
    const late = stub.grantFor(STATE, "9130000000000001", { expiresInMs: -1 });
    expect(await code(relayRedeem(late, { portalState: STATE, environment: "sandbox" }))).toBe("relay_code");
    const others = stub.grantFor(STATE, "9130000000000001", { portalId: "brp_another0portal01" });
    expect(await code(relayRedeem(others, { portalState: STATE, environment: "sandbox" }))).toBe("relay_code");
    // A code that isn't one is never sent.
    expect(await code(relayRedeem("not a code", { portalState: STATE, environment: "sandbox" }))).toBe("relay_code");
    expect(stub.calls).toHaveLength(3);
  });

  it("refuses an answer for another attempt or another environment as relay_code, and an odd company as relay_error", async () => {
    await seedRelayRegistration(stub);
    expect(await code(relayRedeem(stub.grantFor("another-attempts-state-0123456789", "9130000000000001"), { portalState: STATE, environment: "sandbox" }))).toBe("relay_code");
    expect(await code(relayRedeem(stub.grantFor(STATE, "9130000000000001", { environment: "production" }), { portalState: STATE, environment: "sandbox" }))).toBe("relay_code");
    for (const realmId of ["", "12ab", "1".repeat(33), "9130000000000001; DROP"]) {
      expect(await code(relayRedeem(stub.grantFor(STATE, realmId), { portalState: STATE, environment: "sandbox" })), realmId).toBe("relay_error");
    }
    stub.oddAnswer = { path: "/v1/connect/redeem", body: { realm_id: "9130000000000001", environment: "sandbox", portal_state: STATE } };
    expect(await code(relayRedeem("y".repeat(43), { portalState: STATE, environment: "sandbox" }))).toBe("relay_error");
  });
});

describe("refresh", () => {
  it("answers Intuit's new tokens, passed through", async () => {
    await seedRelayRegistration(stub);
    stub.refreshTokens.add("rt-old");
    const t = await relayRefresh("production", "rt-old");
    expect(t.refreshToken).toBe("relay-rt-1");
    expect(stub.calls[0]!.body).toEqual({ environment: "production", refresh_token: "rt-old" });
    expect(stub.refreshTokens.has("rt-old")).toBe(false);
    stub.rotateOnRefresh = false;
    expect((await relayRefresh("production", "relay-rt-1")).refreshToken).toBe("relay-rt-1");
  });

  it("gives each failure the spec's code: Intuit's own word for a 400, the relay's for the rest", async () => {
    await seedRelayRegistration(stub);
    expect(await code(relayRefresh("sandbox", "never-issued"))).toBe("invalid_grant");
    stub.refreshError = "invalid_client";
    expect(await code(relayRefresh("sandbox", "rt"))).toBe("invalid_client");
    stub.refreshError = "Not A Word!";
    expect(await code(relayRefresh("sandbox", "rt"))).toBe("http_400");
    stub.refreshError = null;
    stub.refuseNext = 1;
    expect(await code(relayRefresh("sandbox", "rt"))).toBe("relay_unauthorized");
    stub.busyNext = 1;
    expect(await code(relayRefresh("sandbox", "rt"))).toBe("relay_busy");
    stub.failNext = 1;
    expect(await code(relayRefresh("sandbox", "rt"))).toBe("relay_unreachable");
    stub.oddAnswer = { path: "/v1/token/refresh", body: { access_token: "only-half" } };
    expect(await code(relayRefresh("sandbox", "rt"))).toBe("relay_error");
  });

  it("words invalid_grant as Intuit's own, for the Admin to connect again", async () => {
    await seedRelayRegistration(stub);
    const e = await relayRefresh("sandbox", "never-issued").catch((x: unknown) => x as QboError);
    expect(e).toBeInstanceOf(QboError);
    expect((e as QboError).message).toBe("Intuit no longer accepts this connection. Connect QuickBooks again.");
  });

  it("gives up on a relay that doesn't answer, as relay_unreachable", async () => {
    await seedRelayRegistration(stub);
    relayBase.url = "http://127.0.0.1:1"; // nothing listens there
    try {
      expect(await code(relayRefresh("sandbox", "rt"))).toBe("relay_unreachable");
    } finally { relayBase.url = stub.base; }
  });
});

describe("revoke", () => {
  it("sends the refresh token and the company, and answers whether Intuit confirmed it", async () => {
    await seedRelayRegistration(stub);
    expect(await relayRevoke("sandbox", "rt-1", "9130000000000001")).toBe(true);
    expect(stub.calls[0]!.body).toEqual({ environment: "sandbox", token: "rt-1", realm_id: "9130000000000001" });
    stub.revokeConfirmed = false;
    expect(await relayRevoke("sandbox", "rt-2", "9130000000000001")).toBe(false);
  });

  it("never throws: a refusal, a busy relay or none at all is false", async () => {
    await seedRelayRegistration(stub);
    stub.refuseNext = 1;
    expect(await relayRevoke("sandbox", "rt", "9130000000000001")).toBe(false);
    stub.busyNext = 1;
    expect(await relayRevoke("sandbox", "rt", "9130000000000001")).toBe(false);
    stub.failNext = 1;
    expect(await relayRevoke("sandbox", "rt", "9130000000000001")).toBe(false);
    expect(await relayRevoke("sandbox", "rt", "not-a-company")).toBe(false);
  });
});

describe("forget", () => {
  it("sends the environment and the company, and answers true for the relay's ok", async () => {
    await seedRelayRegistration(stub);
    expect(await relayForget("sandbox", "9130000000000001")).toBe(true);
    expect(stub.calls.map((c) => [c.path, c.portal, c.status, c.body])).toEqual([["/v1/connection/forget", TEST_PORTAL_ID, 200, { environment: "sandbox", realm_id: "9130000000000001" }]]);
    expect(stub.forgotten).toEqual(["sandbox:9130000000000001"]);
    expect(stub.revoked).toEqual([]);
  });

  it("is best effort: a refusal, a busy relay, none at all or an odd answer is false, and it never throws", async () => {
    await seedRelayRegistration(stub);
    stub.refuseNext = 1;
    expect(await relayForget("sandbox", "9130000000000001")).toBe(false);
    stub.busyNext = 1;
    expect(await relayForget("sandbox", "9130000000000001")).toBe(false);
    stub.failNext = 1;
    expect(await relayForget("sandbox", "9130000000000001")).toBe(false);
    stub.oddAnswer = { path: "/v1/connection/forget", body: { status: "nope" } };
    expect(await relayForget("sandbox", "9130000000000001")).toBe(false);
    stub.oddAnswer = null;
    // A company that isn't digits is never sent.
    const sent = stub.calls.length;
    expect(await relayForget("production", "not-a-company")).toBe(false);
    expect(stub.calls).toHaveLength(sent);
    expect(stub.forgotten).toEqual([]);
    expect((await mark())?.lastFailWord).toBe("relay_error");
  });

  it("the fake relay answers an environment the portal may not use with environment_not_allowed, as the relay does", async () => {
    await seedRelayRegistration(stub);
    expect(await relayForget("staging" as "sandbox", "9130000000000001")).toBe(false);
    expect(stub.calls.at(-1)).toMatchObject({ path: "/v1/connection/forget", status: 400 });
  });
});

describe("the relay's mark, for Health", () => {
  it("records when the relay last answered and last failed, and with which fixed word", async () => {
    await seedRelayRegistration(stub);
    stub.refreshTokens.add("rt");
    await relayRefresh("sandbox", "rt");
    const ok = await mark();
    expect(ok).toEqual({ lastOkAt: expect.any(String), lastFailAt: null, lastFailWord: null });
    for (const [knob, word] of [["refuseNext", "unauthorized"], ["busyNext", "busy"], ["failNext", "relay_error"]] as const) {
      stub[knob] = 1;
      await relayRefresh("sandbox", "rt").catch(() => {});
      const m = await mark();
      expect(m?.lastFailWord).toBe(word);
      expect(m?.lastOkAt).toBe(ok!.lastOkAt);
    }
    relayBase.url = "http://127.0.0.1:1";
    try { await relayRevoke("sandbox", "rt", "9130000000000001"); } finally { relayBase.url = stub.base; }
    expect((await mark())?.lastFailWord).toBe("unreachable");
    // A 400 is an answer: the relay was reached.
    await relayRefresh("sandbox", "never-issued").catch(() => {});
    const after = await mark();
    expect(Date.parse(after!.lastOkAt!)).toBeGreaterThanOrEqual(Date.parse(after!.lastFailAt!));
  });

  it("holds times and words only: no token, code, key, body or id", async () => {
    const key = await seedRelayRegistration(stub);
    stub.refreshTokens.add("rt-secret-value");
    await relayRefresh("sandbox", "rt-secret-value");
    const grant = stub.grantFor(STATE, "9130000000000777");
    await relayRedeem(grant, { portalState: STATE, environment: "sandbox" });
    stub.refuseNext = 1;
    await relayStart("sandbox", STATE).catch(() => {});
    const [row] = await db.select().from(setting).where(eq(setting.key, RELAY_MARK));
    const text = JSON.stringify(row!.value);
    for (const secret of ["rt-secret-value", "relay-rt-1", "relay-at-1", grant, STATE, "9130000000000777", TEST_PORTAL_ID, key.privateKeyPkcs8, key.publicKey]) expect(text).not.toContain(secret);
    expect(Object.keys(row!.value as object).sort()).toEqual(["lastFailAt", "lastFailWord", "lastOkAt"]);
  });
});
