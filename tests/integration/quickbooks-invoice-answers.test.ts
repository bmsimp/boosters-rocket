import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { qboInvoices } from "@/lib/quickbooks/client";
import { QboError } from "@/lib/quickbooks/endpoints";
import { resetDb } from "../helpers/db";
import { startQboStub, seedConnected, type QboStub } from "../helpers/qbo-stub";

/**
 * An invoice answer with no invoices in it is shown to a parent as "nothing owed", so the client takes only one shape
 * for it: HTTP 200 with a QueryResponse object that holds no rows. Any other 200 is refused. A file of its own: which
 * form of the query works is module state (tests/integration/quickbooks-invoice-fallback.test.ts), and the last test
 * here leaves the one-customer form remembered.
 */
let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); await seedConnected(stub); });

const inv = (Id: string, customer: string) => ({ Id, CustomerRef: { value: customer }, TotalAmt: 85, Balance: 85 });
const queries = () => stub.apiCalls().map((c) => c.query.get("query"));
const failure = async (p: Promise<unknown>) => { try { await p; return "no error"; } catch (e) { return e instanceof QboError ? `${e.code}: ${e.message}` : `other: ${String(e)}`; } };
const FAULT = { Fault: { Error: [{ Message: "a message the portal must never store", code: "4000" }], type: "ValidationFault" } };
const IN = "select * from Invoice where CustomerRef in ('10','12') orderby Id startposition 1 maxresults 1000";
const ONE = (id: string) => `select * from Invoice where CustomerRef = '${id}' orderby Id startposition 1 maxresults 1000`;

describe("an invoice answer is taken only in the shape QuickBooks gives", () => {
  it.each([
    ["null", null],
    ["a string", "QueryResponse"],
    ["a list", [{ QueryResponse: {} }]],
    ["an empty object", {}],
    ["a QueryResponse that is null", { QueryResponse: null }],
    ["a QueryResponse that is a list", { QueryResponse: [] }],
    ["invoices that are one object", { QueryResponse: { Invoice: { Id: "1" } } }],
    ["invoices that are a number", { QueryResponse: { Invoice: 0 } }],
    ["rows of another entity", { QueryResponse: { Customer: [{ Id: "10" }] } }],
  ])("refuses a 200 that is %s", async (_what, body) => {
    stub.invoices = [inv("1", "10")];
    stub.oddInvoiceAnswer = { body };
    expect(await failure(qboInvoices(["10"]))).toBe("bad_answer: QuickBooks sent an answer the portal couldn't read.");
    expect(await failure(qboInvoices(["10", "12"]))).toBe("bad_answer: QuickBooks sent an answer the portal couldn't read.");
    expect(queries()).toEqual([ONE("10"), IN]); // not a refusal of the form: the other form is not tried
  });

  it("takes an empty QueryResponse, with or without an empty list, as no invoices", async () => {
    stub.oddInvoiceAnswer = { body: { QueryResponse: {}, time: "2026-11-15T10:00:00.000-08:00" } };
    expect(await qboInvoices(["10", "12"])).toEqual([]);
    stub.oddInvoiceAnswer = { body: { QueryResponse: { Invoice: [], startPosition: 1, maxResults: 0, totalCount: 0 } } };
    expect(await qboInvoices(["10", "12"])).toEqual([]);
  });

  it("refuses a Fault sent with status 200, and keeps none of its text", async () => {
    stub.oddInvoiceAnswer = { body: FAULT };
    expect(await failure(qboInvoices(["10"]))).toBe("fault: QuickBooks refused the request.");
    // In the in-form it is taken as that form being refused, like a 400: each customer is asked, and that fails too.
    expect(await failure(qboInvoices(["10", "12"]))).toBe("fault: QuickBooks refused the request.");
    expect(queries()).toEqual([ONE("10"), IN, ONE("10")]);
  });

  it("a Fault with status 200 on the in-form falls back to one customer at a time, and that is remembered", async () => {
    stub.invoices = [inv("1", "10"), inv("2", "12"), inv("3", "20")];
    stub.oddInvoiceAnswer = { body: FAULT, inFormOnly: true };
    expect((await qboInvoices(["10", "12"])).map((r) => r.Id)).toEqual(["1", "2"]);
    expect(queries()).toEqual([IN, ONE("10"), ONE("12")]);
    expect((await qboInvoices(["12", "10"])).map((r) => r.Id)).toEqual(["2", "1"]);
    expect(queries().slice(3)).toEqual([ONE("12"), ONE("10")]);
  });
});
