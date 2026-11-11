import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { jobRun, qboCustomer, qboCustomerType, setting } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { ROSTER_LOCK, SHAPE_KEY } from "./shape";

export const ROSTER_JOB = "roster.refresh";
/** Which QuickBooks company the cache was read from: `{ realmId }`, written with every cache swap. Never sent to a page. */
export const SOURCE_KEY = "roster.source";

export async function getRosterSource(tx?: Tx): Promise<string | null> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, SOURCE_KEY));
  const realmId = (row?.value as { realmId?: unknown } | undefined)?.realmId;
  return typeof realmId === "string" ? realmId : null;
}

export async function setRosterSource(tx: Tx, realmId: string): Promise<void> {
  const value = { realmId };
  await tx.insert(setting).values({ key: SOURCE_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } });
}

/**
 * Called once a connection to `realmId` is stored. When the cache came from a different company, everything that
 * belonged to that company goes: the cache, the membership shape (its type IDs mean nothing in another company) and
 * the roster's run history (so the worker reads the new company at once). Reconnecting the same company keeps it all.
 *
 * It takes the roster lock and nothing else, so it waits for a running refresh or shape save. The caller must not hold
 * the connection row lock: a running refresh holds the roster lock and can be waiting for that row.
 */
export async function clearRosterOfOtherCompany(realmId: string, o: { actor: Actor; ip: string | null }): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
    const from = await getRosterSource(tx);
    if (from === null || from === realmId) return false;
    await tx.delete(qboCustomer);
    await tx.delete(qboCustomerType);
    await tx.delete(setting).where(eq(setting.key, SHAPE_KEY));
    await tx.delete(jobRun).where(eq(jobRun.job, ROSTER_JOB));
    await setRosterSource(tx, realmId);
    await writeAudit({ actor: o.actor, action: "roster.cleared", targetType: "setting", targetId: SOURCE_KEY, ip: o.ip,
      before: { realmId: from }, after: { reason: "different_company", realmId } }, tx);
    return true;
  });
}
