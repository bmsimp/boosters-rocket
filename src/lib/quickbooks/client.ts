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
type Refreshed = { ok: true; access: Access } | { ok: false; error: QboError };

/** The saved access token, still sealed, when it has more than 5 minutes left; null when it must be refreshed first. */
const savedToken = (c: typeof qboConnection.$inferSelect) =>
  c.accessTokenCiphertext && c.accessTokenKeyId && c.accessExpiresAt && c.accessExpiresAt.getTime() - Date.now() > REFRESH_EARLY_MS
    ? { ciphertext: c.accessTokenCiphertext, keyId: c.accessTokenKeyId } : null;

/** Postgres could not take a lock at once (lock_not_available). Drizzle wraps the driver's error, so its cause is read too. */
const lockNotAvailable = (e: unknown): boolean => {
  const code = (v: unknown) => (typeof v === "object" && v !== null ? (v as { code?: unknown }).code : undefined);
  return code(e) === "55P03" || code((e as { cause?: unknown } | null)?.cause) === "55P03";
};

/**
 * A usable access token. Refreshes it when it is expired or within 5 minutes of expiring (or when `force` is set), under
 * a lock on the connection row: Intuit's refresh token works once, so two callers must never both spend it (spec §4).
 *
 * A caller waits its turn for that lock, through another caller's request to Intuit if need be. With `noWait` it does
 * not: when the row is locked, the call ends at once as "busy" and holds nothing.
 */
export async function accessToken(o: { force?: boolean; noWait?: boolean } = {}): Promise<Access> {
  let r: Refreshed;
  try {
    r = await tokenUnderLock(o);
  } catch (e) {
    if (o.noWait && lockNotAvailable(e)) throw new QboError("QuickBooks is busy just now.", "busy");
    throw e;
  }
  if (!r.ok) throw r.error;
  return r.access;
}

