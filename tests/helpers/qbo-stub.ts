import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "@/lib/db/client";
import { qboConnection } from "@/lib/db/schema";
import { secretBox } from "@/lib/crypto/secret-box";

export type StubCall = { method: string; path: string; query: URLSearchParams; auth: string; body: string };
export type QboStub = {
  base: string; calls: StubCall[];
  customers: Record<string, unknown>[]; types: Record<string, unknown>[]; companyName: string;
  /**
   * Invoices the test sets, each with `CustomerRef: { value }`. An invoice query answers only those of the customers its
   * filter names, in either form the portal sends, and leaves `InvoiceLink` out unless the request has include=invoiceLink.
   * A customer read by id (GET .../customer/<id>) answers the matching row of `customers`, with whatever
   * `BalanceWithJobs` the test gave it.
   */
  invoices: Record<string, unknown>[];
  refuseInQuery: boolean;       // answer an invoice query in the `CustomerRef in (...)` form with HTTP 400
  /**
   * Answer invoice queries with HTTP 200 and this body, which is not the QueryResponse the portal expects (a Fault, an
   * empty object, invoices that aren't a list). `inFormOnly` leaves the one-customer form answering as usual.
   */
  oddInvoiceAnswer: { body: unknown; inFormOnly?: boolean } | null;
  /**
   * Answer the roster's queries with HTTP 200 and a body of the test's choosing: `customers` for a Customer query, `types`
   * for the CustomerType query. A key left out answers as usual. For a 200 that is not a query answer (a Fault, an empty
   * object), and for a well-formed answer that holds no rows (`{ QueryResponse: {} }`) while `customers` holds some.
   */
  oddRosterAnswer: { customers?: unknown; types?: unknown } | null;
  /**
   * The products and services an Item query answers (`select * from Item`), paged like the customers. Like the item
   * query itself, this follows Intuit's documentation and has not been checked against a real company (ITEM_QUERY in
   * src/lib/quickbooks/client.ts). `oddItemAnswer` answers the Item query with HTTP 200 and that body instead.
   */
  items: Record<string, unknown>[];
  oddItemAnswer: { body: unknown } | null;
  rateLimitNext: number;        // answer this many API requests, from the next one, with HTTP 429
  failNext: number;             // answer this many API requests, from the next one, with HTTP 500
  apiDelayMs: number;           // wait this long before answering any API request (a slow QuickBooks)
  peakApi: number;              // the most API requests that were being answered at one time
  codes: Set<string>;           // authorization codes the token endpoint accepts, once each
  accessTokens: Set<string>;    // bearer tokens the API accepts
  refreshTokens: Set<string>;   // refresh tokens the token endpoint accepts, once each (Intuit rotates them)
  failToken: string | null;     // answer token requests with this OAuth error
  failQueryFrom: number | null; // answer query number N and later with HTTP 500 (1 is the first query)
  nullQueryBody: boolean;       // answer every query with the JSON body null
  failRevoke: boolean;          // answer revoke requests with HTTP 500 and revoke nothing
  /**
   * A customer update (POST .../customer with Id, SyncToken and sparse: true) is answered as QuickBooks is understood to
   * answer one; like the request itself, this has not been checked against a real company (CUSTOMER_UPDATE in
   * src/lib/quickbooks/client.ts lists what the owner's sandbox check must confirm, and the stub must follow it).
   * The SyncToken must be the stored customer's, or the answer is HTTP 400 with Fault code 5010 and nothing changes.
   * Each top-level field sent replaces the stored one; an empty string clears (a part of the address, or the phone); what
   * isn't sent stays, unless the request left out `sparse: true`, in which case it is gone, as in a full update. The
   * token goes up by one and the answer is `{ Customer }` as now stored. An Id the stub doesn't hold answers code 610.
   * The email update (EMAIL_UPDATE: `PrimaryEmailAddr: { Address }` alone, the whole field as it is to be) is the same
   * request to the same address and is answered the same way, with the same switches below; nor has it been checked.
   */
  /**
   * A customer create (POST .../customer with no Id, CUSTOMER_WRITES in src/lib/quickbooks/client.ts) is answered as
   * QuickBooks is understood to answer one, which has not been checked against a real company either: the next numeric
   * Id, SyncToken "0", Active, and the fields sent. A DisplayName that any customer has, ignoring case, or that is in
   * `otherNames` (a vendor's or an employee's), is refused with code 6240, on a create and on an update that sends one.
   * `updateFault`, `loseUpdateAnswer`, `updateServerFault` and `dropApi` apply to every write, a create too.
   */
  otherNames: string[];
  inactiveTakesChildren: boolean; // a customer made inactive takes the customers under it with it (unconfirmed: CUSTOMER_WRITES check 4)
  updateFault: string | null;   // answer every customer update with HTTP 400 and this Fault code ("6000": a validation failure; "5010": a stale object)
  beforeUpdate: ((customer: Record<string, unknown>) => void) | null; // run on the stored customer as an update for it arrives, before its SyncToken is checked: someone editing in QuickBooks at that moment
  loseUpdateAnswer: boolean;    // make a customer update, then close the connection without answering: the change is in QuickBooks and the portal never hears
  /**
   * Make a customer update, then answer it with this HTTP status (a 5xx) and a SystemFault that carries this code: a
   * server error after the change was made. QuickBooks sends its system errors as a 500 or 503 with a Fault in them.
   */
  updateServerFault: { status: number; code: string } | null;
  dropApi: boolean;             // close the connection on every API request without answering: QuickBooks can't be reached
  /**
   * The buy-out invoice writes (INVOICE_WRITES in src/lib/quickbooks/client.ts), answered as QuickBooks is understood to
   * answer them, which has not been checked against a real company. A create (POST .../invoice) adds an invoice to
   * `invoices`: the next Id from 5001, SyncToken "0", the customer, the lines and the private note sent, TotalAmt and
   * Balance the line's Amount, an InvoiceLink, and answers `{ Invoice }`. A void (POST .../invoice?operation=void with
   * Id and SyncToken) needs the stored SyncToken (else 5010), refuses an invoice with anything paid on it with
   * STUB_PAID_VOID_FAULT (the real code is unconfirmed: INVOICE_WRITES check 6), and sets TotalAmt and Balance to 0.
   * `failNext`, `rateLimitNext` and `dropApi` apply to them as to every request.
   */
  invoiceFault: string | null;    // answer every invoice write with HTTP 400 and this Fault code, making nothing
  loseInvoiceAnswer: boolean;     // make or void the invoice, then close the connection without answering
  beforeVoid: ((invoice: Record<string, unknown>) => void) | null; // run on the stored invoice as a void arrives: a payment made in QuickBooks at that moment
  dropToken: boolean;           // close the connection on every token request without answering: Intuit can't be reached
  onApiRequest: ((call: StubCall) => void | Promise<unknown>) | null; // run, and waited for, as each API request arrives, before anything about it is checked: a token revoked at that moment, say
  revokeDelayMs: number;
  tokenDelayMs: number; queryDelayMs: number; companyInfoDelayMs: number; refreshExpiresIn: number;
  tokenCalls(): StubCall[]; apiCalls(): StubCall[]; reset(): void; close(): Promise<void>;
  /**
   * Resolves once every request the stub has received has been answered, or dropped, and its delay is over: for a test
   * that left a slow request running (the portal gave up on it) and must not let it reach the next test's switches.
   */
  idle(): Promise<void>;
};

