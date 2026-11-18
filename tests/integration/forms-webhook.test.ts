import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, setting, signatureRequest } from "@/lib/db/schema";
import { GET, POST } from "@/app/api/documenso/webhook/route";
import { getFormsStatus, webhookAddress } from "@/lib/forms/settings";
import { WEBHOOK_BODY_MAX } from "@/lib/forms/webhook";
import { resetDb } from "../helpers/db";
import { seedRosterRead } from "../helpers/roster-cache";
import { startDocumensoStub, type DocumensoStub, type StubEnvelope } from "../helpers/documenso-stub";
import { connectForms, formSetting, requestNow, seedFormRequirement, seedRequest } from "../helpers/forms";
import { seedSeason } from "../helpers/season";

/**
 * Hearing from Documenso (src/app/api/documenso/webhook/route.ts): the shared secret guards the door, and a message
 * is only a hint. Whatever it says, the portal stores what Documenso's own API says about the portal's own request.
 */
let stub: DocumensoStub;
beforeAll(async () => { stub = await startDocumensoStub(); });
afterAll(async () => { await stub.close(); });

const SECRET = "the-right-secret-0123456789abcdef";
const post = (body: unknown, secret: string | null = SECRET, extra: Record<string, string> = {}) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return POST(new Request("http://localhost:3000/api/documenso/webhook", { method: "POST", body: text,
    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), ...(secret === null ? {} : { "x-documenso-secret": secret }), ...extra } }));
};
/** A message as Documenso sends one (verification, 4.g): the document as payload, recipients' tokens included. */
const message = (event: string, document: Partial<StubEnvelope> & { externalId: string | null }, status = "COMPLETED") => ({
  event, createdAt: new Date().toISOString(), webhookEndpoint: webhookAddress(),
  payload: { id: 41, envelopeId: document.id ?? "envelope_fromthebody", externalId: document.externalId, status, completedAt: new Date().toISOString(), deletedAt: null,
    recipients: (document.recipients ?? []).map((r) => ({ id: r.id, email: r.email, name: r.name, token: r.token, signingStatus: "SIGNED", signedAt: new Date().toISOString() })) },
});

/** A request with a real document in the stub, out for signing by one guardian. */
async function outForSigning(): Promise<{ id: string; document: StubEnvelope }> {
  const season = await seedSeason({ name: "Fall", steps: [{ name: "Forms" }] });
  const template = stub.addTemplate({ signers: 1 });
  const requirementId = await seedFormRequirement({ stepId: season.stepIds.Forms!, title: "Medical release", appliesTo: "student", form: formSetting({ id: template.id }) });
  const id = await seedRequest({ requirementId, familyQboId: "FAM-1", subjectQboId: "STU-1", state: "waiting", envelopeId: "envelope_placeholder0", signers: [{ parentId: crypto.randomUUID(), recipientId: 0, name: "Ana", email: "ana@example.com", signedAt: null }] });
  const made = await (await fetch(`${stub.origin}/api/v2/envelope/use`, { method: "POST", headers: { authorization: stub.token, "content-type": "application/json" },
    body: JSON.stringify({ envelopeId: template.id, externalId: id, distributeDocument: true, recipients: [{ id: template.recipients[0]!.id, email: "ana@example.com", name: "Ana" }] }) })).json() as { id: string };
  const document = stub.envelopes.get(made.id)!;
  const row = await requestNow(id);
  await db.update(signatureRequest).set({ envelopeId: document.id, signers: [{ ...row.signers[0]!, recipientId: document.recipients[0]!.id }] }).where(eq(signatureRequest.id, id));
  stub.calls.length = 0;
  return { id, document };
}

