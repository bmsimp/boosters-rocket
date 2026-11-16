/**
 * How a payment requirement is met (v1 spec §10.2), as pure functions: it names a QuickBooks product or service, and
 * is met for a family or a student when invoices carrying that item exist for them and none of those has an open
 * balance. Which invoices are "theirs" is decided before this: for a per-student requirement the invoices raised on
 * that student's own customer, for a per-family one those raised on any of the family's customers
 * (./payment-standings.ts). Nothing here reads the database or the clock.
 */
import type { StoredInvoice } from "@/lib/db/schema";
import type { Standing } from "@/lib/seasons/progress";
import { formatMoney } from "./cents";

export const PAID: Standing = { met: true, words: "Paid" };
export const NO_INVOICE_YET: Standing = { met: false, words: "No invoice yet" };

/**
 * How a payment requirement for `itemQboId` stands, given the invoices that are this family's or this student's.
 * `invoices` is undefined when nothing can be said for them (no figures that may be shown): that, no item chosen yet,
 * and no invoice carrying the item all read "No invoice yet". An invoice paid by a credit has no balance left, and is
 * paid. A credit the family holds that hasn't been applied pays nothing: the invoice is still open in QuickBooks.
 * With `amount` false the words leave out how much is left to pay.
 */
export function paymentStanding(itemQboId: string | null, invoices: readonly StoredInvoice[] | undefined, o: { amount: boolean } = { amount: true }): Standing {
  if (itemQboId === null || invoices === undefined) return NO_INVOICE_YET;
  const carrying = invoices.filter((i) => i.itemQboIds?.includes(itemQboId));
  if (carrying.length === 0) return NO_INVOICE_YET;
  const open = carrying.filter((i) => i.balanceCents > 0);
  if (open.length === 0) return PAID;
  const currencies = new Set(open.map((i) => i.currency));
  // Invoices in two currencies have no one amount to say; and the amount is said only to whoever may read it, from figures that are current.
  if (currencies.size > 1 || !o.amount) return { met: false, words: "Not paid yet" };
  return { met: false, words: `Not paid yet (${formatMoney(open.reduce((sum, i) => sum + i.balanceCents, 0), open[0]!.currency)} left to pay)` };
}

/**
 * The invoices that count for one family or student: all of the family's for the family itself, and only those raised
 * on the student's own customer for a student. `familyInvoices` is what may be shown of the family's figures.
 */
export function invoicesFor(subjectQboId: string, familyQboId: string, familyInvoices: readonly StoredInvoice[]): StoredInvoice[] {
  return subjectQboId === familyQboId ? [...familyInvoices] : familyInvoices.filter((i) => i.customerQboId === subjectQboId);
}
