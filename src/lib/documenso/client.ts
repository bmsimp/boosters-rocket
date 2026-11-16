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

export type DocumensoErrorCode = "timeout" | "unreachable" | "unauthorized" | "not_found" | "rate_limited" | "refused" | "server" | "bad_answer";
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
export type Envelope = Omit<z.infer<typeof envelopeSchema>, "fields"> & { fields: EnvelopeField[] };
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
export async function useTemplate(config: DocumensoConfig, payload: UsePayload, o: CallOptions = {}): Promise<{ id: string; recipients: EnvelopeRecipient[] }> {
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