describe("the Documenso webhook", () => {
  const logged: unknown[][] = [];
  beforeEach(async () => {
    await resetDb(); stub.reset();
    await connectForms(stub, { webhookSecret: SECRET });
    await seedRosterRead({ realmId: "9130000000000088" }); // a request names the app's records, made in the roster's company
    logged.length = 0;
    for (const method of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation((...args) => { logged.push(args); });
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it("gives its address on the portal's own address, under /api/", () => {
    expect(webhookAddress()).toBe("http://localhost:3000/api/documenso/webhook");
  });

  it("answers a bare 404 with no secret, a wrong one, or one that differs only at the end, and does nothing", async () => {
    const { id, document } = await outForSigning();
    stub.sign(document.id, "ana@example.com");
    for (const secret of [null, "", "wrong", `${SECRET}x`, SECRET.slice(0, -1), SECRET.toUpperCase(), SECRET.replace("right", "wrong")]) {
      const res = await post(message("DOCUMENT_COMPLETED", { ...document, externalId: id }), secret);
      expect(res.status, `secret ${JSON.stringify(secret)}`).toBe(404);
      expect(await res.text()).toBe('{"ok":false}');
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect((await GET()).status).toBe(404);
    expect(stub.calls).toEqual([]);
    expect((await requestNow(id)).state).toBe("waiting");
    expect((await getFormsStatus()).lastWebhookAt).toBeNull();
  });

  it("accepts nothing while no secret is set, or forms aren't set up, even a message with an empty secret", async () => {
    await connectForms(stub, { webhookSecret: null });
    for (const secret of ["", "anything", SECRET]) expect((await post(message("DOCUMENT_COMPLETED", { externalId: crypto.randomUUID() }), secret)).status).toBe(404);
    await db.delete(setting);
    expect((await post(message("DOCUMENT_COMPLETED", { externalId: crypto.randomUUID() }), SECRET)).status).toBe(404);
  });

  it("with the secret, reads the request's own document from the API and stores what that says", async () => {
    const { id, document } = await outForSigning();
    stub.sign(document.id, "ana@example.com");
    const before = Date.now();
    const res = await post(message("DOCUMENT_COMPLETED", { ...document, externalId: id }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(stub.apiCalls().map((c) => `${c.method} ${c.path}`)).toEqual([`GET /api/v2/envelope/${document.id}`]);
    const row = await requestNow(id);
    expect(row).toMatchObject({ state: "complete", envelopeStatus: "COMPLETED", evidenceOwed: true });
    expect(row.signers[0]!.signedAt).toBe(document.recipients[0]!.signedAt);
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "form.state.change"));
    expect(audit).toMatchObject({ door: "system", actorLabel: "documenso", targetId: id });
    expect(Date.parse((await getFormsStatus()).lastWebhookAt!)).toBeGreaterThanOrEqual(before - 1000);
    // Nothing of the message is kept or logged: it carries the recipient's signing token.
    const kept = JSON.stringify([await db.select().from(signatureRequest), await db.select().from(auditLog), await db.select().from(setting), logged]);
    expect(kept).not.toContain(document.recipients[0]!.token);
    expect(logged).toEqual([]);
  });

  it("is not fooled by a body that lies: the API is believed, not the message", async () => {
    const { id, document } = await outForSigning();
    // Nobody has signed. The message says the document is completed, and names another document as this request's.
    const lie = message("DOCUMENT_COMPLETED", { ...document, id: "envelope_someoneelses", externalId: id }, "COMPLETED");
    expect((await post(lie)).status).toBe(200);
    expect(stub.apiCalls().map((c) => c.path)).toEqual([`/api/v2/envelope/${document.id}`]); // the portal's own record of the document, not the body's
    expect(await requestNow(id)).toMatchObject({ state: "waiting", evidenceOwed: false, envelopeId: document.id });
    expect((await requestNow(id)).signers[0]!.signedAt).toBeNull();
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "form.state.change"))).toEqual([]);
    // And one that says a signed document was rejected, or cancelled, or not signed after all.
    stub.sign(document.id, "ana@example.com");
    await post(message("DOCUMENT_COMPLETED", { ...document, externalId: id }));
    for (const [event, status] of [["DOCUMENT_REJECTED", "REJECTED"], ["DOCUMENT_CANCELLED", "PENDING"], ["DOCUMENT_SENT", "PENDING"]] as const) {
      expect((await post(message(event, { ...document, externalId: id }, status))).status).toBe(200);
      expect((await requestNow(id)).state).toBe("complete");
    }
  });

  it("takes the same message any number of times, and messages out of order, and ends where the API says", async () => {
    const { id, document } = await outForSigning();
    stub.sign(document.id, "ana@example.com");
    const completed = message("DOCUMENT_COMPLETED", { ...document, externalId: id });
    for (let i = 0; i < 4; i++) expect((await post(completed)).status).toBe(200); // Documenso's four quick retries
    expect((await post(message("DOCUMENT_OPENED", { ...document, externalId: id }, "PENDING"))).status).toBe(200); // an earlier event, arriving late
    expect((await requestNow(id)).state).toBe("complete");
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "form.state.change"))).toHaveLength(1);
    // Once the request is complete, a repeat doesn't even ask Documenso.
    stub.calls.length = 0;
    await post(completed);
    expect(stub.calls).toEqual([]);
  });

  it("ignores an id it doesn't know, an id that isn't one, and a body that isn't a message, with a plain 200", async () => {
    const { id } = await outForSigning();
    const bodies: unknown[] = [
      message("DOCUMENT_COMPLETED", { externalId: crypto.randomUUID() }), message("DOCUMENT_COMPLETED", { externalId: null }),
      message("DOCUMENT_COMPLETED", { externalId: `${id}' OR '1'='1` }), message("DOCUMENT_COMPLETED", { externalId: id.slice(0, 8) }),
      { event: "DOCUMENT_COMPLETED" }, { payload: "nothing" }, [], null, "not json at all", "", "{\"payload\":{\"externalId\":7}}",
    ];
    for (const body of bodies) {
      const res = await post(body);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"ok":true}'); // the same answer whether or not the id is one the portal has
    }
    expect(stub.calls).toEqual([]);
    expect((await requestNow(id)).state).toBe("waiting");
  });

  it("refuses a body far larger than any of Documenso's messages", async () => {
    const big = JSON.stringify({ payload: { externalId: crypto.randomUUID(), filler: "x".repeat(WEBHOOK_BODY_MAX) } });
    expect((await post(big)).status).toBe(404);
    // A declared length that lies is caught when the body is read.
    expect((await post(big, SECRET, { "content-length": "10" })).status).toBe(404);
    expect((await getFormsStatus()).lastWebhookAt).toBeNull();
  });

  it("answers 200 when Documenso can't be read just then, and changes nothing: the worker asks again", async () => {
    const { id, document } = await outForSigning();
    stub.sign(document.id, "ana@example.com");
    stub.drop = true;
    expect((await post(message("DOCUMENT_COMPLETED", { ...document, externalId: id }))).status).toBe(200);
    expect((await requestNow(id)).state).toBe("waiting");
    expect((await getFormsStatus()).lastWebhookAt).not.toBeNull();
    expect(logged).toEqual([]);
  });

  it("sets a deleted document's request back to not opened when the API no longer has it", async () => {
    const { id, document } = await outForSigning();
    stub.envelopes.delete(document.id); // deleted in Documenso's own pages
    expect((await post(message("DOCUMENT_CANCELLED", { ...document, externalId: id }, "PENDING"))).status).toBe(200);
    expect(await requestNow(id)).toMatchObject({ state: "not_opened", envelopeId: null, signers: [] });
  });
});
