import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { db } from "@/lib/db/client";
import { auditLog, qboConnection } from "@/lib/db/schema";
import { accessToken, qboCustomerById, qboGet, qboInvoices, qboQueryAll, qboCustomerTypes } from "@/lib/quickbooks/client";
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
    stub.customers = [{ Id: "10", DisplayName: "Rivera Family", BalanceWithJobs: 85 }];
    await qboGet("companyinfo/9130000000000001");
    await qboCustomerTypes();
    await qboInvoices(["10", "12"]);
    await qboCustomerById("10");
    expect(stub.apiCalls().length).toBeGreaterThan(3);
    expect(stub.apiCalls().every((c) => c.method === "GET")).toBe(true);
  });
});

const inv = (Id: string, customer: string, extra: Record<string, unknown> = {}) =>
  ({ Id, DocNumber: `10${Id}`, CustomerRef: { value: customer }, TotalAmt: 85, Balance: 85, TxnDate: "2026-11-01", ...extra });
const queries = () => stub.apiCalls().map((c) => c.query.get("query"));

describe("invoice reads", () => {
  it("asks for the invoices of the customers named, in one query, with the pay link", async () => {
    await seedConnected(stub);
    stub.invoices = [
      inv("1", "10", { InvoiceLink: "https://connect.intuit.com/t/one" }), inv("2", "12"), inv("3", "20", { InvoiceLink: "https://connect.intuit.com/t/three" }),
      inv("4", "100"), inv("5", "1"),
    ];
    const rows = await qboInvoices(["10", "12"]);
    expect(rows.map((r) => r.Id)).toEqual(["1", "2"]); // not customer 20's, and not 100's or 1's, which only contain the digits
    expect(rows[0]!.InvoiceLink).toBe("https://connect.intuit.com/t/one");
    expect(queries()).toEqual(["select * from Invoice where CustomerRef in ('10','12') orderby Id startposition 1 maxresults 1000"]);
    expect(stub.apiCalls()[0]!.query.get("include")).toBe("invoiceLink");
    expect(stub.apiCalls()[0]!.query.get("minorversion")).toBe("75");
  });

  it("gets no pay link from a query that doesn't ask for it: the stub keeps QuickBooks' rule", async () => {
    await seedConnected(stub);
    stub.invoices = [inv("1", "10", { InvoiceLink: "https://connect.intuit.com/t/one" })];
    const body = await qboGet("query", { query: "select * from Invoice where CustomerRef = '10' orderby Id startposition 1 maxresults 1000" }) as { QueryResponse: { Invoice: Record<string, unknown>[] } };
    expect(body.QueryResponse.Invoice[0]).not.toHaveProperty("InvoiceLink");
    expect(body.QueryResponse.Invoice[0]!.Id).toBe("1");
  });

  it("asks for one customer with the plain form, and no customer is asked for twice", async () => {
    await seedConnected(stub);
    stub.invoices = [inv("1", "10"), inv("2", "12")];
    expect((await qboInvoices(["10", "10"])).map((r) => r.Id)).toEqual(["1"]);
    expect(queries()).toEqual(["select * from Invoice where CustomerRef = '10' orderby Id startposition 1 maxresults 1000"]);
  });

  it("reads every page, in Id order", { timeout: 30_000 }, async () => {
    await seedConnected(stub);
    stub.invoices = Array.from({ length: 1200 }, (_, i) => inv(String(1200 - i), i % 2 ? "10" : "12"));
    const rows = await qboInvoices(["10", "12"]);
    expect(rows.map((r) => r.Id)).toEqual(Array.from({ length: 1200 }, (_, i) => String(i + 1)));
    expect(queries().map((q) => /startposition (\d+)/.exec(q!)![1])).toEqual(["1", "1001"]);
  });

  it.each([
    ["a name", ["10", "Rivera Family"]], ["a quote", ["10", "12' or '1'='1"]], ["a seeded test id", ["QBO-FAMILY-7001"]], ["a space", ["10 "]],
    ["a sign", ["-1"]], ["a decimal", ["1.5"]], ["nothing", [""]], ["twenty digits", ["12345678901234567890"]], ["no ids at all", []],
  ])("never puts %s into query text: the read is refused before QuickBooks is asked", async (_what, ids) => {
    await seedConnected(stub);
    expect(await codeOf(qboInvoices(ids))).toBe("bad_id");
    expect(await codeOf(qboCustomerById(ids.at(-1) ?? ""))).toBe("bad_id");
    expect(stub.calls).toHaveLength(0);
  });

  it("reads one customer by id, with QuickBooks' own balance figure", async () => {
    await seedConnected(stub);
    stub.customers = [{ Id: "10", DisplayName: "Rivera Family", Balance: 0, BalanceWithJobs: 185.5 }];
    expect(await qboCustomerById("10")).toMatchObject({ Id: "10", BalanceWithJobs: 185.5 });
    expect(stub.apiCalls()[0]!.path).toBe("/v3/company/9130000000000001/customer/10");
    expect(await codeOf(qboCustomerById("11"))).toBe("http_400"); // QuickBooks answers a record it doesn't have with a 400
  });

  it("the stub refuses a query for an entity it doesn't hold, instead of answering with the customer list", async () => {
    await seedConnected(stub);
    stub.customers = [{ Id: "10", DisplayName: "Rivera Family" }];
    expect(await codeOf(qboGet("query", { query: "select * from Payment" }))).toBe("http_400");
    expect(await codeOf(qboGet("query", { query: "select * from Invoice" }))).toBe("http_400");
  });
});

