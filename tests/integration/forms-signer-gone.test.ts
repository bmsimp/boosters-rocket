import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { auditLog, formWithdrawal, parent, type RequestSigner } from "@/lib/db/schema";
import { blockPerson } from "@/lib/parents/people";
import { runReconcile } from "../helpers/reconcile";
import { resetDb, seedParent, seedGuardian } from "../helpers/db";
import { seedCache, seedRosterRead, seedShape, seedParentSettings, SIGNINS_ON, fam, par, stu } from "../helpers/roster-cache";
import { recordOfCustomer } from "../helpers/app-records";
import { seedSeason } from "../helpers/season";
import { formSetting, requestNow, seedFormRequirement, seedRequest } from "../helpers/forms";

// A guardian who can no longer sign for a family (blocked, or their link closed by the reconcile) keeps a working
// Documenso signing link on any document made for them. Their unfinished forms start again, and the documents are
// withdrawn, so a signature or decline made through that link never counts for the family.

const staff = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000002", label: "reg@club.org" }, ip: "203.0.113.9", permission: "Parents.ReadWrite" };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
// A request names the app's own family: each test reads its roster from one company first, so the families have records.
const REALM = "9130000000000077";
const signer = (parentId: string, name: string, signedAt: string | null = null, recipientId = 1): RequestSigner => ({ parentId, recipientId, name, email: `${name.toLowerCase()}@example.com`, signedAt });

async function formsIn() {
  const s = await seedSeason({ name: "2026-27", steps: [{ name: "Sign-up" }] });
  const stepId = s.stepIds["Sign-up"]!;
  return {
    any: await seedFormRequirement({ stepId, title: "Commitment form", appliesTo: "family", form: formSetting({ id: "envelope_t1" }) }),
    every: await seedFormRequirement({ stepId, title: "Trip consent", appliesTo: "family", form: formSetting({ id: "envelope_t2" }, { signers: "every" }) }),
    third: await seedFormRequirement({ stepId, title: "Photo release", appliesTo: "family", form: formSetting({ id: "envelope_t3" }) }),
    fourth: await seedFormRequirement({ stepId, title: "Code of conduct", appliesTo: "family", form: formSetting({ id: "envelope_t4" }) }),
  };
}

describe("a guardian who can no longer sign for the family", () => {
  beforeEach(async () => { await resetDb(); });

  it("blocking starts again every unfinished form still waiting for them, withdraws its document, and leaves the rest", async () => {
    await seedRosterRead({ realmId: REALM });
    const ana = await seedParent({ name: "Ana" }), mei = await seedParent({ name: "Mei" });
    const r = await formsIn();
    const waitingOnAna = await seedRequest({ requirementId: r.any, familyQboId: "F1", subjectQboId: "F1", state: "waiting", envelopeId: "envelope_any", signers: [signer(ana.id, "Ana")] });
    const meiSigned = await seedRequest({ requirementId: r.every, familyQboId: "F1", subjectQboId: "F1", state: "waiting", envelopeId: "envelope_every",
      signers: [signer(mei.id, "Mei", "2026-11-10T12:00:00.000Z", 1), signer(ana.id, "Ana", null, 2)] });
    const anaSigned = await seedRequest({ requirementId: r.third, familyQboId: "F1", subjectQboId: "F1", state: "waiting", envelopeId: "envelope_signed",
      signers: [signer(ana.id, "Ana", "2026-11-10T12:00:00.000Z", 1), signer(mei.id, "Mei", null, 2)] });
    const complete = await seedRequest({ requirementId: r.fourth, familyQboId: "F1", subjectQboId: "F1", state: "complete", envelopeId: "envelope_done", signers: [signer(ana.id, "Ana", "2026-11-10T12:00:00.000Z")] });
    const meiOnly = await seedRequest({ requirementId: r.any, familyQboId: "F2", subjectQboId: "F2", state: "waiting", envelopeId: "envelope_mei", signers: [signer(mei.id, "Mei")] });

    expect(await blockPerson(ana.id, "Custody order on file.", staff)).toMatchObject({ ok: true });

    expect(await requestNow(waitingOnAna)).toMatchObject({ state: "not_opened", envelopeId: null, signers: [] });
    expect(await requestNow(meiSigned)).toMatchObject({ state: "not_opened", envelopeId: null, signers: [] });
    expect(await requestNow(anaSigned)).toMatchObject({ state: "waiting", envelopeId: "envelope_signed" });
    expect(await requestNow(complete)).toMatchObject({ state: "complete", envelopeId: "envelope_done" });
    expect(await requestNow(meiOnly)).toMatchObject({ state: "waiting", envelopeId: "envelope_mei" });
    const withdrawn = (await db.select().from(formWithdrawal)).map((w) => ({ envelopeId: w.envelopeId, anySigned: w.anySigned })).sort((a, b) => a.envelopeId.localeCompare(b.envelopeId));
    expect(withdrawn).toEqual([{ envelopeId: "envelope_any", anySigned: false }, { envelopeId: "envelope_every", anySigned: true }]);
    const gone = await audits("forms.request.signer_gone");
    expect(gone.map((a) => a.targetId).sort()).toEqual([waitingOnAna, meiSigned].sort());
    expect(gone[0]!.after).toMatchObject({ parentId: ana.id, reason: "blocked" });
    expect((await audits("parent.block"))[0]!.after).toMatchObject({ formsReset: 2 });
    expect((await db.select().from(parent)).find((p) => p.id === ana.id)!.blocked).toBe(true);
  });

  it("the reconcile closing a link starts again that family's forms waiting for them, and no other family's", async () => {
    await seedRosterRead({ realmId: REALM });
    await seedShape(); await seedParentSettings(SIGNINS_ON);
    const both = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), stu("12", "Leo Rivera", "10"),
      fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com")];
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10", status: "active", sourceQboId: "11" });
    await seedGuardian({ parentId: ana.id, familyQboId: "20", status: "active", sourceQboId: "21" });
    await seedCache(both);
    const r = await formsIn();
    const inTen = await seedRequest({ requirementId: r.any, familyQboId: "10", subjectQboId: "10", state: "waiting", envelopeId: "envelope_ten", signers: [signer(ana.id, "Ana")] });
    const inTwenty = await seedRequest({ requirementId: r.any, familyQboId: "20", subjectQboId: "20", state: "waiting", envelopeId: "envelope_twenty", signers: [signer(ana.id, "Ana")] });

    await seedCache(both.map((c) => (c.qboId === "11" ? { ...c, active: false } : c)));
    expect(await runReconcile({ cause: "test" })).toMatchObject({ ended: 1 });

    expect(await requestNow(inTen)).toMatchObject({ state: "not_opened", envelopeId: null });
    expect(await requestNow(inTwenty)).toMatchObject({ state: "waiting", envelopeId: "envelope_twenty" });
    expect((await db.select().from(formWithdrawal)).map((w) => w.envelopeId)).toEqual(["envelope_ten"]);
    expect((await audits("forms.request.signer_gone"))[0]!.after).toMatchObject({ parentId: ana.id, familyId: String(await recordOfCustomer("10", "family")), reason: "access_ended", withdraw: "delete" });
    expect((await audits("parent.access.ended"))[0]!.after).toMatchObject({ familyQboId: "10", formsReset: 1 });
  });
});
