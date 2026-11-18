import { and, eq } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { accountingLink } from "@/lib/db/schema";
import { getConnection } from "@/lib/quickbooks/connection";
import { QUICKBOOKS, type AppFamilyId, type AppStudentId } from "./ids";

/**
 * Lookups through a link, one record at a time (stage 1 of the app-owned families spec). Each names the company
 * QuickBooks is connected to now, read here and never taken from the caller, so another company's link can never
 * answer: while nothing is connected each answers null. Nothing a user sees calls them in stage 1; stage 2's parent
 * queries find the session's app family through them.
 */
async function connectedCompany(tx?: Tx): Promise<string | null> {
  const c = await getConnection(tx);
  return c?.realmId && c.refreshTokenCiphertext ? c.realmId : null;
}

async function linkOfCustomer(customerId: string, tx?: Tx) {
  const realmId = await connectedCompany(tx);
  if (realmId === null) return null;
  const [l] = await (tx ?? db).select().from(accountingLink)
    .where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId), eq(accountingLink.customerId, customerId)));
  return l ?? null;
}

/** The app family linked to this customer of the connected company, or null. */
export async function familyLinkedTo(customerId: string, tx?: Tx): Promise<AppFamilyId | null> {
  return (await linkOfCustomer(customerId, tx))?.familyId ?? null;
}

/** The app student linked to this customer of the connected company, or null. */
export async function studentLinkedTo(customerId: string, tx?: Tx): Promise<AppStudentId | null> {
  return (await linkOfCustomer(customerId, tx))?.studentId ?? null;
}

/** The customer of the connected company this app family is linked to, or null. */
export async function customerOfFamily(familyId: AppFamilyId, tx?: Tx): Promise<string | null> {
  const realmId = await connectedCompany(tx);
  if (realmId === null) return null;
  const [l] = await (tx ?? db).select({ customerId: accountingLink.customerId }).from(accountingLink)
    .where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId), eq(accountingLink.familyId, familyId)));
  return l?.customerId ?? null;
}
