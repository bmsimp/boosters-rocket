import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, parent, qboCustomer, setting, signatureConsent, signatureRequest } from "@/lib/db/schema";
import type { ParentCtx } from "@/lib/guards";
import { loadMyFamily } from "@/lib/parents/my-family";
import { RATE_LIMITS } from "@/lib/parents/rate-limit";
import { loadMySeason } from "@/lib/seasons/my-season";
import { CONSENT_VERSION } from "@/lib/forms/consent";
import { findMyForm, loadMyForms } from "@/lib/forms/my-forms";
import { agreeToSign, checkMyForm, openMyForm, startMyFormAgain, type FormView } from "@/lib/forms/signing";
import { checkOpenForms } from "@/lib/forms/job";
import { getFormsStatus } from "@/lib/forms/settings";
import { hearWebhook } from "@/lib/forms/webhook";
import { resetDb } from "../helpers/db";
import { startDocumensoStub, type DocumensoStub, type StubEnvelope } from "../helpers/documenso-stub";
import { connectForms, formSetting, requestNow, seedConsent, seedFormRequirement } from "../helpers/forms";
import { FAMILY_A, FAMILY_B, seedParentIn, seedSignedInParent, type SeededParent } from "../helpers/parent";
import { seedSeason } from "../helpers/season";
import { subjectColumns } from "../helpers/app-records";

/**
 * A guardian signs a form: the engine under the Forms pages (src/lib/forms/signing.ts), against a Documenso stub that
 * behaves as the verification found. The portal's real client makes every call.
 */
let stub: DocumensoStub;
beforeAll(async () => { stub = await startDocumensoStub(); });
afterAll(async () => { await stub.close(); });

