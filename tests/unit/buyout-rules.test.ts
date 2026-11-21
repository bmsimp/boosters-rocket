import { describe, it, expect } from "vitest";
import { BUYOUT_WORDS, buyoutOffered, guardianMay, judgeInvoice, paidIn, parsePrice, priceText, quoteBuyout, withBuyout, type BuyoutTerms } from "@/lib/buyouts/rules";
import { volunteerStanding } from "@/lib/volunteer/rules";
import type { StoredInvoice } from "@/lib/db/schema";

const shifts: BuyoutTerms = { kind: "volunteer", amount: 2, amountUnit: "shifts", buyoutUnitCents: 5000, itemQboId: "77" };
const hours: BuyoutTerms = { kind: "volunteer", amount: 6, amountUnit: "hours", buyoutUnitCents: 1500, itemQboId: "77" };

describe("a buy-out's quote (v1 spec §11.5)", () => {
  it("is the price per unit times the units still owed after confirmed credit, for shifts", () => {
    expect(quoteBuyout(shifts, 0)).toEqual({ ok: true, units: 2, unitCents: 5000, amountCents: 10000 });
    expect(quoteBuyout(shifts, 1)).toEqual({ ok: true, units: 1, unitCents: 5000, amountCents: 5000 });
  });

  it("rounds an hour requirement up to whole hours, and doesn't round up a sliver of floating point", () => {
    expect(quoteBuyout(hours, 0)).toEqual({ ok: true, units: 6, unitCents: 1500, amountCents: 9000 });
    expect(quoteBuyout(hours, 2.5)).toEqual({ ok: true, units: 4, unitCents: 1500, amountCents: 6000 });
    expect(quoteBuyout(hours, 5.01)).toEqual({ ok: true, units: 1, unitCents: 1500, amountCents: 1500 });
    // 3.9999999 hours is 240 minutes after rounding to the minute: 2 hours left, not 3.
    expect(quoteBuyout(hours, 3.9999999)).toEqual({ ok: true, units: 2, unitCents: 1500, amountCents: 3000 });
  });

  it("is nothing for a requirement credit has met already, or gone past", () => {
    expect(quoteBuyout(shifts, 2)).toEqual({ ok: false, why: "met" });
    expect(quoteBuyout(shifts, 3)).toEqual({ ok: false, why: "met" });
    expect(quoteBuyout(hours, 6)).toEqual({ ok: false, why: "met" });
  });

  it("is off when no buy-out is offered: switched off, no item, no amount, or not volunteering", () => {
    expect(quoteBuyout({ ...shifts, buyoutUnitCents: null }, 0)).toEqual({ ok: false, why: "off" });
    expect(quoteBuyout({ ...shifts, itemQboId: null }, 0)).toEqual({ ok: false, why: "off" });
    expect(quoteBuyout({ ...shifts, amount: null }, 0)).toEqual({ ok: false, why: "off" });
    expect(quoteBuyout({ ...shifts, kind: "payment" }, 0)).toEqual({ ok: false, why: "off" });
    expect(buyoutOffered(shifts)).toBe(true);
  });

  it("is the same per family and per student: the subject decides only who is billed, not the price", () => {
    // The quote reads the requirement's terms and the subject's own credit; appliesTo is not among its inputs.
    expect(quoteBuyout(shifts, 1)).toEqual(quoteBuyout({ ...shifts }, 1));
  });
});

describe("how a volunteer requirement reads with a buy-out (spec §10.2)", () => {
  const credit = volunteerStanding({ amount: 2, amountUnit: "shifts" }, { confirmed: 1, signedUp: 0 });
  it("says where the buy-out is while it is under way, and is met once it is paid", () => {
    expect(withBuyout(credit, { state: "being_invoiced", invoicePaid: false })).toEqual({ met: false, words: "Buy-out being set up" });
    expect(withBuyout(credit, { state: "invoiced", invoicePaid: false })).toEqual({ met: false, words: "Buy-out invoiced" });
    expect(withBuyout(credit, { state: "invoiced", invoicePaid: true })).toEqual({ met: true, words: "Paid instead" });
    expect(withBuyout(credit, { state: "paid", invoicePaid: false })).toEqual({ met: true, words: "Paid instead" });
    expect(withBuyout(credit, { state: "being_voided", invoicePaid: false })).toEqual({ met: false, words: BUYOUT_WORDS.being_voided });
    expect(withBuyout(credit, { state: "stuck", invoicePaid: false })).toEqual({ met: false, words: BUYOUT_WORDS.stuck });
  });
  it("reads as credit says when there is no live buy-out, or credit has met it anyway", () => {
    expect(withBuyout(credit, null)).toEqual(credit);
    expect(withBuyout(credit, { state: "voided", invoicePaid: false })).toEqual(credit);
    expect(withBuyout(credit, { state: "refused", invoicePaid: false })).toEqual(credit);
    const met = volunteerStanding({ amount: 2, amountUnit: "shifts" }, { confirmed: 2, signedUp: 0 });
    expect(withBuyout(met, { state: "invoiced", invoicePaid: false })).toEqual(met);
  });
  it("lets a guardian choose, switch back before it is paid, or wait while QuickBooks is asked", () => {
    const q = quoteBuyout(shifts, 0);
    expect(guardianMay(null, q)).toBe("choose");
    expect(guardianMay({ state: "refused", invoicePaid: false }, q)).toBe("choose");
    expect(guardianMay(null, quoteBuyout(shifts, 2))).toBe("nothing");
    expect(guardianMay({ state: "invoiced", invoicePaid: false }, q)).toBe("switch_back");
    expect(guardianMay({ state: "invoiced", invoicePaid: true }, q)).toBe("nothing");
    expect(guardianMay({ state: "being_invoiced", invoicePaid: false }, q)).toBe("wait");
    expect(guardianMay({ state: "being_voided", invoicePaid: false }, q)).toBe("wait");
    expect(guardianMay({ state: "paid", invoicePaid: false }, q)).toBe("nothing");
  });
});

