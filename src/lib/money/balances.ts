// Staff only: what every family owes, and one family's invoices, for the Balances pages (v1 spec §8, step 4). It
// loads every family in the club, so it is never imported by parent code (STAFF_ONLY_IMPORTS in
// tests/integration/page-guards.test.ts). It reads only what is stored: nothing here asks QuickBooks. What may be shown
// is the parent pages' own rule (mayShow in ./stored.ts), so staff never see figures a parent of the family couldn't.
import "server-only";
import { and, count, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { family as familyTable, type CustomerCheck, type StoredInvoice } from "@/lib/db/schema";
import { QUICKBOOKS, type AppFamilyId } from "@/lib/families/ids";
import { customerOfFamily, linksOfCustomers, recordsCompany } from "@/lib/families/links";
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
  /** The app's own family the family customer is linked to, which its page's address names; null when it has no family record (no page). */
  familyId: AppFamilyId | null;
  name: string;
  /** Null when nothing may be shown: never read, or read when the family's customers were different. */
  figures: Figures | null;
  /** The latest try failed after the figures were read (ISO): they may be behind. */
  failedAt: string | null;
};

/** A family whose customers' own balances in QuickBooks differ from their open invoices, as the worker last found them. */
export type WorthALook = {
  familyQboId: string;
  /** As BalanceRow's: the family's page, or none. */
  familyId: AppFamilyId | null;
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
  /**
   * How many active family records of the portal have no family link in the records' company (0 while that company is
   * unknown), so they have no row here (stage 4's slice M3b; the owner's choice 9, recommended and awaiting his word):
   * the page says so in one line, pointing at Accounting links.
   */
  unlinked: number;
};

/** Active family records with no family link in the records' company (recordsCompany()): none counted while it is unknown. One query, besides the company's. */
async function familiesWithNoLink(): Promise<number> {
  const realmId = await recordsCompany();
  if (realmId === null) return 0;
  const [r] = await db.select({ n: count() }).from(familyTable).where(and(eq(familyTable.active, true),
    sql`not exists (select 1 from accounting_link l where l.family_id = ${familyTable.id} and l.system = ${QUICKBOOKS} and l.realm_id = ${realmId})`));
  return r?.n ?? 0;
}

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
  const [families, rows, source, unlinked] = await Promise.all([familiesCustomers(null), moneyRows(null), getRosterSource(), familiesWithNoLink()]);
  if (source === null) return { roster: false, rows: [], families: 0, worthALook: [], unlinked };
  // Each roster family's row is its app family's, found through the family customer's own family link (the family kind
  // only: a customer may have a student record too), for every family in one query.
  const links = await linksOfCustomers({ families: [...families.keys()], students: [] });
  const needle = (o.search ?? "").trim().toLocaleLowerCase("en").slice(0, SEARCH_MAX);
  const all: BalanceRow[] = [];
  const worthALook: WorthALook[] = [];
  for (const [familyQboId, family] of families) {
    const familyId = links.familyOfCustomer.get(familyQboId);
    const row = familyId === undefined ? undefined : rows.get(familyId);
    all.push({ familyQboId, familyId: familyId ?? null, name: family.familyName, figures: figuresOf(row, source, family), failedAt: iso(failedSince(row)) });
    const differ = differences(row, source, family);
    if (differ.length) worthALook.push({ familyQboId, familyId: familyId ?? null, name: family.familyName, checkedAt: row!.checkedAt!.toISOString(), customers: differ });
  }
  const names = (id: string) => [families.get(id)!.familyName, ...[...families.get(id)!.customers.values()].filter((n): n is string => n !== null)];
  const shown = all.filter((r) => (!o.owing || (r.figures !== null && r.figures.totalCents > 0))
    && (needle === "" || names(r.familyQboId).some((n) => n.toLocaleLowerCase("en").includes(needle))));
  return { roster: families.size > 0, rows: shown.sort(byName), families: all.length, worthALook: worthALook.sort(byName), unlinked };
}

export type FamilyBalance = {
  familyQboId: string;
  /** The app's own family the page's address names, which its audit row names too. */
  familyId: AppFamilyId;
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
 * customer's balance. The address names the app's own family (checked by familyRecordAt() first); whose invoices are
 * its is still the roster cache's tree, so it is turned into its family customer once, here, through its own link in
 * the roster's company. Null when it has none there, or when that customer isn't an active family in the roster cache
 * (the record's customer made inactive, or no longer a family). The page that shows it audits the read first.
 */
export async function loadFamilyBalance(familyId: AppFamilyId): Promise<FamilyBalance | null> {
  const [familyQboId, source] = await Promise.all([customerOfFamily(familyId), getRosterSource()]);
  if (familyQboId === null || source === null) return null;
  const family = (await familiesCustomers([familyQboId])).get(familyQboId);
  if (!family) return null;
  const row = (await moneyRows([familyId])).get(familyId);
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
