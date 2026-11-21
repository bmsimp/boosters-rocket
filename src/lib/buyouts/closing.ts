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

/**
 * A queue item of the buy-out's, with the invoice QuickBooks made for it, kept on the item (`result_qbo_id`) even once
 * it was given up, and whether QuickBooks' own answer closed it (`answered`): done, or given up by the portal on what
 * QuickBooks said (itemClosed(), src/lib/buyouts/writes.ts, which leaves no note). One given up by someone (staff, a
 * change of company's clear, the worker for another company) carries their note, and was closed without an answer.
 */
export type LookItem = CloseItem & { resultQboId: string | null; answered: boolean };

/**
 * What the rule reads of one earlier company's buy-out: the row's own fields, and every queue item made for it, newest
 * first. `here`: its company (`realm_id`) is the roster's again, the club having switched away and back (stage 4's slice
 * M8), so its invoice is in the QuickBooks company connected now, and the words say so.
 */
export type EarlierFacts = {
  id: string; state: BuyoutState; endReason: (typeof buyout.$inferSelect)["endReason"]; flag: Flag | null; lastCode: string | null; invoiceQboId: string | null;
  items: readonly LookItem[]; here?: boolean;
};

/**
 * QuickBooks' answer to a buy-out write that reached it after a change of company had ended the buy-out (stage 4's slice
 * M8, M7b's leftover): kept as the buy-out's `last_code`, its state and end reason unchanged (src/lib/buyouts/writes.ts:
 * createRefused(), voided(), voidKept()). Codes no QuickBooks answer or try ever leaves there, so the rule can tell one
 * from what the portal knew before the change. QuickBooks' own code is in the audit row.
 */
export const AFTER_ENDING = {
  /** The create was refused: no invoice was made. */
  refused: "after_end_refused",
  /** The void went through, or the invoice was read already voided. */
  voided: "after_end_voided",
  /** The void's read found something paid and the rest owed, so it wasn't sent. */
  paid: "after_end_paid",
  /** The void's read found it paid in full, so it wasn't sent. */
  paidInFull: "after_end_paid_in_full",
  /** The void's read found the invoice gone from the customer's. */
  gone: "after_end_gone",
  /** QuickBooks refused the void (or the read before it): the invoice stands. */
  voidRefused: "after_end_void_refused",
} as const;

/**
 * What it leaves to settle in the earlier company's books: `invoice_stands` (an invoice is known, no void of it was
 * left unanswered, and nothing the portal last read says it is gone or part paid), `void_may_have_gone` (a void was
 * on its way, or was given up before QuickBooks answered it), `part_paid` (a void's read found something paid and the
 * rest owed, so it wasn't sent), `last_seen_gone` (the portal last saw the invoice gone from the family's), `may_be_made`
 * (no invoice known, but a create was sent and never answered), `refund_owed` (paid there although it was to be
 * cancelled), or `nothing_to_settle`.
 */
export type EarlierKind = "invoice_stands" | "void_may_have_gone" | "part_paid" | "last_seen_gone" | "may_be_made" | "refund_owed" | "nothing_to_settle";
export type EarlierLook = {
  kind: EarlierKind;
  /** The invoice it is about: the buy-out's own, else the one its newest create that names one kept on its item. */
  invoiceQboId: string | null;
  /** For `invoice_stands`: a given-up create names the invoice, so QuickBooks made it for a request the portal had given up. */
  madeAfter: boolean;
  /** For `may_be_made`: the private note every buy-out invoice carries, to search that company's invoices for. */
  note: string | null;
  words: string;
};

/** What every buy-out invoice's private note starts with (INVOICE_WRITES.notePrefix, src/lib/quickbooks/client.ts, which a pure rule can't import). */
export const BUYOUT_NOTE_PREFIX = "Booster Rocket buy-out ";

/**
 * The words for a buy-out a change of company ended whose company the club has since connected again (`here`): its
 * invoice is in the QuickBooks company connected now (stage 4's slice M8).
 */
