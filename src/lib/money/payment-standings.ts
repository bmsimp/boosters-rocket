// How payment requirements stand, read from the figures QuickBooks last gave each family (family_money), for the
// payment entry of src/lib/seasons/kinds.ts. A parent's season passes its own family and students only, so only that
// family's figures are read; staff pass null, for everyone. What may be shown follows the parent pages' own rule
// (mayShow in ./stored.ts): never figures from another company, nor a row holding an invoice of a customer who is no
// longer the family's, nor a row stored before the portal read which items its invoices carry.
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { qboCustomer, requirement, type StoredInvoice } from "@/lib/db/schema";
import { getRosterSource } from "@/lib/roster/source";
import type { Requirement, Standing } from "@/lib/seasons/progress";
import { invoicesFor, paymentStanding } from "./payment-rule";
import { familiesCustomers, knowsItems, mayShow, moneyRows } from "./stored";

/** The family each of these families or students is in, with the invoices of the family that may be shown, by subject id. */
async function figuresBySubject(subjectQboIds: readonly string[] | null): Promise<Map<string, { familyQboId: string; invoices: StoredInvoice[] }>> {
  const out = new Map<string, { familyQboId: string; invoices: StoredInvoice[] }>();
  if (subjectQboIds?.length === 0) return out;
  let familyIds: string[] | null = null;
  if (subjectQboIds !== null) {
    // A student's family is the customer the cache holds it under; a family is its own.
    const rows = await db.select({ qboId: qboCustomer.qboId, parentQboId: qboCustomer.parentQboId }).from(qboCustomer).where(inArray(qboCustomer.qboId, [...subjectQboIds]));
    familyIds = [...new Set(rows.flatMap((r) => [r.qboId, ...(r.parentQboId ? [r.parentQboId] : [])]))];
  }
  const [families, rows, source] = await Promise.all([familiesCustomers(familyIds), moneyRows(familyIds), getRosterSource()]);
  const asked = subjectQboIds === null ? null : new Set(subjectQboIds);
  for (const [familyQboId, family] of families) {
    const row = rows.get(familyQboId);
    if (!mayShow(row, source, family) || !knowsItems(row)) continue;
    for (const subject of family.customers.keys()) {
      if (asked === null || asked.has(subject)) out.set(subject, { familyQboId, invoices: row.invoices });
    }
  }
  return out;
}

/**
 * How each of these payment requirements stands for each of these families or students (null: everyone), as
 * paymentStanding() judges it. A pair left out has no figures that may be shown, and stands as "No invoice yet".
 */
export async function paymentStandings(requirements: readonly Requirement[], subjectQboIds: readonly string[] | null):
  Promise<{ requirementId: string; subjectQboId: string; standing: Standing }[]> {
  if (requirements.length === 0) return [];
  const [items, figures] = await Promise.all([
    db.select({ id: requirement.id, itemQboId: requirement.itemQboId }).from(requirement).where(inArray(requirement.id, requirements.map((r) => r.id))),
    figuresBySubject(subjectQboIds),
  ]);
  const itemOf = new Map(items.map((r) => [r.id, r.itemQboId]));
  const out: { requirementId: string; subjectQboId: string; standing: Standing }[] = [];
  for (const r of requirements) {
    for (const [subjectQboId, { familyQboId, invoices }] of figures) {
      // A per-family requirement is the family's; a per-student one is each customer's under it.
      if ((r.appliesTo === "family") !== (subjectQboId === familyQboId)) continue;
      out.push({ requirementId: r.id, subjectQboId, standing: paymentStanding(itemOf.get(r.id) ?? null, invoicesFor(subjectQboId, familyQboId, invoices)) });
    }
  }
  return out;
}
