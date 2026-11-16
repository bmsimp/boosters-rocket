import { describe, it, expect } from "vitest";
import type { StoredInvoice } from "@/lib/db/schema";
import { invoicesFor, NO_INVOICE_YET, PAID, paymentStanding } from "@/lib/money/payment-rule";
import { itemsOf, shownInvoices } from "@/lib/money/invoices";

/**
 * A payment requirement (v1 spec §10.2): it names a QuickBooks product or service, and is met for a family or student
 * when invoices carrying that item exist for them and none of those has an open balance.
 */
const FAMILY = "10", LEO = "12", MAYA = "13";
const UNIFORM = "41", TRIP = "42";
const invoice = (qboId: string, customerQboId: string, items: string[], o: Partial<StoredInvoice> = {}): StoredInvoice => ({
  qboId, number: `INV-${qboId}`, customerQboId, forName: null, date: "2026-10-01", dueDate: "2026-11-01", totalCents: 8500, balanceCents: 8500,
  currency: "USD", payLink: null, itemQboIds: items, ...o,
});
const paid = (qboId: string, customerQboId: string, items: string[], o: Partial<StoredInvoice> = {}) => invoice(qboId, customerQboId, items, { balanceCents: 0, ...o });

describe("how a payment requirement stands", () => {
  it("is paid when every invoice carrying its item has nothing left to pay", () => {
    expect(paymentStanding(UNIFORM, [paid("1", FAMILY, [UNIFORM])])).toEqual(PAID);
    expect(PAID).toEqual({ met: true, words: "Paid" });
  });

  it("is not paid yet while any invoice carrying it is open, and says what is left to pay", () => {
    expect(paymentStanding(UNIFORM, [invoice("1", FAMILY, [UNIFORM])])).toEqual({ met: false, words: "Not paid yet ($85.00 left to pay)" });
  });

  it("counts what is left on a part-paid invoice, not its total", () => {
    expect(paymentStanding(UNIFORM, [invoice("1", FAMILY, [UNIFORM], { totalCents: 10000, balanceCents: 4050 })])).toEqual({ met: false, words: "Not paid yet ($40.50 left to pay)" });
  });

  it("with two invoices carrying it: paid only when both are, and what is left adds up across the open ones", () => {
    expect(paymentStanding(UNIFORM, [paid("1", FAMILY, [UNIFORM]), invoice("2", LEO, [UNIFORM, TRIP], { balanceCents: 2500 })]))
      .toEqual({ met: false, words: "Not paid yet ($25.00 left to pay)" });
    expect(paymentStanding(UNIFORM, [invoice("1", FAMILY, [UNIFORM], { balanceCents: 1000 }), invoice("2", LEO, [UNIFORM], { balanceCents: 2500 })]))
      .toEqual({ met: false, words: "Not paid yet ($35.00 left to pay)" });
    expect(paymentStanding(UNIFORM, [paid("1", FAMILY, [UNIFORM]), paid("2", LEO, [UNIFORM])])).toEqual(PAID);
  });

  it("is not met by invoices for something else, or by no invoice at all: no invoice yet", () => {
    expect(paymentStanding(UNIFORM, [paid("1", FAMILY, [TRIP]), invoice("2", FAMILY, [])])).toEqual(NO_INVOICE_YET);
    expect(paymentStanding(UNIFORM, [])).toEqual(NO_INVOICE_YET);
    expect(NO_INVOICE_YET).toEqual({ met: false, words: "No invoice yet" });
  });

  it("an open invoice for something else doesn't hold it open", () => {
    expect(paymentStanding(UNIFORM, [paid("1", FAMILY, [UNIFORM]), invoice("2", FAMILY, [TRIP])])).toEqual(PAID);
  });

  it("reads no invoice yet with no item chosen, or no figures that may be shown, or figures stored before items were read", () => {
    expect(paymentStanding(null, [paid("1", FAMILY, [UNIFORM])])).toEqual(NO_INVOICE_YET);
    expect(paymentStanding(UNIFORM, undefined)).toEqual(NO_INVOICE_YET);
    // Never guessed at: an invoice that doesn't say what it carries carries nothing here (and its row is read again).
    expect(paymentStanding(UNIFORM, [{ ...invoice("1", FAMILY, []), itemQboIds: undefined }])).toEqual(NO_INVOICE_YET);
  });

  it("a credit QuickBooks applied pays the invoice; a credit the family holds unapplied pays nothing", () => {
    // A credit memo applied leaves the invoice with nothing to pay (a balance below zero is stored as nothing to pay).
    expect(paymentStanding(UNIFORM, [paid("1", FAMILY, [UNIFORM], { balanceCents: 0 })])).toEqual(PAID);
    // The family's own balance in QuickBooks may be lower (BalanceWithJobs), but the invoice is still open there.
    expect(paymentStanding(UNIFORM, [invoice("1", FAMILY, [UNIFORM])]).met).toBe(false);
  });

  it("says no single amount when the open invoices are in two currencies", () => {
    expect(paymentStanding(UNIFORM, [invoice("1", FAMILY, [UNIFORM]), invoice("2", FAMILY, [UNIFORM], { currency: "CAD" })])).toEqual({ met: false, words: "Not paid yet" });
  });
});

