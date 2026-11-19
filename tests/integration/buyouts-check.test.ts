import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Voids for a moved student are sent to the stub, never to Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, buyout, familyMoney, jobRun, writeQueue, type StoredInvoice } from "@/lib/db/schema";
import { queueVoid } from "@/lib/buyouts/writes";
import { WORKER_ACTOR } from "@/lib/quickbooks/client";
import { checkBuyoutInvoices } from "@/lib/buyouts/daily-check";
import { buyoutFacts } from "@/lib/buyouts/standing";
import { loadBuyoutsToLook } from "@/lib/buyouts/staff";
import { MONEY_JOB } from "@/lib/money/run-keys";
import { pairKey } from "@/lib/seasons/kinds";
import { runWriteQueue } from "@/lib/roster/queue";
import { afterStudentMoved } from "@/lib/roster/writes";
import { clearRosterOfOtherCompany } from "@/lib/roster/source";
import { resetDb, untilALockIsAwaited } from "../helpers/db";
import { CHENOWETH, RIVERA, stubInvoice } from "../helpers/money";
import { MONEY_REALM, seedSignedInParent, seedTwoFamilies } from "../helpers/parent";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { buyoutFamily, queueOf, seedBuyout, seedBuyoutRequirement, BUYOUT_ITEM } from "../helpers/buyouts";
import { recordOfCustomer } from "../helpers/app-records";
import { moveInCache, moveInQuickBooksOnly } from "../helpers/roster-cache";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

