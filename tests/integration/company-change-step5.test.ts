import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  accountingLink, auditLog, family, formReminderClaim, formReminderRound, guardian, parentEmailChange, qboConnection, requirementCover, requirementProgress, signatureRequest,
  signedFormEvidence, signedFormFile, student, volunteerCredit, requirementReminder, volunteerReminder, volunteerSignup, writeQueue,
} from "@/lib/db/schema";
import { beginConnect, completeConnect, disconnect } from "@/lib/quickbooks/connection";
import { refreshRoster } from "@/lib/roster/refresh";
import { clearRosterOfOtherCompany, getRosterSource, setRosterSource } from "@/lib/roster/source";
import { resetDb, seedStaff, untilALockIsAwaited } from "../helpers/db";
import { seedTwoFamilies } from "../helpers/parent";
import { recordOfCustomer } from "../helpers/app-records";
import { seedConnected, startQboStub, type QboStub } from "../helpers/qbo-stub";

/**
 * Everything step 5 stores against a QuickBooks id goes when a different company is connected (AGENTS.md: the same id
 * may name another customer there), in clearRosterOfOtherCompanyLocked() or the clear functions it calls: the form
 * reminder claims and rounds, volunteer credit and its reminder claims, the staff write queue and parents' email
 * change requests, and the app's own families, students and links (stage 1 of the app-owned families spec), made from
 * that company's customers. Signed-form evidence is the one exception: it is the club's record, kept with every byte and hash,
 * marked as the earlier company's and cut from its request (tests/integration/signed-forms-staff.test.ts shows the
 * archive and that no parent of the new company reaches it).
 *
 * From stage 2 the seasons and volunteering are the exception too: their ticks, waivers, chosen lists and reminder
 * claims, and every sign-up, credit and volunteer reminder claim, name the app's own families and students, so
 * connecting a different company is refused until stage 4 ships (open question 18), and nothing the portal runs
 * reaches the clear. The last describe proves that part; the clear itself is kept for the areas that have not moved
 * yet, whose part stays below until their own slice. Called directly, it still empties volunteering first, before the
 * app's own records it names (the first test).
 */
const admin = { actor: { door: "staff" as const, id: null, label: "admin@club.org" }, ip: null };

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

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
    const famA = await recordOfCustomer(a.spec.family.qboId, "family");
    await db.insert(volunteerReminder).values({ kind: "due_14", key: `${String(famA)}|2026-11-30|${a.identity.parentId}`, familyId: famA, triedAt: new Date(), outcome: "sent" });
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
    // seedTwoFamilies() made the app's own records of both families, linked in this company.
    expect((await db.select().from(family)).length).toBeGreaterThanOrEqual(2);
    expect((await db.select().from(student)).length).toBeGreaterThanOrEqual(4);
    expect((await db.select().from(accountingLink)).every((l) => l.realmId === "1111")).toBe(true);
    expect((await db.select().from(guardian)).every((g) => g.familyId !== null)).toBe(true);

    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);

    expect(await db.select().from(formReminderClaim)).toEqual([]);
    expect(await db.select().from(formReminderRound)).toEqual([]);
    expect(await db.select().from(volunteerCredit)).toEqual([]);
    expect(await db.select().from(volunteerReminder)).toEqual([]);
    expect(await db.select().from(volunteerSignup)).toEqual([]);
    expect(await db.select().from(writeQueue)).toEqual([]);
    expect(await db.select().from(parentEmailChange)).toEqual([]);
    expect(await db.select().from(signatureRequest)).toEqual([]);
    // Nothing of the earlier company's is left in the app's own records: no link, no family or student, and no sign-in
    // in a family of it.
    expect(await db.select().from(accountingLink)).toEqual([]);
    expect(await db.select().from(family)).toEqual([]);
    expect(await db.select().from(student)).toEqual([]);
    expect((await db.select().from(guardian)).map((g) => g.familyId)).toEqual([null, null]);

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

