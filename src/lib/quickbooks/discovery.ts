import type { QboEnvironment } from "@/lib/db/schema";
import { qboEndpoints } from "./endpoints";

/**
 * Intuit's OAuth endpoints (authorize, token, revoke), read from Intuit's discovery document for the connection's
 * environment, as the owner told Intuit the portal does. The document is kept in memory for 24 hours. When it can't be
 * read, or names an endpoint that isn't https on an intuit.com host, the endpoints in ./endpoints.ts are used instead
 * and the fallback is logged: a discovery outage never blocks a connect, a refresh or a revoke, and a bad answer can't
 * send the app's secret anywhere else. After a fallback the document is asked for again in 5 minutes.
 *
 * Integration tests replace qboEndpoints() with a stub server that names no discovery document: the stub's endpoints
 * are then used as they are, and nothing is fetched.
 */
export type OAuthEndpoints = { authorize: string; token: string; revoke: string };

const LIFETIME_MS = 24 * 60 * 60_000;
const RETRY_AFTER_FALLBACK_MS = 5 * 60_000;
const TIMEOUT_MS = 5_000;

const cache = new Map<QboEnvironment, { endpoints: OAuthEndpoints; until: number }>();

/** An endpoint the document may name: an https address on intuit.com or one of its subdomains, with no user or password. */
export function isIntuitEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  const host = url.hostname.toLowerCase();
  return url.protocol === "https:" && !url.username && !url.password && (host === "intuit.com" || host.endsWith(".intuit.com"));
}

async function readDocument(address: string): Promise<OAuthEndpoints | string> {
  let res: Response;
  try {
    res = await fetch(address, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error", headers: { accept: "application/json" } });
  } catch {
    return "unreachable";
  }
  if (!res.ok) return `http_${res.status}`;
  const doc = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") return "not_json";
  const found = { authorize: doc.authorization_endpoint, token: doc.token_endpoint, revoke: doc.revocation_endpoint };
  if (Object.values(found).some((v) => v === undefined)) return "missing_endpoint";
  if (!Object.values(found).every(isIntuitEndpoint)) return "not_intuit";
  return found as OAuthEndpoints;
}

/** The authorize, token and revoke endpoints for this environment. Never throws. */
export async function oauthEndpoints(environment: QboEnvironment, now = Date.now()): Promise<OAuthEndpoints> {
  const base = qboEndpoints();
  const fallback = { authorize: base.authorize, token: base.token, revoke: base.revoke };
  const address = base.discovery?.[environment];
  if (!address) return fallback;
  const kept = cache.get(environment);
  if (kept && kept.until > now) return kept.endpoints;
  const read = await readDocument(address);
  if (typeof read !== "string") {
    cache.set(environment, { endpoints: read, until: now + LIFETIME_MS });
    return read;
  }
  console.warn(JSON.stringify({ event: "quickbooks.discovery_fallback", environment, reason: read }));
  cache.set(environment, { endpoints: fallback, until: now + RETRY_AFTER_FALLBACK_MS });
  return fallback;
}

/** For tests: forget what was read. */
export function forgetDiscovery(): void { cache.clear(); }
