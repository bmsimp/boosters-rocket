/**
 * When staff may close a buy-out from Reconciliation, as a pure rule (v1 spec §11.5; the close itself is ./close.ts).
 * Closing sends nothing to QuickBooks and never voids or changes an invoice: it only ends the buy-out in the portal, so
 * the family can choose again or volunteer. So it is offered only when the portal can tell that no unpaid invoice of the
 * buy-out stands: QuickBooks refused the invoice; the create was never sent (every try of it surely sent nothing); the
 * invoice is gone from QuickBooks; or it is paid in full and a void was asked for (a guardian switched back, or the
 * student moved). Where an unpaid invoice may stand, the words say what to do in QuickBooks first, and the daily check
 * or "Try again now" then sees what was done there. Beside it, what a buy-out of an earlier QuickBooks company leaves to
 * settle in that company's books by hand (earlierCompanyLook(), stage 4's slice M7b), for the treasurer's list on
 * Reconciliation and the family's buy-outs page. Nothing here reads the database or the clock.
 */
import type { BuyoutState, buyout } from "@/lib/db/schema";

type Flag = NonNullable<(typeof buyout.$inferSelect)["flag"]>;

/** A queue item of the buy-out's, as far as closing goes: what it was, where it stands, and whether it may have reached QuickBooks. */
export type CloseItem = { op: "invoice_create" | "invoice_void"; state: "waiting" | "stuck" | "done" | "given_up"; sent: boolean };

/** What the rule reads of one buy-out: the row's own fields, and every queue item made for it. */
export type CloseFacts = { state: BuyoutState; flag: Flag | null; lastCode: string | null; invoiceQboId: string | null; items: readonly CloseItem[] };

export type CloseWhy = "refused" | "never_sent" | "invoice_gone" | "looks_gone" | "moved_away" | "paid_in_full";
export type KeepWhy = "ended" | "in_flight" | "may_be_made" | "invoice_stands" | "other_customer" | "part_paid" | "nothing_to_do";
/** Whether staff may close it, why, and in words what closing does or what to do in QuickBooks first. */
export type CloseVerdict = { may: true; why: CloseWhy; words: string } | { may: false; why: KeepWhy; words: string };

export const CLOSE_WORDS: Record<CloseWhy, string> = {
  refused: "QuickBooks refused the invoice, so nothing was billed. Closing it takes it off this list; the family can choose again or volunteer.",
  never_sent: "The invoice was never sent to QuickBooks, so nothing was billed. Closing it gives up the stuck change and lets the family choose again or volunteer.",
  invoice_gone: "QuickBooks no longer shows the invoice, so nothing is owed on it. Closing it ends the buy-out here; the family can choose again or volunteer.",
  looks_gone: "QuickBooks didn't show the invoice at the last daily read. Closing reads QuickBooks again first, and closes it only if the invoice is still not there: nothing is owed on it then, and the family can choose again or volunteer.",
  moved_away: "The student it was billed to is under another family, or inactive, in QuickBooks, so the daily check can't follow its invoice. Void the invoice in QuickBooks if it shouldn't be billed. Closing reads QuickBooks first, and closes it only if the invoice is voided or gone: nothing is owed on it then, and the family can choose again or volunteer.",
  paid_in_full: "The invoice is paid in full, but the buy-out was to be cancelled. If the family is owed the money back, refund it in QuickBooks. Closing it ends the buy-out here, and the family volunteers instead.",
};

/**
 * A `student_moved` flag the daily check set by itself (./daily-check.ts, flagMovedAway()): on an invoiced buy-out, with
 * no void ever tried (no code from one, and no void item). A move staff made, or a void, sets the flag with a void
 * beside it. Only this flag is the check's to take off again, once the student is back under the family.
 */
export function movedAwayByTheCheck(f: { state: BuyoutState; flag: Flag | null; lastCode: string | null; items: readonly Pick<CloseItem, "op">[] }): boolean {
  return f.state === "invoiced" && f.flag === "student_moved" && f.lastCode === null && !f.items.some((i) => i.op === "invoice_void");
}

const keep = (why: KeepWhy, words: string): CloseVerdict => ({ may: false, why, words });
const close = (why: CloseWhy): CloseVerdict => ({ may: true, why, words: CLOSE_WORDS[why] });