/** The code the stub refuses the void of a paid or part-paid invoice with. QuickBooks' own is not known yet (INVOICE_WRITES check 6). */
export const STUB_PAID_VOID_FAULT = "6140";

/** A value as a customer update stores it: an empty string clears, in an object too, and an object left with nothing is gone. */
function withoutEmpty(value: unknown): unknown {
  if (value === "") return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const kept = Object.entries(value).filter(([, v]) => v !== "");
  return kept.length ? Object.fromEntries(kept) : undefined;
}

/** Intuit's token and revoke endpoints and the QuickBooks query API, enough for the portal's real client to talk to. */
export async function startQboStub(): Promise<QboStub> {
  let issued = 0, queries = 0, answering = 0, open = 0;
  const waitingForIdle: (() => void)[] = [];
  const settle = (answer: () => Promise<unknown>) => {
    open++;
    void answer().finally(() => { if (--open === 0) for (const wake of waitingForIdle.splice(0)) wake(); });
  };
  const stub = { calls: [], customers: [], types: [], companyName: "Stub Boosters", codes: new Set(), accessTokens: new Set(), refreshTokens: new Set(),
    invoices: [], items: [], oddItemAnswer: null, refuseInQuery: false, oddInvoiceAnswer: null, oddRosterAnswer: null, rateLimitNext: 0, failNext: 0, apiDelayMs: 0, peakApi: 0,
    otherNames: [], inactiveTakesChildren: false, updateFault: null, beforeUpdate: null, loseUpdateAnswer: false, updateServerFault: null, dropApi: false, dropToken: false, onApiRequest: null,
    invoiceFault: null, loseInvoiceAnswer: false, beforeVoid: null,
    failToken: null, failQueryFrom: null, nullQueryBody: false, failRevoke: false, revokeDelayMs: 0, tokenDelayMs: 0, queryDelayMs: 0, companyInfoDelayMs: 0, refreshExpiresIn: 8_640_000 } as unknown as QboStub;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => settle(async () => {
      const url = new URL(req.url!, "http://stub");
      const call: StubCall = { method: req.method!, path: url.pathname, query: url.searchParams, auth: req.headers.authorization ?? "", body };
      stub.calls.push(call);
      const json = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      // A refused write, as QuickBooks sends one: always HTTP 400, told apart by the code. The words are never the portal's to keep.
      const fault = (code: string) => ({ Fault: { Error: [{ Message: "a message the portal must never store", Detail: "a detail the portal must never store", code, element: "" }], type: "ValidationFault" }, time: new Date().toISOString() });
      // Intuit's token and revoke endpoints take the app's keys as HTTP Basic: a Client ID and a secret, both present.
      const keys = /^Basic (.+)$/.exec(call.auth)?.[1];
      const hasAppKeys = keys !== undefined && /^[^:]+:.+$/.test(Buffer.from(keys, "base64").toString("utf8"));
      if (url.pathname === "/token") {
        if (stub.dropToken) { req.socket.destroy(); return; }
        if (stub.tokenDelayMs) await new Promise((r) => setTimeout(r, stub.tokenDelayMs));
        const form = new URLSearchParams(body);
        if (!hasAppKeys) return json(401, { error: "invalid_client" });
        if (stub.failToken) return json(400, { error: stub.failToken, error_description: "a description the portal must never store" });
        const grant = form.get("grant_type");
        // A code is exchanged with the address Intuit sent the Admin back to; Intuit refuses one that doesn't match.
        const redirectOk = /\/api\/quickbooks\/callback$/.test(form.get("redirect_uri") ?? "");
        const ok = grant === "authorization_code" ? redirectOk && stub.codes.delete(form.get("code") ?? "") : grant === "refresh_token" ? stub.refreshTokens.delete(form.get("refresh_token") ?? "") : false;
        if (!ok) return json(400, { error: "invalid_grant" });
        issued++;
        stub.accessTokens.add(`at-${issued}`); stub.refreshTokens.add(`rt-${issued}`);
        return json(200, { access_token: `at-${issued}`, refresh_token: `rt-${issued}`, expires_in: 3600, x_refresh_token_expires_in: stub.refreshExpiresIn, token_type: "bearer" });
      }
      if (url.pathname === "/revoke") {
        if (!hasAppKeys) return json(401, { error: "invalid_client" });
        if (stub.revokeDelayMs) await new Promise((r) => setTimeout(r, stub.revokeDelayMs));
        if (stub.failRevoke) return json(500, { error: "a revoke answer the portal must never store" });
        let token: unknown;
        try { token = (JSON.parse(body) as { token?: unknown }).token; } catch { return json(400, {}); }
        if (typeof token === "string") stub.refreshTokens.delete(token);
        return json(200, {});
      }
      if (!url.pathname.startsWith("/v3/company/")) return json(404, {});
      await stub.onApiRequest?.(call);
      if (stub.dropApi) { req.socket.destroy(); return; }
      if (!stub.accessTokens.has(call.auth.replace(/^Bearer /, ""))) return json(401, { fault: { error: [{ code: "3200" }] } });
      answering++; stub.peakApi = Math.max(stub.peakApi, answering);
      res.once("close", () => { answering--; });
      if (stub.apiDelayMs) await new Promise((r) => setTimeout(r, stub.apiDelayMs));
      if (stub.rateLimitNext > 0) { stub.rateLimitNext--; return json(429, { Fault: { Error: [{ Message: "a throttling message the portal must never store" }] } }); }
      if (stub.failNext > 0) { stub.failNext--; return json(500, { Fault: { Error: [{ Message: "a message the portal must never store" }] } }); }
      if (call.method === "POST" && /\/invoice$/.test(url.pathname)) {
        // The buy-out invoice writes (INVOICE_WRITES): a create, or a void with operation=void.
        if (stub.invoiceFault) return json(400, fault(stub.invoiceFault));
        let sent: Record<string, unknown>;
        try { sent = JSON.parse(body) as Record<string, unknown>; } catch { return json(400, fault("2010")); }
        if (url.searchParams.get("operation") === "void") {
          const stored = stub.invoices.find((i) => i.Id === sent.Id);
          if (!stored) return json(400, fault("610"));
          stub.beforeVoid?.(stored);
          if (sent.SyncToken !== String(stored.SyncToken ?? "0")) return json(400, fault("5010"));
          if (Number(stored.Balance) < Number(stored.TotalAmt)) return json(400, fault(STUB_PAID_VOID_FAULT));
          Object.assign(stored, { TotalAmt: 0, Balance: 0, SyncToken: String(Number(stored.SyncToken ?? 0) + 1), MetaData: { LastUpdatedTime: new Date().toISOString() } });
          if (stub.loseInvoiceAnswer) { req.socket.destroy(); return; }
          return json(200, { Invoice: stored, time: new Date().toISOString() });
        }
        if (url.searchParams.has("operation") || sent.Id !== undefined) return json(400, fault("2010"));
        const line = (Array.isArray(sent.Line) ? sent.Line[0] : undefined) as { Amount?: unknown } | undefined;
        if (typeof (sent.CustomerRef as { value?: unknown } | undefined)?.value !== "string" || typeof line?.Amount !== "number") return json(400, fault("2020"));
        const next = String(Math.max(5000, ...stub.invoices.map((i) => Number(i.Id)).filter((n) => !Number.isNaN(n))) + 1);
        const today = new Date().toISOString().slice(0, 10);
        const made: Record<string, unknown> = { ...sent, Id: next, SyncToken: "0", DocNumber: next, TxnDate: today, DueDate: today, TotalAmt: line.Amount, Balance: line.Amount,
          InvoiceLink: `https://connect.intuit.com/t/scs-v1-stub-${next}`, MetaData: { CreateTime: new Date().toISOString() } };
        stub.invoices.push(made);
        if (stub.loseInvoiceAnswer) { req.socket.destroy(); return; }
        return json(200, { Invoice: made, time: new Date().toISOString() });
      }
      if (call.method === "POST") {
        // The customer writes the portal sends. Anything else posted to the API is refused.
        if (!/\/customer$/.test(url.pathname)) return json(400, fault("2010"));
        if (stub.updateFault) return json(400, fault(stub.updateFault));
        let sent: Record<string, unknown>;
        try { sent = JSON.parse(body) as Record<string, unknown>; } catch { return json(400, fault("2010")); }
        // A name taken by any customer (other than the one updated), vendor or employee is refused (CUSTOMER_WRITES).
        const nameTaken = (name: unknown, except: unknown) => typeof name === "string" && [...stub.customers.filter((c) => c.Id !== except).map((c) => c.DisplayName), ...stub.otherNames]
          .some((n) => typeof n === "string" && n.trim().toLowerCase() === name.trim().toLowerCase());
        if (sent.Id === undefined) {
          // A create (CUSTOMER_WRITES.create): the next Id, version 0, active, with the fields sent.
          if (typeof sent.DisplayName !== "string" || !sent.DisplayName.trim()) return json(400, fault("2020"));
          if (nameTaken(sent.DisplayName, null)) return json(400, fault("6240"));
          const parentId = (sent.ParentRef as { value?: unknown } | undefined)?.value;
          if (parentId !== undefined && !stub.customers.some((c) => c.Id === parentId)) return json(400, fault("2500"));
          const next = String(Math.max(0, ...stub.customers.map((c) => Number(c.Id)).filter((n) => !Number.isNaN(n))) + 1);
          const made: Record<string, unknown> = { ...sent, Id: next, SyncToken: "0", Active: true, MetaData: { CreateTime: new Date().toISOString(), LastUpdatedTime: new Date().toISOString() } };
          stub.customers.push(made);
          if (stub.loseUpdateAnswer) { req.socket.destroy(); return; }
          if (stub.updateServerFault) return json(stub.updateServerFault.status, { ...fault(stub.updateServerFault.code), Fault: { ...fault(stub.updateServerFault.code).Fault, type: "SystemFault" } });
          return json(200, { Customer: made, time: new Date().toISOString() });
        }
        const at = stub.customers.findIndex((c) => c.Id === sent.Id);
        if (at < 0) return json(400, fault("610"));
        stub.beforeUpdate?.(stub.customers[at]!);
        const stored = stub.customers[at]!;
        if (sent.SyncToken !== String(stored.SyncToken ?? "0")) return json(400, fault("5010"));
        if ("DisplayName" in sent && nameTaken(sent.DisplayName, stored.Id)) return json(400, fault("6240"));
        // Making a family inactive makes the customers under it inactive too, when the test says QuickBooks does so.
        if (sent.Active === false && stub.inactiveTakesChildren) for (const c of stub.customers) if ((c.ParentRef as { value?: unknown } | undefined)?.value === stored.Id) c.Active = false;
        const updated: Record<string, unknown> = sent.sparse === true ? { ...stored } : { Id: stored.Id };
        for (const [field, value] of Object.entries(sent)) {
          if (field === "Id" || field === "SyncToken" || field === "sparse") continue;
          const kept = withoutEmpty(value);
          if (kept === undefined) delete updated[field]; else updated[field] = kept;
        }
        updated.SyncToken = String(Number(stored.SyncToken ?? 0) + 1);
        updated.MetaData = { ...(stored.MetaData as object | undefined), LastUpdatedTime: new Date().toISOString() };
        stub.customers[at] = updated;
        if (stub.loseUpdateAnswer) { req.socket.destroy(); return; }
        if (stub.updateServerFault) return json(stub.updateServerFault.status, { ...fault(stub.updateServerFault.code), Fault: { ...fault(stub.updateServerFault.code).Fault, type: "SystemFault" } });
        return json(200, { Customer: updated, time: new Date().toISOString() });
      }
      const byId = /\/customer\/([^/]+)$/.exec(url.pathname)?.[1];
      if (byId !== undefined) {
        const customer = stub.customers.find((c) => c.Id === decodeURIComponent(byId));
        // QuickBooks answers a record it doesn't have with a 400 and a fault, not a 404.
        return customer ? json(200, { Customer: customer }) : json(400, { Fault: { Error: [{ Message: "Object Not Found" }] } });
      }
      if (url.pathname.includes("/companyinfo/")) {
        if (stub.companyInfoDelayMs) await new Promise((r) => setTimeout(r, stub.companyInfoDelayMs));
        return json(200, { CompanyInfo: { CompanyName: stub.companyName } });
      }
      if (url.pathname.endsWith("/query")) {
        queries++;
        if (stub.queryDelayMs) await new Promise((r) => setTimeout(r, stub.queryDelayMs));
        if (stub.failQueryFrom !== null && queries >= stub.failQueryFrom) return json(500, { Fault: { Error: [{ Message: "a message the portal must never store" }] } });
        if (stub.nullQueryBody) return json(200, null);
        const q = url.searchParams.get("query") ?? "";
        const entity = /from (\w+)/i.exec(q)?.[1] ?? "";
        const start = Number(/startposition (\d+)/i.exec(q)?.[1] ?? 1), max = Number(/maxresults (\d+)/i.exec(q)?.[1] ?? 100);
        // An entity the stub doesn't hold is refused, as QuickBooks refuses a query it can't parse: never the customer list.
        if (!["Customer", "CustomerType", "Invoice", "Item"].includes(entity)) return json(400, { Fault: { Error: [{ Message: "QueryParserError" }] } });
        let matched: Record<string, unknown>[];
        if (entity === "Invoice") {
          // The two filters the portal sends: CustomerRef in ('1','2') and CustomerRef = '1'. Any other invoice query is refused.
          const list = /where CustomerRef in \(([^)]*)\)/i.exec(q)?.[1], one = /where CustomerRef = '([^']*)'/i.exec(q)?.[1];
          if (list === undefined && one === undefined) return json(400, { Fault: { Error: [{ Message: "QueryParserError" }] } });
          if (list !== undefined && stub.refuseInQuery) return json(400, { Fault: { Error: [{ Message: "QueryValidationError: a message the portal must never store" }] } });
          if (stub.oddInvoiceAnswer && (list !== undefined || !stub.oddInvoiceAnswer.inFormOnly)) return json(200, stub.oddInvoiceAnswer.body);
          const ids = new Set(list !== undefined ? [...list.matchAll(/'([^']*)'/g)].map((m) => m[1]!) : [one!]);
          const withLink = (url.searchParams.get("include") ?? "").toLowerCase() === "invoicelink";
          matched = stub.invoices.filter((i) => ids.has(String((i.CustomerRef as { value?: unknown } | undefined)?.value)))
            .map((i) => (withLink ? i : Object.fromEntries(Object.entries(i).filter(([field]) => field !== "InvoiceLink"))));
        } else if (entity === "Item") {
          if (stub.oddItemAnswer) return json(200, stub.oddItemAnswer.body);
          matched = stub.items;
        } else {
          const odd = stub.oddRosterAnswer ?? {};
          if (entity === "Customer" && "customers" in odd) return json(200, odd.customers);
          if (entity === "CustomerType" && "types" in odd) return json(200, odd.types);
          matched = entity === "CustomerType" ? stub.types
            : /active in \(true, ?false\)/i.test(q) ? stub.customers : stub.customers.filter((c) => c.Active !== false);
        }
        // `orderby Id` sorts as QuickBooks was seen to in the sandbox (Ids compared as numbers); without it the rows
        // come back in whatever order the test stored them. A row with no numeric Id (some tests store junk) goes last.
        const idOf = (c: unknown) => { const n = Number((c as { Id?: unknown } | null)?.Id ?? NaN); return Number.isNaN(n) ? Infinity : n; };
        const all = /\borderby Id\b/i.test(q) ? [...matched].sort((a, b) => (idOf(a) === idOf(b) ? 0 : idOf(a) - idOf(b))) : matched;
        // The portal sends the type query with no paging clause, as it was tried against the sandbox: answer with every type.
        const unpagedTypes = entity === "CustomerType" && !/startposition|maxresults/i.test(q);
        const page = unpagedTypes ? all : all.slice(start - 1, start - 1 + max);
        return json(200, { QueryResponse: page.length ? { [entity]: page, startPosition: start, maxResults: page.length } : {} });
      }
      return json(404, {});
    }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  stub.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.tokenCalls = () => stub.calls.filter((c) => c.path === "/token");
  stub.apiCalls = () => stub.calls.filter((c) => c.path.startsWith("/v3/"));
  stub.idle = () => (open === 0 ? Promise.resolve() : new Promise<void>((r) => waitingForIdle.push(r)));
  stub.reset = () => {
    stub.otherNames = []; stub.inactiveTakesChildren = false; stub.updateFault = null; stub.beforeUpdate = null; stub.loseUpdateAnswer = false; stub.updateServerFault = null; stub.dropApi = false; stub.dropToken = false; stub.onApiRequest = null;
    stub.invoiceFault = null; stub.loseInvoiceAnswer = false; stub.beforeVoid = null;
    issued = 0; queries = 0; stub.calls.length = 0; stub.customers = []; stub.types = []; stub.companyName = "Stub Boosters";
    stub.invoices = []; stub.items = []; stub.oddItemAnswer = null; stub.refuseInQuery = false; stub.oddInvoiceAnswer = null; stub.oddRosterAnswer = null; stub.rateLimitNext = 0; stub.failNext = 0; stub.apiDelayMs = 0; stub.peakApi = 0;
    stub.codes.clear(); stub.accessTokens.clear(); stub.refreshTokens.clear(); stub.failToken = null; stub.failQueryFrom = null; stub.nullQueryBody = false; stub.failRevoke = false; stub.revokeDelayMs = 0; stub.tokenDelayMs = 0; stub.queryDelayMs = 0; stub.companyInfoDelayMs = 0; stub.refreshExpiresIn = 8_640_000;
  };
  stub.close = () => new Promise<void>((r) => server.close(() => r()));
  return stub;
}

