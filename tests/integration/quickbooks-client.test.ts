import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { db } from "@/lib/db/client";
import { auditLog, qboConnection } from "@/lib/db/schema";
import { accessToken, qboGet, qboQueryAll, qboCustomerTypes } from "@/lib/quickbooks/client";
import { QboError } from "@/lib/quickbooks/endpoints";
import { resetDb } from "../helpers/db";
import { startQboStub, seedConnected, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

const row = async () => (await db.select().from(qboConnection))[0]!;
const codeOf = async (p: Promise<unknown>) => { try { await p; return "no error"; } catch (e) { return e instanceof QboError ? e.code : `other: ${String(e)}`; } };

describe("the QuickBooks client", () => {
  it("uses a fresh access token without asking Intuit", async () => {
    await seedConnected(stub);
    expect((await accessToken()).token).toBe("at-seed");
    expect(stub.tokenCalls()).toHaveLength(0);
  });

  it("refreshes a token that is within 5 minutes of expiring, and saves the new refresh token", async () => {
    await seedConnected(stub, { accessExpiresInMs: 4 * 60_000 });
    expect((await accessToken()).token).toBe("at-1");
    expect(Object.fromEntries(new URLSearchParams(stub.tokenCalls()[0]!.body))).toEqual({ grant_type: "refresh_token", refresh_token: "rt-seed" });
    expect(stub.tokenCalls()[0]!.auth).toBe(`Basic ${Buffer.from("stub-client-id:stub-secret").toString("base64")}`);
    await db.update(qboConnection).set({ accessExpiresAt: new Date(Date.now() - 1000) });
    expect((await accessToken()).token).toBe("at-2");
    expect(Object.fromEntries(new URLSearchParams(stub.tokenCalls()[1]!.body))).toMatchObject({ refresh_token: "rt-1" });
    expect((await row()).lastTokenRefreshAt!.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it("two callers at once spend the refresh token once", async () => {
    await seedConnected(stub, { accessExpiresInMs: -1000 });
    stub.tokenDelayMs = 150;
    const [a, b] = await Promise.all([accessToken(), accessToken()]);
    expect(a.token).toBe("at-1");
    expect(b.token).toBe("at-1");
    expect(stub.tokenCalls()).toHaveLength(1);
  });

  it("a forced refresh racing an ordinary caller never spends a refresh token twice", async () => {
    await seedConnected(stub, { accessExpiresInMs: -1000 });
    stub.tokenDelayMs = 150;
    const [forced, plain] = await Promise.all([accessToken({ force: true }), accessToken()]);
    // Whichever takes the row lock first refreshes with the seeded token. If that was the ordinary caller, the forced
    // one then refreshes again, with the token the first refresh saved; if it was the forced one, the other reuses it.
    const spent = stub.tokenCalls().map((c) => new URLSearchParams(c.body).get("refresh_token"));
    expect([["rt-seed"], ["rt-seed", "rt-1"]]).toContainEqual(spent);
    expect([forced.token, plain.token]).toContain(`at-${spent.length}`);
    expect(stub.accessTokens.has(forced.token) && stub.accessTokens.has(plain.token)).toBe(true);
    expect((await row()).lastError).toBeNull(); // Intuit never answered invalid_grant
    expect((await accessToken()).token).toBe(`at-${spent.length}`); // and the saved token is the newest
  });

  it("records a refused refresh with Intuit's code, never its text, and throws", async () => {
    await seedConnected(stub, { accessExpiresInMs: -1000 });
    stub.failToken = "invalid_grant";
    expect(await codeOf(accessToken())).toBe("invalid_grant");
    const c = await row();
    expect(c.lastError).toBe("Intuit no longer accepts this connection. Connect QuickBooks again. (invalid_grant)");
    expect(c.lastErrorAt).not.toBeNull();
    const audit = (await db.select().from(auditLog)).filter((r) => r.action === "quickbooks.token_refresh.failed");
    expect(audit[0]).toMatchObject({ door: "system", after: { code: "invalid_grant" } });
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain("a description the portal must never store");
  });

  it("clears the recorded error when a later refresh works", async () => {
    await seedConnected(stub, { accessExpiresInMs: -1000 });
    stub.failToken = "server_error";
    await codeOf(accessToken());
    stub.failToken = null;
    await accessToken();
    expect((await row()).lastError).toBeNull();
  });

  it("says QuickBooks isn't connected when there is no connection", async () => {
    expect(await codeOf(accessToken())).toBe("not_connected");
  });

  it("refreshes once and tries again when QuickBooks says the token is no good", async () => {
    await seedConnected(stub);
    stub.accessTokens.delete("at-seed");
    expect(await qboGet("companyinfo/9130000000000001")).toEqual({ CompanyInfo: { CompanyName: "Stub Boosters" } });
    expect(stub.tokenCalls()).toHaveLength(1);
    expect(stub.apiCalls().map((c) => c.auth)).toEqual(["Bearer at-seed", "Bearer at-1"]);
    expect(stub.apiCalls().every((c) => c.query.get("minorversion") === "75")).toBe(true);
  });

  it("reads every page of a query", { timeout: 30_000 }, async () => {
    await seedConnected(stub);
    stub.customers = Array.from({ length: 2050 }, (_, i) => ({ Id: String(i + 1), DisplayName: `Customer ${i + 1}`, Active: i % 10 !== 0 }));
    const rows = await qboQueryAll("Customer", "Active in (true, false)");
    expect(rows).toHaveLength(2050);
    expect(stub.apiCalls().map((c) => /startposition (\d+)/.exec(c.query.get("query")!)![1])).toEqual(["1", "1001", "2001"]);
  });

  it("asks for every page in Id order, so no customer is skipped or repeated between pages", { timeout: 30_000 }, async () => {
    await seedConnected(stub);
    // Stored newest first, as an unordered query could return them: only the orderby makes the pages line up.
    stub.customers = Array.from({ length: 2050 }, (_, i) => ({ Id: String(2050 - i), DisplayName: `Customer ${2050 - i}`, Active: true }));
    const rows = await qboQueryAll("Customer", "Active in (true, false)");
    expect(stub.apiCalls().map((c) => c.query.get("query"))).toEqual([
      "select * from Customer where Active in (true, false) orderby Id startposition 1 maxresults 1000",
      "select * from Customer where Active in (true, false) orderby Id startposition 1001 maxresults 1000",
      "select * from Customer where Active in (true, false) orderby Id startposition 2001 maxresults 1000",
    ]);
    expect(rows.map((r) => r.Id)).toEqual(Array.from({ length: 2050 }, (_, i) => String(i + 1)));
  });

  it("turns a QuickBooks failure into a short code", async () => {
    await seedConnected(stub);
    stub.failQueryFrom = 1;
    expect(await codeOf(qboQueryAll("Customer"))).toBe("http_500");
  });

  it("sends nothing but GET to the QuickBooks API", async () => {
    await seedConnected(stub, { accessExpiresInMs: -1000 });
    await qboGet("companyinfo/9130000000000001");
    await qboCustomerTypes();
    expect(stub.apiCalls().length).toBeGreaterThan(0);
    expect(stub.apiCalls().every((c) => c.method === "GET")).toBe(true);
  });
});
