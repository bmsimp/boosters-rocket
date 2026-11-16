// What the portal keeps about each form to be signed, and the one way it is brought up to date: by reading the
// document from Documenso's API and storing what that says (v1 spec §9.2 step 5, as the verification changed it). The
// parent's pages, the webhook and the worker's job all come through readAndStore(): none of them stores anything a
// webhook's body or the signing frame said. Imports no staff-only module (tests/integration/page-guards.test.ts).
import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { signatureRequest, type RequestSigner } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { documensoCode, getEnvelope, type CallOptions, type DocumensoConfig, type DocumensoErrorCode, type Envelope } from "@/lib/documenso/client";
import { noteApiFailure, noteApiOk } from "./settings";
import { readDocument, type DocumentReading } from "./states";

export type RequestRow = typeof signatureRequest.$inferSelect;
export type FormsFailure = DocumensoErrorCode | "unexpected";

/** Who the audit log names when Documenso's own record moved a request on. */
export const DOCUMENSO_ACTOR: Actor = { door: "system", id: null, label: "documenso" };
export const FORMS_WORKER: Actor = { door: "system", id: null, label: "worker" };

/** One call to Documenso, with its outcome noted for the Health page. The error keeps its short code and nothing else. */
export async function asking<T>(call: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: FormsFailure }> {
  try {
    const value = await call();
    await noteApiOk();
    return { ok: true, value };
  } catch (e) {
    const code = documensoCode(e);
    // "Nothing with that id" is an answer, not an outage: Documenso was reached and replied.
    if (code === "not_found") await noteApiOk(); else await noteApiFailure(code);
    return { ok: false, code };
  }
}

/** The fields that describe a document, as they stand when there is none. */
export const NO_DOCUMENT = {
  state: "not_opened", envelopeId: null, envelopeStatus: null, templateId: null, templateUpdatedAt: null, signersMode: null, subjectName: null,
  signers: [] as RequestSigner[], documentCreatedAt: null, allSignedAt: null, sealAskedAt: null, completedAt: null, declinedAt: null,
} as const;

/**
 * Stores what a document's own record says, for a request that still points at that document. A request that is
 * complete or declined is left as it is, whatever is read later: a signed form stays signed even if someone deletes
 * the document in Documenso. A change of state is audited in the transaction that makes it; a request that becomes
 * complete is marked as owing its evidence (the sealed PDF and the audit record), for the job that fetches it.
 */
export async function storeReading(row: RequestRow, reading: DocumentReading, o: { actor: Actor; ip: string | null }, at: Date = new Date()): Promise<RequestRow> {
  if (row.state === "complete" || row.state === "declined" || row.envelopeId === null) return row;
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(signatureRequest).where(eq(signatureRequest.id, row.id)).for("update");
    // The document was replaced, or the request finished, while this reading was on its way: nothing to store.
    if (!current || current.envelopeId !== row.envelopeId || current.state === "complete" || current.state === "declined") return current ?? row;
    const next = reading.state === "gone" ? { ...NO_DOCUMENT, signers: [] as RequestSigner[], checkedAt: at, updatedAt: at } : {
      state: reading.state, envelopeStatus: reading.status, checkedAt: at, updatedAt: at,
      signers: current.signers.map((s) => ({ ...s, signedAt: reading.signedAt.get(s.recipientId) ?? null })),
      allSignedAt: reading.state === "signed" || reading.state === "complete" ? (current.allSignedAt ?? at) : null,
      completedAt: reading.state === "complete" ? (parsed(reading.completedAt) ?? at) : null,
      declinedAt: reading.state === "declined" ? at : null,
      ...(reading.state === "complete" ? { evidenceOwed: true } : {}),
    };
    const [after] = await tx.update(signatureRequest).set(next).where(eq(signatureRequest.id, current.id)).returning();
    if (after!.state !== current.state) await auditState(tx, current, after!, reading.status, o);
    return after!;
  });
}

const parsed = (iso: string | null): Date | null => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };

async function auditState(tx: Tx, before: RequestRow, after: RequestRow, documensoStatus: string, o: { actor: Actor; ip: string | null }): Promise<void> {
  await writeAudit({ actor: o.actor, action: "form.state.change", targetType: "signature_request", targetId: after.id, ip: o.ip,
    before: { state: before.state }, after: { state: after.state, documensoStatus, familyQboId: after.familyQboId, subjectQboId: after.subjectQboId, requirementId: after.requirementId } }, tx);
}

export type Read = { ok: true; row: RequestRow; envelope: Envelope | null; reading: DocumentReading | null } | { ok: false; code: FormsFailure; row: RequestRow };

/**
 * Reads a request's document from Documenso and stores what it says. A document Documenso no longer has (404), or
 * one that doesn't carry this request's id as its externalId, counts as gone. `envelope` comes back for the caller
 * that needs a recipient's signing token; it is never stored.
 */
export async function readAndStore(row: RequestRow, config: DocumensoConfig, o: { actor: Actor; ip: string | null } & CallOptions): Promise<Read> {
  if (row.envelopeId === null) return { ok: true, row, envelope: null, reading: null };
  const got = await asking(() => getEnvelope(config, row.envelopeId!, { timeoutMs: o.timeoutMs }));
  if (!got.ok && got.code !== "not_found") return { ok: false, code: got.code, row };
  const envelope = got.ok && got.value.externalId === row.id ? got.value : null;
  const reading: DocumentReading = envelope ? readDocument(envelope)
    : { state: "gone", status: got.ok ? "NOT_OURS" : "NOT_FOUND", signedAt: new Map(), anySigned: false, completedAt: null };
  const stored = await storeReading(row, reading, o);
  return { ok: true, row: stored, envelope: reading.state === "gone" ? null : envelope, reading };
}

/**
 * Takes the request for a moment, so two opens at once can't make two documents (Documenso's `use` has no
 * idempotency key). False when someone else holds it; a hold older than a minute was left by a crash and is taken over.
 */
export async function claim(requestId: string, at: Date = new Date()): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`UPDATE signature_request SET preparing_at = ${at.toISOString()}::timestamptz
    WHERE id = ${requestId} AND (preparing_at IS NULL OR preparing_at < ${new Date(at.getTime() - CLAIM_MS).toISOString()}::timestamptz) RETURNING id`);
  return Array.from(rows as ArrayLike<{ id: string }>).length > 0;
}
export const CLAIM_MS = 60_000;
export async function release(requestId: string): Promise<void> {
  await db.update(signatureRequest).set({ preparingAt: null }).where(eq(signatureRequest.id, requestId));
}

/** The family's own request with this id, or nothing. Every parent lookup of a request comes through here. */
export async function requestOfFamily(requestId: string, familyQboId: string): Promise<RequestRow | null> {
  const [row] = await db.select().from(signatureRequest).where(and(eq(signatureRequest.id, requestId), eq(signatureRequest.familyQboId, familyQboId)));
  return row ?? null;
}
