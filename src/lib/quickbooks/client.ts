import { db } from "@/lib/db/client";
import { qboConnection, type QboEnvironment } from "@/lib/db/schema";
import { secretBox, SecretBoxError } from "@/lib/crypto/secret-box";
import { writeAudit } from "@/lib/audit/log";
import { qboEndpoints, QboError, QBO_MINOR_VERSION } from "./endpoints";

const TIMEOUT_MS = 15_000;
const REFRESH_EARLY_MS = 5 * 60_000;
export const QBO_PAGE = 1000;
export const QBO_AAD = { secret: "qbo:client-secret", access: "qbo:access-token", refresh: "qbo:refresh-token" } as const;
export const WORKER_ACTOR = { door: "system", id: null, label: "worker" } as const;

export type TokenSet = { accessToken: string; refreshToken: string; accessExpiresAt: Date; refreshExpiresAt: Date };
export type QboApp = { clientId: string; clientSecret: string };

/** One request to Intuit's token endpoint (a code exchange or a refresh). Failures keep Intuit's error code and none of its text. */
export async function tokenRequest(form: Record<string, string>, app: QboApp): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetch(qboEndpoints().token, {
      method: "POST", body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error",
      headers: { authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    });
  } catch {
    throw new QboError("Couldn't reach Intuit.", "unreachable");
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; x_refresh_token_expires_in?: unknown; error?: unknown };
  if (!res.ok || typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
    const code = typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : `http_${res.status}`;
    throw new QboError(code === "invalid_grant" ? "Intuit no longer accepts this connection. Connect QuickBooks again." : "Intuit refused the request.", code);
  }
  const seconds = (v: unknown, fallback: number) => (typeof v === "number" && v > 0 ? v : fallback);
  const now = Date.now();
  return {
    accessToken: body.access_token, refreshToken: body.refresh_token,
    accessExpiresAt: new Date(now + seconds(body.expires_in, 3600) * 1000),
    refreshExpiresAt: new Date(now + seconds(body.x_refresh_token_expires_in, 100 * 86_400) * 1000),
  };
}

/** The columns that hold a token set, sealed, with the refresh recorded and any earlier error cleared. */
export function sealTokens(t: TokenSet) {
  const box = secretBox();
  const access = box.seal(t.accessToken, QBO_AAD.access), refresh = box.seal(t.refreshToken, QBO_AAD.refresh);
  return {
    accessTokenCiphertext: access.ciphertext, accessTokenKeyId: access.keyId, accessExpiresAt: t.accessExpiresAt,
    refreshTokenCiphertext: refresh.ciphertext, refreshTokenKeyId: refresh.keyId, refreshExpiresAt: t.refreshExpiresAt,
    lastTokenRefreshAt: new Date(), lastError: null, lastErrorAt: null, updatedAt: new Date(),
  };
}

type Access = { token: string; realmId: string; environment: QboEnvironment };

/**
 * A usable access token. Refreshes it when it is expired or within 5 minutes of expiring (or when `force` is set), under
 * a lock on the connection row: Intuit's refresh token works once, so two callers must never both spend it (spec §4).
 */