const FAMILY = RIVERA.family.qboId, [S1, S2] = RIVERA.students.map((s) => s.qboId) as [string, string];
const audits = async (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
const row = async (id: string) => (await db.select().from(buyout).where(eq(buyout.id, id)))[0]!;
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
const stored = (qboId: string, customerQboId: string, o: Partial<StoredInvoice> = {}): StoredInvoice => ({ qboId, number: qboId, customerQboId, forName: null, date: "2026-11-01", dueDate: "2026-12-01",
  totalCents: 10000, balanceCents: 10000, currency: "USD", payLink: null, itemQboIds: [BUYOUT_ITEM], ...o });
/** A money run that read every family, and what it stored for the family. */
async function moneyRun(invoices: StoredInvoice[], o: { readAt?: Date } = {}) {
  const [run] = await db.insert(jobRun).values({ job: MONEY_JOB, startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(), outcome: "ok", startedBy: "worker" }).returning();
  const figures = { realmId: MONEY_REALM, readAt: o.readAt ?? new Date(), invoices, totalCents: 0, currency: "USD" };
  await db.insert(familyMoney).values({ familyId: await recordOfCustomer(FAMILY, "family"), ...figures }).onConflictDoUpdate({ target: familyMoney.familyId, set: figures });
  return run!;
}

describe("the daily check of buy-out invoices (v1 spec §8.4)", () => {
  it("marks a paid one paid, flags one QuickBooks no longer shows, one on another customer and one whose student QuickBooks moved (voiding nothing for it), and audits each once", async () => {
    const p = await buyoutFamily(stub);
    await seedSignedInParent(CHENOWETH);
    const by = p.identity.parentId;
    const reqs: string[] = [];
    for (const title of ["Fine", "Paid", "Gone", "Elsewhere"]) reqs.push(await seedBuyoutRequirement({ title }));
    const perStudent = await seedBuyoutRequirement({ title: "Moved", appliesTo: "student" });
    const fine = await seedBuyout({ requirementId: reqs[0]!, familyQboId: FAMILY, chosenBy: by, invoiceQboId: "9901" });
    const paid = await seedBuyout({ requirementId: reqs[1]!, familyQboId: FAMILY, chosenBy: by, invoiceQboId: "9902" });
    const gone = await seedBuyout({ requirementId: reqs[2]!, familyQboId: FAMILY, chosenBy: by, invoiceQboId: "9903" });
    const elsewhere = await seedBuyout({ requirementId: reqs[3]!, familyQboId: FAMILY, chosenBy: by, invoiceQboId: "9904" });
    const moved = await seedBuyout({ requirementId: perStudent, familyQboId: FAMILY, subjectQboId: S1, chosenBy: by, invoiceQboId: "9905" });
    stub.invoices.push(stubInvoice("9905", S1, { TotalAmt: 100, Balance: 100, SyncToken: "2" }));
    // The student was moved to another family in QuickBooks, and a refresh read it: the family's read no longer has their
    // invoices, and the app still holds the student in the family (stage 3's slice 9c).
    await moveInQuickBooksOnly([S1], CHENOWETH.family.qboId);
    await moneyRun([stored("9901", FAMILY), stored("9902", FAMILY, { balanceCents: 0 }), stored("9904", S2)]);
    // The new family's figures hold the moved student's invoice, open, as a money read would.
    const theirFigures = { realmId: MONEY_REALM, readAt: new Date(), invoices: [stored("9905", S1)], totalCents: 10000, currency: "USD", staleAt: null };
    await db.insert(familyMoney).values({ familyId: await recordOfCustomer(CHENOWETH.family.qboId, "family"), ...theirFigures }).onConflictDoUpdate({ target: familyMoney.familyId, set: theirFigures });

    expect(await checkBuyoutInvoices()).toEqual({ ran: true, paid: 1, flagged: 3, voided: 0, unflagged: 0 });
    expect(await row(fine.id)).toMatchObject({ state: "invoiced", flag: null });
    expect(await row(paid.id)).toMatchObject({ state: "paid", flag: null });
    expect(await row(gone.id)).toMatchObject({ state: "invoiced", flag: "missing" });
    expect(await row(elsewhere.id)).toMatchObject({ state: "invoiced", flag: "other_customer" });
    // A move made in QuickBooks is no longer followed: nothing is voided or queued for it, but the buy-out is flagged
    // for staff, so it is not left reading "Buy-out invoiced" with no way out.
    expect(await row(moved.id)).toMatchObject({ state: "invoiced", flag: "student_moved" });
    expect(await queueOf(moved.id)).toEqual([]);
    expect(stub.apiCalls()).toEqual([]);
    expect(await audits("volunteer.buyout.flagged")).toHaveLength(3);
    expect((await audits("volunteer.buyout.flagged")).find((a) => a.targetId === moved.id)!.after).toMatchObject({ flag: "student_moved", why: "not_under_the_family" });
    expect(await audits("volunteer.buyout.paid")).toHaveLength(1);
    expect(await audits("volunteer.buyout.moved")).toEqual([]);
    // Shown on Reconciliation, with the family, the requirement and the amount; the moved one closes after a live read.
    const look = await loadBuyoutsToLook();
    expect(look.map((l) => [l.requirement, l.flag, l.amountCents, l.familyName])).toEqual(expect.arrayContaining([
      ["Gone", "missing", 10000, RIVERA.family.name], ["Elsewhere", "other_customer", 10000, RIVERA.family.name], ["Moved", "student_moved", 10000, RIVERA.family.name]]));
    expect(look.find((l) => l.requirement === "Moved")!.close).toMatchObject({ may: true, why: "moved_away" });

    // The worker has nothing of it to send.
    await runWriteQueue(later(1));
    expect(await row(moved.id)).toMatchObject({ state: "invoiced" });
    expect(stub.apiCalls().filter((c) => c.method === "POST")).toEqual([]);

    // Each run is followed once; a later run with nothing new audits nothing again.
    expect((await checkBuyoutInvoices()).ran).toBe(false);
    await moneyRun([stored("9901", FAMILY), stored("9904", S2)]);
    expect(await checkBuyoutInvoices()).toEqual({ ran: true, paid: 0, flagged: 0, voided: 0, unflagged: 0 });
    expect(await audits("volunteer.buyout.flagged")).toHaveLength(3);
  });

  it("ends one voided in QuickBooks as voided, so the family is not left reading 'Buy-out invoiced' for good", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    const b = await seedBuyout({ requirementId: req, familyQboId: FAMILY, chosenBy: p.identity.parentId, invoiceQboId: "9901" });
    await moneyRun([stored("9901", FAMILY, { totalCents: 0, balanceCents: 0 })]);
    expect(await checkBuyoutInvoices()).toMatchObject({ ran: true, voided: 1, flagged: 0 });
    expect(await row(b.id)).toMatchObject({ state: "voided", endReason: "voided_in_quickbooks", flag: null });
    const [audit] = await audits("volunteer.buyout.voided");
    expect(audit!.after).toMatchObject({ why: "voided_in_quickbooks" });
    expect(stub.apiCalls()).toEqual([]);
  });

  it("does not judge figures marked behind since they were read, and takes off a flag a later run does not bear out", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    // The run read the family, then the guardian's invoice was made, marking the figures behind.
    const b = await seedBuyout({ requirementId: req, familyQboId: FAMILY, chosenBy: p.identity.parentId, invoiceQboId: "5001" });
    await moneyRun([], { readAt: new Date(Date.now() - 30_000) });
    await db.update(familyMoney).set({ staleAt: new Date() }).where(eq(familyMoney.familyId, await recordOfCustomer(FAMILY, "family")));
    expect((await checkBuyoutInvoices()).flagged).toBe(0);
    expect((await row(b.id)).flag).toBeNull();
    // A flag set before (as an older check did) is taken off once the figures show the invoice where it belongs.
    await db.update(buyout).set({ flag: "missing", flaggedAt: new Date() }).where(eq(buyout.id, b.id));
    await moneyRun([stored("5001", FAMILY)]);
    await db.update(familyMoney).set({ staleAt: null }).where(eq(familyMoney.familyId, await recordOfCustomer(FAMILY, "family")));
    expect(await checkBuyoutInvoices()).toMatchObject({ ran: true, flagged: 0, unflagged: 1 });
    expect(await row(b.id)).toMatchObject({ state: "invoiced", flag: null });
    expect(await audits("volunteer.buyout.unflagged")).toHaveLength(1);
  });

  it("takes its own flag off one it finds paid, so a paid buy-out is never left flagged missing", async () => {
    const p = await buyoutFamily(stub);
    // A run that missed the invoice (made while QuickBooks was answering) flagged it missing; the family has paid since.
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement(), familyQboId: FAMILY, chosenBy: p.identity.parentId, invoiceQboId: "5001", flag: "missing" });
    const other = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Gate shifts" }), familyQboId: FAMILY, chosenBy: p.identity.parentId, invoiceQboId: "5002", flag: "other_customer" });
    await moneyRun([stored("5001", FAMILY, { balanceCents: 0 }), stored("5002", FAMILY, { balanceCents: 0 })]);
    expect(await checkBuyoutInvoices()).toMatchObject({ ran: true, paid: 2, flagged: 0 });
    expect(await row(b.id)).toMatchObject({ state: "paid", flag: null, flaggedAt: null });
    expect(await row(other.id)).toMatchObject({ state: "paid", flag: null });
    expect((await audits("volunteer.buyout.paid")).map((a) => a.before)).toEqual(expect.arrayContaining([{ state: "invoiced", flag: "missing" }, { state: "invoiced", flag: "other_customer" }]));
    expect(await loadBuyoutsToLook()).toEqual([]);
  });

  it("flags and audits once when two wakes follow the same run at once", async () => {
    const p = await buyoutFamily(stub);
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement(), familyQboId: FAMILY, chosenBy: p.identity.parentId, invoiceQboId: "9903" });
    await moneyRun([]);
    // The buy-out's row is held, so both wakes have read it unflagged and are at its update before either writes.
    let release!: () => void, holding!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const holds = new Promise<void>((resolve) => { holding = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select().from(buyout).where(eq(buyout.id, b.id)).for("update");
      holding();
      await held;
    });
    await holds;
    const one = checkBuyoutInvoices(), two = checkBuyoutInvoices();
    await untilALockIsAwaited(15_000, 2);
    release();
    const [first, second] = await Promise.all([one, two, holder]);
    expect(first.flagged + second.flagged).toBe(1);
    expect(await row(b.id)).toMatchObject({ state: "invoiced", flag: "missing" });
    expect(await audits("volunteer.buyout.flagged")).toHaveLength(1);
  });

  it("judges only a family that run read: older figures may be from before the invoice was made", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    const b = await seedBuyout({ requirementId: req, familyQboId: FAMILY, chosenBy: p.identity.parentId, invoiceQboId: "9901" });
    await moneyRun([], { readAt: new Date(Date.now() - 3_600_000) });
    expect((await checkBuyoutInvoices()).flagged).toBe(0);
    expect((await row(b.id)).flag).toBeNull();
  });
});

