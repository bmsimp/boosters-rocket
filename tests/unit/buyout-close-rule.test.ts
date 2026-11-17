import { describe, it, expect } from "vitest";
import { CLOSE_WORDS, closeVerdict, type CloseFacts, type CloseItem } from "@/lib/buyouts/closing";

// When staff may close a buy-out (src/lib/buyouts/closing.ts): only when the portal can tell no unpaid invoice of it
// stands, since closing sends nothing to QuickBooks. Every state and every flag.
const create = (state: CloseItem["state"], sent: boolean): CloseItem => ({ op: "invoice_create", state, sent });
const voidItem = (state: CloseItem["state"], sent = false): CloseItem => ({ op: "invoice_void", state, sent });
const facts = (f: Partial<CloseFacts>): CloseFacts => ({ state: "invoiced", flag: null, lastCode: null, invoiceQboId: "5001", items: [create("done", true)], ...f });
const why = (f: Partial<CloseFacts>) => { const v = closeVerdict(facts(f)); return `${v.may ? "close" : "keep"}:${v.why}`; };

describe("closing a buy-out (v1 spec §11.5)", () => {
  it("is offered for a refused one: QuickBooks made no invoice", () => {
    expect(closeVerdict(facts({ state: "refused", invoiceQboId: null, lastCode: "fault_6000", items: [create("given_up", true)] })))
      .toEqual({ may: true, why: "refused", words: CLOSE_WORDS.refused });
  });

  it("is offered for a stuck create every try of which surely sent nothing, stuck or given up", () => {
    expect(why({ state: "stuck", invoiceQboId: null, lastCode: "http_429", items: [create("stuck", false)] })).toBe("close:never_sent");
    expect(why({ state: "stuck", flag: "given_up", invoiceQboId: null, items: [create("given_up", false)] })).toBe("close:never_sent");
  });

  it("is not offered for a stuck create that may have reached QuickBooks, or one with no record of its tries", () => {
    const stuck = closeVerdict(facts({ state: "stuck", invoiceQboId: null, lastCode: "timeout", items: [create("stuck", true)] }));
    expect(stuck).toMatchObject({ may: false, why: "may_be_made" });
    expect(stuck.words).toContain("Try again now");
    const givenUp = closeVerdict(facts({ state: "stuck", flag: "given_up", invoiceQboId: null, items: [create("given_up", true)] }));
    expect(givenUp).toMatchObject({ may: false, why: "may_be_made" });
    expect(givenUp.words).toContain("Booster Rocket buy-out");
    expect(why({ state: "stuck", invoiceQboId: null, items: [] })).toBe("keep:may_be_made");
  });

  it("is not offered while a change is on its way to QuickBooks, whatever else holds", () => {
    expect(why({ state: "being_invoiced", invoiceQboId: null, items: [create("waiting", false)] })).toBe("keep:in_flight");
    expect(why({ state: "being_voided", items: [create("done", true), voidItem("waiting")] })).toBe("keep:in_flight");
    // A stuck one "Try again now" has put back to waiting: the worker may be sending it.
    expect(why({ state: "stuck", invoiceQboId: null, items: [create("waiting", false)] })).toBe("keep:in_flight");
    expect(why({ state: "invoiced", flag: "missing", items: [create("done", true), voidItem("waiting")] })).toBe("keep:in_flight");
  });

  it("is offered for one a void's live read found gone from QuickBooks", () => {
    expect(why({ state: "stuck", flag: "missing", lastCode: "invoice_gone", items: [create("done", true), voidItem("given_up", true)] })).toBe("close:invoice_gone");
    expect(why({ state: "stuck", flag: "student_moved", lastCode: "invoice_gone", items: [create("done", true), voidItem("given_up", true)] })).toBe("close:invoice_gone");
  });

  it("is offered, read again live first, for one the daily check flagged missing from stored figures alone", () => {
    expect(why({ state: "invoiced", flag: "missing" })).toBe("close:looks_gone");
    expect(CLOSE_WORDS.looks_gone).toContain("reads QuickBooks again first");
    // Its stuck void, if any, is given up by the close.
    expect(why({ state: "stuck", flag: "missing", items: [create("done", true), voidItem("stuck", true)] })).toBe("close:looks_gone");
  });

  it("closes a paid one only as paid in full, whatever other flag the daily check left on it", () => {
    expect(why({ state: "paid", flag: "missing" })).toBe("keep:nothing_to_do");
    expect(why({ state: "paid", flag: "other_customer" })).toBe("keep:nothing_to_do");
    expect(why({ state: "paid", flag: "missing", lastCode: "invoice_gone" })).toBe("keep:nothing_to_do");
  });

  it("is offered for a void the portal wouldn't send because the invoice is paid in full", () => {
    expect(why({ state: "paid", flag: "paid_before_void", lastCode: "paid", items: [create("done", true), voidItem("given_up")] })).toBe("close:paid_in_full");
    expect(why({ state: "paid", flag: "student_moved", lastCode: "paid" })).toBe("close:paid_in_full");
    expect(CLOSE_WORDS.paid_in_full).toContain("refund it in QuickBooks");
  });

  it("is not offered for a part-paid invoice: the rest is still owed, and is settled in QuickBooks first", () => {
    const v = closeVerdict(facts({ state: "invoiced", flag: "paid_before_void", lastCode: "paid" }));
    expect(v).toMatchObject({ may: false, why: "part_paid" });
    expect(v.words).toContain("daily check");
    expect(why({ state: "invoiced", flag: "student_moved", lastCode: "paid" })).toBe("keep:part_paid");
  });

  it("is not offered for an invoice on another customer", () => {
    const v = closeVerdict(facts({ state: "invoiced", flag: "other_customer" }));
    expect(v).toMatchObject({ may: false, why: "other_customer" });
    expect(v.words).toContain("Put it back on that customer in QuickBooks");
  });

  it("is not offered while an unpaid invoice may stand: a void QuickBooks refused, a moved student's, or a stuck or given-up void", () => {
    expect(closeVerdict(facts({ state: "invoiced", flag: "void_refused", lastCode: "fault_6000" }))).toMatchObject({ may: false, why: "invoice_stands" });
    expect(why({ state: "invoiced", flag: "student_moved", lastCode: "fault_6000" })).toBe("keep:invoice_stands");
    expect(closeVerdict(facts({ state: "stuck", lastCode: "timeout", items: [create("done", true), voidItem("stuck", true)] })).words).toContain("Try again now");
    expect(why({ state: "stuck", flag: "given_up", items: [create("done", true), voidItem("given_up", true)] })).toBe("keep:invoice_stands");
  });

  it("has nothing to close for an invoiced or paid one with nothing to look at, or one that has ended", () => {
    expect(why({ state: "invoiced" })).toBe("keep:nothing_to_do");
    expect(closeVerdict(facts({ state: "paid" })).words).toContain("Paid instead");
    expect(why({ state: "voided", items: [create("done", true), voidItem("done", true)] })).toBe("keep:ended");
    expect(why({ state: "voided", flag: null, invoiceQboId: null, items: [] })).toBe("keep:ended");
  });
});