export function closeVerdict(f: CloseFacts): CloseVerdict {
  if (f.state === "voided") return keep("ended", "It has ended: there is nothing to close.");
  const open = f.items.filter((i) => i.state === "waiting" || i.state === "stuck");
  // A waiting item may be in QuickBooks' hands right now (the worker's try, or the guardian's first one).
  if (open.some((i) => i.state === "waiting") || f.state === "being_invoiced" || f.state === "being_voided") {
    return keep("in_flight", "A change to its invoice is on its way to QuickBooks. Wait for it to go through, then look again.");
  }
  if (f.state === "refused") return close("refused");
  if (f.invoiceQboId === null) {
    // No invoice the portal knows of. Only a create that every try surely didn't send leaves none in QuickBooks.
    const creates = f.items.filter((i) => i.op === "invoice_create");
    if (f.state === "stuck" && creates.length > 0 && creates.every((i) => !i.sent)) return close("never_sent");
    return keep("may_be_made", open.length > 0
      ? "QuickBooks may have made this invoice. Use Try again now, above: the portal looks for the invoice first, by the buy-out's note, and takes it up if it is there."
      : "QuickBooks may have made this invoice before the change was given up, so the portal can't tell whether one is owed. Look in QuickBooks for an invoice whose note starts “Booster Rocket buy-out”, and sort it out there.");
  }
  // Paid: its invoice stands, paid. Closing is for a void the portal wouldn't send, whatever any other flag says.
  if (f.state === "paid") {
    if (f.flag === "paid_before_void" || f.flag === "student_moved") return close("paid_in_full");
    return keep("nothing_to_do", "Paid instead: nothing to look at.");
  }
  // A void's own live read found it gone; a flag from stored figures alone is read again live by the close.
  if (f.lastCode === "invoice_gone") return close("invoice_gone");
  if (f.flag === "missing") return close("looks_gone");
  if (f.flag === "other_customer") {
    return keep("other_customer", "The invoice is on another customer in QuickBooks than the one it was made for. Put it back on that customer in QuickBooks: the daily check then takes the flag off.");
  }
  if (f.state === "invoiced" && f.lastCode === "paid" && (f.flag === "paid_before_void" || f.flag === "student_moved")) {
    return keep("part_paid", "Something was paid on the invoice and the rest is still owed. Settle it in QuickBooks first, by refunding and voiding it or by its being paid in full: the daily check then sees it voided or paid.");
  }
  // Flagged by the daily check alone (no void was tried, so no code): the student is no longer under the family in
  // QuickBooks, and the check can't follow the invoice. Read again live by the close, as looks_gone is.
  if (movedAwayByTheCheck(f)) return close("moved_away");
  if (f.state === "stuck") {
    return keep("invoice_stands", open.length > 0
      ? "The invoice may still be owed in QuickBooks. Void it there if it shouldn't be billed, then use Try again now, above: the portal reads the invoice first and sees it voided."
      : "The invoice may still be owed in QuickBooks, and the change was given up, so the portal can't tell. Sort it out in QuickBooks.");
  }
  if (f.flag !== null) {
    return keep("invoice_stands", "The invoice may still be owed in QuickBooks. Void it there if it shouldn't be billed: the daily check then sees it voided.");
  }
  return keep("nothing_to_do", "Its invoice is in QuickBooks as it should be: nothing to look at.");
}

/*
 * A buy-out of an earlier QuickBooks company: one whose `realm_id` is not the roster's company (stage 4's slice M7b,
 * open question 16). A change of company's clear ended every unpaid live one (`voided`, `end_reason` `earlier_company`,
 * src/lib/buyouts/company-change.ts) and kept the paid ones as they were; nothing of either can be sent to that
 * company now, so what may still stand in its books is the treasurer's, by hand. The state each ended one was in is
 * told here from its own fields and its queue items, never from the audit log.
 */

/** A queue item of the buy-out's, with the invoice QuickBooks made for it, kept on the item (`result_qbo_id`) even once it was given up. */
export type LookItem = CloseItem & { resultQboId: string | null };

/** What the rule reads of one earlier company's buy-out: the row's own fields, and every queue item made for it, newest first. */
export type EarlierFacts = {
  id: string; state: BuyoutState; endReason: (typeof buyout.$inferSelect)["endReason"]; flag: Flag | null; lastCode: string | null; invoiceQboId: string | null;
  items: readonly LookItem[];
};

/**
 * What it leaves to settle in the earlier company's books: `invoice_stands` (an invoice is known and no void of it was
 * ever sent), `void_may_have_gone` (a void was sent and never answered), `may_be_made` (no invoice known, but a create
 * was sent), `refund_owed` (paid there although it was to be cancelled), or `nothing_to_settle`.
 */
