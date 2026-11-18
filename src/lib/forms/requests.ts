// What the portal keeps about each form to be signed, and the one way it is brought up to date: by reading the
// document from Documenso's API and storing what that says (v1 spec §9.2 step 5, as the verification changed it). The
// parent's pages, the webhook and the worker's job all come through readAndStore(): none of them stores anything a
// webhook's body or the signing frame said. Imports no staff-only module (tests/integration/page-guards.test.ts).
import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { guardian, signatureRequest, type RequestSigner } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import type { AppFamilyId } from "@/lib/families/ids";
import type { SubjectId } from "@/lib/seasons/progress";
import { documensoCode, getEnvelope, type CallOptions, type DocumensoConfig, type DocumensoErrorCode, type Envelope } from "@/lib/documenso/client";
import { noteApiFailure, noteApiOk } from "./settings";
import { readDocument, type DocumentReading } from "./states";

export type RequestRow = typeof signatureRequest.$inferSelect;
export type FormsFailure = DocumensoErrorCode | "unexpected";

/** Who the audit log names when Documenso's own record moved a request on. */
export const DOCUMENSO_ACTOR: Actor = { door: "system", id: null, label: "documenso" };
export const FORMS_WORKER: Actor = { door: "system", id: null, label: "worker" };

/**
 * One call to Documenso, with its outcome noted for the Health page. The error keeps its short code and nothing else.
 * "Nothing with that id" is usually an answer, not an outage: Documenso was reached and replied. But a document the
 * portal made and recorded should be there, so a call for one passes `missingIsFailure` and its 404 is noted as a
 * failure: a token of another team, or the wrong address, answers 404 for every document.
 */
export async function asking<T>(call: () => Promise<T>, o: { missingIsFailure?: boolean } = {}): Promise<{ ok: true; value: T } | { ok: false; code: FormsFailure }> {
  try {
    const value = await call();
    await noteApiOk();
    return { ok: true, value };
  } catch (e) {
    const code = documensoCode(e);
    if (code === "not_found" && !o.missingIsFailure) await noteApiOk(); else await noteApiFailure(code);
    return { ok: false, code };
  }
}

/** The fields that describe a document, as they stand when there is none. */
export const NO_DOCUMENT = {
  state: "not_opened", envelopeId: null, envelopeStatus: null, templateId: null, templateUpdatedAt: null, signersMode: null, subjectName: null,
  signers: [] as RequestSigner[], documentCreatedAt: null, allSignedAt: null, sealAskedAt: null, completedAt: null, declinedAt: null,
} as const;

/** True while an open is making or replacing the request's document (claim()). A hold older than CLAIM_MS was left by a crash. */
export const isHeld = (row: Pick<RequestRow, "preparingAt">, at: Date = new Date()): boolean => row.preparingAt !== null && row.preparingAt.getTime() > at.getTime() - CLAIM_MS;
/** True when the request holds a signature: a guardian signed its document, or everyone did and it is being sealed. */
export const holdsSignature = (row: Pick<RequestRow, "state" | "signers">): boolean => row.state === "signed" || row.signers.some((s) => s.signedAt !== null);

/**
 * Stores what a document's own record says, for a request that still points at that document. A request that is
 * complete or declined is left as it is, whatever is read later: a signed form stays signed even if someone deletes
 * the document in Documenso. A request whose document an open is making right now is left alone too: until that
 * open has sent it, Documenso reads the document as a draft, which would look like a document gone. And a document
 * that seems gone is forgotten only while nobody has signed it: a request that holds a signature is kept as it is
 * (only `checkedAt` moves), since a wrong address or a token of another team answers "not found" for every document.
 * A change of state is audited in the transaction that makes it; a request that becomes complete is marked as owing
 * its evidence (the sealed PDF and the audit record), for the job that fetches it.
 */
export async function storeReading(row: RequestRow, reading: DocumentReading, o: { actor: Actor; ip: string | null }, at: Date = new Date()): Promise<RequestRow> {
  if (row.state === "complete" || row.state === "declined" || row.envelopeId === null) return row;
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(signatureRequest).where(eq(signatureRequest.id, row.id)).for("update");
    // The document was replaced, the request finished, or an open is making it, while this reading was on its way: nothing to store.
    if (!current || current.envelopeId !== row.envelopeId || current.state === "complete" || current.state === "declined" || isHeld(current, at)) return current ?? row;
    if (reading.state === "gone" && holdsSignature(current)) {
      const [kept] = await tx.update(signatureRequest).set({ checkedAt: at }).where(eq(signatureRequest.id, current.id)).returning();
      return kept!;
    }
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
    // Each signature the portal first reads is recorded with the portal guardian whose recipient signed (spec §9.4).
    for (const s of after!.signers) {
      if (s.signedAt === null || current.signers.find((c) => c.recipientId === s.recipientId)?.signedAt) continue;
      await writeAudit({ actor: o.actor, action: "form.signer.signed", targetType: "signature_request", targetId: after!.id, ip: o.ip,
        after: { envelopeId: after!.envelopeId, recipientId: s.recipientId, parentId: s.parentId || null, name: s.name, email: s.email, signedAt: s.signedAt, ...requestRecords(after!) } }, tx);
    }
    return after!;
  });
}

