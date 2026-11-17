// Staff only: one signed form's evidence, its files, the archive of an earlier QuickBooks company's, and one request
// as it stands. The pages and downloads that show these audit each read before anything is shown or sent. Never
// imported by parent code (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts).
import "server-only";
import { and, asc, desc, eq, isNotNull, isNull, notInArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { qboCustomer, requirement, signatureConsent, signatureRequest, signedFormCopy, signedFormEvidence, signedFormFile } from "@/lib/db/schema";
import { getRosterSource } from "@/lib/roster/source";
import { isUuid } from "@/lib/seasons/ids";

export type EvidenceRow = typeof signedFormEvidence.$inferSelect;
export type EvidenceFileInfo = { id: string; kind: (typeof signedFormFile.$inferSelect)["kind"]; position: number; size: number; sha256: string; key: string; label: string };
export type EvidenceView = {
  evidence: EvidenceRow;
  files: EvidenceFileInfo[];
  copies: { parentId: string; outcome: string; how: string | null; doneAt: Date | null }[];
  /** True when this evidence is from a QuickBooks company other than the one connected now: shown in the archive only. */
  earlier: boolean;
};

/** Each stored file's place in a download address, its fixed file name, and what staff read for it. */
const FILES = {
  sealed_pdf: { key: (n: number) => `sealed-pdf-${n}`, name: (n: number) => (n === 1 ? "signed-form.pdf" : `signed-form-part-${n}.pdf`), label: "Signed form (sealed PDF)", type: "application/pdf" },
  certificate_pdf: { key: () => "certificate-pdf", name: () => "certificate.pdf", label: "Signing certificate (PDF)", type: "application/pdf" },
  audit_log_pdf: { key: () => "audit-log-pdf", name: () => "audit-log.pdf", label: "Audit log (PDF)", type: "application/pdf" },
  audit_log_json: { key: () => "audit-log-json", name: () => "audit-log.json", label: "Audit log (JSON)", type: "application/json" },
} as const;
export const RECORD_KEY = "evidence-record-json";
const ORDER = ["sealed_pdf", "certificate_pdf", "audit_log_pdf", "audit_log_json"] as const;

/** One evidence row and the facts about its files (never the bytes); null for an id that isn't one. */
export async function loadEvidence(id: unknown): Promise<EvidenceView | null> {
  if (!isUuid(id)) return null;
  const [evidence] = await db.select().from(signedFormEvidence).where(eq(signedFormEvidence.id, id));
  if (!evidence) return null;
  const rows = await db.select({ id: signedFormFile.id, kind: signedFormFile.kind, position: signedFormFile.position, size: signedFormFile.size, sha256: signedFormFile.sha256 })
    .from(signedFormFile).where(eq(signedFormFile.evidenceId, id)).orderBy(asc(signedFormFile.position));
  const files = rows.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.position - b.position)
    .map((f) => ({ ...f, key: FILES[f.kind].key(f.position), label: `${FILES[f.kind].label}${f.kind === "sealed_pdf" && rows.filter((r) => r.kind === "sealed_pdf").length > 1 ? `, part ${f.position}` : ""}` }));
  const copies = await db.select({ parentId: signedFormCopy.parentId, outcome: signedFormCopy.outcome, how: signedFormCopy.how, doneAt: signedFormCopy.doneAt }).from(signedFormCopy)
    .where(eq(signedFormCopy.evidenceId, id)).orderBy(asc(signedFormCopy.claimedAt));
  const realmId = await getRosterSource();
  return { evidence, files, copies, earlier: evidence.earlierCompanyAt !== null || evidence.realmId !== realmId };
}

export type EvidenceDownload = { bytes: Buffer; filename: string; contentType: string; kind: string; sha256: string | null };

/** One file of an evidence row by the key in the download address, or the evidence record as JSON; null for anything else. */
export async function evidenceDownload(id: unknown, key: unknown): Promise<EvidenceDownload | null> {
  const view = await loadEvidence(id);
  if (!view || typeof key !== "string") return null;
  if (key === RECORD_KEY) return { bytes: Buffer.from(JSON.stringify(evidenceRecord(view), null, 2), "utf8"), filename: "evidence-record.json", contentType: "application/json", kind: "evidence_record", sha256: null };
  const info = view.files.find((f) => f.key === key);
  if (!info) return null;
  const [file] = await db.select({ bytes: signedFormFile.bytes }).from(signedFormFile).where(eq(signedFormFile.id, info.id));
  if (!file) return null;
  return { bytes: file.bytes, filename: FILES[info.kind].name(info.position), contentType: FILES[info.kind].type, kind: info.kind, sha256: info.sha256 };
}

/** The evidence record: everything kept about the signed form but the files' bytes, which are named by size and hash. */
export function evidenceRecord(view: EvidenceView) {
  const e = view.evidence;
  return {
    evidenceId: e.id, requestId: e.requestId, quickBooksCompany: e.realmId, fromAnEarlierCompany: view.earlier, earlierCompanySince: e.earlierCompanyAt?.toISOString() ?? null,
    form: e.formTitle, season: e.seasonName, family: { qboId: e.familyQboId, name: e.familyName }, signedFor: { kind: e.subjectKind, qboId: e.subjectQboId, name: e.subjectName },
    documenso: { envelopeId: e.envelopeId, templateId: e.templateId, templateUpdatedAt: e.templateUpdatedAt?.toISOString() ?? null, completedAt: e.completedAt?.toISOString() ?? null },
    signers: e.signers, consents: e.consents,
    files: view.files.map((f) => ({ kind: f.kind, position: f.position, size: f.size, sha256: f.sha256 })),
    originals: e.originals, storedAt: e.storedAt.toISOString(), hashMismatchSeenAt: e.mismatchAt?.toISOString() ?? null,
    copies: view.copies.map((c) => ({ parentId: c.parentId, outcome: c.outcome, how: c.how, at: c.doneAt?.toISOString() ?? null })),
  };
}

