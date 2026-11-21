import { describe, it, expect, beforeEach, vi } from "vitest";
import { asParent, asParentChoosing, asRefusedParent, asStaff, redirectOf, renderPage, signedOut } from "../helpers/signed-in";

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, guardian, parentAuthSession, role, roleAssignment, roleRule, signatureRequest, signedFormEvidence } from "@/lib/db/schema";
import { GET as parentDownload } from "@/app/(parent)/forms/[id]/signed/route";
import { GET as staffDownload } from "@/app/staff/(app)/forms/evidence/[id]/[file]/route";
import FormsPage from "@/app/(parent)/forms/page";
import FormPage from "@/app/(parent)/forms/[id]/page";
import { findMySignedPdf, mySignedDownloads } from "@/lib/forms/my-evidence";
import { resetDb, seedStaff } from "../helpers/db";
import { identityNow, seedTwoFamilies, type SeededParent } from "../helpers/parent";
import { familyRecord, studentRecord } from "../helpers/volunteer";

/**
 * The downloads of a signed form. A parent's (src/app/(parent)/forms/[id]/signed/route.ts): the session first, then
 * the request looked up within the session's family, and the same 404 with no bytes for anything else. Staff's
 * (src/app/staff/(app)/forms/evidence/[id]/[file]/route.ts): the session and Forms.Signature.Read first, the read
 * audited before a byte is sent. Both no-store, both with a fixed file name.
 */
