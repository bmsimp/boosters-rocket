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
import { auditLog, buyout, familyMoney, jobRun, qboCustomer, writeQueue, type StoredInvoice } from "@/lib/db/schema";
import { checkBuyoutInvoices } from "@/lib/buyouts/daily-check";
import { buyoutFacts } from "@/lib/buyouts/standing";
import { loadBuyoutsToLook } from "@/lib/buyouts/staff";
import { MONEY_JOB } from "@/lib/money/run-keys";
import { runWriteQueue } from "@/lib/roster/queue";
import { afterStudentMoved } from "@/lib/roster/writes";
import { clearRosterOfOtherCompany } from "@/lib/roster/source";
import { resetDb } from "../helpers/db";
import { CHENOWETH, RIVERA, stubInvoice } from "../helpers/money";
import { MONEY_REALM, seedSignedInParent, seedTwoFamilies } from "../helpers/parent";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { buyoutFamily, queueOf, seedBuyout, seedBuyoutRequirement, BUYOUT_ITEM } from "../helpers/buyouts";

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
  await db.insert(familyMoney).values({ familyQboId: FAMILY, ...figures }).onConflictDoUpdate({ target: familyMoney.familyQboId, set: figures });
  return run!;
}

describe("the daily check of buy-out invoices (v1 spec §8.4)", () => {
  it("marks a paid one paid, flags one QuickBooks no longer shows, one on another customer and one whose student moved there, and audits each once", async () => {
    const p = await buyoutFamily(stub);
    const by = p.identity.parentId;
    const reqs: string[] = [];
    for (const title of ["Fine", "Paid", "Gone", "Elsewhere"]) reqs.push(await seedBuyoutRequirement({ title }));
    const perStudent = await seedBuyoutRequirement({ title: "Moved", appliesTo: "student" });
    const fine = await seedBuyout({ requirementId: reqs[0]!, familyQboId: FAMILY, chosenBy: by, invoiceQboId: "9901" });
    const paid = await seedBuyout({ requirementId: reqs[1]!, familyQboId: FAMILY, chosenBy: by, invoiceQboId: "9902" });
    const gone = await seedBuyout({ requirementId: reqs[2]!, familyQboId: FAMILY, chosenBy: by, invoiceQboId: "9903" });
    const elsewhere = await seedBuyout({ requirementId: reqs[3]!, familyQboId: FAMILY, chosenBy: by, invoiceQboId: "9904" });
    const moved = await seedBuyout({ requirementId: perStudent, familyQboId: FAMILY, subjectQboId: S1, chosenBy: by, invoiceQboId: "9905" });
    // The student was moved to another family in QuickBooks, and a refresh read it: the family's read no longer has their invoices.
    await db.update(qboCustomer).set({ parentQboId: CHENOWETH.family.qboId }).where(eq(qboCustomer.qboId, S1));
    await moneyRun([stored("9901", FAMILY), stored("9902", FAMILY, { balanceCents: 0 }), stored("9904", S2)]);

    expect(await checkBuyoutInvoices()).toEqual({ ran: true, paid: 1, flagged: 3 });
    expect(await row(fine.id)).toMatchObject({ state: "invoiced", flag: null });
    expect(await row(paid.id)).toMatchObject({ state: "paid", flag: null });
    expect(await row(gone.id)).toMatchObject({ state: "invoiced", flag: "missing" });
    expect(await row(elsewhere.id)).toMatchObject({ state: "invoiced", flag: "other_customer" });
    expect(await row(moved.id)).toMatchObject({ state: "invoiced", flag: "student_moved" });
    // Nothing is voided by the check, or by a refresh: nothing was sent at all.
    expect(stub.apiCalls()).toEqual([]);
    expect(await audits("volunteer.buyout.flagged")).toHaveLength(3);
    expect(await audits("volunteer.buyout.paid")).toHaveLength(1);
    // Shown on Reconciliation, with the family, the requirement and the amount.
    const look = await loadBuyoutsToLook();
    expect(look.map((l) => [l.requirement, l.flag, l.amountCents, l.familyName])).toEqual(expect.arrayContaining([
      ["Gone", "missing", 10000, RIVERA.family.name], ["Elsewhere", "other_customer", 10000, RIVERA.family.name], ["Moved", "student_moved", 10000, RIVERA.family.name]]));

    // Each run is followed once; a later run with nothing new audits nothing again.
    expect(await checkBuyoutInvoices()).toEqual({ ran: false, paid: 0, flagged: 0 });
    await moneyRun([stored("9901", FAMILY), stored("9904", S2)]);
    expect(await checkBuyoutInvoices()).toEqual({ ran: true, paid: 0, flagged: 0 });
    expect(await audits("volunteer.buyout.flagged")).toHaveLength(3);
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
    // The cache already says the student is under the other family when the follow-ups run (applyWritten).
    await db.update(qboCustomer).set({ parentQboId: CHENOWETH.family.qboId }).where(eq(qboCustomer.qboId, S1));
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
    // The new family's standing holds nothing of it.
    expect(await buyoutFacts([req], [CHENOWETH.family.qboId, S1])).toEqual(new Map());
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
    await db.insert(writeQueue).values({ realmId: MONEY_REALM, request: { op: "invoice_create", buyoutId: b.id, customerQboId: S1, itemQboId: BUYOUT_ITEM, units: 2, unitCents: 5000, familyQboId: FAMILY },
      familyQboId: FAMILY, sent: false, tries: 0, nextTryAt: new Date() });
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

describe("connecting a different company", () => {
  it("deletes every buy-out, counted in the audit row, and their queued writes with the queue", async () => {
    const { a } = await seedTwoFamilies();
    await db.insert(writeQueue).values({ realmId: MONEY_REALM, request: { op: "invoice_void", buyoutId: "00000000-0000-4000-8000-000000000001", invoiceQboId: "9174", customerQboId: a.identity.familyQboId,
      familyQboId: a.identity.familyQboId, why: "switched_back" }, familyQboId: a.identity.familyQboId, sent: false, nextTryAt: new Date() });
    expect((await db.select().from(buyout)).length).toBe(2);
    expect(await clearRosterOfOtherCompany("2222", { actor: { door: "staff", id: null, label: "admin@club.org" }, ip: null })).toBe(true);
    expect(await db.select().from(buyout)).toEqual([]);
    expect(await db.select().from(writeQueue)).toEqual([]);
    const [cleared] = await audits("volunteer.signups.cleared");
    expect(cleared!.after).toMatchObject({ buyouts: 2 });
  });
});
