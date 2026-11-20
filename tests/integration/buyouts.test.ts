import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent, renderPage, withoutIds } from "../helpers/signed-in";

// Buy-out invoices are made and voided in QuickBooks: here that is the stub, never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { env } from "@/env";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, buyout, familyMoney, qboCustomer, qboCustomerType, setting, writeQueue } from "@/lib/db/schema";
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
import { seedCheckIn, seedEvent, seedOutsideCredit, seedShift, seedSignup } from "../helpers/volunteer";
import { addToCache, stu } from "../helpers/roster-cache";
import { SHAPE_KEY } from "@/lib/roster/shape";
import { recordOfCustomer, subjectColumns, syncAppRecords } from "../helpers/app-records";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

const FAMILY = RIVERA.family.qboId, STUDENT = RIVERA.students[0]!.qboId;
const posts = () => stub.apiCalls().filter((c) => c.method === "POST");
const invoicePosts = () => posts().filter((c) => c.path.endsWith("/invoice"));
const ctxOf = (p: SeededParent) => ({ ...p.identity, ip: "203.0.113.50" });
const audits = async (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
/** The choice as the family's page shows it: its key and the stamp of its quote. */
async function shown(p: SeededParent, requirementId: string, key = "family") {
  const all = await loadMyBuyouts({ familyId: p.identity.familyId, parentId: p.identity.parentId });
  const one = all.find((b) => b.requirementId === requirementId && b.key === key);
  if (!one) throw new Error(`no buy-out choice ${key} for ${requirementId}`);
  return one;
}
/** Switching back as the page's form does: with the stamp of the subject the page shows (subjectStamp()). */
async function switchBack(p: SeededParent, requirementId: string, key = "family") {
  return switchBackAction(requirementId, key, (await shown(p, requirementId, key)).subjectStamp);
}
const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
/** What the buy-out's and the queue's audit rows say, before and after, as one string. */
const buyoutAuditBodies = async () => JSON.stringify((await db.select({ action: auditLog.action, before: auditLog.before, after: auditLog.after }).from(auditLog))
  .filter((r) => /^(volunteer\.buyout|roster\.write)\./.test(r.action)));
/** The bill-to address of each invoice the portal asked QuickBooks to make, in order. */
const billedTo = () => invoicePosts().filter((c) => c.query.get("operation") === null).map((c) => (JSON.parse(c.body) as { BillEmail?: { Address?: string } }).BillEmail?.Address ?? null);

describe("choosing to pay instead of volunteering (v1 spec §11.5)", () => {
  it("makes one invoice in QuickBooks, for the family, with the item, the amount, the buy-out's id and the chooser's address, and emails nothing", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ amount: 3, unitCents: 2500 });
    // A shift already credited: two are left, so the quote is two at $25.00.
    await seedOutsideCredit({ familyQboId: FAMILY, requirementId: req, shifts: 1 });
    await seedFamilyMoney(RIVERA);
    const choice = await shown(p, req);
    expect(choice.quote).toEqual({ ok: true, units: 2, unitCents: 2500, amountCents: 5000 });
    asParent(p.identity);
    const r = await confirmBuyoutAction(req, "family", choice.subjectStamp, choice.stamp);
    expect(r).toEqual({ ok: true, message: BUYOUT_COPY.done("$50.00") });
    const [b] = await buyoutsOf(FAMILY);
    expect(b).toMatchObject({ state: "invoiced", subjectQboId: FAMILY, customerQboId: FAMILY, itemQboId: BUYOUT_ITEM, units: 2, unitCents: 2500, amountCents: 5000, invoiceQboId: "5001" });
    // It names the app's own family that chose it, and no student: the family is its subject.
    expect(b).toMatchObject({ familyId: await recordOfCustomer(FAMILY, "family"), studentId: null });
    expect(invoicePosts()).toHaveLength(1);
    const sent = JSON.parse(invoicePosts()[0]!.body);
    // The bill-to address is the confirming guardian's own sign-in address (the owner's decision of 2026-11-17), and
    // the email status stays not set, so nothing is emailed.
    expect(p.identity.email).toBe(RIVERA.parent.email);
    expect(sent).toEqual({ CustomerRef: { value: FAMILY }, PrivateNote: `Booster Rocket buy-out ${b!.id}`, AllowOnlineACHPayment: true, EmailStatus: "NotSet",
      BillEmail: { Address: RIVERA.parent.email },
      Line: [{ DetailType: "SalesItemLineDetail", Amount: 50, SalesItemLineDetail: { ItemRef: { value: BUYOUT_ITEM }, Qty: 2, UnitPrice: 25 } }] });
    expect(invoicePosts()[0]!.query.get("operation")).toBeNull();
    // Nothing else was sent: no send of the invoice by email, no other write.
    expect(posts()).toHaveLength(1);
    // The family's figures are behind QuickBooks now, so its next page load reads it.
    const [money] = await db.select().from(familyMoney).where(eq(familyMoney.familyId, await recordOfCustomer(FAMILY, "family")));
    expect(money!.staleAt).not.toBeNull();
    // It does: the invoice is then among the family's open invoices, with its Pay link. The sandbox gave a link only to
    // an invoice carrying a bill-to email address (2026-11-17; the stub's quirks.linkNeedsEmail), and this one carries one.
    const after = await loadFamilyMoney(p.identity.familyId);
    expect(after.figures?.current).toBe(true);
    expect(after.figures?.open.map((i) => [i.qboId, i.totalCents, i.payLink ?? null])).toEqual([["5001", 5000, "https://connect.intuit.com/t/scs-v1-stub-5001"]]);
    // The address is in no audit row's before or after (the actor is the guardian, as on every row a parent's action writes).
    expect(await buyoutAuditBodies()).not.toContain(RIVERA.parent.email);
    // Audited: the choice, with what was asked for, and the invoice made.
    const [chosen] = await audits("volunteer.buyout.chosen");
    expect(chosen!.after).toMatchObject({ customerQboId: FAMILY, itemQboId: BUYOUT_ITEM, units: 2, unitCents: 2500, amountCents: 5000,
      familyId: String(await recordOfCustomer(FAMILY, "family")), studentId: null });
    expect((await audits("volunteer.buyout.invoiced"))).toHaveLength(1);
    const [item] = await queueOf(b!.id);
    expect(item).toMatchObject({ state: "done", resultQboId: "5001" });
  });

  it("bills a per-student requirement to the student's own customer, and says the student's key, never an id", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ appliesTo: "student", amount: 4, unit: "hours", unitCents: 1200 });
    const all = await loadMyBuyouts({ familyId: p.identity.familyId, parentId: p.identity.parentId });
    expect(all.map((b) => b.key)).toEqual(["s1", "s2"]);
    expect(JSON.stringify(all)).not.toContain(STUDENT);
    const choice = all[0]!;
    expect(choice.who).toBe(RIVERA.students[0]!.name);
    asParent(p.identity);
    expect((await confirmBuyoutAction(req, "s1", choice.subjectStamp, choice.stamp)).ok).toBe(true);
    expect(JSON.parse(invoicePosts()[0]!.body).CustomerRef).toEqual({ value: STUDENT });
    const [b] = await buyoutsOf(FAMILY);
    expect(b).toMatchObject({ subjectQboId: STUDENT, customerQboId: STUDENT, units: 4, amountCents: 4800 });
    expect(b).toMatchObject({ familyId: await recordOfCustomer(FAMILY, "family"), studentId: await recordOfCustomer(STUDENT, "student") });
  });

  it("refuses a stale quote with the new amount, and a used one, and sends nothing for either", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ amount: 2, unitCents: 5000 });
    const before = await shown(p, req);
    await seedOutsideCredit({ familyQboId: FAMILY, requirementId: req, shifts: 1 });
    asParent(p.identity);
    expect(await confirmBuyoutAction(req, "family", before.subjectStamp, before.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.changed("$50.00")] });
    expect(await buyoutsOf(FAMILY)).toEqual([]);
    expect(posts()).toEqual([]);
    const now = await shown(p, req);
    expect((await confirmBuyoutAction(req, "family", now.subjectStamp, now.stamp)).ok).toBe(true);
    expect(await confirmBuyoutAction(req, "family", now.subjectStamp, now.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.already] });
    expect(invoicePosts()).toHaveLength(1);
    expect(await buyoutsOf(FAMILY)).toHaveLength(1);
  });

  it("refuses a quote stamped the old way, by the QuickBooks ids it billed, with the price-changed words, and a page drawn before the subject's stamp with the reload words, nothing queued", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ amount: 2, unitCents: 5000 });
    const now = await shown(p, req);
    // The stamp a page drawn before the session carried the app's family was given: it sealed the family's customer.
    const old = createHmac("sha256", env.BETTER_AUTH_SECRET).update(`buyout-quote:${FAMILY}|${req}|${FAMILY}|${BUYOUT_ITEM}|5000|2|10000`).digest("base64url").slice(0, 22);
    expect(old).not.toBe(now.stamp);
    asParent(p.identity);
    expect(await confirmBuyoutAction(req, "family", now.subjectStamp, old)).toEqual({ ok: false, errors: [BUYOUT_COPY.changed("$100.00")] });
    // A page drawn before the subject's stamp bound three values: its quote stamp arrives as the subject's, and no
    // quote stamp comes at all. That is the reload words, said before any stamp is compared.
    expect(await (confirmBuyoutAction as (...a: unknown[]) => Promise<unknown>)(req, "family", old)).toEqual({ ok: false, errors: [BUYOUT_COPY.notFromPage] });
    expect(await buyoutsOf(FAMILY)).toEqual([]);
    expect(await db.select().from(writeQueue)).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("refuses a student's key that has come to name another student since the page was shown, never billing the wrong one", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ appliesTo: "student", amount: 2, unitCents: 5000 });
    // Romilly's choice as her page showed it: the second of the family's students by name.
    const romilly = await shown(p, req, "s2");
    expect(romilly.who).toBe(RIVERA.students[1]!.name);
    // A student joins the family whose name comes first: the keys now follow the new list, and "s2" names Rafferty.
    await addToCache([stu("7019", "Abner Riverquill", FAMILY)]);
    expect((await shown(p, req, "s2")).who).toBe(RIVERA.students[0]!.name);
    asParent(p.identity);
    // The subject is checked first: the reload words, never the price-changed ones for the student the key names now.
    expect(await confirmBuyoutAction(req, "s2", romilly.subjectStamp, romilly.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.notFromPage] });
    expect(await buyoutsOf(FAMILY)).toEqual([]);
    expect(await db.select().from(writeQueue)).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("answers a confirm from a page whose key a sibling's rename has moved with the reload words, billing and queueing nothing", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ appliesTo: "student", amount: 2, unitCents: 5000 });
    // Rafferty's choice as his page showed it: the first of the family's students by name.
    const rafferty = await shown(p, req, "s1");
    expect(rafferty.who).toBe(RIVERA.students[0]!.name);
    // Romilly's record is renamed so she sorts first (here by importing a cache that names her so, as a staff rename leaves it).
    await db.update(qboCustomer).set({ displayName: "Abigail Riverquill" }).where(eq(qboCustomer.qboId, RIVERA.students[1]!.qboId));
    await syncAppRecords();
    const now = await shown(p, req, "s1");
    expect(now.who).toBe("Abigail Riverquill");
    expect(now.quote).toEqual(rafferty.quote); // the same price: only the subject differs
    asParent(p.identity);
    expect(await confirmBuyoutAction(req, "s1", rafferty.subjectStamp, rafferty.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.notFromPage] });
    expect(await buyoutsOf(FAMILY)).toEqual([]);
    expect(await db.select().from(writeQueue)).toEqual([]);
    expect(posts()).toEqual([]);
    // Rafferty's choice, from a page drawn now, still goes through, for him.
    const again = await shown(p, req, "s2");
    expect(again.who).toBe(RIVERA.students[0]!.name);
    expect((await confirmBuyoutAction(req, "s2", again.subjectStamp, again.stamp)).ok).toBe(true);
    expect(JSON.parse(invoicePosts()[0]!.body).CustomerRef).toEqual({ value: STUDENT });
  });

  it("refuses a price staff changed since the page was shown, a buy-out switched off, and a requirement already met", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ amount: 2, unitCents: 5000 });
    const choice = await shown(p, req);
    asParent(p.identity);
    const { requirement } = await import("@/lib/db/schema");
    await db.update(requirement).set({ buyoutUnitCents: 6000 }).where(eq(requirement.id, req));
    expect(await confirmBuyoutAction(req, "family", choice.subjectStamp, choice.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.changed("$120.00")] });
    await db.update(requirement).set({ buyoutUnitCents: null }).where(eq(requirement.id, req));
    expect(await confirmBuyoutAction(req, "family", choice.subjectStamp, choice.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.notFromPage] });
    await db.update(requirement).set({ buyoutUnitCents: 5000 }).where(eq(requirement.id, req));
    await seedOutsideCredit({ familyQboId: FAMILY, requirementId: req, shifts: 2 });
    expect(await confirmBuyoutAction(req, "family", choice.subjectStamp, choice.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.met] });
    expect(posts()).toEqual([]);
  });

  it("offers no choice that could never be set up for a student who moved in with the old family's buy-out, and never says why", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ appliesTo: "student", title: "Concession shifts QR79" });
    // The student was the Chenoweth family's, who chose a buy-out for them; QuickBooks moved them since.
    const before = await shown(p, req, "s1");
    await seedBuyout({ requirementId: req, familyQboId: "8010", subjectQboId: STUDENT, chosenBy: p.identity.parentId, invoiceQboId: "9977", unitCents: 4321, units: 1 });
    const all = await loadMyBuyouts({ familyId: p.identity.familyId, parentId: p.identity.parentId });
    expect(all.map((b) => b.key)).toEqual(["s2"]);
    asParent(p.identity);
    const html = await renderPage(VolunteerPage);
    expect(withoutIds(html)).not.toMatch(/43\.21|8010|9977|\$86\.42/);
    const { pageOutcome } = await import("../helpers/signed-in");
    expect(await pageOutcome(PayInsteadPage, { params: { requirementId: req, choice: "s1" } })).toEqual({ notFound: true });
    // A confirm sent with a stamp from before is refused as not from the page, telling nothing of the other family.
    const r = await confirmBuyoutAction(req, "s1", before.subjectStamp, before.stamp);
    expect(r).toEqual({ ok: false, errors: [BUYOUT_COPY.notFromPage] });
    expect(JSON.stringify(r)).not.toMatch(/43\.21|8010|9977/);
    expect(await buyoutsOf(FAMILY)).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("offers nothing to buy, and bills nothing, for a requirement staff waived", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ amount: 2, unitCents: 5000 });
    const before = await shown(p, req);
    expect(before.quote.ok).toBe(true);
    const { requirementProgress } = await import("@/lib/db/schema");
    await db.insert(requirementProgress).values({ requirementId: req, ...(await subjectColumns(FAMILY, "family")), waivedAt: new Date(), waivedReason: "Coach's family" });
    const now = await shown(p, req);
    expect(now).toMatchObject({ standing: "Waived", met: true, may: "nothing", quote: { ok: false, why: "met" }, stamp: null });
    asParent(p.identity);
    expect(await renderPage(VolunteerPage)).not.toContain("Pay instead of volunteering ($100.00)");
    expect(await confirmBuyoutAction(req, "family", before.subjectStamp, before.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.met] });
    expect(await buyoutsOf(FAMILY)).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("offers a family with no link to the club's books nothing: no price on Volunteer, Not found at every address, and the confirm refuses", async () => {
    const p = await buyoutFamily(stub);
    const forFamily = await seedBuyoutRequirement({ amount: 2, unitCents: 5000, title: "Concession shifts QU81" });
    const forStudent = await seedBuyoutRequirement({ appliesTo: "student", amount: 2, unitCents: 3100, title: "Pit crew shifts QU82" });
    const stamps = { family: await shown(p, forFamily), s1: await shown(p, forStudent, "s1") };
    expect(stamps.family.stamp).not.toBeNull();
    // From stage 3's later slices a family may have no link; here it is made by hand, and nothing brings it into step after.
    await db.delete(accountingLink).where(eq(accountingLink.familyId, p.identity.familyId));
    expect(await loadMyBuyouts({ familyId: p.identity.familyId, parentId: p.identity.parentId })).toEqual([]);
    asParent(p.identity);
    const html = await renderPage(VolunteerPage);
    expect(html).not.toMatch(/\/volunteer\/pay-instead\/|id="pay-h"|\$100\.00|\$62\.00|\$50\.00|\$31\.00/);
    const { pageOutcome } = await import("../helpers/signed-in");
    for (const params of [{ requirementId: forFamily, choice: "family" }, { requirementId: forStudent, choice: "s1" }, { requirementId: forStudent, choice: "s2" }]) {
      expect(await pageOutcome(PayInsteadPage, { params }), JSON.stringify(params)).toEqual({ notFound: true });
    }
    expect(await confirmBuyoutAction(forFamily, "family", stamps.family.subjectStamp, stamps.family.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.notFromPage] });
    expect(await confirmBuyoutAction(forStudent, "s1", stamps.s1.subjectStamp, stamps.s1.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.notFromPage] });
    expect(await db.select().from(buyout)).toEqual([]);
    expect(await db.select().from(writeQueue)).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it("is rate-limited per parent, and audits the first refusal once", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    const { subjectStamp } = await shown(p, req);
    asParent(p.identity);
    for (let i = 0; i < 10; i++) expect(await confirmBuyoutAction(req, "family", subjectStamp, "a-stamp-that-is-wrong")).toEqual({ ok: false, errors: [BUYOUT_COPY.changed("$100.00")] });
    expect(await confirmBuyoutAction(req, "family", subjectStamp, "a-stamp-that-is-wrong")).toEqual({ ok: false, errors: [BUYOUT_COPY.rateLimited] });
    expect(await switchBack(p, req)).toEqual({ ok: false, errors: [BUYOUT_COPY.rateLimited] });
    expect(await audits("volunteer.buyout.limit")).toHaveLength(1);
    expect(posts()).toEqual([]);
  });

  it("refuses arguments that aren't what the page sends", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    asParent(p.identity);
    const { subjectStamp } = await shown(p, req);
    for (const [id, key, subject, stamp] of [["not-a-uuid", "family", subjectStamp, "x"], [req, FAMILY, subjectStamp, "x"], [req, "s99", subjectStamp, "x"], [req, "family", subjectStamp, ""],
      [req, "family", subjectStamp, "x".repeat(65)], [req, { k: 1 }, subjectStamp, "x"], [req, "family", "", "x"], [req, "family", 7, "x"], [req, "family", "x".repeat(65), "x"]] as unknown[][]) {
      expect((await confirmBuyoutAction(id, key, subject, stamp)).ok, JSON.stringify([id, key, subject])).toBe(false);
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
    expect(await confirmBuyoutAction(req, "family", choice.subjectStamp, choice.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.refused] });
    const [b] = await buyoutsOf(FAMILY);
    expect(b).toMatchObject({ state: "refused", lastCode: "fault_6000", invoiceQboId: null });
    expect((await queueOf(b!.id)).map((i) => i.state)).toEqual(["given_up"]);
    expect(await audits("volunteer.buyout.refused")).toHaveLength(1);
    // The family may choose again, and reads that the last try couldn't be set up.
    const again = await shown(p, req);
    expect(again).toMatchObject({ may: "choose", refusedBefore: true, buyout: null });
    expect((await loadBuyoutsToLook()).map((x) => x.state)).toEqual(["refused"]);
  });

  it("bills the sign-in address of the guardian who confirms, and no other guardian's", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    // The family's second guardian, with an address of their own, is the one who chooses.
    const other = await seedParentIn({ familyQboId: FAMILY, name: "Ottoline Riverquill", email: "ottoline.riverquill@family-r.example" });
    expect(other.identity.email).toBe("ottoline.riverquill@family-r.example");
    const choice = await shown({ ...p, identity: other.identity }, req);
    asParent(other.identity);
    expect((await confirmBuyoutAction(req, "family", choice.subjectStamp, choice.stamp)).ok).toBe(true);
    expect(billedTo()).toEqual(["ottoline.riverquill@family-r.example"]);
    expect(JSON.stringify(invoicePosts().map((c) => c.body))).not.toContain(RIVERA.parent.email);
    // The queued create carries that address alone, and the invoice QuickBooks made has it, with a Pay link.
    const [b] = await buyoutsOf(FAMILY);
    expect((await queueOf(b!.id))[0]!.request).toMatchObject({ op: "invoice_create", billEmail: "ottoline.riverquill@family-r.example" });
    expect(stub.invoices[0]).toMatchObject({ BillEmail: { Address: "ottoline.riverquill@family-r.example" }, EmailStatus: "NotSet", InvoiceLink: expect.stringMatching(/^https:\/\/connect\.intuit\.com\//) });
  });

  it("sends, from the worker, the address the guardian had when they chose, even after it has changed", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    const choice = await shown(p, req);
    stub.rateLimitNext = 1; // the try made at once is throttled: nothing is made, and the create waits on the queue
    asParent(p.identity);
    expect(await confirmBuyoutAction(req, "family", choice.subjectStamp, choice.stamp)).toEqual({ ok: true, message: BUYOUT_COPY.waiting("$100.00") });
    const [b] = await buyoutsOf(FAMILY);
    expect((await queueOf(b!.id))[0]).toMatchObject({ state: "waiting", sent: false, request: { op: "invoice_create", billEmail: RIVERA.parent.email } });
    expect(stub.invoices).toEqual([]);
    // The guardian's sign-in address changes before the worker's try.
    const { parent } = await import("@/lib/db/schema");
    await db.update(parent).set({ email: "rosalind.new@family-r.example" }).where(eq(parent.id, p.identity.parentId));
    const logged = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k));
    try {
      expect(await runWriteQueue(later(2))).toEqual({ ran: true, ok: true });
      for (const spy of logged) for (const args of spy.mock.calls) expect(JSON.stringify(args)).not.toMatch(/rosalind/);
    } finally { for (const spy of logged) spy.mockRestore(); }
    expect(stub.invoices).toHaveLength(1);
    expect(stub.invoices[0]).toMatchObject({ BillEmail: { Address: RIVERA.parent.email } });
    expect(billedTo().every((a) => a === RIVERA.parent.email)).toBe(true);
    expect(JSON.stringify(invoicePosts().map((c) => c.body))).not.toContain("rosalind.new@family-r.example");
    expect((await buyoutsOf(FAMILY))[0]).toMatchObject({ state: "invoiced", invoiceQboId: "5001" });
    // Neither address is in what the audit rows say.
    const said = await buyoutAuditBodies();
    expect(said).not.toContain(RIVERA.parent.email);
    expect(said).not.toContain("rosalind.new@family-r.example");
  });

  it("shows the buy-out's invoice with its Pay button on Payments once it is made, as the pay-instead page says", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ title: "Concession shifts QR80" });
    await seedFamilyMoney(RIVERA);
    const choice = await shown(p, req);
    asParent(p.identity);
    expect(await confirmBuyoutAction(req, "family", choice.subjectStamp, choice.stamp)).toEqual({ ok: true, message: BUYOUT_COPY.done("$100.00") });
    const { default: PaymentsPage } = await import("@/app/(parent)/payments/page");
    const payments = (await renderPage(PaymentsPage)).replaceAll("<!-- -->", "");
    expect(payments).toContain('href="https://connect.intuit.com/t/scs-v1-stub-5001"');
    expect(payments).toContain("Pay $100.00, ");
    expect(payments).toContain("Paying instead of volunteering: Concession shifts QR80");
    const page = await renderPage(PayInsteadPage, { params: { requirementId: req, choice: "family" } });
    expect(page).toContain("Buy-out invoiced");
    expect(page).toContain("with a Pay button");
  });

  it("refuses the buy-out, queues nothing, and tells staff about the address, when QuickBooks won't take the guardian's address", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    const choice = await shown(p, req);
    stub.invoiceFault = "2210"; // as the check saw QuickBooks answer for a field that isn't an address
    asParent(p.identity);
    expect(await confirmBuyoutAction(req, "family", choice.subjectStamp, choice.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.refused] });
    const [b] = await buyoutsOf(FAMILY);
    expect(b).toMatchObject({ state: "refused", lastCode: "fault_2210", invoiceQboId: null });
    expect((await queueOf(b!.id)).map((i) => i.state)).toEqual(["given_up"]);
    const [look] = await loadBuyoutsToLook();
    expect(look).toMatchObject({ state: "refused", code: "fault_2210" });
    expect(look!.words).toContain("bill-to address");
    expect(look!.words).not.toContain(RIVERA.parent.email);
    expect(await buyoutAuditBodies()).not.toContain(RIVERA.parent.email);
    expect((await shown(p, req))).toMatchObject({ may: "choose", refusedBefore: true });
  });

  it("refuses the buy-out without sending anything when the guardian's address is one QuickBooks can't take", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    const choice = await shown(p, req);
    // Longer than the portal sends (InvoiceCreate.billEmail: at most 100 characters).
    asParent({ ...p.identity, email: `${"r".repeat(95)}@family-r.example` });
    expect(await confirmBuyoutAction(req, "family", choice.subjectStamp, choice.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.refused] });
    expect(invoicePosts()).toEqual([]);
    const [b] = await buyoutsOf(FAMILY);
    expect(b).toMatchObject({ state: "refused", lastCode: "bad_email" });
    expect((await queueOf(b!.id)).map((i) => i.state)).toEqual(["given_up"]);
    expect((await loadBuyoutsToLook())[0]!.words).toContain("bill-to address");
  });

  it("refuses at once, and records nothing, when only an Admin can mend the connection", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    const choice = await shown(p, req);
    const { qboConnection } = await import("@/lib/db/schema");
    await db.update(qboConnection).set({ lastError: "Intuit no longer accepts this connection. Connect QuickBooks again. (invalid_grant)" });
    asParent(p.identity);
    expect(await confirmBuyoutAction(req, "family", choice.subjectStamp, choice.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.cantNow] });
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
    expect(await confirmBuyoutAction(req, "family", choice.subjectStamp, choice.stamp)).toEqual({ ok: true, message: BUYOUT_COPY.waiting("$100.00") });
    await stub.idle();
    const [b] = await buyoutsOf(FAMILY);
    expect(b!.state).toBe("being_invoiced");
    const [waiting] = await queueOf(b!.id);
    expect(waiting).toMatchObject({ state: "waiting", sent: true, tries: 1 });
    // The page reads "being set up", and the guardian can't switch back until the outcome is known.
    expect((await shown(p, req)).standing).toBe("Buy-out being set up");
    expect(await switchBack(p, req)).toEqual({ ok: false, errors: [BUYOUT_COPY.stillMaking] });
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
    expect((await confirmBuyoutAction(req, "family", choice.subjectStamp, choice.stamp)).ok).toBe(true);
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

  it("marks the create as maybe sent before it goes, so a try cut off mid-send is looked for before it is sent again", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    const choice = await shown(p, req);
    let sentAsPosted: boolean | null = null;
    stub.onApiRequest = async (c) => {
      if (c.method === "POST" && c.path.endsWith("/invoice")) sentAsPosted = (await db.select().from(writeQueue))[0]!.sent;
    };
    asParent(p.identity);
    expect((await confirmBuyoutAction(req, "family", choice.subjectStamp, choice.stamp)).ok).toBe(true);
    expect(sentAsPosted).toBe(true);
  });

  it("refuses 'Try again now' while the try made at once for the guardian may still be under way", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    const b = await seedBuyout({ requirementId: req, familyQboId: FAMILY, chosenBy: p.identity.parentId, state: "being_invoiced" });
    const [item] = await db.insert(writeQueue).values({ realmId: b.realmId, request: { op: "invoice_create", buyoutId: b.id, customerQboId: FAMILY, itemQboId: BUYOUT_ITEM, units: 2, unitCents: 5000 },
      familyId: b.familyId, sent: false, tries: 0, nextTryAt: later(5) }).returning();
    const { tryAgainNow } = await import("@/lib/roster/queue");
    const op = { actor: { door: "staff" as const, id: null, label: "registrar@club.org" }, ip: null, permission: "Roster.Family.ReadWrite" };
    expect(await tryAgainNow(item!.id, op)).toMatchObject({ ok: false });
    expect((await queueOf(b.id))[0]!.nextTryAt!.getTime()).toBeGreaterThan(Date.now());
    // Once that try's hold has run out, staff may ask again.
    await db.update(writeQueue).set({ nextTryAt: new Date(Date.now() - 1000) }).where(eq(writeQueue.id, item!.id));
    expect(await tryAgainNow(item!.id, op)).toMatchObject({ ok: true });
  });

  it("waits while QuickBooks is busy, and is stuck after the tries run out, for staff to look at", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    const choice = await shown(p, req);
    stub.rateLimitNext = 100;
    asParent(p.identity);
    expect((await confirmBuyoutAction(req, "family", choice.subjectStamp, choice.stamp)).ok).toBe(true);
    const [b] = await buyoutsOf(FAMILY);
    expect((await queueOf(b!.id))[0]).toMatchObject({ state: "waiting", sent: false, lastCode: "http_429" });
    // Filed under the session's own family record, checked under the lock; what it sends names the customer billed only.
    expect((await queueOf(b!.id))[0]).toMatchObject({ familyId: await recordOfCustomer(FAMILY, "family"), studentId: null, targetQboId: null });
    expect((await queueOf(b!.id))[0]!.request).not.toHaveProperty("familyQboId");
    await db.update(writeQueue).set({ tries: 7, createdAt: new Date(Date.now() - 3_600_000) }).where(eq(writeQueue.familyId, b!.familyId));
    await runWriteQueue(later(2));
    expect((await queueOf(b!.id))[0]).toMatchObject({ state: "stuck", tries: 8 });
    expect((await buyoutsOf(FAMILY))[0]!.state).toBe("stuck");
    expect((await shown(p, req)).standing).toBe("Buy-out waiting for the club");
    expect(stub.invoices).toEqual([]);
  });

  it("says what each write is, in words, with the names the cache has", () => {
    const names = new Map([[FAMILY, "Riverquill Family"]]);
    const create = { op: "invoice_create" as const, buyoutId: "b", customerQboId: FAMILY, itemQboId: "1", units: 2, unitCents: 2500 };
    expect(describeWrite(create, names, { showAmounts: true })).toBe("Invoice Riverquill Family $50.00 for a volunteer buy-out");
    // The amount is what the family is billed: said only to staff who may see money.
    expect(describeWrite(create, names)).toBe("Invoice Riverquill Family for a volunteer buy-out");
    expect(describeWrite({ op: "invoice_void", buyoutId: "b", invoiceQboId: "5001", customerQboId: FAMILY, why: "switched_back" }, names))
      .toBe("Void the volunteer buy-out invoice of Riverquill Family");
  });
});