describe("a student who moves in the portal (afterStudentMoved)", () => {
  async function move(by: string) {
    // The cache already says the student is under the other family when the follow-ups run (applyWritten), and the
    // student's own record with it.
    await moveInCache([S1], CHENOWETH.family.qboId);
    return db.transaction((tx) => afterStudentMoved(tx, { studentQboId: S1, fromFamilyQboId: FAMILY, toFamilyQboId: CHENOWETH.family.qboId, cause: "test" },
      { actor: { door: "staff", id: by, label: "registrar@club.org" }, ip: null }));
  }

  it("voids an unpaid per-student invoice through the queue, so the new family is never billed for the old family's choice", async () => {
    const p = await buyoutFamily(stub);
    await seedSignedInParent(CHENOWETH);
    const req = await seedBuyoutRequirement({ appliesTo: "student" });
    const family = await seedBuyoutRequirement({ title: "Family one" });
    const b = await seedBuyout({ requirementId: req, familyQboId: FAMILY, subjectQboId: S1, chosenBy: p.identity.parentId, invoiceQboId: "5001" });
    const theFamilys = await seedBuyout({ requirementId: family, familyQboId: FAMILY, chosenBy: p.identity.parentId, invoiceQboId: "5002" });
    stub.invoices.push(stubInvoice("5001", S1, { TotalAmt: 100, Balance: 100, SyncToken: "3" }), stubInvoice("5002", FAMILY, { TotalAmt: 100, Balance: 100 }));
    await move("00000000-0000-4000-8000-00000000aaaa");
    expect(await row(b.id)).toMatchObject({ state: "being_voided" });
    expect((await queueOf(b.id)).map((i) => [i.state, (i.request as { why?: string }).why])).toEqual([["waiting", "student_moved"]]);
    // The new family's standing holds nothing of it, asked by the new family's record and the student's.
    const theirs = { families: [await recordOfCustomer(CHENOWETH.family.qboId, "family")], students: [await recordOfCustomer(S1, "student")] };
    expect(await buyoutFacts([req], theirs, pairKey)).toEqual(new Map());
    await runWriteQueue(later(1));
    expect(await row(b.id)).toMatchObject({ state: "voided", endReason: "student_moved" });
    const voids = stub.apiCalls().filter((c) => c.method === "POST");
    expect(voids.map((c) => [c.query.get("operation"), JSON.parse(c.body)])).toEqual([["void", { Id: "5001", SyncToken: "3" }]]);
    // A per-family buy-out is the family's still: untouched.
    expect(await row(theFamilys.id)).toMatchObject({ state: "invoiced", flag: null });
    expect(await audits("volunteer.buyout.moved")).toHaveLength(1);
    // The move's own follow-up row counts what it did to buy-outs, beside forms and places.
    expect((await audits("roster.student.move.followed"))[0]!.after).toMatchObject({ buyoutsToVoid: 1, buyoutsFlagged: 0 });
  });

  it("leaves a paid or part-paid one as it is and flags it for the treasurer", async () => {
    const p = await buyoutFamily(stub);
    await seedSignedInParent(CHENOWETH);
    const paidReq = await seedBuyoutRequirement({ appliesTo: "student", title: "Paid" });
    const partReq = await seedBuyoutRequirement({ appliesTo: "student", title: "Part paid" });
    const paid = await seedBuyout({ requirementId: paidReq, familyQboId: FAMILY, subjectQboId: S1, chosenBy: p.identity.parentId, state: "paid", invoiceQboId: "5003" });
    const part = await seedBuyout({ requirementId: partReq, familyQboId: FAMILY, subjectQboId: S1, chosenBy: p.identity.parentId, invoiceQboId: "5004" });
    stub.invoices.push(stubInvoice("5004", S1, { TotalAmt: 100, Balance: 30 }));
    await move("00000000-0000-4000-8000-00000000aaaa");
    expect(await row(paid.id)).toMatchObject({ state: "paid", flag: "student_moved" });
    expect(await row(part.id)).toMatchObject({ state: "being_voided" });
    expect((await audits("roster.student.move.followed"))[0]!.after).toMatchObject({ buyoutsToVoid: 1, buyoutsFlagged: 1 });
    await runWriteQueue(later(1));
    // Read live before the void: something was paid, so it is never voided.
    expect(await row(part.id)).toMatchObject({ state: "invoiced", flag: "student_moved" });
    expect(stub.apiCalls().filter((c) => c.method === "POST")).toEqual([]);
    expect(stub.invoices[0]).toMatchObject({ TotalAmt: 100, Balance: 30 });
    const look = await loadBuyoutsToLook();
    expect(look.map((l) => l.requirement).sort()).toEqual(["Paid", "Part paid"]);
  });

  it("voids one still being invoiced as soon as its invoice is made", async () => {
    const p = await buyoutFamily(stub);
    await seedSignedInParent(CHENOWETH);
    const req = await seedBuyoutRequirement({ appliesTo: "student" });
    const b = await seedBuyout({ requirementId: req, familyQboId: FAMILY, subjectQboId: S1, chosenBy: p.identity.parentId, state: "being_invoiced" });
    await db.insert(writeQueue).values({ realmId: MONEY_REALM, request: { op: "invoice_create", buyoutId: b.id, customerQboId: S1, itemQboId: BUYOUT_ITEM, units: 2, unitCents: 5000 },
      familyId: b.familyId, sent: false, tries: 0, nextTryAt: new Date() });
    await move("00000000-0000-4000-8000-00000000aaaa");
    expect((await row(b.id)).flag).toBe("student_moved");
    await runWriteQueue(later(1));
    expect(await row(b.id)).toMatchObject({ state: "being_voided" });
    await runWriteQueue(later(3));
    expect(await row(b.id)).toMatchObject({ state: "voided", endReason: "student_moved" });
    expect(stub.invoices).toHaveLength(1);
    expect(stub.invoices[0]).toMatchObject({ TotalAmt: 0, Balance: 0 });
  });
});

