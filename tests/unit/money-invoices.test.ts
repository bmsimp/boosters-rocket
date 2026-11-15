import { describe, it, expect } from "vitest";
import { monthsBefore, openInvoices, paidInvoices, shownInvoices, utcDay } from "@/lib/money/invoices";
import { dueState, localDay, SOON_DAYS } from "@/lib/money/due";
import { DEFAULT_MONEY_SETTINGS, parseMoneySettings } from "@/lib/money/settings";

const TODAY = "2026-11-15";
/** The family (10), a student (12) and a parent (11): the customers that were asked for, with the names shown beside their invoices. */
const ASKED = new Map<string, string | null>([["10", null], ["12", "Leo Rivera"], ["11", "Ana Rivera"]]);
const inv = (Id: string, customer: string, extra: Record<string, unknown> = {}) =>
  ({ Id, DocNumber: `10${Id}`, CustomerRef: { value: customer, name: "a name the portal never reads" }, TotalAmt: 85, Balance: 85, TxnDate: "2026-11-01", DueDate: "2026-11-22", ...extra });
const read = (raw: unknown[]) => shownInvoices(raw, ASKED, TODAY);

describe("QuickBooks' invoices as a parent sees them", () => {
  it("keeps the number, the dates, what is still due in cents, and whose it is", () => {
    const shown = read([inv("1", "10"), inv("2", "12", { TotalAmt: 100, Balance: 40.5, DueDate: undefined })])!;
    expect(shown.invoices).toEqual([
      { qboId: "1", number: "101", customerQboId: "10", forName: null, date: "2026-11-01", dueDate: "2026-11-22", totalCents: 8500, balanceCents: 8500, currency: "USD", payLink: null },
      { qboId: "2", number: "102", customerQboId: "12", forName: "Leo Rivera", date: "2026-11-01", dueDate: null, totalCents: 10000, balanceCents: 4050, currency: "USD", payLink: null },
    ]);
    expect(shown.totalCents).toBe(12550); // the sum of what is still due, not of the invoices' totals
    expect(shown.currency).toBe("USD");
  });

  it("puts the soonest due first, and an invoice with no due date last", () => {
    const shown = read([inv("1", "10", { DueDate: "2026-12-20" }), inv("2", "10", { DueDate: undefined }), inv("3", "10", { DueDate: "2026-10-30" }),
      inv("4", "10", { DueDate: "2026-12-20", TxnDate: "2026-10-01" }), inv("10", "10", { DueDate: "2026-10-30" })])!;
    expect(shown.invoices.map((i) => i.qboId)).toEqual(["3", "10", "4", "1", "2"]);
  });

  it("keeps a pay link only when it is https on an Intuit host, and only on an invoice with something left to pay", () => {
    const shown = read([
      inv("1", "10", { InvoiceLink: "https://connect.intuit.com/t/one" }), inv("2", "10", { InvoiceLink: "javascript:alert(1)" }),
      inv("3", "10", { InvoiceLink: "http://connect.intuit.com/t/three" }), inv("4", "10", { InvoiceLink: "https://evil.example/intuit.com" }),
      inv("5", "10"), inv("6", "10", { Balance: 0, InvoiceLink: "https://connect.intuit.com/t/six" }), inv("7", "10", { InvoiceLink: { href: "https://connect.intuit.com/t/seven" } }),
    ])!;
    expect(Object.fromEntries(shown.invoices.map((i) => [i.qboId, i.payLink]))).toEqual({ 1: "https://connect.intuit.com/t/one", 2: null, 3: null, 4: null, 5: null, 6: null, 7: null });
  });

  it("lists invoices paid in the last 12 months, newest first, and leaves out older ones and voided ones", () => {
    const paid = (Id: string, TxnDate: string, extra: Record<string, unknown> = {}) => inv(Id, "10", { Balance: 0, TxnDate, DueDate: undefined, ...extra });
    const shown = read([
      paid("1", "2026-08-28"), paid("2", "2025-11-15"), paid("3", "2025-11-14"), paid("4", "2024-01-01"), paid("5", "2026-10-01"),
      paid("6", "2026-09-01", { TotalAmt: 0 }), // voided in QuickBooks: no total and nothing due
      paid("7", "not a date"), inv("8", "12"),
    ])!;
    expect(paidInvoices(shown.invoices).map((i) => i.qboId)).toEqual(["5", "1", "2"]);
    expect(openInvoices(shown.invoices).map((i) => i.qboId)).toEqual(["8"]);
    expect(shown.totalCents).toBe(8500);
  });

  it("says nothing is owed when every invoice is paid", () => {
    const shown = read([inv("1", "10", { Balance: 0 })])!;
    expect(shown).toMatchObject({ totalCents: 0, currency: "USD" });
    expect(read([])).toEqual({ invoices: [], totalCents: 0, currency: "USD" });
  });

  it("uses the invoice's own currency, and gives no single total when open invoices are in more than one", () => {
    expect(read([inv("1", "10", { CurrencyRef: { value: "CAD" } })])).toMatchObject({ currency: "CAD", totalCents: 8500 });
    expect(read([inv("1", "10", { CurrencyRef: { value: "CAD" } }), inv("2", "10")])!.currency).toBeNull();
    expect(read([inv("1", "10", { CurrencyRef: { value: "CAD" }, Balance: 0 }), inv("2", "10")])!.currency).toBe("USD"); // a paid one doesn't count
    expect(read([inv("1", "10", { CurrencyRef: { value: "<b>" } })])!.currency).toBe("USD");
  });

  it("keeps a hostile invoice number as the text it is, cut to a sensible length", () => {
    const shown = read([inv("1", "10", { DocNumber: "<img src=x onerror=alert(1)>" }), inv("2", "10", { DocNumber: "x".repeat(500) }), inv("3", "10", { DocNumber: "   " }), inv("4", "10", { DocNumber: 1042 })])!;
    expect(shown.invoices.map((i) => i.number)).toEqual(["<img src=x onerror=alert(1)>", "x".repeat(50), null, null]);
  });

  it("counts an invoice QuickBooks sent twice once", () => {
    expect(read([inv("1", "10"), inv("1", "10")])).toMatchObject({ totalCents: 8500 });
  });

  it.each([
    ["an invoice of a customer that wasn't asked for", [inv("1", "10"), inv("2", "20")]],
    ["an invoice of a customer whose id only starts the same", [inv("1", "100")]],
    ["an invoice with no customer", [inv("1", "10", { CustomerRef: undefined })]],
    ["an invoice whose customer is named, not given by id", [inv("1", "10", { CustomerRef: { name: "10" } })]],
    ["an amount still due that can't be read", [inv("1", "10", { Balance: "lots" })]],
    ["a missing amount still due", [inv("1", "10", { Balance: undefined })]],
    ["a total that can't be read", [inv("1", "10", { TotalAmt: null })]],
    ["an invoice with no id", [inv("1", "10", { Id: undefined })]],
    ["an invoice whose id isn't a number", [inv("1; drop", "10")]],
    ["a row that isn't an invoice", [inv("1", "10"), null]],
    ["a row that is a list", [[inv("1", "10")]]],
    ["a row that is text", ["invoice"]],
  ])("refuses the whole answer when it holds %s: a figure that might be wrong, or another family's, is never shown", (_what, raw) => {
    expect(read(raw)).toBeNull();
  });

  it("works out the day a year back, and today in UTC", () => {
    expect(monthsBefore("2026-11-15", 12)).toBe("2025-11-15");
    expect(monthsBefore("2026-01-31", 12)).toBe("2025-01-31");
    expect(monthsBefore("2028-02-29", 12)).toBe("2027-03-01");
    expect(utcDay(new Date("2026-11-15T23:59:59Z"))).toBe("2026-11-15");
  });
});