export const HERE_WORDS: Record<EarlierKind, string> = {
  invoice_stands: "This buy-out ended when the club connected a different QuickBooks company, and its invoice is still in the QuickBooks company connected now, as far as the portal knows: nothing was sent to void it. "
    + "If the family paid it, they paid instead: waive the requirement for them on their season page. If they didn't, void it in QuickBooks, and the family can volunteer or choose to pay instead again.",
  void_may_have_gone: "A void of its invoice was on its way when the club connected a different QuickBooks company, and the portal never heard back, so it may be voided already. "
    + "Its invoice is in the QuickBooks company connected now: look at it there. If it still stands unpaid, void it; if the family paid it, waive the requirement for them on their season page.",
  part_paid: "Something was paid on its invoice, and the rest was still owed when the portal last looked, so the portal didn't void it before the club connected a different QuickBooks company. "
    + "Its invoice is in the QuickBooks company connected now: settle it there. If the family pays the rest, they paid instead, so waive the requirement for them on their season page; if they'll volunteer instead, refund what they paid and void it.",
  last_seen_gone: "When the portal last looked, QuickBooks no longer showed this invoice to the family: it was most likely voided or deleted, and nothing is owed on it. "
    + "It would be in the QuickBooks company connected now: look for it there if you'd like to be sure.",
  may_be_made: "The portal asked QuickBooks for its invoice and never heard back before the club connected a different company, so the invoice may have been made in the QuickBooks company connected now. "
    + "Look in its invoices for the note shown here, and void it if it is there and unpaid; if the family paid it, waive the requirement for them on their season page.",
  refund_owed: "The family paid this in the QuickBooks company connected now, though the buy-out was to be cancelled. If they're owed the money back, refund it there. Closing it ends the buy-out here, and the family volunteers instead.",
  nothing_to_settle: "Nothing is left to settle in QuickBooks for this.",
};

/**
 * Said of a buy-out a change of company ended whose void QuickBooks then found paid in full (AFTER_ENDING.paidInFull):
 * the family paid, though the buy-out was to be cancelled. It ended, so there is nothing to close here.
 */
export const PAID_AFTER_ENDING_WORDS = {
  earlier: "The family paid this invoice in full in the earlier QuickBooks company, though the buy-out was to be cancelled, so the portal didn't void it. "
    + "If they're owed the money back, refund it there; if they paid instead, waive the requirement for them on their season page.",
  here: "The family paid this invoice in full in the QuickBooks company connected now, though the buy-out was to be cancelled, so the portal didn't void it. "
    + "If they're owed the money back, refund it there; if they paid instead, waive the requirement for them on their season page.",
} as const;

export const EARLIER_WORDS: Record<EarlierKind, string> = {
  invoice_stands: "Its invoice is still in the earlier QuickBooks company's books as far as the portal knows: nothing was sent there to void it. "
    + "If the family paid it there, they paid instead: waive the requirement for them on their season page. If they didn't, void it there, and the family can volunteer or choose to pay instead again.",
  void_may_have_gone: "A void of its invoice was on its way to the earlier QuickBooks company when the portal stopped sending there, and the portal never heard back, so it may be voided already. "
    + "Look at it there: if it still stands unpaid, void it; if the family paid it, waive the requirement for them on their season page.",
  part_paid: "Something was paid on its invoice in the earlier QuickBooks company, and the rest was still owed when the portal last looked, so the portal didn't void it. "
    + "Settle it there: if the family pays the rest, they paid instead, so waive the requirement for them on their season page; if they'll volunteer instead, refund what they paid and void it.",
  last_seen_gone: "When the portal last looked, the earlier QuickBooks company no longer showed this invoice to the family: it was most likely voided or deleted there, and nothing is owed on it. "
    + "Look for it there if you'd like to be sure.",
  may_be_made: "The portal asked the earlier QuickBooks company for its invoice and never heard back, so the invoice may have been made there. "
    + "Look in that company's invoices for the note shown here, and void it if it is there and unpaid; if the family paid it, waive the requirement for them on their season page.",
  refund_owed: "The family paid this in the earlier QuickBooks company, though the buy-out was to be cancelled. If they're owed the money back, refund it there. Closing it ends the buy-out here, and the family volunteers instead.",
  nothing_to_settle: "Nothing is left to settle in the earlier QuickBooks company for this.",
};
/** Said beside `invoice_stands` when a given-up create names the invoice. */
export const MADE_AFTER_WORDS = "QuickBooks made this invoice for a request the portal had given up.";

