// Staff only: what every family owes, and one family's invoices, for the Balances pages (v1 spec §8, step 4). It
// loads every family in the club, so it is never imported by parent code (STAFF_ONLY_IMPORTS in
// tests/integration/page-guards.test.ts). It reads only what is stored: nothing here asks QuickBooks. What may be shown
// is the parent pages' own rule (mayShow in ./stored.ts), so staff never see figures a parent of the family couldn't.
import "server-only";
import type { CustomerCheck, StoredInvoice } from "@/lib/db/schema";
import type { AppFamilyId } from "@/lib/families/ids";
import { familyLinkedTo, linksOfCustomers } from "@/lib/families/links";
import { getRosterSource } from "@/lib/roster/source";
import { openInvoices, paidInvoices } from "./invoices";
import { safePayLink } from "./pay-link";
import { familiesCustomers, mayShow, moneyRows, type FamilyCustomers, type MoneyRow } from "./stored";

export const SEARCH_MAX = 100;

export type Figures = {
  totalCents: number;
  /** Null when the open invoices are in more than one currency: there is then no single total. */
  currency: string | null;
  openCount: number;
  /** The earliest due date among the open invoices (YYYY-MM-DD), or null. */
  oldestDue: string | null;
  /** When QuickBooks gave these figures (ISO). */
  readAt: string;
};

export type BalanceRow = {
  familyQboId: string;
  name: string;
  /** Null when nothing may be shown: never read, or read when the family's customers were different. */
  figures: Figures | null;
  /** The latest try failed after the figures were read (ISO): they may be behind. */
  failedAt: string | null;
};

/** A family whose customers' own balances in QuickBooks differ from their open invoices, as the worker last found them. */
export type WorthALook = {
  familyQboId: string;
  name: string;
  checkedAt: string;
  /** Only the customers that differ; `name` null is the family customer itself. */
  customers: CustomerCheck[];
};

export type Balances = {
  /** False when the roster can't be shown (no membership shape, or no company read): nothing is listed. */
  roster: boolean;
  rows: BalanceRow[];
  /** How many families there are before the filter and the search. */
  families: number;
  worthALook: WorthALook[];
};

const iso = (d: Date | null) => d?.toISOString() ?? null;
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, "en", { sensitivity: "base" });
const failedSince = (row: MoneyRow | undefined) => (row?.failedAt && (!row.readAt || row.failedAt > row.readAt) ? row.failedAt : null);

function figuresOf(row: MoneyRow | undefined, source: string | null, family: FamilyCustomers): Figures | null {
  if (!mayShow(row, source, family)) return null;
  const open = openInvoices(row.invoices);
  const dues = open.map((i) => i.dueDate).filter((d): d is string => d !== null).sort();
  return { totalCents: row.totalCents, currency: row.currency, openCount: open.length, oldestDue: dues[0] ?? null, readAt: row.readAt.toISOString() };
}

/** The customers a check found differing, when the check may still be shown: the same company, and customers still the family's. */
function differences(row: MoneyRow | undefined, source: string | null, family: FamilyCustomers): CustomerCheck[] {
  if (!row?.checkedAt || !row.customerChecks || row.realmId !== source) return [];
  return row.customerChecks.filter((c) => family.customers.has(c.customerQboId) && c.balanceCents !== c.invoicesCents);
}

/**
 * Every active family with what it owes, its oldest due date and when its figures were read, by name; and the families
 * whose customers' balances in QuickBooks differ from their invoices ("worth a look"). `owing` keeps only families
 * that owe something; `search` keeps families whose name, or the name of a student or parent in them, holds it.
 */
export async function loadBalances(o: { owing?: boolean; search?: string } = {}): Promise<Balances> {
  const [families, rows, source] = await Promise.all([familiesCustomers(null), moneyRows(null), getRosterSource()]);
  if (source === null) return { roster: false, rows: [], families: 0, worthALook: [] };
  // Each roster family's row is its app family's, found through the family customer's own family link (the family kind
  // only: a customer may have a student record too), for every family in one query.
  const links = await linksOfCustomers({ families: [...families.keys()], students: [] });
  const needle = (o.search ?? "").trim().toLocaleLowerCase("en").slice(0, SEARCH_MAX);
  const all: BalanceRow[] = [];
  const worthALook: WorthALook[] = [];
  for (const [familyQboId, family] of families) {
    const familyId = links.familyOfCustomer.get(familyQboId);
    const row = familyId === undefined ? undefined : rows.get(familyId);
    all.push({ familyQboId, name: family.familyName, figures: figuresOf(row, source, family), failedAt: iso(failedSince(row)) });
    const differ = differences(row, source, family);
    if (differ.length) worthALook.push({ familyQboId, name: family.familyName, checkedAt: row!.checkedAt!.toISOString(), customers: differ });
  }
  const names = (id: string) => [families.get(id)!.familyName, ...[...families.get(id)!.customers.values()].filter((n): n is string => n !== null)];
  const shown = all.filter((r) => (!o.owing || (r.figures !== null && r.figures.totalCents > 0))
    && (needle === "" || names(r.familyQboId).some((n) => n.toLocaleLowerCase("en").includes(needle))));
  return { roster: families.size > 0, rows: shown.sort(byName), families: all.length, worthALook: worthALook.sort(byName) };
}

export type FamilyBalance = {
  familyQboId: string;
  /** The app's own family the address's customer is linked to, which the page's audit row names; null when it has none. */
  familyId: AppFamilyId | null;
  name: string;
  /** The students and parents whose invoices are the family's, by name. */
  members: string[];
  figures: (Figures & { open: StoredInvoice[]; paid: StoredInvoice[]; credit: boolean }) | null;
  failed: { at: string; code: string | null } | null;
  /** The worker's last customer-by-customer check, when it may be shown. */
  check: { at: string; customers: CustomerCheck[] } | null;
};

/**
 * One family's money for staff: its open invoices, what was paid in the last 12 months, and the last check of each
 * customer's balance. Null when the id isn't an active family in the roster cache. The address names the family's
 * customer; it is turned into the app's family once, here, through its own family link (`familyId`, null for a
 * customer with no family record, which then has no figures). The page that shows it audits the read first.
 */
export async function loadFamilyBalance(familyQboId: string): Promise<FamilyBalance | null> {
  const [families, familyId, source] = await Promise.all([familiesCustomers([familyQboId]), familyLinkedTo(familyQboId), getRosterSource()]);
  const family = families.get(familyQboId);
  if (!family || source === null) return null;
  const row = familyId === null ? undefined : (await moneyRows([familyId])).get(familyId);
  const base = figuresOf(row, source, family);
  const invoices = base && mayShow(row, source, family) ? row.invoices.map((i) => ({ ...i, payLink: safePayLink(i.payLink) })) : [];
  const failedAt = failedSince(row);
  const check = row?.checkedAt && row.customerChecks && row.realmId === source && row.customerChecks.every((c) => family.customers.has(c.customerQboId))
    ? { at: row.checkedAt.toISOString(), customers: row.customerChecks } : null;
  return {
    familyQboId, familyId, name: family.familyName,
    members: [...family.customers.values()].filter((n): n is string => n !== null).sort((a, b) => a.localeCompare(b, "en")),
    figures: base ? { ...base, open: openInvoices(invoices), paid: paidInvoices(invoices),
      credit: row!.currency !== null && row!.balanceWithJobsCents !== null && row!.balanceWithJobsCents < row!.totalCents! } : null,
    failed: failedAt ? { at: failedAt.toISOString(), code: row?.failedCode ?? null } : null,
    check,
  };
}
