import { db } from "@/lib/db/client";
import { qboConnection, type QboEnvironment } from "@/lib/db/schema";
import { secretBox, SecretBoxError } from "@/lib/crypto/secret-box";
import { writeAudit } from "@/lib/audit/log";
import { errorNeedsAdmin, qboEndpoints, QboError, QBO_MINOR_VERSION } from "./endpoints";

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

export type QboGetOptions = {
  /** How long one request may take. The roster's reads keep the default; a parent's page load asks for less. */
  timeoutMs?: number;
  /** The caller's own deadline for everything it is doing: when it fires, the call ends as a timeout. */
  signal?: AbortSignal;
  /** Try once more, after a short random wait, when QuickBooks answers 429 or 5xx. */
  retry?: boolean;
  /** The company the caller means to read. When another company is the connected one, nothing is asked of it. */
  realmId?: string;
  /**
   * Refuse at once when the saved connection error is one only an Admin can fix (errorNeedsAdmin). accessToken() would
   * try the refresh again under the connection row lock, holding it across its call to Intuit; with this set, a
   * parent's page load never waits in that queue for a refresh that cannot succeed.
   */
  failFast?: boolean;
};

const RETRY_WAIT_MS = { min: 150, spread: 350 };
const timedOut = () => new QboError("QuickBooks took too long to answer.", "timeout");

/** `work`, given up on when `signal` fires. The work itself carries on (a token refresh must finish and be saved); only the wait ends. */
function within<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { work.catch(() => {}); reject(timedOut()); };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const pause = (ms: number, signal: AbortSignal | undefined) => within(new Promise<void>((r) => setTimeout(r, ms)), signal);

/** GET one QuickBooks API path. This module has no way to send anything else to the API (spec §3). */
export async function qboGet(path: string, params: Record<string, string> = {}, o: QboGetOptions = {}): Promise<unknown> {
  if (o.failFast) {
    const [c] = await db.select({ lastError: qboConnection.lastError }).from(qboConnection); // a plain read: no row lock
    if (errorNeedsAdmin(c?.lastError)) throw new QboError("QuickBooks needs to be connected again.", "needs_admin");
  }
  let force = false, refreshed = false, retried = false;
  for (;;) {
    const a = await within(accessToken({ force }), o.signal);
    force = false;
    if (o.realmId !== undefined && a.realmId !== o.realmId) throw new QboError("A different QuickBooks company is connected.", "other_company");
    const url = new URL(`${qboEndpoints().api[a.environment]}/v3/company/${encodeURIComponent(a.realmId)}/${path}`);
    for (const [k, v] of Object.entries({ ...params, minorversion: QBO_MINOR_VERSION })) url.searchParams.set(k, v);
    const timeout = AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS);
    const gaveUp = () => timeout.aborted || o.signal?.aborted === true;
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers: { authorization: `Bearer ${a.token}`, accept: "application/json" }, signal: o.signal ? AbortSignal.any([timeout, o.signal]) : timeout, redirect: "error" });
    } catch {
      throw gaveUp() ? timedOut() : new QboError("Couldn't reach QuickBooks.", "unreachable");
    }
    if (res.status === 401 && !refreshed) { refreshed = true; force = true; continue; } // the token was revoked or replaced: refresh once and try again
    if (o.retry && !retried && (res.status === 429 || res.status >= 500)) {
      retried = true;
      await res.body?.cancel().catch(() => {});
      await pause(RETRY_WAIT_MS.min + Math.random() * RETRY_WAIT_MS.spread, o.signal); // jitter: callers refused together don't come back together
      continue;
    }
    if (!res.ok) throw new QboError("QuickBooks refused the request.", `http_${res.status}`);
    try { return await res.json(); } catch { throw gaveUp() ? timedOut() : new QboError("QuickBooks sent an answer the portal couldn't read.", "bad_answer"); }
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

/** A QuickBooks record id as it may go into query text or a path: digits only. Anything else is never sent. */
export const isQboId = (id: string): boolean => /^\d{1,19}$/.test(id);

/**
 * The invoice queries, exactly as they are sent. NOT YET TRIED AGAINST A REAL QUICKBOOKS COMPANY: every other query
 * string in this file was verified in the sandbox before it was built on (spec §8), and nobody could reach the sandbox
 * for these. The owner's sandbox check must confirm, with `include=invoiceLink` and `minorversion` 75:
 *   1. that `inForm` is accepted (CustomerRef in a quoted list, ordered by Id, paged), or that QuickBooks answers it
 *      with HTTP 400, in which case qboInvoices() falls back to `oneForm`, one query per customer;
 *   2. that `oneForm` is accepted;
 *   3. that each returns only the invoices of the customers named, with `InvoiceLink` on those payable online.
 * Don't change either string without trying the new one there first. The ids are checked by isQboId() before they
 * reach a string; nothing else is ever put into query text.
 */
export const INVOICE_QUERIES = {
  inForm: (customerIds: string[], start: number) =>
    `select * from Invoice where CustomerRef in (${customerIds.map((id) => `'${id}'`).join(",")}) orderby Id startposition ${start} maxresults ${QBO_PAGE}`,
  oneForm: (customerId: string, start: number) =>
    `select * from Invoice where CustomerRef = '${customerId}' orderby Id startposition ${start} maxresults ${QBO_PAGE}`,
} as const;
/** What makes QuickBooks send InvoiceLink at all (v1 spec §8.3). */
export const INVOICE_INCLUDE = "invoiceLink";

/** True once the in-form was refused with a 400 and the one-customer form then worked: kept for the life of the process. */
let invoicesOneCustomerAtATime = false;

async function invoicePages(query: (start: number) => string, o: QboGetOptions): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let start = 1; ; start += QBO_PAGE) {
    const page = rowsOf(await qboGet("query", { query: query(start), include: INVOICE_INCLUDE }, o), "Invoice");
    out.push(...page);
    if (page.length < QBO_PAGE) return out;
  }
}

/**
 * Every invoice raised on these customers, with its pay link where QuickBooks gives one. The ids come from the roster
 * cache, never from a request; one that isn't digits only is refused here, before any query text is built.
 */
export async function qboInvoices(customerIds: string[], o: QboGetOptions = {}): Promise<Record<string, unknown>[]> {
  const ids = [...new Set(customerIds)];
  if (!ids.length || !ids.every(isQboId)) throw new QboError("That isn't a QuickBooks customer.", "bad_id");
  const oneAtATime = async () => {
    const out: Record<string, unknown>[] = [];
    for (const id of ids) out.push(...await invoicePages((start) => INVOICE_QUERIES.oneForm(id, start), o));
    return out;
  };
  if (ids.length === 1 || invoicesOneCustomerAtATime) return oneAtATime();
  try {
    return await invoicePages((start) => INVOICE_QUERIES.inForm(ids, start), o);
  } catch (e) {
    if (!(e instanceof QboError) || e.code !== "http_400") throw e;
  }
  const rows = await oneAtATime();
  invoicesOneCustomerAtATime = true; // remembered only once the other form has worked
  return rows;
}

/** One customer, read by id: used for its BalanceWithJobs, the cross-check on a family's total (v1 spec §8.3). */
export async function qboCustomerById(customerId: string, o: QboGetOptions = {}): Promise<Record<string, unknown> | null> {
  if (!isQboId(customerId)) throw new QboError("That isn't a QuickBooks customer.", "bad_id");
  const customer = ((await qboGet(`customer/${customerId}`, {}, o)) as { Customer?: unknown } | null)?.Customer;
  return typeof customer === "object" && customer !== null && !Array.isArray(customer) ? (customer as Record<string, unknown>) : null;
}
