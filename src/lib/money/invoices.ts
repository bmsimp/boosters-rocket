import type { StoredInvoice } from "@/lib/db/schema";
import { currencyOf, toCents } from "./cents";
import { safePayLink } from "./pay-link";

/** How far back a paid invoice is still listed, and how many of them are kept. */
const PAID_MONTHS = 12;
const PAID_KEPT = 100;

type Raw = Record<string, unknown>;
const isRow = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const ref = (v: unknown): string | null => text((v as { value?: unknown } | null | undefined)?.value, 64);
/** A calendar date as QuickBooks writes it (2026-11-22), or null. */
const day = (v: unknown): string | null => {
  const d = typeof v === "string" ? v.trim().slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) ? d : null;
};
const byNumber = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
/** Dates in order, with "no date" last. */
const byDay = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);

/** A QuickBooks record id as the portal keeps one from an answer: digits only. */
const recordId = (v: unknown): string | null => { const id = text(v, 32); return id !== null && /^\d{1,19}$/.test(id) ? id : null; };

/**
 * The products and services an invoice's lines carry, in id order, each once: what a payment requirement is met by
 * (v1 spec §10.2). QuickBooks puts one on each sales line (`SalesItemLineDetail.ItemRef`) and, for a bundle, on the
 * group line (`GroupLineDetail.GroupItemRef`) and on each line inside it. Lines of other kinds (a subtotal, a discount)
 * carry none. NOT YET TRIED AGAINST A REAL QUICKBOOKS COMPANY: the owner's sandbox check confirms that `select * from
 * Invoice` returns `Line` with the item ids in these places (INVOICE_QUERIES in src/lib/quickbooks/client.ts). Null
 * when `Line` is there and isn't a list: an answer of a shape the portal doesn't know is refused, not read as "no items".
 */
export function itemsOf(lines: unknown): string[] | null {
  if (lines === undefined || lines === null) return [];
  if (!Array.isArray(lines)) return null;
  const found = new Set<string>();
  const visit = (line: unknown, depth: number) => {
    if (!isRow(line) || depth > 2) return;
    const sales = isRow(line.SalesItemLineDetail) ? recordId((line.SalesItemLineDetail.ItemRef as { value?: unknown } | null | undefined)?.value) : null;
    if (sales) found.add(sales);
    if (isRow(line.GroupLineDetail)) {
      const group = recordId((line.GroupLineDetail.GroupItemRef as { value?: unknown } | null | undefined)?.value);
      if (group) found.add(group);
      if (Array.isArray(line.GroupLineDetail.Line)) for (const inner of line.GroupLineDetail.Line) visit(inner, depth + 1);
    }
  };
  for (const line of lines) visit(line, 0);
  return [...found].sort(byNumber);
}

/** Today as a calendar date, in UTC: only used to decide how far back paid invoices go. */
export const utcDay = (at: Date = new Date()): string => at.toISOString().slice(0, 10);

/** The same day `months` months earlier (a 31st lands on the month's last day or just after: close enough for a window). */
export function monthsBefore(dayText: string, months: number): string {
  const [y, m, d] = dayText.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1 - months, d)).toISOString().slice(0, 10);
}

export type ShownInvoices = {
  /** Open invoices, soonest due first, then the paid ones, newest first. */
  invoices: StoredInvoice[];
  /** The sum of the open invoices: the family's total (v1 spec §8.3). */
  totalCents: number;
  /** The currency of the open invoices; null when they are in more than one, and then there is no single total. */
  currency: string | null;
};

export const openInvoices = (invoices: StoredInvoice[]) => invoices.filter((i) => i.balanceCents > 0);
export const paidInvoices = (invoices: StoredInvoice[]) => invoices.filter((i) => i.balanceCents <= 0);

/**
 * QuickBooks' invoices as a parent sees them. Pure. `forNames` holds the customers that were asked for, each with the
 * name to show beside its invoices (null for the family itself). The answer is refused whole (null) when any row isn't
 * an invoice of one of those customers, or has an amount that can't be read: a figure that might be wrong, or might be
 * another family's, is never shown. An invoice with nothing left to pay is kept only if it was for something (a voided
 * invoice has a total of zero) and is dated in the last 12 months.
 */
export function shownInvoices(raw: unknown[], forNames: ReadonlyMap<string, string | null>, today: string = utcDay()): ShownInvoices | null {
  const since = monthsBefore(today, PAID_MONTHS);
  const open: StoredInvoice[] = [], paid: StoredInvoice[] = [], seen = new Set<string>();
  for (const r of raw) {
    if (!isRow(r)) return null;
    const qboId = text(r.Id, 32), customer = ref(r.CustomerRef);
    if (qboId === null || !/^\d+$/.test(qboId)) return null;
    if (customer === null || !forNames.has(customer)) return null; // not one of the customers asked for
    if (seen.has(qboId)) continue;
    seen.add(qboId);
    const totalCents = toCents(r.TotalAmt), balanceCents = toCents(r.Balance);
    if (totalCents === null || balanceCents === null) return null;
    const itemQboIds = itemsOf(r.Line);
    if (itemQboIds === null) return null;
    const invoice: StoredInvoice = {
      qboId, number: text(r.DocNumber, 50), customerQboId: customer, forName: forNames.get(customer) ?? null, date: day(r.TxnDate), dueDate: day(r.DueDate),
      totalCents, balanceCents: Math.max(balanceCents, 0), currency: currencyOf((r.CurrencyRef as { value?: unknown } | null | undefined)?.value),
      payLink: balanceCents > 0 ? safePayLink(r.InvoiceLink) : null, itemQboIds,
    };
    if (balanceCents > 0) open.push(invoice);
    else if (totalCents > 0 && invoice.date !== null && invoice.date >= since) paid.push(invoice);
  }
  open.sort((a, b) => byDay(a.dueDate, b.dueDate) || byDay(a.date, b.date) || byNumber(a.qboId, b.qboId));
  paid.sort((a, b) => byDay(b.date, a.date) || byNumber(b.qboId, a.qboId));
  const currencies = new Set(open.map((i) => i.currency));
  return {
    invoices: [...open, ...paid.slice(0, PAID_KEPT)],
    totalCents: open.reduce((sum, i) => sum + i.balanceCents, 0),
    currency: currencies.size > 1 ? null : open[0]?.currency ?? paid[0]?.currency ?? "USD",
  };
}
