// How payment requirements stand, read from the figures QuickBooks last gave each family (family_money), for the
// payment entry of src/lib/seasons/kinds.ts. The rule is asked by the app's own families and students, as the season
// keeps them, and the figures are kept by the app's family; but whose invoices are a family's, and which are a
// student's own, is still the roster cache's tree of customers, so figuresBySubject() below is the one place the
// records asked about become customers, through their own links (src/lib/families/links.ts), and back. A parent's season passes its own family and students only, so
// only that family's figures are read; staff pass null, for everyone. What may be shown follows the parent pages' own
// rule (mayShow in ./stored.ts): never figures from another company, nor a row holding an invoice of a customer who is
// no longer the family's, nor a row stored before the portal read which items its invoices carry. This folder is
// parent-facing (PARENT_FACING_LIB in tests/integration/page-guards.test.ts): it imports no staff-only module.
import { inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { qboCustomer, requirement, type StoredInvoice } from "@/lib/db/schema";
import { linksOf, linksOfCustomers, type LinkMaps } from "@/lib/families/links";
import { getRosterSource } from "@/lib/roster/source";
import type { RequirementFields, Standing, SubjectId, SubjectsAsked } from "@/lib/seasons/progress";
import { invoicesFor, paymentStanding, type Whose } from "./payment-rule";
import { getMoneySettings } from "./settings";
import { familiesCustomers, knowsItems, mayShow, moneyRows } from "./stored";

/**
 * Whether a payment line says how much is left to pay. "fresh": only from figures read within the money setting's
 * `freshSeconds` (a parent's pages, where an amount that is not current would carry no note); "all": whenever the
 * figures may be shown (staff who may read balances, as Balances shows them with their date); "none": never (staff
 * who may not read what a family owes).
 */
export type AmountsShown = "fresh" | "all" | "none";

/** One family or student record with figures that may be shown: whose invoices of them are its own, and when they were read. */
type Subject = { subjectId: SubjectId; whose: Whose; invoices: StoredInvoice[]; readAt: Date };

/**
 * Each of these family and student records (null: everyone) that has figures that may be shown. A family record is
 * the family customer its own link names; a student record is the customer its own link names, among the customers
 * whose invoices are a family's (customersOf in ./stored.ts) other than the family customer itself, and its invoices
 * are those raised on that customer alone. A record with no link in the records' company (none at all while
 * QuickBooks is connected to another company) has no figures here, and stands as "No invoice yet": never another's.
 * Asked about everyone, the links are read for the customers the cache puts in a family, in one query: a fixed few
 * queries whatever the number of families.
 */
async function figuresBySubject(asked: SubjectsAsked | null): Promise<Subject[]> {
  let links: LinkMaps | null = null, familyQboIds: string[] | null = null;
  if (asked !== null) {
    if (asked.families.length === 0 && asked.students.length === 0) return [];
    links = await linksOf(asked);
    const customers = [...links.customerOfFamily.values(), ...links.customerOfStudent.values()];
    if (customers.length === 0) return [];
    // A student's family is the customer the cache holds it under; a family is its own.
    const rows = await db.select({ qboId: qboCustomer.qboId, parentQboId: qboCustomer.parentQboId }).from(qboCustomer).where(inArray(qboCustomer.qboId, customers));
    familyQboIds = [...new Set(rows.flatMap((r) => [r.qboId, ...(r.parentQboId ? [r.parentQboId] : [])]))];
  }
  const [families, source] = await Promise.all([familiesCustomers(familyQboIds), getRosterSource()]);
  if (links === null) {
    const under = [...families].flatMap(([familyQboId, family]) => [...family.customers.keys()].filter((c) => c !== familyQboId));
    links = await linksOfCustomers({ families: [...families.keys()], students: under });
  }
  // A family's row is its app family's, found through the family customer's own family link. Asked about a student
  // alone, its family is not among the records asked about, so the families' links are read for the rows apart.
  const rowOf = asked === null ? links : await linksOfCustomers({ families: [...families.keys()], students: [] });
  const rows = await moneyRows([...new Set(rowOf.familyOfCustomer.values())]);
  // Asked about particular records, the maps hold those records' links alone, so a record nobody asked about is never answered for.
  const out: Subject[] = [];
  for (const [familyQboId, family] of families) {
    const familyRecord = rowOf.familyOfCustomer.get(familyQboId);
    const row = familyRecord === undefined ? undefined : rows.get(familyRecord);
    if (!mayShow(row, source, family) || !knowsItems(row)) continue;
    const familyId = links.familyOfCustomer.get(familyQboId);
    if (familyId) out.push({ subjectId: familyId, whose: { appliesTo: "family" }, invoices: row.invoices, readAt: row.readAt });
    for (const customerQboId of family.customers.keys()) {
      const studentId = customerQboId === familyQboId ? undefined : links.studentOfCustomer.get(customerQboId);
      if (studentId) out.push({ subjectId: studentId, whose: { appliesTo: "student", customerQboId }, invoices: row.invoices, readAt: row.readAt });
    }
  }
  return out;
}

/**
 * How each of these payment requirements stands for each of these families and students (null: everyone), by the
 * app's own ids, as paymentStanding() judges it. A per-family requirement is the family record's, a per-student one
 * each student record's (`appliesTo`). A pair left out has no figures that may be shown, and stands as "No invoice yet".
 */
export async function paymentStandings(requirements: readonly RequirementFields[], asked: SubjectsAsked | null, amounts: AmountsShown):
  Promise<{ requirementId: string; subjectId: SubjectId; standing: Standing }[]> {
  if (requirements.length === 0) return [];
  const [items, subjects, { freshSeconds }] = await Promise.all([
    db.select({ id: requirement.id, itemQboId: requirement.itemQboId }).from(requirement).where(inArray(requirement.id, requirements.map((r) => r.id))),
    figuresBySubject(asked),
    getMoneySettings(),
  ]);
  const now = Date.now();
  const sayAmount = (readAt: Date) => amounts === "all" || (amounts === "fresh" && now - readAt.getTime() < freshSeconds * 1000);
  const itemOf = new Map(items.map((r) => [r.id, r.itemQboId]));
  const out: { requirementId: string; subjectId: SubjectId; standing: Standing }[] = [];
  for (const r of requirements) {
    for (const s of subjects) {
      if (s.whose.appliesTo !== r.appliesTo) continue;
      out.push({ requirementId: r.id, subjectId: s.subjectId, standing: paymentStanding(itemOf.get(r.id) ?? null, invoicesFor(s.whose, s.invoices), { amount: sayAmount(s.readAt) }) });
    }
  }
  return out;
}
