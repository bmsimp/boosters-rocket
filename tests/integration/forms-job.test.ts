import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, setting, signatureRequest } from "@/lib/db/schema";
import { ASK_AT_MOST, ASK_EVERY_MS, FORMS_JOB, SEALING_LATE_MS, SEAL_AGAIN_AFTER_MS, checkOpenForms, formsWaiting } from "@/lib/forms/job";
import { getFormsStatus } from "@/lib/forms/settings";
import { runDueJobs } from "@/lib/jobs/runner";
import { resetDb } from "../helpers/db";
import { startDocumensoStub, type DocumensoStub, type StubEnvelope } from "../helpers/documenso-stub";
import { connectForms, formSetting, requestNow, seedFormRequirement, seedRequest } from "../helpers/forms";
import { seedSeason } from "../helpers/season";

/**
 * The worker's part in forms (src/lib/forms/job.ts): Documenso's webhooks are not retried, so the worker asks about
 * every form that is out and not finished, and asks Documenso to seal again a form that everyone signed a while ago.
 */
let stub: DocumensoStub;
beforeAll(async () => { stub = await startDocumensoStub(); });
afterAll(async () => { await stub.close(); });

const ago = (ms: number) => new Date(Date.now() - ms);
let requirementId: string, templateId: string;
/** A request with a real document in the stub, last read `checkedAgo` ago. */
async function outForSigning(subject: string, o: { checkedAgo?: number | null } = {}): Promise<{ id: string; document: StubEnvelope }> {
  const id = await seedRequest({ requirementId, familyQboId: `FAM-${subject}`, subjectQboId: subject, state: "waiting", envelopeId: `envelope_placeholder${subject.replace(/\W/g, "")}`,
    checkedAt: o.checkedAgo === null ? null : ago(o.checkedAgo ?? ASK_EVERY_MS + 1000) });
  const template = stub.envelopes.get(templateId)!;
  const made = await (await fetch(`${stub.origin}/api/v2/envelope/use`, { method: "POST", headers: { authorization: stub.token, "content-type": "application/json" },
    body: JSON.stringify({ envelopeId: templateId, externalId: id, distributeDocument: true, recipients: [{ id: template.recipients[0]!.id, email: `${subject.toLowerCase()}@example.com`, name: subject }] }) })).json() as { id: string };
  const document = stub.envelopes.get(made.id)!;
  await db.update(signatureRequest).set({ envelopeId: document.id, signers: [{ parentId: crypto.randomUUID(), recipientId: document.recipients[0]!.id, name: subject, email: document.recipients[0]!.email, signedAt: null }] })
    .where(eq(signatureRequest.id, id));
  return { id, document };
}
const audits = async (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));

