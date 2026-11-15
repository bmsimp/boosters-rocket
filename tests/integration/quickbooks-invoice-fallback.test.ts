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
 * Nobody has tried `CustomerRef in (...)` against a real QuickBooks company (INVOICE_QUERIES in the client). If
 * QuickBooks refuses that form with a 400, the client asks one customer at a time and remembers it for the life of the
 * process. A file of its own: the memory is module state, and each test file gets the module fresh. The tests run in
 * order and each builds on what the one before left remembered.
 */
let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

const inv = (Id: string, customer: string) => ({ Id, CustomerRef: { value: customer }, TotalAmt: 85, Balance: 85, InvoiceLink: `https://connect.intuit.com/t/${Id}` });
const queries = () => stub.apiCalls().map((c) => c.query.get("query"));
const codeOf = async (p: Promise<unknown>) => { try { await p; return "no error"; } catch (e) { return e instanceof QboError ? e.code : `other: ${String(e)}`; } };
const IN = "select * from Invoice where CustomerRef in ('10','12') orderby Id startposition 1 maxresults 1000";
const ONE = (id: string) => `select * from Invoice where CustomerRef = '${id}' orderby Id startposition 1 maxresults 1000`;

describe("the invoice query falls back to one customer at a time", () => {
  it("does not remember the other form when that fails too", async () => {
    await seedConnected(stub);
    stub.refuseInQuery = true;
    stub.failQueryFrom = 2; // the in-form is refused, then the first one-customer query fails
    expect(await codeOf(qboInvoices(["10", "12"]))).toBe("http_500");
    expect(queries()).toEqual([IN, ONE("10")]);
    stub.reset(); stub.accessTokens.add("at-seed");
    stub.invoices = [inv("1", "10"), inv("2", "12")];
    expect(await qboInvoices(["10", "12"])).toHaveLength(2);
    expect(queries()).toEqual([IN]); // the in-form is tried first again
  });

  it("asks each customer in turn when QuickBooks answers the in-form with a 400, and keeps the pay links", async () => {
    await seedConnected(stub);
    stub.refuseInQuery = true;
    stub.invoices = [inv("1", "10"), inv("2", "12"), inv("3", "20")];
    const rows = await qboInvoices(["10", "12"]);
    expect(rows.map((r) => r.Id)).toEqual(["1", "2"]);
    expect(rows.map((r) => r.InvoiceLink)).toEqual(["https://connect.intuit.com/t/1", "https://connect.intuit.com/t/2"]);
    expect(queries()).toEqual([IN, ONE("10"), ONE("12")]);
    expect(stub.apiCalls().every((c) => c.query.get("include") === "invoiceLink")).toBe(true);
  });

  it("remembers which form works: the refused one is not sent again in this process", async () => {
    await seedConnected(stub);
    stub.refuseInQuery = true;
    stub.invoices = [inv("1", "10"), inv("2", "12")];
    expect(await qboInvoices(["12", "10"])).toHaveLength(2);
    expect(queries()).toEqual([ONE("12"), ONE("10")]);
  });

  it("another failure is not taken for a refusal of the form", async () => {
    await seedConnected(stub);
    stub.failNext = 1;
    expect(await codeOf(qboInvoices(["10", "12"]))).toBe("http_500");
    expect(stub.apiCalls()).toHaveLength(1);
  });
});