describe("whose invoices count", () => {
  const family = [paid("1", FAMILY, [TRIP]), invoice("2", LEO, [UNIFORM]), paid("3", MAYA, [UNIFORM])];

  it("for a student: only the invoices raised on that student, so an item on a sibling's invoice is not theirs", () => {
    expect(invoicesFor(MAYA, FAMILY, family).map((i) => i.qboId)).toEqual(["3"]);
    expect(paymentStanding(UNIFORM, invoicesFor(MAYA, FAMILY, family))).toEqual(PAID);
    expect(paymentStanding(UNIFORM, invoicesFor(LEO, FAMILY, family)).met).toBe(false);
    // The trip is on the family's own invoice: no student has one.
    expect(paymentStanding(TRIP, invoicesFor(LEO, FAMILY, family))).toEqual(NO_INVOICE_YET);
  });

  it("for a family: the invoices raised on any of its customers", () => {
    expect(invoicesFor(FAMILY, FAMILY, family).map((i) => i.qboId)).toEqual(["1", "2", "3"]);
    expect(paymentStanding(TRIP, invoicesFor(FAMILY, FAMILY, family))).toEqual(PAID);
    expect(paymentStanding(UNIFORM, invoicesFor(FAMILY, FAMILY, family)).words).toBe("Not paid yet ($85.00 left to pay)");
  });
});

describe("which products and services an invoice carries", () => {
  it("reads the item of each sales line, of a bundle and of the lines inside it, each once and in order", () => {
    expect(itemsOf([
      { DetailType: "SalesItemLineDetail", Amount: 50, SalesItemLineDetail: { ItemRef: { value: "42", name: "Trip" } } },
      { DetailType: "SalesItemLineDetail", Amount: 35, SalesItemLineDetail: { ItemRef: { value: "7" } } },
      { DetailType: "GroupLineDetail", GroupLineDetail: { GroupItemRef: { value: "19" }, Line: [{ SalesItemLineDetail: { ItemRef: { value: "42" } } }, { SalesItemLineDetail: { ItemRef: { value: "8" } } }] } },
      { DetailType: "SubTotalLineDetail", Amount: 85, SubTotalLineDetail: {} },
      { DetailType: "DiscountLineDetail", DiscountLineDetail: { PercentBased: false } },
    ])).toEqual(["7", "8", "19", "42"]);
  });

  it("keeps only ids QuickBooks could have sent: an item ref that isn't digits is left out", () => {
    expect(itemsOf([{ SalesItemLineDetail: { ItemRef: { value: "<b>1</b>" } } }, { SalesItemLineDetail: { ItemRef: { value: 3 } } }, null, "line"])).toEqual([]);
  });

  it("reads an invoice with no lines as carrying nothing, and refuses lines that aren't a list", () => {
    expect(itemsOf(undefined)).toEqual([]);
    expect(itemsOf({ Line: "x" })).toBeNull();
    const raw = { Id: "1", DocNumber: "1", CustomerRef: { value: "10" }, TotalAmt: 85, Balance: 85, TxnDate: "2026-11-01" };
    expect(shownInvoices([{ ...raw, Line: [{ SalesItemLineDetail: { ItemRef: { value: "41" } } }] }], new Map([["10", null]]), "2026-11-16")!.invoices[0]!.itemQboIds).toEqual(["41"]);
    // An answer of a shape the portal doesn't know is refused whole, never read as "carries nothing".
    expect(shownInvoices([{ ...raw, Line: { SalesItemLineDetail: {} } }], new Map([["10", null]]), "2026-11-16")).toBeNull();
  });
});
