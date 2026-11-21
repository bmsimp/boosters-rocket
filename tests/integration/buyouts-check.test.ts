import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Voids for a moved student are sent to the stub, never to Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, buyout, family, familyMoney, jobRun, qboConnection, requirement, seasonStep, setting, student, writeQueue, type StoredInvoice } from "@/lib/db/schema";
import { recordNameWords } from "@/lib/families/words";
import { queueVoid, sendBuyoutWrite } from "@/lib/buyouts/writes";
import { INVOICE_WRITES, WORKER_ACTOR } from "@/lib/quickbooks/client";
import { checkBuyoutInvoices } from "@/lib/buyouts/daily-check";
import { buyoutFacts } from "@/lib/buyouts/standing";
import { closeTag, loadBuyoutsToLook, loadEarlierCompanyBuyouts, loadFamilyBuyouts, stateWords } from "@/lib/buyouts/staff";
import { AFTER_ENDING, CLOSE_WORDS, EARLIER_WORDS, HERE_WORDS, MADE_AFTER_WORDS, PAID_AFTER_ENDING_WORDS } from "@/lib/buyouts/closing";
import { prerender } from "react-dom/static";
import { EarlierCompanyBuyouts } from "@/app/staff/(app)/reconciliation/buyouts";
import { beginSwitchConnect, completeConnect, disconnect } from "@/lib/quickbooks/connection";
import { CLOSE_COPY, closeBuyout } from "@/lib/buyouts/close";
import { buyoutCheckLine } from "@/lib/health/job-lines";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { MONEY_JOB } from "@/lib/money/run-keys";
import { pairKey } from "@/lib/seasons/kinds";
import { GIVE_UP_BUSY, giveUp, runWriteQueue } from "@/lib/roster/queue";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { afterStudentMoved } from "@/lib/roster/writes";
import { clearRosterOfOtherCompany, clearRosterOfOtherCompanyLocked, SOURCE_KEY } from "@/lib/roster/source";
import { resetDb, seedStaff, untilALockIsAwaited } from "../helpers/db";
import { CHENOWETH, RIVERA, stubInvoice } from "../helpers/money";
import { MONEY_REALM, seedSignedInParent } from "../helpers/parent";
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

  it("takes its own student_moved flag off once QuickBooks holds the student under the family again, and off one it then finds paid", async () => {
    const p = await buyoutFamily(stub);
    await seedSignedInParent(CHENOWETH);
    const by = p.identity.parentId;
    const back = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Back", appliesTo: "student" }), familyQboId: FAMILY, subjectQboId: S1, chosenBy: by, invoiceQboId: "9906" });
    const paidLater = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Paid later", appliesTo: "student" }), familyQboId: FAMILY, subjectQboId: S2, chosenBy: by, invoiceQboId: "9907" });
    // Both students moved to another family in QuickBooks by mistake: the check flags both, voiding nothing.
    await moveInQuickBooksOnly([S1, S2], CHENOWETH.family.qboId);
    await moneyRun([]);
    expect(await checkBuyoutInvoices()).toMatchObject({ ran: true, flagged: 2, unflagged: 0 });
    expect(await row(back.id)).toMatchObject({ state: "invoiced", flag: "student_moved" });
    expect(await row(paidLater.id)).toMatchObject({ state: "invoiced", flag: "student_moved" });
    // Moved back in QuickBooks: the family's figures hold both invoices again, one of them paid since.
    await moveInQuickBooksOnly([S1, S2], FAMILY);
    await moneyRun([stored("9906", S1), stored("9907", S2, { balanceCents: 0 })]);
    expect(await checkBuyoutInvoices()).toMatchObject({ ran: true, paid: 1, flagged: 0, unflagged: 1 });
    expect(await row(back.id)).toMatchObject({ state: "invoiced", flag: null, flaggedAt: null });
    expect(await row(paidLater.id)).toMatchObject({ state: "paid", flag: null });
    expect((await audits("volunteer.buyout.unflagged")).map((a) => [a.targetId, a.before])).toEqual([[back.id, { flag: "student_moved" }]]);
    expect((await audits("volunteer.buyout.paid")).map((a) => [a.targetId, a.before])).toEqual([[paidLater.id, { state: "invoiced", flag: "student_moved" }]]);
    // Nothing is left for Reconciliation: a paid one is not offered a "paid in full" close it never asked for.
    expect(await loadBuyoutsToLook()).toEqual([]);
    expect(stub.apiCalls().filter((c) => c.method === "POST")).toEqual([]);
  });

  it("keeps a student_moved flag a void set beside it, though the student is under the family", async () => {
    const p = await buyoutFamily(stub);
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement({ appliesTo: "student" }), familyQboId: FAMILY, subjectQboId: S1, chosenBy: p.identity.parentId,
      invoiceQboId: "9908", flag: "student_moved" });
    // A void was tried for it (a staff move's), and kept: part of it was paid.
    await db.transaction((tx) => queueVoid(tx, b, "student_moved", { actor: WORKER_ACTOR, label: "student moved", nextTryAt: later(60) }));
    await db.update(buyout).set({ state: "invoiced", flag: "student_moved", lastCode: "paid" }).where(eq(buyout.id, b.id));
    await moneyRun([stored("9908", S1, { balanceCents: 3000 })]);
    expect(await checkBuyoutInvoices()).toMatchObject({ ran: true, unflagged: 0 });
    expect(await row(b.id)).toMatchObject({ state: "invoiced", flag: "student_moved" });
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
    // The follow-ups run at the portal's save (moveStudent(), stage 3's slice 9f), before QuickBooks or the cache has the
    // move, and take it by the app's own records, read here before moveInCache() moves the record. They read no cache,
    // so moving the cache first (as a move QuickBooks has taken leaves it) changes nothing they do.
    const move = { studentId: await recordOfCustomer(S1, "student"), fromFamilyId: await recordOfCustomer(FAMILY, "family"), toFamilyId: await recordOfCustomer(CHENOWETH.family.qboId, "family") };
    await moveInCache([S1], CHENOWETH.family.qboId);
    return db.transaction((tx) => afterStudentMoved(tx, { ...move, cause: "test" },
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
  const admin = { actor: { door: "staff" as const, id: null, label: "admin@club.org" }, ip: null };
  const NOTE = "Given up: the club connected a different QuickBooks company, so nothing more was sent for this.";
  /** The same choice made again, straight into the table, by the app's own records (a family may choose again once one ended). */
  const chooseAgain = (b: typeof buyout.$inferSelect) => db.insert(buyout).values({ requirementId: b.requirementId, familyId: b.familyId, studentId: b.studentId,
    customerQboId: b.customerQboId, itemQboId: b.itemQboId, unitCents: b.unitCents, units: b.units, amountCents: b.amountCents, state: "being_invoiced", realmId: "2222",
    chosenBy: b.chosenBy, chosenByLabel: "a guardian" }).returning();

  // Stage 4's slice M7a (open question 16): unpaid live buy-outs end as the earlier company's and paid ones keep counting.
  // It was "deletes every buy-out" while a change of company removed the families they name.
  it("ends every unpaid live buy-out as the earlier company's, keeps paid, voided and refused ones, and gives up their writes", async () => {
    const p = await buyoutFamily(stub);
    const by = p.identity.parentId;
    const states = ["being_invoiced", "invoiced", "being_voided", "stuck", "paid", "voided", "refused"] as const;
    const made = new Map<(typeof states)[number], typeof buyout.$inferSelect>();
    for (const state of states) {
      const requirementId = await seedBuyoutRequirement({ title: `In state ${state}` });
      made.set(state, await seedBuyout({ requirementId, familyQboId: FAMILY, chosenBy: by, state, invoiceQboId: state === "being_invoiced" ? null : `77${states.indexOf(state)}`,
        flag: state === "stuck" ? "missing" : undefined }));
    }
    // The being-voided one's void, and the stuck one's create, still to go in the old company.
    const voiding = made.get("being_voided")!, stuck = made.get("stuck")!;
    const [voidItem] = await db.insert(writeQueue).values({ realmId: MONEY_REALM, request: { op: "invoice_void", buyoutId: voiding.id, invoiceQboId: voiding.invoiceQboId!, customerQboId: FAMILY,
      why: "switched_back" }, familyId: voiding.familyId, sent: false, nextTryAt: new Date() }).returning();
    const [stuckItem] = await db.insert(writeQueue).values({ realmId: MONEY_REALM, request: { op: "invoice_create", buyoutId: stuck.id, customerQboId: FAMILY, itemQboId: BUYOUT_ITEM, units: 2, unitCents: 5000 },
      familyId: stuck.familyId, state: "stuck", sent: true, nextTryAt: null }).returning();
    const before = await db.select().from(buyout);
    stub.calls.length = 0;

    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
    const unpaid = ["being_invoiced", "invoiced", "being_voided", "stuck"] as const;
    for (const state of states) {
      const was = before.find((x) => x.id === made.get(state)!.id)!;
      // Ended in the portal alone: its customer, item, invoice, company and flag as they were, for the treasurer.
      if ((unpaid as readonly string[]).includes(state)) expect(await row(was.id)).toEqual({ ...was, state: "voided", endReason: "earlier_company", updatedAt: expect.any(Date) });
      else expect(await row(was.id)).toEqual(was);
    }
    expect(await row(stuck.id)).toMatchObject({ flag: "missing", invoiceQboId: "773", realmId: MONEY_REALM });
    expect(await queueOf(voiding.id)).toEqual([expect.objectContaining({ id: voidItem!.id, state: "given_up", note: NOTE, nextTryAt: null })]);
    expect(await queueOf(stuck.id)).toEqual([expect.objectContaining({ id: stuckItem!.id, state: "given_up", note: NOTE, nextTryAt: null })]);
    const [ended] = await audits("volunteer.buyouts.ended");
    expect(ended).toMatchObject({ door: "staff", actorLabel: "admin@club.org", targetType: "buyout" });
    expect(ended!.before).toEqual({ realmId: MONEY_REALM, being_invoiced: 1, invoiced: 1, being_voided: 1, stuck: 1 });
    expect(ended!.after).toEqual({ reason: "different_company", realmId: "2222", state: "voided", endReason: "earlier_company", ended: 4,
      endedIds: unpaid.map((s) => made.get(s)!.id).sort(), paidKept: 1, sentToQuickBooks: false });
    expect(await audits("volunteer.signups.cleared")).toEqual([]);
    // Nothing was asked of QuickBooks.
    expect(stub.calls).toEqual([]);
    // As far as the database goes the family may choose again where one ended (the live indexes no longer hold it),
    // and not where the paid one still counts.
    expect(await chooseAgain(made.get("invoiced")!)).toHaveLength(1);
    await expect(chooseAgain(made.get("paid")!)).rejects.toThrow();
  });

  it("a void queued at that moment commits first, then its buy-out ends and its void is given up", async () => {
    const p = await buyoutFamily(stub);
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Racing" }), familyQboId: FAMILY, chosenBy: p.identity.parentId, invoiceQboId: "9301" });
    let commit!: () => void, queued!: () => void;
    const held = new Promise<void>((r) => { commit = r; }), ready = new Promise<void>((r) => { queued = r; });
    // As switchMyBuyoutBack() queues it: no roster lock, the buy-out moved to being voided and its void inserted, the commit still to come.
    const voiding = db.transaction(async (tx) => {
      const item = await queueVoid(tx, b, "switched_back", { actor: WORKER_ACTOR, label: "a guardian", nextTryAt: later(5) });
      queued(); await held;
      return item;
    });
    await ready;
    const clearing = clearRosterOfOtherCompany("2222", admin);
    // The clear waits for the buy-out's row.
    await untilALockIsAwaited();
    commit();
    const item = await voiding;
    expect(item).not.toBeNull();
    expect(await clearing).toBe(true);
    expect(await row(b.id)).toMatchObject({ state: "voided", endReason: "earlier_company", invoiceQboId: "9301" });
    expect(await queueOf(b.id)).toEqual([expect.objectContaining({ id: item!.id, state: "given_up", note: NOTE })]);
    expect((await audits("volunteer.buyouts.ended"))[0]!.before).toEqual({ realmId: MONEY_REALM, being_invoiced: 0, invoiced: 0, being_voided: 1, stuck: 0 });
  });

  it("a void asked for after the clear finds the buy-out ended and queues nothing", async () => {
    const p = await buyoutFamily(stub);
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Late" }), familyQboId: FAMILY, chosenBy: p.identity.parentId, invoiceQboId: "9302" });
    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
    // The guardian's page was drawn before: it still holds the buy-out as invoiced.
    expect(await db.transaction((tx) => queueVoid(tx, b, "switched_back", { actor: WORKER_ACTOR, label: "a guardian", nextTryAt: later(5) }))).toBeNull();
    expect(await queueOf(b.id)).toEqual([]);
    expect(await row(b.id)).toMatchObject({ state: "voided", endReason: "earlier_company" });
  });

  // Stage 4's slice M7a2: a buy-out write on its way when the clear runs. The stub runs the clear as the request arrives,
  // before it answers, so the finish comes after the clear has ended the buy-out and given its item up.
  const staff = { actor: { door: "staff" as const, id: null, label: "treasurer@club.org" }, ip: null, permission: "Roster.Family.ReadWrite" };
  /** The buy-out's queued create as the confirm leaves it, due now. */
  const createFor = (b: typeof buyout.$inferSelect) => db.insert(writeQueue).values({ realmId: b.realmId, request: { op: "invoice_create", buyoutId: b.id, customerQboId: b.customerQboId,
    itemQboId: b.itemQboId, units: b.units, unitCents: b.unitCents }, familyId: b.familyId, sent: false, tries: 0, nextTryAt: new Date(Date.now() - 1000) }).returning().then((r) => r[0]!);
  /** An invoiced buy-out's void as a switch back leaves it, due now, with its invoice open in QuickBooks. */
  const voidFor = (b: typeof buyout.$inferSelect, o: { balance?: number } = {}) => {
    stub.invoices.push(stubInvoice(b.invoiceQboId!, FAMILY, { TotalAmt: 100, Balance: o.balance ?? 100, SyncToken: "0" }));
    return db.insert(writeQueue).values({ realmId: b.realmId, request: { op: "invoice_void", buyoutId: b.id, invoiceQboId: b.invoiceQboId!, customerQboId: FAMILY, why: "switched_back" },
      familyId: b.familyId, sent: false, tries: 0, nextTryAt: new Date(Date.now() - 1000) }).returning().then((r) => r[0]!);
  };
  /** Runs the change of company's clear as the first request of `method` reaches QuickBooks, then `then` on the stub. */
  const clearAsItArrives = (method: "GET" | "POST", then: () => void = () => {}) => {
    stub.onApiRequest = async (c) => {
      if (c.method !== method) return;
      stub.onApiRequest = null;
      expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
      then();
    };
  };
  const item = async (id: string) => (await db.select().from(writeQueue).where(eq(writeQueue.id, id)))[0]!;
  const ended = { state: "voided", endReason: "earlier_company" };
  const noQueueRows = async () => {
    for (const action of ["roster.write.done", "roster.write.retry", "roster.write.stuck", "volunteer.buyout.invoiced", "volunteer.buyout.refused", "volunteer.buyout.stuck",
      "volunteer.buyout.voided", "volunteer.buyout.kept"]) expect(await audits(action)).toEqual([]);
  };

  it("an invoice QuickBooks makes as the clear runs: the item stays given up with the invoice, the buy-out stays ended with it recorded, and nothing is marked done", async () => {
    const p = await buyoutFamily(stub);
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Made at that moment" }), familyQboId: FAMILY, chosenBy: p.identity.parentId, state: "being_invoiced" });
    const queued = await createFor(b);
    clearAsItArrives("POST");
    expect(await runWriteQueue()).toEqual({ ran: true, ok: true });
    expect(stub.invoices).toHaveLength(1);
    const made = String(stub.invoices[0]!.Id);
    expect(await item(queued.id)).toMatchObject({ state: "given_up", note: NOTE, sent: true, resultQboId: made });
    expect(await row(b.id)).toMatchObject({ ...ended, invoiceQboId: made, invoiceSyncToken: "0", flag: null });
    const [found] = await audits("volunteer.buyout.invoice_found_after_ending");
    expect(found).toMatchObject({ targetType: "buyout", targetId: b.id, door: "system" });
    expect(found!.after).toMatchObject({ state: "voided", endReason: "earlier_company", invoiceQboId: made, customerQboId: FAMILY, amountCents: b.amountCents, realmId: MONEY_REALM, queueId: queued.id });
    await noQueueRows();
  });

  it("a create that times out as the clear runs leaves its item given up and its buy-out ended, not stuck, and the family may choose again", async () => {
    const p = await buyoutFamily(stub);
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Busy at that moment" }), familyQboId: FAMILY, chosenBy: p.identity.parentId, state: "being_invoiced" });
    const queued = await createFor(b);
    clearAsItArrives("POST", () => { stub.failNext = 1; });
    expect(await runWriteQueue()).toEqual({ ran: true, ok: true });
    expect(stub.invoices).toEqual([]);
    expect(await item(queued.id)).toMatchObject({ state: "given_up", note: NOTE, sent: true, tries: 0, nextTryAt: null });
    expect(await row(b.id)).toMatchObject({ ...ended, invoiceQboId: null, lastCode: null });
    await noQueueRows();
    // Ended, it holds nothing live: the same requirement and family take a new buy-out.
    expect(await chooseAgain(b)).toHaveLength(1);
  });

  // Since stage 4's slice M8 (M7b's leftover) QuickBooks' answer to such a write is recorded on the ended buy-out as its
  // last code (AFTER_ENDING), audited, its state and end reason unchanged, so the treasurer's list reads what QuickBooks
  // did; these four cases expected no code before, and changed on purpose.
  const listed = async (id: string) => (await loadEarlierCompanyBuyouts()).find((x) => x.id === id) ?? null;
  const answeredRow = async (action: string, id: string) => (await audits(action)).filter((r) => r.targetId === id);

  it("a create QuickBooks refuses as the clear runs leaves its buy-out ended, not refused, with the refusal recorded: nothing to settle", async () => {
    const p = await buyoutFamily(stub);
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Refused at that moment" }), familyQboId: FAMILY, chosenBy: p.identity.parentId, state: "being_invoiced" });
    const queued = await createFor(b);
    clearAsItArrives("POST", () => { stub.invoiceFault = "6000"; });
    await runWriteQueue();
    expect(await item(queued.id)).toMatchObject({ state: "given_up", note: NOTE, lastCode: null, tries: 0 });
    expect(await row(b.id)).toMatchObject({ ...ended, invoiceQboId: null, lastCode: AFTER_ENDING.refused });
    const [rec] = await answeredRow("volunteer.buyout.refused_after_ending", b.id);
    expect(rec!.after).toMatchObject({ state: "voided", endReason: "earlier_company", lastCode: AFTER_ENDING.refused, queueId: queued.id, realmId: MONEY_REALM });
    await noQueueRows();
    // QuickBooks made nothing, so there is nothing to look for in the earlier company's invoices.
    expect(await listed(b.id)).toBeNull();
  });

  it("a void QuickBooks makes as the clear runs leaves its buy-out ended as the earlier company's, with the void recorded: nothing to settle", async () => {
    const p = await buyoutFamily(stub);
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Voided at that moment" }), familyQboId: FAMILY, chosenBy: p.identity.parentId, state: "being_voided", invoiceQboId: "9401" });
    const queued = await voidFor(b);
    clearAsItArrives("POST");
    await runWriteQueue();
    expect(stub.invoices[0]).toMatchObject({ Id: "9401", TotalAmt: 0 });
    expect(await item(queued.id)).toMatchObject({ state: "given_up", note: NOTE, resultQboId: null });
    expect(await row(b.id)).toMatchObject({ ...ended, invoiceQboId: "9401", lastCode: AFTER_ENDING.voided });
    expect(await answeredRow("volunteer.buyout.voided_after_ending", b.id)).toHaveLength(1);
    await noQueueRows();
    expect(await listed(b.id)).toBeNull();
  });

  it("a void QuickBooks refuses as the clear runs leaves its buy-out ended and unflagged, with the refusal recorded: the invoice stands", async () => {
    const p = await buyoutFamily(stub);
    const refused = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Void refused" }), familyQboId: FAMILY, chosenBy: p.identity.parentId, state: "being_voided", invoiceQboId: "9402" });
    const refusedItem = await voidFor(refused);
    clearAsItArrives("POST", () => { stub.invoiceFault = "6000"; });
    await runWriteQueue();
    expect(await item(refusedItem.id)).toMatchObject({ state: "given_up", note: NOTE, lastCode: null });
    expect(await row(refused.id)).toMatchObject({ ...ended, flag: null, lastCode: AFTER_ENDING.voidRefused });
    expect(await answeredRow("volunteer.buyout.kept_after_ending", refused.id)).toHaveLength(1);
    await noQueueRows();
    expect(await listed(refused.id)).toMatchObject({ kind: "invoice_stands", invoiceQboId: "9402", here: false, words: EARLIER_WORDS.invoice_stands });
  });

  it("a void found paid as the clear runs leaves its buy-out ended and unflagged, sends nothing, and records it: part paid", async () => {
    // The invoice read before the void finds something paid on it: the void is kept, and the ended buy-out stays so.
    const q = await buyoutFamily(stub);
    const paid = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Paid meanwhile" }), familyQboId: FAMILY, chosenBy: q.identity.parentId, state: "being_voided", invoiceQboId: "9403" });
    const paidItem = await voidFor(paid, { balance: 40 });
    clearAsItArrives("GET");
    await runWriteQueue();
    expect(stub.apiCalls().filter((c) => c.method === "POST")).toEqual([]);
    expect(await item(paidItem.id)).toMatchObject({ state: "given_up", note: NOTE, lastCode: null });
    expect(await row(paid.id)).toMatchObject({ ...ended, flag: null, lastCode: AFTER_ENDING.paid });
    expect(await answeredRow("volunteer.buyout.kept_after_ending", paid.id)).toHaveLength(1);
    await noQueueRows();
    expect(await listed(paid.id)).toMatchObject({ kind: "part_paid", invoiceQboId: "9403" });
  });

  it("a void found paid in full as the clear runs is recorded so: the family paid though it was to be cancelled", async () => {
    const q = await buyoutFamily(stub);
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Paid in full meanwhile" }), familyQboId: FAMILY, chosenBy: q.identity.parentId, state: "being_voided", invoiceQboId: "9406" });
    const queued = await voidFor(b, { balance: 0 });
    clearAsItArrives("GET");
    await runWriteQueue();
    expect(stub.apiCalls().filter((c) => c.method === "POST")).toEqual([]);
    expect(await item(queued.id)).toMatchObject({ state: "given_up", note: NOTE, lastCode: null });
    expect(await row(b.id)).toMatchObject({ ...ended, flag: null, lastCode: AFTER_ENDING.paidInFull });
    expect(await answeredRow("volunteer.buyout.kept_after_ending", b.id)).toHaveLength(1);
    await noQueueRows();
    expect(await listed(b.id)).toMatchObject({ kind: "refund_owed", invoiceQboId: "9406", words: PAID_AFTER_ENDING_WORDS.earlier });
  });

  it("a void whose read finds the invoice gone as the clear runs is recorded so: last seen gone", async () => {
    const q = await buyoutFamily(stub);
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Gone meanwhile" }), familyQboId: FAMILY, chosenBy: q.identity.parentId, state: "being_voided", invoiceQboId: "9407" });
    const queued = await voidFor(b);
    // The invoice is taken out of QuickBooks before the read is answered.
    clearAsItArrives("GET", () => { stub.invoices.length = 0; });
    await runWriteQueue();
    expect(stub.apiCalls().filter((c) => c.method === "POST")).toEqual([]);
    expect(await item(queued.id)).toMatchObject({ state: "given_up", note: NOTE, lastCode: null });
    expect(await row(b.id)).toMatchObject({ ...ended, flag: null, lastCode: AFTER_ENDING.gone });
    expect(await answeredRow("volunteer.buyout.kept_after_ending", b.id)).toHaveLength(1);
    await noQueueRows();
    expect(await listed(b.id)).toMatchObject({ kind: "last_seen_gone", invoiceQboId: "9407", words: EARLIER_WORDS.last_seen_gone });
  });

  it("a void the portal itself refuses after the clear (another company connected) records nothing: one sent before may have gone", async () => {
    const q = await buyoutFamily(stub);
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Sent before" }), familyQboId: FAMILY, chosenBy: q.identity.parentId, state: "being_voided", invoiceQboId: "9408" });
    // An earlier try was sent and timed out: the item is waiting, marked sent, as the worker's claim returns it.
    const queued = await voidFor(b);
    await db.update(writeQueue).set({ sent: true, tries: 1 }).where(eq(writeQueue.id, queued.id));
    const claimed = await item(queued.id);
    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
    // The connection is another company's now, so the client refuses the read before sending anything (other_company).
    await db.update(qboConnection).set({ realmId: "2222" });
    stub.calls.length = 0;
    await sendBuyoutWrite(claimed, new Date(), { mayWait: true });
    expect(stub.apiCalls()).toEqual([]);
    expect(await row(b.id)).toMatchObject({ ...ended, invoiceQboId: "9408", lastCode: null });
    expect(await answeredRow("volunteer.buyout.kept_after_ending", b.id)).toEqual([]);
    expect(await listed(b.id)).toMatchObject({ kind: "void_may_have_gone", invoiceQboId: "9408", words: EARLIER_WORDS.void_may_have_gone });
  });

  // Stage 4's slice M8 (M7b's leftover): a switch away and back, through the connect each time.
  it("a buy-out ended at a switch away stays on the treasurer's list after the switch back, in words for the company connected now, and off the live list", { timeout: 30_000 }, async () => {
    const p = await buyoutFamily(stub);
    const by = p.identity.parentId;
    // An invoiced one whose void QuickBooks refused (flagged for the treasurer), and a paid one.
    const stands = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Standing" }), familyQboId: FAMILY, chosenBy: by, invoiceQboId: "9501", flag: "void_refused" });
    const paidReq = await seedBuyoutRequirement({ title: "Paid before" });
    const paid = await seedBuyout({ requirementId: paidReq, familyQboId: FAMILY, chosenBy: by, invoiceQboId: "9502", state: "paid" });
    expect((await loadBuyoutsToLook()).map((x) => x.id)).toContain(stands.id);
    const staff = await seedStaff({ email: "admin@club.org", admin: true });
    const op = { actor: { door: "staff" as const, id: staff.id, label: staff.email }, ip: "203.0.113.9", permission: "Settings.QuickBooks.ReadWrite" };
    const switchTo = async (realmId: string) => {
      await disconnect(op);
      const asked = await beginSwitchConnect(staff.id, op);
      if (!asked.ok) throw new Error("not configured");
      stub.codes.add(`code-${realmId}`);
      expect(await completeConnect({ code: `code-${realmId}`, state: new URL(asked.url).searchParams.get("state"), realmId, error: null }, { staffUserId: staff.id, ...op })).toEqual({ ok: true });
    };
    await switchTo("9130000000000555");
    expect(await row(stands.id)).toMatchObject({ ...ended, realmId: MONEY_REALM, flag: "void_refused" });
    expect(await listed(stands.id)).toMatchObject({ kind: "invoice_stands", here: false, words: EARLIER_WORDS.invoice_stands });
    expect(await row(paid.id)).toMatchObject({ state: "paid" });

    // Back to the first company, as a second switch.
    await switchTo(MONEY_REALM);
    expect(await audits("roster.cleared")).toHaveLength(2);
    // Its company is the roster's again, and it is still the treasurer's: its invoice may stand in the books connected now.
    expect(await listed(stands.id)).toMatchObject({ kind: "invoice_stands", here: true, invoiceQboId: "9501", words: HERE_WORDS.invoice_stands, close: null });
    expect(HERE_WORDS.invoice_stands).toContain("QuickBooks company connected now");
    expect((await loadBuyoutsToLook()).map((x) => x.id)).not.toContain(stands.id);
    const own = (await loadFamilyBuyouts(stands.familyId)).buyouts.find((x) => x.id === stands.id)!;
    expect(own.earlier).toMatchObject({ kind: "invoice_stands", words: HERE_WORDS.invoice_stands });
    expect(own.invoice).toEqual({ kind: "earlier_company", owedCents: null, readAt: null, qboId: "9501", here: true });
    expect(own.close.may).toBe(false);
    // The paid one of this company counts as it always has, and is nobody's to settle.
    expect(await row(paid.id)).toMatchObject({ state: "paid", realmId: MONEY_REALM });
    expect(await listed(paid.id)).toBeNull();
    const facts = await buyoutFacts([paidReq], null, (r, s) => pairKey(r, s));
    expect([...facts.values()]).toEqual([{ state: "paid", invoicePaid: false }]);
    // Reconciliation's section names no single company around a row that is in the company connected now.
    const { prelude } = await prerender((await EarlierCompanyBuyouts({ showAmounts: false }))!);
    const section = (await new Response(prelude).text()).replaceAll("<!-- -->", "");
    expect(section).toMatch(/Ended by a change of QuickBooks company \(\d+\)/);
    expect(section).toContain("In QuickBooks");
    expect(section).toContain("The company connected now: the club switched away and back");
    expect(section).not.toContain("From the earlier QuickBooks company");
    expect(section).not.toContain("In the earlier company");
    expect(section).not.toContain("sent nothing more to the earlier company");
  });

  it("an item the clear gave up before its send sends nothing", async () => {
    const p = await buyoutFamily(stub);
    const creating = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Not yet sent" }), familyQboId: FAMILY, chosenBy: p.identity.parentId, state: "being_invoiced" });
    const voiding = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Void not yet sent" }), familyQboId: FAMILY, chosenBy: p.identity.parentId, state: "being_voided", invoiceQboId: "9404" });
    // Each as the worker's claim returned it, still waiting, before the clear.
    const create = await createFor(creating), voidIt = await voidFor(voiding);
    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
    stub.calls.length = 0;
    expect(await sendBuyoutWrite(create, new Date(), { mayWait: true })).toBe("stuck");
    expect(stub.apiCalls()).toEqual([]);
    expect(await item(create.id)).toMatchObject({ state: "given_up", sent: false });
    // The void reads the invoice first, as every void does, and then sends nothing.
    expect(await sendBuyoutWrite(voidIt, new Date(), { mayWait: true })).toBe("stuck");
    expect(stub.apiCalls().filter((c) => c.method === "POST")).toEqual([]);
    expect(stub.invoices[0]).toMatchObject({ Id: "9404", TotalAmt: 100 });
    expect(await row(creating.id)).toMatchObject(ended);
    expect(await row(voiding.id)).toMatchObject(ended);
    await noQueueRows();
  });

  it("waits for a buy-out write's finish holding the roster lock shared before it clears anything", async () => {
    await buyoutFamily(stub);
    let release!: () => void, holding!: () => void;
    const released = new Promise<void>((r) => { release = r; }), held = new Promise<void>((r) => { holding = r; });
    const finishing = db.transaction(async (tx) => { await tx.execute(sql`select pg_advisory_xact_lock_shared(${ROSTER_LOCK})`); holding(); await released; });
    await held;
    let cleared = false;
    const clearing = clearRosterOfOtherCompany("2222", admin).then((r) => { cleared = true; return r; });
    await untilALockIsAwaited();
    expect(cleared).toBe(false);
    release();
    await finishing;
    expect(await clearing).toBe(true);
  });

  it("'Give up' waits while a change of company holds the roster lock, then finds the item given up and leaves the buy-out ended", async () => {
    const p = await buyoutFamily(stub);
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Given up at that moment" }), familyQboId: FAMILY, chosenBy: p.identity.parentId, state: "being_invoiced" });
    const queued = await createFor(b);
    let goOn!: () => void, holding!: () => void;
    const proceed = new Promise<void>((r) => { goOn = r; }), held = new Promise<void>((r) => { holding = r; });
    // The change of company holds the roster lock alone and has cleared nothing yet when "Give up" starts: only the
    // roster lock can hold "Give up" back (without it, the item would be given up and the buy-out made stuck first).
    const clearing = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
      holding(); await proceed;
      return clearRosterOfOtherCompanyLocked(tx, "2222", admin);
    });
    await held;
    const giving = giveUp(queued.id, "Sorting it out by hand.", staff);
    await untilALockIsAwaited();
    expect(await item(queued.id)).toMatchObject({ state: "waiting" });
    expect(await row(b.id)).toMatchObject({ state: "being_invoiced", flag: null });
    goOn();
    expect(await clearing).toBe(true);
    expect(await giving).toEqual({ ok: false, errors: [expect.stringContaining("no longer waiting")] });
    expect(await item(queued.id)).toMatchObject({ state: "given_up", note: NOTE });
    expect(await row(b.id)).toMatchObject({ ...ended, flag: null });
    expect(await audits("roster.write.given_up")).toEqual([]);
  });

  it("'Give up' past its wait for the roster lock says to try again and changes nothing", { timeout: 40_000 }, async () => {
    const p = await buyoutFamily(stub);
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Busy roster" }), familyQboId: FAMILY, chosenBy: p.identity.parentId, state: "stuck" });
    const queued = await createFor(b);
    await db.update(writeQueue).set({ state: "stuck", nextTryAt: null }).where(eq(writeQueue.id, queued.id));
    let release!: () => void, holding!: () => void;
    const released = new Promise<void>((r) => { release = r; }), held = new Promise<void>((r) => { holding = r; });
    // A roster read holding the lock longer than "Give up" waits.
    const reading = db.transaction(async (tx) => { await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`); holding(); await released; });
    await held;
    expect(await giveUp(queued.id, "Sorting it out by hand.", staff)).toEqual({ ok: false, errors: [GIVE_UP_BUSY] });
    release();
    await reading;
    expect(await item(queued.id)).toMatchObject({ state: "stuck", note: null });
    expect(await row(b.id)).toMatchObject({ state: "stuck", flag: null });
    expect(await audits("roster.write.given_up")).toEqual([]);
  });

  /**
   * The roster lock held exclusively, as a roster read or a change of company holds it, until `release(clear)`: with
   * `clear`, the change of company's clear runs in that transaction first, as a refresh's savepoint would run it.
   */
  const holdRosterLock = async () => {
    let decide!: (clear: boolean) => void, holding!: () => void;
    const letGo = new Promise<boolean>((r) => { decide = r; }), held = new Promise<void>((r) => { holding = r; });
    const done = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
      holding();
      if (await letGo) expect(await clearRosterOfOtherCompanyLocked(tx, "2222", admin)).toBe(true);
    });
    await held;
    return async (clear: boolean) => { decide(clear); await done; };
  };
  /** Postgres' code for an error, through Drizzle's wrapping. */
  const pgCode = (e: unknown): unknown => (typeof e === "object" && e !== null ? (e as { code?: unknown }).code ?? pgCode((e as { cause?: unknown }).cause) : undefined);

  it("a create's finish waits for the roster lock a change of company holds, with the invoice already kept on the item, and then leaves the clear's endings alone", async () => {
    const p = await buyoutFamily(stub);
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Finish waits" }), familyQboId: FAMILY, chosenBy: p.identity.parentId, state: "being_invoiced" });
    const queued = await createFor(b);
    const release = await holdRosterLock();
    const wake = runWriteQueue();
    // QuickBooks has answered, and the finish waits for the lock: nothing of it is done but the invoice kept on the item.
    await untilALockIsAwaited();
    expect(stub.invoices).toHaveLength(1);
    const made = String(stub.invoices[0]!.Id);
    expect(await item(queued.id)).toMatchObject({ state: "waiting", sent: true, resultQboId: made });
    expect(await row(b.id)).toMatchObject({ state: "being_invoiced", invoiceQboId: null });
    await release(true);
    expect(await wake).toEqual({ ran: true, ok: true });
    expect(await item(queued.id)).toMatchObject({ state: "given_up", note: NOTE, resultQboId: made });
    expect(await row(b.id)).toMatchObject({ ...ended, invoiceQboId: made });
    expect(await audits("volunteer.buyout.invoice_found_after_ending")).toHaveLength(1);
    await noQueueRows();
  });

  it("the worker's create finish waits again past its first wait for the roster lock, and finishes once the lock is free", { timeout: 40_000 }, async () => {
    const p = await buyoutFamily(stub);
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Long read" }), familyQboId: FAMILY, chosenBy: p.identity.parentId, state: "being_invoiced" });
    const queued = await createFor(b);
    const release = await holdRosterLock();
    const wake = runWriteQueue();
    await untilALockIsAwaited();
    // Past the first wait (10 seconds), a roster read still holding the lock.
    await new Promise((r) => setTimeout(r, 11_000));
    expect(await item(queued.id)).toMatchObject({ state: "waiting", resultQboId: String(stub.invoices[0]!.Id) });
    await release(false);
    expect(await wake).toEqual({ ran: true, ok: true });
    expect(await item(queued.id)).toMatchObject({ state: "done", resultQboId: String(stub.invoices[0]!.Id) });
    expect(await row(b.id)).toMatchObject({ state: "invoiced", invoiceQboId: String(stub.invoices[0]!.Id) });
    expect(stub.apiCalls().filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("a guardian's try made at once past its wait for the roster lock leaves the invoice on its item; the worker finishes it without sending again, and a clear keeps it named", { timeout: 60_000 }, async () => {
    const p = await buyoutFamily(stub);
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "At once, busy" }), familyQboId: FAMILY, chosenBy: p.identity.parentId, state: "being_invoiced" });
    const c = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "At once, cleared" }), familyQboId: FAMILY, chosenBy: p.identity.parentId, state: "being_invoiced" });
    const first = await createFor(b);
    let release = await holdRosterLock();
    // The try made at once (mayWait false) fails past its wait (lock_not_available), which the guardian reads as on its way.
    expect(pgCode(await sendBuyoutWrite(first, new Date(), { mayWait: false }).catch((e: unknown) => e))).toBe("55P03");
    const made = String(stub.invoices[0]!.Id);
    expect(await item(first.id)).toMatchObject({ state: "waiting", sent: true, resultQboId: made });
    expect(await row(b.id)).toMatchObject({ state: "being_invoiced", invoiceQboId: null });
    await release(false);
    // The worker looks for the invoice by the buy-out's id, finds it, and sends nothing again.
    expect(await runWriteQueue()).toEqual({ ran: true, ok: true });
    expect(stub.apiCalls().filter((x) => x.method === "POST")).toHaveLength(1);
    expect(await item(first.id)).toMatchObject({ state: "done", resultQboId: made });
    expect(await row(b.id)).toMatchObject({ state: "invoiced", invoiceQboId: made });
    // The same, with a change of company's clear after the read: the item, given up, still names the invoice.
    const second = await createFor(c);
    release = await holdRosterLock();
    expect(pgCode(await sendBuyoutWrite(second, new Date(), { mayWait: false }).catch((e: unknown) => e))).toBe("55P03");
    const madeToo = String(stub.invoices[1]!.Id);
    await release(true);
    expect(await item(second.id)).toMatchObject({ state: "given_up", note: NOTE, sent: true, resultQboId: madeToo });
    expect(await row(c.id)).toMatchObject(ended);
    stub.calls.length = 0;
    await runWriteQueue();
    expect(stub.apiCalls().filter((x) => x.method === "POST")).toEqual([]);
  });

  // Stage 4's slice M7b: what the clear ended or kept, as the treasurer and staff read it. Each case runs the real clear
  // over buy-outs seeded in each state with their queue items, as the portal leaves them.
  /** A queue item of the buy-out's, in the state given; a waiting one isn't due, so no worker's wake would claim it. */
  const itemOf = (b: typeof buyout.$inferSelect, op: "invoice_create" | "invoice_void", o: { state: "waiting" | "stuck" | "done" | "given_up"; sent: boolean; resultQboId?: string }) =>
    db.insert(writeQueue).values({ realmId: b.realmId, familyId: b.familyId, state: o.state, sent: o.sent, resultQboId: o.resultQboId ?? null, nextTryAt: o.state === "waiting" ? later(60) : null,
      request: op === "invoice_create" ? { op, buyoutId: b.id, customerQboId: b.customerQboId, itemQboId: b.itemQboId, units: b.units, unitCents: b.unitCents }
        : { op, buyoutId: b.id, invoiceQboId: b.invoiceQboId!, customerQboId: b.customerQboId, why: "switched_back" } }).returning().then((r) => r[0]!);
  const EARLIER_ENDED = "Ended when the club connected a different QuickBooks company: nothing more was sent to the earlier one";

  it("lists for the treasurer what each buy-out it ended or kept may still leave in the earlier company's books, and nothing of one that leaves nothing", async () => {
    const p = await buyoutFamily(stub);
    const by = p.identity.parentId, familyId = p.identity.familyId;
    const seed = async (title: string, o: Omit<Parameters<typeof seedBuyout>[0], "requirementId" | "familyQboId" | "chosenBy">) =>
      seedBuyout({ requirementId: await seedBuyoutRequirement({ title, appliesTo: o.subjectQboId ? "student" : "family" }), familyQboId: FAMILY, chosenBy: by, ...o });
    // Left something in the old company's books.
    const invoiced = await seed("Invoiced QM71", { subjectQboId: S1, invoiceQboId: "7701" });
    await itemOf(invoiced, "invoice_create", { state: "done", sent: true, resultQboId: "7701" });
    const voiding = await seed("Being voided QM72", { state: "being_voided", invoiceQboId: "7702" });
    await itemOf(voiding, "invoice_create", { state: "done", sent: true, resultQboId: "7702" });
    await itemOf(voiding, "invoice_void", { state: "waiting", sent: true });
    const creating = await seed("Being invoiced QM73", { state: "being_invoiced" });
    await itemOf(creating, "invoice_create", { state: "waiting", sent: true });
    // M7a2's finish held past its wait: the invoice kept on its item before the clear gave the item up, never on the buy-out.
    const heldPast = await seed("Held past its wait QM74", { state: "being_invoiced" });
    await itemOf(heldPast, "invoice_create", { state: "waiting", sent: true, resultQboId: "7704" });
    // As invoiceFoundAfterEnding() leaves one (its end state seeded: the next case drives it): ended, its given-up item and the buy-out both naming the invoice.
    const found = await seed("Found after ending QM75", { state: "voided", invoiceQboId: "7705" });
    await db.update(buyout).set({ endReason: "earlier_company" }).where(eq(buyout.id, found.id));
    await itemOf(found, "invoice_create", { state: "given_up", sent: true, resultQboId: "7705" });
    const refund = await seed("Paid, to be cancelled QM76", { state: "paid", invoiceQboId: "7706", flag: "paid_before_void" });
    await itemOf(refund, "invoice_create", { state: "done", sent: true, resultQboId: "7706" });
    await itemOf(refund, "invoice_void", { state: "done", sent: false });
    // As voidKept() leaves a void whose live read found the invoice gone: stuck, flagged, the code, its item closed on that answer (no note).
    const stuck = await seed("Stuck, flagged QM77", { state: "stuck", invoiceQboId: "7707", flag: "missing" });
    await db.update(buyout).set({ lastCode: "invoice_gone" }).where(eq(buyout.id, stuck.id));
    await itemOf(stuck, "invoice_create", { state: "done", sent: true, resultQboId: "7707" });
    await itemOf(stuck, "invoice_void", { state: "given_up", sent: false });
    // A void on its way as the clear runs: not marked sent before it goes (only a create is), so its item is waiting, unsent.
    const inFlight = await seed("Void on its way QM86", { state: "being_voided", invoiceQboId: "7710" });
    await itemOf(inFlight, "invoice_create", { state: "done", sent: true, resultQboId: "7710" });
    await itemOf(inFlight, "invoice_void", { state: "waiting", sent: false });
    // As voidKept() leaves a void that timed out once and then read the invoice part paid: invoiced, flagged, `paid`, its item closed on that answer, sent kept.
    const partPaid = await seed("Part paid QM87", { state: "invoiced", invoiceQboId: "7711", flag: "paid_before_void" });
    await db.update(buyout).set({ lastCode: "paid" }).where(eq(buyout.id, partPaid.id));
    await itemOf(partPaid, "invoice_create", { state: "done", sent: true, resultQboId: "7711" });
    await itemOf(partPaid, "invoice_void", { state: "given_up", sent: true });
    // As voidKept() leaves a void QuickBooks refused: the invoice stands.
    const voidRefused = await seed("Void refused QM88", { state: "invoiced", invoiceQboId: "7712", flag: "void_refused" });
    await db.update(buyout).set({ lastCode: "fault_6240" }).where(eq(buyout.id, voidRefused.id));
    await itemOf(voidRefused, "invoice_create", { state: "done", sent: true, resultQboId: "7712" });
    await itemOf(voidRefused, "invoice_void", { state: "given_up", sent: false });
    // Left nothing there.
    const paid = await seed("Paid QM78", { state: "paid", invoiceQboId: "7708" });
    await itemOf(paid, "invoice_create", { state: "done", sent: true, resultQboId: "7708" });
    const neverSent = await seed("Never sent QM79", { state: "being_invoiced" });
    await itemOf(neverSent, "invoice_create", { state: "waiting", sent: false });
    const refused = await seed("Refused QM80", { state: "refused", invoiceQboId: null });
    await db.update(buyout).set({ lastCode: "fault_6000" }).where(eq(buyout.id, refused.id));
    await itemOf(refused, "invoice_create", { state: "given_up", sent: true });
    const switchedBack = await seed("Switched back QM81", { state: "voided", invoiceQboId: "7709" });
    await db.update(buyout).set({ endReason: "switched_back" }).where(eq(buyout.id, switchedBack.id));
    await itemOf(switchedBack, "invoice_create", { state: "done", sent: true, resultQboId: "7709" });
    await itemOf(switchedBack, "invoice_void", { state: "done", sent: true });
    // Before the change of company every one of them is the roster's company's: none is listed as an earlier one's but
    // the one seeded as a change of company already ended it (stage 4's slice M8: one ended so is the treasurer's
    // whatever its company, as after a switch away and back).
    expect((await loadEarlierCompanyBuyouts()).map((l) => l.id)).toEqual([found.id]);
    expect((await loadBuyoutsToLook()).map((l) => l.id)).toEqual(expect.arrayContaining([refund.id, stuck.id, refused.id]));

    stub.calls.length = 0;
    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);

    const list = await loadEarlierCompanyBuyouts();
    expect(list.map((l) => l.id).sort()).toEqual([invoiced, voiding, creating, heldPast, found, refund, stuck, inFlight, partPaid, voidRefused].map((b) => b.id).sort());
    const of = (b: typeof buyout.$inferSelect) => list.find((l) => l.id === b.id)!;
    // Named by the app's own records: the roster cache holds none of the old company's customers now.
    expect(of(invoiced)).toMatchObject({ familyId, familyName: RIVERA.family.name, subjectName: RIVERA.students[0]!.name, requirement: "Invoiced QM71", amountCents: 10000,
      realmId: MONEY_REALM, kind: "invoice_stands", invoiceQboId: "7701", madeAfter: false, note: null, words: EARLIER_WORDS.invoice_stands, close: null });
    expect(of(voiding)).toMatchObject({ kind: "void_may_have_gone", invoiceQboId: "7702", subjectName: null, words: EARLIER_WORDS.void_may_have_gone, close: null });
    expect(of(creating)).toMatchObject({ kind: "may_be_made", invoiceQboId: null, note: `${INVOICE_WRITES.notePrefix}${creating.id}`, words: EARLIER_WORDS.may_be_made, close: null });
    expect(of(heldPast)).toMatchObject({ kind: "invoice_stands", invoiceQboId: "7704", madeAfter: true, words: `${EARLIER_WORDS.invoice_stands} ${MADE_AFTER_WORDS}` });
    expect(of(found)).toMatchObject({ kind: "invoice_stands", invoiceQboId: "7705", madeAfter: true });
    expect(of(stuck)).toMatchObject({ kind: "last_seen_gone", invoiceQboId: "7707", words: EARLIER_WORDS.last_seen_gone });
    expect(of(inFlight)).toMatchObject({ kind: "void_may_have_gone", invoiceQboId: "7710", words: EARLIER_WORDS.void_may_have_gone });
    expect(of(partPaid)).toMatchObject({ kind: "part_paid", invoiceQboId: "7711", words: EARLIER_WORDS.part_paid, close: null });
    expect(of(voidRefused)).toMatchObject({ kind: "invoice_stands", invoiceQboId: "7712", madeAfter: false, words: EARLIER_WORDS.invoice_stands });
    // The family's roster page doesn't open until the new company's shape is set, so no row links it.
    expect(list.every((l) => !l.familyPageStands)).toBe(true);
    expect(of(refund)).toMatchObject({ kind: "refund_owed", invoiceQboId: "7706", words: EARLIER_WORDS.refund_owed, close: { may: true, why: "paid_in_full", words: CLOSE_WORDS.paid_in_full } });
    // Every row's season is its requirement's, for the link to the family's season page.
    const seasonId = (await db.select({ seasonId: seasonStep.seasonId }).from(requirement).innerJoin(seasonStep, eq(seasonStep.id, requirement.stepId)).where(eq(requirement.id, invoiced.requirementId)))[0]!.seasonId;
    expect(list.every((l) => l.seasonId === seasonId)).toBe(true);
    // Reconciliation's own list is the roster's company's: none of them, with a kept flag or refused, is listed there.
    expect(await loadBuyoutsToLook()).toEqual([]);

    // One buy-out's words, for staff.
    for (const b of [invoiced, voiding, creating, heldPast, found, stuck, neverSent, inFlight, partPaid, voidRefused]) expect(stateWords(await row(b.id)), b.id).toBe(EARLIER_ENDED);
    expect(stateWords(await row(paid.id))).toBe("Paid instead");
    expect(stateWords(await row(refused.id))).toBe("Refused by QuickBooks: nothing was billed");
    expect(stateWords(await row(switchedBack.id))).toBe("Ended: the family switched back to volunteering, and the invoice was voided");
    // The family's buy-outs page, for a family the clear left with no link: every one listed, each invoice as in the earlier company's books, no figures.
    const page = await loadFamilyBuyouts(familyId);
    expect(page).toMatchObject({ familyQboId: null, familyName: null });
    expect(page.buyouts).toHaveLength(14);
    expect(page.recordName).toBe(RIVERA.family.name);
    const shown = (b: typeof buyout.$inferSelect) => page.buyouts.find((x) => x.id === b.id)!;
    // A student's name is the record's own, never the cache's by the old company's customer id.
    expect(shown(invoiced)).toMatchObject({ subjectName: RIVERA.students[0]!.name });
    expect(shown(invoiced)).toMatchObject({ words: EARLIER_ENDED, invoice: { kind: "earlier_company", qboId: "7701", owedCents: null, readAt: null }, earlier: { kind: "invoice_stands" } });
    expect(shown(heldPast)).toMatchObject({ invoice: { kind: "earlier_company", qboId: "7704" }, earlier: { kind: "invoice_stands", madeAfter: true } });
    expect(shown(creating)).toMatchObject({ invoice: { kind: "earlier_company", owedCents: null, readAt: null }, earlier: { kind: "may_be_made", note: `${INVOICE_WRITES.notePrefix}${creating.id}` } });
    expect(shown(voiding)).toMatchObject({ earlier: { kind: "void_may_have_gone", words: EARLIER_WORDS.void_may_have_gone } });
    expect(shown(paid)).toMatchObject({ words: "Paid instead", invoice: { kind: "earlier_company", qboId: "7708" }, earlier: { kind: "nothing_to_settle" } });
    expect(shown(refund)).toMatchObject({ words: "Paid instead", earlier: { kind: "refund_owed" }, close: { may: true, why: "paid_in_full" } });
    expect(shown(neverSent)).toMatchObject({ invoice: { kind: "none" }, earlier: { kind: "nothing_to_settle" } });
    expect(shown(refused)).toMatchObject({ invoice: { kind: "none" }, earlier: { kind: "nothing_to_settle" } });

    // The refund owed closes as today: in the portal alone, and it leaves the list.
    expect(await closeBuyout(refund.id, closeTag(await row(refund.id)), await currentRosterTag(), "Refunded in the earlier company.", staff)).toEqual({ ok: true, message: CLOSE_COPY.done });
    expect(await row(refund.id)).toMatchObject({ state: "voided", endReason: "closed_by_staff", invoiceQboId: "7706", realmId: MONEY_REALM });
    expect((await loadEarlierCompanyBuyouts()).map((l) => l.id)).not.toContain(refund.id);
    // Nothing of any of it was asked of QuickBooks.
    expect(stub.calls).toEqual([]);
  });

  it("names a family or student whose record has no name in words, and lists nothing while the roster names no company", async () => {
    const p = await buyoutFamily(stub);
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Nameless QM89", appliesTo: "student" }), familyQboId: FAMILY, subjectQboId: S1, chosenBy: p.identity.parentId,
      invoiceQboId: "7713" });
    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
    await db.update(family).set({ name: "  " }).where(eq(family.id, p.identity.familyId));
    await db.update(student).set({ name: null }).where(eq(student.id, b.studentId!));
    expect(await loadEarlierCompanyBuyouts()).toEqual([expect.objectContaining({ id: b.id, kind: "invoice_stands",
      familyName: recordNameWords(null, "family"), subjectName: recordNameWords(null, "student") })]);
    const page = await loadFamilyBuyouts(p.identity.familyId);
    expect(page.recordName).toBe(recordNameWords(null, "family"));
    expect(page.buyouts[0]).toMatchObject({ id: b.id, subjectName: recordNameWords(null, "student") });
    // With no roster company named, neither list says anything of any company's buy-outs.
    await db.delete(setting).where(eq(setting.key, SOURCE_KEY));
    expect(await loadEarlierCompanyBuyouts()).toEqual([]);
    expect(await loadBuyoutsToLook()).toEqual([]);
  });

  it("an invoice QuickBooks makes as the clear runs is listed for the treasurer, made after its change was given up", async () => {
    const p = await buyoutFamily(stub);
    const b = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Made at that moment QM82" }), familyQboId: FAMILY, chosenBy: p.identity.parentId, state: "being_invoiced" });
    await createFor(b);
    clearAsItArrives("POST");
    expect(await runWriteQueue()).toEqual({ ran: true, ok: true });
    const made = String(stub.invoices[0]!.Id);
    expect(await audits("volunteer.buyout.invoice_found_after_ending")).toHaveLength(1);
    expect(await loadEarlierCompanyBuyouts()).toEqual([expect.objectContaining({ id: b.id, kind: "invoice_stands", invoiceQboId: made, madeAfter: true, familyName: RIVERA.family.name })]);
    expect(stateWords(await row(b.id))).toBe(EARLIER_ENDED);
  });

  it("the daily check, after the clear, judges none of the earlier company's buy-outs, and the Health line counts none of their flags", async () => {
    const p = await buyoutFamily(stub);
    const by = p.identity.parentId, familyId = p.identity.familyId;
    const invoiced = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Invoiced QM83" }), familyQboId: FAMILY, chosenBy: by, invoiceQboId: "7801" });
    await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Paid QM84" }), familyQboId: FAMILY, chosenBy: by, state: "paid", invoiceQboId: "7802" });
    await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Flagged QM85" }), familyQboId: FAMILY, chosenBy: by, invoiceQboId: "7803", flag: "missing" });
    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
    const before = await db.select().from(buyout).orderBy(buyout.id);
    expect(before.find((b) => b.id === invoiced.id)).toMatchObject({ state: "voided", endReason: "earlier_company" });
    // A money run of the new company that read the family (its figures kept by its app record), which happen to hold
    // the old invoices' ids, one of them paid: they are the new company's invoices, and say nothing of the old ones.
    await db.insert(jobRun).values({ job: MONEY_JOB, startedAt: new Date(Date.now() - 60_000), finishedAt: new Date(), outcome: "ok", startedBy: "worker" });
    await db.insert(familyMoney).values({ familyId, realmId: "2222", readAt: new Date(), totalCents: 10000, currency: "USD",
      invoices: [stored("7801", FAMILY, { balanceCents: 0 }), stored("7802", FAMILY), stored("7803", FAMILY)] });
    const auditsBefore = (await db.select().from(auditLog)).length;
    expect(await checkBuyoutInvoices()).toEqual({ ran: true, paid: 0, flagged: 0, voided: 0, unflagged: 0 });
    expect(await db.select().from(buyout).orderBy(buyout.id)).toEqual(before);
    expect((await db.select().from(auditLog)).length).toBe(auditsBefore);
    const line = await buyoutCheckLine({ connected: true, needsAdmin: false }, new Date());
    expect(line.notes.join(" ")).not.toContain("flagged and waiting");
  });
});