vi.setConfig({ testTimeout: 30_000 });
type Staff = Awaited<ReturnType<typeof seedStaff>>;
const NOBODY = "5b0e7f0a-3c1d-4a52-9f0e-3a1b2c3d4e5f";
const withRole = async (email: string, patterns: string[]): Promise<Staff> => {
  const s = await seedStaff({ email, name: email });
  const [r] = await db.insert(role).values({ key: email, name: email }).returning();
  await db.insert(roleRule).values(patterns.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  return s;
};
const audits = async (action?: string) => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((r) => !action || r.action === action);
const askParent = (id: string, query = "") => parentDownload(new Request(`http://localhost/forms/${id}/signed${query}`), { params: Promise.resolve({ id }) });
const askStaff = (id: string, file: string) => staffDownload(new Request(`http://localhost/staff/forms/evidence/${id}/${file}`, { headers: { "cf-connecting-ip": "198.51.100.7" } }), { params: Promise.resolve({ id, file }) });

let a: SeededParent, b: SeededParent;
beforeEach(async () => {
  await resetDb();
  ({ a, b } = await seedTwoFamilies());
});

describe("a parent downloads their own family's signed form", () => {
  it("sends the sealed PDF, no-store, as application/pdf with a fixed file name", async () => {
    asParent(a.identity);
    const res = await askParent(a.forms!.ids.complete);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="signed-form.pdf"');
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), a.forms!.evidence.sealed)).toBe(0);
    // A parent viewing their own family is not audited.
    expect(await audits()).toEqual([]);
  });

  it("answers another family's id, an unknown id, a non-uuid, an unsigned form and one with no kept evidence with the same 404 and no bytes", async () => {
    asParent(a.identity);
    const [extra] = await db.insert(signatureRequest).values({ requirementId: (await db.select().from(signatureRequest).where(eq(signatureRequest.id, a.forms!.ids.complete)))[0]!.requirementId,
      familyId: await familyRecord(a.spec.family.qboId), studentId: await studentRecord("QBO-ALDERQUIST-EXTRA"), state: "complete", envelopeId: "envelope_alderquistextra", evidenceOwed: true }).returning();
    const answers = [];
    // B's app family and student ids are uuids too: never a request of A's.
    const bRecords = [String(await familyRecord(b.spec.family.qboId)), ...(await Promise.all(b.spec.students.map(async (s) => String(await studentRecord(s.qboId)))))];
    for (const id of [b.forms!.ids.complete, ...bRecords, NOBODY, "not-a-uuid", "..%2F..%2Fstaff", a.forms!.ids.waiting, a.forms!.ids.signed, extra!.id]) {
      const res = await askParent(id);
      answers.push({ status: res.status, body: await res.text(), cache: res.headers.get("cache-control"), type: res.headers.get("content-type") });
    }
    expect(new Set(answers.map((x) => JSON.stringify(x))).size).toBe(1);
    expect(answers[0]).toEqual({ status: 404, body: "Not found", cache: "no-store", type: "text/plain; charset=utf-8" });
    // Another part of the family's own form that doesn't exist, or a part that isn't a number: the same.
    for (const q of ["?part=2", "?part=0", "?part=abc", "?part=1e3"]) expect((await askParent(a.forms!.ids.complete, q)).status).toBe(404);
    // And B's own download still works for B, and only for B.
    asParent(b.identity);
    expect(Buffer.compare(Buffer.from(await (await askParent(b.forms!.ids.complete)).arrayBuffer()), b.forms!.evidence.sealed)).toBe(0);
    expect((await askParent(a.forms!.ids.complete)).status).toBe(404);
  });

  it("finds evidence only by the family's own request and the company connected now", async () => {
    asParent(a.identity);
    const ctx = { ...a.identity, ip: null };
    expect(await findMySignedPdf(ctx, b.forms!.ids.complete)).toBeNull();
    expect([...(await mySignedDownloads(ctx, [a.forms!.ids.complete, b.forms!.ids.complete, NOBODY, "x"])).entries()]).toEqual([[a.forms!.ids.complete, 1]]);
    // The same row under another company is not this family's, whatever its QuickBooks id says.
    await db.update(signedFormEvidence).set({ realmId: "another-company" }).where(eq(signedFormEvidence.id, a.forms!.evidence.id));
    expect(await findMySignedPdf(ctx, a.forms!.ids.complete)).toBeNull();
    expect((await askParent(a.forms!.ids.complete)).status).toBe(404);
  });

  it("sends someone signed out to sign in and back, and someone refused where the pages send them, with no bytes", async () => {
    signedOut();
    expect(await redirectOf(askParent(a.forms!.ids.complete))).toBe(`/sign-in?next=${encodeURIComponent(`/forms/${a.forms!.ids.complete}/signed`)}`);
    asParentChoosing(a.identity);
    expect(await redirectOf(askParent(a.forms!.ids.complete))).toBe(`/choose-family?next=${encodeURIComponent(`/forms/${a.forms!.ids.complete}/signed`)}`);
    asRefusedParent();
    expect(await redirectOf(askParent(a.forms!.ids.complete))).toBe("/refused");
  });

  it("is offered on the Forms page and the signed form's page, for the family's own signed forms only", async () => {
    asParent(a.identity);
    const list = await renderPage(FormsPage);
    expect(list).toContain(`/forms/${a.forms!.ids.complete}/signed`);
    expect(list).not.toContain(b.forms!.ids.complete);
    expect(list.match(/\/signed"/g)).toHaveLength(1);
    const page = await renderPage(FormPage, { params: { id: a.forms!.ids.complete } });
    expect(page).toContain(`/forms/${a.forms!.ids.complete}/signed`);
    expect(page).toContain("Download the signed form");
    for (const m of b.markers) expect(page).not.toContain(m);
  });

  it("says a signed copy is coming only while it is being filed, and to ask the club for one it won't offer the family", async () => {
    asParent(a.identity);
    const id = a.forms!.ids.complete;
    // Signed by a guardian of another family, as a form that came with a moved student is: filed, never offered here.
    await db.update(signatureRequest).set({ signers: [{ parentId: NOBODY, recipientId: 1, name: "Someone else", email: "else@example.com", signedAt: "2026-11-10T12:00:00.000Z" }] })
      .where(eq(signatureRequest.id, id));
    const moved = await renderPage(FormPage, { params: { id } });
    expect(moved).not.toContain("Download the signed form");
    expect(moved).not.toContain("download it here soon");
    expect(moved).toContain("If you&#x27;d like one, just ask the club.");
    // Still being filed: the copy is on its way.
    await db.update(signatureRequest).set({ evidenceOwed: true }).where(eq(signatureRequest.id, id));
    expect(await renderPage(FormPage, { params: { id } })).toContain("download it here soon");
  });
});

