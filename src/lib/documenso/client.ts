// The portal's client for a self-hosted Documenso (v1 spec §9; the calls are the recipe verified by hand in
// docs/superpowers/specs/2026-11-15-documenso-verification.md, section 6). Server only. Every call has a timeout, an
// error is reduced to a short code with a fixed sentence, nothing is written to the log, and the API token appears in
// no message. A recipient's signing token passes through here and is never stored by the portal.
import "server-only";
import { z } from "zod";

export type DocumensoConfig = {
  /** The one origin Documenso is configured with (its NEXT_PUBLIC_WEBAPP_URL): the API and the signing frame both use it. */
  origin: string;
  token: string;
};

export type DocumensoErrorCode = "timeout" | "unreachable" | "unauthorized" | "not_found" | "rate_limited" | "refused" | "server" | "bad_answer" | "too_large";
/** What staff read for each code. Never the response body: Documenso answers even a 400 with a stack trace. */
export const DOCUMENSO_ERRORS: Record<DocumensoErrorCode, string> = {
  timeout: "Documenso took too long to answer.",
  unreachable: "Documenso couldn't be reached at that address.",
  unauthorized: "Documenso refused the API token.",
  not_found: "Documenso has nothing with that id.",
  rate_limited: "Documenso is answering too many requests right now.",
  refused: "Documenso refused the request.",
  server: "Documenso had an error of its own.",
  bad_answer: "Documenso answered in a way the portal doesn't understand.",
  too_large: "Documenso sent a file larger than the portal keeps.",
};
export class DocumensoError extends Error {
  constructor(readonly code: DocumensoErrorCode) { super(DOCUMENSO_ERRORS[code]); this.name = "DocumensoError"; }
}
export const documensoCode = (e: unknown): DocumensoErrorCode | "unexpected" => (e instanceof DocumensoError ? e.code : "unexpected");

/** A page load waits this long at most; a job or a staff action may wait longer. */
export const PAGE_TIMEOUT_MS = 8_000;
export const DEFAULT_TIMEOUT_MS = 15_000;
export type CallOptions = { timeoutMs?: number };

/** The nine document emails Documenso can send (v2.22.0). The portal switches every one off on every document it makes. */
export const EMAIL_FLAGS = ["recipientSigningRequest", "recipientRemoved", "recipientSigned", "documentPending", "documentCompleted", "documentDeleted",
  "ownerDocumentCompleted", "ownerRecipientExpired", "ownerDocumentCreated"] as const;
export const EMAILS_OFF = Object.fromEntries(EMAIL_FLAGS.map((flag) => [flag, false])) as Record<(typeof EMAIL_FLAGS)[number], false>;

const ENVELOPE_ID = /^envelope_[A-Za-z0-9]{6,64}$/;
/** True for an id in the form Documenso gives its envelopes. Only such an id is put into a request's address. */
export const isEnvelopeId = (value: unknown): value is string => typeof value === "string" && ENVELOPE_ID.test(value);
/** The envelope id in something staff pasted: the id itself, or the address of the template's page in Documenso. */
export const envelopeIdIn = (text: string): string | null => /envelope_[A-Za-z0-9]{6,64}/.exec(text)?.[0] ?? null;

const recipientSchema = z.object({
  id: z.number().int(), role: z.string(), email: z.string(), name: z.string(), token: z.string().optional().default(""),
  signingStatus: z.string().optional().default("NOT_SIGNED"), signedAt: z.string().nullable().optional().default(null), signingOrder: z.number().nullable().optional().default(null),
});
const fieldSchema = z.object({
  id: z.number().int(), type: z.string(), recipientId: z.number().int(),
  fieldMeta: z.object({ label: z.string().nullable().optional(), readOnly: z.boolean().nullable().optional() }).passthrough().nullable().optional(),
});
const envelopeSchema = z.object({
  id: z.string(), type: z.string(), status: z.string(), externalId: z.string().nullable().optional().default(null), title: z.string().optional().default(""),
  updatedAt: z.string(), completedAt: z.string().nullable().optional().default(null), deletedAt: z.string().nullable().optional().default(null),
  recipients: z.array(recipientSchema), fields: z.array(fieldSchema).optional().default([]),
  envelopeItems: z.array(z.object({ id: z.string(), order: z.number().nullable().optional().default(null) })).optional().default([]),
});
const listSchema = z.object({ data: z.array(z.object({
  id: z.string(), type: z.string().optional().default(""), status: z.string().optional().default(""), externalId: z.string().nullable().optional().default(null),
  title: z.string().optional().default(""), updatedAt: z.string().optional().default(""),
  recipients: z.array(z.object({ id: z.number().int(), signingStatus: z.string().optional().default("NOT_SIGNED") })).optional().default([]),
})) });
const usedSchema = z.object({ id: z.string(), recipients: z.array(recipientSchema) });
const distributedSchema = z.object({ recipients: z.array(recipientSchema) });

