import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  accountingLink, auditLog, buyout, family, familyMoney, formReminderClaim, formReminderRound, guardian, parentAuthSession, parentEmailChange, qboConnection, requirementCover, requirementProgress, signatureConsent, signatureRequest,
  signedFormCopy, signedFormEvidence, signedFormFile, student, volunteerCredit, requirementReminder, volunteerReminder, volunteerSignup, writeQueue,
} from "@/lib/db/schema";
import { beginConnect, completeConnect, disconnect } from "@/lib/quickbooks/connection";
import { refreshRoster } from "@/lib/roster/refresh";
import { clearRosterOfOtherCompany, getRosterSource, setRosterSource } from "@/lib/roster/source";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { resetDb, seedStaff, untilALockIsAwaited } from "../helpers/db";
import { seedTwoFamilies } from "../helpers/parent";
import { recordOfCustomer } from "../helpers/app-records";
import { seedConsent } from "../helpers/forms";
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
 * From stage 2 the seasons, volunteering and forms are the exception too: their ticks, waivers, chosen lists and
 * reminder claims, every sign-up, credit and volunteer reminder claim, and every form request and the current
 * company's evidence, name the app's own families and students, so
 * connecting a different company is refused until stage 4 ships (open question 18), and nothing the portal runs
 * reaches the clear. The last describe proves that part; the clear itself is kept for the areas that have not moved
 * yet, whose part stays below until their own slice. Called directly, it still empties volunteering and the form
 * requests first, and cuts the evidence from the app's records, before the app's own records they name (the first test).
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
    // A queued change filed under the app's own family and student (stage 3): the database would refuse to remove the
    // records while it names them, so the clear deletes the queue first, and counts it.
    const studentA = await recordOfCustomer(a.spec.students[0]!.qboId, "student");
    await db.insert(writeQueue).values({ realmId: "1111", request: { op: "deactivate", role: "student", qboId: a.spec.students[0]!.qboId, syncToken: "0" }, targetQboId: a.spec.students[0]!.qboId,
      familyId: famA, studentId: studentA, state: "waiting", sent: false });
    // B's form was kept while B had no QuickBooks link (as the evidence job keeps one since migration 0036): no company
    // and no copy. It is the club's record like any other: archived with the rest and never deleted, since the clear
    // removes the families it names.
    await db.update(signedFormEvidence).set({ realmId: null, familyQboId: null, subjectQboId: null }).where(eq(signedFormEvidence.id, b.forms!.evidence.id));
    const before = {
      credit: (await db.select().from(volunteerCredit)).length, emails: (await db.select().from(parentEmailChange)).length,
      evidence: await db.select().from(signedFormEvidence), files: await db.select().from(signedFormFile),
    };
    // Something of each is there to clear, and both families have kept evidence.
    expect(before.credit).toBeGreaterThan(0);
    expect(before.emails).toBeGreaterThanOrEqual(2);
    expect(before.evidence.map((e) => e.id).sort()).toEqual([a.forms!.evidence.id, b.forms!.evidence.id].sort());
    // The current company's evidence names the app's own family and student (stage 2), beside its own copies of the ids.
    expect(before.evidence.every((e) => e.familyId !== null && e.studentId !== null && e.earlierCompanyAt === null)).toBe(true);
    expect(reqId).toBeTruthy();
    // A buy-out of each family, by the app's own family record (stage 2).
    expect((await db.select().from(buyout)).map((x) => String(x.familyId)).sort()).toEqual([String(famA), String(await recordOfCustomer(b.spec.family.qboId, "family"))].sort());
    // Each family's stored figures, kept by the app's own family record (stage 2): the database would refuse to remove
    // the record while they name it, so the clear removes them first.
    expect((await db.select().from(familyMoney)).map((m) => String(m.familyId)).sort()).toEqual([String(famA), String(await recordOfCustomer(b.spec.family.qboId, "family"))].sort());
    // seedTwoFamilies() made the app's own records of both families, linked in this company.
    expect((await db.select().from(family)).length).toBeGreaterThanOrEqual(2);
    expect((await db.select().from(student)).length).toBeGreaterThanOrEqual(4);
    expect((await db.select().from(accountingLink)).every((l) => l.realmId === "1111")).toBe(true);
    expect((await db.select().from(guardian)).every((g) => g.familyId !== null)).toBe(true);
    // Each parent's session and pending change of sign-in address name the app's own family (stage 3's fifth slice):
    // the database would refuse to remove the records while they do, so the clear's parent access part, which runs
    // first, deletes them.
    const familyIds = [String(a.identity.familyId), String(b.identity.familyId)].sort();
    expect((await db.select().from(parentAuthSession)).map((s) => String(s.familyId)).sort()).toEqual(familyIds);
    expect((await db.select().from(parentEmailChange)).map((e) => String(e.familyId)).sort()).toEqual(familyIds);

    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
    expect(await db.select().from(parentAuthSession)).toEqual([]);

    expect(await db.select().from(formReminderClaim)).toEqual([]);
    expect(await db.select().from(formReminderRound)).toEqual([]);
    expect(await db.select().from(volunteerCredit)).toEqual([]);
    expect(await db.select().from(volunteerReminder)).toEqual([]);
    expect(await db.select().from(volunteerSignup)).toEqual([]);
    // Every buy-out (seedTwoFamilies() gives each family one): they name the app's own families, so they go before those.
    expect(await db.select().from(buyout)).toEqual([]);
    expect(await db.select().from(familyMoney)).toEqual([]);
    expect(await db.select().from(writeQueue)).toEqual([]);
    expect((await db.select().from(auditLog).where(eq(auditLog.action, "roster.cleared")))[0]!.after).toMatchObject({ writesDeleted: 1 });
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
    // Kept, marked as the earlier company's and cut from its request and from the app's records, which are gone: every
    // QuickBooks id, name, signer and consent it holds as it was.
    for (const e of kept) expect(e).toMatchObject({ requestId: null, realmId: e.id === b.forms!.evidence.id ? null : "1111", earlierCompanyAt: expect.any(Date), familyId: null, studentId: null });
    expect(kept.find((e) => e.id === b.forms!.evidence.id)).toMatchObject({ realmId: null, familyQboId: null, subjectQboId: null });
    const asSigned = (e: typeof kept[number]) => ({ ...e, requestId: null, earlierCompanyAt: null, familyId: null, studentId: null });
    for (const e of kept) expect(asSigned(e)).toEqual(asSigned(before.evidence.find((x) => x.id === e.id)!));
    const files = await db.select().from(signedFormFile);
    expect(files.map((f) => [f.id, f.sha256, f.size, Buffer.from(f.bytes).toString("hex")]).sort())
      .toEqual(before.files.map((f) => [f.id, f.sha256, f.size, Buffer.from(f.bytes).toString("hex")]).sort());
  });

  it("marks evidence the worker was storing at that moment as the earlier company's too, once its store commits", async () => {
    const { a } = await seedTwoFamilies();
    const requestId = a.forms!.ids.signed;
    const familyId = a.identity.familyId;
    let commit!: () => void, inserted!: () => void;
    const held = new Promise<void>((resolve) => { commit = resolve; });
    const ready = new Promise<void>((resolve) => { inserted = resolve; });
    // As storeEvidence() does (stage 3's slice 9d): the roster lock held shared, the request locked, the evidence
    // inserted, the commit still to come. The clear, which holds the roster lock exclusively, waits for it.
    const storing = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(${ROSTER_LOCK})`);
      await tx.select().from(signatureRequest).where(eq(signatureRequest.id, requestId)).for("update");
      await tx.insert(signedFormEvidence).values({ requestId, realmId: "1111", requirementId: null, familyQboId: a.spec.family.qboId, subjectQboId: a.spec.family.qboId,
        subjectKind: "family", familyId, formTitle: "In flight", envelopeId: "envelope_inflight", signers: [], consents: [], originals: [] });
      inserted();
      await held;
    });
    // The store holds its locks before the clear starts, so the lock the clear waits for is the store's.
    await ready;
    const clearing = clearRosterOfOtherCompany("2222", admin);
    await untilALockIsAwaited();
    commit();
    await storing;
    expect(await clearing).toBe(true);
    const [inFlight] = await db.select().from(signedFormEvidence).where(eq(signedFormEvidence.formTitle, "In flight"));
    expect(inFlight).toMatchObject({ requestId: null, earlierCompanyAt: expect.any(Date), familyId: null, studentId: null });
  });
});

describe("the seasons, volunteering and forms, from stage 2 until stage 4: a different company is refused, and every record stays", () => {
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
    // Buy-outs (stage 2): every one, by the app's own family and student.
    buyouts: await db.select().from(buyout).orderBy(asc(buyout.id)),
    // The money cache (stage 2): every family's stored figures, by the app's own family.
    money: await db.select().from(familyMoney).orderBy(asc(familyMoney.familyId)),
    families: await db.select().from(family).orderBy(asc(family.id)),
    students: await db.select().from(student).orderBy(asc(student.id)),
    links: await db.select().from(accountingLink).orderBy(asc(accountingLink.id)),
    // Forms (stage 2): every request, consent, reminder claim and round, and every piece of kept evidence with its files and copies.
    requests: await db.select().from(signatureRequest).orderBy(asc(signatureRequest.id)),
    consents: await db.select().from(signatureConsent).orderBy(asc(signatureConsent.id)),
    formClaims: await db.select().from(formReminderClaim).orderBy(asc(formReminderClaim.id)),
    formRounds: await db.select().from(formReminderRound).orderBy(asc(formReminderRound.id)),
    evidence: await db.select().from(signedFormEvidence).orderBy(asc(signedFormEvidence.id)),
    files: await db.select().from(signedFormFile).orderBy(asc(signedFormFile.id)),
    copies: await db.select().from(signedFormCopy).orderBy(asc(signedFormCopy.id)),
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
    // A guardian's consent to sign, and a form reminder's claim and round.
    await seedConsent(a.forms!.ids.waiting, { parentId: a.identity.parentId, name: a.spec.parent.name, email: a.spec.parent.email });
    const [req] = await db.select().from(signatureRequest).limit(1);
    await db.insert(formReminderClaim).values({ requirementId: req!.requirementId, parentId: a.identity.parentId, onDate: "2026-11-16" });
    await db.insert(formReminderRound).values({ requirementId: req!.requirementId, onDate: "2026-11-16" });
    await seedConnected(stub, { realmId: "1111" });
    const before = await seasonRecords();
    // Both families' requests in every state, a consent, the kept evidence of each with its four files, the claim and round.
    expect(new Set(before.requests.map((r) => r.state))).toEqual(new Set(["not_opened", "waiting", "signed", "complete", "declined"]));
    expect(before.requests.length).toBeGreaterThanOrEqual(12);
    expect(before.consents).toHaveLength(1);
    expect(before.evidence).toHaveLength(2);
    expect(before.files).toHaveLength(8);
    expect([before.formClaims.length, before.formRounds.length]).toEqual([1, 1]);
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
    expect(await audits("roster.cleared", "season.records.cleared", "volunteer.signups.cleared", "accounting.links.cleared", "parent.access.cleared", "form.records.cleared")).toEqual([]);

    // The same company again: connected, and every record is as it was.
    expect(await connect("1111")).toEqual({ ok: true });
    expect((await db.select().from(qboConnection))[0]!.realmId).toBe("1111");
    expect(await seasonRecords()).toEqual(before);
    expect(await audits("roster.cleared", "season.records.cleared", "volunteer.signups.cleared", "accounting.links.cleared", "form.records.cleared")).toEqual([]);
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
    expect(await audits("roster.cleared", "season.records.cleared", "volunteer.signups.cleared", "accounting.links.cleared", "form.records.cleared")).toEqual([]);
  });
});