export type ArchiveEntry = { id: string; formTitle: string; subjectName: string | null; familyName: string | null; seasonName: string | null; completedAt: Date | null; realmId: string | null; earlierCompanyAt: Date | null };
/** Evidence kept from an earlier QuickBooks company, newest signing first, by the names it kept. */
export async function loadArchive(): Promise<ArchiveEntry[]> {
  return db.select({ id: signedFormEvidence.id, formTitle: signedFormEvidence.formTitle, subjectName: signedFormEvidence.subjectName, familyName: signedFormEvidence.familyName,
    seasonName: signedFormEvidence.seasonName, completedAt: signedFormEvidence.completedAt, realmId: signedFormEvidence.realmId, earlierCompanyAt: signedFormEvidence.earlierCompanyAt })
    .from(signedFormEvidence).where(isNotNull(signedFormEvidence.earlierCompanyAt)).orderBy(desc(signedFormEvidence.completedAt), asc(signedFormEvidence.id));
}

/** At most this many other kept signed forms are listed at once; a search narrows them. */
export const OTHER_KEPT_LIMIT = 200;
/**
 * The company's own kept signed forms the matrix doesn't lead to (`shown` are the ones it does): an earlier season's,
 * or a family's or student's no longer on the roster. Newest signing first, by the names kept with them, narrowed by
 * `search` (a form, student, family or season name).
 */
export async function loadOtherKept(shown: readonly string[], search: string): Promise<{ entries: ArchiveEntry[]; more: boolean }> {
  const realmId = await getRosterSource();
  if (realmId === null) return { entries: [], more: false };
  const rows = await db.select({ id: signedFormEvidence.id, formTitle: signedFormEvidence.formTitle, subjectName: signedFormEvidence.subjectName, familyName: signedFormEvidence.familyName,
    seasonName: signedFormEvidence.seasonName, completedAt: signedFormEvidence.completedAt, realmId: signedFormEvidence.realmId, earlierCompanyAt: signedFormEvidence.earlierCompanyAt })
    .from(signedFormEvidence)
    .where(and(eq(signedFormEvidence.realmId, realmId), isNull(signedFormEvidence.earlierCompanyAt), shown.length ? notInArray(signedFormEvidence.id, [...shown]) : undefined))
    .orderBy(desc(signedFormEvidence.completedAt), asc(signedFormEvidence.id));
  const needle = search.toLowerCase();
  const found = needle === "" ? rows : rows.filter((r) => [r.formTitle, r.subjectName, r.familyName, r.seasonName].some((t) => t?.toLowerCase().includes(needle)));
  return { entries: found.slice(0, OTHER_KEPT_LIMIT), more: found.length > OTHER_KEPT_LIMIT };
}

export type RequestView = {
  row: typeof signatureRequest.$inferSelect;
  title: string; appliesTo: "family" | "student"; signersMode: "any" | "every" | null;
  familyName: string | null; subjectName: string | null;
  consents: { parentName: string; textVersion: string; agreedAt: Date }[];
  evidenceId: string | null;
};
/** One request of the company connected now, as it stands; null for an id that isn't one. */
export async function loadRequest(id: unknown): Promise<RequestView | null> {
  if (!isUuid(id)) return null;
  const [found] = await db.select({ row: signatureRequest, title: requirement.title, appliesTo: requirement.appliesTo, form: requirement.form }).from(signatureRequest)
    .innerJoin(requirement, eq(requirement.id, signatureRequest.requirementId)).where(eq(signatureRequest.id, id));
  if (!found) return null;
  const names = await db.select({ qboId: qboCustomer.qboId, name: qboCustomer.displayName }).from(qboCustomer).where(eq(qboCustomer.qboId, found.row.familyQboId));
  const subject = found.row.subjectQboId === found.row.familyQboId ? names : await db.select({ qboId: qboCustomer.qboId, name: qboCustomer.displayName }).from(qboCustomer).where(eq(qboCustomer.qboId, found.row.subjectQboId));
  const consents = await db.select({ parentName: signatureConsent.parentName, textVersion: signatureConsent.textVersion, agreedAt: signatureConsent.agreedAt }).from(signatureConsent)
    .where(eq(signatureConsent.requestId, id)).orderBy(asc(signatureConsent.agreedAt));
  const realmId = await getRosterSource();
  const [evidence] = realmId === null ? [] : await db.select({ id: signedFormEvidence.id }).from(signedFormEvidence)
    .where(and(eq(signedFormEvidence.requestId, id), eq(signedFormEvidence.realmId, realmId)));
  return { row: found.row, title: found.title, appliesTo: found.appliesTo, signersMode: found.form?.signers ?? found.row.signersMode,
    familyName: names[0]?.name ?? null, subjectName: subject[0]?.name ?? found.row.subjectName, consents, evidenceId: evidence?.id ?? null };
}
