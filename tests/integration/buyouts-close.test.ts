import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { asParent, asStaff, pageOutcome, renderPage } from "../helpers/signed-in";

// Closing a buy-out sends nothing to QuickBooks: the stub is here only to prove that, and to make the new buy-out a
// family chooses after a close. Never Intuit.
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, buyout, familyMoney, writeQueue, type BuyoutWrite } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import { CLOSE_WORDS } from "@/lib/buyouts/closing";
import { CLOSE_COPY } from "@/lib/buyouts/close";
import { closeTag, loadBuyoutsToLook } from "@/lib/buyouts/staff";
import { loadMyBuyouts } from "@/lib/buyouts/my-buyouts";
import { BUYOUT_COPY } from "@/lib/buyouts/writes";
import { currentRosterTag, ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { closeBuyoutAction } from "@/app/staff/(app)/reconciliation/buyout-actions";
import { confirmBuyoutAction } from "@/app/(parent)/volunteer/pay-instead/actions";
import ReconciliationPage from "@/app/staff/(app)/reconciliation/page";
import FamilyBuyoutsPage from "@/app/staff/(app)/roster/[id]/buyouts/page";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import FamilyProgressPage from "@/app/staff/(app)/seasons/progress/family/[familyId]/page";
import VolunteerPage from "@/app/(parent)/volunteer/page";
import { resetDb } from "../helpers/db";
import { CHENOWETH, invoiceQueries, RIVERA, stubInvoice } from "../helpers/money";
import { MONEY_REALM, seedFamilyMoney, seedSignedInParent, type SeededParent } from "../helpers/parent";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";
import { buyoutFamily, buyoutsOf, queueOf, seedBuyout, seedBuyoutRequirement } from "../helpers/buyouts";
import { staffWith } from "../helpers/roster-writes";
import { recordOfCustomer } from "../helpers/app-records";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

const FAMILY = RIVERA.family.qboId;
const NOT_FROM_PAGE = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const family = { students: RIVERA.students };
const audits = async (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action));
const rowOf = async (id: string) => (await db.select().from(buyout).where(eq(buyout.id, id)))[0]!;
const writer = () => staffWith("treasurer@club.org", ["Roster.Read", "Roster.Family.ReadWrite"]);
const standing = async (p: SeededParent, req: string) =>
  (await loadMyBuyouts({ familyQboId: p.identity.familyQboId, parentId: p.identity.parentId }, family)).find((b) => b.requirementId === req)!;

/** A queue item for a buy-out, as the write queue leaves one. */
async function seedItem(b: { id: string; customerQboId: string }, o: { op?: "invoice_create" | "invoice_void"; state?: "waiting" | "stuck" | "done" | "given_up"; sent?: boolean } = {}) {
  const request: BuyoutWrite = (o.op ?? "invoice_create") === "invoice_create"
    ? { op: "invoice_create", buyoutId: b.id, customerQboId: b.customerQboId, itemQboId: "4343", units: 2, unitCents: 5000, familyQboId: FAMILY }
    : { op: "invoice_void", buyoutId: b.id, invoiceQboId: "5001", customerQboId: b.customerQboId, familyQboId: FAMILY, why: "switched_back" };
  const [item] = await db.insert(writeQueue).values({ realmId: "9130000000000001", request, familyQboId: FAMILY, state: o.state ?? "stuck", sent: o.sent ?? false,
    tries: 8, lastCode: "http_429", nextTryAt: o.state === "waiting" ? new Date() : null, askedByLabel: "a guardian" }).returning();
  return item!;
}

/** A family of digits connected through the stub, with a volunteer requirement that offers a buy-out, and a buy-out in the given shape. */
async function withBuyout(o: Parameters<typeof seedBuyout>[0] extends infer T ? Partial<T> & { lastCode?: string | null } : never = {}) {
  const p = await buyoutFamily(stub);
  const req = await seedBuyoutRequirement();
  const b = await seedBuyout({ requirementId: req, familyQboId: FAMILY, chosenBy: p.identity.parentId, ...o });
  if (o.lastCode !== undefined) await db.update(buyout).set({ lastCode: o.lastCode }).where(eq(buyout.id, b.id));
  return { p, req, b: await rowOf(b.id) };
}

/** Closes as the page offers it: with the buy-out's tag as shown and the roster's tag. */
const closeAsShown = async (id: string, note = "Sorted out with the family by phone.") => closeBuyoutAction(id, closeTag(await rowOf(id)), await currentRosterTag(), note);

