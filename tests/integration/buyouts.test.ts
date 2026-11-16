import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent, renderPage } from "../helpers/signed-in";

// Buy-out invoices are made and voided in QuickBooks: here that is the stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, buyout, familyMoney, writeQueue } from "@/lib/db/schema";
import { BUYOUT_COPY, confirmMyBuyout } from "@/lib/buyouts/writes";
import { loadMyBuyouts } from "@/lib/buyouts/my-buyouts";
import { loadBuyoutsToLook } from "@/lib/buyouts/staff";
import { loadFamilyMoney } from "@/lib/money/family-money";
import { runWriteQueue } from "@/lib/roster/queue";
import { describeWrite } from "@/lib/roster/queue";
import { confirmBuyoutAction, switchBackAction } from "@/app/(parent)/volunteer/pay-instead/actions";
import VolunteerPage from "@/app/(parent)/volunteer/page";
import PayInsteadPage from "@/app/(parent)/volunteer/pay-instead/[requirementId]/[choice]/page";
import { resetDb } from "../helpers/db";
import { RIVERA } from "../helpers/money";
import { seedFamilyMoney, seedParentIn, type SeededParent } from "../helpers/parent";
import { startQboStub, STUB_PAID_VOID_FAULT, type QboStub } from "../helpers/qbo-stub";
import { BUYOUT_ITEM, buyoutFamily, buyoutsOf, queueOf, seedBuyout, seedBuyoutRequirement } from "../helpers/buyouts";
import { seedOutsideCredit } from "../helpers/volunteer";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