export async function accessToken(o: { force?: boolean } = {}): Promise<Access> {
  const r = await db.transaction(async (tx): Promise<{ ok: true; access: Access } | { ok: false; error: QboError }> => {
    const [c] = await tx.select().from(qboConnection).for("update");
    if (!c?.realmId || !c.refreshTokenCiphertext || !c.refreshTokenKeyId) return { ok: false, error: new QboError("QuickBooks isn't connected.", "not_connected") };
    try {
      const box = secretBox(); // inside the try: a server key that can't be used is recorded like any unreadable secret
      if (!o.force && c.accessTokenCiphertext && c.accessTokenKeyId && c.accessExpiresAt && c.accessExpiresAt.getTime() - Date.now() > REFRESH_EARLY_MS) {
        return { ok: true, access: { token: box.open({ ciphertext: c.accessTokenCiphertext, keyId: c.accessTokenKeyId }, QBO_AAD.access), realmId: c.realmId, environment: c.environment } };
      }
      const t = await tokenRequest(
        { grant_type: "refresh_token", refresh_token: box.open({ ciphertext: c.refreshTokenCiphertext, keyId: c.refreshTokenKeyId }, QBO_AAD.refresh) },
        { clientId: c.clientId, clientSecret: box.open({ ciphertext: c.clientSecretCiphertext, keyId: c.clientSecretKeyId }, QBO_AAD.secret) });
      await tx.update(qboConnection).set(sealTokens(t));
      return { ok: true, access: { token: t.accessToken, realmId: c.realmId, environment: c.environment } };
    } catch (e) {
      const error = e instanceof QboError ? e
        : e instanceof SecretBoxError ? new QboError("The saved QuickBooks keys can't be read with this server's encryption key. Connect QuickBooks again.", "unreadable")
        : null;
      if (!error) throw e;
      // Returned, not thrown, so this record of the failure is committed. Audited only when the error changes, so a
      // failure repeated on every try doesn't bury the log; the time of the latest try is always kept.
      const lastError = `${error.message} (${error.code})`;
      await tx.update(qboConnection).set({ lastError, lastErrorAt: new Date(), updatedAt: new Date() });
      if (lastError !== c.lastError) await writeAudit({ actor: WORKER_ACTOR, action: "quickbooks.token_refresh.failed", targetType: "qbo_connection", targetId: "singleton", after: { code: error.code } }, tx);
      return { ok: false, error };
    }
  });
  if (!r.ok) throw r.error;
  return r.access;
}

/** GET one QuickBooks API path. This module has no way to send anything else to the API (spec §3). */
export async function qboGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const a = await accessToken({ force: attempt === 1 });
    const url = new URL(`${qboEndpoints().api[a.environment]}/v3/company/${encodeURIComponent(a.realmId)}/${path}`);
    for (const [k, v] of Object.entries({ ...params, minorversion: QBO_MINOR_VERSION })) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers: { authorization: `Bearer ${a.token}`, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
    } catch {
      throw new QboError("Couldn't reach QuickBooks.", "unreachable");
    }
    if (res.status === 401 && attempt === 0) continue; // the token was revoked or replaced: refresh once and try again
    if (!res.ok) throw new QboError("QuickBooks refused the request.", `http_${res.status}`);
    try { return await res.json(); } catch { throw new QboError("QuickBooks sent an answer the portal couldn't read.", "bad_answer"); }
  }
}

const rowsOf = (body: unknown, entity: string): Record<string, unknown>[] => {
  const rows = (body as { QueryResponse?: Record<string, unknown> }).QueryResponse?.[entity]; // a null body throws, and is recorded as unexpected
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
};

/**
 * Every customer, a page at a time, in Id order: without an order a customer could be skipped or repeated between
 * pages. `where` is fixed text from this codebase, never anything a person typed.
 */
export async function qboQueryAll(entity: "Customer", where = ""): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let start = 1; ; start += QBO_PAGE) {
    // With where = "Active in (true, false)" this is the string verified against the sandbox on 2026-11-11 (spec §8),
    // starting at 1. Don't change it without trying the new string there first.
    const page = rowsOf(await qboGet("query", { query: `select * from ${entity}${where ? ` where ${where}` : ""} orderby Id startposition ${start} maxresults ${QBO_PAGE}` }), entity);
    out.push(...page);
    if (page.length < QBO_PAGE) return out;
  }
}

/** Every customer type, in one request with no paging clause. */
export async function qboCustomerTypes(): Promise<Record<string, unknown>[]> {
  // The string verified against the sandbox on 2026-11-11 (spec §8). Don't change it (a paging clause, say) without
  // trying the new string there first.
  return rowsOf(await qboGet("query", { query: "select * from CustomerType" }), "CustomerType");
}