function tokenUnderLock(o: { force?: boolean; noWait?: boolean }): Promise<Refreshed> {
  return db.transaction(async (tx): Promise<Refreshed> => {
    const [c] = await (o.noWait ? tx.select().from(qboConnection).for("update", { noWait: true }) : tx.select().from(qboConnection).for("update"));
    if (!c?.realmId || !c.refreshTokenCiphertext || !c.refreshTokenKeyId) return { ok: false, error: new QboError("QuickBooks isn't connected.", "not_connected") };
    try {
      const box = secretBox(); // inside the try: a server key that can't be used is recorded like any unreadable secret
      const saved = o.force ? null : savedToken(c);
      if (saved) return { ok: true, access: { token: box.open(saved, QBO_AAD.access), realmId: c.realmId, environment: c.environment } };
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
}

/** The refresh a page load started, which the others in this process wait for. `forced`: it will not settle for the saved token. */
let pageRefresh: { forced: boolean; work: Promise<Access> } | null = null;

/**
 * The access token for a parent's page load, and for a parent's save. A page load must not wait in line for the connection row, or keep a
 * database connection after the page has given up: a refresh holds the row through its request to Intuit, 15 seconds
 * when Intuit hangs, and callers queued behind it would each hold one of the pool's 10 connections, then each make
 * that request in turn.
 *
 * A saved token that is still good is read with no lock at all. One that needs refreshing is refreshed by one caller
 * in this process; the others wait for that refresh in memory, each for as long as its own page will wait. The refresh
 * takes the row only if it is free (`noWait`): held by a job or by another copy of the portal, the answer is "busy".
 * So however many pages are loading, one database connection at most is kept for a refresh.
 */
async function accessTokenForPage(force: boolean): Promise<Access> {
  if (!force) {
    const [c] = await db.select().from(qboConnection); // a plain read: no row lock
    const saved = c?.realmId && c.refreshTokenCiphertext ? savedToken(c) : null;
    if (c?.realmId && saved) {
      // A key that can't be read is left to the refresh below, which records it.
      try { return { token: secretBox().open(saved, QBO_AAD.access), realmId: c.realmId, environment: c.environment }; } catch (e) { if (!(e instanceof SecretBoxError)) throw e; }
    }
  }
  if (!pageRefresh || (force && !pageRefresh.forced)) {
    const mine = { forced: force, work: accessToken({ force, noWait: true }).finally(() => { if (pageRefresh === mine) pageRefresh = null; }) };
    pageRefresh = mine;
  }
  return pageRefresh.work;
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
   * For a parent's page load, which must answer soon and leave nothing queued behind it. Refuses at once when the saved
   * connection error is one only an Admin can fix (errorNeedsAdmin), and never waits in line for the connection row:
   * the token comes from accessTokenForPage(), which refuses as "busy" when the row is held elsewhere.
   */
  failFast?: boolean;
  /** Waited for before each request is sent, a retry included: the worker's read of every family keeps its gentle pace with it. */
  pace?: () => Promise<void>;
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

/** Refuses when the saved connection error is one only an Admin can fix (QboGetOptions.failFast). A plain read: no row lock. */
async function refuseWhenOnlyAnAdminCanFixIt(): Promise<void> {
  const [c] = await db.select({ lastError: qboConnection.lastError }).from(qboConnection);
  if (errorNeedsAdmin(c?.lastError)) throw new QboError("QuickBooks needs to be connected again.", "needs_admin");
}

/**
 * GET one QuickBooks API path. Every read goes through here. The one thing this module can change in QuickBooks is a
 * customer's phone and billing address, through qboUpdateCustomerContact() at the foot of the file and nothing else
 * (tests/unit/quickbooks-writes.test.ts), and since the second write, its email field (qboUpdateCustomerEmail, below it).
 */
export async function qboGet(path: string, params: Record<string, string> = {}, o: QboGetOptions = {}): Promise<unknown> {
  if (o.failFast) await refuseWhenOnlyAnAdminCanFixIt();
  let force = false, refreshed = false, retried = false;
  for (;;) {
    const a = await within(o.failFast ? accessTokenForPage(force) : accessToken({ force }), o.signal);
    force = false;
    if (o.realmId !== undefined && a.realmId !== o.realmId) throw new QboError("A different QuickBooks company is connected.", "other_company");
    const url = new URL(`${qboEndpoints().api[a.environment]}/v3/company/${encodeURIComponent(a.realmId)}/${path}`);
    for (const [k, v] of Object.entries({ ...params, minorversion: QBO_MINOR_VERSION })) url.searchParams.set(k, v);
    if (o.pace) await within(o.pace(), o.signal);
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

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const badAnswer = () => new QboError("QuickBooks sent an answer the portal couldn't read.", "bad_answer");

/**
 * The rows of a query answer. Every query the portal sends is read through here, because an answer with no rows is
 * acted on: no invoices is shown to a parent as "nothing owed", and no customers would be saved as an empty roster,
 * which ends every parent's access. So "no rows" is taken from one shape only, the one QuickBooks gives: an object
 * whose QueryResponse is an object holding no rows at all. Anything else with status 200 is refused, never read as an
 * empty list: a body that isn't an object, a missing QueryResponse, rows that aren't a list, rows of another entity.
 * A Fault sent with status 200 is a refusal and gets its own code ("fault"); none of its text is kept.
 */
function strictRowsOf(body: unknown, entity: string): Record<string, unknown>[] {
  if (!isPlainObject(body)) throw badAnswer();
  if ("Fault" in body || "fault" in body) throw new QboError("QuickBooks refused the request.", "fault");
  const answer = body.QueryResponse;
  if (!isPlainObject(answer)) throw badAnswer();
  const rows = answer[entity];
  if (rows === undefined) {
    // Only paging numbers may sit beside no rows: a list or an object here is the answer to some other question.
    if (Object.values(answer).some((v) => typeof v === "object" && v !== null)) throw badAnswer();
    return [];
  }
  if (!Array.isArray(rows)) throw badAnswer();
  return rows as Record<string, unknown>[];
}

/**
 * Every customer, a page at a time, in Id order: without an order a customer could be skipped or repeated between
 * pages. `where` is fixed text from this codebase, never anything a person typed. Each page is read strictly
 * (strictRowsOf): a 200 that isn't a query answer fails the whole read, and is never a short last page.
 */
export async function qboQueryAll(entity: "Customer", where = ""): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let start = 1; ; start += QBO_PAGE) {
    // With where = "Active in (true, false)" this is the string verified against the sandbox on 2026-11-11 (spec §8),
    // starting at 1. Don't change it without trying the new string there first.
    const page = strictRowsOf(await qboGet("query", { query: `select * from ${entity}${where ? ` where ${where}` : ""} orderby Id startposition ${start} maxresults ${QBO_PAGE}` }), entity);
    out.push(...page);
    if (page.length < QBO_PAGE) return out;
  }
}

/** Every customer type, in one request with no paging clause, read strictly like the customers. */
export async function qboCustomerTypes(): Promise<Record<string, unknown>[]> {
  // The string verified against the sandbox on 2026-11-11 (spec §8). Don't change it (a paging clause, say) without
  // trying the new string there first.
  return strictRowsOf(await qboGet("query", { query: "select * from CustomerType" }), "CustomerType");
}

/** A QuickBooks record id as it may go into query text or a path: digits only. Anything else is never sent. */
export const isQboId = (id: string): boolean => /^\d{1,19}$/.test(id);

/**
 * The invoice queries, exactly as they are sent. NOT YET TRIED AGAINST A REAL QUICKBOOKS COMPANY: every other query
 * string in this file was verified in the sandbox before it was built on (spec §8), and nobody could reach the sandbox
 * for these. The owner's sandbox check must confirm, with `include=invoiceLink` and `minorversion` 75:
 *   1. that `inForm` is accepted (CustomerRef in a quoted list, ordered by Id, paged), or that QuickBooks answers it
 *      with HTTP 400 (or a Fault with status 200), in which case qboInvoices() falls back to `oneForm`, one query per
 *      customer;
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

/**
 * The item query, exactly as it is sent: QuickBooks' products and services, for staff to choose what a payment
 * requirement is met by. NOT YET TRIED AGAINST A REAL QUICKBOOKS COMPANY, like INVOICE_QUERIES above: nobody could
 * reach the sandbox for it. The owner's sandbox check must confirm, with `minorversion` 75:
 *   1. that it is accepted, paged and ordered as the customer query is (`orderby Id startposition 1 maxresults 1000`);
 *   2. that it answers the company's active products and services, each with `Id`, `Name`, `Type` and `Active`, and
 *      that a company with none answers a QueryResponse holding no rows (strictRowsOf);
 *   3. that the `Id` of each is the `ItemRef.value` its invoice lines carry (itemsOf in src/lib/money/invoices.ts).
 * Don't change it without trying the new one there first.
 */
export const ITEM_QUERY = (start: number) => `select * from Item orderby Id startposition ${start} maxresults ${QBO_PAGE}`;

/** Every product and service, a page at a time, read strictly: a 200 that isn't a query answer fails the whole read. */
export async function qboItems(o: QboGetOptions = {}): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let start = 1; ; start += QBO_PAGE) {
    const page = strictRowsOf(await qboGet("query", { query: ITEM_QUERY(start) }, o), "Item");
    out.push(...page);
    if (page.length < QBO_PAGE) return out;
  }
}

/** True once the in-form was refused (a 400, or a Fault) and the one-customer form then worked: kept for the life of the process. */
let invoicesOneCustomerAtATime = false;

async function invoicePages(query: (start: number) => string, o: QboGetOptions): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let start = 1; ; start += QBO_PAGE) {
    const page = strictRowsOf(await qboGet("query", { query: query(start), include: INVOICE_INCLUDE }, o), "Invoice");
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
    // The form itself was refused: with a 400, or with a Fault sent as a 200. Anything else is not about the form.
    if (!(e instanceof QboError) || (e.code !== "http_400" && e.code !== "fault")) throw e;
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

export type CustomerAddress = { line1: string; line2: string; city: string; region: string; postalCode: string; country: string };
/** What a contact update may change: the phone, the billing address, or both. A part left out is not sent, and so not touched. */
export type CustomerContactChange = { phone?: string; address?: CustomerAddress };

/**
 * The one write the portal sends to QuickBooks, exactly as it is sent, and the Fault codes its callers rely on.
 * NOT YET TRIED AGAINST A REAL QUICKBOOKS COMPANY: nobody could reach the sandbox when this was built, so it follows
 * Intuit's documentation as remembered. The owner's sandbox check must confirm, with `minorversion` 75:
 *   1. `POST /v3/company/<realm>/customer` with `{ Id, SyncToken, sparse: true, PrimaryPhone: { FreeFormNumber } }`
 *      answers 200 with `{ Customer: {...} }`, changes the phone and nothing else (DisplayName, the email, ParentRef,
 *      CustomerTypeRef, Active and BillAddr are as they were), and raises SyncToken;
 *   2. the same with `BillAddr: { Line1, Line2, Line3, Line4, Line5, City, CountrySubDivisionCode, PostalCode, Country }`
 *      replaces the billing address, and the phone is as it was;
 *   3. HOW A FIELD IS CLEARED. This sends an empty string: `PrimaryPhone: { FreeFormNumber: "" }` for no phone, and
 *      `""` for each part of the address left empty (Line3 to Line5 always, since the portal shows two lines). Confirm
 *      that QuickBooks accepts the empty strings and that the field is then empty in QuickBooks. If it refuses them, or
 *      keeps the old value, `body` below is the one place to change, and tests/helpers/qbo-stub.ts must follow it;
 *   4. an update with an old SyncToken answers HTTP 400 with `Fault.Error[0].code` "5010" (`faults.stale`) and
 *      changes nothing;
 *   5. a value QuickBooks will not take (a phone of 31 characters, say) answers HTTP 400 with a code that
 *      `faults.validation` matches (2xxx, or 6000), and changes nothing;
 *   6. for the record: a duplicate DisplayName is "6240" (`faults.duplicateName`). This update never sends a name, so
 *      the code is kept only to name it in the audit log if it ever comes back.
 * A stale object, a duplicate name and a validation failure all arrive as HTTP 400: the code is what tells them apart.
 * Don't change the body without trying the new one in the sandbox first.
 */
export const CUSTOMER_UPDATE = {
  /** A create and an update share this address; `sparse: true` with an Id and a SyncToken makes it an update of the fields sent. */
  path: "customer",
  body: (customerId: string, syncToken: string, change: CustomerContactChange) => ({
    Id: customerId, SyncToken: syncToken, sparse: true,
    ...(change.phone !== undefined ? { PrimaryPhone: { FreeFormNumber: change.phone } } : {}),
    ...(change.address !== undefined ? { BillAddr: {
      Line1: change.address.line1, Line2: change.address.line2, Line3: "", Line4: "", Line5: "",
      City: change.address.city, CountrySubDivisionCode: change.address.region, PostalCode: change.address.postalCode, Country: change.address.country,
    } } : {}),
  }),
  faults: { stale: "5010", duplicateName: "6240", validation: /^(2\d{3}|6000)$/ },
} as const;

/**
 * The code QuickBooks gave a write it refused (`e.code` is `fault_<code>`), or null when the failure was something
 * else: a server error is never one, whatever code came with it (refusalCode).
 */
export const faultCodeOf = (e: QboError): string | null => /^fault_(\d{1,6})$/.exec(e.code)?.[1] ?? null;

/**
 * What a write that didn't get a 2xx is called: QuickBooks' own code, and none of its words.
 *
 * A 4xx is a refusal: QuickBooks read the request and changed nothing. It is `fault_<code>` from
 * `Fault.Error[0].code`, else `http_<status>`. A 5xx is not a refusal, whatever is in it. QuickBooks sends its system
 * errors as a 500 or a 503 with a Fault inside, and after one nobody can say the change wasn't made. So the status
 * comes first there, `http_<status>` or `http_<status>_fault_<code>`, and no caller reads that Fault code as "stale"
 * or "a value it won't take", or tells a parent that nothing was changed.
 */
async function refusalCode(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const fault = (body?.Fault ?? body?.fault) as Record<string, unknown> | undefined;
  const errors = fault?.Error ?? fault?.error;
  const first = (Array.isArray(errors) ? errors[0] : undefined) as { code?: unknown } | null | undefined;
  const code = typeof first?.code === "string" && /^\d{1,6}$/.test(first.code) ? first.code : null;
  if (res.status >= 400 && res.status < 500) return code === null ? `http_${res.status}` : `fault_${code}`;
  return code === null ? `http_${res.status}` : `http_${res.status}_fault_${code}`;
}

/**
 * What a failure to get an access token for the write is called: its own code with this in front (`token_busy`,
 * `token_unreachable`, `token_timeout`, `token_http_503`). The token comes before anything is sent, or after
 * QuickBooks refused what was sent without reading it (a 401), so such a failure always means nothing was changed.
 * Without the mark, Intuit's token endpoint being down would read like a write whose answer was lost.
 */
export const NO_TOKEN = "token_";

export type QboWriteOptions = {
  /** The company the caller means to change, as the roster cache names it. When another company is connected, nothing is sent. */
  realmId: string;
  /** How long the request may take. */
  timeoutMs?: number;
  /** The caller's own deadline for everything it is doing. */
  signal?: AbortSignal;
};

/**
 * Changes one customer's phone, billing address or both: the only request this module sends to the QuickBooks API
 * that is not a GET. `syncToken` is the version the person editing was shown; QuickBooks refuses the change when the
 * record has moved on since (`fault_5010`), and nothing is overwritten. It returns the customer as QuickBooks now has it.
 *
 * Like a parent's reads, it refuses at once when only an Admin can fix the connection, asks nothing of a company
 * other than the one the caller means, and never waits in line for the connection row: a parent is waiting on the
 * save, so the token comes from accessTokenForPage(), which refuses as "busy" when the row is held elsewhere, before
 * anything is sent. A 401 is answered by one token refresh and one more try: QuickBooks did not act on a request it
 * refused to authenticate. Nothing else is tried twice: after a timeout or a 5xx the portal can't know whether the
 * change was made, and sending it again could only meet its own new SyncToken.
 *
 * How it fails is in the error's code, which is what its caller tells a parent by. A failure to get a token is marked
 * NO_TOKEN (nothing was changed); a 4xx is QuickBooks' refusal (nothing was changed); a timeout, a lost connection, an
 * unreadable answer and any 5xx came after the request went, and the change may have been made (refusalCode).
 *
 * `customerId` is the caller's to get right: it comes from the session's own roster record, never from a request.
 */
export async function qboUpdateCustomerContact(customerId: string, syncToken: string, change: CustomerContactChange, o: QboWriteOptions): Promise<Record<string, unknown>> {
  if (!isQboId(customerId) || !/^\d{1,20}$/.test(syncToken)) throw new QboError("That isn't a QuickBooks customer.", "bad_id");
  if (change.phone === undefined && change.address === undefined) throw new QboError("There is nothing to change.", "nothing_to_change");
  await refuseWhenOnlyAnAdminCanFixIt();
  const body = JSON.stringify(CUSTOMER_UPDATE.body(customerId, syncToken, change));
  let force = false, refreshed = false;
  for (;;) {
    const a = await within(accessTokenForPage(force), o.signal).catch((e: unknown) => { throw e instanceof QboError ? new QboError(e.message, `${NO_TOKEN}${e.code}`) : e; });
    force = false;
    if (a.realmId !== o.realmId) throw new QboError("A different QuickBooks company is connected.", "other_company");
    const url = new URL(`${qboEndpoints().api[a.environment]}/v3/company/${encodeURIComponent(a.realmId)}/${CUSTOMER_UPDATE.path}`);
    url.searchParams.set("minorversion", QBO_MINOR_VERSION);
    const timeout = AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS);
    const gaveUp = () => timeout.aborted || o.signal?.aborted === true;
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", body, headers: { authorization: `Bearer ${a.token}`, accept: "application/json", "content-type": "application/json" },
        signal: o.signal ? AbortSignal.any([timeout, o.signal]) : timeout, redirect: "error" });
    } catch {
      throw gaveUp() ? timedOut() : new QboError("Couldn't reach QuickBooks.", "unreachable");
    }
    if (res.status === 401 && !refreshed) { // the token was revoked or replaced: refresh once and send it again
      refreshed = true; force = true;
      await res.body?.cancel().catch(() => {});
      continue;
    }
    if (!res.ok) throw new QboError("QuickBooks refused the change.", await refusalCode(res));
    let customer: unknown;
    try { customer = ((await res.json()) as { Customer?: unknown } | null)?.Customer; } catch { throw gaveUp() ? timedOut() : new QboError("QuickBooks sent an answer the portal couldn't read.", "bad_answer"); }
    if (typeof customer !== "object" || customer === null || Array.isArray(customer)) throw new QboError("QuickBooks sent an answer the portal couldn't read.", "bad_answer");
    return customer as Record<string, unknown>;
  }
}

