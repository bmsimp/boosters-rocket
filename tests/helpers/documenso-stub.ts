import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

/**
 * A stand-in for a self-hosted Documenso (v2.22.0), enough for the portal's real client to talk to. It behaves as the
 * hands-on verification found (docs/superpowers/specs/2026-11-15-documenso-verification.md), the awkward parts included:
 *
 *  - a signer role left out of `use` is still a recipient of the new document, with the template's placeholder address,
 *    until it is deleted; the document can't complete while it is there;
 *  - every recipient has its own signing token, given by `use`, `distribute` and `GET /envelope/{id}`;
 *  - a recipient who has signed, or has an inserted field (a prefilled one counts), is locked once the document is
 *    sent: it can't be changed or deleted;
 *  - the email settings a document was made with are kept as sent (`documentMeta`), so a test can prove both were sent;
 *    a flag the request leaves out is stored as true;
 *  - `GET /envelope?query=` is a case-insensitive substring search over title, externalId and recipient name or
 *    email, with `_` and `%` as wildcards: it finds more than the exact id;
 *  - a document every signer has signed is sealed (COMPLETED) by a separate step, which a test can hold back;
 *    `distribute` on such a document queues the sealing again;
 *  - deleting an unsigned document makes it answer 404; a completed one is only marked deleted.
 *
 * Nothing here is a real signature: `sign()` and `reject()` do what a guardian does in the signing frame.
 */
export type StubRecipient = {
  id: number; role: string; email: string; name: string; token: string; signingStatus: "NOT_SIGNED" | "SIGNED" | "REJECTED";
  signedAt: string | null; signingOrder: number | null;
};
export type StubField = { id: number; type: string; recipientId: number; inserted: boolean; customText: string; fieldMeta: { label?: string; readOnly?: boolean; type?: string } | null };
export type StubEnvelope = {
  id: string; type: "TEMPLATE" | "DOCUMENT"; status: "DRAFT" | "PENDING" | "COMPLETED" | "REJECTED"; externalId: string | null; title: string;
  createdAt: string; updatedAt: string; completedAt: string | null; deletedAt: string | null; templateId: string | null;
  recipients: StubRecipient[]; fields: StubField[];
  /** What the document was made with: the override sent with `use`, laid over the template's own settings. */
  documentMeta: { distributionMethod: string; emailSettings: Record<string, boolean>; timezone: string | null; dateFormat: string | null; envelopeExpirationPeriod: unknown };
};
export type DocumensoCall = { method: string; path: string; query: URLSearchParams; auth: string; body: unknown };

export type TemplateSpec = {
  title?: string;
  /** How many signer roles: 1 or 2 by default; any number for a template the portal must refuse. */
  signers?: number;
  /** The label of the field that takes the student's (or family's) name; null for none. */
  subjectLabel?: string | null;
  /** Whether the fields the portal fills are read-only (true), or which labels are not. */
  readOnly?: boolean | { except: string[] };
  /** Leave the signature field out for this signer (1 or 2). */
  noSignatureFor?: number;
  /** A recipient who is not a signer, such as "CC" or "APPROVER". */
  extraRole?: string;
  /** Email settings of the template itself: by default everything on, as Documenso makes a new template. */
  emailsOff?: boolean;
};