const FAMILY = RIVERA.family.qboId, STUDENT = RIVERA.students[0]!.qboId;
const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const invoicePosts = () => posts().filter((c) => c.path.endsWith("/invoice"));
const ctxOf = (p: SeededParent) => ({ ...p.identity, ip: "203.0.113.50" });
const family = { students: RIVERA.students };
const audits = async (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
/** The choice as the family's page shows it: its key and the stamp of its quote. */
async function shown(p: SeededParent, requirementId: string, key = "family") {
  const all = await loadMyBuyouts({ familyQboId: p.identity.familyQboId, parentId: p.identity.parentId }, family);
  const one = all.find((b) => b.requirementId === requirementId && b.key === key);
  if (!one) throw new Error(`no buy-out choice ${key} for ${requirementId}`);
  return one;
}
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

describe("choosing to pay instead of volunteering (v1 spec §11.5)", () => {
  it("makes one invoice in QuickBooks, for the family, with the item, the amount and the buy-out's id, and no email", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ amount: 3, unitCents: 2500 });
    // A shift already credited: two are left, so the quote is two at $25.00.
    await seedOutsideCredit({ familyQboId: FAMILY, requirementId: req, shifts: 1 });
    await seedFamilyMoney(RIVERA);
    const choice = await shown(p, req);
    expect(choice.quote).toEqual({ ok: true, units: 2, unitCents: 2500, amountCents: 5000 });
    asParent(p.identity);
    const r = await confirmBuyoutAction(req, "family", choice.stamp);
    expect(r).toEqual({ ok: true, message: BUYOUT_COPY.done("$50.00") });
    const [b] = await buyoutsOf(FAMILY);
    expect(b).toMatchObject({ state: "invoiced", subjectQboId: FAMILY, customerQboId: FAMILY, itemQboId: BUYOUT_ITEM, units: 2, unitCents: 2500, amountCents: 5000, invoiceQboId: "5001" });
    expect(invoicePosts()).toHaveLength(1);
    const sent = JSON.parse(invoicePosts()[0]!.body);
    expect(sent).toEqual({ CustomerRef: { value: FAMILY }, PrivateNote: `Booster Rocket buy-out ${b!.id}`, AllowOnlineACHPayment: true, EmailStatus: "NotSet",
      Line: [{ DetailType: "SalesItemLineDetail", Amount: 50, SalesItemLineDetail: { ItemRef: { value: BUYOUT_ITEM }, Qty: 2, UnitPrice: 25 } }] });
    expect(invoicePosts()[0]!.query.get("operation")).toBeNull();
    // Nothing else was sent: no send of the invoice by email, no other write.
    expect(posts()).toHaveLength(1);
    // The family's figures are behind QuickBooks now, so its next page load reads it.
    const [money] = await db.select().from(familyMoney).where(eq(familyMoney.familyQboId, FAMILY));
    expect(money!.staleAt).not.toBeNull();
    // It does: the invoice is then among the family's open invoices, with its own Pay button.
    const after = await loadFamilyMoney(FAMILY);
    expect(after.figures?.current).toBe(true);
    expect(after.figures?.open.map((i) => [i.qboId, i.totalCents, i.payLink])).toEqual([["5001", 5000, "https://connect.intuit.com/t/scs-v1-stub-5001"]]);
    // Audited: the choice, with what was asked for, and the invoice made.
    const [chosen] = await audits("volunteer.buyout.chosen");
    expect(chosen!.after).toMatchObject({ customerQboId: FAMILY, itemQboId: BUYOUT_ITEM, units: 2, unitCents: 2500, amountCents: 5000 });
    expect((await audits("volunteer.buyout.invoiced"))).toHaveLength(1);
    const [item] = await queueOf(b!.id);
    expect(item).toMatchObject({ state: "done", resultQboId: "5001" });
  });

  it("bills a per-student requirement to the student's own customer, and says the student's key, never an id", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ appliesTo: "student", amount: 4, unit: "hours", unitCents: 1200 });
    const all = await loadMyBuyouts({ familyQboId: FAMILY, parentId: p.identity.parentId }, family);
    expect(all.map((b) => b.key)).toEqual(["s1", "s2"]);
    expect(JSON.stringify(all)).not.toContain(STUDENT);
    const choice = all[0]!;
    expect(choice.who).toBe(RIVERA.students[0]!.name);
    asParent(p.identity);
    expect((await confirmBuyoutAction(req, "s1", choice.stamp)).ok).toBe(true);
    expect(JSON.parse(invoicePosts()[0]!.body).CustomerRef).toEqual({ value: STUDENT });
    const [b] = await buyoutsOf(FAMILY);
    expect(b).toMatchObject({ subjectQboId: STUDENT, customerQboId: STUDENT, units: 4, amountCents: 4800 });
  });

  it("refuses a stale quote with the new amount, and a used one, and sends nothing for either", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ amount: 2, unitCents: 5000 });
    const before = await shown(p, req);
    await seedOutsideCredit({ familyQboId: FAMILY, requirementId: req, shifts: 1 });
    asParent(p.identity);
    expect(await confirmBuyoutAction(req, "family", before.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.changed("$50.00")] });
    expect(await buyoutsOf(FAMILY)).toEqual([]);
    expect(posts()).toEqual([]);
    const now = await shown(p, req);
    expect((await confirmBuyoutAction(req, "family", now.stamp)).ok).toBe(true);
    expect(await confirmBuyoutAction(req, "family", now.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.already] });
    expect(invoicePosts()).toHaveLength(1);
    expect(await buyoutsOf(FAMILY)).toHaveLength(1);
  });

  it("refuses a price staff changed since the page was shown, a buy-out switched off, and a requirement already met", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ amount: 2, unitCents: 5000 });
    const choice = await shown(p, req);
    asParent(p.identity);
    const { requirement } = await import("@/lib/db/schema");
    await db.update(requirement).set({ buyoutUnitCents: 6000 }).where(eq(requirement.id, req));
    expect(await confirmBuyoutAction(req, "family", choice.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.changed("$120.00")] });
    await db.update(requirement).set({ buyoutUnitCents: null }).where(eq(requirement.id, req));
    expect(await confirmBuyoutAction(req, "family", choice.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.notFromPage] });
    await db.update(requirement).set({ buyoutUnitCents: 5000 }).where(eq(requirement.id, req));
    await seedOutsideCredit({ familyQboId: FAMILY, requirementId: req, shifts: 2 });
    expect(await confirmBuyoutAction(req, "family", choice.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.met] });
    expect(posts()).toEqual([]);
  });

  it("never tells a family that a student who moved in still has the old family's buy-out", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ appliesTo: "student" });
    // The student was the Chenoweth family's, who chose a buy-out for them; QuickBooks moved them since.
    await seedBuyout({ requirementId: req, familyQboId: "8010", subjectQboId: STUDENT, chosenBy: p.identity.parentId, invoiceQboId: "9977", unitCents: 4321, units: 1 });
    const choice = await shown(p, req, "s1");
    expect(choice).toMatchObject({ buyout: null, may: "choose", standing: "0 of 2 shifts done" });
    asParent(p.identity);
    const r = await confirmBuyoutAction(req, "s1", choice.stamp);
    expect(r).toEqual({ ok: false, errors: [BUYOUT_COPY.cantNow] });
    expect(JSON.stringify(r)).not.toMatch(/43\.21|8010|9977/);
    expect(await buyoutsOf(FAMILY)).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("is rate-limited per parent, and audits the first refusal once", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    asParent(p.identity);
    for (let i = 0; i < 10; i++) expect(await confirmBuyoutAction(req, "family", "a-stamp-that-is-wrong")).toEqual({ ok: false, errors: [BUYOUT_COPY.changed("$100.00")] });
    expect(await confirmBuyoutAction(req, "family", "a-stamp-that-is-wrong")).toEqual({ ok: false, errors: [BUYOUT_COPY.rateLimited] });
    expect(await switchBackAction(req, "family")).toEqual({ ok: false, errors: [BUYOUT_COPY.rateLimited] });
    expect(await audits("volunteer.buyout.limit")).toHaveLength(1);
    expect(posts()).toEqual([]);
  });

  it("refuses arguments that aren't what the page sends", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    asParent(p.identity);
    for (const [id, key, stamp] of [["not-a-uuid", "family", "x"], [req, FAMILY, "x"], [req, "s99", "x"], [req, "family", ""], [req, "family", "x".repeat(65)], [req, { k: 1 }, "x"]] as unknown[][]) {
      expect((await confirmBuyoutAction(id, key, stamp)).ok, JSON.stringify([id, key])).toBe(false);
    }
    expect(await buyoutsOf(FAMILY)).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("is calm when QuickBooks refuses the invoice: nothing is billed, nothing is queued, and staff see it", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    const choice = await shown(p, req);
    stub.invoiceFault = "6000";
    asParent(p.identity);
    expect(await confirmBuyoutAction(req, "family", choice.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.refused] });
    const [b] = await buyoutsOf(FAMILY);
    expect(b).toMatchObject({ state: "refused", lastCode: "fault_6000", invoiceQboId: null });
    expect((await queueOf(b!.id)).map((i) => i.state)).toEqual(["given_up"]);
    expect(await audits("volunteer.buyout.refused")).toHaveLength(1);
    // The family may choose again, and reads that the last try couldn't be set up.
    const again = await shown(p, req);
    expect(again).toMatchObject({ may: "choose", refusedBefore: true, buyout: null });
    expect((await loadBuyoutsToLook()).map((x) => x.state)).toEqual(["refused"]);
  });

  it("refuses at once, and records nothing, when only an Admin can mend the connection", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    const choice = await shown(p, req);
    const { qboConnection } = await import("@/lib/db/schema");
    await db.update(qboConnection).set({ lastError: "Intuit no longer accepts this connection. Connect QuickBooks again. (invalid_grant)" });
    asParent(p.identity);
    expect(await confirmBuyoutAction(req, "family", choice.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.cantNow] });
    expect(await buyoutsOf(FAMILY)).toEqual([]);
    expect(stub.apiCalls()).toEqual([]);
  });
});

