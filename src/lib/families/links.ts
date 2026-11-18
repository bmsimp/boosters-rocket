import { and, eq, isNotNull } from "drizzle-orm";
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
 * Nothing a user sees calls them in stage 1; stage 2's parent queries find the session's app family through them.
 */
async function recordsCompany(tx?: Tx): Promise<string | null> {
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