/* ---- The second write: a parent's own sign-in email (src/lib/parents/email-change.ts). ----
   QuickBooks is the only home of a sign-in address (parents spec, decision 6), so a parent's change of address is
   written there first, and the portal follows from QuickBooks' answer. Everything above is the first write's and is
   left as it was; this block adds the second beside it. */

/**
 * The email update, exactly as it is sent, and the Fault codes its caller relies on. NOT YET TRIED AGAINST A REAL
 * QUICKBOOKS COMPANY, like CUSTOMER_UPDATE: it follows Intuit's documentation as remembered. The owner's sandbox
 * check must confirm, with `minorversion` 75:
 *   1. `POST /v3/company/<realm>/customer` with `{ Id, SyncToken, sparse: true, PrimaryEmailAddr: { Address } }`
 *      answers 200 with `{ Customer: {...} }` and raises SyncToken;
 *   2. that it changes the email field and nothing else: DisplayName, the phone, BillAddr, ParentRef, CustomerTypeRef
 *      and Active are as they were, and on a customer with sub-customers, theirs are untouched (QuickBooks copies a
 *      family's details onto new sub-customers in its own screens: an update must not);
 *   3. that a field holding several addresses (`a@x.org, b@x.org`, with commas, semicolons or spaces) is kept exactly
 *      as sent, and read back the same way;
 *   4. HOW LONG A FIELD QUICKBOOKS TAKES. Intuit's documentation gives 100 characters; the portal sends no field
 *      longer than `maxLength` until the check says otherwise, and the parent is asked to go to the club. If QuickBooks
 *      takes more, raise `maxLength` here and EMAIL_FIELD_MAX in src/lib/parents/email-field.ts together; if a longer
 *      one is refused, note the code it gives;
 *   5. an update with an old SyncToken answers HTTP 400 with `Fault.Error[0].code` "5010" (`faults.stale`) and
 *      changes nothing;
 *   6. a value QuickBooks will not take (a field that isn't addresses, say `not an address`) answers HTTP 400 with a
 *      code that `faults.validation` matches (2xxx, or 6000), and changes nothing.
 * Don't change the body without trying the new one in the sandbox first, and tests/helpers/qbo-stub.ts with it.
 */