describe("one buy-out, one invoice, however many confirm at once", () => {
  it("makes one buy-out and one invoice when the same guardian confirms five times at once", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement();
    const choice = await shown(p, req);
    const results = await Promise.all(Array.from({ length: 5 }, () => confirmMyBuyout(ctxOf(p), req, "family", choice.subjectStamp, choice.stamp)));
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
    const results = await Promise.all([confirmMyBuyout(ctxOf(p), req, "family", choice.subjectStamp, choice.stamp), confirmMyBuyout({ ...other.identity, ip: null }, req, "family", theirs.subjectStamp, theirs.stamp)]);
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
    expect((await confirmBuyoutAction(req, "family", choice.subjectStamp, choice.stamp)).ok).toBe(true);
    return { p, req };
  }

  it("voids the invoice when nothing is paid on it, read live first, and the requirement reads as volunteering again", async () => {
    const { p, req } = await invoiced();
    expect((await shown(p, req)).may).toBe("switch_back");
    expect(await switchBack(p, req)).toEqual({ ok: true, message: BUYOUT_COPY.switched });
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

  it("never voids a sibling's invoice from a page drawn before a student joined and moved the keys", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ appliesTo: "student", amount: 2, unitCents: 5000 });
    const [rafferty, romilly] = [await shown(p, req, "s1"), await shown(p, req, "s2")];
    expect([rafferty.who, romilly.who]).toEqual([RIVERA.students[0]!.name, RIVERA.students[1]!.name]);
    asParent(p.identity);
    expect((await confirmBuyoutAction(req, "s1", rafferty.subjectStamp, rafferty.stamp)).ok).toBe(true);
    expect((await confirmBuyoutAction(req, "s2", romilly.subjectStamp, romilly.stamp)).ok).toBe(true);
    // Romilly's page as it was drawn, ready to switch her back: "s2", and the stamp of her own record.
    const romillyPage = await shown(p, req, "s2");
    expect(romillyPage.may).toBe("switch_back");
    // A student joins whose name comes first: "s2" now names Rafferty, whose invoice is unpaid too.
    await addToCache([stu("7019", "Abner Riverquill", FAMILY)]);
    expect((await shown(p, req, "s2")).who).toBe(RIVERA.students[0]!.name);
    expect(await switchBackAction(req, "s2", romillyPage.subjectStamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.notFromPage] });
    // Nothing was read live or voided, and both buy-outs stand as they were.
    expect(invoicePosts().filter((c) => c.query.get("operation") === "void")).toEqual([]);
    expect((await buyoutsOf(FAMILY)).map((b) => [b.subjectQboId, b.state]).sort()).toEqual([[RIVERA.students[0]!.qboId, "invoiced"], [RIVERA.students[1]!.qboId, "invoiced"]].sort());
    expect(await audits("volunteer.buyout.switch_back")).toEqual([]);
    // Romilly's page drawn now ("s3") switches her own back, and only hers.
    const now = await shown(p, req, "s3");
    expect(now.who).toBe(RIVERA.students[1]!.name);
    expect(await switchBackAction(req, "s3", now.subjectStamp)).toEqual({ ok: true, message: BUYOUT_COPY.switched });
    const ends = Object.fromEntries((await buyoutsOf(FAMILY)).map((b) => [b.subjectQboId, b.state]));
    expect(ends).toEqual({ [RIVERA.students[0]!.qboId]: "invoiced", [RIVERA.students[1]!.qboId]: "voided" });
  });

  it("never voids a paid or part-paid invoice: the treasurer sorts it out, in QuickBooks", async () => {
    const { p, req } = await invoiced();
    stub.invoices[0]!.Balance = 40;
    expect(await switchBack(p, req)).toEqual({ ok: false, errors: [BUYOUT_COPY.paidSome] });
    expect(invoicePosts().filter((c) => c.query.get("operation") === "void")).toEqual([]);
    expect((await buyoutsOf(FAMILY))[0]!.state).toBe("invoiced");
  });

  it("keeps the invoice, and flags it, when a payment lands in QuickBooks as the void is sent", async () => {
    const { p, req } = await invoiced();
    stub.beforeVoid = (inv) => { inv.Balance = 0; };
    // QuickBooks refused the void: the portal can't tell why, so the guardian is told the club will look, not that a payment was made.
    expect(await switchBack(p, req)).toEqual({ ok: false, errors: [BUYOUT_COPY.clubLooks] });
    const [b] = await buyoutsOf(FAMILY);
    expect(b).toMatchObject({ state: "invoiced", flag: "void_refused", lastCode: `fault_${STUB_PAID_VOID_FAULT}` });
    expect(stub.invoices[0]).toMatchObject({ TotalAmt: 100, Balance: 0 });
  });

  it("ends the buy-out as the guardian asked when the treasurer already voided the invoice in QuickBooks", async () => {
    const { p, req } = await invoiced();
    stub.invoices[0]!.TotalAmt = 0; stub.invoices[0]!.Balance = 0;
    expect(await switchBack(p, req)).toEqual({ ok: true, message: BUYOUT_COPY.switched });
    expect(invoicePosts().filter((c) => c.query.get("operation") === "void")).toEqual([]);
    expect((await buyoutsOf(FAMILY))[0]).toMatchObject({ state: "voided", endReason: "switched_back" });
    expect(await shown(p, req)).toMatchObject({ may: "choose", buyout: null });
  });

  it("never says a payment was made when the invoice is gone from QuickBooks, and changes nothing", async () => {
    const { p, req } = await invoiced();
    stub.invoices.length = 0;
    const r = await switchBack(p, req);
    expect(r).toEqual({ ok: false, errors: [BUYOUT_COPY.invoiceGone] });
    expect(JSON.stringify(r)).not.toMatch(/payment/i);
    expect((await buyoutsOf(FAMILY))[0]).toMatchObject({ state: "invoiced", flag: null });
  });

  it("offers nothing, and says the club is looking, while the buy-out is flagged for staff", async () => {
    const { p, req } = await invoiced();
    await db.update(buyout).set({ flag: "missing", flaggedAt: new Date() });
    expect(await shown(p, req)).toMatchObject({ may: "nothing", buyout: { clubLooking: true } });
    const page = await renderPage(PayInsteadPage, { params: { requirementId: req, choice: "family" } });
    expect(page).not.toContain("Volunteer instead");
    expect(page).not.toContain("with a Pay button");
    expect(page).toContain("The club is looking at this invoice");
    expect(await switchBack(p, req)).toEqual({ ok: false, errors: [BUYOUT_COPY.clubLooks] });
  });

  it("tells the guardian they can sign up for shifts now, not once the invoice is cancelled", async () => {
    const { p, req } = await invoiced();
    await db.update(buyout).set({ state: "being_voided" });
    const page = await renderPage(PayInsteadPage, { params: { requirementId: req, choice: "family" } });
    expect(page).not.toContain("Once it is, you can sign up");
    expect(page).toContain("You can sign up for shifts now");
    expect(BUYOUT_COPY.switching).not.toMatch(/once it is, you can sign up/i);
    expect((await shown(p, req)).standing).toBe("Buy-out being cancelled");
  });

  it("goes through the queue when QuickBooks can't be reached for the void, and reads 'being cancelled' meanwhile", async () => {
    const { p, req } = await invoiced();
    stub.onApiRequest = (c) => { if (c.method === "POST") stub.dropApi = true; };
    expect(await switchBack(p, req)).toEqual({ ok: true, message: BUYOUT_COPY.switching });
    await stub.idle();
    stub.dropApi = false; stub.onApiRequest = null;
    expect((await shown(p, req)).standing).toBe("Buy-out being cancelled");
    await runWriteQueue(later(2));
    expect((await buyoutsOf(FAMILY))[0]).toMatchObject({ state: "voided", endReason: "switched_back" });
  });
});