export type DocumensoStub = {
  /** The origin: what the portal's settings hold as Documenso's address. */
  origin: string; token: string; calls: DocumensoCall[];
  envelopes: Map<string, StubEnvelope>;
  /** "auto": a document is COMPLETED as soon as every signer has signed. "held": it stays PENDING until seal() or, with `sealWhenAsked`, a `distribute`. */
  sealing: "auto" | "held";
  sealWhenAsked: boolean;
  /** How many times sealing was queued again by `distribute` on a fully signed document. */
  sealAsks: number;
  healthy: boolean;
  failNext: number;             // answer this many API requests, from the next one, with HTTP 500 and a stack trace in the body
  rateLimitNext: number;        // answer this many with HTTP 429
  drop: boolean;                // close the connection on every request without answering
  delayMs: number;
  /** Fail the call with this path (such as "/envelope/distribute") once, with HTTP 500: a crash in the middle of the recipe. */
  failPathOnce: string | null;
  addTemplate(spec?: TemplateSpec): StubEnvelope;
  /** The documents made, newest last (templates left out), and the one for a request by its externalId. */
  documents(): StubEnvelope[];
  documentFor(externalId: string): StubEnvelope | undefined;
  /** What a guardian does in the frame: signs. `who` is the recipient's email, or its id. */
  sign(envelopeId: string, who: string | number): void;
  reject(envelopeId: string, who: string | number): void;
  seal(envelopeId: string): void;
  /** What a signer can do with their token alone: put text in a field, unless it is read-only. True when it took. */
  typeInto(envelopeId: string, fieldId: number, text: string): boolean;
  apiCalls(path?: string): DocumensoCall[];
  reset(): void; close(): Promise<void>;
};

const EMAIL_FLAGS = ["recipientSigningRequest", "recipientRemoved", "recipientSigned", "documentPending", "documentCompleted", "documentDeleted",
  "ownerDocumentCompleted", "ownerRecipientExpired", "ownerDocumentCreated"];
