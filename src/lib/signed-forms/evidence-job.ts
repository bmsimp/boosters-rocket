// Staff only (it reads every family's completed forms): the worker's part in keeping signed forms (v1 spec §9.2 step 6
// and §9.4, as the Documenso verification changed them). A request that becomes complete is marked `evidence_owed`;
// a few of them each wake, oldest first, have their evidence fetched from Documenso and kept in the portal's database:
// every item's sealed PDF, the certificate and the audit log as PDFs, the audit log as JSON, and the hash of each
// original PDF. Nothing is assumed about what the sealed PDF holds: the certificate and the audit log are kept as their
// own files whatever Documenso put inside it (verification, 1a point 4). Never imported by parent code
// (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts).
import "server-only";
import { createHash } from "node:crypto";
import { and, asc, count, eq, isNotNull, isNull, lte, min, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import {
  family, formWithdrawal, requirement, season, seasonStep, signatureConsent, signatureRequest, signedFormEvidence, signedFormFile,
  type EvidenceConsent, type EvidenceOriginal, type EvidenceSigner,
} from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import {
  auditLogEntries, cancelEnvelope, deleteEnvelope, documensoCode, downloadAuditLogPdf, downloadCertificate, downloadItem, getEnvelope, isEnvelopeItemId,
  type DocumensoConfig,
} from "@/lib/documenso/client";
import { getRosterSource } from "@/lib/roster/source";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { FORMS_WORKER, requestRecords, type FormsFailure } from "@/lib/forms/requests";
import { customerOfFamily, customerOfStudent, recordsCompany } from "@/lib/families/links";
import { readDocument } from "@/lib/forms/states";
import { getFormsConfig, noteApiFailure, noteApiOk } from "@/lib/forms/settings";
import { sendOwedCopies } from "./copies";
import { EVIDENCE_LATE_MS, nextEvidenceTry } from "./rules";

export const EVIDENCE_JOB = "forms.evidence";
/** One wake fetches the evidence of this many forms at most, the longest waiting first. */
export const EVIDENCE_PER_WAKE = 5;

export const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

type FileKind = (typeof signedFormFile.$inferInsert)["kind"];
type Fetched = { kind: FileKind; position: number; itemId: string | null; bytes: Buffer; sha256: string };
type Evidence = { files: Fetched[]; originals: EvidenceOriginal[]; completedAt: Date | null };
type RequestRow = typeof signatureRequest.$inferSelect;

/** Everything Documenso holds as the evidence of one completed document, fetched in full or not at all. */
async function fetchEvidence(config: DocumensoConfig, row: RequestRow): Promise<{ ok: true; evidence: Evidence } | { ok: false; code: FormsFailure | "not_complete" }> {
  try {
    const envelope = await getEnvelope(config, row.envelopeId!);
    // The document must still be this request's, and sealed: only a COMPLETED document has a sealed PDF.
    if (envelope.externalId !== row.id) return { ok: false, code: "not_found" };
    if (envelope.status !== "COMPLETED") return { ok: false, code: "not_complete" };
    const items = [...(envelope.envelopeItems ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    if (items.length === 0 || items.some((i) => !isEnvelopeItemId(i.id))) return { ok: false, code: "bad_answer" };
    const files: Fetched[] = [];
    const originals: EvidenceOriginal[] = [];
    const keep = (kind: FileKind, position: number, itemId: string | null, bytes: Buffer) => files.push({ kind, position, itemId, bytes, sha256: sha256(bytes) });
    for (const [i, item] of items.entries()) {
      keep("sealed_pdf", i + 1, item.id, await downloadItem(config, item.id, "signed"));
      const original = await downloadItem(config, item.id, "original");
      originals.push({ itemId: item.id, sha256: sha256(original), size: original.byteLength });
    }
    keep("certificate_pdf", 1, null, await downloadCertificate(config, row.envelopeId!));
    keep("audit_log_pdf", 1, null, await downloadAuditLogPdf(config, row.envelopeId!));
    keep("audit_log_json", 1, null, (await auditLogEntries(config, row.envelopeId!)).json);
    const completedAt = envelope.completedAt ? new Date(envelope.completedAt) : null;
    return { ok: true, evidence: { files, originals, completedAt: completedAt && !Number.isNaN(completedAt.getTime()) ? completedAt : null } };
  } catch (e) {
    return { ok: false, code: documensoCode(e) };
  }
}

/**
 * Whether the request's links can be read now. While QuickBooks is connected to a company other than the roster's,
 * every lookup through a link answers nothing though the links exist (recordsCompany() is null while the roster names a
 * company), so a record with no link can't be told from one whose link can't be read: nothing is kept then
 * (`other_company`), and the job tries again later. Otherwise the links are read in the roster's company, or there is
 * no company at all (the roster names none: a club with no accounting system), and a record with no link is no reason
 * to wait.
 */
async function linksReadable(tx?: Tx): Promise<{ readable: false } | { readable: true; realmId: string | null }> {
  const [source, company] = await Promise.all([getRosterSource(tx), recordsCompany(tx)]);
  if (source !== null && company !== source) return { readable: false };
  return { readable: true, realmId: source };
}

type Names = { formTitle: string; seasonName: string | null; familyName: string | null; subjectKind: "family" | "student"; realmId: string | null; familyQboId: string | null; subjectQboId: string | null };

/**
 * The names as they are now, kept with the evidence as they were: the form's title, its season, the family (the app's
 * record of it, named from the roster). And the QuickBooks customers of the request's family and student records, in
 * the roster's company, which the evidence keeps as its own copies of whose form it was (family_qbo_id,
 * subject_qbo_id), each null when that record has no link; with them the company (realm_id), kept only with the
 * family's copy. A QuickBooks id is never kept without its company, so a family with no link keeps no copy at all,
 * whatever its student's link. Read in the store's own transaction, which holds the roster lock shared (storeEvidence()):
 * every write of a link holds it exclusively (a staff roster write's changeOwnRecord() under lockRosterAs(), "Create a
 * family from this" and "Create in QuickBooks and link", the change of company's clear), so a link made at that moment
 * is either in these copies or made after the evidence is kept, never missed or half-seen. Throws
 * EvidenceNotStored("other_company") when the links can't be read.
 */
async function namesOf(tx: Tx, row: RequestRow): Promise<Names> {
  const links = await linksReadable(tx);
  if (!links.readable) throw new EvidenceNotStored("other_company");
  const [r] = await tx.select({ title: requirement.title, seasonName: season.name }).from(requirement)
    .innerJoin(seasonStep, eq(seasonStep.id, requirement.stepId)).innerJoin(season, eq(season.id, seasonStep.seasonId)).where(eq(requirement.id, row.requirementId));
  const [mine] = await tx.select({ name: family.name }).from(family).where(eq(family.id, row.familyId));
  const familyQboId = links.realmId === null ? null : await customerOfFamily(row.familyId, tx);
  const subjectQboId = familyQboId === null ? null : row.studentId === null ? familyQboId : await customerOfStudent(row.studentId, tx);
  return { formTitle: r?.title ?? "Form", seasonName: r?.seasonName ?? null, familyName: mine?.name ?? null, subjectKind: row.studentId === null ? "family" : "student",
    realmId: familyQboId === null ? null : links.realmId, familyQboId, subjectQboId };
}

const shown = (f: Pick<Fetched, "kind" | "position" | "sha256"> & { size: number }) => ({ kind: f.kind, position: f.position, sha256: f.sha256, size: f.size });

export type StoreOutcome = "stored" | "same" | "mismatch" | "gone";

/**
 * Why evidence fetched (or about to be) can't be kept yet, in the portal's own records rather than in Documenso:
 * `other_company`, QuickBooks is connected to a company other than the roster's, so the request's links can't be read
 * and the evidence couldn't keep whose form it was (a family or student with no link is no reason: its evidence is kept
 * with no copy); `moved_while_fetched`, the request moved to another family while its files were being fetched.
 * Recorded as the request's evidence error and said on the Health page's forms line. (Until migration 0036 the first
 * was `no_link`, for a record with no link too; a request still holding that code is tried again on its own schedule.)
 */
export type NotStoredCode = "other_company" | "moved_while_fetched";
export class EvidenceNotStored extends Error {
  constructor(readonly code: NotStoredCode) { super(code); }
}

/**
 * Keeps what was fetched, in one transaction with the audit row, and only then clears `evidence_owed`. A request that
 * already has its evidence (two wakes fetched it at once, or it was fetched again) keeps the first copy: the sealed
 * PDFs and the originals are compared by hash, and one that differs is audited as a mismatch and shown on the Health
 * page. The certificate and the audit log PDF are made afresh by Documenso at each download, so theirs are not compared.
 */
export async function storeEvidence(row: RequestRow, got: Evidence, at: Date = new Date()): Promise<StoreOutcome> {
  const consents = await db.select().from(signatureConsent).where(eq(signatureConsent.requestId, row.id)).orderBy(asc(signatureConsent.agreedAt));
  return db.transaction(async (tx): Promise<StoreOutcome> => {
    // The roster lock, shared, before the request row: the order a move's follow-ups take (under the roster lock, then
    // the requests), so the two never deadlock; and no link is written while it is held (namesOf()).
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${ROSTER_LOCK})`);
    // The company and the customers as they are now (namesOf() throws while the links can't be read; runEvidenceJob()
    // checks that before fetching anything, and this is the last word). Null with no link: never filled in later.
    const names = await namesOf(tx, row);
    const realmId = names.realmId;
    const [current] = await tx.select().from(signatureRequest).where(eq(signatureRequest.id, row.id)).for("update");
    if (!current || current.state !== "complete" || current.envelopeId !== row.envelopeId) return "gone";
    // Moved to another family while this was fetched: its names and customers are read again on the next try.
    if (String(current.familyId) !== String(row.familyId) || String(current.studentId) !== String(row.studentId)) throw new EvidenceNotStored("moved_while_fetched");
    const clear = () => tx.update(signatureRequest).set({ evidenceOwed: false, evidenceTries: 0, evidenceError: null, evidenceNextAt: null, updatedAt: at }).where(eq(signatureRequest.id, row.id));
    const [kept] = await tx.select().from(signedFormEvidence).where(eq(signedFormEvidence.requestId, row.id));
    if (kept) {
      const stored = await tx.select({ kind: signedFormFile.kind, position: signedFormFile.position, sha256: signedFormFile.sha256, size: signedFormFile.size }).from(signedFormFile).where(eq(signedFormFile.evidenceId, kept.id));
      const differs = [
        ...got.files.filter((f) => f.kind === "sealed_pdf").filter((f) => stored.find((s) => s.kind === "sealed_pdf" && s.position === f.position)?.sha256 !== f.sha256)
          .map((f) => ({ kind: f.kind, position: f.position, kept: stored.find((s) => s.kind === "sealed_pdf" && s.position === f.position)?.sha256 ?? null, fetched: f.sha256 })),
        ...got.originals.filter((o) => kept.originals.find((k) => k.itemId === o.itemId)?.sha256 !== o.sha256)
          .map((o) => ({ kind: "original_pdf", itemId: o.itemId, kept: kept.originals.find((k) => k.itemId === o.itemId)?.sha256 ?? null, fetched: o.sha256 })),
      ];
      await clear();
      if (differs.length === 0) return "same";
      await tx.update(signedFormEvidence).set({ mismatchAt: kept.mismatchAt ?? at }).where(eq(signedFormEvidence.id, kept.id));
      await writeAudit({ actor: FORMS_WORKER, action: "forms.evidence.mismatch", targetType: "signed_form_evidence", targetId: kept.id,
        after: { requestId: row.id, envelopeId: row.envelopeId, differs, keptFirst: true } }, tx);
      return "mismatch";
    }
    const signers: EvidenceSigner[] = current.signers.map((s) => ({ parentId: s.parentId || null, name: s.name, email: s.email, signedAt: s.signedAt }));
    const consent: EvidenceConsent[] = consents.map((c) => ({ parentId: c.parentId, name: c.parentName, email: c.parentEmail, textVersion: c.textVersion,
      agreedAt: c.agreedAt.toISOString(), ip: c.ip, userAgent: c.userAgent }));
    const [evidence] = await tx.insert(signedFormEvidence).values({
      requestId: row.id, realmId, requirementId: row.requirementId, familyQboId: names.familyQboId, subjectQboId: names.subjectQboId, subjectKind: names.subjectKind,
      familyId: current.familyId, studentId: current.studentId,
      formTitle: names.formTitle, familyName: names.familyName, subjectName: current.subjectName, seasonName: names.seasonName,
      envelopeId: current.envelopeId!, templateId: current.templateId, templateUpdatedAt: current.templateUpdatedAt, signers, consents: consent, originals: got.originals,
      completedAt: got.completedAt ?? current.completedAt, storedAt: at,
    }).returning({ id: signedFormEvidence.id });
    await tx.insert(signedFormFile).values(got.files.map((f) => ({ evidenceId: evidence!.id, kind: f.kind, position: f.position, itemId: f.itemId, bytes: f.bytes, size: f.bytes.byteLength, sha256: f.sha256 })));
    await clear();
    await writeAudit({ actor: FORMS_WORKER, action: "forms.evidence.stored", targetType: "signed_form_evidence", targetId: evidence!.id,
      after: { requestId: row.id, envelopeId: row.envelopeId, realmId, ...requestRecords(current),
        files: got.files.map((f) => shown({ ...f, size: f.bytes.byteLength })), originals: got.originals } }, tx);
    return "stored";
  });
}

/** A failed try: nothing is kept, `evidence_owed` stays, and the next try waits 5 minutes, then 30, then 3 hours. */
async function noteFailure(row: RequestRow, code: string, at: Date): Promise<void> {
  const tries = row.evidenceTries + 1;
  await db.update(signatureRequest).set({ evidenceTries: tries, evidenceError: code, evidenceNextAt: nextEvidenceTry(tries, at), updatedAt: at })
    .where(and(eq(signatureRequest.id, row.id), eq(signatureRequest.evidenceOwed, true)));
}

export type EvidenceRun = { fetched: number; stored: number; failed: number; mismatches: number; copies: { sent: number; failed: number; skipped: number }; withdrawn: number };

/**
 * One wake's share: nothing while forms aren't set up. The evidence of up to EVIDENCE_PER_WAKE forms, the longest
 * waiting first; then the guardians' copies owed for evidence already kept; then any document a moved student left to
 * withdraw. A Documenso that can't be reached, or refuses the token, ends the fetching for this wake.
 */
export async function runEvidenceJob(now: Date = new Date()): Promise<EvidenceRun> {
  const run: EvidenceRun = { fetched: 0, stored: 0, failed: 0, mismatches: 0, copies: { sent: 0, failed: 0, skipped: 0 }, withdrawn: 0 };
  const config = await getFormsConfig();
  if (config) {
    const due = await db.select().from(signatureRequest)
      .where(and(eq(signatureRequest.evidenceOwed, true), eq(signatureRequest.state, "complete"), isNotNull(signatureRequest.envelopeId),
        or(isNull(signatureRequest.evidenceNextAt), lte(signatureRequest.evidenceNextAt, now))))
      .orderBy(sql`${signatureRequest.completedAt} asc nulls first`, asc(signatureRequest.id)).limit(EVIDENCE_PER_WAKE);
    for (const row of due) {
      run.fetched++;
      // Nothing is asked of Documenso for evidence that couldn't be kept: QuickBooks is connected to a company other
      // than the roster's, so the request's links can't be read. That is QuickBooks' connection to mend, not
      // Documenso's, and its code says so. A record with no link is no reason to wait: its evidence keeps no copy.
      if (!(await linksReadable()).readable) {
        run.failed++;
        await noteFailure(row, "other_company", now);
        continue;
      }
      const got = await fetchEvidence(config, row);
      if (!got.ok) {
        run.failed++;
        await noteFailure(row, got.code, now);
        if (got.code !== "not_complete" && got.code !== "not_found") await noteApiFailure(got.code); else await noteApiOk();
        if (got.code === "unreachable" || got.code === "timeout" || got.code === "unauthorized") break;
        continue;
      }
      await noteApiOk();
      try {
        const outcome = await storeEvidence(row, got.evidence, now);
        if (outcome === "stored") run.stored++;
        if (outcome === "mismatch") run.mismatches++;
      } catch (e) {
        run.failed++;
        await noteFailure(row, e instanceof EvidenceNotStored ? e.code : "unexpected", now);
      }
    }
    run.withdrawn = await withdrawLeftDocuments(config);
  }
  run.copies = await sendOwedCopies();
  return run;
}

/**
 * Withdraws the documents a moved student's forms left behind (formsForMovedStudent). Each is read first, since the
 * move planned from what the portal last stored: one Documenso has sealed since is never deleted or cancelled (it is
 * left in Documenso and audited for staff, form.document.withdraw.kept); one that can't be signed any more needs
 * nothing; otherwise it is deleted while nobody has signed it and cancelled once anyone has. A withdrawal that still
 * fails after ten wakes is audited as failed, with its code, and dropped: never recorded as done.
 */
async function withdrawLeftDocuments(config: DocumensoConfig): Promise<number> {
  const rows = await db.select().from(formWithdrawal).orderBy(asc(formWithdrawal.createdAt)).limit(EVIDENCE_PER_WAKE);
  let done = 0;
  for (const w of rows) {
    let how: "cancel" | "delete" | "already_gone" | "kept_complete";
    let failure: string | null = null;
    try {
      const reading = readDocument(await getEnvelope(config, w.envelopeId));
      how = reading.state === "complete" ? "kept_complete" : reading.state === "gone" || reading.state === "declined" ? "already_gone" : w.anySigned || reading.anySigned ? "cancel" : "delete";
      if (how === "cancel") await cancelEnvelope(config, w.envelopeId, "Started again for another family");
      if (how === "delete") await deleteEnvelope(config, w.envelopeId);
    } catch (e) {
      const code = documensoCode(e);
      how = "already_gone";
      if (code !== "not_found") failure = code;
    }
    if (failure !== null && w.tries < 10) { await db.update(formWithdrawal).set({ tries: w.tries + 1 }).where(eq(formWithdrawal.envelopeId, w.envelopeId)); continue; }
    await db.transaction(async (tx) => {
      await tx.delete(formWithdrawal).where(eq(formWithdrawal.envelopeId, w.envelopeId));
      const action = failure !== null ? "form.document.withdraw.failed" : how === "kept_complete" ? "form.document.withdraw.kept" : "form.document.withdraw";
      await writeAudit({ actor: FORMS_WORKER, action, targetType: "envelope", targetId: w.envelopeId,
        after: failure !== null ? { reason: "student_moved", error: failure, tries: w.tries + 1 } : { reason: "student_moved", how } }, tx);
    });
    if (failure === null) done++;
  }
  return done;
}

/**
 * For the Health page: complete forms whose evidence isn't kept yet, how many waited more than an hour, how many of
 * those last waited because QuickBooks is connected to a company other than the roster's (`otherCompany`), and any
 * hash mismatch.
 */
export async function evidenceHealth(now: Date = new Date()): Promise<{ waiting: number; late: number; oldestCompletedAt: Date | null; mismatches: number; otherCompany: number }> {
  const [owed] = await db.select({ n: count(), oldest: min(signatureRequest.completedAt) }).from(signatureRequest)
    .where(and(eq(signatureRequest.evidenceOwed, true), eq(signatureRequest.state, "complete")));
  const [late] = await db.select({ n: count() }).from(signatureRequest)
    .where(and(eq(signatureRequest.evidenceOwed, true), eq(signatureRequest.state, "complete"), lte(signatureRequest.completedAt, new Date(now.getTime() - EVIDENCE_LATE_MS))));
  const [mismatched] = await db.select({ n: count() }).from(signedFormEvidence).where(isNotNull(signedFormEvidence.mismatchAt));
  const [elsewhere] = await db.select({ n: count() }).from(signatureRequest)
    .where(and(eq(signatureRequest.evidenceOwed, true), eq(signatureRequest.state, "complete"), eq(signatureRequest.evidenceError, "other_company")));
  return { waiting: owed?.n ?? 0, late: late?.n ?? 0, oldestCompletedAt: owed?.oldest ?? null, mismatches: mismatched?.n ?? 0, otherCompany: elsewhere?.n ?? 0 };
}