export type EnvelopeRecipient = z.infer<typeof recipientSchema>;
export type EnvelopeField = { id: number; type: string; recipientId: number; label: string | null; readOnly: boolean };
/** An envelope as the portal reads it. `envelopeItems` (its PDFs) is always read from Documenso; a test's made-up envelope may leave it out. */
export type Envelope = Omit<z.infer<typeof envelopeSchema>, "fields" | "envelopeItems"> & { fields: EnvelopeField[]; envelopeItems?: { id: string; order: number | null }[] };
export type EnvelopeSummary = z.infer<typeof listSchema>["data"][number];

function codeFor(status: number): DocumensoErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return status >= 500 ? "server" : "refused";
}

/** One request. A redirect is refused: the address must be Documenso's own, and the token goes nowhere else. */
async function send(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new DocumensoError((e as { name?: string } | null)?.name === "TimeoutError" ? "timeout" : "unreachable");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined); // never read: it holds a stack trace, and may hold tokens
    throw new DocumensoError(codeFor(res.status));
  }
  return res;
}

async function api<T>(config: DocumensoConfig, method: "GET" | "POST", path: string, schema: z.ZodType<T> | null, body?: unknown, o: CallOptions & { multipart?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { authorization: config.token, accept: "application/json" };
  let payload: BodyInit | undefined;
  if (o.multipart) {
    const form = new FormData();
    form.append("payload", JSON.stringify(body));
    payload = form;
  } else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await send(`${config.origin}/api/v2${path}`, { method, headers, body: payload }, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (!schema) { await res.body?.cancel().catch(() => undefined); return undefined as T; }
  let json: unknown;
  try { json = await res.json(); } catch { throw new DocumensoError("bad_answer"); }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new DocumensoError("bad_answer");
  return parsed.data;
}

const withId = (id: string): string => {
  if (!isEnvelopeId(id)) throw new DocumensoError("not_found");
  return id;
};

/** Documenso's own health answer (its database and its signing certificate). No token is sent. */
export async function documensoHealth(origin: string, o: CallOptions = {}): Promise<void> {
  const res = await send(`${origin}/api/health`, { method: "GET", headers: { accept: "application/json" } }, o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let json: unknown;
  try { json = await res.json(); } catch { throw new DocumensoError("bad_answer"); }
  if ((json as { status?: unknown } | null)?.status !== "ok") throw new DocumensoError("server");
}

/** One envelope: a template, or a document made from one. Its recipients carry their signing tokens. */
export async function getEnvelope(config: DocumensoConfig, envelopeId: string, o: CallOptions = {}): Promise<Envelope> {
  const e = await api(config, "GET", `/envelope/${withId(envelopeId)}`, envelopeSchema, undefined, o);
  return { ...e, fields: e.fields.map((f) => ({ id: f.id, type: f.type, recipientId: f.recipientId, label: f.fieldMeta?.label ?? null, readOnly: f.fieldMeta?.readOnly === true })) };
}

/** The team's templates, for staff to choose from: the newest hundred. */
export async function listTemplates(config: DocumensoConfig, o: CallOptions = {}): Promise<{ id: string; title: string }[]> {
  const list = await api(config, "GET", "/envelope?type=TEMPLATE&perPage=100", listSchema, undefined, o);
  return list.data.filter((e) => isEnvelopeId(e.id)).map((e) => ({ id: e.id, title: e.title }));
}

/**
 * The documents whose externalId is exactly this. Documenso's `query` is a substring search over titles, externalIds
 * and recipients, with `_` and `%` as wildcards (verification, 1a point 6), so its hits are filtered here.
 */
export async function findDocumentsByExternalId(config: DocumensoConfig, externalId: string, o: CallOptions = {}): Promise<EnvelopeSummary[]> {
  const list = await api(config, "GET", `/envelope?type=DOCUMENT&perPage=100&query=${encodeURIComponent(externalId)}`, listSchema, undefined, o);
  return list.data.filter((e) => e.externalId === externalId && isEnvelopeId(e.id));
}

export type UsePayload = {
  envelopeId: string; externalId: string; distributeDocument: boolean;
  recipients: { id: number; email: string; name: string }[];
  prefillFields: { id: number; type: "text"; value: string }[];
  override: {
    title: string; distributionMethod: "NONE"; emailSettings: typeof EMAILS_OFF;
    timezone: string; dateFormat: string; envelopeExpirationPeriod: { disabled: true };
  };
};

/** Makes a document from a template. With `distributeDocument` it is sent for signing in the same call. */
export async function documentFromTemplate(config: DocumensoConfig, payload: UsePayload, o: CallOptions = {}): Promise<{ id: string; recipients: EnvelopeRecipient[] }> {
  withId(payload.envelopeId);
  const used = await api(config, "POST", "/envelope/use", usedSchema, payload, { ...o, multipart: true });
  if (!isEnvelopeId(used.id)) throw new DocumensoError("bad_answer");
  return used;
}

/** Removes a recipient, and their fields with them, from a document that has not been sent. */
export async function deleteRecipient(config: DocumensoConfig, recipientId: number, o: CallOptions = {}): Promise<void> {
  await api(config, "POST", "/envelope/recipient/delete", null, { recipientId }, o);
}

/**
 * Sends a document for signing. On a document every signer has already signed, it queues the sealing again
 * (verification, 1a point 3). No mail is sent either way: the document was made with both email settings off.
 */
export async function distributeEnvelope(config: DocumensoConfig, envelopeId: string, o: CallOptions = {}): Promise<EnvelopeRecipient[]> {
  return (await api(config, "POST", "/envelope/distribute", distributedSchema, { envelopeId: withId(envelopeId) }, o)).recipients;
}

/** Withdraws a document nobody has signed. Afterwards Documenso answers 404 for it. */
export async function deleteEnvelope(config: DocumensoConfig, envelopeId: string, o: CallOptions = {}): Promise<void> {
  await api(config, "POST", "/envelope/delete", null, { envelopeId: withId(envelopeId) }, o);
}

/**
 * The address of the signing frame for one recipient. The options ride in the fragment, which never reaches a server.
 * `lockName` is applied in the browser and is no control; the name on the document is the one the portal filled in.
 */
export function signingFrameUrl(origin: string, token: string, name: string): string {
  const options = Buffer.from(encodeURIComponent(JSON.stringify({ name, lockName: true })), "utf8").toString("base64");
  return `${origin}/embed/sign/${encodeURIComponent(token)}#${options}`;
}

/* ---- Evidence of a completed document, and withdrawing one (verification, section 6: "When status is COMPLETED", "Withdrawing a document") ---- */

/** The most the portal reads of any one file Documenso sends. A larger answer is refused, and none of it is kept. */
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** A download may take longer than a page load; it is only ever made by the worker or a staff action. */
export const DOWNLOAD_TIMEOUT_MS = 60_000;
/** The audit log as JSON is read this many entries a page, every page in order, and no more pages than this. */
export const AUDIT_PAGE_SIZE = 100;
export const AUDIT_MAX_PAGES = 50;

const ITEM_ID = /^envelope_item_[A-Za-z0-9]{6,64}$/;
/** True for an id in the form Documenso gives the items (the PDFs) of an envelope. Only such an id goes into an address. */
export const isEnvelopeItemId = (value: unknown): value is string => typeof value === "string" && ITEM_ID.test(value);

/** The body, read to its end but never past `limit` bytes: a longer one is refused as soon as it passes the limit. */
async function readCapped(res: Response, limit: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > limit) { await res.body?.cancel().catch(() => undefined); throw new DocumensoError("too_large"); }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => undefined); throw new DocumensoError("too_large"); }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof DocumensoError) throw e;
    // The connection broke, or the time ran out, half way through the file: nothing of it is used.
    throw new DocumensoError((e as { name?: string } | null)?.name === "TimeoutError" ? "timeout" : "unreachable");
  }
  return Buffer.concat(chunks);
}