describe("the worker asks Documenso about forms that are out", () => {
  beforeEach(async () => {
    await resetDb(); stub.reset();
    await connectForms(stub);
    const season = await seedSeason({ name: "Fall", steps: [{ name: "Forms" }] });
    const template = stub.addTemplate({ signers: 1 });
    templateId = template.id;
    requirementId = await seedFormRequirement({ stepId: season.stepIds.Forms!, title: "Medical release", appliesTo: "student", form: formSetting({ id: template.id }) });
    stub.calls.length = 0;
  });

  it("does nothing while forms aren't set up, and nothing when no form is out", async () => {
    expect(await checkOpenForms()).toEqual({ asked: 0, failed: 0, completed: 0, sealAsked: 0 });
    await outForSigning("STU-1");
    stub.calls.length = 0;
    await db.delete(setting);
    expect(await checkOpenForms()).toEqual({ asked: 0, failed: 0, completed: 0, sealAsked: 0 });
    expect(stub.calls).toEqual([]);
  });

  it("stores a completion no webhook told it about, and marks the evidence as owed", async () => {
    const { id, document } = await outForSigning("STU-1");
    const other = await outForSigning("STU-2");
    stub.sign(document.id, "stu-1@example.com"); // signed and sealed; the webhook never arrived
    stub.calls.length = 0;
    expect(await checkOpenForms()).toEqual({ asked: 2, failed: 0, completed: 1, sealAsked: 0 });
    expect(await requestNow(id)).toMatchObject({ state: "complete", evidenceOwed: true });
    expect(await requestNow(other.id)).toMatchObject({ state: "waiting", evidenceOwed: false });
    expect((await audits("form.state.change"))[0]).toMatchObject({ door: "system", actorLabel: "worker", targetId: id });
    expect((await getFormsStatus()).lastAskedAt).not.toBeNull();
    // The finished one is never asked about again; the other only when its last read is old enough.
    stub.calls.length = 0;
    expect((await checkOpenForms()).asked).toBe(0);
    expect((await checkOpenForms(new Date(Date.now() + ASK_EVERY_MS + 2000))).asked).toBe(1);
    expect(stub.apiCalls().map((c) => c.path)).toEqual([`/api/v2/envelope/${other.document.id}`]);
  });

  it("asks only about forms whose last read is old enough, the longest unread first, and no more than its limit in one wake", async () => {
    const fresh = await outForSigning("STU-FRESH", { checkedAgo: ASK_EVERY_MS - 30_000 });
    const old = await outForSigning("STU-OLD", { checkedAgo: ASK_EVERY_MS + 60_000 });
    const never = await outForSigning("STU-NEVER", { checkedAgo: null });
    stub.calls.length = 0;
    expect((await checkOpenForms()).asked).toBe(2);
    expect(stub.apiCalls().map((c) => c.path)).toEqual([`/api/v2/envelope/${never.document.id}`, `/api/v2/envelope/${old.document.id}`]);
    expect((await requestNow(fresh.id)).checkedAt!.getTime()).toBeLessThan(Date.now() - ASK_EVERY_MS + 60_000);
    expect(ASK_AT_MOST).toBeGreaterThanOrEqual(20);
    expect(ASK_EVERY_MS).toBeLessThanOrEqual(10 * 60_000); // "every few minutes"
  });

  it("never asks about a request that is not opened, complete or declined", async () => {
    await seedRequest({ requirementId, familyQboId: "F", subjectQboId: "S-NOT" });
    await seedRequest({ requirementId, familyQboId: "F", subjectQboId: "S-DONE", state: "complete", checkedAt: ago(ASK_EVERY_MS * 10) });
    await seedRequest({ requirementId, familyQboId: "F", subjectQboId: "S-NO", state: "declined", checkedAt: ago(ASK_EVERY_MS * 10) });
    expect((await checkOpenForms()).asked).toBe(0);
    expect(stub.calls).toEqual([]);
  });

  it("asks Documenso to seal again when everyone signed a while ago and it still isn't sealed, and not too often", async () => {
    const { id, document } = await outForSigning("STU-1");
    stub.sealing = "held"; stub.sealWhenAsked = false;
    stub.sign(document.id, "stu-1@example.com");
    // First read: signed by everyone, not sealed. Too soon to ask again.
    expect(await checkOpenForms()).toEqual({ asked: 1, failed: 0, completed: 0, sealAsked: 0 });
    expect(await requestNow(id)).toMatchObject({ state: "signed", evidenceOwed: false, sealAskedAt: null });
    expect(stub.sealAsks).toBe(0);

    // Twenty minutes on, still not sealed: the portal queues the sealing again.
    const signedAt = (await requestNow(id)).allSignedAt!.getTime();
    const later = new Date(signedAt + SEAL_AGAIN_AFTER_MS + 60_000);
    await db.update(signatureRequest).set({ checkedAt: ago(ASK_EVERY_MS + 1000) }).where(eq(signatureRequest.id, id));
    expect(await checkOpenForms(later)).toEqual({ asked: 1, failed: 0, completed: 0, sealAsked: 1 });
    expect(stub.sealAsks).toBe(1);
    expect(stub.apiCalls("/envelope/distribute").at(-1)!.body).toEqual({ envelopeId: document.id });
    expect((await requestNow(id)).sealAskedAt?.getTime()).toBe(later.getTime());
    expect((await audits("form.seal.ask"))[0]).toMatchObject({ door: "system", actorLabel: "worker", targetId: id });
    expect((await audits("form.seal.ask"))[0]!.after).toMatchObject({ envelopeId: document.id, accepted: true });

    // Five minutes after that it is read again, and not asked again: the wait starts over from the last ask.
    await db.update(signatureRequest).set({ checkedAt: ago(ASK_EVERY_MS + 1000) }).where(eq(signatureRequest.id, id));
    expect((await checkOpenForms(new Date(later.getTime() + 5 * 60_000))).sealAsked).toBe(0);
    expect(stub.sealAsks).toBe(1);

    // The next ask works: Documenso seals it, and the following read finds it complete.
    stub.sealWhenAsked = true;
    await db.update(signatureRequest).set({ checkedAt: ago(ASK_EVERY_MS + 1000) }).where(eq(signatureRequest.id, id));
    expect((await checkOpenForms(new Date(later.getTime() + SEAL_AGAIN_AFTER_MS + 60_000))).sealAsked).toBe(1);
    await db.update(signatureRequest).set({ checkedAt: ago(ASK_EVERY_MS + 1000) }).where(eq(signatureRequest.id, id));
    expect((await checkOpenForms()).completed).toBe(1);
    expect(await requestNow(id)).toMatchObject({ state: "complete", evidenceOwed: true });
  });

  it("stops the pass when Documenso can't be reached, changes nothing, and tries again at the next wake", async () => {
    const a = await outForSigning("STU-1"), b = await outForSigning("STU-2");
    stub.sign(a.document.id, "stu-1@example.com");
    stub.calls.length = 0;
    stub.drop = true;
    expect(await checkOpenForms()).toEqual({ asked: 1, failed: 1, completed: 0, sealAsked: 0 });
    expect(stub.calls).toHaveLength(1); // the second form was not tried against a server that isn't there
    expect((await requestNow(a.id)).state).toBe("waiting");
    expect((await getFormsStatus()).lastApiError).toBe("unreachable");
    stub.drop = false;
    expect(await checkOpenForms()).toMatchObject({ asked: 2, failed: 0, completed: 1 });
    expect((await requestNow(b.id)).state).toBe("waiting");
    // One form's own failure doesn't stop the others.
    await db.update(signatureRequest).set({ checkedAt: ago(ASK_EVERY_MS + 1000) }).where(eq(signatureRequest.id, b.id));
    const c = await outForSigning("STU-3");
    stub.failNext = 1;
    stub.sign(c.document.id, "stu-3@example.com");
    expect(await checkOpenForms()).toMatchObject({ asked: 2, failed: 1, completed: 1 });
  });

  it("runs from the worker's wake, and is in the wake's answer only when it asked about something", async () => {
    expect((await runDueJobs()).ran).toEqual([]);
    const { id, document } = await outForSigning("STU-1");
    stub.sign(document.id, "stu-1@example.com");
    expect((await runDueJobs()).ran).toEqual([{ job: FORMS_JOB, ok: true }]);
    expect((await requestNow(id)).state).toBe("complete");
    expect((await runDueJobs()).ran).toEqual([]);
    const second = await outForSigning("STU-2");
    stub.drop = true;
    expect((await runDueJobs()).ran).toEqual([{ job: FORMS_JOB, ok: false }]);
    expect((await requestNow(second.id)).state).toBe("waiting");
  });

  it("counts for the Health page the forms that are out, and those signed over an hour ago that still aren't sealed", async () => {
    await seedRequest({ requirementId, familyQboId: "F", subjectQboId: "S1", state: "waiting" });
    await seedRequest({ requirementId, familyQboId: "F", subjectQboId: "S2", state: "signed", allSignedAt: ago(SEALING_LATE_MS - 60_000) });
    await seedRequest({ requirementId, familyQboId: "F", subjectQboId: "S3", state: "signed", allSignedAt: ago(SEALING_LATE_MS + 60_000) });
    await seedRequest({ requirementId, familyQboId: "F", subjectQboId: "S4", state: "complete", allSignedAt: ago(SEALING_LATE_MS * 5) });
    await seedRequest({ requirementId, familyQboId: "F", subjectQboId: "S5" });
    expect(await formsWaiting()).toEqual({ open: 3, sealingLate: 1 });
  });
});
