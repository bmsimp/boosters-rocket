// A parent's confirmed change of sign-in email, taken into the roster cache once QuickBooks has said yes
// (src/lib/parents/email-change.ts). It puts the address in the cache and nothing else: the app's own records stand
// alone (stage 3's slice 9c), and it decides nothing about who may sign in. The caller holds the roster lock and owns
// the transaction. Parent-reachable: the parent's confirm (email-change.ts, parent code) calls it, so it imports no
// staff-only module (AGENTS.md, Privacy).
import { eq } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { qboCustomer } from "@/lib/db/schema";

/** A QuickBooks SyncToken as a number, for which version is later; anything that isn't digits is earlier than all. */
const versionNumber = (t: string | null | undefined): bigint => (t && /^\d{1,20}$/.test(t) ? BigInt(t) : BigInt(-1));

/**
 * Stores QuickBooks' answer for the customer's email field as the roster refresh stores one (trimmed and lower-cased,
 * at most 320 characters), only over an older version: a refresh that finished while the caller waited may hold a
 * later one, which is kept.
 */
export async function takeEmailIntoCache(tx: Tx, c: { qboId: string; field: string | null; version: string; updatedAt: Date | null }): Promise<void> {
  const [cached] = await tx.select({ syncToken: qboCustomer.syncToken }).from(qboCustomer).where(eq(qboCustomer.qboId, c.qboId)).for("update");
  if (!cached || versionNumber(cached.syncToken) < versionNumber(c.version)) {
    await tx.update(qboCustomer).set({ email: c.field?.trim().slice(0, 320).toLowerCase() || null, syncToken: c.version, ...(c.updatedAt ? { qboUpdatedAt: c.updatedAt } : {}) })
      .where(eq(qboCustomer.qboId, c.qboId));
  }
}