describe("the write queue's share of a buy-out", () => {
  it("never makes a second invoice after a lost answer: the customer's invoices are read, and the one carrying the buy-out's id is taken as made", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    const choice = await shown(p, req);
    stub.loseInvoiceAnswer = true;
    asParent(p.identity);
    expect(await confirmBuyoutAction(req, "family", choice.stamp)).toEqual({ ok: true, message: BUYOUT_COPY.waiting("$100.00") });
    await stub.idle();
    const [b] = await buyoutsOf(FAMILY);
    expect(b!.state).toBe("being_invoiced");
    const [waiting] = await queueOf(b!.id);
    expect(waiting).toMatchObject({ state: "waiting", sent: true, tries: 1 });
    // The page reads "being set up", and the guardian can't switch back until the outcome is known.
    expect((await shown(p, req)).standing).toBe("Buy-out being set up");
    expect(await switchBackAction(req, "family")).toEqual({ ok: false, errors: [BUYOUT_COPY.stillMaking] });
    stub.loseInvoiceAnswer = false;
    const r = await runWriteQueue(later(2));
    expect(r).toEqual({ ran: true, ok: true });
    expect(invoicePosts()).toHaveLength(1);
    expect(stub.invoices).toHaveLength(1);
    const [made] = await buyoutsOf(FAMILY);
    expect(made).toMatchObject({ state: "invoiced", invoiceQboId: "5001" });
    expect((await queueOf(b!.id))[0]).toMatchObject({ state: "done", resultQboId: "5001" });
    const [done] = (await audits("roster.write.done"));
    expect(done!.after).toMatchObject({ how: "found" });
  });

  it("sends the invoice again when the read finds it wasn't made, and makes exactly one", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    const choice = await shown(p, req);
    stub.failNext = 1; // a 500 before anything is made: QuickBooks may have acted, as far as the portal can tell
    asParent(p.identity);
    expect((await confirmBuyoutAction(req, "family", choice.stamp)).ok).toBe(true);
    const [b] = await buyoutsOf(FAMILY);
    expect((await queueOf(b!.id))[0]).toMatchObject({ state: "waiting", sent: true, lastCode: "http_500" });
    await runWriteQueue(later(2));
    expect(stub.invoices).toHaveLength(1);
    expect(invoicePosts()).toHaveLength(2);
    // The read came first, through the existing invoice reader, for that customer alone.
    const calls = stub.apiCalls().map((c) => `${c.method} ${c.path.endsWith("/query") ? c.query.get("query") : c.path.split("/").at(-1)}`);
    expect(calls.slice(-2)).toEqual([`GET select * from Invoice where CustomerRef = '${FAMILY}' orderby Id startposition 1 maxresults 1000`, "POST invoice"]);
    expect((await buyoutsOf(FAMILY))[0]!.state).toBe("invoiced");
  });

  it("waits while QuickBooks is busy, and is stuck after the tries run out, for staff to look at", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    const choice = await shown(p, req);
    stub.rateLimitNext = 100;
    asParent(p.identity);
    expect((await confirmBuyoutAction(req, "family", choice.stamp)).ok).toBe(true);
    const [b] = await buyoutsOf(FAMILY);
    expect((await queueOf(b!.id))[0]).toMatchObject({ state: "waiting", sent: false, lastCode: "http_429" });
    await db.update(writeQueue).set({ tries: 7, createdAt: new Date(Date.now() - 3_600_000) }).where(eq(writeQueue.familyQboId, FAMILY));
    await runWriteQueue(later(2));
    expect((await queueOf(b!.id))[0]).toMatchObject({ state: "stuck", tries: 8 });
    expect((await buyoutsOf(FAMILY))[0]!.state).toBe("stuck");
    expect((await shown(p, req)).standing).toBe("Buy-out waiting for the club");
    expect(stub.invoices).toEqual([]);
  });

  it("says what each write is, in words, with the names the cache has", () => {
    const names = new Map([[FAMILY, "Riverquill Family"]]);
    expect(describeWrite({ op: "invoice_create", buyoutId: "b", customerQboId: FAMILY, itemQboId: "1", units: 2, unitCents: 2500, familyQboId: FAMILY }, names))
      .toBe("Invoice Riverquill Family $50.00 for a volunteer buy-out");
    expect(describeWrite({ op: "invoice_void", buyoutId: "b", invoiceQboId: "5001", customerQboId: FAMILY, familyQboId: FAMILY, why: "switched_back" }, names))
      .toBe("Void the volunteer buy-out invoice of Riverquill Family");
  });
});