describe("a signed form kept while the family had no QuickBooks link", () => {
  // Kept with no company and no copy, as the evidence job keeps it for a family with no link
  // (signed-forms-evidence.test.ts). In the first case the families are linked again since; in the second the
  // family still has no link at all, and its parent signs in to it by the app's own family the session stores.
  const keptWithNoLink = (evidenceId: string) => db.update(signedFormEvidence).set({ realmId: null, familyQboId: null, subjectQboId: null }).where(eq(signedFormEvidence.id, evidenceId));

  it("is the family's own to list and download, and nobody else's: another family's id is the same 404", async () => {
    await keptWithNoLink(a.forms!.evidence.id);
    await keptWithNoLink(b.forms!.evidence.id);
    asParent(a.identity);
    const ctx = { ...a.identity, ip: null };
    const res = await askParent(a.forms!.ids.complete);
    expect(res.status).toBe(200);
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), a.forms!.evidence.sealed)).toBe(0);
    expect([...(await mySignedDownloads(ctx, [a.forms!.ids.complete, b.forms!.ids.complete, NOBODY])).entries()]).toEqual([[a.forms!.ids.complete, 1]]);
    expect(await findMySignedPdf(ctx, b.forms!.ids.complete)).toBeNull();
    const answers = [];
    for (const id of [b.forms!.ids.complete, NOBODY]) {
      const r = await askParent(id);
      answers.push({ status: r.status, body: await r.text(), cache: r.headers.get("cache-control") });
    }
    expect(answers).toEqual([{ status: 404, body: "Not found", cache: "no-store" }, { status: 404, body: "Not found", cache: "no-store" }]);
    const list = await renderPage(FormsPage);
    expect(list).toContain(`/forms/${a.forms!.ids.complete}/signed`);
    expect(list).not.toContain(b.forms!.ids.complete);
    // B's own is B's alone.
    asParent(b.identity);
    expect(Buffer.compare(Buffer.from(await (await askParent(b.forms!.ids.complete)).arrayBuffer()), b.forms!.evidence.sealed)).toBe(0);
    expect((await askParent(a.forms!.ids.complete)).status).toBe(404);
  });

  it("is listed and downloaded by a parent signed in to a family with no QuickBooks link at all, and another family's is the same 404", async () => {
    await keptWithNoLink(a.forms!.evidence.id);
    // A's family loses its link, removed by hand, and the records are not brought into step after: the family record
    // stays active with no link, as a family the app owns may be. Its students keep theirs; nothing here reads them.
    const familyA = a.identity.familyId;
    await db.delete(accountingLink).where(eq(accountingLink.familyId, familyA));
    expect(await db.select().from(accountingLink).where(eq(accountingLink.familyId, familyA))).toEqual([]);
    expect((await db.select({ active: family.active }).from(family).where(eq(family.id, familyA)))[0]).toEqual({ active: true });
    // The session names the family record, never a QuickBooks id (the session slice, migrations 0037 and 0038). The
    // guardian row's QuickBooks family is changed too, as a later slice drops that column: a gate that still matched a
    // session to a row by a QuickBooks family would find no row, so this half proves the session slice with the other two.
    expect((await db.select({ familyId: parentAuthSession.familyId }).from(parentAuthSession).where(eq(parentAuthSession.id, a.session.id)))[0])
      .toEqual({ familyId: familyA });
    await db.update(guardian).set({ familyQboId: "NO-CUSTOMER-A" }).where(eq(guardian.id, a.identity.guardianId));
    // The gate signs the parent in to it from the session, which names the family record: no link is asked for.
    const signedIn = await identityNow(a.session.id);
    expect(signedIn).toMatchObject({ familyId: familyA, guardianId: a.identity.guardianId });
    asParent(signedIn);
    const list = await renderPage(FormsPage);
    expect(list).toContain(`/forms/${a.forms!.ids.complete}/signed`);
    expect(list.match(/\/signed"/g)).toHaveLength(1);
    for (const m of [b.forms!.ids.complete, ...b.markers]) expect(list).not.toContain(m);
    const res = await askParent(a.forms!.ids.complete);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), a.forms!.evidence.sealed)).toBe(0);
    // Another family's signed form, an unknown id and B's family record answer the same 404, with no bytes.
    const answers = [];
    for (const id of [b.forms!.ids.complete, NOBODY, String(b.identity.familyId)]) {
      const r = await askParent(id);
      answers.push({ status: r.status, body: await r.text(), cache: r.headers.get("cache-control") });
    }
    expect(answers).toEqual(Array.from({ length: 3 }, () => ({ status: 404, body: "Not found", cache: "no-store" })));
    expect(await findMySignedPdf({ ...signedIn, ip: null }, b.forms!.ids.complete)).toBeNull();
  });
});