const id = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`;
const STACK = { message: "Something went wrong", code: "INTERNAL_SERVER_ERROR", stack: "Error: at /app/node_modules/secret-path/index.js:1:1 token=api_should_never_be_shown" };

/** The `payload` part of a multipart/form-data body, as the portal sends `use`. */
function payloadOf(contentType: string, body: string): unknown {
  if (contentType.includes("application/json")) return JSON.parse(body || "null");
  const part = /name="payload"\r?\n(?:[^\r\n]+\r?\n)*\r?\n([\s\S]*?)\r?\n--/.exec(body);
  return part ? JSON.parse(part[1]!) : null;
}

/** Documenso's `query`: a substring match, case-insensitive, where `_` is any one character and `%` any run of them. */
function matches(query: string, value: string | null): boolean {
  if (value === null) return false;
  const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(pattern, "i").test(value);
}

export async function startDocumensoStub(): Promise<DocumensoStub> {
  let nextRecipient = 100, nextField = 1000;
  const stub = { token: `api_${randomBytes(12).toString("hex")}`, calls: [], envelopes: new Map(), sealing: "auto", sealWhenAsked: true, sealAsks: 0, healthy: true,
    failNext: 0, rateLimitNext: 0, drop: false, delayMs: 0, failPathOnce: null } as unknown as DocumensoStub;
  const now = () => new Date().toISOString();
  const recipientOf = (envelope: StubEnvelope, who: string | number) => {
    const r = envelope.recipients.find((x) => (typeof who === "number" ? x.id === who : x.email.toLowerCase() === who.toLowerCase()));
    if (!r) throw new Error(`documenso stub: ${envelope.id} has no recipient ${who}`);
    return r;
  };
  const need = (envelopeId: string) => {
    const e = stub.envelopes.get(envelopeId);
    if (!e) throw new Error(`documenso stub: no envelope ${envelopeId}`);
    return e;
  };
  const allSigned = (e: StubEnvelope) => e.recipients.filter((r) => r.role === "SIGNER").every((r) => r.signingStatus === "SIGNED");
  const locked = (e: StubEnvelope, r: StubRecipient) => e.status !== "DRAFT" && (r.signingStatus !== "NOT_SIGNED" || e.fields.some((f) => f.recipientId === r.id && f.inserted));
  const shown = (r: StubRecipient) => ({ id: r.id, name: r.name, email: r.email, token: r.token, role: r.role, signingOrder: r.signingOrder, signingUrl: `${stub.origin}/sign/${r.token}` });

  stub.addTemplate = (spec = {}) => {
    const signers = spec.signers ?? 2;
    const readOnly = (label: string) => (typeof spec.readOnly === "object" ? !spec.readOnly.except.includes(label) : spec.readOnly ?? true);
    const text = (recipientId: number, label: string): StubField => ({ id: nextField++, type: "TEXT", recipientId, inserted: false, customText: "", fieldMeta: { type: "text", label, readOnly: readOnly(label) } });
    const recipients: StubRecipient[] = [], fields: StubField[] = [];
    for (let n = 1; n <= signers; n++) {
      const r: StubRecipient = { id: nextRecipient++, role: "SIGNER", email: `guardian.${n}@placeholder.stub.test`, name: `Guardian ${n}`, token: id("tpl"), signingStatus: "NOT_SIGNED", signedAt: null, signingOrder: n };
      recipients.push(r);
      const subjectLabel = spec.subjectLabel === undefined ? "Student name" : spec.subjectLabel;
      if (n === 1 && subjectLabel !== null) fields.push(text(r.id, subjectLabel));
      fields.push(text(r.id, `Guardian ${n} name`));
      if (spec.noSignatureFor !== n) fields.push({ id: nextField++, type: "SIGNATURE", recipientId: r.id, inserted: false, customText: "", fieldMeta: { type: "signature" } });
      fields.push({ id: nextField++, type: "DATE", recipientId: r.id, inserted: false, customText: "", fieldMeta: { type: "date" } });
    }
    if (spec.extraRole) recipients.push({ id: nextRecipient++, role: spec.extraRole, email: "office@placeholder.stub.test", name: "Office", token: id("tpl"), signingStatus: "NOT_SIGNED", signedAt: null, signingOrder: signers + 1 });
    const on = !spec.emailsOff;
    const template: StubEnvelope = { id: id("envelope"), type: "TEMPLATE", status: "DRAFT", externalId: null, title: spec.title ?? "Commitment form", createdAt: now(), updatedAt: now(),
      completedAt: null, deletedAt: null, templateId: null, recipients, fields,
      documentMeta: { distributionMethod: on ? "EMAIL" : "NONE", emailSettings: Object.fromEntries(EMAIL_FLAGS.map((f) => [f, on])), timezone: "Etc/UTC", dateFormat: "yyyy-MM-dd hh:mm a", envelopeExpirationPeriod: { unit: "month", amount: 3 } } };
    stub.envelopes.set(template.id, template);
    return template;
  };
  stub.documents = () => [...stub.envelopes.values()].filter((e) => e.type === "DOCUMENT");
  stub.documentFor = (externalId) => stub.documents().filter((e) => e.externalId === externalId && e.deletedAt === null).at(-1);
  stub.seal = (envelopeId) => {
    const e = need(envelopeId);
    if (e.status === "PENDING" && allSigned(e)) { e.status = "COMPLETED"; e.completedAt = now(); e.updatedAt = now(); }
  };
  stub.sign = (envelopeId, who) => {
    const e = need(envelopeId), r = recipientOf(e, who);
    if (e.status !== "PENDING") throw new Error(`documenso stub: ${envelopeId} is ${e.status}, not out for signing`);
    r.signingStatus = "SIGNED"; r.signedAt = now(); e.updatedAt = now();
    for (const f of e.fields) if (f.recipientId === r.id) f.inserted = true;
    if (stub.sealing === "auto") stub.seal(envelopeId);
  };
  stub.reject = (envelopeId, who) => {
    const e = need(envelopeId), r = recipientOf(e, who);
    r.signingStatus = "REJECTED"; e.status = "REJECTED"; e.completedAt = now(); e.updatedAt = now(); // a rejected document has a completedAt too
  };
  stub.typeInto = (envelopeId, fieldId, text) => {
    const f = need(envelopeId).fields.find((x) => x.id === fieldId);
    if (!f || f.fieldMeta?.readOnly === true) return false;
    f.customText = text; f.inserted = true;
    return true;
  };
  stub.apiCalls = (path) => stub.calls.filter((c) => c.path.startsWith("/api/v2") && (path === undefined || c.path === `/api/v2${path}`));
  stub.reset = () => {
    stub.calls.length = 0; stub.envelopes.clear(); stub.sealing = "auto"; stub.sealWhenAsked = true; stub.sealAsks = 0; stub.healthy = true;
    stub.failNext = 0; stub.rateLimitNext = 0; stub.drop = false; stub.delayMs = 0; stub.failPathOnce = null;
  };

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      const url = new URL(req.url!, "http://stub");
      let body: unknown = null;
      try { body = req.method === "POST" ? payloadOf(req.headers["content-type"] ?? "", raw) : null; } catch { body = null; }
      const call: DocumensoCall = { method: req.method!, path: url.pathname, query: url.searchParams, auth: req.headers.authorization ?? "", body };
      stub.calls.push(call);
      if (stub.drop) { req.socket.destroy(); return; }
      if (stub.delayMs) await new Promise((r) => setTimeout(r, stub.delayMs));
      const send = (status: number, json: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(json)); };
      const refused = (status = 400, message = "Bad request") => send(status, { ...STACK, message });

      if (url.pathname === "/api/health") return send(stub.healthy ? 200 : 503, { status: stub.healthy ? "ok" : "error", checks: { database: { status: "ok" }, certificate: { status: stub.healthy ? "ok" : "error" } } });
      if (!url.pathname.startsWith("/api/v2/")) return send(404, { message: "Not found" });
      if (call.auth !== stub.token) return refused(401, "Unauthorized");
      if (stub.rateLimitNext > 0) { stub.rateLimitNext--; res.writeHead(429, { "retry-after": "30", "content-type": "application/json" }); res.end(JSON.stringify(STACK)); return; }
      if (stub.failNext > 0) { stub.failNext--; return refused(500, "Internal error"); }
      const path = url.pathname.slice("/api/v2".length);
      if (stub.failPathOnce === path) { stub.failPathOnce = null; return refused(500, "Internal error"); }
      const input = (body ?? {}) as Record<string, unknown>;

      if (req.method === "GET" && path === "/envelope") {
        const type = url.searchParams.get("type"), query = url.searchParams.get("query");
        const data = [...stub.envelopes.values()].filter((e) => e.deletedAt === null && (!type || e.type === type)
          && (!query || matches(query, e.title) || matches(query, e.externalId) || e.recipients.some((r) => matches(query, r.name) || matches(query, r.email))));
        return send(200, { data: data.map((e) => ({ id: e.id, type: e.type, status: e.status, externalId: e.externalId, title: e.title, updatedAt: e.updatedAt,
          recipients: e.recipients.map((r) => ({ id: r.id, signingStatus: r.signingStatus })) })), count: data.length, currentPage: 1, perPage: 100, totalPages: 1 });
      }
      const one = /^\/envelope\/(envelope_[A-Za-z0-9]+)$/.exec(path);
      if (req.method === "GET" && one) {
        const e = stub.envelopes.get(one[1]!);
        return e ? send(200, { ...e, envelopeItems: [{ id: `envelope_item_${e.id.slice(-8)}`, title: "form.pdf", order: 1 }] }) : refused(404, "Envelope not found");
      }
      if (req.method !== "POST") return refused(404, "Not found");

      if (path === "/envelope/use") {
        const template = stub.envelopes.get(String(input.envelopeId));
        if (!template || template.type !== "TEMPLATE") return refused(404, "Template not found");
        const given = (input.recipients ?? []) as { id: number; email: string; name: string }[];
        const prefill = (input.prefillFields ?? []) as { id: number; type: string; value: string }[];
        const override = (input.override ?? {}) as Record<string, unknown>;
        const recipientIds = new Map<number, number>();
        // Every recipient of the template is copied: one the request doesn't name keeps the template's placeholder.
        const recipients = template.recipients.map((r): StubRecipient => {
          const mine = given.find((g) => g.id === r.id);
          const made = { ...r, id: nextRecipient++, token: id("tok"), email: mine?.email ?? r.email, name: mine?.name ?? r.name, signingStatus: "NOT_SIGNED" as const, signedAt: null };
          recipientIds.set(r.id, made.id);
          return made;
        });
        const fields = template.fields.map((f): StubField => {
          const value = prefill.find((p) => p.id === f.id);
          return { ...f, id: nextField++, recipientId: recipientIds.get(f.recipientId)!, inserted: value !== undefined, customText: value?.value ?? "", fieldMeta: f.fieldMeta ? { ...f.fieldMeta } : null };
        });
        const sentFlags = (override.emailSettings ?? null) as Record<string, boolean> | null;
        const document: StubEnvelope = { id: id("envelope"), type: "DOCUMENT", status: input.distributeDocument === true ? "PENDING" : "DRAFT", externalId: typeof input.externalId === "string" ? input.externalId : null,
          title: typeof override.title === "string" ? override.title : template.title, createdAt: now(), updatedAt: now(), completedAt: null, deletedAt: null, templateId: template.id, recipients, fields,
          documentMeta: {
            distributionMethod: typeof override.distributionMethod === "string" ? override.distributionMethod : template.documentMeta.distributionMethod,
            // A flag the request doesn't send is stored as true, whatever the template had (verification, 1a).
            emailSettings: sentFlags ? Object.fromEntries(EMAIL_FLAGS.map((f) => [f, sentFlags[f] ?? true])) : { ...template.documentMeta.emailSettings },
            timezone: typeof override.timezone === "string" ? override.timezone : template.documentMeta.timezone,
            dateFormat: typeof override.dateFormat === "string" ? override.dateFormat : template.documentMeta.dateFormat,
            envelopeExpirationPeriod: override.envelopeExpirationPeriod ?? template.documentMeta.envelopeExpirationPeriod,
          } };
        stub.envelopes.set(document.id, document);
        return send(200, { id: document.id, recipients: recipients.map(shown) });
      }
      if (path === "/envelope/recipient/delete" || path === "/envelope/recipient/update-many") {
        const wanted = path.endsWith("delete") ? [Number(input.recipientId)] : ((input.data ?? []) as { id: number }[]).map((d) => d.id);
        const envelope = [...stub.envelopes.values()].find((e) => e.recipients.some((r) => wanted.includes(r.id)));
        if (!envelope) return refused(404, "Recipient not found");
        for (const recipientId of wanted) {
          const r = envelope.recipients.find((x) => x.id === recipientId)!;
          if (locked(envelope, r)) return refused(400, "Cannot modify a recipient who has already interacted with the document");
        }
        if (path.endsWith("delete")) {
          envelope.recipients = envelope.recipients.filter((r) => !wanted.includes(r.id));
          envelope.fields = envelope.fields.filter((f) => !wanted.includes(f.recipientId)); // its fields go with it
        } else {
          for (const d of (input.data ?? []) as { id: number; email?: string; name?: string }[]) {
            const r = envelope.recipients.find((x) => x.id === d.id)!;
            if (d.email) r.email = d.email;
            if (d.name) r.name = d.name;
          }
        }
        envelope.updatedAt = now();
        return send(200, { success: true });
      }
      const envelope = stub.envelopes.get(String(input.envelopeId));
      if (!envelope || envelope.type !== "DOCUMENT") return refused(404, "Envelope not found");
      if (path === "/envelope/distribute") {
        if (envelope.status === "DRAFT") { envelope.status = "PENDING"; envelope.updatedAt = now(); }
        else if (envelope.status === "PENDING" && allSigned(envelope)) { stub.sealAsks++; if (stub.sealWhenAsked) stub.seal(envelope.id); }
        return send(200, { success: true, id: envelope.id, recipients: envelope.recipients.map(shown) });
      }
      if (path === "/envelope/delete") {
        if (envelope.status === "COMPLETED") envelope.deletedAt = now(); // a soft delete: it still answers, marked deleted
        else stub.envelopes.delete(envelope.id);
        return send(200, { success: true });
      }
      return refused(404, "Not found");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return stub;
}