describe("one buy-out, one invoice, however many confirm at once", () => {
  it("makes one buy-out and one invoice when the same guardian confirms five times at once", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    const choice = await shown(p, req);
    const results = await Promise.all(Array.from({ length: 5 }, () => confirmMyBuyout(ctxOf(p), family, req, "family", choice.stamp)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => !r.ok && r.errors)).toEqual(Array.from({ length: 4 }, () => [BUYOUT_COPY.already]));
    expect(await buyoutsOf(FAMILY)).toHaveLength(1);
    await stub.idle();
    expect(invoicePosts()).toHaveLength(1);
    expect(stub.invoices).toHaveLength(1);
  });

  it("makes one when two guardians of the family confirm at the same moment", async () => {
    const p = await buyoutFamily(stub);
    const other = await seedParentIn({ familyQboId: FAMILY, name: "Remy Riverquill", email: "remy.riverquill@family-r.example" });
    const req = await seedBuyoutRequirement();
    const choice = await shown(p, req);
    const theirs = await shown({ ...p, identity: other.identity }, req);
    expect(theirs.stamp).toBe(choice.stamp);
    const results = await Promise.all([confirmMyBuyout(ctxOf(p), family, req, "family", choice.stamp), confirmMyBuyout({ ...other.identity, ip: null }, family, req, "family", theirs.stamp)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await buyoutsOf(FAMILY)).toHaveLength(1);
    await stub.idle();
    expect(stub.invoices).toHaveLength(1);
  });
});

