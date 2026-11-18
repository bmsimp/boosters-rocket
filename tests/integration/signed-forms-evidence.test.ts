import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string; attachments?: { filename: string; contentType: string; content: string | Buffer }[] };
const mail = vi.hoisted(() => ({ outbox: [] as Msg[], fail: false }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => {
  if (mail.fail) { const { MailSendError } = await import("@/lib/mail/types"); throw new MailSendError("The mail server refused the message. (550)"); }
  mail.outbox.push(m);
} }));

import { createHash } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, guardian, parent, setting, signedFormCopy, signedFormEvidence, signedFormFile, signatureRequest } from "@/lib/db/schema";
import { EVIDENCE_PER_WAKE, evidenceHealth, runEvidenceJob, storeEvidence } from "@/lib/signed-forms/evidence-job";
import { formsForMovedStudent } from "@/lib/forms/moved";
import { healthReport } from "@/lib/health/report";
import { SOURCE_KEY } from "@/lib/roster/source";
import { resetDb, seedWorkingMail } from "../helpers/db";
import { startDocumensoStub, type DocumensoStub } from "../helpers/documenso-stub";
import { connectForms, formSetting, requestNow, seedConsent, seedFormRequirement, signedInStub } from "../helpers/forms";
import { FAMILY_A, FAMILY_B, seedSignedInParent, type SeededParent } from "../helpers/parent";
import { seedSeason } from "../helpers/season";
import { familyRecord, studentRecord } from "../helpers/volunteer";

/**
 * Signed forms kept (src/lib/signed-forms/evidence-job.ts and copies.ts), against the Documenso stub: the worker
 * fetches each completed form's evidence (every item's sealed PDF, the certificate and the audit log as PDFs, the audit
 * log as JSON in pages, the originals' hashes) and keeps it in one transaction with its audit row, or keeps nothing and
 * backs off. Then each guardian who signed gets a copy, once: attached when small, a link when large.
 */
vi.setConfig({ testTimeout: 30_000 });
let stub: DocumensoStub;
beforeAll(async () => { stub = await startDocumensoStub(); });
afterAll(async () => { await stub.close(); });

const REALM = "4620816365000000001";
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((r) => r.action === action);
let a: SeededParent, b: SeededParent, requirementId: string, templateId: string;
const guardianOf = (p: SeededParent) => ({ parentId: p.identity.parentId, name: p.spec.parent.name, email: p.spec.parent.email });
const signedForA = (o: { items?: number } = {}) => signedInStub(stub, { requirementId, templateId, familyQboId: FAMILY_A.family.qboId, subjectQboId: FAMILY_A.students[0]!.qboId,
  subjectName: FAMILY_A.students[0]!.name, guardians: [guardianOf(a)], ...o });

beforeEach(async () => {
  await resetDb(); stub.reset(); mail.outbox.length = 0; mail.fail = false;
  // The roster's company first: seedSignedInParent() marks one only when none is set, and makes the app's records in it.
  await db.insert(setting).values({ key: SOURCE_KEY, value: { realmId: REALM } });
  a = await seedSignedInParent(FAMILY_A);
  b = await seedSignedInParent(FAMILY_B);
  await connectForms(stub);
  await seedWorkingMail();
  const season = await seedSeason({ name: "Fall", steps: [{ name: "Forms" }] });
  const template = stub.addTemplate({ signers: 1, title: "Medical release" });
  templateId = template.id;
  requirementId = await seedFormRequirement({ stepId: season.stepIds.Forms!, title: "Medical release", appliesTo: "student", form: formSetting({ id: template.id }) });
});