describe("staff close a buy-out (v1 spec §11.5)", () => {
  it("closes a refused one, sending nothing, audited with before, after and the note", async () => {
    const { b } = await withBuyout({ state: "refused", invoiceQboId: null, lastCode: "fault_6000" });
    const staff = await writer();
    asStaff(staff);
    expect(await closeAsShown(b.id)).toEqual({ ok: true, message: CLOSE_COPY.done });
    expect(await rowOf(b.id)).toMatchObject({ state: "voided", endReason: "closed_by_staff", flag: null });
    expect(stub.apiCalls()).toEqual([]);
    const [a] = await audits("volunteer.buyout.closed");
    expect(a).toMatchObject({ actorId: staff.id, permission: "Roster.Family.ReadWrite", targetType: "buyout", targetId: b.id,
      before: { state: "refused", flag: null, code: "fault_6000", invoiceQboId: null, amountCents: 10000, familyId: String(await recordOfCustomer(FAMILY, "family")), studentId: null },
      after: { state: "voided", why: "closed_by_staff", close: "refused", note: "Sorted out with the family by phone.", givenUp: [] } });
    // Off Reconciliation's list.
    expect(await loadBuyoutsToLook()).toEqual([]);
  });

  it("closes a stuck create that was never sent, giving its queue item up in the same transaction", async () => {
    const { p, req, b } = await withBuyout({ state: "stuck", invoiceQboId: null, lastCode: "http_429" });
    const item = await seedItem(b, { state: "stuck", sent: false });
    expect((await standing(p, req)).standing).toBe("Buy-out waiting for the club");
    asStaff(await writer());
    expect(await closeAsShown(b.id)).toEqual({ ok: true, message: CLOSE_COPY.done });
    expect(await rowOf(b.id)).toMatchObject({ state: "voided", endReason: "closed_by_staff", flag: null });
    expect((await queueOf(b.id))[0]).toMatchObject({ id: item.id, state: "given_up", note: "Sorted out with the family by phone." });
    expect(await audits("roster.write.given_up")).toHaveLength(1);
    expect((await audits("volunteer.buyout.closed"))[0]!.after).toMatchObject({ close: "never_sent", givenUp: [item.id] });
    expect(stub.apiCalls()).toEqual([]);
  });

  it("closes one whose invoice QuickBooks no longer shows, and one paid in full that was to be voided, never touching the invoice", async () => {
    const { b } = await withBuyout({ state: "invoiced", flag: "missing" });
    const paid = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Gate shifts" }), familyQboId: FAMILY, chosenBy: b.chosenBy, state: "paid", flag: "paid_before_void", invoiceQboId: "5002" });
    await db.update(buyout).set({ lastCode: "paid" }).where(eq(buyout.id, paid.id));
    asStaff(await writer());
    expect(await closeAsShown(b.id)).toEqual({ ok: true, message: CLOSE_COPY.done });
    expect(await closeAsShown(paid.id)).toEqual({ ok: true, message: CLOSE_COPY.done });
    expect((await audits("volunteer.buyout.closed")).map((a) => (a.after as { close: string }).close).sort()).toEqual(["looks_gone", "paid_in_full"]);
    expect(await rowOf(paid.id)).toMatchObject({ state: "voided", endReason: "closed_by_staff", invoiceQboId: "5002" });
    // The "missing" flag came from stored figures alone, so the close read the customer's invoices first: a GET, nothing sent.
    expect(stub.apiCalls().every((c) => c.method === "GET")).toBe(true);
    expect(invoiceQueries(stub)).toHaveLength(1);
  });

  it("on a daily check's missing flag, reads QuickBooks live first: closes one gone or voided there, refuses one that stands or can't be read", async () => {
    const { b } = await withBuyout({ state: "invoiced", flag: "missing" });
    asStaff(await writer());
    // Made while QuickBooks was answering the money run, so the stored figures missed it: it stands, unpaid.
    stub.invoices.push(stubInvoice("5001", FAMILY, { TotalAmt: 100, Balance: 100 }));
    const before = await rowOf(b.id);
    expect(await closeAsShown(b.id)).toEqual({ ok: false, errors: [CLOSE_COPY.stands] });
    stub.dropApi = true;
    expect(await closeAsShown(b.id)).toEqual({ ok: false, errors: [CLOSE_COPY.unreadable] });
    expect(await rowOf(b.id)).toEqual(before);
    expect(await audits("volunteer.buyout.closed")).toEqual([]);
    // Voided in QuickBooks since: nothing is owed, so it closes.
    stub.dropApi = false;
    stub.invoices[0] = stubInvoice("5001", FAMILY, { TotalAmt: 0, Balance: 0 });
    expect(await closeAsShown(b.id)).toEqual({ ok: true, message: CLOSE_COPY.done });
    expect((await audits("volunteer.buyout.closed"))[0]!.after).toMatchObject({ close: "looks_gone", readLive: "gone" });
    expect(stub.apiCalls().every((c) => c.method === "GET")).toBe(true);
  });

  it("refuses where an unpaid invoice may stand, says what to do in QuickBooks first, and changes nothing", async () => {
    const { b } = await withBuyout({ state: "stuck", invoiceQboId: null, lastCode: "timeout" });
    const item = await seedItem(b, { state: "stuck", sent: true });
    const other = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Gate shifts" }), familyQboId: FAMILY, chosenBy: b.chosenBy, state: "invoiced", flag: "other_customer", invoiceQboId: "5002" });
    const part = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Raffle shifts" }), familyQboId: FAMILY, chosenBy: b.chosenBy, state: "invoiced", flag: "paid_before_void", invoiceQboId: "5003" });
    await db.update(buyout).set({ lastCode: "paid" }).where(eq(buyout.id, part.id));
    asStaff(await writer());
    for (const id of [b.id, other.id, part.id]) {
      const before = await rowOf(id);
      const r = await closeAsShown(id);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.errors[0]).toBe(CLOSE_COPY.changed);
      expect(!r.ok && r.errors[1]).toMatch(/QuickBooks/);
      expect(await rowOf(id)).toEqual(before);
    }
    expect((await queueOf(b.id))[0]).toMatchObject({ id: item.id, state: "stuck" });
    expect(await audits("volunteer.buyout.closed")).toEqual([]);
    expect(stub.apiCalls()).toEqual([]);
  });

  it("refuses when the buy-out changed since the page was shown, or a change to it is on its way to QuickBooks", async () => {
    const { b } = await withBuyout({ state: "stuck", invoiceQboId: null, lastCode: "http_429" });
    const item = await seedItem(b, { state: "stuck", sent: false });
    const shownTag = closeTag(b), rosterTag = await currentRosterTag();
    asStaff(await writer());
    // The worker tried again meanwhile: the row changed.
    await db.update(buyout).set({ lastCode: "http_503", updatedAt: new Date(Date.now() + 1000) }).where(eq(buyout.id, b.id));
    expect(await closeBuyoutAction(b.id, shownTag, rosterTag, "Done by hand.")).toEqual({ ok: false, errors: [CLOSE_COPY.changed] });
    // "Try again now" put its item back to waiting: the worker may be sending it.
    await db.update(writeQueue).set({ state: "waiting", nextTryAt: new Date() }).where(eq(writeQueue.id, item.id));
    const r = await closeAsShown(b.id);
    expect(!r.ok && r.errors).toEqual([CLOSE_COPY.changed, expect.stringContaining("on its way to QuickBooks")]);
    // A page that showed another company's roster.
    await db.update(writeQueue).set({ state: "stuck", nextTryAt: null }).where(eq(writeQueue.id, item.id));
    expect(await closeBuyoutAction(b.id, closeTag(await rowOf(b.id)), "another-company-tag", "Done by hand.")).toEqual({ ok: false, errors: [ROSTER_MOVED] });
    // A buy-out a company change deleted.
    expect(await closeBuyoutAction("00000000-0000-4000-8000-0000000000f1", "stuck.-.1", rosterTag, "Done by hand.")).toEqual({ ok: false, errors: [CLOSE_COPY.gone] });
    expect((await rowOf(b.id)).state).toBe("stuck");
    expect((await queueOf(b.id))[0]!.state).toBe("stuck");
    expect(await audits("volunteer.buyout.closed")).toEqual([]);
  });

  it("asks why, and refuses a note too long", async () => {
    const { b } = await withBuyout({ state: "refused", invoiceQboId: null });
    asStaff(await writer());
    expect(await closeAsShown(b.id, "   ")).toEqual({ ok: false, errors: [CLOSE_COPY.noNote] });
    expect(await closeAsShown(b.id, "x".repeat(501))).toEqual({ ok: false, errors: [CLOSE_COPY.tooLong] });
    expect((await rowOf(b.id)).state).toBe("refused");
  });

  it("is refused to staff without Roster.Family.ReadWrite, with it but without Roster.Read, to a parent session, and for arguments no page sends", async () => {
    const { p, b } = await withBuyout({ state: "refused", invoiceQboId: null });
    const tag = closeTag(b), roster = await currentRosterTag();
    for (const who of [await staffWith("nobody@club.org", []), await staffWith("reader@club.org", ["Roster.Read"])]) {
      asStaff(who);
      await expect(closeBuyoutAction(b.id, tag, roster, "Done.")).rejects.toBeInstanceOf(AccessDenied);
    }
    asParent(p.identity);
    await expect(closeBuyoutAction(b.id, tag, roster, "Done.")).rejects.toBeInstanceOf(AccessDenied);
    asStaff(await staffWith("writer@club.org", ["Roster.Family.ReadWrite"]));
    expect(await closeBuyoutAction(b.id, tag, roster, "Done.")).toEqual(NOT_FROM_PAGE);
    asStaff(await writer());
    const bad: unknown[][] = [["not-a-uuid", tag, roster, "Done."], [b.id, "", roster, "Done."], [b.id, tag, "x".repeat(65), "Done."], [b.id, tag, roster, 7], [b.id, { tag }, roster, "Done."]];
    for (const args of bad) expect(await (closeBuyoutAction as (...a: unknown[]) => Promise<unknown>)(...args)).toEqual(NOT_FROM_PAGE);
    expect((await rowOf(b.id)).state).toBe("refused");
    expect(await audits("volunteer.buyout.closed")).toEqual([]);
  });
});