describe("the seasons and volunteering, from stage 2 until stage 4: a different company is refused, and every record stays", () => {
  const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
  const audits = async (...actions: string[]) => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((r) => actions.includes(r.action));
  /** Every season and volunteering record, ids and times and all, and the app's own records they name. */
  const seasonRecords = async () => ({
    progress: await db.select().from(requirementProgress).orderBy(asc(requirementProgress.id)),
    covers: await db.select().from(requirementCover).orderBy(asc(requirementCover.requirementId), asc(requirementCover.familyId), asc(requirementCover.studentId)),
    reminders: await db.select().from(requirementReminder).orderBy(asc(requirementReminder.id)),
    signups: await db.select().from(volunteerSignup).orderBy(asc(volunteerSignup.id)),
    credits: await db.select().from(volunteerCredit).orderBy(asc(volunteerCredit.id)),
    volunteerReminders: await db.select().from(volunteerReminder).orderBy(asc(volunteerReminder.id)),
    families: await db.select().from(family).orderBy(asc(family.id)),
    students: await db.select().from(student).orderBy(asc(student.id)),
    links: await db.select().from(accountingLink).orderBy(asc(accountingLink.id)),
  });
  let staff: Awaited<ReturnType<typeof seedStaff>>;
  const connect = async (realmId: string) => {
    const r = await beginConnect(staff.id);
    if (!r.ok) throw new Error("not configured");
    stub.codes.add("code-1");
    return completeConnect({ code: "code-1", state: new URL(r.url).searchParams.get("state"), realmId, error: null },
      { staffUserId: staff.id, actor: { door: "staff", id: staff.id, label: staff.email }, ip: "203.0.113.9", permission: "Settings.QuickBooks.ReadWrite" });
  };

  beforeEach(async () => {
    await resetDb(); stub.reset();
    await db.transaction((tx) => setRosterSource(tx, "1111"));
    staff = await seedStaff({ email: "admin@example.org", admin: true });
  });

  it("refuses to connect another company, keeps the season's and volunteering's records, and connects the same one again", { timeout: 30_000 }, async () => {
    const { a, b } = await seedTwoFamilies();
    // A due-date reminder claim of each, carried by the app's own family (src/lib/seasons/due-reminders.ts, src/lib/volunteer/reminders.ts).
    const famA = await recordOfCustomer(a.spec.family.qboId, "family");
    await db.insert(requirementReminder).values({ kind: "due_14", familyId: famA, parentId: a.identity.parentId, dueOn: "2026-11-30", triedAt: new Date(), outcome: "sent" });
    await db.insert(volunteerReminder).values({ kind: "due_14", key: `${String(famA)}|2026-11-30|${a.identity.parentId}`, familyId: famA, triedAt: new Date(), outcome: "sent" });
    await seedConnected(stub, { realmId: "1111" });
    const before = await seasonRecords();
    // Something of each is there to keep: both families' ticks and waivers, their chosen lists, the claim.
    expect(before.progress.filter((p) => p.metAt !== null).length).toBeGreaterThanOrEqual(4);
    expect(before.progress.filter((p) => p.waivedAt !== null).length).toBeGreaterThanOrEqual(2);
    expect(before.covers.length).toBeGreaterThanOrEqual(4);
    expect(before.reminders).toHaveLength(1);
    expect(b.season!.markers.length).toBeGreaterThan(0);
    // Both families' places on the shared shift, A's check-in and B's credit from outside the portal, the claim.
    expect(before.signups.length).toBeGreaterThanOrEqual(2);
    expect(before.credits.length).toBeGreaterThanOrEqual(2);
    expect(before.volunteerReminders).toHaveLength(1);

    // The Admin disconnects, and signs in to Intuit with another company: refused before anything is stored or cleared.
    await disconnect({ actor: { door: "staff", id: staff.id, label: staff.email }, ip: null });
    expect(await connect("2222")).toEqual({ ok: false, reason: "roster_company" });
    expect((await db.select().from(qboConnection))[0]).toMatchObject({ realmId: null, refreshTokenCiphertext: null });
    expect(stub.calls.filter((c) => c.path === "/token")).toEqual([]); // no code was exchanged for that company
    expect(await getRosterSource()).toBe("1111");
    expect(await seasonRecords()).toEqual(before);
    expect((await audits("quickbooks.connect_refused")).map((r) => r.after)).toEqual([{ reason: "roster_company" }]);
    expect(await audits("roster.cleared", "season.records.cleared", "volunteer.signups.cleared", "accounting.links.cleared", "parent.access.cleared")).toEqual([]);

    // The same company again: connected, and every record is as it was.
    expect(await connect("1111")).toEqual({ ok: true });
    expect((await db.select().from(qboConnection))[0]!.realmId).toBe("1111");
    expect(await seasonRecords()).toEqual(before);
    expect(await audits("roster.cleared", "season.records.cleared", "volunteer.signups.cleared", "accounting.links.cleared")).toEqual([]);
  });

  it("refuses to read another company's roster over this one's, asking QuickBooks nothing, and keeps every season record", { timeout: 30_000 }, async () => {
    await seedTwoFamilies();
    // A connection to another company stored without a connect (from before the refusal, or by hand).
    await seedConnected(stub, { realmId: "2222" });
    const before = await seasonRecords();
    expect(await refreshRoster(worker)).toEqual({ ok: false, reason: "failed",
      error: "The roster was read from another QuickBooks company than the one connected now, so it wasn't read. Disconnect QuickBooks, then connect the company the roster was read from. (roster_company)" });
    expect(stub.apiCalls()).toEqual([]);
    expect(await getRosterSource()).toBe("1111");
    expect(await seasonRecords()).toEqual(before);
    expect((await audits("roster.refresh.failed")).map((r) => r.after)).toEqual([{ code: "roster_company" }]);
    expect(before.signups.length).toBeGreaterThanOrEqual(2);
    expect(await audits("roster.cleared", "season.records.cleared", "volunteer.signups.cleared", "accounting.links.cleared")).toEqual([]);
  });
});