/** A connection row as if an Admin had connected a company: sealed tokens the stub accepts. */
export async function seedConnected(stub: QboStub, o: { realmId?: string; accessExpiresInMs?: number; refreshExpiresInMs?: number; connectedBy?: string | null } = {}) {
  const box = secretBox();
  const secret = box.seal("stub-secret", "qbo:client-secret"), access = box.seal("at-seed", "qbo:access-token"), refresh = box.seal("rt-seed", "qbo:refresh-token");
  stub.accessTokens.add("at-seed"); stub.refreshTokens.add("rt-seed");
  const now = Date.now();
  await db.insert(qboConnection).values({
    environment: "sandbox", clientId: "stub-client-id", clientSecretCiphertext: secret.ciphertext, clientSecretKeyId: secret.keyId,
    realmId: o.realmId ?? "9130000000000001", companyName: stub.companyName,
    accessTokenCiphertext: access.ciphertext, accessTokenKeyId: access.keyId, accessExpiresAt: new Date(now + (o.accessExpiresInMs ?? 3_600_000)),
    refreshTokenCiphertext: refresh.ciphertext, refreshTokenKeyId: refresh.keyId, refreshExpiresAt: new Date(now + (o.refreshExpiresInMs ?? 100 * 86_400_000)),
    connectedAt: new Date(now), connectedBy: o.connectedBy ?? null, lastTokenRefreshAt: new Date(now),
  });
}

