// A fake Boosters Rocket Connect (the relay): an HTTP server on a free port that checks every signed request as the
// relay does (bmsimp/boosters-rocket-connect, src/app.ts `authenticate`: the registered public key, the 5-minute clock
// window, a spent nonce, the signature over the body's hash) and answers start, redeem, refresh, revoke, forget and
// the registration's check in the relay's shapes, keeping what it was sent. Set it as QBO_RELAY_URL by replacing the module that reads it:
//
//   const relayBase = vi.hoisted(() => ({ url: "" }));
//   vi.mock("@/lib/quickbooks/relay-address", () => ({ qboRelayUrl: () => relayBase.url }));
//
// The knobs below make it refuse, fail or slow down the way the real relay, or the way to it, can.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "@/lib/db/client";
import { qboRelay } from "@/lib/db/schema";
import { secretBox } from "@/lib/crypto/secret-box";
import { canonical, newRelayKey } from "@/lib/quickbooks/relay-sign";

export const TEST_PORTAL_ID = "brp_test0portal0id01";
/** The name the fake relay says the portal was registered under, unless a test sets another. */
export const CHECK_NAME = "Test Boosters";
const CLOCK_SKEW_MS = 5 * 60_000;
const MAX_BODY = 8 * 1024;

export type RelayCall = { path: string; portal: string; body: Record<string, unknown> | null; status: number; refusal: string | null };
type Grant = { environment: string; realmId: string; portalState: string; portalId: string; expiresAt: number };

export type RelayStub = {
  base: string;
  /** Every request, answered or refused, with why it was refused (the real relay keeps that only in its events). */
  calls: RelayCall[];
  /** The registered portals: id to public key (base64url of the raw 32 bytes). */
  portals: Map<string, string>;
  /** Refresh tokens Intuit, behind the relay, accepts, once each; and the refresh tokens revoked. */
  refreshTokens: Set<string>; revoked: string[];
  /** The connections a portal asked the relay to forget, as `environment:realmId`; Intuit is asked nothing for them. */
  forgotten: string[];
  /** How far ahead of the portal's clock the relay's is: past 5 minutes, every signature is refused as stale. */
  clockAheadMs: number;
  refuseNext: number;               // answer this many signed requests, from the next one, 401 unauthorized
  busyNext: number;                 // answer this many with 429 too_many_requests
  failNext: number;                 // answer this many with 502 (a failed call to Intuit, or the relay down behind its edge)
  delayMs: number;                  // wait this long before answering (a slow relay)
  refreshError: string | null;      // answer refreshes 400 with this word of Intuit's ("invalid_grant")
  rotateOnRefresh: boolean;         // a refresh answers a new refresh token (Intuit rotates it); false answers the same one
  revokeConfirmed: boolean;         // a revoke answers { revoked: true }
  oddAnswer: { path: string; body: unknown; status?: number } | null; // answer this body (a 200 unless given) on this path, instead of the usual
  /** Run this once, on the next request to this path that passes the checks, before answering it (what happens meanwhile). */
  beforeAnswer: { path: string; run: () => Promise<void> } | null;
  /** What the registration's check answers: the name the portal was registered under, and the environments it may use. */
  checkName: string; checkEnvironments: string[];
  /** The redemption code the relay would put in the browser's return to the portal, for this state and company. */
  grantFor(portalState: string, realmId: string, o?: { environment?: string; portalId?: string; expiresInMs?: number }): string;
  reset(): void; close(): Promise<void>;
};