describe("while the membership shape can't say whose customers are the family's (shapeHolds())", () => {
  const BREAKS = [
    ["the shape names a customer type QuickBooks no longer has", () => db.delete(qboCustomerType).where(eq(qboCustomerType.qboId, "S"))],
    ["there is no shape", () => db.delete(setting).where(eq(setting.key, SHAPE_KEY))],
  ] as const;
  for (const [when, breakShape] of BREAKS) {
    it(`offers nothing, confirms and switches back nothing, and still reads a live buy-out, when ${when}`, async () => {
      const p = await buyoutFamily(stub);
      const req = await seedBuyoutRequirement({ title: "Concession shifts QR81" });
      const live = await seedBuyoutRequirement({ title: "Gate shifts QR82" });
      await seedBuyout({ requirementId: live, familyQboId: FAMILY, chosenBy: p.identity.parentId, invoiceQboId: "9902" });
      // The pages as they were drawn while the shape held: an offer, and a buy-out to switch back from.
      const choice = await shown(p, req), standing = await shown(p, live);
      expect(choice.may).toBe("choose");
      expect(standing.may).toBe("switch_back");
      await breakShape(); // the app's records are left as they are, and stay active
      const before = { buyouts: await db.select().from(buyout).orderBy(buyout.id), queue: await db.select().from(writeQueue) };
      expect(await loadMyBuyouts({ familyId: p.identity.familyId, parentId: p.identity.parentId })).toEqual([]);
      asParent(p.identity);
      const html = await renderPage(VolunteerPage);
      expect(html).not.toContain('id="pay-h"');
      expect(html).not.toContain("/volunteer/pay-instead/");
      // The live buy-out is still read where the season says how the requirement stands.
      const asked = html.split('id="asked-h"')[1]!.split('id="mine-h"')[0]!;
      expect(asked).toContain("Gate shifts QR82");
      expect(asked).toContain("Buy-out invoiced");
      // The pay-instead page says the family isn't set up, as it did when loadMyFamily() went by the shape.
      for (const [requirementId, key] of [[req, choice.key], [live, standing.key]] as [string, string][]) {
        const page = await renderPage(PayInsteadPage, { params: { requirementId, choice: key } });
        expect(page).toContain("Your family isn&#x27;t set up here yet");
        expect(page).not.toContain("Confirm: invoice me");
      }
      expect(await confirmBuyoutAction(req, choice.key, choice.subjectStamp, choice.stamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.notSetUp] });
      expect(await switchBackAction(live, standing.key, standing.subjectStamp)).toEqual({ ok: false, errors: [BUYOUT_COPY.notSetUp] });
      expect(await db.select().from(buyout).orderBy(buyout.id)).toEqual(before.buyouts);
      expect(await db.select().from(writeQueue)).toEqual(before.queue);
      expect(posts()).toEqual([]);
      expect(await audits("volunteer.buyout.limit")).toEqual([]);
    });
  }
});