export const FZN_SHAPE = { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" } as const;

/** A small company shaped like FZN's: Family at the top, Parent and Student under it, School and Vendor beside them. */
export function fznCompany() {
  const type = (Id: string, Name: string) => ({ Id, Name, Active: true });
  const c = (Id: string, DisplayName: string, typeId: string | null, extra: Record<string, unknown> = {}) => ({
    Id, DisplayName, Active: true, SyncToken: "0", MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" },
    ...(typeId ? { CustomerTypeRef: { value: typeId } } : {}), ...extra,
  });
  const under = (id: string) => ({ ParentRef: { value: id }, Job: true });
  return {
    types: [type("1", "Family"), type("2", "Parent"), type("3", "Student"), type("4", "School"), type("5", "Vendor")],
    customers: [
      c("10", "Rivera Family", "1"),
      c("11", "Ana Rivera", "2", { ...under("10"), PrimaryEmailAddr: { Address: " Ana@Example.com " }, PrimaryPhone: { FreeFormNumber: "555-0101" } }),
      c("12", "Leo Rivera", "3", under("10")),
      c("20", "Chen Family", "1"),
      c("21", "Mei Chen", "2", under("20")),
      c("30", "Lincoln High", "4", { PrimaryEmailAddr: { Address: "office@lincoln.example" }, PrimaryPhone: { FreeFormNumber: "555-0199" } }),
      c("40", "Old Family", "1", { Active: false }),
      c("50", "Stray Student", "3"),
      c("60", "No Type At All", null, { PrimaryEmailAddr: { Address: "untyped@example.com" }, PrimaryPhone: { FreeFormNumber: "555-0160" } }),
    ],
  };
}