export const EMAIL_UPDATE = {
  /** The same address as CUSTOMER_UPDATE: `sparse: true` with an Id and a SyncToken makes it an update of the one field sent. */
  path: "customer",
  body: (customerId: string, syncToken: string, field: string) => ({
    Id: customerId, SyncToken: syncToken, sparse: true, PrimaryEmailAddr: { Address: field },
  }),
  faults: { stale: "5010", validation: /^(2\d{3}|6000)$/ },
  /** The longest field sent (point 4 above). */
  maxLength: 100,
} as const;

/**
 * Changes one customer's email field to `field`, the whole field as it is to be, the other addresses in it included:
 * the only other request this module sends to the QuickBooks API that is not a GET. Built as qboUpdateCustomerContact
 * is, for the same reasons: `syncToken` is the version just read, so a record that has moved on since is refused
 * (`fault_5010`) and nothing is overwritten; it refuses at once when only an Admin can fix the connection, sends nothing
 * to a company other than `o.realmId`, never waits in line for the connection row (accessTokenForPage), and is sent
 * once more only after a 401. After a timeout or a 5xx the change may have been made, and is never sent again here.
 * A failure to get a token is marked NO_TOKEN (nothing was changed); a 4xx is QuickBooks' refusal (nothing was changed).
 *
 * `customerId` is the caller's to get right: it comes from the session's own roster record, never from a request.
 */