describe("how the requirement reads, on the parent's pages", () => {
  it("reads 'Buy-out invoiced' until the stored figures say its invoice is paid, then 'Paid instead'", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ title: "Concession shifts QR77" });
    await seedBuyout({ requirementId: req, familyQboId: FAMILY, chosenBy: p.identity.parentId, invoiceQboId: "9901" });
    asParent(p.identity);
    expect(await renderPage(VolunteerPage)).toContain("Buy-out invoiced");
    await db.insert(familyMoney).values({ familyId: await recordOfCustomer(FAMILY, "family"), realmId: "9130000000000001", readAt: new Date(), totalCents: 0, currency: "USD",
      invoices: [{ qboId: "9901", number: "9901", customerQboId: FAMILY, forName: null, date: "2026-11-01", dueDate: null, totalCents: 10000, balanceCents: 0, currency: "USD", payLink: null, itemQboIds: [BUYOUT_ITEM] }] });
    const html = await renderPage(VolunteerPage);
    expect(html).toContain("Paid instead");
    const page = await renderPage(PayInsteadPage, { params: { requirementId: req, choice: "family" } });
    expect(page).toContain("Paid instead");
    expect(page).not.toContain("Volunteer instead");
  });

  // Today's reading, pinned so stage 4 meets it on purpose: until stage 4's slice that unlinks a family (M3b) a linked
  // family can't lose its link, and that slice decides what a family with a live buy-out and no link reads. The requirement's words go by the buy-out (kept by the app's records),
  // while the offer, the pay-instead page and the money all need the link, so only the words remain.
  it("a family that loses its link with a buy-out invoiced still reads 'Buy-out invoiced', with no way to it from Volunteer (stage 4 decides)", async () => {
    const p = await buyoutFamily(stub);
    const req = await seedBuyoutRequirement({ title: "Concession shifts QR78" });
    await seedBuyout({ requirementId: req, familyQboId: FAMILY, chosenBy: p.identity.parentId, invoiceQboId: "9902" });
    await db.delete(accountingLink).where(eq(accountingLink.familyId, p.identity.familyId));
    asParent(p.identity);
    const html = await renderPage(VolunteerPage);
    expect(html).toContain("Buy-out invoiced");
    expect(html).not.toMatch(/\/volunteer\/pay-instead\/|id="pay-h"/);
    const { pageOutcome } = await import("../helpers/signed-in");
    expect(await pageOutcome(PayInsteadPage, { params: { requirementId: req, choice: "family" } })).toEqual({ notFound: true });
    expect(posts()).toEqual([]);
  });

  it("spends no credit on a requirement its paid buy-out has met: the credit counts toward the next one (v1 spec §11.4)", async () => {
    const p = await buyoutFamily(stub);
    const r1 = await seedBuyoutRequirement({ title: "First shifts" }), r2 = await seedBuyoutRequirement({ title: "Second shifts" });
    await seedBuyout({ requirementId: r1, familyQboId: FAMILY, chosenBy: p.identity.parentId, state: "paid", invoiceQboId: "9901" });
    const event = await seedEvent();
    for (let i = 0; i < 2; i++) {
      const shift = await seedShift(event.event.id, { requirementIds: [r1, r2] });
      const signup = await seedSignup({ shiftId: shift.id, familyQboId: FAMILY, signedUpBy: p.identity.parentId });
      await seedCheckIn({ signupId: signup.id, familyQboId: FAMILY, by: p.identity.parentId });
    }
    expect((await shown(p, r1)).standing).toBe("Paid instead");
    expect(await shown(p, r2)).toMatchObject({ standing: "2 of 2 shifts done", met: true, quote: { ok: false, why: "met" } });
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
    expect(withoutIds(page)).not.toContain(FAMILY);
    expect(withoutIds(page)).not.toContain(BUYOUT_ITEM);
    // The confirm's answer goes to a status line outside the section that redraws, so it is heard and keeps the focus.
    expect(page).toMatch(/<p[^>]*role="status"[^>]*class="volunteer-done announce"/);
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
