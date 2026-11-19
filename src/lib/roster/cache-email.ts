// A parent's confirmed change of sign-in email, taken into the roster cache once QuickBooks has said yes
// (src/lib/parents/email-change.ts). It changes the cache and brings the app's own records into step after it, as
// every change of the cache does (keepAppRecordsInStep()); it decides nothing about who may sign in. The caller holds
// the roster lock and owns the transaction, and puts what the records' step changed on its own audit row.
import { eq } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { qboCustomer } from "@/lib/db/schema";
import { keepAppRecordsInStep } from "@/lib/families/in-step";
import type { AppRecordChanges } from "@/lib/families/changes";

/** A QuickBooks SyncToken as a number, for which version is later; anything that isn't digits is earlier than all. */
const versionNumber = (t: string | null | undefined): bigint => (t && /^\d{1,20}$/.test(t) ? BigInt(t) : BigInt(-1));

/**
 * Stores QuickBooks' answer for the customer's email field as the roster refresh stores one (trimmed and lower-cased,
 * at most 320 characters), only over an older version: a refresh that finished while the caller waited may hold a
 * later one, which is kept. Then the app's own records are brought into step.
 */
export async function takeEmailIntoCache(tx: Tx, c: { qboId: string; field: string | null; version: string; updatedAt: Date | null }): Promise<AppRecordChanges> {
  const [cached] = await tx.select({ syncToken: qboCustomer.syncToken }).from(qboCustomer).where(eq(qboCustomer.qboId, c.qboId)).for("update");
  if (!cached || versionNumber(cached.syncToken) < versionNumber(c.version)) {
    await tx.update(qboCustomer).set({ email: c.field?.trim().slice(0, 320).toLowerCase() || null, syncToken: c.version, ...(c.updatedAt ? { qboUpdatedAt: c.updatedAt } : {}) })
      .where(eq(qboCustomer.qboId, c.qboId));
  }
  return keepAppRecordsInStep(tx);
}
