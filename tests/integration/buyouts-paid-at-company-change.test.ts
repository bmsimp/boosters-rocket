import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent, renderPage } from "../helpers/signed-in";

// Nothing here may reach Intuit: the clear sends nothing, and the stub would show it if it did.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, buyout, familyMoney, jobRun, qboConnection, qboCustomer, qboCustomerType, requirement, setting, writeQueue,
  type StoredInvoice } from "@/lib/db/schema";
import type { AppFamilyId } from "@/lib/families/ids";
import { queueVoid } from "@/lib/buyouts/writes";
import { WORKER_ACTOR } from "@/lib/quickbooks/client";
import { checkBuyoutInvoices } from "@/lib/buyouts/daily-check";
import { loadMyBuyouts } from "@/lib/buyouts/my-buyouts";
import { closeTag, loadBuyoutsToLook, loadEarlierCompanyBuyouts, loadFamilyBuyouts, stateWords } from "@/lib/buyouts/staff";
import { CLOSE_WORDS, EARLIER_WORDS } from "@/lib/buyouts/closing";
import { CLOSE_COPY, closeBuyout } from "@/lib/buyouts/close";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { MONEY_JOB } from "@/lib/money/run-keys";
import { clearRosterOfOtherCompany, SOURCE_KEY } from "@/lib/roster/source";
import VolunteerPage from "@/app/(parent)/volunteer/page";
import { resetDb, untilALockIsAwaited } from "../helpers/db";
import { CHENOWETH, RIVERA } from "../helpers/money";
import { identityNow, MONEY_REALM, seedSignedInParent, type SeededParent } from "../helpers/parent";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { buyoutFamily, queueOf, seedBuyout, seedBuyoutRequirement, BUYOUT_ITEM } from "../helpers/buyouts";
import { recordOfCustomer } from "../helpers/app-records";
import { P_TYPES, storeShape } from "../helpers/roster-cache";

// Stage 4's slice M7b2 (the owner's reading of open question 16, 2026-11-21): at a change of company, an invoiced
// buy-out whose own family's stored figures, of its own company, show its invoice paid is marked paid by the clear
// before it ends the rest (endBuyoutsOfEarlierCompany(), src/lib/buyouts/company-change.ts), so it keeps counting. A
// change of company is still refused until slice M8, so these run the clear directly.

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