describe("a due date is said in words (DESIGN.md, Money lines)", () => {
  it.each([
    ["2026-11-15", "soon", "Due", ", today"],
    ["2026-11-16", "soon", "Due", ", tomorrow"],
    ["2026-11-23", "soon", "Due", ", in 8 days"],
    ["2026-11-29", "soon", "Due", ", in 14 days"],
    ["2026-11-30", "later", "Due", ""],
    ["2027-03-01", "later", "Due", ""],
    ["2026-11-14", "late", "Was due", ""],
    ["2026-10-30", "late", "Was due", ""],
    ["2025-11-15", "late", "Was due", ""],
  ] as const)("due %s, seen on 2026-11-15, is %s: \"%s <date>%s\"", (due, tone, lead, tail) => {
    expect(dueState(due, TODAY)).toEqual({ tone, lead, tail });
  });

  it("counts days across a month end, a year end and a leap day", () => {
    expect(dueState("2026-12-01", "2026-11-28").tail).toBe(", in 3 days");
    expect(dueState("2027-01-02", "2026-12-30").tail).toBe(", in 3 days");
    expect(dueState("2028-03-01", "2028-02-28").tail).toBe(", in 2 days");
    expect(SOON_DAYS).toBe(14);
  });

  it("never uses an alarm word, and says a date it can't read plainly", () => {
    for (const due of ["2020-01-01", "2026-11-14", "2026-11-15", "2030-01-01"]) {
      const { lead, tail } = dueState(due, TODAY);
      expect(`${lead}${tail}`).not.toMatch(/overdue|late|urgent|immediately|!|[A-Z]{3,}/);
    }
    expect(dueState("soon", TODAY)).toEqual({ tone: "later", lead: "Due", tail: "" });
  });

  it("takes today from the viewer's own clock", () => {
    expect(localDay(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
    expect(localDay(new Date(2026, 11, 31, 0, 0))).toBe("2026-12-31");
  });
});

describe("the freshness window", () => {
  it("is five minutes unless a readable setting says otherwise", () => {
    expect(DEFAULT_MONEY_SETTINGS).toEqual({ freshSeconds: 300 });
    expect(parseMoneySettings(undefined)).toEqual({ freshSeconds: 300 });
    expect(parseMoneySettings({ freshSeconds: 60 })).toEqual({ freshSeconds: 60 });
    expect(parseMoneySettings({ freshSeconds: 0 })).toEqual({ freshSeconds: 0 });
    expect(parseMoneySettings({ freshSeconds: 7 * 86_400 })).toEqual({ freshSeconds: 604_800 });
  });

  it.each([[null], ["300"], [{ freshSeconds: "300" }], [{ freshSeconds: -1 }], [{ freshSeconds: 1.5 }], [{ freshSeconds: 1e12 }], [{}], [[300]]])(
    "falls back to five minutes for a stored value that can't be read: %j", (value) => {
      expect(parseMoneySettings(value)).toEqual({ freshSeconds: 300 });
    });
});