describe("after a close, the family can choose again", () => {
  it("reads as it did before the choice on the parent's and staff pages, and a new buy-out makes one new invoice", async () => {
    const { p, req, b } = await withBuyout({ state: "stuck", invoiceQboId: null, lastCode: "http_429" });
    await seedItem(b, { state: "stuck", sent: false });
    await seedFamilyMoney(RIVERA);
    expect(await standing(p, req)).toMatchObject({ standing: "Buy-out waiting for the club", may: "nothing" });
    asParent(p.identity);
    expect(await renderPage(VolunteerPage)).toContain("Buy-out waiting for the club");
    const progress = await staffWith("progress@club.org", ["Season.Progress.Read", "Roster.Read", "Roster.Family.ReadWrite"]);
    asStaff(progress);
    expect(await renderPage(FamilyProgressPage, { params: { familyId: FAMILY } })).toContain("Buy-out waiting for the club");

    expect((await closeAsShown(b.id)).ok).toBe(true);

    const after = await standing(p, req);
    expect(after).toMatchObject({ standing: "0 of 2 shifts done", may: "choose", buyout: null, refusedBefore: false });
    asParent(p.identity);
    const volunteer = await renderPage(VolunteerPage);
    expect(volunteer).not.toContain("Buy-out waiting for the club");
    expect(volunteer).not.toContain("Sorted out with the family by phone.");
    asStaff(progress);
    const staffPage = await renderPage(FamilyProgressPage, { params: { familyId: FAMILY } });
    expect(staffPage).not.toContain("Buy-out waiting for the club");
    expect(staffPage).toContain("0 of 2 shifts done");

    asParent(p.identity);
    expect(await confirmBuyoutAction(req, "family", after.stamp)).toEqual({ ok: true, message: BUYOUT_COPY.done("$100.00") });
    const rows = await buyoutsOf(FAMILY);
    expect(rows.map((r) => r.state)).toEqual(["voided", "invoiced"]);
    expect(stub.invoices).toHaveLength(1);
  });
});