/** One file. It must be a PDF (its first bytes say so): anything else Documenso sends here is refused, not kept. */
async function downloadPdf(config: DocumensoConfig, path: string, o: CallOptions): Promise<Buffer> {
  const res = await send(`${config.origin}/api/v2${path}`, { method: "GET", headers: { authorization: config.token, accept: "application/pdf" } }, o.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
  const bytes = await readCapped(res, MAX_DOWNLOAD_BYTES);
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new DocumensoError("bad_answer");
  return bytes;
}

/** One item of a document as a PDF: `signed` is the sealed copy (the evidence), `original` the PDF the template was made from. */
export async function downloadItem(config: DocumensoConfig, itemId: string, version: "signed" | "original", o: CallOptions = {}): Promise<Buffer> {
  if (!isEnvelopeItemId(itemId)) throw new DocumensoError("not_found");
  return downloadPdf(config, `/envelope/item/${itemId}/download?version=${version}`, o);
}

/** The signing certificate as its own PDF. Documenso renders it on request; it is not signed. */
export async function downloadCertificate(config: DocumensoConfig, envelopeId: string, o: CallOptions = {}): Promise<Buffer> {
  return downloadPdf(config, `/envelope/${withId(envelopeId)}/certificate/download`, o);
}

/** The audit log as a PDF. Documenso renders it on request; it is not signed. */
export async function downloadAuditLogPdf(config: DocumensoConfig, envelopeId: string, o: CallOptions = {}): Promise<Buffer> {
  return downloadPdf(config, `/envelope/${withId(envelopeId)}/audit-log/download`, o);
}

const auditPageSchema = z.object({
  data: z.array(z.record(z.string(), z.unknown())), count: z.number().int().nonnegative(),
  currentPage: z.number().int().positive(), perPage: z.number().int().positive(), totalPages: z.number().int().nonnegative(),
});

/**
 * The audit log as JSON: every page, oldest entry first, as Documenso gave them (each entry's createdAt, type, name,
 * email, userAgent, ipAddress and data). The result is the entries in order and the bytes as the portal keeps them. A
 * log with more pages than AUDIT_MAX_PAGES, or whose pages don't add up to its count, is refused.
 */
export async function auditLogEntries(config: DocumensoConfig, envelopeId: string, o: CallOptions = {}): Promise<{ entries: Record<string, unknown>[]; json: Buffer }> {
  const entries: Record<string, unknown>[] = [];
  let total = 0;
  for (let page = 1; ; page++) {
    const res = await send(`${config.origin}/api/v2/envelope/${withId(envelopeId)}/audit-log?page=${page}&perPage=${AUDIT_PAGE_SIZE}&orderByDirection=asc`,
      { method: "GET", headers: { authorization: config.token, accept: "application/json" } }, o.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
    let json: unknown;
    try { json = JSON.parse((await readCapped(res, MAX_DOWNLOAD_BYTES)).toString("utf8")); } catch (e) { if (e instanceof DocumensoError) throw e; throw new DocumensoError("bad_answer"); }
    const parsed = auditPageSchema.safeParse(json);
    if (!parsed.success || parsed.data.currentPage !== page) throw new DocumensoError("bad_answer");
    entries.push(...parsed.data.data);
    total = parsed.data.count;
    if (page >= parsed.data.totalPages || parsed.data.data.length === 0) break;
    if (page >= AUDIT_MAX_PAGES) throw new DocumensoError("too_large");
  }
  if (entries.length !== total) throw new DocumensoError("bad_answer");
  const json = Buffer.from(JSON.stringify({ envelopeId, count: total, entries }, null, 2), "utf8");
  if (json.byteLength > MAX_DOWNLOAD_BYTES) throw new DocumensoError("too_large");
  return { entries, json };
}

/**
 * Withdraws a document someone has signed: Documenso marks it CANCELLED and sends no mail (the document was made with
 * its emails off). Never for a completed one. `reason` is the club's own sentence, without names.
 */
export async function cancelEnvelope(config: DocumensoConfig, envelopeId: string, reason: string, o: CallOptions = {}): Promise<void> {
  await api(config, "POST", "/envelope/cancel", null, { envelopeId: withId(envelopeId), reason: reason.slice(0, 200) }, o);
}
