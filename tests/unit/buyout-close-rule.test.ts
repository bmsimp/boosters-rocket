import { describe, it, expect } from "vitest";
import { BUYOUT_NOTE_PREFIX, CLOSE_WORDS, closeVerdict, EARLIER_WORDS, earlierCompanyLook, MADE_AFTER_WORDS, type CloseFacts, type CloseItem, type EarlierFacts, type EarlierKind,
  type LookItem } from "@/lib/buyouts/closing";
import type { BuyoutState } from "@/lib/db/schema";

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

  it("is offered, read again live first, for one the daily check flagged because its student is no longer under the family in QuickBooks", () => {
    // Flagged by the check alone: no void was tried, so there is no code and no void item.
    expect(why({ state: "invoiced", flag: "student_moved" })).toBe("close:moved_away");
    expect(CLOSE_WORDS.moved_away).toContain("Closing reads QuickBooks first");
    // A void the portal tried for a move made in the portal says its own thing, as before.
    expect(why({ state: "invoiced", flag: "student_moved", items: [create("done", true), voidItem("done", true)] })).toBe("keep:invoice_stands");
    expect(why({ state: "invoiced", flag: "student_moved", lastCode: "paid" })).toBe("keep:part_paid");
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

// What a buy-out of an earlier QuickBooks company leaves to settle there by hand (stage 4's slice M7b): every state, end
// reason, flag and set of queue items such a buy-out can have falls in one kind.
describe("an earlier company's buy-out, for the treasurer (stage 4's slice M7b)", () => {
  const ID = "00000000-0000-4000-8000-0000000000b7";
  const item = (op: LookItem["op"], state: LookItem["state"], sent: boolean, resultQboId: string | null = null): LookItem => ({ op, state, sent, resultQboId });
  const earlier = (f: Partial<EarlierFacts>): EarlierFacts => ({ id: ID, state: "voided", endReason: "earlier_company", flag: null, lastCode: null, invoiceQboId: "5001",
    items: [item("invoice_create", "done", true, "5001")], ...f });
  const kind = (f: Partial<EarlierFacts>) => earlierCompanyLook(earlier(f)).kind;

  it("an ended one whose invoice is known and no void of it was sent: the invoice stands there", () => {
    // Ended from invoiced (its create done), from stuck with a void never sent, or from being voided with the void not yet sent.
    expect(earlierCompanyLook(earlier({}))).toEqual({ kind: "invoice_stands", invoiceQboId: "5001", madeAfter: false, note: null, words: EARLIER_WORDS.invoice_stands });
    expect(kind({ items: [item("invoice_void", "given_up", false), item("invoice_create", "done", true, "5001")] })).toBe("invoice_stands");
    expect(kind({ flag: "missing", items: [item("invoice_void", "given_up", false), item("invoice_create", "done", true, "5001")] })).toBe("invoice_stands");
    // A void QuickBooks answered (done) found it paid and kept it: the invoice stands, something paid on it.
    expect(kind({ flag: "paid_before_void", lastCode: "paid", items: [item("invoice_void", "done", true), item("invoice_create", "done", true, "5001")] })).toBe("invoice_stands");
    expect(EARLIER_WORDS.invoice_stands).toContain("waive the requirement");
    expect(EARLIER_WORDS.invoice_stands).toContain("void it there");
  });

  it("an ended one whose invoice came only from its given-up create's item, or was recorded on it after the item was given up: the invoice stands, made after", () => {
    const fromItem = earlierCompanyLook(earlier({ invoiceQboId: null, items: [item("invoice_create", "given_up", true, "6101")] }));
    expect(fromItem).toEqual({ kind: "invoice_stands", invoiceQboId: "6101", madeAfter: true, note: null, words: `${EARLIER_WORDS.invoice_stands} ${MADE_AFTER_WORDS}` });
    // invoiceFoundAfterEnding() recorded it on the buy-out: the item, still given up, names the same invoice.
    expect(earlierCompanyLook(earlier({ invoiceQboId: "6102", items: [item("invoice_create", "given_up", true, "6102")] }))).toMatchObject({ kind: "invoice_stands", invoiceQboId: "6102", madeAfter: true });
    // The newest create that names one is read.
    expect(earlierCompanyLook(earlier({ invoiceQboId: null, items: [item("invoice_create", "given_up", true, null), item("invoice_create", "given_up", true, "6103")] })))
      .toMatchObject({ kind: "invoice_stands", invoiceQboId: "6103", madeAfter: true });
  });

  it("an ended one whose void was sent and never answered: it may be voided already", () => {
    const v = earlierCompanyLook(earlier({ items: [item("invoice_void", "given_up", true), item("invoice_create", "done", true, "5001")] }));
    expect(v).toEqual({ kind: "void_may_have_gone", invoiceQboId: "5001", madeAfter: false, note: null, words: EARLIER_WORDS.void_may_have_gone });
    expect(kind({ items: [item("invoice_void", "stuck", true)] })).toBe("void_may_have_gone");
    expect(kind({ invoiceQboId: null, items: [item("invoice_void", "given_up", true), item("invoice_create", "given_up", true, "6104")] })).toBe("void_may_have_gone");
  });

  it("an ended one with no invoice known whose create was sent: it may be made, and the note to search for is its own", () => {
    const v = earlierCompanyLook(earlier({ invoiceQboId: null, items: [item("invoice_create", "given_up", true)] }));
    expect(v).toEqual({ kind: "may_be_made", invoiceQboId: null, madeAfter: false, note: `Booster Rocket buy-out ${ID}`, words: EARLIER_WORDS.may_be_made });
    expect(BUYOUT_NOTE_PREFIX).toBe("Booster Rocket buy-out ");
    expect(kind({ invoiceQboId: null, items: [item("invoice_create", "stuck", true)] })).toBe("may_be_made");
    expect(kind({ invoiceQboId: null, items: [item("invoice_create", "given_up", false), item("invoice_create", "given_up", true)] })).toBe("may_be_made");
  });

  it("a paid one that was to be cancelled may be owed a refund; any other paid one has nothing to settle", () => {
    for (const flag of ["paid_before_void", "student_moved"] as const) {
      expect(earlierCompanyLook(earlier({ state: "paid", endReason: null, flag }))).toEqual({ kind: "refund_owed", invoiceQboId: "5001", madeAfter: false, note: null, words: EARLIER_WORDS.refund_owed });
    }
    for (const flag of [null, "missing", "other_customer", "void_refused", "given_up"] as const) expect(kind({ state: "paid", endReason: null, flag }), String(flag)).toBe("nothing_to_settle");
  });

  it("nothing to settle: an ended one with no invoice and no create ever sent, a refused one, and one that ended any other way", () => {
    expect(kind({ invoiceQboId: null, items: [] })).toBe("nothing_to_settle");
    expect(kind({ invoiceQboId: null, items: [item("invoice_create", "given_up", false)] })).toBe("nothing_to_settle");
    expect(kind({ state: "refused", endReason: null, invoiceQboId: null, lastCode: "fault_6000", items: [item("invoice_create", "given_up", true)] })).toBe("nothing_to_settle");
    for (const endReason of ["switched_back", "student_moved", "voided_in_quickbooks", "closed_by_staff"] as const) {
      expect(kind({ endReason, items: [item("invoice_void", "given_up", true), item("invoice_create", "done", true, "5001")] }), endReason).toBe("nothing_to_settle");
    }
    expect(EARLIER_WORDS.nothing_to_settle).toContain("earlier QuickBooks company");
  });

  it("puts every state, end reason, flag and set of items in exactly one kind", () => {
    const states: BuyoutState[] = ["being_invoiced", "invoiced", "paid", "being_voided", "voided", "refused", "stuck"];
    const reasons: EarlierFacts["endReason"][] = [null, "switched_back", "student_moved", "voided_in_quickbooks", "closed_by_staff", "earlier_company"];
    const flags: EarlierFacts["flag"][] = [null, "missing", "other_customer", "student_moved", "paid_before_void", "void_refused", "given_up"];
    const itemSets: LookItem[][] = [[], [item("invoice_create", "given_up", false)], [item("invoice_create", "given_up", true)], [item("invoice_create", "given_up", true, "7001")],
      [item("invoice_create", "done", true, "5001")], [item("invoice_void", "given_up", false), item("invoice_create", "done", true, "5001")],
      [item("invoice_void", "given_up", true), item("invoice_create", "done", true, "5001")], [item("invoice_void", "done", true), item("invoice_create", "done", true, "5001")],
      [item("invoice_void", "stuck", true)], [item("invoice_create", "stuck", true)]];
    const kinds = new Set<EarlierKind>();
    let n = 0;
    for (const state of states) for (const endReason of reasons) for (const flag of flags) for (const items of itemSets) for (const invoiceQboId of [null, "5001"]) {
      const v = earlierCompanyLook(earlier({ state, endReason, flag, items, invoiceQboId }));
      const at = JSON.stringify({ state, endReason, flag, items, invoiceQboId });
      // The table, as the slice's brief states it.
      const known = invoiceQboId ?? items.find((i) => i.op === "invoice_create" && i.resultQboId !== null)?.resultQboId ?? null;
      const expected: EarlierKind = state === "refused" ? "nothing_to_settle"
        : state === "paid" ? (flag === "paid_before_void" || flag === "student_moved" ? "refund_owed" : "nothing_to_settle")
          : state === "voided" && endReason !== "earlier_company" ? "nothing_to_settle"
            : known === null ? (items.some((i) => i.op === "invoice_create" && i.sent) ? "may_be_made" : "nothing_to_settle")
              : items.some((i) => i.op === "invoice_void" && i.sent && i.state !== "done") ? "void_may_have_gone" : "invoice_stands";
      expect(v.kind, at).toBe(expected);
      expect(v.words.startsWith(EARLIER_WORDS[v.kind]), at).toBe(true);
      expect(v.madeAfter && v.kind !== "invoice_stands", at).toBe(false);
      expect(v.note !== null, at).toBe(v.kind === "may_be_made");
      kinds.add(v.kind); n++;
    }
    expect(n).toBe(states.length * reasons.length * flags.length * itemSets.length * 2);
    expect([...kinds].sort()).toEqual(["invoice_stands", "may_be_made", "nothing_to_settle", "refund_owed", "void_may_have_gone"]);
    // Each kind's words name "the earlier QuickBooks company", never a company of its own.
    for (const words of Object.values(EARLIER_WORDS)) expect(words).toContain("earlier QuickBooks company");
  });
});