describe("the worker keeps a completed form's evidence", () => {
  it("fetches every file, keeps it with the names and consents as they were, clears evidence_owed and audits the hashes, never the bytes", async () => {
    stub.auditEntries = 230; // three pages of the audit log
    const { id, envelopeId } = await signedForA();
    await seedConsent(id, guardianOf(a));
    const run = await runEvidenceJob();
    expect(run).toMatchObject({ fetched: 1, stored: 1, failed: 0, mismatches: 0 });

    const [evidence] = await db.select().from(signedFormEvidence);
    expect(evidence).toMatchObject({ requestId: id, realmId: REALM, earlierCompanyAt: null, familyQboId: FAMILY_A.family.qboId, subjectQboId: FAMILY_A.students[0]!.qboId,
      subjectKind: "student", formTitle: "Medical release", familyName: FAMILY_A.family.name, subjectName: FAMILY_A.students[0]!.name, seasonName: "Fall", envelopeId, templateId: "envelope_seedtemplate" });
    // Beside its own copies of the QuickBooks ids, the app's records whose form it is: the family's and the student's.
    expect(evidence).toMatchObject({ familyId: await familyRecord(FAMILY_A.family.qboId), studentId: await studentRecord(FAMILY_A.students[0]!.qboId) });
    expect(evidence!.signers).toEqual([{ parentId: a.identity.parentId, name: FAMILY_A.parent.name, email: FAMILY_A.parent.email, signedAt: expect.any(String) }]);
    expect(evidence!.consents).toEqual([expect.objectContaining({ parentId: a.identity.parentId, name: FAMILY_A.parent.name, textVersion: expect.any(String), ip: "203.0.113.50" })]);
    expect(evidence!.originals).toEqual([{ itemId: expect.stringMatching(/^envelope_item_/), sha256: hash(stub.originalBytes(envelopeId)), size: 1585 }]);

    const files = await db.select().from(signedFormFile).orderBy(asc(signedFormFile.kind));
    expect(files.map((f) => f.kind).sort()).toEqual(["audit_log_json", "audit_log_pdf", "certificate_pdf", "sealed_pdf"]);
    const sealed = files.find((f) => f.kind === "sealed_pdf")!;
    expect(Buffer.compare(sealed.bytes, stub.sealedBytes(envelopeId))).toBe(0);
    expect(sealed.sha256).toBe(hash(stub.sealedBytes(envelopeId)));
    for (const f of files) { expect(f.size).toBe(f.bytes.byteLength); expect(f.sha256).toBe(hash(f.bytes)); }
    // Every page of the audit log, in order.
    const json = JSON.parse(files.find((f) => f.kind === "audit_log_json")!.bytes.toString("utf8"));
    expect(json.count).toBe(230);
    expect(json.entries.map((e: { data: { n: number } }) => e.data.n)).toEqual(Array.from({ length: 230 }, (_, i) => i + 1));
    expect(stub.apiCalls(`/envelope/${envelopeId}/audit-log`).map((c) => c.query.get("page"))).toEqual(["1", "2", "3"]);

    expect(await requestNow(id)).toMatchObject({ evidenceOwed: false, evidenceTries: 0, evidenceError: null });
    const [stored] = await audits("forms.evidence.stored");
    expect(stored!.after).toMatchObject({ requestId: id, envelopeId, realmId: REALM });
    expect((stored!.after as { files: unknown[] }).files).toHaveLength(4);
    expect(JSON.stringify(stored!.after)).not.toContain(sealed.bytes.subarray(0, 40).toString("base64"));
    expect(JSON.stringify(stored!.after)).not.toContain("%PDF");
    // Nothing more is fetched for it.
    stub.calls.length = 0;
    expect((await runEvidenceJob()).fetched).toBe(0);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("keeps each item of a document of several items", async () => {
    const { envelopeId } = await signedForA({ items: 3 });
    await runEvidenceJob();
    const sealed = await db.select().from(signedFormFile).where(eq(signedFormFile.kind, "sealed_pdf")).orderBy(asc(signedFormFile.position));
    expect(sealed.map((f) => f.position)).toEqual([1, 2, 3]);
    for (const f of sealed) expect(f.sha256).toBe(hash(stub.sealedBytes(envelopeId, f.position)));
    expect((await db.select().from(signedFormEvidence))[0]!.originals).toHaveLength(3);
  });

  it("does nothing while forms aren't set up, and fetches a few a wake, the longest waiting first", async () => {
    const first = await signedForA();
    await db.delete(setting).where(eq(setting.key, "forms"));
    expect((await runEvidenceJob()).fetched).toBe(0);
    await connectForms(stub);
    const more = [];
    for (let i = 0; i < EVIDENCE_PER_WAKE + 1; i++) {
      more.push(await signedInStub(stub, { requirementId, templateId, familyQboId: FAMILY_B.family.qboId, subjectQboId: `STU-B-${i}`, guardians: [guardianOf(b)] }));
    }
    await db.update(signatureRequest).set({ completedAt: new Date(Date.now() - 3_600_000) }).where(eq(signatureRequest.id, first.id));
    expect((await runEvidenceJob()).stored).toBe(EVIDENCE_PER_WAKE);
    expect((await requestNow(first.id)).evidenceOwed).toBe(false);
    expect((await runEvidenceJob()).stored).toBe(2);
  });

  it("keeps nothing when a download breaks half way, keeps evidence_owed, records the code, and backs off 5, 30, then 180 minutes", async () => {
    const { id } = await signedForA();
    stub.breakDownloadOnce = "version=signed";
    const t0 = new Date();
    const run = await runEvidenceJob(t0);
    expect(run).toMatchObject({ fetched: 1, stored: 0, failed: 1 });
    expect(await db.select().from(signedFormEvidence)).toEqual([]);
    expect(await db.select().from(signedFormFile)).toEqual([]);
    let row = await requestNow(id);
    expect(row).toMatchObject({ evidenceOwed: true, evidenceTries: 1, evidenceError: "unreachable" });
    expect(row.evidenceNextAt!.getTime() - t0.getTime()).toBe(5 * 60_000);
    expect(await audits("forms.evidence.stored")).toEqual([]);
    // Not tried again before its time.
    expect((await runEvidenceJob(new Date(t0.getTime() + 4 * 60_000))).fetched).toBe(0);
    stub.failNext = 1;
    const t1 = new Date(t0.getTime() + 5 * 60_000);
    await runEvidenceJob(t1);
    row = await requestNow(id);
    expect(row).toMatchObject({ evidenceTries: 2, evidenceError: "server" });
    expect(row.evidenceNextAt!.getTime() - t1.getTime()).toBe(30 * 60_000);
    stub.failNext = 1;
    const t2 = new Date(t1.getTime() + 30 * 60_000);
    await runEvidenceJob(t2);
    expect((await requestNow(id)).evidenceNextAt!.getTime() - t2.getTime()).toBe(180 * 60_000);
    // The next try works, and then all of it is kept.
    const t3 = new Date(t2.getTime() + 180 * 60_000);
    expect((await runEvidenceJob(t3)).stored).toBe(1);
    expect(await requestNow(id)).toMatchObject({ evidenceOwed: false, evidenceTries: 0, evidenceError: null, evidenceNextAt: null });
  });

  it("refuses a file that isn't a PDF and a document that isn't the request's or isn't sealed", async () => {
    const { id, envelopeId } = await signedForA();
    const doc = stub.envelopes.get(envelopeId)!;
    doc.externalId = "someone-else";
    await runEvidenceJob();
    expect(await requestNow(id)).toMatchObject({ evidenceOwed: true, evidenceError: "not_found" });
    doc.externalId = id; doc.status = "PENDING";
    await runEvidenceJob(new Date(Date.now() + 3_600_000));
    expect(await requestNow(id)).toMatchObject({ evidenceOwed: true, evidenceError: "not_complete" });
    expect(await db.select().from(signedFormEvidence)).toEqual([]);
  });

  it("gives the same hash when the same document is fetched again; a different one keeps the first, is audited and shows on the Health page", async () => {
    const { id, envelopeId } = await signedForA();
    await runEvidenceJob();
    const [kept] = await db.select().from(signedFormFile).where(eq(signedFormFile.kind, "sealed_pdf"));
    // Fetched again (the request owes its evidence once more): the same bytes, so nothing changes.
    await db.update(signatureRequest).set({ evidenceOwed: true }).where(eq(signatureRequest.id, id));
    await runEvidenceJob();
    expect(await db.select().from(signedFormEvidence)).toHaveLength(1);
    expect((await db.select().from(signedFormFile).where(eq(signedFormFile.kind, "sealed_pdf")))[0]!.sha256).toBe(kept!.sha256);
    expect(await audits("forms.evidence.mismatch")).toEqual([]);
    expect((await evidenceHealth()).mismatches).toBe(0);

    stub.alterSealed.add(envelopeId);
    await db.update(signatureRequest).set({ evidenceOwed: true }).where(eq(signatureRequest.id, id));
    expect((await runEvidenceJob()).mismatches).toBe(1);
    const files = await db.select().from(signedFormFile).where(eq(signedFormFile.kind, "sealed_pdf"));
    expect(files).toHaveLength(1);
    expect(files[0]!.sha256).toBe(kept!.sha256);
    expect(Buffer.compare(files[0]!.bytes, kept!.bytes)).toBe(0);
    const [mismatch] = await audits("forms.evidence.mismatch");
    expect(mismatch!.after).toMatchObject({ requestId: id, keptFirst: true, differs: [{ kind: "sealed_pdf", kept: kept!.sha256, fetched: hash(stub.sealedBytes(envelopeId)) }] });
    expect((await requestNow(id)).evidenceOwed).toBe(false);
    expect(await evidenceHealth()).toMatchObject({ mismatches: 1 });
    const line = (await healthReport()).find((l) => l.key === "forms")!;
    expect(line.state).toBe("attention");
    expect(line.notes.join(" ")).toContain("came back from Documenso with a different file than the one kept");
  });

  it("says on the Health page how many complete forms wait for their evidence, warning after an hour", async () => {
    const { id } = await signedForA();
    stub.drop = true;
    await runEvidenceJob();
    expect(await evidenceHealth()).toMatchObject({ waiting: 1, late: 0 });
    let line = (await healthReport()).find((l) => l.key === "forms")!;
    expect(line.notes.join(" ")).toContain("Evidence waiting: 1 signed form hasn't had the signed copy and its record kept yet.");
    await db.update(signatureRequest).set({ completedAt: new Date(Date.now() - 61 * 60_000) }).where(eq(signatureRequest.id, id));
    expect(await evidenceHealth()).toMatchObject({ waiting: 1, late: 1 });
    line = (await healthReport()).find((l) => l.key === "forms")!;
    expect(line.state).toBe("attention");
    expect(line.notes.join(" ")).toContain("waited more than an hour");
  });
});

describe("evidence the portal can't keep for want of its own records", () => {
  it("asks Documenso nothing for a form whose family has no link in the roster's company, records no_link, and says so on the Health page as the roster's to mend", async () => {
    const { id } = await signedForA();
    // Family A's link in the roster's company is gone (its record stays): the evidence couldn't keep whose form it is.
    await db.delete(accountingLink).where(eq(accountingLink.familyId, await familyRecord(FAMILY_A.family.qboId)));
    stub.calls.length = 0;
    expect(await runEvidenceJob()).toMatchObject({ fetched: 1, stored: 0, failed: 1 });
    expect(stub.apiCalls()).toEqual([]);
    expect(await requestNow(id)).toMatchObject({ evidenceOwed: true, evidenceError: "no_link", evidenceTries: 1 });
    expect(await db.select().from(signedFormEvidence)).toEqual([]);
    expect(await evidenceHealth()).toMatchObject({ waiting: 1, noLink: 1 });
    const line = (await healthReport()).find((l) => l.key === "forms")!;
    expect(line).toMatchObject({ state: "attention", says: expect.stringContaining("can't be filed until the portal can find their families in the roster's QuickBooks company"),
      fix: { href: "/staff/settings/quickbooks", label: "Open QuickBooks settings" } });
    expect(line.notes.join(" ")).toContain("1 signed form can't be filed");
    expect(line.notes.join(" ")).toContain("After the roster is read again it tries again on its own schedule");
    expect(line.notes.join(" ")).not.toContain("Check that Documenso answers");
  });

  it("keeps nothing of a form that moved to another family while its files were fetched, and records moved_while_fetched", async () => {
    const { id } = await signedForA();
    const fetchedFor = await requestNow(id);
    // While the worker fetched it, the student moved: the request is another family's now.
    await db.update(signatureRequest).set({ familyId: await familyRecord(FAMILY_B.family.qboId) }).where(eq(signatureRequest.id, id));
    await expect(storeEvidence(fetchedFor, { files: [], originals: [], completedAt: null })).rejects.toMatchObject({ code: "moved_while_fetched" });
    expect(await db.select().from(signedFormEvidence)).toEqual([]);
    expect(await requestNow(id)).toMatchObject({ evidenceOwed: true });
    // The next wake reads it as it stands now and keeps it, under the family it is now.
    expect(await runEvidenceJob()).toMatchObject({ stored: 1, failed: 0 });
    expect((await db.select().from(signedFormEvidence))[0]).toMatchObject({ requestId: id, familyId: await familyRecord(FAMILY_B.family.qboId), familyQboId: FAMILY_B.family.qboId });
  });
});

describe("the guardians' copies", () => {
  it("emails each guardian who signed it, once, with the sealed PDF attached when it is under 3 MB", async () => {
    const { id, envelopeId } = await signedForA();
    await runEvidenceJob();
    expect(mail.outbox).toHaveLength(1);
    const [m] = mail.outbox;
    expect(m!.to).toBe(FAMILY_A.parent.email);
    expect(m!.subject).toBe("Signed: Medical release");
    expect(m!.text).toContain(`Medical release for ${FAMILY_A.students[0]!.name}`);
    expect(m!.attachments).toHaveLength(1);
    expect(m!.attachments![0]).toMatchObject({ filename: "signed-form.pdf", contentType: "application/pdf" });
    expect(Buffer.compare(m!.attachments![0]!.content as Buffer, stub.sealedBytes(envelopeId))).toBe(0);
    expect((await audits("forms.copy.sent"))[0]!.after).toEqual({ parentId: a.identity.parentId, requestId: id, how: "attached" });
    expect(JSON.stringify(await audits("forms.copy.sent"))).not.toContain(FAMILY_A.parent.email);
    // Once only: another wake, or the evidence fetched again, sends nothing more.
    await db.update(signedFormEvidence).set({ copiesDoneAt: null });
    await runEvidenceJob();
    expect(mail.outbox).toHaveLength(1);
    expect(await db.select().from(signedFormCopy)).toHaveLength(1);
  });

  it("sends a link to the signed-in download in place of a PDF of 3 MB or more, and to the form's page for a document of several items", async () => {
    stub.sealedSize = 3_000_001;
    const big = await signedForA();
    await runEvidenceJob();
    expect(mail.outbox[0]!.attachments).toBeUndefined();
    expect(mail.outbox[0]!.text).toContain(`/forms/${big.id}/signed`);
    expect((await audits("forms.copy.sent"))[0]!.after).toMatchObject({ how: "link" });
    stub.sealedSize = 2048;
    mail.outbox.length = 0;
    const several = await signedInStub(stub, { requirementId, templateId, familyQboId: FAMILY_A.family.qboId, subjectQboId: FAMILY_A.students[1]!.qboId, guardians: [guardianOf(a)], items: 2 });
    await runEvidenceJob();
    expect(mail.outbox[0]!.attachments).toBeUndefined();
    // Several parts: the link is the form's own page, which offers each part, not the download of the first alone.
    expect(mail.outbox[0]!.text).toContain(`The signed form has 2 parts. You can download each of them here, after signing in: http://localhost:3000/forms/${several.id}
`);
    expect(mail.outbox[0]!.text).not.toContain(`/forms/${several.id}/signed`);
  });

  it("goes only to the guardians recorded as signers: nobody else, nobody blocked, nobody whose link is closed", async () => {
    // B's guardian is linked to A's family too, but didn't sign: nothing goes to them.
    await db.insert(guardian).values({ parentId: b.identity.parentId, familyQboId: FAMILY_A.family.qboId, status: "active" });
    await signedForA();
    await db.update(parent).set({ blocked: true }).where(eq(parent.id, a.identity.parentId));
    await runEvidenceJob();
    expect(mail.outbox).toEqual([]);
    expect((await audits("forms.copy.skipped"))[0]!.after).toMatchObject({ parentId: a.identity.parentId, reason: "no_open_link" });

    await db.update(parent).set({ blocked: false }).where(eq(parent.id, a.identity.parentId));
    await db.update(guardian).set({ status: "disabled" }).where(eq(guardian.parentId, a.identity.parentId));
    await signedInStub(stub, { requirementId, templateId, familyQboId: FAMILY_A.family.qboId, subjectQboId: FAMILY_A.students[1]!.qboId, guardians: [guardianOf(a)] });
    await runEvidenceJob();
    expect(mail.outbox).toEqual([]);
    expect(await audits("forms.copy.skipped")).toHaveLength(2);
  });

  it("reaches a guardian whose student moved to another family before the evidence was kept, by their link to the family they signed in", async () => {
    const { id, envelopeId } = await signedForA();
    await db.transaction((tx) => formsForMovedStudent(tx, { studentQboId: FAMILY_A.students[0]!.qboId, fromFamilyQboId: FAMILY_A.family.qboId, toFamilyQboId: FAMILY_B.family.qboId }));
    await runEvidenceJob();
    // Kept after the move: it names the family the request is under now, by its record and, as its own copy, its customer.
    expect((await db.select().from(signedFormEvidence))[0]).toMatchObject({ familyId: await familyRecord(FAMILY_B.family.qboId), familyQboId: FAMILY_B.family.qboId });
    expect(mail.outbox.map((m) => m.to)).toEqual([FAMILY_A.parent.email]);
    expect(Buffer.compare(mail.outbox[0]!.attachments![0]!.content as Buffer, stub.sealedBytes(envelopeId))).toBe(0);
    expect((await audits("forms.copy.sent"))[0]!.after).toEqual({ parentId: a.identity.parentId, requestId: id, how: "attached" });
  });

  it("waits while outgoing mail isn't set up, and records a failed send without trying it again", async () => {
    await db.delete(setting).where(inArray(setting.key, ["mail", "mail.status"]));
    await signedForA();
    await runEvidenceJob();
    expect(mail.outbox).toEqual([]);
    expect(await db.select().from(signedFormCopy)).toEqual([]);
    expect((await db.select().from(signedFormEvidence))[0]!.copiesDoneAt).toBeNull();
    await seedWorkingMail();
    mail.fail = true;
    await runEvidenceJob();
    expect((await db.select().from(signedFormCopy))[0]).toMatchObject({ outcome: "failed" });
    expect(await audits("forms.copy.failed")).toHaveLength(1);
    mail.fail = false;
    await db.update(signedFormEvidence).set({ copiesDoneAt: null });
    await runEvidenceJob();
    expect(mail.outbox).toEqual([]);
  });
});
