import { and, eq, inArray, isNotNull, or, type SQL } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { accountingLink } from "@/lib/db/schema";
import { getConnection } from "@/lib/quickbooks/connection";
import { getRosterSource } from "@/lib/roster/source";
import { QUICKBOOKS, type AppFamilyId, type AppStudentId } from "./ids";

/** Connected (a company named) to a company other than the roster cache's: one meaning, for both readers below. */
const otherCompany = (source: string | null, connected: string | null | undefined) => source !== null && !!connected && connected !== source;

/**
 * Lookups through a link, one record of one kind at a time (stage 1 of the app-owned families spec). A customer may
 * have a family record and a student record, so each lookup asks for a kind and reads only that kind's link. Each goes
 * by the company the records were made from (the roster cache's company), read here and never taken from the caller,
 * so they keep answering while QuickBooks is disconnected, as parent pages keep working from the cache today; and each
 * answers nothing while QuickBooks is connected to a different company, so another company's link never answers.
 * Stage 2's areas read them: a parent's season finds the session's app family through familyLinkedTo(), and the code
 * that crosses into what is still keyed by QuickBooks ids translates through linksOf() and linksOfCustomers() (the
 * boundaries are listed in AGENTS.md, Seasons). Each reads only the links it is asked for, so parent code may import
 * this module (PARENT_CODE_ELSEWHERE in tests/integration/page-guards.test.ts).
 */
export async function recordsCompany(tx?: Tx): Promise<string | null> {
  const [source, connection] = await Promise.all([getRosterSource(tx), getConnection(tx)]);
  if (source === null || otherCompany(source, connection?.realmId)) return null;
  return source;
}

/**
 * True while QuickBooks is connected to a company other than the one the records were made from (the roster cache's):
 * the one state in which recordsCompany() answers null although the records name a company. Nothing the portal runs
 * makes it since stage 2 (a connect and a refresh of another company are both refused), but a database can still be in
 * it from before, until an Admin disconnects.
 */
export async function connectedToAnotherCompany(tx?: Tx): Promise<boolean> {
  const [source, connection] = await Promise.all([getRosterSource(tx), getConnection(tx)]);
  return otherCompany(source, connection?.realmId);
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

/**
 * Whether this app family has a family link, told apart from not being able to tell, for the words an unlinked family
 * reads about money (src/lib/money/family-money.ts). customerOfFamily() answers nothing in both cases; this reads, beside
 * the link itself, the roster's company and the connection, as recordsCompany() does:
 * - `linked`: its family link in the records' company names `customerId` (what customerOfFamily() answers).
 * - `none`: the portal can tell it has none: the roster names a company, QuickBooks is not connected to a different one,
 *   and the family has no family link in that company; or the roster names no company at all (a club that has never
 *   read one) and the family has no link of any system or company.
 * - `unknown`: QuickBooks is connected to another company than the roster's, so no link of the roster's company may
 *   answer; or the roster names no company while the family still holds a link of some company.
 * It reads this family's links only.
 */
export type FamilyLinkState = { state: "linked"; customerId: string } | { state: "none" } | { state: "unknown" };
export async function familyLinkState(familyId: AppFamilyId, tx?: Tx): Promise<FamilyLinkState> {
  const q = tx ?? db;
  const [source, connection] = await Promise.all([getRosterSource(tx), getConnection(tx)]);
  if (source === null) {
    const [any] = await q.select({ id: accountingLink.id }).from(accountingLink).where(eq(accountingLink.familyId, familyId)).limit(1);
    return any ? { state: "unknown" } : { state: "none" };
  }
  if (connection?.realmId && connection.realmId !== source) return { state: "unknown" };
  const [l] = await q.select({ customerId: accountingLink.customerId }).from(accountingLink)
    .where(and(eq(accountingLink.familyId, familyId), eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, source)));
  return l ? { state: "linked", customerId: l.customerId } : { state: "none" };
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

async function linksWhere(which: SQL | "none", tx?: Tx): Promise<LinkMaps> {
  const out = noLinks();
  if (which === "none") return out;
  const realmId = await recordsCompany(tx);
  if (realmId === null) return out;
  return linkMapsFrom(await (tx ?? db).select(LINK_COLUMNS).from(accountingLink)
    .where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId), or(isNotNull(accountingLink.familyId), isNotNull(accountingLink.studentId)), which)));
}
/** The columns linkMapsFrom() reads. */
const LINK_COLUMNS = { customerId: accountingLink.customerId, familyId: accountingLink.familyId, studentId: accountingLink.studentId };
/** Link rows as maps by kind, both ways. */
function linkMapsFrom(rows: readonly { customerId: string; familyId: AppFamilyId | null; studentId: AppStudentId | null }[]): LinkMaps {
  const out = noLinks();
  for (const r of rows) {
    if (r.familyId !== null) { out.customerOfFamily.set(r.familyId, r.customerId); out.familyOfCustomer.set(r.customerId, r.familyId); }
    else if (r.studentId !== null) { out.customerOfStudent.set(r.studentId, r.customerId); out.studentOfCustomer.set(r.customerId, r.studentId); }
  }
  return out;
}
const anyOf = (...parts: (SQL | null)[]): SQL | "none" => {
  const given = parts.filter((p): p is SQL => p !== null);
  return given.length === 0 ? "none" : or(...given)!;
};

/** The customers of these family and student records, in the records' company (as every lookup here reads it), with the way back. */
export function linksOf(records: { families: readonly AppFamilyId[]; students: readonly AppStudentId[] }, tx?: Tx): Promise<LinkMaps> {
  return linksWhere(anyOf(records.families.length ? inArray(accountingLink.familyId, [...records.families]) : null,
    records.students.length ? inArray(accountingLink.studentId, [...records.students]) : null), tx);
}

/** The family records of these customers and the student records of those, in the records' company, with the way back. */
export function linksOfCustomers(customers: { families: readonly string[]; students: readonly string[] }, tx?: Tx): Promise<LinkMaps> {
  return linksWhere(anyOf(customers.families.length ? and(isNotNull(accountingLink.familyId), inArray(accountingLink.customerId, [...customers.families]))! : null,
    customers.students.length ? and(isNotNull(accountingLink.studentId), inArray(accountingLink.customerId, [...customers.students]))! : null), tx);
}