const FAMILY = RIVERA.family.qboId, [S1, S2] = RIVERA.students.map((s) => s.qboId) as [string, string];
const admin = { actor: { door: "staff" as const, id: null, label: "admin@club.org" }, ip: null };
const staff = { actor: { door: "staff" as const, id: null, label: "treasurer@club.org" }, ip: null, permission: "Roster.Family.ReadWrite" };
const audits = async (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
/** The `volunteer.buyout.paid` rows of one buy-out, found by action and target. */
const paidRows = async (id: string) => db.select().from(auditLog).where(and(eq(auditLog.action, "volunteer.buyout.paid"), eq(auditLog.targetId, id)));
const row = async (id: string) => (await db.select().from(buyout).where(eq(buyout.id, id)))[0]!;
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const stored = (qboId: string, customerQboId: string, o: Partial<StoredInvoice> = {}): StoredInvoice => ({ qboId, number: qboId, customerQboId, forName: null, date: "2026-11-01", dueDate: "2026-12-01",
  totalCents: 10000, balanceCents: 10000, currency: "USD", payLink: null, itemQboIds: [BUYOUT_ITEM], ...o });
const paidInv = (qboId: string, customerQboId = FAMILY) => stored(qboId, customerQboId, { balanceCents: 0 });
/** A family's stored figures as the daily read left them, kept by its app record: read from MONEY_REALM an hour ago unless said otherwise. */
async function figures(familyQboId: string, invoices: StoredInvoice[] | null, o: { realmId?: string; readAt?: Date | null; staleAt?: Date | null; failedAt?: Date | null } = {}) {
  const values = { realmId: o.realmId ?? MONEY_REALM, readAt: o.readAt === undefined ? ago(60) : o.readAt, invoices, totalCents: 0, currency: "USD",
    staleAt: o.staleAt ?? null, failedAt: o.failedAt ?? null, failedCode: o.failedAt ? "http_500" : null };
  await db.insert(familyMoney).values({ familyId: await recordOfCustomer(familyQboId, "family"), ...values });
}
/** A buy-out of the family's, on a requirement of its own. */
async function buyoutOf(p: SeededParent, title: string, o: Omit<Parameters<typeof seedBuyout>[0], "requirementId" | "familyQboId" | "chosenBy"> & { familyQboId?: string } = {}) {
  return seedBuyout({ requirementId: await seedBuyoutRequirement({ title, appliesTo: o.subjectQboId ? "student" : "family" }), familyQboId: o.familyQboId ?? FAMILY,
    chosenBy: p.identity.parentId, ...o });
}
/** A void queued for the buy-out at some time, as a switch back or a move leaves it once answered. */
const voidItemFor = (b: typeof buyout.$inferSelect) => db.insert(writeQueue).values({ realmId: b.realmId, request: { op: "invoice_void", buyoutId: b.id, invoiceQboId: b.invoiceQboId!,
  customerQboId: b.customerQboId, why: "switched_back" }, familyId: b.familyId, state: "given_up", sent: true, nextTryAt: null });
/** Runs the clear and proves each of these ended as M7a ends one, with no paid row. */
async function clearAndExpectEnded(ids: string[]) {
  const before = new Map((await db.select().from(buyout)).map((b) => [b.id, b]));
  expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
  for (const id of ids) {
    expect(await row(id), id).toEqual({ ...before.get(id)!, state: "voided", endReason: "earlier_company", updatedAt: expect.any(Date) });
    expect(await paidRows(id), id).toEqual([]);
  }
  const [ended] = await audits("volunteer.buyouts.ended");
  expect((ended!.after as { endedIds: string[] }).endedIds).toEqual(expect.arrayContaining(ids));
}

describe("an invoiced buy-out its stored figures show paid, at a change of company", () => {
  it("is marked paid, not ended, its row otherwise as it was, audited once as the clear's, with nothing asked of QuickBooks", async () => {
    const p = await buyoutFamily(stub);
    const b = await buyoutOf(p, "Paid as read QP01", { invoiceQboId: "6101" });
    const unpaid = await buyoutOf(p, "Still owed QP02", { invoiceQboId: "6102" });
    const readAt = ago(90);
    await figures(FAMILY, [paidInv("6101"), stored("6102", FAMILY)], { readAt });
    const was = await row(b.id);
    stub.calls.length = 0;

    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
    // Its customer, item, invoice, company, units, amount and (no) flag as they were; no end reason.
    expect(await row(b.id)).toEqual({ ...was, state: "paid", endReason: null, updatedAt: expect.any(Date) });
    expect(await row(unpaid.id)).toMatchObject({ state: "voided", endReason: "earlier_company" });
    const marked = await paidRows(b.id);
    expect(marked).toHaveLength(1);
    expect(marked[0]).toMatchObject({ door: "staff", actorLabel: "admin@club.org", targetType: "buyout", targetId: b.id, ip: null });
    expect(marked[0]!.before).toEqual({ state: "invoiced" });
    expect(marked[0]!.after).toEqual({ state: "paid", invoiceQboId: "6101", amountCents: 10000, why: "different_company", realmId: MONEY_REALM, figures: "as_stored",
      figuresReadAt: readAt.toISOString(), figuresStaleAt: null });
    // The ended row counts only what it ended; the marked one is among the paid ones kept.
    const [ended] = await audits("volunteer.buyouts.ended");
    expect(ended!.before).toEqual({ realmId: MONEY_REALM, being_invoiced: 0, invoiced: 1, being_voided: 0, stuck: 0 });
    expect(ended!.after).toEqual({ reason: "different_company", realmId: "2222", state: "voided", endReason: "earlier_company", ended: 1, endedIds: [unpaid.id],
      paidKept: 1, sentToQuickBooks: false });
    // The figures are cleared after, as before; nothing was queued or sent.
    expect(await db.select().from(familyMoney)).toEqual([]);
    expect(await queueOf(b.id)).toEqual([]);
    expect(stub.calls).toEqual([]);
  });

  it("ends as today one part paid, voided, not in the figures, of another company than the roster's, or being invoiced, being cancelled or stuck though shown paid", async () => {
    const p = await buyoutFamily(stub);
    const partPaid = await buyoutOf(p, "Part paid QP11", { invoiceQboId: "6201" });
    const voided = await buyoutOf(p, "Voided QP12", { invoiceQboId: "6202" });
    const notThere = await buyoutOf(p, "Not there QP13", { invoiceQboId: "6203" });
    const creating = await buyoutOf(p, "Being invoiced QP14", { state: "being_invoiced", invoiceQboId: "6204" });
    const voiding = await buyoutOf(p, "Being voided QP15", { state: "being_voided", invoiceQboId: "6205" });
    const stuck = await buyoutOf(p, "Stuck QP16", { state: "stuck", invoiceQboId: "6206" });
    // Its own company is not the roster's, though the family's figures (the roster's company's) show the invoice paid.
    const elsewhere = await buyoutOf(p, "Another company QP17", { invoiceQboId: "6207", realmId: "5555" });
    await figures(FAMILY, [stored("6201", FAMILY, { balanceCents: 2500 }), stored("6202", FAMILY, { totalCents: 0, balanceCents: 0 }), paidInv("6204"), paidInv("6205"),
      paidInv("6206"), paidInv("6207")]);
    await clearAndExpectEnded([partPaid, voided, notThere, creating, voiding, stuck, elsewhere].map((b) => b.id));
    expect(await audits("volunteer.buyout.paid")).toEqual([]);
  });

  it("ends as today one whose family's figures are of another company than the buy-out's", async () => {
    const p = await buyoutFamily(stub);
    const b = await buyoutOf(p, "Other figures QP21", { invoiceQboId: "6301" });
    await figures(FAMILY, [paidInv("6301")], { realmId: "7777" });
    await clearAndExpectEnded([b.id]);
  });

  it("ends as today one whose family has no figures", async () => {
    const p = await buyoutFamily(stub);
    const none = await buyoutOf(p, "No figures QP31", { invoiceQboId: "6401" });
    await clearAndExpectEnded([none.id]);
  });

  it("ends as today one whose family's figures hold no invoices (its first read failed)", async () => {
    const p = await buyoutFamily(stub);
    const empty = await buyoutOf(p, "No invoices QP32", { invoiceQboId: "6402" });
    await figures(FAMILY, null, { readAt: null, failedAt: ago(5) });
    await clearAndExpectEnded([empty.id]);
  });

  it("ends as today one whose invoice another family's figures show paid: only its own family's count", async () => {
    const p = await buyoutFamily(stub);
    await seedSignedInParent(CHENOWETH);
    const b = await buyoutOf(p, "Another family's figures QP41", { invoiceQboId: "6501" });
    await figures(FAMILY, [stored("6599", FAMILY)]);
    await figures(CHENOWETH.family.qboId, [paidInv("6501", CHENOWETH.family.qboId)]);
    await clearAndExpectEnded([b.id]);
  });

  it.each([
    { what: "read 400 days ago", o: { readAt: ago(400 * 24 * 60) } },
    { what: "marked behind since they were read", o: { readAt: ago(120), staleAt: ago(30) } },
    { what: "whose last read failed", o: { readAt: ago(3 * 24 * 60), failedAt: ago(10) } },
  ])("counts figures as stored, whatever their age: $what", async ({ o }) => {
    const p = await buyoutFamily(stub);
    const b = await buyoutOf(p, "As stored QP51", { invoiceQboId: "6601" });
    await figures(FAMILY, [paidInv("6601")], o);
    const [money] = await db.select().from(familyMoney);
    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
    expect(await row(b.id)).toMatchObject({ state: "paid", endReason: null });
    const [marked] = await paidRows(b.id);
    expect(marked!.after).toMatchObject({ figures: "as_stored", figuresReadAt: money!.readAt!.toISOString(), figuresStaleAt: money!.staleAt?.toISOString() ?? null });
  });

  it("takes off the daily check's own flags and keeps a void's or a move's, which then read as a refund owed and close", async () => {
    const p = await buyoutFamily(stub);
    const missing = await buyoutOf(p, "Flagged missing QP61", { invoiceQboId: "6701", flag: "missing" });
    // The check's own student_moved: no void ever tried, no code.
    const ownMoved = await buyoutOf(p, "Moved by the check QP62", { subjectQboId: S1, invoiceQboId: "6702", flag: "student_moved" });
    // A void that read the invoice part paid, before it was paid in full.
    const beforeVoid = await buyoutOf(p, "Paid before its void QP63", { invoiceQboId: "6703", flag: "paid_before_void" });
    await db.update(buyout).set({ lastCode: "paid" }).where(eq(buyout.id, beforeVoid.id));
    await voidItemFor(beforeVoid);
    // A move's student_moved: a void was queued beside it.
    const voidMoved = await buyoutOf(p, "Moved with a void QP64", { subjectQboId: S2, invoiceQboId: "6704", flag: "student_moved" });
    await voidItemFor(voidMoved);
    await figures(FAMILY, ["6701", "6702", "6703", "6704"].map((id) => paidInv(id)));
    const was = new Map((await db.select().from(buyout)).map((b) => [b.id, b]));

    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
    for (const b of [missing, ownMoved]) {
      expect(await row(b.id)).toEqual({ ...was.get(b.id)!, state: "paid", flag: null, flaggedAt: null, updatedAt: expect.any(Date) });
      const [marked] = await paidRows(b.id);
      expect(marked!.before).toEqual({ state: "invoiced", flag: b.flag });
      expect(marked!.after).toMatchObject({ state: "paid", flag: null });
    }
    for (const b of [beforeVoid, voidMoved]) {
      expect(await row(b.id)).toEqual({ ...was.get(b.id)!, state: "paid", updatedAt: expect.any(Date) });
      const [marked] = await paidRows(b.id);
      expect(marked!.before).toEqual({ state: "invoiced" });
      expect(marked!.after).not.toHaveProperty("flag");
    }
    // For the treasurer: the kept flags are refunds owed, closable; the others leave nothing to settle.
    const list = await loadEarlierCompanyBuyouts();
    expect(list.map((l) => l.id).sort()).toEqual([beforeVoid.id, voidMoved.id].sort());
    for (const l of list) expect(l).toMatchObject({ kind: "refund_owed", words: EARLIER_WORDS.refund_owed, close: { may: true, why: "paid_in_full", words: CLOSE_WORDS.paid_in_full } });
    for (const b of [beforeVoid, voidMoved]) {
      expect(await closeBuyout(b.id, closeTag(await row(b.id)), await currentRosterTag(), "Refunded in the earlier company.", staff)).toEqual({ ok: true, message: CLOSE_COPY.done });
      expect(await row(b.id)).toMatchObject({ state: "voided", endReason: "closed_by_staff", realmId: MONEY_REALM });
    }
    expect(await loadEarlierCompanyBuyouts()).toEqual([]);
  });
});

describe("what runs beside the mark", () => {
  it("a void queued at that moment commits first: its buy-out is being voided, so it ends as today and is not marked", async () => {
    const p = await buyoutFamily(stub);
    const b = await buyoutOf(p, "Racing QP71", { invoiceQboId: "6801" });
    await figures(FAMILY, [paidInv("6801")]);
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
    expect(await row(b.id)).toMatchObject({ state: "voided", endReason: "earlier_company", invoiceQboId: "6801" });
    expect(await paidRows(b.id)).toEqual([]);
    expect(await queueOf(b.id)).toEqual([expect.objectContaining({ id: item!.id, state: "given_up" })]);
    expect((await audits("volunteer.buyouts.ended"))[0]!.before).toEqual({ realmId: MONEY_REALM, being_invoiced: 0, invoiced: 0, being_voided: 1, stuck: 0 });
  });

  it("a void that waits for the clear's row lock finds the buy-out paid and queues nothing", async () => {
    const p = await buyoutFamily(stub);
    const b = await buyoutOf(p, "Waiting QP72", { invoiceQboId: "6802" });
    await figures(FAMILY, [paidInv("6802")]);
    // Holds the family's figures, so the clear stops at their delete, after it has marked the buy-out paid under its row lock.
    let release!: () => void, locked!: () => void;
    const free = new Promise<void>((r) => { release = r; }), holding = new Promise<void>((r) => { locked = r; });
    const holder = db.transaction(async (tx) => {
      await tx.select().from(familyMoney).for("update");
      locked(); await free;
    });
    await holding;
    const clearing = clearRosterOfOtherCompany("2222", admin);
    await untilALockIsAwaited();
    // The guardian's page was drawn before: it still holds the buy-out as invoiced.
    const voiding = db.transaction((tx) => queueVoid(tx, b, "switched_back", { actor: WORKER_ACTOR, label: "a guardian", nextTryAt: later(5) }));
    await untilALockIsAwaited(15_000, 2);
    release();
    await holder;
    expect(await clearing).toBe(true);
    expect(await voiding).toBeNull();
    expect(await row(b.id)).toMatchObject({ state: "paid", endReason: null });
    expect(await queueOf(b.id)).toEqual([]);
    expect(await audits("volunteer.buyout.switch_back")).toEqual([]);
    expect(await paidRows(b.id)).toHaveLength(1);
  });

  it("one the daily check marked paid first is not marked or audited again", async () => {
    const p = await buyoutFamily(stub);
    const b = await buyoutOf(p, "Checked first QP73", { invoiceQboId: "6803" });
    await db.insert(jobRun).values({ job: MONEY_JOB, startedAt: ago(1), finishedAt: new Date(), outcome: "ok", startedBy: "worker" });
    await figures(FAMILY, [paidInv("6803")], { readAt: new Date() });
    expect(await checkBuyoutInvoices()).toMatchObject({ ran: true, paid: 1 });
    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
    const rows = await paidRows(b.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ door: WORKER_ACTOR.door });
    expect(rows[0]!.after).toHaveProperty("runId");
    expect(await row(b.id)).toMatchObject({ state: "paid", endReason: null });
  });
});

