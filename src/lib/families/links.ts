import { and, eq, inArray, isNotNull, or, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { accountingLink } from "@/lib/db/schema";
import { getConnection } from "@/lib/quickbooks/connection";
import { getRosterSource } from "@/lib/roster/source";
import { QUICKBOOKS, type AppFamilyId, type AppStudentId } from "./ids";

/**
 * Lookups through a link, one record of one kind at a time (stage 1 of the app-owned families spec). A customer may
 * have a family record and a student record, so each lookup asks for a kind and reads only that kind's link. Each goes
 * by the company the records were made from (the roster cache's company), read here and never taken from the caller,
 * so they keep answering while QuickBooks is disconnected, as parent pages keep working from the cache today; and each
 * answers nothing while QuickBooks is connected to a different company, so another company's link never answers.
 * Stage 2's areas read them: a parent's season finds the session's app family through familyLinkedTo(), and the season's
 * reads that cross into an area still keyed by QuickBooks ids translate through linksOf() and linksOfCustomers() (the
 * boundaries are listed in AGENTS.md, Seasons). Each reads only the links it is asked for, so parent code may import
 * this module (PARENT_CODE_ELSEWHERE in tests/integration/page-guards.test.ts); only linksOf("all") reads every
 * family's link, and only staff code asks for it.
 */
export async function recordsCompany(tx?: Tx): Promise<string | null> {
  const [source, connection] = await Promise.all([getRosterSource(tx), getConnection(tx)]);
  if (source === null) return null;
  if (connection?.realmId && connection.realmId !== source) return null;
  return source;
}

async function linkOf(customerId: string, kind: "family" | "student", tx?: Tx) {
  const realmId = await recordsCompany(tx);
  if (realmId === null) return null;
  const [l] = await (tx ?? db).select().from(accountingLink).where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId),
    eq(accountingLink.customerId, customerId), isNotNull(kind === "family" ? accountingLink.familyId : accountingLink.studentId)));
  return l ?? null;
}

/** The app family linked to this customer, or null. */
export async function familyLinkedTo(customerId: string, tx?: Tx): Promise<AppFamilyId | null> {
  return (await linkOf(customerId, "family", tx))?.familyId ?? null;
}

/** The app student linked to this customer, or null. */
export async function studentLinkedTo(customerId: string, tx?: Tx): Promise<AppStudentId | null> {
  return (await linkOf(customerId, "student", tx))?.studentId ?? null;
}

/** The customer this app family is linked to, or null. */
export async function customerOfFamily(familyId: AppFamilyId, tx?: Tx): Promise<string | null> {
  const realmId = await recordsCompany(tx);
  if (realmId === null) return null;
  const [l] = await (tx ?? db).select({ customerId: accountingLink.customerId }).from(accountingLink)
    .where(and(eq(accountingLink.familyId, familyId), eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId)));
  return l?.customerId ?? null;
}

/** The customer this app student is linked to, or null. */
export async function customerOfStudent(studentId: AppStudentId, tx?: Tx): Promise<string | null> {
  const realmId = await recordsCompany(tx);
  if (realmId === null) return null;
  const [l] = await (tx ?? db).select({ customerId: accountingLink.customerId }).from(accountingLink)
    .where(and(eq(accountingLink.studentId, studentId), eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId)));
  return l?.customerId ?? null;
}

/**
 * Records and their customers in both directions, by kind: a customer may have a family record and a student record,
 * and each map holds one kind only, so a family's id is never looked up among the students' customers.
 */
export type LinkMaps = {
  customerOfFamily: Map<AppFamilyId, string>; familyOfCustomer: Map<string, AppFamilyId>;
  customerOfStudent: Map<AppStudentId, string>; studentOfCustomer: Map<string, AppStudentId>;
};
const noLinks = (): LinkMaps => ({ customerOfFamily: new Map(), familyOfCustomer: new Map(), customerOfStudent: new Map(), studentOfCustomer: new Map() });

async function linksWhere(which: SQL | undefined | "none", tx?: Tx): Promise<LinkMaps> {
  const out = noLinks();
  if (which === "none") return out;
  const realmId = await recordsCompany(tx);
  if (realmId === null) return out;
  const rows = await (tx ?? db).select({ customerId: accountingLink.customerId, familyId: accountingLink.familyId, studentId: accountingLink.studentId }).from(accountingLink)
    .where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId), or(isNotNull(accountingLink.familyId), isNotNull(accountingLink.studentId)), which));
  for (const r of rows) {
    if (r.familyId !== null) { out.customerOfFamily.set(r.familyId, r.customerId); out.familyOfCustomer.set(r.customerId, r.familyId); }
    else if (r.studentId !== null) { out.customerOfStudent.set(r.studentId, r.customerId); out.studentOfCustomer.set(r.customerId, r.studentId); }
  }
  return out;
}
const anyOf = (...parts: (SQL | null)[]): SQL | undefined | "none" => {
  const given = parts.filter((p): p is SQL => p !== null);
  return given.length === 0 ? "none" : or(...given);
};

/**
 * The customers of these family and student records, in the records' company (as every lookup here reads it), with
 * the way back. "all" is every family and student record's link: for staff code that asks about everyone.
 */
export function linksOf(records: { families: readonly AppFamilyId[]; students: readonly AppStudentId[] } | "all", tx?: Tx): Promise<LinkMaps> {
  if (records === "all") return linksWhere(undefined, tx);
  return linksWhere(anyOf(records.families.length ? inArray(accountingLink.familyId, [...records.families]) : null,
    records.students.length ? inArray(accountingLink.studentId, [...records.students]) : null), tx);
}

/** The family records of these customers and the student records of those, in the records' company, with the way back. */
export function linksOfCustomers(customers: { families: readonly string[]; students: readonly string[] }, tx?: Tx): Promise<LinkMaps> {
  return linksWhere(anyOf(customers.families.length ? and(isNotNull(accountingLink.familyId), inArray(accountingLink.customerId, [...customers.families]))! : null,
    customers.students.length ? and(isNotNull(accountingLink.studentId), inArray(accountingLink.customerId, [...customers.students]))! : null), tx);
}