export async function qboUpdateCustomerEmail(customerId: string, syncToken: string, field: string, o: QboWriteOptions): Promise<Record<string, unknown>> {
  if (!isQboId(customerId) || !/^\d{1,20}$/.test(syncToken)) throw new QboError("That isn't a QuickBooks customer.", "bad_id");
  if (typeof field !== "string" || !field.trim() || field.length > EMAIL_UPDATE.maxLength) throw new QboError("That email field can't be sent.", "bad_field");
  await refuseWhenOnlyAnAdminCanFixIt();
  const body = JSON.stringify(EMAIL_UPDATE.body(customerId, syncToken, field));
  let force = false, refreshed = false;
  for (;;) {
    const a = await within(accessTokenForPage(force), o.signal).catch((e: unknown) => { throw e instanceof QboError ? new QboError(e.message, `${NO_TOKEN}${e.code}`) : e; });
    force = false;
    if (a.realmId !== o.realmId) throw new QboError("A different QuickBooks company is connected.", "other_company");
    const url = new URL(`${qboEndpoints().api[a.environment]}/v3/company/${encodeURIComponent(a.realmId)}/${EMAIL_UPDATE.path}`);
    url.searchParams.set("minorversion", QBO_MINOR_VERSION);
    const timeout = AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS);
    const gaveUp = () => timeout.aborted || o.signal?.aborted === true;
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", body, headers: { authorization: `Bearer ${a.token}`, accept: "application/json", "content-type": "application/json" },
        signal: o.signal ? AbortSignal.any([timeout, o.signal]) : timeout, redirect: "error" });
    } catch {
      throw gaveUp() ? timedOut() : new QboError("Couldn't reach QuickBooks.", "unreachable");
    }
    if (res.status === 401 && !refreshed) { // the token was revoked or replaced: refresh once and send it again
      refreshed = true; force = true;
      await res.body?.cancel().catch(() => {});
      continue;
    }
    if (!res.ok) throw new QboError("QuickBooks refused the change.", await refusalCode(res));
    let customer: unknown;
    try { customer = ((await res.json()) as { Customer?: unknown } | null)?.Customer; } catch { throw gaveUp() ? timedOut() : new QboError("QuickBooks sent an answer the portal couldn't read.", "bad_answer"); }
    if (typeof customer !== "object" || customer === null || Array.isArray(customer)) throw new QboError("QuickBooks sent an answer the portal couldn't read.", "bad_answer");
    return customer as Record<string, unknown>;
  }
}