describe("a void on the queue", () => {
  it("is always queued for an invoiced buy-out, filed under the buy-out's own family record, even once that record has no link", async () => {
    const p = await buyoutFamily(stub);
    // A per-student buy-out, billed to the student's own customer. Before migration 0034 the item named the family's
    // customer, found through the family record's link: with that link gone there was none to name, so no void was
    // queued and the callers flagged the buy-out instead. (A per-family one was queued even then: the customer it is
    // billed to stood in for its family.)
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement({ appliesTo: "student" }), familyQboId: FAMILY, subjectQboId: S1, chosenBy: p.identity.parentId, invoiceQboId: "5001" });
    const f = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Family one" }), familyQboId: FAMILY, chosenBy: p.identity.parentId, invoiceQboId: "5002" });
    expect(b.studentId).not.toBeNull();
    await db.delete(accountingLink).where(eq(accountingLink.familyId, b.familyId));
    const item = await db.transaction((tx) => queueVoid(tx, b, "student_moved", { actor: WORKER_ACTOR, label: "student moved", nextTryAt: later(5) }));
    expect(item).toMatchObject({ familyId: b.familyId, studentId: null, targetQboId: null, request: { op: "invoice_void", buyoutId: b.id, invoiceQboId: "5001", customerQboId: S1, why: "student_moved" } });
    expect(item!.request).not.toHaveProperty("familyQboId");
    expect(await row(b.id)).toMatchObject({ state: "being_voided", flag: null });
    // A per-family buy-out the same way.
    expect(await db.transaction((tx) => queueVoid(tx, f, "switched_back", { actor: WORKER_ACTOR, label: "a guardian", nextTryAt: later(5) })))
      .toMatchObject({ familyId: f.familyId, request: { op: "invoice_void", buyoutId: f.id, customerQboId: FAMILY } });
    // Only a buy-out no longer invoiced comes back without one.
    expect(await db.transaction((tx) => queueVoid(tx, { ...b, state: "being_voided" }, "switched_back", { actor: WORKER_ACTOR, label: "a guardian", nextTryAt: later(5) }))).toBeNull();
    expect(await queueOf(b.id)).toHaveLength(1);
  });
});

describe("connecting a different company", () => {
  it("deletes every buy-out, counted in the audit row, and their queued writes with the queue", async () => {
    const { a } = await seedTwoFamilies();
    // Filed under the family's own record: the queue goes before the records, or the clear would be refused.
    await db.insert(writeQueue).values({ realmId: MONEY_REALM, request: { op: "invoice_void", buyoutId: "00000000-0000-4000-8000-000000000001", invoiceQboId: "9174", customerQboId: a.spec.family.qboId,
      why: "switched_back" }, familyId: a.identity.familyId, sent: false, nextTryAt: new Date() });
    expect((await db.select().from(buyout)).length).toBe(2);
    expect(await clearRosterOfOtherCompany("2222", { actor: { door: "staff", id: null, label: "admin@club.org" }, ip: null })).toBe(true);
    expect(await db.select().from(buyout)).toEqual([]);
    expect(await db.select().from(writeQueue)).toEqual([]);
    const [cleared] = await audits("volunteer.signups.cleared");
    expect(cleared!.after).toMatchObject({ buyouts: 2 });
  });
});