const send = (res: import("node:http").ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

async function holds(publicKey: string, message: string, signature: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
  try {
    const key = await crypto.subtle.importKey("raw", Buffer.from(publicKey, "base64url"), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, Buffer.from(signature, "base64url"), new TextEncoder().encode(message));
  } catch {
    return false;
  }
}

export async function startRelayStub(): Promise<RelayStub> {
  const grants = new Map<string, Grant>();
  const nonces = new Set<string>();
  let issued = 0;
  const stub = {
    base: "", calls: [] as RelayCall[], portals: new Map<string, string>(), refreshTokens: new Set<string>(), revoked: [] as string[], forgotten: [] as string[],
    clockAheadMs: 0, refuseNext: 0, busyNext: 0, failNext: 0, delayMs: 0, refreshError: null as string | null, rotateOnRefresh: true, revokeConfirmed: true,
    oddAnswer: null as { path: string; body: unknown; status?: number } | null, beforeAnswer: null as { path: string; run: () => Promise<void> } | null, checkName: CHECK_NAME, checkEnvironments: ["production", "sandbox"],
  } as RelayStub;
  const tokens = () => { issued++; return { access_token: `relay-at-${issued}`, refresh_token: `relay-rt-${issued}`, token_type: "bearer", expires_in: 3600, x_refresh_token_expires_in: 8_640_000 }; };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => void (async () => {
      const path = (req.url ?? "").split("?")[0]!;
      const raw = Buffer.concat(chunks).toString("utf8");
      const h = (k: string) => String(req.headers[k] ?? "");
      const call: RelayCall = { path, portal: h("x-brc-portal"), body: null, status: 0, refusal: null };
      stub.calls.push(call);
      const answer = (status: number, body: unknown, refusal: string | null = null) => { call.status = status; call.refusal = refusal; send(res, status, body); };
      if (stub.delayMs) await new Promise((r) => setTimeout(r, stub.delayMs));
      if (req.method !== "POST" || !["/v1/connect/start", "/v1/connect/redeem", "/v1/token/refresh", "/v1/token/revoke", "/v1/portal/check", "/v1/connection/forget"].includes(path)) return answer(404, { error: "not_found" });
      if (raw.length > MAX_BODY) return answer(413, { error: "too_large" });
      // The relay's checks, in its order; every refusal is the same 401.
      const id = h("x-brc-portal"), ts = h("x-brc-timestamp"), nonce = h("x-brc-nonce"), sig = h("x-brc-signature");
      const refuse = (why: string) => answer(401, { error: "unauthorized" }, why);
      if (!/^brp_[a-z0-9]{16}$/.test(id) || !/^\d{1,12}$/.test(ts) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return refuse("malformed");
      const publicKey = stub.portals.get(id);
      if (!publicKey) return refuse("unknown_portal");
      if (Math.abs(Number(ts) * 1000 - (Date.now() + stub.clockAheadMs)) > CLOCK_SKEW_MS) return refuse("clock");
      if (!(await holds(publicKey, canonical(req.method, path, ts, nonce, raw), sig))) return refuse("signature");
      if (nonces.has(`${id}:${nonce}`)) return refuse("replay");
      nonces.add(`${id}:${nonce}`);
      if (stub.refuseNext > 0) { stub.refuseNext--; return refuse("knob"); }
      if (stub.busyNext > 0) { stub.busyNext--; return answer(429, { error: "too_many_requests" }); }
      if (stub.failNext > 0) { stub.failNext--; return answer(502, { error: "unreachable" }); }
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { return answer(400, { error: "bad_request" }); }
      call.body = body;
      if (stub.beforeAnswer?.path === path) { const meanwhile = stub.beforeAnswer; stub.beforeAnswer = null; await meanwhile.run(); }
      if (stub.oddAnswer?.path === path) return answer(stub.oddAnswer.status ?? 200, stub.oddAnswer.body);
      const env = body.environment;
      const envOk = env === "production" || env === "sandbox";
      switch (path) {
        case "/v1/portal/check": return answer(200, { status: "ok", portal: { name: stub.checkName, environments: stub.checkEnvironments } });
        case "/v1/connect/start": {
          if (!envOk) return answer(400, { error: "environment_not_allowed" });
          if (typeof body.portal_state !== "string" || !/^[A-Za-z0-9_-]{16,200}$/.test(body.portal_state)) return answer(400, { error: "bad_request" });
          return answer(200, { url: `${stub.base}/v1/connect/go/${randomBytes(32).toString("base64url")}`, expires_in: 600 });
        }
        case "/v1/connect/redeem": {
          const code = typeof body.code === "string" ? body.code : "";
          const g = grants.get(code);
          grants.delete(code); // any try spends it, as the relay's GrantBox does
          if (!g || g.portalId !== id || g.expiresAt < Date.now()) return answer(400, { error: "invalid_code" });
          const t = tokens();
          stub.refreshTokens.add(t.refresh_token);
          return answer(200, { ...t, realm_id: g.realmId, environment: g.environment, portal_state: g.portalState });
        }
        case "/v1/token/refresh": {
          if (!envOk) return answer(400, { error: "environment_not_allowed" });
          if (stub.refreshError) return answer(400, { error: stub.refreshError });
          const given = typeof body.refresh_token === "string" ? body.refresh_token : "";
          if (!stub.refreshTokens.has(given)) return answer(400, { error: "invalid_grant" });
          const t = tokens();
          if (stub.rotateOnRefresh) { stub.refreshTokens.delete(given); stub.refreshTokens.add(t.refresh_token); } else t.refresh_token = given;
          return answer(200, t);
        }
        case "/v1/connection/forget": {
          if (!envOk) return answer(400, { error: "environment_not_allowed" });
          if (typeof body.realm_id !== "string" || !/^\d{1,32}$/.test(body.realm_id)) return answer(400, { error: "bad_request" });
          stub.forgotten.push(`${String(env)}:${body.realm_id}`);
          return answer(200, { status: "ok" });
        }
        default: {
          if (!envOk) return answer(400, { error: "environment_not_allowed" });
          if (typeof body.token !== "string" || body.token.length < 1) return answer(400, { error: "bad_request" });
          if (body.realm_id !== undefined && (typeof body.realm_id !== "string" || !/^\d{1,32}$/.test(body.realm_id))) return answer(400, { error: "bad_request" });
          if (stub.revokeConfirmed) { stub.refreshTokens.delete(body.token); stub.revoked.push(body.token); }
          return answer(200, { revoked: stub.revokeConfirmed });
        }
      }
    })().catch(() => { if (!res.headersSent) send(res, 500, { error: "server_error" }); }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  stub.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.grantFor = (portalState, realmId, o = {}) => {
    const code = randomBytes(32).toString("base64url");
    grants.set(code, { environment: o.environment ?? "sandbox", realmId, portalState, portalId: o.portalId ?? TEST_PORTAL_ID, expiresAt: Date.now() + (o.expiresInMs ?? 120_000) });
    return code;
  };
  stub.reset = () => {
    grants.clear(); nonces.clear(); issued = 0;
    stub.calls.length = 0; stub.portals.clear(); stub.refreshTokens.clear(); stub.revoked.length = 0; stub.forgotten.length = 0;
    stub.clockAheadMs = 0; stub.refuseNext = 0; stub.busyNext = 0; stub.failNext = 0; stub.delayMs = 0; stub.refreshError = null;
    stub.rotateOnRefresh = true; stub.revokeConfirmed = true; stub.oddAnswer = null; stub.beforeAnswer = null; stub.checkName = CHECK_NAME; stub.checkEnvironments = ["production", "sandbox"];
  };
  stub.close = () => new Promise<void>((r) => server.close(() => r()));
  return stub;
}

/**
 * The portal registered with the fake relay, as an Admin would leave it: a key made and sealed in qbo_relay, the
 * portal id saved, and the public key registered with the stub under that id. Answers the private key's PKCS#8, for a
 * test that looks for it where it must never be.
 */
export async function seedRelayRegistration(stub: RelayStub, o: { portalId?: string | null } = {}): Promise<{ publicKey: string; privateKeyPkcs8: string }> {
  const key = await newRelayKey();
  const sealed = secretBox().seal(key.privateKeyPkcs8, "qbo:relay-key");
  const portalId = o.portalId === undefined ? TEST_PORTAL_ID : o.portalId;
  await db.insert(qboRelay).values({ publicKey: key.publicKey, privateKeyCiphertext: sealed.ciphertext, privateKeyKeyId: sealed.keyId, keyMadeAt: new Date(), portalId, portalIdSavedAt: portalId ? new Date() : null });
  if (portalId) stub.portals.set(portalId, key.publicKey);
  return key;
}