const parsed = (iso: string | null): Date | null => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };

async function auditState(tx: Tx, before: RequestRow, after: RequestRow, documensoStatus: string, o: { actor: Actor; ip: string | null }): Promise<void> {
  await writeAudit({ actor: o.actor, action: "form.state.change", targetType: "signature_request", targetId: after.id, ip: o.ip,
    before: { state: before.state }, after: { state: after.state, documensoStatus, ...requestRecords(after), requirementId: after.requirementId } }, tx);
}

export type Read = { ok: true; row: RequestRow; envelope: Envelope | null; reading: DocumentReading | null } | { ok: false; code: FormsFailure; row: RequestRow };

/**
 * Reads a request's document from Documenso and stores what it says. A document Documenso no longer has (404), or
 * one that doesn't carry this request's id as its externalId, counts as gone. `envelope` comes back for the caller
 * that needs a recipient's signing token; it is never stored. When the reading could not be stored as it was (an
 * open is making the document, or the request holds a signature and its document seems gone), the answer is a
 * failure: the page says it can't show the form just now, and the worker asks again later.
 */
export async function readAndStore(row: RequestRow, config: DocumensoConfig, o: { actor: Actor; ip: string | null } & CallOptions): Promise<Read> {
  if (row.envelopeId === null) return { ok: true, row, envelope: null, reading: null };
  const got = await asking(() => getEnvelope(config, row.envelopeId!, { timeoutMs: o.timeoutMs }), { missingIsFailure: true });
  if (!got.ok && got.code !== "not_found") return { ok: false, code: got.code, row };
  const envelope = got.ok && got.value.externalId === row.id ? got.value : null;
  const reading: DocumentReading = envelope ? readDocument(envelope)
    : { state: "gone", status: got.ok ? "NOT_OURS" : "NOT_FOUND", signedAt: new Map(), anySigned: false, completedAt: null };
  const stored = await storeReading(row, reading, o);
  const unstored = stored.envelopeId !== null && stored.envelopeId === row.envelopeId && stored.state !== "complete" && stored.state !== "declined" && (reading.state === "gone" || isHeld(stored));
  if (unstored) return { ok: false, code: reading.state === "gone" ? "not_found" : "unexpected", row: stored };
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
/**
 * Waits, briefly, for whoever holds the request to finish making its document: two draws of one page, or two
 * guardians at the same moment. The row as it stands when the hold is gone, or null when it is still held.
 */
export async function whenReleased(requestId: string, waitMs = 8_000): Promise<RequestRow | null> {
  const until = Date.now() + waitMs;
  for (;;) {
    const [row] = await db.select().from(signatureRequest).where(eq(signatureRequest.id, requestId));
    if (!row || row.preparingAt === null) return row ?? null;
    if (Date.now() >= until) return null;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
export async function release(requestId: string): Promise<void> {
  await db.update(signatureRequest).set({ preparingAt: null }).where(eq(signatureRequest.id, requestId));
}

/**
 * True when every guardian the request's document was made for is a guardian of this app family (a link of any status:
 * one closed since still counts, since they signed as the family's own). A request whose student moved here from
 * another family keeps the old family's guardians on it (formsForMovedStudent): it counts for the student, but who
 * signed it and the signed PDF (their names, signatures and what they filled in) are that family's, so a parent page
 * shows them only when this is true. A signer the portal couldn't match to a guardian (no parentId) makes it false.
 */
export async function signedWithin(familyId: AppFamilyId, signers: readonly Pick<RequestSigner, "parentId">[]): Promise<boolean> {
  if (signers.length === 0) return true;
  if (signers.some((s) => !s.parentId)) return false;
  const ids = [...new Set(signers.map((s) => s.parentId))];
  // A guardian's membership of the app's own family (guardian.family_id).
  const links = await db.select({ parentId: guardian.parentId }).from(guardian).where(and(eq(guardian.familyId, familyId), inArray(guardian.parentId, ids)));
  return ids.every((id) => links.some((l) => l.parentId === id));
}

/** The family's own request with this id, or nothing. Every parent lookup of a request comes through here. */
export async function requestOfFamily(requestId: string, familyId: AppFamilyId): Promise<RequestRow | null> {
  const [row] = await db.select().from(signatureRequest).where(and(eq(signatureRequest.id, requestId), eq(signatureRequest.familyId, familyId)));
  return row ?? null;
}

/** Whom a request is signed for: its student for a per-student form, its family for a per-family one. */
export const subjectOfRequest = (row: Pick<RequestRow, "familyId" | "studentId">): SubjectId => row.studentId ?? row.familyId;

/** The app's records a request names, as its audit rows write them (open question 17: older rows keep the QuickBooks ids). */
export const requestRecords = (row: Pick<RequestRow, "familyId" | "studentId">): { familyId: string; studentId: string | null } =>
  ({ familyId: String(row.familyId), studentId: row.studentId === null ? null : String(row.studentId) });