const looker = (here: boolean) => (kind: EarlierKind, invoiceQboId: string | null, o: { madeAfter?: boolean; note?: string | null; words?: string } = {}): EarlierLook => {
  const words = o.words ?? (here ? HERE_WORDS : EARLIER_WORDS)[kind];
  return { kind, invoiceQboId, madeAfter: o.madeAfter ?? false, note: o.note ?? null, words: o.madeAfter ? `${words} ${MADE_AFTER_WORDS}` : words };
};

/**
 * What an earlier company's buy-out leaves to settle there (the caller has told it is one: its `realm_id` is not the
 * roster's). A refused one billed nothing; a paid one keeps counting, and only one paid although its void was asked for
 * (`paid_before_void`, `student_moved`) may be owed a refund, which the close (closeVerdict()'s `paid_in_full`) then ends
 * here; one that ended any other way than by the change of company (voided, closed by staff) is history. One the change
 * of company ended (or, which the clear leaves none of, one still live in that company) is read from its invoice, its
 * queue items and what the portal last read of it:
 * - With no invoice known, a create sent and never answered may have made one; one never sent made nothing.
 * - Its newest void, unless QuickBooks' answer closed it, may have gone through: a void is not marked sent before it
 *   goes (only a create is), so one the clear gave up mid-send, or a restart cut off, looks like one never sent. One
 *   done voided the invoice.
 * - A void QuickBooks answered left its answer on the buy-out (voidKept()): something paid and the rest owed (`paid`),
 *   or the invoice gone (`invoice_gone`, as the daily check's `missing` flag says from the stored figures); a refused
 *   void (`void_refused`) left the invoice standing.
 * - An answer that came after the change of company ended it is on the buy-out too (AFTER_ENDING, stage 4's slice M8),
 *   and is read first: a refused create made nothing, a void that went through left nothing, and a void's read that
 *   found it part paid, paid in full or gone says so; a refused void left the invoice standing. A void still unanswered
 *   may have gone through.
 * One whose company the roster names again (`here`) reads the same, in words for the company connected now.
 */
export function earlierCompanyLook(f: EarlierFacts): EarlierLook {
  const here = f.here ?? false, look = looker(here);
  if (f.state === "refused") return look("nothing_to_settle", null);
  if (f.state === "paid") return f.flag === "paid_before_void" || f.flag === "student_moved" ? look("refund_owed", f.invoiceQboId) : look("nothing_to_settle", f.invoiceQboId);
  if (f.state === "voided" && f.endReason !== "earlier_company") return look("nothing_to_settle", f.invoiceQboId);
  const creates = f.items.filter((i) => i.op === "invoice_create");
  const invoice = f.invoiceQboId ?? creates.find((i) => i.resultQboId !== null)?.resultQboId ?? null;
  const afterEnding = f.state === "voided" && f.endReason === "earlier_company" ? f.lastCode : null;
  if (invoice === null) {
    if (afterEnding === AFTER_ENDING.refused) return look("nothing_to_settle", null);
    return creates.some((i) => i.sent && !i.answered) ? look("may_be_made", null, { note: `${BUYOUT_NOTE_PREFIX}${f.id}` }) : look("nothing_to_settle", null);
  }
  switch (afterEnding) {
    case AFTER_ENDING.voided: return look("nothing_to_settle", invoice);
    case AFTER_ENDING.gone: return look("last_seen_gone", invoice);
    case AFTER_ENDING.paid: return look("part_paid", invoice);
    case AFTER_ENDING.paidInFull: return look("refund_owed", invoice, { words: PAID_AFTER_ENDING_WORDS[here ? "here" : "earlier"] });
    case AFTER_ENDING.voidRefused: return look("invoice_stands", invoice, { madeAfter: creates.some((i) => i.state === "given_up" && i.resultQboId === invoice) });
  }
  const lastVoid = f.items.find((i) => i.op === "invoice_void");
  if (lastVoid && !lastVoid.answered) return look("void_may_have_gone", invoice);
  if (lastVoid?.state === "done") return look("nothing_to_settle", invoice);
  if (f.lastCode === "paid" && (f.flag === "paid_before_void" || f.flag === "student_moved")) return look("part_paid", invoice);
  if (f.lastCode === "invoice_gone" || f.flag === "missing") return look("last_seen_gone", invoice);
  return look("invoice_stands", invoice, { madeAfter: creates.some((i) => i.state === "given_up" && i.resultQboId === invoice) });
}