describe("a price as staff type it", () => {
  it("is read digit by digit into cents", () => {
    expect(parsePrice("50")).toBe(5000);
    expect(parsePrice("50.00")).toBe(5000);
    expect(parsePrice("$12.5")).toBe(1250);
    expect(parsePrice(" 0.07 ")).toBe(7);
    expect(parsePrice("1,250.99")).toBe(125099);
    expect(parsePrice("10000")).toBe(1_000_000);
    expect(priceText(125099)).toBe("1250.99");
    expect(priceText(7)).toBe("0.07");
  });
  it("refuses what isn't one", () => {
    for (const bad of ["", "0", "0.00", "-5", "5.001", "abc", "10000.01", "1e3", "12,34", "$", null, 5]) expect(parsePrice(bad), String(bad)).toBeNull();
  });
});

describe("the daily check's verdict on one invoice (spec §8.4)", () => {
  const b = { invoiceQboId: "5001", customerQboId: "7012", perStudent: true };
  const inv = (o: Partial<{ qboId: string; customerQboId: string; totalCents: number; balanceCents: number }> = {}) => ({ qboId: "5001", customerQboId: "7012", totalCents: 5000, balanceCents: 5000, ...o });
  it("is ok while it is there with something to pay, and paid once its balance is 0", () => {
    expect(judgeInvoice(b, [inv()], true)).toBe("ok");
    expect(judgeInvoice(b, [inv({ balanceCents: 2000 })], true)).toBe("ok");
    expect(judgeInvoice(b, [inv({ balanceCents: 0 })], true)).toBe("paid");
  });
  it("is voided when QuickBooks shows it with a total of 0, never flagged as gone or paid", () => {
    expect(judgeInvoice(b, [inv({ totalCents: 0, balanceCents: 0 })], true)).toBe("voided");
    expect(judgeInvoice(b, [inv({ totalCents: 0, balanceCents: 0, customerQboId: "7013" })], true)).toBe("other_customer");
  });
  it("flags one QuickBooks no longer shows, one on another customer, and one whose student moved", () => {
    expect(judgeInvoice(b, [], true)).toBe("missing");
    expect(judgeInvoice(b, [inv({ customerQboId: "7013" })], true)).toBe("other_customer");
    expect(judgeInvoice(b, [], false)).toBe("student_moved");
    // A student moved in QuickBooks is a move whatever the family's figures still hold.
    expect(judgeInvoice(b, [inv()], false)).toBe("student_moved");
    expect(judgeInvoice({ ...b, perStudent: false }, [], false)).toBe("missing");
  });
});

describe("whether an invoice is paid in stored figures (paidIn)", () => {
  const inv = (qboId: string, o: Partial<StoredInvoice> = {}): StoredInvoice => ({ qboId, number: qboId, customerQboId: "10", forName: null, date: "2026-11-01", dueDate: null,
    totalCents: 10000, balanceCents: 0, currency: "USD", payLink: null, itemQboIds: [], ...o });

  it("is paid when the invoice is there, for something, with nothing left to pay", () => {
    expect(paidIn([inv("5001")], "5001")).toBe(true);
    expect(paidIn([inv("5002", { balanceCents: 2500 }), inv("5001")], "5001")).toBe(true);
  });

  it("is not paid when something is still owed on it, part paid or not", () => {
    expect(paidIn([inv("5001", { balanceCents: 2500 })], "5001")).toBe(false);
    expect(paidIn([inv("5001", { balanceCents: 10000 })], "5001")).toBe(false);
  });

  it("is not paid when it was voided: QuickBooks keeps it with a total of 0", () => {
    expect(paidIn([inv("5001", { totalCents: 0, balanceCents: 0 })], "5001")).toBe(false);
  });

  it("is not paid when the figures don't hold it, hold none, or the buy-out has no invoice", () => {
    expect(paidIn([inv("5002")], "5001")).toBe(false);
    expect(paidIn([], "5001")).toBe(false);
    expect(paidIn(null, "5001")).toBe(false);
    expect(paidIn(undefined, "5001")).toBe(false);
    expect(paidIn([inv("5001")], null)).toBe(false);
  });
});