const ctxOf = (identity: SeededParent["identity"], ip = "203.0.113.50"): ParentCtx => ({ ...identity, ip });
const audits = async (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
const tokenIn = (view: FormView): string => {
  if (view.step.kind !== "sign") throw new Error(`expected the signing frame, got "${view.step.kind}"`);
  return decodeURIComponent(/\/embed\/sign\/([^#]+)#/.exec(view.step.frameUrl)![1]!);
};

type Scene = { a: SeededParent; ctx: ParentCtx; template: StubEnvelope; requirementId: string; stepId: string };
/** Family A signed in, a current season with one step, and one form requirement made from a template in the stub. */
async function scene(o: { appliesTo?: "family" | "student"; signers?: "any" | "every"; roles?: 1 | 2; connect?: boolean } = {}): Promise<Scene> {
  const a = await seedSignedInParent(FAMILY_A);
  const season = await seedSeason({ name: "Fall", steps: [{ name: "Forms" }] });
  const template = stub.addTemplate({ signers: o.roles ?? 2, subjectLabel: (o.appliesTo ?? "student") === "student" ? "Student name" : "Family name" });
  const requirementId = await seedFormRequirement({ stepId: season.stepIds.Forms!, title: "Medical release", appliesTo: o.appliesTo ?? "student", required: true,
    form: formSetting({ id: template.id, updatedAt: template.updatedAt }, { signers: o.signers ?? "any", signerRoles: o.roles ?? 2 }) });
  if (o.connect !== false) await connectForms(stub);
  return { a, ctx: ctxOf(a.identity), template, requirementId, stepId: season.stepIds.Forms! };
}
/** The id of the family's request for a student (by default the first) or the family itself, made as the Forms page makes it. */
async function requestIdFor(ctx: ParentCtx, subjectQboId: string): Promise<string> {
  const family = (await loadMyFamily(ctx))!;
  const forms = (await loadMyForms(ctx, family))!;
  return forms.groups.find((g) => g.subjectQboId === subjectQboId)!.forms[0]!.requestId!;
}
const open = async (ctx: ParentCtx, id: string) => openMyForm(ctx, (await findMyForm(ctx, id))!);
/** Agrees, then opens: what the page does once the guardian presses the button. */
async function agreeAndOpen(ctx: ParentCtx, id: string): Promise<FormView> {
  expect((await agreeToSign(ctx, id, "Mozilla/5.0 (test)")).ok).toBe(true);
  return open(ctx, id);
}
/** A second guardian with a sign-in for family A. */
const secondGuardian = async () => ctxOf((await seedParentIn({ familyQboId: FAMILY_A.family.qboId, name: "Astrid Alderquist", email: "astrid.alderquist@family-a.example" })).identity, "198.51.100.7");

describe("signing a form", () => {
  beforeEach(async () => { await resetDb(); stub.reset(); });

  it("makes nothing and asks Documenso nothing until the guardian has agreed to sign electronically", async () => {
    const { ctx } = await scene();
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    const view = await open(ctx, id);
    expect(view.step).toEqual({ kind: "consent" });
    expect(view.words).toBe("Not signed yet");
    expect(stub.calls).toEqual([]);
    expect((await requestNow(id)).envelopeId).toBeNull();

    expect(await agreeToSign(ctx, id, "Mozilla/5.0 (test)")).toEqual({ ok: true, message: "Thank you. The form is next." });
    expect(stub.calls).toEqual([]); // agreeing makes nothing either: the next open does
    const consents = await db.select().from(signatureConsent);
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({ requestId: id, parentId: ctx.parentId, parentName: FAMILY_A.parent.name, parentEmail: FAMILY_A.parent.email, textVersion: CONSENT_VERSION, ip: "203.0.113.50", userAgent: "Mozilla/5.0 (test)" });
    expect(consents[0]!.agreedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    const [audit] = await audits("form.consent.agree");
    expect(audit).toMatchObject({ door: "parent", actorId: ctx.parentId, targetType: "signature_request", targetId: id, ip: "203.0.113.50" });
    // Pressing twice records it once.
    await agreeToSign(ctx, id, null);
    expect(await db.select().from(signatureConsent)).toHaveLength(1);
    expect(await audits("form.consent.agree")).toHaveLength(1);
  });

  it("makes the document on the first open after consent, for one guardian of a two-signer template, by the verified recipe", async () => {
    const { ctx, template } = await scene({ signers: "any", roles: 2 });
    await db.insert(setting).values({ key: "club", value: { name: "Stub Boosters", shortName: "SB", color: "#5b2a86", treasurerEmail: null, timeZone: "America/Chicago" } });
    const student = FAMILY_A.students[0]!;
    const id = await requestIdFor(ctx, student.qboId);
    const view = await agreeAndOpen(ctx, id);

    // Template read, leftovers looked for, then: use without sending, delete the unused signer, send.
    expect(stub.apiCalls().map((c) => `${c.method} ${c.path.slice("/api/v2".length)}`)).toEqual([
      `GET /envelope/${template.id}`, "GET /envelope", "POST /envelope/use", "POST /envelope/recipient/delete", "POST /envelope/distribute", expect.stringMatching(/^GET \/envelope\/envelope_/)]);
    const used = stub.apiCalls("/envelope/use")[0]!.body as Record<string, unknown>;
    expect(used).toMatchObject({ envelopeId: template.id, externalId: id, distributeDocument: false });
    expect(used.recipients).toEqual([{ id: template.recipients[0]!.id, email: FAMILY_A.parent.email, name: FAMILY_A.parent.name }]);

    const document = stub.documentFor(id)!;
    expect(document.status).toBe("PENDING");
    // The second signer of the template is gone, and its fields with it: the document can complete with one signature.
    expect(document.recipients.map((r) => r.email)).toEqual([FAMILY_A.parent.email]);
    expect(document.fields.every((f) => f.recipientId === document.recipients[0]!.id)).toBe(true);
    // Names filled in.
    const text = (label: string) => document.fields.find((f) => f.fieldMeta?.label === label)?.customText;
    expect(text("Student name")).toBe(student.name);
    expect(text("Guardian 1 name")).toBe(FAMILY_A.parent.name);
    // Documenso's emails are off by BOTH settings, though the template had every one of them on.
    expect(template.documentMeta.distributionMethod).toBe("EMAIL");
    expect(document.documentMeta.distributionMethod).toBe("NONE");
    expect(Object.keys(document.documentMeta.emailSettings)).toHaveLength(9);
    expect(Object.values(document.documentMeta.emailSettings).every((on) => on === false)).toBe(true);
    // No expiry, the club's time zone, and a title that names the form and the student.
    expect(document.documentMeta.envelopeExpirationPeriod).toEqual({ disabled: true });
    expect(document.documentMeta.timezone).toBe("America/Chicago");
    expect(document.title).toBe(`Medical release - ${student.name}`);

    // The guardian's own token, in the address of the frame, on Documenso's own origin.
    expect(view.step.kind).toBe("sign");
    expect(tokenIn(view)).toBe(document.recipients[0]!.token);
    expect(view.step.kind === "sign" && view.step.frameUrl.startsWith(`${stub.origin}/embed/sign/`)).toBe(true);
    expect(view.step.kind === "sign" && view.step.origin).toBe(stub.origin);
    expect(view.signers).toEqual([{ name: FAMILY_A.parent.name, signed: false, you: true }]);

    // What the portal keeps: the document's id and who it was made for. Never the token.
    const row = await requestNow(id);
    expect(row).toMatchObject({ state: "waiting", envelopeId: document.id, templateId: template.id, signersMode: "any", subjectName: student.name, preparingAt: null, evidenceOwed: false });
    expect(row.templateUpdatedAt?.toISOString()).toBe(template.updatedAt);
    expect(row.signers).toEqual([{ parentId: ctx.parentId, recipientId: document.recipients[0]!.id, name: FAMILY_A.parent.name, email: FAMILY_A.parent.email, signedAt: null }]);
    const everythingStored = JSON.stringify([await db.select().from(signatureRequest), await db.select().from(auditLog), await db.select().from(setting)]);
    expect(everythingStored).not.toContain(document.recipients[0]!.token);
    const [made] = await audits("form.document.create");
    expect(made).toMatchObject({ door: "parent", actorId: ctx.parentId, targetId: id });
    expect(made!.after).toMatchObject({ envelopeId: document.id, templateId: template.id, signers: "any", subjectName: student.name });

    // A second open makes nothing new: it reads the document and hands the same token again.
    stub.calls.length = 0;
    expect(tokenIn(await open(ctx, id))).toBe(document.recipients[0]!.token);
    expect(stub.apiCalls().map((c) => c.method)).toEqual(["GET"]);
    expect(stub.documents()).toHaveLength(1);
  });

  it("makes one document for every guardian in one call, and gives each guardian their own token and nobody else's", async () => {
    const { ctx, template } = await scene({ signers: "every", roles: 2 });
    const other = await secondGuardian();
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    const mine = await agreeAndOpen(ctx, id);

    expect(stub.apiCalls("/envelope/use")).toHaveLength(1);
    expect(stub.apiCalls("/envelope/use")[0]!.body).toMatchObject({ distributeDocument: true });
    expect(stub.apiCalls("/envelope/recipient/delete")).toEqual([]);
    expect(stub.apiCalls("/envelope/distribute")).toEqual([]);
    const document = stub.documentFor(id)!;
    expect(document.recipients.map((r) => r.name).sort()).toEqual(["Ansgar Alderquist", "Astrid Alderquist"]);
    const tokenOf = (email: string) => document.recipients.find((r) => r.email === email)!.token;
    expect(tokenIn(mine)).toBe(tokenOf(FAMILY_A.parent.email));
    expect(mine.step.kind === "sign" && mine.step.frameUrl).not.toContain(tokenOf("astrid.alderquist@family-a.example"));
    expect(document.fields.find((f) => f.fieldMeta?.label === "Guardian 2 name")?.customText).toBe("Astrid Alderquist");

    // The other guardian has not agreed: no token for them yet, whatever the document says.
    expect((await open(other, id)).step).toEqual({ kind: "consent" });
    const theirs = await agreeAndOpen(other, id);
    expect(tokenIn(theirs)).toBe(tokenOf("astrid.alderquist@family-a.example"));
    expect(theirs.step.kind === "sign" && theirs.step.frameUrl).not.toContain(tokenOf(FAMILY_A.parent.email));
    expect(theirs.signers).toEqual([{ name: "Ansgar Alderquist", signed: false, you: false }, { name: "Astrid Alderquist", signed: false, you: true }]);
    expect(stub.documents()).toHaveLength(1); // the same document: nothing was made again
    expect(template.recipients).toHaveLength(2);

    // One signs: the form waits for the other guardian, and the one who signed gets no token any more.
    stub.sign(document.id, FAMILY_A.parent.email);
    expect(await checkMyForm(ctx, id)).toEqual({ ok: true, message: "Waiting for the other guardian", state: "waiting" });
    const after = await open(ctx, id);
    expect(after.step).toEqual({ kind: "waiting", signedByYou: true });
    expect(JSON.stringify(after)).not.toContain(tokenOf(FAMILY_A.parent.email));
    expect(tokenIn(await open(other, id))).toBe(tokenOf("astrid.alderquist@family-a.example"));
    stub.sign(document.id, "astrid.alderquist@family-a.example");
    expect(await checkMyForm(other, id)).toEqual({ ok: true, message: "Signed", state: "complete" });
  });

  it("with one guardian who has a sign-in, a form for every guardian is made for that one, and the template's other signer is deleted", async () => {
    const { ctx } = await scene({ signers: "every", roles: 2 });
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    tokenIn(await agreeAndOpen(ctx, id));
    expect(stub.documentFor(id)!.recipients.map((r) => r.email)).toEqual([FAMILY_A.parent.email]);
    expect(stub.apiCalls("/envelope/recipient/delete")).toHaveLength(1);
  });

  it("fills in the family's name for a form asked once of each family", async () => {
    const { ctx } = await scene({ appliesTo: "family", roles: 1 });
    const id = await requestIdFor(ctx, FAMILY_A.family.qboId);
    tokenIn(await agreeAndOpen(ctx, id));
    const document = stub.documentFor(id)!;
    expect(document.fields.find((f) => f.fieldMeta?.label === "Family name")?.customText).toBe(FAMILY_A.family.name);
    expect(stub.apiCalls("/envelope/use")[0]!.body).toMatchObject({ distributeDocument: true }); // one signer, one guardian: every role is filled
    expect((await requestNow(id)).subjectQboId).toBe(FAMILY_A.family.qboId);
  });

  it("any one guardian: when the other guardian opens it while nobody has signed, it is withdrawn and made again for them", async () => {
    const { ctx } = await scene({ signers: "any", roles: 2 });
    const other = await secondGuardian();
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    tokenIn(await agreeAndOpen(ctx, id));
    const first = stub.documentFor(id)!;

    const theirs = await agreeAndOpen(other, id);
    const second = stub.documentFor(id)!;
    expect(second.id).not.toBe(first.id);
    expect(stub.envelopes.has(first.id)).toBe(false); // deleted in Documenso
    expect(second.recipients.map((r) => r.name)).toEqual(["Astrid Alderquist"]);
    expect(tokenIn(theirs)).toBe(second.recipients[0]!.token);
    expect((await requestNow(id)).signers.map((s) => s.parentId)).toEqual([other.parentId]);
    const [withdrawn] = await audits("form.document.withdraw");
    expect(withdrawn).toMatchObject({ door: "parent", actorId: other.parentId, targetId: id });
    expect(withdrawn!.before).toMatchObject({ envelopeId: first.id });

    // Once someone has signed it is left alone: the first guardian opens it and nothing is made again.
    stub.sealing = "held";
    stub.sign(second.id, "astrid.alderquist@family-a.example");
    const mine = await open(ctx, id);
    expect(mine.step).toEqual({ kind: "sealing" });
    expect(mine.words).toBe("Signed, being finished");
    expect(stub.documentFor(id)!.id).toBe(second.id);
    expect(stub.documents()).toHaveLength(1);
  });

  it("makes the document again when a name changed while nobody had signed, and leaves it alone once someone has", async () => {
    const { ctx } = await scene({ signers: "every", roles: 2 });
    const other = await secondGuardian();
    const student = FAMILY_A.students[0]!;
    const id = await requestIdFor(ctx, student.qboId);
    tokenIn(await agreeAndOpen(ctx, id));
    const first = stub.documentFor(id)!;

    // The student is renamed in QuickBooks, and a guardian's name is corrected.
    await db.update(qboCustomer).set({ displayName: "Aurelio Alderquist-Reyes" }).where(eq(qboCustomer.qboId, student.qboId));
    await db.update(parent).set({ name: "Astrid Alderquist-Reyes" }).where(eq(parent.id, other.parentId));
    tokenIn(await open(ctx, id));
    const second = stub.documentFor(id)!;
    expect(second.id).not.toBe(first.id);
    expect(stub.envelopes.has(first.id)).toBe(false);
    expect(second.fields.find((f) => f.fieldMeta?.label === "Student name")?.customText).toBe("Aurelio Alderquist-Reyes");
    expect(second.recipients.map((r) => r.name).sort()).toEqual(["Ansgar Alderquist", "Astrid Alderquist-Reyes"]);

    // One guardian signs; then the name changes again. The document stays: a signed name is not rewritten.
    stub.sign(second.id, FAMILY_A.parent.email);
    await db.update(qboCustomer).set({ displayName: "Aurelio A. Reyes" }).where(eq(qboCustomer.qboId, student.qboId));
    expect((await open(ctx, id)).step).toEqual({ kind: "waiting", signedByYou: true });
    await seedConsent(id, { parentId: other.parentId, name: "Astrid", email: other.email });
    expect(tokenIn(await open(other, id))).toBe(second.recipients.find((r) => r.email === other.email)!.token);
    expect(stub.documentFor(id)!.id).toBe(second.id);
    expect((await requestNow(id)).subjectName).toBe("Aurelio Alderquist-Reyes");
  });

  it("makes the document again when staff attached the template anew while nobody had signed", async () => {
    const { ctx, requirementId } = await scene({ signers: "any", roles: 1 });
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    tokenIn(await agreeAndOpen(ctx, id));
    const first = stub.documentFor(id)!;
    const replacement = stub.addTemplate({ signers: 1, title: "Medical release 2027" });
    const { requirement } = await import("@/lib/db/schema");
    await db.update(requirement).set({ form: formSetting({ id: replacement.id, updatedAt: replacement.updatedAt }, { signers: "any", signerRoles: 1 }) }).where(eq(requirement.id, requirementId));
    tokenIn(await open(ctx, id));
    expect(stub.documentFor(id)!.templateId).toBe(replacement.id);
    expect(stub.envelopes.has(first.id)).toBe(false);
  });

  it("is complete only when Documenso says COMPLETED: signed by everyone but not sealed is still not done", async () => {
    const { ctx } = await scene({ signers: "any", roles: 1 });
    const student = FAMILY_A.students[0]!;
    const id = await requestIdFor(ctx, student.qboId);
    tokenIn(await agreeAndOpen(ctx, id));
    const document = stub.documentFor(id)!;
    const line = async () => (await loadMySeason(ctx, (await loadMyFamily(ctx))!.students))!.steps[0]!.students.find((s) => s.qboId === student.qboId)!.lines[0]!;
    expect(await line()).toMatchObject({ state: "todo", words: "Not signed yet" });

    stub.sealing = "held";
    stub.sign(document.id, FAMILY_A.parent.email);
    expect(await checkMyForm(ctx, id)).toEqual({ ok: true, message: "Signed, being finished", state: "signed" });
    expect(await requestNow(id)).toMatchObject({ state: "signed", evidenceOwed: false, completedAt: null });
    expect((await requestNow(id)).allSignedAt).not.toBeNull();
    expect(await line()).toMatchObject({ state: "todo", words: "Signed, being finished" });
    expect((await open(ctx, id)).step).toEqual({ kind: "sealing" });

    stub.seal(document.id);
    expect(await checkMyForm(ctx, id)).toEqual({ ok: true, message: "Signed", state: "complete" });
    const row = await requestNow(id);
    // Complete, and its evidence (the sealed PDF and the audit record) is marked as still to be fetched.
    expect(row).toMatchObject({ state: "complete", envelopeStatus: "COMPLETED", evidenceOwed: true });
    expect(row.completedAt?.toISOString()).toBe(document.completedAt);
    expect(row.signers[0]!.signedAt).toBe(document.recipients[0]!.signedAt);
    expect(await line()).toMatchObject({ state: "done", words: "Signed" });
    const changes = await audits("form.state.change");
    expect(changes.map((c) => [(c.before as { state: string }).state, (c.after as { state: string }).state])).toEqual([["waiting", "signed"], ["signed", "complete"]]);
    expect(changes[1]).toMatchObject({ door: "parent", actorId: ctx.parentId, targetId: id });

    // Finished: opening it again asks Documenso nothing, and a later reading can't undo it.
    stub.calls.length = 0;
    expect((await open(ctx, id)).step).toEqual({ kind: "complete" });
    expect(await checkMyForm(ctx, id)).toEqual({ ok: true, message: "Signed", state: "complete" });
    expect(stub.calls).toEqual([]);
  });

  it("shows a declined form as declined, and starts it again with a new document", async () => {
    const { ctx } = await scene({ signers: "any", roles: 1 });
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    tokenIn(await agreeAndOpen(ctx, id));
    const first = stub.documentFor(id)!;
    stub.reject(first.id, FAMILY_A.parent.email);
    expect(await checkMyForm(ctx, id)).toEqual({ ok: true, message: "Declined", state: "declined" });
    // A rejected document has a completedAt too: it is not complete, and it owes no evidence.
    expect(await requestNow(id)).toMatchObject({ state: "declined", evidenceOwed: false, completedAt: null });
    expect((await requestNow(id)).declinedAt).not.toBeNull();
    const view = await open(ctx, id);
    expect(view.step).toEqual({ kind: "declined", canRestart: true });
    expect(JSON.stringify(view)).not.toContain(first.recipients[0]!.token);

    expect(await startMyFormAgain(ctx, id)).toEqual({ ok: true, message: "Started again. You can sign it now." });
    expect(await requestNow(id)).toMatchObject({ state: "not_opened", envelopeId: null, declinedAt: null });
    expect((await audits("form.document.restart"))[0]).toMatchObject({ door: "parent", actorId: ctx.parentId, targetId: id });
    const again = await open(ctx, id); // consent was already given for this form
    const second = stub.documents().at(-1)!;
    expect(second.id).not.toBe(first.id);
    expect(tokenIn(again)).toBe(second.recipients[0]!.token);
    expect(stub.envelopes.get(first.id)?.status).toBe("REJECTED"); // the declined document stays in Documenso as it was
    // Only a declined form can be started again.
    expect((await startMyFormAgain(ctx, id)).ok).toBe(false);
    expect((await requestNow(id)).envelopeId).toBe(second.id);
  });

  it("says the form can't be shown right now when Documenso can't be reached, and makes nothing", async () => {
    const { ctx } = await scene({ signers: "any", roles: 1 });
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    stub.drop = true;
    const view = await agreeAndOpen(ctx, id);
    expect(view.step).toEqual({ kind: "unavailable" });
    expect(await requestNow(id)).toMatchObject({ state: "not_opened", envelopeId: null, preparingAt: null });
    stub.drop = false;
    tokenIn(await open(ctx, id));
    // With a document out, an outage changes nothing that is stored.
    stub.drop = true;
    const before = await requestNow(id);
    expect((await open(ctx, id)).step).toEqual({ kind: "unavailable" });
    expect((await checkMyForm(ctx, id)).ok).toBe(false);
    expect(await requestNow(id)).toMatchObject({ state: before.state, envelopeId: before.envelopeId });
  });

  it("deletes a half-made document when a call in the middle of the recipe fails, and the next open starts clean", async () => {
    const { ctx } = await scene({ signers: "any", roles: 2 });
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    stub.failPathOnce = "/envelope/distribute";
    expect((await agreeAndOpen(ctx, id)).step).toEqual({ kind: "unavailable" });
    expect(stub.documents()).toEqual([]); // the draft was deleted again
    expect(await requestNow(id)).toMatchObject({ state: "not_opened", envelopeId: null, preparingAt: null });
    tokenIn(await open(ctx, id));
    expect(stub.documents()).toHaveLength(1);
  });

  it("clears away a draft an earlier crash left under the request's id, and leaves a document whose id only contains it", async () => {
    const { ctx, template } = await scene({ signers: "any", roles: 1 });
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    const leftover = (externalId: string): StubEnvelope => {
      const e: StubEnvelope = { ...structuredClone(template), id: `envelope_left${Math.random().toString(36).slice(2, 10)}`, type: "DOCUMENT", status: "DRAFT", externalId, templateId: template.id };
      stub.envelopes.set(e.id, e);
      return e;
    };
    const crashed = leftover(id), lookalike = leftover(`${id}-copy`), wildcard = leftover(id.replace(/-/g, "x"));
    tokenIn(await agreeAndOpen(ctx, id));
    expect(stub.envelopes.has(crashed.id)).toBe(false);
    // Documenso's search matches substrings, and "_" and "%" as wildcards: only the exact id is the portal's own.
    expect(stub.envelopes.has(lookalike.id)).toBe(true);
    expect(stub.envelopes.has(wildcard.id)).toBe(true);
    expect(stub.documentFor(id)!.status).toBe("PENDING");
  });

  it("makes one document when the form is opened twice at the same moment: the second open waits and reads the first's", async () => {
    const { ctx } = await scene({ signers: "any", roles: 2 });
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    await agreeToSign(ctx, id, null);
    stub.delayMs = 120; // each call to Documenso takes a moment, as a real one does
    const [first, second, third] = await Promise.all([open(ctx, id), open(ctx, id), open(ctx, id)]);
    expect(stub.documents()).toHaveLength(1);
    expect(stub.apiCalls("/envelope/use")).toHaveLength(1);
    const token = stub.documentFor(id)!.recipients[0]!.token;
    for (const view of [first, second, third]) expect(tokenIn(view)).toBe(token);
    expect((await requestNow(id)).preparingAt).toBeNull();
  });

  it("does not make a document from a template whose name fields are no longer read-only", async () => {
    const { ctx, template } = await scene({ signers: "any", roles: 1 });
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    template.fields.find((f) => f.fieldMeta?.label === "Student name")!.fieldMeta!.readOnly = false; // staff changed it in Documenso after attaching it
    const view = await agreeAndOpen(ctx, id);
    expect(view.step).toEqual({ kind: "not_ready" });
    expect(stub.apiCalls("/envelope/use")).toEqual([]);
    expect(stub.documents()).toEqual([]);
    expect(await requestNow(id)).toMatchObject({ state: "not_opened", envelopeId: null, preparingAt: null });
  });

  it("says the form isn't ready, and makes nothing, when the template's signers changed in Documenso since staff attached it", async () => {
    const { ctx, template } = await scene({ signers: "every", roles: 2 });
    await secondGuardian();
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    const second = template.recipients.pop()!; // staff deleted Signer 2 in Documenso's editor
    template.fields = template.fields.filter((f) => f.recipientId !== second.id);
    expect((await agreeAndOpen(ctx, id)).step).toEqual({ kind: "not_ready" });
    expect((await open(ctx, id)).step).toEqual({ kind: "not_ready" });
    expect(stub.apiCalls("/envelope/use")).toEqual([]);
    expect(await audits("form.document.withdraw")).toEqual([]);
  });

  it("hands out no token for a document that does not carry the request's own id, and treats it as gone", async () => {
    const { ctx } = await scene({ signers: "any", roles: 1 });
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    tokenIn(await agreeAndOpen(ctx, id));
    const document = stub.documentFor(id)!;
    document.externalId = "someone-elses-document";
    stub.sealing = "held";
    const view = await open(ctx, id); // the stored id no longer leads to this request's document: a new one is made
    expect(tokenIn(view)).not.toBe(document.recipients[0]!.token);
    expect(JSON.stringify(view)).not.toContain(document.recipients[0]!.token);
    expect(stub.envelopes.has(document.id)).toBe(true); // and the other one is not touched
  });

  it("says forms aren't ready, and asks for no consent, until forms are set up and the form has a template", async () => {
    const { ctx, requirementId } = await scene({ connect: false });
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    expect((await open(ctx, id)).step).toEqual({ kind: "not_ready" });
    expect((await agreeToSign(ctx, id, null)).ok).toBe(false);
    expect(await db.select().from(signatureConsent)).toEqual([]);
    const family = (await loadMyFamily(ctx))!;
    expect((await loadMyForms(ctx, family))!.ready).toBe(false);
    expect((await loadMySeason(ctx, family.students))!.steps[0]!.students[0]!.lines[0]).toMatchObject({ state: "todo", words: "Not ready yet" });

    await connectForms(stub);
    expect((await open(ctx, id)).step).toEqual({ kind: "consent" });
    const { requirement } = await import("@/lib/db/schema");
    await db.update(requirement).set({ form: null }).where(eq(requirement.id, requirementId)); // no template attached
    expect((await open(ctx, id)).step).toEqual({ kind: "not_ready" });
    expect((await loadMySeason(ctx, family.students))!.steps[0]!.students[0]!.lines[0]).toMatchObject({ words: "Not ready yet" });
    expect(stub.calls).toEqual([]);
  });

  it("counts opens and checks per person, and refuses calmly past the limit with one audit row", async () => {
    const { ctx } = await scene({ signers: "any", roles: 1 });
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    tokenIn(await agreeAndOpen(ctx, id));
    const { rateLimitEvent } = await import("@/lib/db/schema");
    const filler = Array.from({ length: RATE_LIMITS.form_open_parent.max - 1 }, () => ({ kind: "form_open_parent", subject: ctx.parentId, at: new Date() }));
    await db.insert(rateLimitEvent).values(filler);
    stub.calls.length = 0;
    expect((await open(ctx, id)).step).toEqual({ kind: "unavailable" });
    expect((await checkMyForm(ctx, id)).ok).toBe(false);
    expect(stub.calls).toEqual([]);
    expect(await audits("form.open.refused")).toHaveLength(1);
  });
});

describe("a form's document is never lost track of", () => {
  beforeEach(async () => { await resetDb(); stub.reset(); });
  const SECRET = "the-right-secret-0123456789abcdef";

  it("a webhook that arrives while the document is still being made leaves it alone: the open hands out the token", async () => {
    const { ctx } = await scene({ signers: "any", roles: 2, connect: false }); // two signers, one guardian: the three-call recipe
    await connectForms(stub, { webhookSecret: SECRET });
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    const heard: string[] = [];
    // Documenso's DOCUMENT_CREATED message comes after `use`, while the portal is still deleting the unused signer.
    stub.beforeAnswer = { path: "/envelope/recipient/delete", run: async () => { heard.push(await hearWebhook(SECRET, JSON.stringify({ event: "DOCUMENT_CREATED", payload: { externalId: id } }))); } };
    const view = await agreeAndOpen(ctx, id);
    expect(heard).toEqual(["not_read"]);
    const document = stub.documentFor(id)!;
    expect(tokenIn(view)).toBe(document.recipients[0]!.token);
    expect(await requestNow(id)).toMatchObject({ state: "waiting", envelopeId: document.id, preparingAt: null });
    expect(stub.documents().map((d) => d.status)).toEqual(["PENDING"]);
  });

  it("keeps a half-signed form when Documenso answers 'not found' for it, says so on the Health page, and carries on once it answers again", async () => {
    const { ctx } = await scene({ signers: "every", roles: 2 });
    const other = await secondGuardian();
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    tokenIn(await agreeAndOpen(ctx, id));
    expect((await agreeToSign(other, id, null)).ok).toBe(true);
    const document = stub.documentFor(id)!;
    stub.sign(document.id, FAMILY_A.parent.email);
    expect((await checkMyForm(ctx, id)).state).toBe("waiting");
    const before = await requestNow(id);

    // A wrong address or a token of another team: every document answers 404.
    stub.envelopes.delete(document.id);
    const later = new Date(Date.now() + 10 * 60_000);
    expect(await checkOpenForms(later)).toMatchObject({ asked: 1, failed: 1 });
    expect((await open(other, id)).step).toEqual({ kind: "unavailable" });
    expect(await requestNow(id)).toMatchObject({ state: "waiting", envelopeId: document.id, signers: before.signers });
    expect((await getFormsStatus()).lastApiError).toBe("not_found");
    expect(await audits("form.state.change")).toEqual([]);

    // Put right: the other guardian signs the same document, and the worker still asks about it.
    stub.envelopes.set(document.id, document);
    expect(tokenIn(await open(other, id))).toBe(document.recipients.find((r) => r.email === "astrid.alderquist@family-a.example")!.token);
    stub.sign(document.id, "astrid.alderquist@family-a.example");
    expect(await checkOpenForms(new Date(Date.now() + 20 * 60_000))).toMatchObject({ completed: 1 });
    expect((await requestNow(id)).state).toBe("complete");
  });

  it("keeps a form every guardian signed that is still being sealed when Documenso answers 'not found' for it", async () => {
    const { ctx } = await scene({ signers: "any", roles: 1 });
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    tokenIn(await agreeAndOpen(ctx, id));
    stub.sealing = "held";
    const document = stub.documentFor(id)!;
    stub.sign(document.id, FAMILY_A.parent.email);
    expect((await checkMyForm(ctx, id)).state).toBe("signed");
    stub.envelopes.delete(document.id);
    expect((await checkMyForm(ctx, id)).ok).toBe(false);
    expect(await requestNow(id)).toMatchObject({ state: "signed", envelopeId: document.id });
  });

  it("takes up again a signed document the request lost track of, instead of refusing every open", async () => {
    const { ctx } = await scene({ signers: "every", roles: 2 });
    const other = await secondGuardian();
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    tokenIn(await agreeAndOpen(ctx, id));
    expect((await agreeToSign(other, id, null)).ok).toBe(true);
    const document = stub.documentFor(id)!;
    stub.sign(document.id, FAMILY_A.parent.email);
    // What an earlier version did on a 404: the request was set back to not opened, the document still out.
    await db.update(signatureRequest).set({ state: "not_opened", envelopeId: null, envelopeStatus: null, signers: [] }).where(eq(signatureRequest.id, id));

    const theirs = await open(other, id);
    expect(tokenIn(theirs)).toBe(document.recipients.find((r) => r.email === "astrid.alderquist@family-a.example")!.token);
    expect(stub.documents()).toHaveLength(1); // nothing new was made, nothing deleted
    const row = await requestNow(id);
    expect(row).toMatchObject({ state: "waiting", envelopeId: document.id });
    expect(row.signers.map((s) => [s.parentId, s.signedAt !== null])).toEqual([[ctx.parentId, true], [other.parentId, false]]);
    expect(theirs.words).toBe("Not signed yet"); // to the guardian who still has to sign it
    const [recovered] = await audits("form.document.recover");
    expect(recovered).toMatchObject({ door: "parent", actorId: other.parentId, targetId: id });

    stub.sign(document.id, "astrid.alderquist@family-a.example");
    expect((await checkMyForm(other, id)).state).toBe("complete");
  });

  it("takes up a completed document the request lost track of, and the form reads signed", async () => {
    const { ctx } = await scene({ signers: "any", roles: 1 });
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    tokenIn(await agreeAndOpen(ctx, id));
    const document = stub.documentFor(id)!;
    stub.sign(document.id, FAMILY_A.parent.email);
    await db.update(signatureRequest).set({ state: "not_opened", envelopeId: null, envelopeStatus: null, signers: [] }).where(eq(signatureRequest.id, id));
    expect((await open(ctx, id)).step).toEqual({ kind: "complete" });
    expect(await requestNow(id)).toMatchObject({ state: "complete", envelopeId: document.id, evidenceOwed: true });
    expect(stub.documents()).toHaveLength(1);
  });
});

describe("what each guardian reads", () => {
  beforeEach(async () => { await resetDb(); stub.reset(); });

  it("a guardian who still has to sign reads 'Not signed yet' and a Sign button, while the one who signed reads that it waits for the other", async () => {
    const { ctx } = await scene({ signers: "every", roles: 2 });
    const other = await secondGuardian();
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    tokenIn(await agreeAndOpen(ctx, id));
    stub.sign(stub.documentFor(id)!.id, FAMILY_A.parent.email);
    expect(await checkMyForm(ctx, id)).toMatchObject({ message: "Waiting for the other guardian" });
    const lineFor = async (who: ParentCtx) => (await loadMyForms(who, (await loadMyFamily(who))!))!.groups.find((g) => g.subjectQboId === FAMILY_A.students[0]!.qboId)!.forms[0]!.line;
    expect((await lineFor(ctx)).words).toBe("Waiting for the other guardian");
    expect((await lineFor(other)).words).toBe("Not signed yet");
    const family = (await loadMyFamily(other))!;
    expect((await loadMySeason(other, family.students))!.steps[0]!.students[0]!.lines[0]!.words).toBe("Not signed yet");
    const theirs = await agreeAndOpen(other, id);
    expect(theirs.words).toBe("Not signed yet");
    tokenIn(theirs);
  });

  it("audits each time a guardian is given their signing frame, and each signature as the portal first reads it, with the guardian it belongs to", async () => {
    const { ctx } = await scene({ signers: "every", roles: 2 });
    const other = await secondGuardian();
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    tokenIn(await agreeAndOpen(ctx, id));
    const document = stub.documentFor(id)!;
    const recipientOf = (email: string) => document.recipients.find((r) => r.email === email)!.id;
    tokenIn(await agreeAndOpen(other, id));
    tokenIn(await open(other, id)); // a second open is a second hand-out
    const opens = await audits("form.sign.open");
    expect(opens.map((r) => [r.actorId, r.ip, (r.after as { recipientId: number }).recipientId])).toEqual([
      [ctx.parentId, "203.0.113.50", recipientOf(FAMILY_A.parent.email)],
      [other.parentId, "198.51.100.7", recipientOf("astrid.alderquist@family-a.example")],
      [other.parentId, "198.51.100.7", recipientOf("astrid.alderquist@family-a.example")],
    ]);
    stub.sign(document.id, "astrid.alderquist@family-a.example");
    await checkOpenForms(new Date(Date.now() + 10 * 60_000)); // the worker reads it, not the guardian
    await checkMyForm(other, id);
    const signed = await audits("form.signer.signed");
    expect(signed).toHaveLength(1);
    expect(signed[0]).toMatchObject({ door: "system", targetId: id, after: { parentId: other.parentId, recipientId: recipientOf("astrid.alderquist@family-a.example"), email: "astrid.alderquist@family-a.example" } });
  });

  it("asks no consent of a guardian a signed form doesn't wait for", async () => {
    const { ctx } = await scene({ signers: "any", roles: 1 });
    const other = await secondGuardian();
    const id = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    tokenIn(await agreeAndOpen(ctx, id));
    stub.sealing = "held";
    stub.sign(stub.documentFor(id)!.id, FAMILY_A.parent.email);
    expect((await checkMyForm(ctx, id)).state).toBe("signed");
    stub.calls.length = 0;
    const view = await open(other, id);
    expect(view.step).toEqual({ kind: "sealing" });
    expect(view.words).toBe("Signed, being finished");
    expect(stub.calls).toEqual([]);
  });

  it("a student who moved to another family brings no signature along: the new family's season reads the form as not signed", async () => {
    const { ctx } = await scene({ signers: "any", roles: 1 });
    const b = await seedSignedInParent(FAMILY_B);
    const ctxB = ctxOf(b.identity);
    const student = FAMILY_A.students[0]!;
    const id = await requestIdFor(ctx, student.qboId);
    tokenIn(await agreeAndOpen(ctx, id));
    stub.sign(stub.documentFor(id)!.id, FAMILY_A.parent.email);
    expect((await checkMyForm(ctx, id)).state).toBe("complete");
    await db.update(qboCustomer).set({ parentQboId: FAMILY_B.family.qboId }).where(eq(qboCustomer.qboId, student.qboId));
    const season = (await loadMySeason(ctxB, (await loadMyFamily(ctxB))!.students))!;
    const line = season.steps[0]!.students.find((s) => s.qboId === student.qboId)!.lines[0]!;
    expect(line).toMatchObject({ state: "todo", words: "Not signed yet" });
  });
});

describe("a form is looked up within the session's family", () => {
  beforeEach(async () => { await resetDb(); stub.reset(); });

  it("finds nothing for another family's request, an id that isn't one, or a form the season no longer asks of the family", async () => {
    const { ctx, requirementId } = await scene({ signers: "any", roles: 1 });
    const b = await seedSignedInParent(FAMILY_B);
    const ctxB = ctxOf(b.identity);
    const mine = await requestIdFor(ctx, FAMILY_A.students[0]!.qboId);
    const theirs = await requestIdFor(ctxB, FAMILY_B.students[0]!.qboId);
    expect((await findMyForm(ctx, mine))?.row.id).toBe(mine);
    expect(await findMyForm(ctx, theirs)).toBeNull();
    expect(await findMyForm(ctxB, mine)).toBeNull();
    for (const bad of ["", "not-an-id", null, undefined, 7, { id: mine }, [mine], `${mine}'--`]) expect(await findMyForm(ctx, bad)).toBeNull();

    // A's own row, but the requirement is now asked only of family B: it is no longer A's form to open.
    const { requirement, requirementCover } = await import("@/lib/db/schema");
    await db.update(requirement).set({ covers: "chosen" }).where(eq(requirement.id, requirementId));
    await db.insert(requirementCover).values({ requirementId, ...(await subjectColumns(FAMILY_B.students[0]!.qboId, "student")) });
    expect(await findMyForm(ctx, mine)).toBeNull();
    expect((await findMyForm(ctxB, theirs))?.row.id).toBe(theirs);
  });

  it("every action called as family A with family B's request changes nothing of B's and returns nothing of B's", async () => {
    const { ctx } = await scene({ signers: "any", roles: 1 });
    const b = await seedSignedInParent(FAMILY_B);
    const ctxB = ctxOf(b.identity);
    const theirs = await requestIdFor(ctxB, FAMILY_B.students[0]!.qboId);
    tokenIn(await agreeAndOpen(ctxB, theirs));
    const document = stub.documentFor(theirs)!;
    stub.reject(document.id, FAMILY_B.parent.email);
    await checkMyForm(ctxB, theirs);
    const before = await requestNow(theirs);
    expect(before.state).toBe("declined");
    stub.calls.length = 0;

    const refused = { ok: false, errors: ["That form isn't here. Go back to Forms and open it again."] };
    expect(await agreeToSign(ctx, theirs, "x")).toEqual(refused);
    expect(await checkMyForm(ctx, theirs)).toEqual(refused);
    expect(await startMyFormAgain(ctx, theirs)).toEqual(refused);
    // The same words for an id that is nobody's: A can't tell that B's form exists.
    expect(await checkMyForm(ctx, crypto.randomUUID())).toEqual(refused);

    expect(stub.calls).toEqual([]);
    expect(await requestNow(theirs)).toEqual(before);
    expect(await db.select().from(signatureConsent).where(and(eq(signatureConsent.requestId, theirs), eq(signatureConsent.parentId, ctx.parentId)))).toEqual([]);
    expect(await audits("form.document.restart")).toEqual([]);
  });

  it("gives a student's form to the family the student is in now only while nothing was made for it", async () => {
    const { ctx, requirementId } = await scene({ signers: "any", roles: 1 });
    const b = await seedSignedInParent(FAMILY_B);
    const ctxB = ctxOf(b.identity);
    const [first, second] = FAMILY_A.students;
    const untouched = await requestIdFor(ctx, first!.qboId);
    const family = (await loadMyFamily(ctx))!;
    const opened = (await loadMyForms(ctx, family))!.groups.find((g) => g.subjectQboId === second!.qboId)!.forms[0]!.requestId!;
    tokenIn(await agreeAndOpen(ctx, opened));
    // Both students move to family B in QuickBooks.
    await db.update(qboCustomer).set({ parentQboId: FAMILY_B.family.qboId }).where(eq(qboCustomer.parentQboId, FAMILY_A.family.qboId));
    const forB = (await loadMyForms(ctxB, (await loadMyFamily(ctxB))!))!;
    const of = (qboId: string) => forB.groups.find((g) => g.subjectQboId === qboId)!.forms.find((f) => f.line.requirementId === requirementId)!;
    // The unopened request passes to the new family; the one with a document made for family A's guardian does not.
    expect(of(first!.qboId).requestId).toBe(untouched);
    expect((await requestNow(untouched)).familyQboId).toBe(FAMILY_B.family.qboId);
    expect(of(second!.qboId).requestId).toBeNull();
    expect((await requestNow(opened)).familyQboId).toBe(FAMILY_A.family.qboId);
    expect(await findMyForm(ctxB, opened)).toBeNull();
    expect(await findMyForm(ctx, opened)).toBeNull(); // nor is it family A's to open any more: the student is not theirs
  });
});