/* ---- Staff roster writes (v1 spec §6.1): a customer create, and sparse updates of a name, a parent and Active ---- */

/** A new customer as staff ask for it: always a type, and for a student or a parent the family it sits under. */
export type CustomerCreate = {
  name: string; typeQboId: string;
  /** The family a student or parent is made under; null for a family or a flat member. */
  parentQboId: string | null;
  /** A student is billed with its family (BillWithParent); a parent is not. */
  billWithParent: boolean;
  /** A parent's own address; null for everyone else. */
  email: string | null;
};

/**
 * The roster writes, exactly as they are sent. NOT YET TRIED AGAINST A REAL QUICKBOOKS COMPANY: nobody could reach the
 * sandbox when they were built, so they follow Intuit's documentation as remembered, like CUSTOMER_UPDATE above. They
 * share its address: a body with no Id is a create, and one with an Id, a SyncToken and `sparse: true` an update of the
 * fields sent and nothing else. The owner's sandbox check must confirm, with `minorversion` 75:
 *   1. `create` with `{ DisplayName, CustomerTypeRef: { value } }` answers 200 with `{ Customer }`, and that the customer
 *      it made carries that CustomerTypeRef (that QuickBooks takes a type on a create at all); for a student the same with
 *      `ParentRef`, `Job: true` and `BillWithParent: true`, and for a parent `BillWithParent: false` and
 *      `PrimaryEmailAddr: { Address }`. Also whether QuickBooks copies the family's contact details onto the new
 *      sub-customer (parents spec, Guidance for the club), which the parent's own email must then replace;
 *   2. `rename` (`DisplayName` alone) changes the name and nothing else: not GivenName, FamilyName, the contact details,
 *      the type, the parent or Active; and what it does to FullyQualifiedName and to the names of the sub-customers of a
 *      family that is renamed;
 *   3. `reparent` (`ParentRef`, `Job: true`, `BillWithParent: true`) moves a student under the other family and changes
 *      nothing else, and what happens to its open invoices;
 *   4. `active` with `Active: false` makes the customer inactive (QuickBooks has no delete), and what it does to the
 *      customers under a family made inactive (the portal asks for a roster refresh after one to see), and whether a
 *      customer with an open balance can be made inactive at all: if QuickBooks refuses it, with which code;
 *   5. a DisplayName already used by any customer, vendor or employee answers HTTP 400 with `Fault.Error[0].code` "6240"
 *      (`faults.duplicateName`), and changes nothing;
 *   6. an update with an old SyncToken answers HTTP 400 with "5010" (`faults.stale`), and changes nothing.
 * Don't change a body without trying the new one in the sandbox first, and tests/helpers/qbo-stub.ts must follow it.
 */
