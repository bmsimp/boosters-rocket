import { describe, it, expect } from "vitest";
import { BUYOUT_NOTE_PREFIX, checksOwnFlag, CLOSE_WORDS, closeVerdict, EARLIER_WORDS, earlierCompanyLook, MADE_AFTER_WORDS, type CloseFacts, type CloseItem, type EarlierFacts, type EarlierKind,
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
// reason, flag, last code and set of queue items such a buy-out can have falls in one kind.
describe("an earlier company's buy-out, for the treasurer (stage 4's slice M7b)", () => {
  const ID = "00000000-0000-4000-8000-0000000000b7";
  /**
   * A queue item as the portal leaves one. `answered`: done, or closed by the portal on QuickBooks' answer (itemClosed(),
   * no note); false for one given up by staff or by the clear (a note), or still waiting or stuck.
   */
  const item = (op: LookItem["op"], state: LookItem["state"], sent: boolean, o: { resultQboId?: string | null; answered?: boolean } = {}): LookItem =>
    ({ op, state, sent, resultQboId: o.resultQboId ?? null, answered: o.answered ?? state === "done" });
  const created = (id = "5001") => item("invoice_create", "done", true, { resultQboId: id });
  /** A void closed by voidKept() on QuickBooks' answer: given up, no note, `sent` as an earlier try left it. */
  const voidKept = (sent: boolean) => item("invoice_void", "given_up", sent, { answered: true });
  /** A void the clear (or staff) gave up before any answer came back. */
  const voidGivenUp = (sent: boolean) => item("invoice_void", "given_up", sent);
  const earlier = (f: Partial<EarlierFacts>): EarlierFacts => ({ id: ID, state: "voided", endReason: "earlier_company", flag: null, lastCode: null, invoiceQboId: "5001",
    items: [created()], ...f });
  const kind = (f: Partial<EarlierFacts>) => earlierCompanyLook(earlier(f)).kind;

  it("an ended one whose invoice is known, with no void left unanswered and nothing read that says it is gone or part paid: the invoice stands", () => {
    // Ended from invoiced (its create done), or flagged by the daily check alone, or with a void QuickBooks refused.
    expect(earlierCompanyLook(earlier({}))).toEqual({ kind: "invoice_stands", invoiceQboId: "5001", madeAfter: false, note: null, words: EARLIER_WORDS.invoice_stands });
    expect(kind({ flag: "other_customer" })).toBe("invoice_stands");
    expect(kind({ flag: "student_moved" })).toBe("invoice_stands");
    expect(kind({ flag: "void_refused", lastCode: "fault_6240", items: [voidKept(false), created()] })).toBe("invoice_stands");
    expect(kind({ flag: "void_refused", lastCode: "fault_6240", items: [voidKept(true), created()] })).toBe("invoice_stands");
    expect(EARLIER_WORDS.invoice_stands).toContain("waive the requirement");
    expect(EARLIER_WORDS.invoice_stands).toContain("void it there");
    // It says nothing of whether it was paid: the stored figures may have shown it paid before the clear (slice M7b2's).
    expect(EARLIER_WORDS.invoice_stands).not.toContain("unpaid");
  });

  it("an ended one whose invoice came from a given-up create's item, or was recorded on it after the item was given up: the invoice stands, made for a request given up", () => {
    const fromItem = earlierCompanyLook(earlier({ invoiceQboId: null, items: [item("invoice_create", "given_up", true, { resultQboId: "6101" })] }));
    expect(fromItem).toEqual({ kind: "invoice_stands", invoiceQboId: "6101", madeAfter: true, note: null, words: `${EARLIER_WORDS.invoice_stands} ${MADE_AFTER_WORDS}` });
    // invoiceFoundAfterEnding() recorded it on the buy-out: the item, still given up, names the same invoice.
    expect(earlierCompanyLook(earlier({ invoiceQboId: "6102", items: [item("invoice_create", "given_up", true, { resultQboId: "6102" })] })))
      .toMatchObject({ kind: "invoice_stands", invoiceQboId: "6102", madeAfter: true });
    // The newest create that names one is read.
    expect(earlierCompanyLook(earlier({ invoiceQboId: null, items: [item("invoice_create", "given_up", true), item("invoice_create", "given_up", true, { resultQboId: "6103" })] })))
      .toMatchObject({ kind: "invoice_stands", invoiceQboId: "6103", madeAfter: true });
    // The words claim no order of events: in M7a2's held finish QuickBooks made it before the clear gave the item up.
    expect(MADE_AFTER_WORDS).not.toContain("after");
  });

  it("an ended one whose newest void QuickBooks never answered may be voided already, whether or not the item was marked sent", () => {
    const v = earlierCompanyLook(earlier({ items: [voidGivenUp(true), created()] }));
    expect(v).toEqual({ kind: "void_may_have_gone", invoiceQboId: "5001", madeAfter: false, note: null, words: EARLIER_WORDS.void_may_have_gone });
    // A void is not marked sent before it goes: one the clear gave up mid-send, or a restart cut off, is unsent.
    expect(kind({ items: [voidGivenUp(false), created()] })).toBe("void_may_have_gone");
    expect(kind({ items: [item("invoice_void", "waiting", false), created()] })).toBe("void_may_have_gone");
    expect(kind({ items: [item("invoice_void", "stuck", true)] })).toBe("void_may_have_gone");
    // Whatever an older void's answer left on the buy-out: the newest void is the one on its way.
    expect(kind({ flag: "missing", lastCode: "invoice_gone", items: [voidGivenUp(false), voidKept(false), created()] })).toBe("void_may_have_gone");
    expect(kind({ invoiceQboId: null, items: [voidGivenUp(true), item("invoice_create", "given_up", true, { resultQboId: "6104" })] })).toBe("void_may_have_gone");
  });

  it("an ended one whose void's read found something paid and the rest owed: part paid, not to be voided as it is", () => {
    for (const flag of ["paid_before_void", "student_moved"] as const) {
      for (const sent of [false, true]) {
        expect(earlierCompanyLook(earlier({ flag, lastCode: "paid", items: [voidKept(sent), created()] })), `${flag} ${sent}`)
          .toEqual({ kind: "part_paid", invoiceQboId: "5001", madeAfter: false, note: null, words: EARLIER_WORDS.part_paid });
      }
    }
    expect(EARLIER_WORDS.part_paid).toContain("refund what they paid");
  });

  it("an ended one the portal last saw gone from the family's invoices: by a void's live read, or by the daily check's flag", () => {
    for (const sent of [false, true]) expect(kind({ flag: "missing", lastCode: "invoice_gone", items: [voidKept(sent), created()] })).toBe("last_seen_gone");
    expect(kind({ flag: "student_moved", lastCode: "invoice_gone", items: [voidKept(false), created()] })).toBe("last_seen_gone");
    expect(kind({ flag: "missing" })).toBe("last_seen_gone");
    expect(EARLIER_WORDS.last_seen_gone).not.toContain("void it");
  });

  it("an ended one with no invoice known whose create was sent and never answered: it may be made, and the note to search for is its own", () => {
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

  it("nothing to settle: an ended one with no invoice and no create left unanswered, a refused one, one whose void was done, and one that ended any other way", () => {
    expect(kind({ invoiceQboId: null, items: [] })).toBe("nothing_to_settle");
    expect(kind({ invoiceQboId: null, items: [item("invoice_create", "given_up", false)] })).toBe("nothing_to_settle");
    // A create QuickBooks refused, closed on that answer.
    expect(kind({ invoiceQboId: null, items: [item("invoice_create", "given_up", true, { answered: true })] })).toBe("nothing_to_settle");
    expect(kind({ state: "refused", endReason: null, invoiceQboId: null, lastCode: "fault_6000", items: [item("invoice_create", "given_up", true)] })).toBe("nothing_to_settle");
    expect(kind({ items: [item("invoice_void", "done", true), created()] })).toBe("nothing_to_settle");
    for (const endReason of ["switched_back", "student_moved", "voided_in_quickbooks", "closed_by_staff"] as const) {
      expect(kind({ endReason, items: [voidGivenUp(true), created()] }), endReason).toBe("nothing_to_settle");
    }
    expect(EARLIER_WORDS.nothing_to_settle).toContain("earlier QuickBooks company");
  });

  it("puts every state, end reason, flag, last code and set of items in exactly one kind", () => {
    const states: BuyoutState[] = ["being_invoiced", "invoiced", "paid", "being_voided", "voided", "refused", "stuck"];
    const reasons: EarlierFacts["endReason"][] = [null, "switched_back", "student_moved", "voided_in_quickbooks", "closed_by_staff", "earlier_company"];
    const flags: EarlierFacts["flag"][] = [null, "missing", "other_customer", "student_moved", "paid_before_void", "void_refused", "given_up"];
    const codes: (string | null)[] = [null, "paid", "invoice_gone", "fault_6240", "timeout"];
    const itemSets: LookItem[][] = [[], [item("invoice_create", "given_up", false)], [item("invoice_create", "given_up", true)], [item("invoice_create", "given_up", true, { answered: true })],
      [item("invoice_create", "given_up", true, { resultQboId: "7001" })], [created()],
      [voidGivenUp(false), created()], [voidGivenUp(true), created()], [voidKept(false), created()], [voidKept(true), created()],
      [item("invoice_void", "done", true), created()], [item("invoice_void", "waiting", false), created()], [item("invoice_void", "stuck", true)], [item("invoice_create", "stuck", true)],
      [voidGivenUp(false), voidKept(true), created()], [voidKept(false), voidGivenUp(true), created()]];
    const kinds = new Set<EarlierKind>();
    let n = 0;
    for (const state of states) for (const endReason of reasons) for (const flag of flags) for (const lastCode of codes) for (const items of itemSets) for (const invoiceQboId of [null, "5001"]) {
      const v = earlierCompanyLook(earlier({ state, endReason, flag, lastCode, items, invoiceQboId }));
      const at = JSON.stringify({ state, endReason, flag, lastCode, items, invoiceQboId });
      // The table, written out.
      const known = invoiceQboId ?? items.find((i) => i.op === "invoice_create" && i.resultQboId !== null)?.resultQboId ?? null;
      const lastVoid = items.find((i) => i.op === "invoice_void");
      const expected: EarlierKind = state === "refused" ? "nothing_to_settle"
        : state === "paid" ? (flag === "paid_before_void" || flag === "student_moved" ? "refund_owed" : "nothing_to_settle")
          : state === "voided" && endReason !== "earlier_company" ? "nothing_to_settle"
            : known === null ? (items.some((i) => i.op === "invoice_create" && i.sent && !i.answered) ? "may_be_made" : "nothing_to_settle")
              : lastVoid && !lastVoid.answered ? "void_may_have_gone"
                : lastVoid?.state === "done" ? "nothing_to_settle"
                  : lastCode === "paid" && (flag === "paid_before_void" || flag === "student_moved") ? "part_paid"
                    : lastCode === "invoice_gone" || flag === "missing" ? "last_seen_gone" : "invoice_stands";
      expect(v.kind, at).toBe(expected);
      expect(v.words.startsWith(EARLIER_WORDS[v.kind]), at).toBe(true);
      expect(v.madeAfter && v.kind !== "invoice_stands", at).toBe(false);
      expect(v.note !== null, at).toBe(v.kind === "may_be_made");
      kinds.add(v.kind); n++;
    }
    expect(n).toBe(states.length * reasons.length * flags.length * codes.length * itemSets.length * 2);
    expect([...kinds].sort()).toEqual(["invoice_stands", "last_seen_gone", "may_be_made", "nothing_to_settle", "part_paid", "refund_owed", "void_may_have_gone"]);
    // Each kind's words name "the earlier QuickBooks company", never a company of its own.
    for (const words of Object.values(EARLIER_WORDS)) expect(words).toContain("earlier QuickBooks company");
  });
});

// Which flags finding an invoiced buy-out paid takes off (checksOwnFlag()): the daily check's own, never a void's or a
// move's. The daily check and the change of company's mark (stage 4's slice M7b2) both read it.
describe("the daily check's own flags, which a paid finding takes off", () => {
  const own = (f: Partial<CloseFacts>) => { const x = facts(f); return checksOwnFlag({ state: x.state, flag: x.flag, lastCode: x.lastCode, items: x.items }); };

  it("are an invoice the check didn't find or found on another customer, and a student_moved it set by itself", () => {
    expect(own({ flag: "missing" })).toBe(true);
    expect(own({ flag: "other_customer" })).toBe(true);
    expect(own({ flag: "student_moved" })).toBe(true);
  });

  it("are never a void's or a move's: a student_moved beside a void item or a void's code, paid_before_void, void_refused, given_up", () => {
    expect(own({ flag: "student_moved", items: [create("done", true), voidItem("done", true)] })).toBe(false);
    expect(own({ flag: "student_moved", lastCode: "paid" })).toBe(false);
    expect(own({ flag: "paid_before_void", lastCode: "paid" })).toBe(false);
    expect(own({ flag: "void_refused", lastCode: "fault_6240" })).toBe(false);
    expect(own({ flag: "given_up" })).toBe(false);
  });

  it("is nothing to take off when there is no flag", () => {
    expect(own({ flag: null })).toBe(false);
  });
});