describe("switching back to volunteering before paying", () => {
  async function invoiced() {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    const choice = await shown(p, req);
    asParent(p.identity);
    expect((await confirmBuyoutAction(req, "family", choice.stamp)).ok).toBe(true);
    return { p, req };
  }

  it("voids the invoice when nothing is paid on it, read live first, and the requirement reads as volunteering again", async () => {
    const { p, req } = await invoiced();
    expect((await shown(p, req)).may).toBe("switch_back");
    expect(await switchBackAction(req, "family")).toEqual({ ok: true, message: BUYOUT_COPY.switched });
    const voids = invoicePosts().filter((c) => c.query.get("operation") === "void");
    expect(voids).toHaveLength(1);
    expect(JSON.parse(voids[0]!.body)).toEqual({ Id: "5001", SyncToken: "0" });
    expect(stub.invoices[0]).toMatchObject({ TotalAmt: 0, Balance: 0 });
    const [b] = await buyoutsOf(FAMILY);
    expect(b).toMatchObject({ state: "voided", endReason: "switched_back" });
    expect(await audits("volunteer.buyout.switch_back")).toHaveLength(1);
    expect(await audits("volunteer.buyout.voided")).toHaveLength(1);
    const now = await shown(p, req);
    expect(now).toMatchObject({ may: "choose", buyout: null, standing: "0 of 2 shifts done" });
  });

  it("never voids a paid or part-paid invoice: the treasurer sorts it out, in QuickBooks", async () => {
    const { req } = await invoiced();
    stub.invoices[0]!.Balance = 40;
    expect(await switchBackAction(req, "family")).toEqual({ ok: false, errors: [BUYOUT_COPY.paidSome] });
    expect(invoicePosts().filter((c) => c.query.get("operation") === "void")).toEqual([]);
    expect((await buyoutsOf(FAMILY))[0]!.state).toBe("invoiced");
  });

  it("keeps the invoice, and flags it, when a payment lands in QuickBooks as the void is sent", async () => {
    const { req } = await invoiced();
    stub.beforeVoid = (inv) => { inv.Balance = 0; };
    expect(await switchBackAction(req, "family")).toEqual({ ok: false, errors: [BUYOUT_COPY.paidSome] });
    const [b] = await buyoutsOf(FAMILY);
    expect(b).toMatchObject({ state: "invoiced", flag: "void_refused", lastCode: `fault_${STUB_PAID_VOID_FAULT}` });
    expect(stub.invoices[0]).toMatchObject({ TotalAmt: 100, Balance: 0 });
  });

  it("goes through the queue when QuickBooks can't be reached for the void, and reads 'being cancelled' meanwhile", async () => {
    const { p, req } = await invoiced();
    stub.onApiRequest = (c) => { if (c.method === "POST") stub.dropApi = true; };
    expect(await switchBackAction(req, "family")).toEqual({ ok: true, message: BUYOUT_COPY.switching });
    await stub.idle();
    stub.dropApi = false; stub.onApiRequest = null;
    expect((await shown(p, req)).standing).toBe("Buy-out being cancelled");
    await runWriteQueue(later(2));
    expect((await buyoutsOf(FAMILY))[0]).toMatchObject({ state: "voided", endReason: "switched_back" });
  });
});