export const CUSTOMER_WRITES = {
  path: "customer",
  create: (c: CustomerCreate) => ({
    DisplayName: c.name, CustomerTypeRef: { value: c.typeQboId },
    ...(c.parentQboId !== null ? { ParentRef: { value: c.parentQboId }, Job: true, BillWithParent: c.billWithParent } : {}),
    ...(c.email !== null ? { PrimaryEmailAddr: { Address: c.email } } : {}),
  }),
  rename: (customerId: string, syncToken: string, name: string) => ({ Id: customerId, SyncToken: syncToken, sparse: true, DisplayName: name }),
  reparent: (customerId: string, syncToken: string, parentQboId: string) =>
    ({ Id: customerId, SyncToken: syncToken, sparse: true, ParentRef: { value: parentQboId }, Job: true, BillWithParent: true }),
  active: (customerId: string, syncToken: string, active: boolean) => ({ Id: customerId, SyncToken: syncToken, sparse: true, Active: active }),
  faults: { stale: "5010", duplicateName: "6240" },
} as const;

export type QboRosterWriteOptions = QboWriteOptions & {
  /**
   * The worker may wait its turn for the connection row (accessToken()); a staff member pressing a button never does:
   * without it the token comes from accessTokenForPage(), which answers "busy" (token_busy) when the row is held.
   */
  mayWait?: boolean;
};

const badRosterId = () => new QboError("That isn't a QuickBooks customer.", "bad_id");
const isSyncToken = (v: string) => /^\d{1,20}$/.test(v);

