import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  formReminderClaim, formReminderRound, parentEmailChange, signatureRequest, signedFormEvidence, signedFormFile, volunteerCredit,
  volunteerReminder, volunteerSignup, writeQueue,
} from "@/lib/db/schema";
import { clearRosterOfOtherCompany, setRosterSource } from "@/lib/roster/source";
import { resetDb, untilALockIsAwaited } from "../helpers/db";
import { seedTwoFamilies } from "../helpers/parent";

/**
 * Everything step 5 stores against a QuickBooks id goes when a different company is connected (AGENTS.md: the same id
 * may name another customer there), in clearRosterOfOtherCompanyLocked() or the clear functions it calls: the form
 * reminder claims and rounds, volunteer credit and its reminder claims, the staff write queue and parents' email
 * change requests. Signed-form evidence is the one exception: it is the club's record, kept with every byte and hash,
 * marked as the earlier company's and cut from its request (tests/integration/signed-forms-staff.test.ts shows the
 * archive and that no parent of the new company reaches it).
 */
const admin = { actor: { door: "staff" as const, id: null, label: "admin@club.org" }, ip: null };

describe("connecting a different company after step 5", () => {
  beforeEach(async () => {
    await resetDb();
    await db.transaction((tx) => setRosterSource(tx, "1111"));
  });

  it("clears every new record keyed by a QuickBooks id and keeps the signed forms' evidence as the earlier company's", async () => {
    const { a, b } = await seedTwoFamilies();
    const reqId = a.forms!.ids.waiting;
    const [req] = await db.select().from(signatureRequest).limit(1);
    await db.insert(formReminderClaim).values({ requirementId: req!.requirementId, parentId: a.identity.parentId, onDate: "2026-11-16" });
    await db.insert(formReminderRound).values({ requirementId: req!.requirementId, onDate: "2026-11-16" });
    await db.insert(volunteerReminder).values({ kind: "due_14", key: `${a.identity.familyQboId}|2026-11-30|${a.identity.parentId}`, familyQboId: a.identity.familyQboId, triedAt: new Date(), outcome: "sent" });
    await db.insert(writeQueue).values({ realmId: "1111", request: { op: "deactivate", role: "student", qboId: "12", syncToken: "0" }, targetQboId: "12", state: "waiting", sent: false });
    const before = {
      credit: (await db.select().from(volunteerCredit)).length, emails: (await db.select().from(parentEmailChange)).length,
      evidence: await db.select().from(signedFormEvidence), files: await db.select().from(signedFormFile),
    };
    // Something of each is there to clear, and both families have kept evidence.
    expect(before.credit).toBeGreaterThan(0);
    expect(before.emails).toBeGreaterThanOrEqual(2);
    expect(before.evidence.map((e) => e.id).sort()).toEqual([a.forms!.evidence.id, b.forms!.evidence.id].sort());
    expect(reqId).toBeTruthy();

    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);

    expect(await db.select().from(formReminderClaim)).toEqual([]);
    expect(await db.select().from(formReminderRound)).toEqual([]);
    expect(await db.select().from(volunteerCredit)).toEqual([]);
    expect(await db.select().from(volunteerReminder)).toEqual([]);
    expect(await db.select().from(volunteerSignup)).toEqual([]);
    expect(await db.select().from(writeQueue)).toEqual([]);
    expect(await db.select().from(parentEmailChange)).toEqual([]);
    expect(await db.select().from(signatureRequest)).toEqual([]);

    const kept = await db.select().from(signedFormEvidence);
    expect(kept.map((e) => e.id).sort()).toEqual(before.evidence.map((e) => e.id).sort());
    for (const e of kept) expect(e).toMatchObject({ requestId: null, realmId: "1111", earlierCompanyAt: expect.any(Date) });
    const files = await db.select().from(signedFormFile);
    expect(files.map((f) => [f.id, f.sha256, f.size, Buffer.from(f.bytes).toString("hex")]).sort())
      .toEqual(before.files.map((f) => [f.id, f.sha256, f.size, Buffer.from(f.bytes).toString("hex")]).sort());
  });

  it("marks evidence the worker was storing at that moment as the earlier company's too, once its store commits", async () => {
    const { a } = await seedTwoFamilies();
    const requestId = a.forms!.ids.signed;
    let commit!: () => void;
    const held = new Promise<void>((resolve) => { commit = resolve; });
    // As storeEvidence() does: the request locked, the evidence inserted, the commit still to come.
    const storing = db.transaction(async (tx) => {
      await tx.select().from(signatureRequest).where(eq(signatureRequest.id, requestId)).for("update");
      await tx.insert(signedFormEvidence).values({ requestId, realmId: "1111", requirementId: null, familyQboId: a.identity.familyQboId, subjectQboId: a.identity.familyQboId,
        subjectKind: "family", formTitle: "In flight", envelopeId: "envelope_inflight", signers: [], consents: [], originals: [] });
      await held;
    });
    const clearing = clearRosterOfOtherCompany("2222", admin);
    await untilALockIsAwaited();
    commit();
    await storing;
    expect(await clearing).toBe(true);
    const [inFlight] = await db.select().from(signedFormEvidence).where(eq(signedFormEvidence.formTitle, "In flight"));
    expect(inFlight).toMatchObject({ requestId: null, earlierCompanyAt: expect.any(Date) });
  });
});