describe("how the requirement reads, on the parent's pages", () => {
  it("reads 'Buy-out invoiced' until the stored figures say its invoice is paid, then 'Paid instead'", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ title: "Concession shifts QR77" });
    await seedBuyout({ requirementId: req, familyQboId: FAMILY, chosenBy: p.identity.parentId, invoiceQboId: "9901" });
    asParent(p.identity);
    expect(await renderPage(VolunteerPage)).toContain("Buy-out invoiced");
    await db.insert(familyMoney).values({ familyQboId: FAMILY, realmId: "9130000000000001", readAt: new Date(), totalCents: 0, currency: "USD",
      invoices: [{ qboId: "9901", number: "9901", customerQboId: FAMILY, forName: null, date: "2026-11-01", dueDate: null, totalCents: 10000, balanceCents: 0, currency: "USD", payLink: null, itemQboIds: [BUYOUT_ITEM] }] });
    const html = await renderPage(VolunteerPage);
    expect(html).toContain("Paid instead");
    const page = await renderPage(PayInsteadPage, { params: { requirementId: req, choice: "family" } });
    expect(page).toContain("Paid instead");
    expect(page).not.toContain("Volunteer instead");
  });

  it("offers the choice with the amount, and its own page says plainly what will happen", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ title: "Parking crew QR78", unitCents: 3150, amount: 2 });
    asParent(p.identity);
    const html = await renderPage(VolunteerPage);
    expect(html).toContain("Pay instead of volunteering ($63.00)");
    const page = await renderPage(PayInsteadPage, { params: { requirementId: req, choice: "family" } });
    for (const words of ["$63.00", "will appear on your Payments page", "volunteering later doesn&#x27;t lower it", "switch back to volunteering until it&#x27;s paid", "Confirm: invoice me $63.00"]) {
      expect(page, words).toContain(words);
    }
    expect(page).not.toContain(FAMILY);
    expect(page).not.toContain(BUYOUT_ITEM);
  });

  it("answers 404 for a requirement or a key that isn't the family's", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ appliesTo: "family" });
    asParent(p.identity);
    const { pageOutcome } = await import("../helpers/signed-in");
    for (const params of [{ requirementId: req, choice: "s1" }, { requirementId: req, choice: FAMILY }, { requirementId: "00000000-0000-4000-8000-000000000000", choice: "family" }]) {
      expect(await pageOutcome(PayInsteadPage, { params }), JSON.stringify(params)).toEqual({ notFound: true });
    }
    await db.delete(buyout);
  });
});