/**
 * Sends one roster write and returns the customer as QuickBooks now has it. The one request of the staff roster writes
 * that is not a GET; the four functions below build its body from CUSTOMER_WRITES and nothing else. It fails as
 * qboUpdateCustomerContact() does, with the same codes: NO_TOKEN for a token that couldn't be had (nothing was sent), a
 * 4xx for a refusal (nothing was changed), and a timeout, a lost connection, an unreadable answer or a 5xx when the
 * change may have been made. A 401 is answered by one token refresh and one more try; nothing else is tried twice.
 */
async function sendRosterWrite(payload: Record<string, unknown>, o: QboRosterWriteOptions): Promise<Record<string, unknown>> {
  await refuseWhenOnlyAnAdminCanFixIt();
  const body = JSON.stringify(payload);
  let force = false, refreshed = false;
  for (;;) {
    const token = o.mayWait ? accessToken({ force }) : accessTokenForPage(force);
    const a = await within(token, o.signal).catch((e: unknown) => { throw e instanceof QboError ? new QboError(e.message, `${NO_TOKEN}${e.code}`) : e; });
    force = false;
    if (a.realmId !== o.realmId) throw new QboError("A different QuickBooks company is connected.", "other_company");
    const url = new URL(`${qboEndpoints().api[a.environment]}/v3/company/${encodeURIComponent(a.realmId)}/${CUSTOMER_WRITES.path}`);
    url.searchParams.set("minorversion", QBO_MINOR_VERSION);
    const timeout = AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS);
    const gaveUp = () => timeout.aborted || o.signal?.aborted === true;
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", body, headers: { authorization: `Bearer ${a.token}`, accept: "application/json", "content-type": "application/json" },
        signal: o.signal ? AbortSignal.any([timeout, o.signal]) : timeout, redirect: "error" });
    } catch {
      throw gaveUp() ? timedOut() : new QboError("Couldn't reach QuickBooks.", "unreachable");
    }
    if (res.status === 401 && !refreshed) {
      refreshed = true; force = true;
      await res.body?.cancel().catch(() => {});
      continue;
    }
    if (!res.ok) throw new QboError("QuickBooks refused the change.", await refusalCode(res));
    let customer: unknown;
    try { customer = ((await res.json()) as { Customer?: unknown } | null)?.Customer; } catch { throw gaveUp() ? timedOut() : new QboError("QuickBooks sent an answer the portal couldn't read.", "bad_answer"); }
    if (typeof customer !== "object" || customer === null || Array.isArray(customer)) throw new QboError("QuickBooks sent an answer the portal couldn't read.", "bad_answer");
    return customer as Record<string, unknown>;
  }
}

/** Makes a customer: a family or member with its type, or a student or parent of that type under its family. */
export async function qboCreateCustomer(c: CustomerCreate, o: QboRosterWriteOptions): Promise<Record<string, unknown>> {
  if (!isQboId(c.typeQboId) || (c.parentQboId !== null && !isQboId(c.parentQboId))) throw badRosterId();
  return sendRosterWrite(CUSTOMER_WRITES.create(c), o);
}

/** Changes one customer's DisplayName, from the version the staff member was shown. */
export async function qboRenameCustomer(customerId: string, syncToken: string, name: string, o: QboRosterWriteOptions): Promise<Record<string, unknown>> {
  if (!isQboId(customerId) || !isSyncToken(syncToken)) throw badRosterId();
  return sendRosterWrite(CUSTOMER_WRITES.rename(customerId, syncToken, name), o);
}

/** Puts a student under another family, billed with it, from the version the staff member was shown. */
export async function qboMoveCustomer(customerId: string, syncToken: string, parentQboId: string, o: QboRosterWriteOptions): Promise<Record<string, unknown>> {
  if (!isQboId(customerId) || !isQboId(parentQboId) || !isSyncToken(syncToken)) throw badRosterId();
  return sendRosterWrite(CUSTOMER_WRITES.reparent(customerId, syncToken, parentQboId), o);
}

/** Makes one customer inactive, or active (QuickBooks has no delete), from the version the staff member was shown. */
export async function qboSetCustomerActive(customerId: string, syncToken: string, active: boolean, o: QboRosterWriteOptions): Promise<Record<string, unknown>> {
  if (!isQboId(customerId) || !isSyncToken(syncToken)) throw badRosterId();
  return sendRosterWrite(CUSTOMER_WRITES.active(customerId, syncToken, active), o);
}
