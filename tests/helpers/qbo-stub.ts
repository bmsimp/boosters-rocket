import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "@/lib/db/client";
import { qboConnection } from "@/lib/db/schema";
import { secretBox } from "@/lib/crypto/secret-box";

export type StubCall = { method: string; path: string; query: URLSearchParams; auth: string; body: string };
export type QboStub = {
  base: string; calls: StubCall[];
  customers: Record<string, unknown>[]; types: Record<string, unknown>[]; companyName: string;
  codes: Set<string>;           // authorization codes the token endpoint accepts, once each
  accessTokens: Set<string>;    // bearer tokens the API accepts
  refreshTokens: Set<string>;   // refresh tokens the token endpoint accepts, once each (Intuit rotates them)
  failToken: string | null;     // answer token requests with this OAuth error
  failQueryFrom: number | null; // answer query number N and later with HTTP 500 (1 is the first query)
  nullQueryBody: boolean;       // answer every query with the JSON body null
  tokenDelayMs: number; queryDelayMs: number; refreshExpiresIn: number;
  tokenCalls(): StubCall[]; apiCalls(): StubCall[]; reset(): void; close(): Promise<void>;
};

/** Intuit's token and revoke endpoints and the QuickBooks query API, enough for the portal's real client to talk to. */
export async function startQboStub(): Promise<QboStub> {
  let issued = 0, queries = 0;
  const stub = { calls: [], customers: [], types: [], companyName: "Stub Boosters", codes: new Set(), accessTokens: new Set(), refreshTokens: new Set(),
    failToken: null, failQueryFrom: null, nullQueryBody: false, tokenDelayMs: 0, queryDelayMs: 0, refreshExpiresIn: 8_640_000 } as unknown as QboStub;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const url = new URL(req.url!, "http://stub");
      const call: StubCall = { method: req.method!, path: url.pathname, query: url.searchParams, auth: req.headers.authorization ?? "", body };
      stub.calls.push(call);
      const json = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (url.pathname === "/token") {
        if (stub.tokenDelayMs) await new Promise((r) => setTimeout(r, stub.tokenDelayMs));
        const form = new URLSearchParams(body);
        if (stub.failToken) return json(400, { error: stub.failToken, error_description: "a description the portal must never store" });
        const grant = form.get("grant_type");
        const ok = grant === "authorization_code" ? stub.codes.delete(form.get("code") ?? "") : grant === "refresh_token" ? stub.refreshTokens.delete(form.get("refresh_token") ?? "") : false;
        if (!ok) return json(400, { error: "invalid_grant" });
        issued++;
        stub.accessTokens.add(`at-${issued}`); stub.refreshTokens.add(`rt-${issued}`);
        return json(200, { access_token: `at-${issued}`, refresh_token: `rt-${issued}`, expires_in: 3600, x_refresh_token_expires_in: stub.refreshExpiresIn, token_type: "bearer" });
      }
      if (url.pathname === "/revoke") return json(200, {});
      if (!url.pathname.startsWith("/v3/company/")) return json(404, {});
      if (!stub.accessTokens.has(call.auth.replace(/^Bearer /, ""))) return json(401, { fault: { error: [{ code: "3200" }] } });
      if (url.pathname.includes("/companyinfo/")) return json(200, { CompanyInfo: { CompanyName: stub.companyName } });
      if (url.pathname.endsWith("/query")) {
        queries++;
        if (stub.queryDelayMs) await new Promise((r) => setTimeout(r, stub.queryDelayMs));
        if (stub.failQueryFrom !== null && queries >= stub.failQueryFrom) return json(500, { Fault: { Error: [{ Message: "a message the portal must never store" }] } });
        if (stub.nullQueryBody) return json(200, null);
        const q = url.searchParams.get("query") ?? "";
        const entity = /from (\w+)/i.exec(q)?.[1] ?? "";
        const start = Number(/startposition (\d+)/i.exec(q)?.[1] ?? 1), max = Number(/maxresults (\d+)/i.exec(q)?.[1] ?? 100);
        const matched = entity === "CustomerType" ? stub.types
          : /active in \(true, ?false\)/i.test(q) ? stub.customers : stub.customers.filter((c) => c.Active !== false);
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
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  stub.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.tokenCalls = () => stub.calls.filter((c) => c.path === "/token");
  stub.apiCalls = () => stub.calls.filter((c) => c.path.startsWith("/v3/"));
  stub.reset = () => {
    issued = 0; queries = 0; stub.calls.length = 0; stub.customers = []; stub.types = []; stub.companyName = "Stub Boosters";
    stub.codes.clear(); stub.accessTokens.clear(); stub.refreshTokens.clear(); stub.failToken = null; stub.failQueryFrom = null; stub.nullQueryBody = false; stub.tokenDelayMs = 0; stub.queryDelayMs = 0; stub.refreshExpiresIn = 8_640_000;
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
      c("60", "No Type At All", null),
    ],
  };
}
