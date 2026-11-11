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
  tokenDelayMs: number; refreshExpiresIn: number;
  tokenCalls(): StubCall[]; apiCalls(): StubCall[]; reset(): void; close(): Promise<void>;
};

/** Intuit's token and revoke endpoints and the QuickBooks query API, enough for the portal's real client to talk to. */
export async function startQboStub(): Promise<QboStub> {
  let issued = 0, queries = 0;
  const stub = { calls: [], customers: [], types: [], companyName: "Stub Boosters", codes: new Set(), accessTokens: new Set(), refreshTokens: new Set(),
    failToken: null, failQueryFrom: null, tokenDelayMs: 0, refreshExpiresIn: 8_640_000 } as unknown as QboStub;
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
        if (stub.failQueryFrom !== null && queries >= stub.failQueryFrom) return json(500, { Fault: { Error: [{ Message: "a message the portal must never store" }] } });
        const q = url.searchParams.get("query") ?? "";
        const entity = /from (\w+)/i.exec(q)?.[1] ?? "";
        const start = Number(/startposition (\d+)/i.exec(q)?.[1] ?? 1), max = Number(/maxresults (\d+)/i.exec(q)?.[1] ?? 100);
        const all = entity === "CustomerType" ? stub.types
          : /active in \(true, ?false\)/i.test(q) ? stub.customers : stub.customers.filter((c) => c.Active !== false);
        const page = all.slice(start - 1, start - 1 + max);
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
    stub.codes.clear(); stub.accessTokens.clear(); stub.refreshTokens.clear(); stub.failToken = null; stub.failQueryFrom = null; stub.tokenDelayMs = 0; stub.refreshExpiresIn = 8_640_000;
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