describe("staff download a signed form's evidence", () => {
  it("checks the session and Forms.Signature.Read first, then audits the read before sending the bytes", async () => {
    const reader = await withRole("reader@club.org", ["Forms.Signature.Read"]);
    asStaff(reader);
    const res = await askStaff(a.forms!.evidence.id, "sealed-pdf-1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="signed-form.pdf"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), a.forms!.evidence.sealed)).toBe(0);
    const [row] = await audits("forms.evidence.download");
    expect(row).toMatchObject({ actorId: reader.id, permission: "Forms.Signature.Read", targetId: a.forms!.evidence.id, ip: "198.51.100.7" });
    expect(row!.after).toMatchObject({ file: "sealed_pdf", filename: "signed-form.pdf", sha256: a.forms!.evidence.sealedSha256 });
    for (const [key, name, type] of [["certificate-pdf", "certificate.pdf", "application/pdf"], ["audit-log-pdf", "audit-log.pdf", "application/pdf"],
      ["audit-log-json", "audit-log.json", "application/json; charset=utf-8"], ["evidence-record-json", "evidence-record.json", "application/json; charset=utf-8"]] as const) {
      const r = await askStaff(a.forms!.evidence.id, key);
      expect([r.status, r.headers.get("content-disposition"), r.headers.get("content-type")]).toEqual([200, `attachment; filename="${name}"`, type]);
    }
    const record = JSON.parse(await (await askStaff(a.forms!.evidence.id, "evidence-record-json")).text());
    expect(record).toMatchObject({ evidenceId: a.forms!.evidence.id, requestId: a.forms!.ids.complete, archivedAsEarlierCompany: false, form: "Uniform agreement" });
    expect(record.files.find((f: { kind: string }) => f.kind === "sealed_pdf").sha256).toBe(a.forms!.evidence.sealedSha256);
    expect(await audits("forms.evidence.download")).toHaveLength(6);
  });

  it("refuses staff without the permission, and a parent's session, with no bytes; an unknown file is a 404", async () => {
    const outsider = await withRole("outsider@club.org", ["Roster.*", "Season.*", "Volunteer.*"]);
    asStaff(outsider);
    const refused = await askStaff(a.forms!.evidence.id, "sealed-pdf-1");
    expect(refused.status).toBe(307);
    expect(new URL(refused.headers.get("location")!).pathname).toBe("/refused");
    expect(await refused.text()).toBe("");
    expect((await audits("access.refused"))[0]).toMatchObject({ actorId: outsider.id, permission: "Forms.Signature.Read" });
    expect(await audits("forms.evidence.download")).toEqual([]);
    signedOut();
    asParent(a.identity);
    const parentTry = await askStaff(a.forms!.evidence.id, "sealed-pdf-1");
    expect(new URL(parentTry.headers.get("location")!).pathname).toBe("/staff/sign-in");
    const reader = await withRole("reader@club.org", ["Forms.Signature.Read"]);
    asStaff(reader);
    for (const [id, key] of [[a.forms!.evidence.id, "nope"], [a.forms!.evidence.id, "sealed-pdf-2"], [NOBODY, "sealed-pdf-1"], ["not-a-uuid", "sealed-pdf-1"]]) {
      expect((await askStaff(id!, key!)).status).toBe(404);
    }
    expect(await audits("forms.evidence.download")).toEqual([]);
  });
});
