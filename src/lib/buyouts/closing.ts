/**
 * When staff may close a buy-out from Reconciliation, as a pure rule (v1 spec §11.5; the close itself is ./close.ts).
 * Closing sends nothing to QuickBooks and never voids or changes an invoice: it only ends the buy-out in the portal, so
 * the family can choose again or volunteer. So it is offered only when the portal can tell that no unpaid invoice of the
 * buy-out stands: QuickBooks refused the invoice; the create was never sent (every try of it surely sent nothing); the
 * invoice is gone from QuickBooks; or it is paid in full and a void was asked for (a guardian switched back, or the
 * student moved). Where an unpaid invoice may stand, the words say what to do in QuickBooks first, and the daily check
 * or "Try again now" then sees what was done there. Nothing here reads the database or the clock.
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
  if (f.state === "invoiced" && f.flag === "student_moved" && f.lastCode === null && !f.items.some((i) => i.op === "invoice_void")) return close("moved_away");
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