export type EarlierKind = "invoice_stands" | "void_may_have_gone" | "may_be_made" | "refund_owed" | "nothing_to_settle";
export type EarlierLook = {
  kind: EarlierKind;
  /** The invoice it is about: the buy-out's own, else the one its newest create that names one kept on its item. */
  invoiceQboId: string | null;
  /** The invoice came only from a given-up create's item: QuickBooks made it after the change that asked for it was given up. */
  madeAfter: boolean;
  /** For `may_be_made`: the private note every buy-out invoice carries, to search that company's invoices for. */
  note: string | null;
  words: string;
};

/** What every buy-out invoice's private note starts with (INVOICE_WRITES.notePrefix, src/lib/quickbooks/client.ts, which a pure rule can't import). */
export const BUYOUT_NOTE_PREFIX = "Booster Rocket buy-out ";

export const EARLIER_WORDS: Record<EarlierKind, string> = {
  invoice_stands: "Its invoice is still in the earlier QuickBooks company's books, unpaid as far as the portal last knew. "
    + "If the family paid it there, they paid instead: waive the requirement for them on their season page. If they didn't, void it there, and the family can volunteer or choose to pay instead again.",
  void_may_have_gone: "The portal sent the earlier QuickBooks company a void of its invoice and never heard back, so it may be voided already. "
    + "Look at it there: if it still stands unpaid, void it; if the family paid it, waive the requirement for them on their season page.",
  may_be_made: "The portal asked the earlier QuickBooks company for its invoice and never heard back, so the invoice may have been made there. "
    + "Look in that company's invoices for the note shown here, and void it if it is there and unpaid; if the family paid it, waive the requirement for them on their season page.",
  refund_owed: "The family paid this in the earlier QuickBooks company, though the buy-out was to be cancelled. If they're owed the money back, refund it there. Closing it ends the buy-out here, and the family volunteers instead.",
  nothing_to_settle: "Nothing is left to settle in the earlier QuickBooks company for this.",
};
/** Said beside `invoice_stands` when the invoice came only from a given-up create's item. */
export const MADE_AFTER_WORDS = "QuickBooks made this invoice after the portal had given up the change that asked for it.";

const look = (kind: EarlierKind, invoiceQboId: string | null, o: { madeAfter?: boolean; note?: string | null } = {}): EarlierLook =>
  ({ kind, invoiceQboId, madeAfter: o.madeAfter ?? false, note: o.note ?? null, words: o.madeAfter ? `${EARLIER_WORDS[kind]} ${MADE_AFTER_WORDS}` : EARLIER_WORDS[kind] });

/**
 * What an earlier company's buy-out leaves to settle there (the caller has told it is one: its `realm_id` is not the
 * roster's). A refused one billed nothing; a paid one keeps counting, and only one paid although its void was asked for
 * (`paid_before_void`, `student_moved`) may be owed a refund, which the close (closeVerdict()'s `paid_in_full`) then ends
 * here; one that ended any other way than by the change of company (voided, closed by staff) is history. One the change
 * of company ended (or, which the clear leaves none of, one still live in that company) is read from its invoice and its
 * queue items: a void sent and never answered (sent, not done) may have gone through; else a known invoice stands; with
 * none known, a create that was ever sent may have made one, and one never sent made nothing.
 */
export function earlierCompanyLook(f: EarlierFacts): EarlierLook {
  if (f.state === "refused") return look("nothing_to_settle", null);
  if (f.state === "paid") return f.flag === "paid_before_void" || f.flag === "student_moved" ? look("refund_owed", f.invoiceQboId) : look("nothing_to_settle", f.invoiceQboId);
  if (f.state === "voided" && f.endReason !== "earlier_company") return look("nothing_to_settle", f.invoiceQboId);
  const creates = f.items.filter((i) => i.op === "invoice_create");
  const invoice = f.invoiceQboId ?? creates.find((i) => i.resultQboId !== null)?.resultQboId ?? null;
  if (invoice === null) {
    return creates.some((i) => i.sent) ? look("may_be_made", null, { note: `${BUYOUT_NOTE_PREFIX}${f.id}` }) : look("nothing_to_settle", null);
  }
  if (f.items.some((i) => i.op === "invoice_void" && i.sent && i.state !== "done")) return look("void_may_have_gone", invoice);
  return look("invoice_stands", invoice, { madeAfter: creates.some((i) => i.state === "given_up" && i.resultQboId === invoice) });
}