describe("a buy-out marked paid at the clear, after it", () => {
  /**
   * The new company connected and its roster read, and the family linked again there, as the accounting links screen
   * leaves it: its customer, the shape, and the requirements' product chosen again.
   */
  async function linkAgain(familyId: AppFamilyId, customerId: string, name: string) {
    await db.update(qboConnection).set({ realmId: "2222" });
    await db.insert(qboCustomerType).values(P_TYPES.map((t) => ({ ...t, active: true })));
    await db.insert(qboCustomer).values({ qboId: customerId, displayName: name, active: true, parentQboId: null, typeQboId: "F", syncToken: "0" });
    await storeShape();
    await db.insert(accountingLink).values({ system: "quickbooks", realmId: "2222", customerId, familyId, origin: "confirmed" });
    await db.update(requirement).set({ itemQboId: BUYOUT_ITEM }).where(eq(requirement.kind, "volunteer"));
  }

  it("reads Paid instead and met for the family, with no new choice, and paid with nothing to settle for staff; the new company's figures and check change nothing", async () => {
    const p = await buyoutFamily(stub);
    const b = await buyoutOf(p, "Marked QP81", { invoiceQboId: "6901" });
    await figures(FAMILY, [paidInv("6901")]);
    asParent(p.identity);
    expect(await renderPage(VolunteerPage)).toContain("Paid instead");

    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(true);
    const identity = await identityNow(p.session.id);
    asParent(identity);
    const volunteer = await renderPage(VolunteerPage);
    expect(volunteer).toContain("Paid instead");
    expect(volunteer).not.toContain("Buy-out invoiced");

    // For staff: paid, its invoice in the earlier company's books, nothing to settle, on neither list.
    const marked = await row(b.id);
    expect(stateWords(marked)).toBe("Paid instead");
    const page = await loadFamilyBuyouts(p.identity.familyId);
    expect(page.buyouts.find((x) => x.id === b.id)).toMatchObject({ words: "Paid instead", invoice: { kind: "earlier_company", qboId: "6901" }, earlier: { kind: "nothing_to_settle" } });
    expect((await loadEarlierCompanyBuyouts()).map((l) => l.id)).not.toContain(b.id);
    expect((await loadBuyoutsToLook()).map((l) => l.id)).not.toContain(b.id);

    // The new company's money run holds an invoice of the same id, unpaid: it is another company's, and the check, which
    // reads only the roster's company's invoiced buy-outs, changes nothing and audits nothing.
    await linkAgain(p.identity.familyId, "8801", RIVERA.family.name);
    await db.insert(jobRun).values({ job: MONEY_JOB, startedAt: ago(1), finishedAt: new Date(), outcome: "ok", startedBy: "worker" });
    await db.insert(familyMoney).values({ familyId: p.identity.familyId, realmId: "2222", readAt: new Date(), totalCents: 10000, currency: "USD", invoices: [stored("6901", "8801")] });
    const rowsBefore = await db.select().from(buyout).orderBy(buyout.id);
    const auditsBefore = (await db.select().from(auditLog)).length;
    expect(await checkBuyoutInvoices()).toEqual({ ran: true, paid: 0, flagged: 0, voided: 0, unflagged: 0 });
    expect(await db.select().from(buyout).orderBy(buyout.id)).toEqual(rowsBefore);
    expect((await db.select().from(auditLog)).length).toBe(auditsBefore);

    // The family, linked again: it still counts, with nothing to choose, and nothing ended for the company.
    const mine = (await loadMyBuyouts({ familyId: identity.familyId, parentId: identity.parentId })).find((x) => x.requirementId === b.requirementId && x.key === "family");
    expect(mine).toMatchObject({ standing: "Paid instead", met: true, may: "nothing", buyout: { state: "paid" }, endedForCompany: false });
  });
});

describe("no change of company", () => {
  it("marks nothing for the same company again, or while the roster names no company", async () => {
    const p = await buyoutFamily(stub);
    const b = await buyoutOf(p, "Same company QP91", { invoiceQboId: "7001" });
    await figures(FAMILY, [paidInv("7001")]);
    const was = await row(b.id);
    expect(await clearRosterOfOtherCompany(MONEY_REALM, admin)).toBe(false);
    expect(await row(b.id)).toEqual(was);
    await db.delete(setting).where(eq(setting.key, SOURCE_KEY));
    expect(await clearRosterOfOtherCompany("2222", admin)).toBe(false);
    expect(await row(b.id)).toEqual(was);
    expect(await audits("volunteer.buyout.paid")).toEqual([]);
    expect(await audits("volunteer.buyouts.ended")).toEqual([]);
  });
});