describe("a family's buy-outs page (Roster.Read)", () => {
  it("is refused without Roster.Read and to a parent session, and answers 404 for a family it doesn't know", async () => {
    const { p } = await withBuyout({ state: "refused", invoiceQboId: null });
    asStaff(await staffWith("money@club.org", ["Finance.Balance.Read"]));
    expect(await pageOutcome(FamilyBuyoutsPage, { params: { id: FAMILY } })).toEqual({ redirect: "/refused" });
    asParent(p.identity);
    expect((await pageOutcome(FamilyBuyoutsPage, { params: { id: FAMILY } }))).toHaveProperty("redirect");
    asStaff(await staffWith("reader@club.org", ["Roster.Read"]));
    expect(await pageOutcome(FamilyBuyoutsPage, { params: { id: "99999" } })).toEqual({ notFound: true });
    expect(await audits("volunteer.buyout.family.read")).toEqual([]);
  });

  it("lists every state, audited before anything is shown, with amounts only for staff who may see money and the close only for staff who may change the roster", async () => {
    const { b } = await withBuyout({ state: "refused", invoiceQboId: null, lastCode: "fault_6000" });
    const invoiced = await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Gate shifts" }), familyQboId: FAMILY, chosenBy: b.chosenBy, state: "invoiced", invoiceQboId: "5002", unitCents: 3719 });
    await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Raffle hours", appliesTo: "student" }), familyQboId: FAMILY, subjectQboId: RIVERA.students[0]!.qboId,
      chosenBy: b.chosenBy, state: "voided", invoiceQboId: "5003" });
    await db.update(buyout).set({ endReason: "switched_back" }).where(eq(buyout.invoiceQboId, "5003"));
    // The family's figures as the daily read stored them: the invoiced one's invoice open, all of it still owed.
    await db.insert(familyMoney).values({ familyId: await recordOfCustomer(FAMILY, "family"), realmId: MONEY_REALM, readAt: new Date(), totalCents: 7438, currency: "USD",
      invoices: [{ qboId: "5002", number: "1042", customerQboId: FAMILY, forName: null, date: null, dueDate: null, totalCents: 7438, balanceCents: 7438, currency: "USD", payLink: null, itemQboIds: ["4343"] }] });

    const reader = await staffWith("reader@club.org", ["Roster.Read"]);
    asStaff(reader);
    const html = await renderPage(FamilyBuyoutsPage, { params: { id: FAMILY } });
    const [read] = await audits("volunteer.buyout.family.read");
    // Naming the app's family, as the season's and volunteering's family pages do.
    expect(read).toMatchObject({ actorId: reader.id, permission: "Roster.Read", targetType: "family", targetId: String(await recordOfCustomer(FAMILY, "family")) });
    expect(html).toContain(RIVERA.family.name);
    expect(html).toContain("Concession shifts");
    expect(html).toContain("Refused by QuickBooks: nothing was billed");
    expect(html).toContain("Gate shifts");
    expect(html).toContain("Buy-out invoiced");
    expect(html).toContain("Raffle hours");
    expect(html).toContain(`For ${RIVERA.students[0]!.name}`);
    expect(html).toContain("Ended: the family switched back to volunteering, and the invoice was voided");
    expect(html).toContain(CLOSE_WORDS.refused);
    expect(html).not.toContain("Close this buy-out");
    expect(html).not.toContain("$74.38");
    expect(html).not.toContain("$100.00");

    asStaff(await staffWith("treasurer@club.org", ["Roster.Read", "Roster.Family.ReadWrite", "Finance.Balance.Read"]));
    const full = await renderPage(FamilyBuyoutsPage, { params: { id: FAMILY } });
    expect(full).toContain("Close this buy-out");
    expect(full).toContain("$100.00");
    expect(full).toContain("Open: $74.38 owed");
    // Only the refused one may be closed: the invoiced one's invoice stands, and the ended one has ended.
    expect(full.match(/Close this buy-out/g)).toHaveLength(1);
    expect(invoiced.id).toBeTruthy();
  });

  it("shows one family's buy-outs only, and is reached from the family's roster page and from each Reconciliation row", async () => {
    const { p, b } = await withBuyout({ state: "refused", invoiceQboId: null });
    const other = await seedSignedInParent(CHENOWETH);
    await seedBuyout({ requirementId: await seedBuyoutRequirement({ title: "Chenoweth gate shifts" }), familyQboId: CHENOWETH.family.qboId, chosenBy: other.identity.parentId, state: "refused", invoiceQboId: null });
    asStaff(await writer());
    const html = await renderPage(FamilyBuyoutsPage, { params: { id: FAMILY } });
    expect(html).not.toContain("Chenoweth");
    const recon = await renderPage(ReconciliationPage);
    expect(recon).toContain(`href="/staff/roster/${FAMILY}/buyouts"`);
    expect(recon).toContain(`href="/staff/roster/${CHENOWETH.family.qboId}/buyouts"`);
    expect(recon).toContain("Close this buy-out");
    const entry = await renderPage(RosterEntryPage, { params: { id: FAMILY } });
    expect(entry).toContain(`href="/staff/roster/${FAMILY}/buyouts"`);
    expect(b.id && p).toBeTruthy();
  });
});
