// What a family's stored figures may be shown as, and whose invoices are a family's. The rules both the parent pages
// (./family-money.ts) and the staff ones (./balances.ts) go by, so the two can't disagree. Nothing here reads a
// request: the callers pass ids from the session (a parent) or from the roster cache (staff, the worker).
import { inArray, or } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { familyMoney, qboCustomer, type StoredInvoice } from "@/lib/db/schema";
import { getShape, type MembershipShape } from "@/lib/roster/shape";

export type MoneyRow = typeof familyMoney.$inferSelect;

export type FamilyCustomers = {
  familyName: string;
  /** The customers whose invoices are the family's, each with the name to show beside its invoices (null for the family itself). */
  customers: Map<string, string | null>;
  /** The cache holds a customer directly under the family that is not one of those. */
  othersUnder: boolean;
};

type CustomerRow = { qboId: string; name: string; active: boolean; parentQboId: string | null; typeQboId: string | null };
const customerColumns = { qboId: qboCustomer.qboId, name: qboCustomer.displayName, active: qboCustomer.active, parentQboId: qboCustomer.parentQboId, typeQboId: qboCustomer.typeQboId };

/**
 * Whose invoices are a family's (v1 spec §8.2). Layered: the family customer and its active direct sub-customers of the
 * student or the parent type. A sub-customer of the family type is another family and is never included. Flat: the
 * member's own customer. Null when the cache doesn't hold this id as an active family: QuickBooks made it inactive, or
 * the shape doesn't call it a family (the rule of loadMyFamily, src/lib/parents/my-family.ts).
 */
function customersOf(family: CustomerRow | undefined, under: CustomerRow[], shape: MembershipShape): FamilyCustomers | null {
  if (!family || !family.active || family.typeQboId === null) return null;
  const customers = new Map<string, string | null>([[family.qboId, null]]);
  if (shape.kind === "flat") return shape.memberTypeIds.includes(family.typeQboId) ? { familyName: family.name, customers, othersUnder: under.length > 0 } : null;
  if (family.typeQboId !== shape.familyTypeId) return null;
  const included = [shape.studentTypeId, shape.parentTypeId].filter((t): t is string => t !== null);
  for (const r of under) {
    if (r.active && r.typeQboId !== null && included.includes(r.typeQboId)) customers.set(r.qboId, r.name);
  }
  return { familyName: family.name, customers, othersUnder: under.length > customers.size - 1 };
}

/**
 * Whose invoices are each of these families' (customersOf), by family id; a family the cache doesn't hold as an active
 * one is left out. With null, every family in the cache: for the staff pages and the worker, never a parent's.
 */
export async function familiesCustomers(familyQboIds: readonly string[] | null, tx?: Tx): Promise<Map<string, FamilyCustomers>> {
  const out = new Map<string, FamilyCustomers>();
  if (familyQboIds?.length === 0) return out;
  const shape = await getShape(tx);
  if (!shape) return out;
  const q = (tx ?? db).select(customerColumns).from(qboCustomer);
  const rows: CustomerRow[] = familyQboIds === null ? await q
    : await q.where(or(inArray(qboCustomer.qboId, [...familyQboIds]), inArray(qboCustomer.parentQboId, [...familyQboIds])));
  const byId = new Map(rows.map((r) => [r.qboId, r]));
  const under = new Map<string, CustomerRow[]>();
  for (const r of rows) if (r.parentQboId !== null) under.set(r.parentQboId, [...(under.get(r.parentQboId) ?? []), r]);
  // With null, every customer is asked: customersOf answers only for those the shape calls a family, wherever they sit.
  const wanted = familyQboIds ?? rows.map((r) => r.qboId);
  for (const id of wanted) {
    const family = customersOf(byId.get(id), under.get(id) ?? [], shape);
    if (family) out.set(id, family);
  }
  return out;
}

/** One family's customers (familiesCustomers), or null. */
export async function familyCustomers(familyQboId: string, tx?: Tx): Promise<FamilyCustomers | null> {
  return (await familiesCustomers([familyQboId], tx)).get(familyQboId) ?? null;
}

export type ShownRow = MoneyRow & { readAt: Date; invoices: StoredInvoice[]; totalCents: number };

/**
 * Whether a stored row is this family's to see now. Not when it came from another QuickBooks company than the roster
 * cache. Not when the cache no longer holds the family as one. And not when it holds an invoice of a customer the
 * cache no longer puts in this family: a student moved to another family or made inactive since the read, or a row
 * that doesn't say whose its invoices are. Such a row is treated as absent, however fresh, until QuickBooks is read
 * again: it is never shown with somebody else's invoice in it.
 */
export function mayShow(row: MoneyRow | undefined, source: string | null, family: FamilyCustomers | null | undefined): row is ShownRow {
  return Boolean(row?.readAt && row.invoices && row.totalCents !== null && row.realmId !== null && row.realmId === source
    && family && row.invoices.every((i) => family.customers.has(i.customerQboId)));
}

/** Whether each stored invoice says which products and services it carries. A row stored before the portal read them is read again (isFresh). */
export const knowsItems = (row: ShownRow): boolean => row.invoices.every((i) => Array.isArray(i.itemQboIds));

/** The stored rows of these families (all of them, with null). */
export async function moneyRows(familyQboIds: readonly string[] | null, tx?: Tx): Promise<Map<string, MoneyRow>> {
  if (familyQboIds?.length === 0) return new Map();
  const q = (tx ?? db).select().from(familyMoney);
  const rows = familyQboIds === null ? await q : await q.where(inArray(familyMoney.familyQboId, [...familyQboIds]));
  return new Map(rows.map((r) => [r.familyQboId, r]));
}