describe("what a parent's page load asks of the client", () => {
  const PARENT = { timeoutMs: 2000, retry: true, failFast: true } as const;

  it.each([["429", "rateLimitNext"], ["500", "failNext"]] as const)("tries once more after a short wait when QuickBooks answers %s", async (_status, sw) => {
    await seedConnected(stub);
    stub.invoices = [inv("1", "10")];
    stub[sw] = 1;
    const started = Date.now();
    expect((await qboInvoices(["10"], PARENT)).map((r) => r.Id)).toEqual(["1"]);
    expect(stub.apiCalls()).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140); // the wait before the second try
    expect(stub.tokenCalls()).toHaveLength(0); // a retry is not a token problem
  });

  it.each([["429", "rateLimitNext", "http_429"], ["500", "failNext", "http_500"]] as const)("gives up after one more try when QuickBooks keeps answering %s", async (_status, sw, code) => {
    await seedConnected(stub);
    stub[sw] = 5;
    expect(await codeOf(qboInvoices(["10"], PARENT))).toBe(code);
    expect(stub.apiCalls()).toHaveLength(2);
  });

  it("does not try again unless asked to, and never after a 400", async () => {
    await seedConnected(stub);
    stub.failNext = 5;
    expect(await codeOf(qboInvoices(["10"]))).toBe("http_500");
    expect(stub.apiCalls()).toHaveLength(1);
    stub.reset(); stub.accessTokens.add("at-seed");
    expect(await codeOf(qboGet("query", { query: "select * from Payment" }, PARENT))).toBe("http_400");
    expect(stub.apiCalls()).toHaveLength(1);
  });

  it("gives up on a slow answer after the time it was given, and says so", async () => {
    await seedConnected(stub);
    stub.apiDelayMs = 3000;
    const started = Date.now();
    expect(await codeOf(qboInvoices(["10"], { ...PARENT, timeoutMs: 200 }))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2500);
    expect(stub.apiCalls()).toHaveLength(1); // a timeout is not retried
  });

  it("gives up when the caller's own deadline passes, between tries too", async () => {
    await seedConnected(stub);
    stub.apiDelayMs = 3000;
    const started = Date.now();
    expect(await codeOf(qboInvoices(["10"], { ...PARENT, signal: AbortSignal.timeout(200) }))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2500);
    stub.reset(); stub.accessTokens.add("at-seed");
    stub.failNext = 1;
    expect(await codeOf(qboInvoices(["10"], { ...PARENT, signal: AbortSignal.timeout(60) }))).toBe("timeout"); // the wait before the retry is cut short
    expect(stub.apiCalls()).toHaveLength(1);
  });

  it("does not wait for a token refresh that is taking longer than the caller's deadline", async () => {
    await seedConnected(stub, { accessExpiresInMs: -1000 });
    stub.tokenDelayMs = 2000;
    const started = Date.now();
    expect(await codeOf(qboInvoices(["10"], { ...PARENT, signal: AbortSignal.timeout(150) }))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1500);
    expect(stub.apiCalls()).toHaveLength(0);
    // The refresh itself carries on and is saved: the refresh token is spent only once.
    await expect.poll(async () => (await row()).lastTokenRefreshAt!.getTime() > started, { timeout: 15_000 }).toBe(true);
    expect((await accessToken()).token).toBe("at-1");
  });

  it("several page loads that find the token expired share one refresh, and all are answered", async () => {
    await seedConnected(stub, { accessExpiresInMs: -1000 });
    stub.invoices = [inv("1", "10"), inv("2", "12"), inv("3", "14")];
    stub.customers = [{ Id: "10", BalanceWithJobs: 85 }];
    stub.tokenDelayMs = 150;
    const [one, two, three, customer] = await Promise.all([qboInvoices(["10"], PARENT), qboInvoices(["12"], PARENT), qboInvoices(["14"], PARENT), qboCustomerById("10", PARENT)]);
    expect([one, two, three].map((rows) => rows.map((r) => r.Id))).toEqual([["1"], ["2"], ["3"]]);
    expect(customer).toMatchObject({ Id: "10" });
    expect(stub.tokenCalls()).toHaveLength(1);
    expect(stub.apiCalls().every((c) => c.auth === "Bearer at-1")).toBe(true);
    expect((await row()).lastError).toBeNull();
  });

  it("page loads whose token QuickBooks no longer takes refresh it and try again, and never spend a refresh token twice", async () => {
    await seedConnected(stub);
    stub.accessTokens.delete("at-seed"); // revoked or replaced: the API answers 401
    stub.invoices = [inv("1", "10"), inv("2", "12")];
    const all = await Promise.all([qboInvoices(["10"], PARENT), qboInvoices(["12"], PARENT)]);
    expect(all.map((rows) => rows.map((r) => r.Id))).toEqual([["1"], ["2"]]);
    expect((await row()).lastError).toBeNull(); // no refresh was refused
    expect(stub.tokenCalls().length).toBeGreaterThanOrEqual(1);
  });

  it("a page load does not wait for the connection row: held elsewhere, a token that needs refreshing is 'busy' at once", async () => {
    await seedConnected(stub, { accessExpiresInMs: -1000 });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let holder!: Promise<void>;
    const locked = new Promise<void>((r) => { holder = db.transaction(async (tx) => { await tx.select().from(qboConnection).for("update"); r(); await held; }); });
    await locked;
    try {
      const started = Date.now();
      expect(await codeOf(qboInvoices(["10"], { ...PARENT, signal: AbortSignal.timeout(1500) }))).toBe("busy");
      expect(Date.now() - started).toBeLessThan(1000);
      expect(stub.calls).toHaveLength(0);
      // A caller that is not a page load (the worker, a staff check) still waits its turn, as before.
      const waiting = accessToken();
      release();
      expect((await waiting).token).toBe("at-1");
    } finally { release(); await holder; }
    expect(await codeOf(accessToken({ noWait: true }))).toBe("no error");
  });

  it("a page load with a token that is still good takes no lock on the connection row", async () => {
    await seedConnected(stub);
    stub.invoices = [inv("1", "10")];
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let holder!: Promise<void>;
    const locked = new Promise<void>((r) => { holder = db.transaction(async (tx) => { await tx.select().from(qboConnection).for("update"); r(); await held; }); });
    await locked;
    try {
      expect((await qboInvoices(["10"], { ...PARENT, signal: AbortSignal.timeout(1500) })).map((r) => r.Id)).toEqual(["1"]);
    } finally { release(); await holder; }
  });

  it.each([
    ["Intuit no longer accepts this connection. Connect QuickBooks again. (invalid_grant)"],
    ["The saved QuickBooks keys can't be read with this server's encryption key. Connect QuickBooks again. (unreadable)"],
  ])("refuses at once, without the connection row lock, when only an Admin can fix the connection: %s", async (lastError) => {
    await seedConnected(stub, { accessExpiresInMs: -1000 });
    await db.update(qboConnection).set({ lastError, lastErrorAt: new Date() });
    // Another caller holds the connection row lock, as a token refresh does across its call to Intuit.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const locked = new Promise<void>((r) => { void db.transaction(async (tx) => { await tx.select().from(qboConnection).for("update"); r(); await held; }); });
    await locked;
    try {
      const started = Date.now();
      expect(await codeOf(qboInvoices(["10"], PARENT))).toBe("needs_admin");
      expect(await codeOf(qboCustomerById("10", PARENT))).toBe("needs_admin");
      expect(Date.now() - started).toBeLessThan(1000);
      expect(stub.calls).toHaveLength(0); // Intuit is not asked again for a refresh that cannot succeed
    } finally { release(); }
  });

  it("still tries when the recorded error is one a retry can clear", async () => {
    await seedConnected(stub);
    await db.update(qboConnection).set({ lastError: "Couldn't reach Intuit. (unreachable)", lastErrorAt: new Date() });
    stub.invoices = [inv("1", "10")];
    expect(await qboInvoices(["10"], PARENT)).toHaveLength(1);
  });

  it("asks nothing of a company other than the one the caller means", async () => {
    await seedConnected(stub, { realmId: "9130000000000002" });
    stub.invoices = [inv("1", "10")];
    expect(await codeOf(qboInvoices(["10"], { ...PARENT, realmId: "9130000000000001" }))).toBe("other_company");
    expect(stub.apiCalls()).toHaveLength(0);
    expect(await qboInvoices(["10"], { ...PARENT, realmId: "9130000000000002" })).toHaveLength(1);
  });
});
