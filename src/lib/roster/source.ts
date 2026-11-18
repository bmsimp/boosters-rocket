import { and, eq, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { familyMoney, jobRun, qboCustomer, qboCustomerType, setting, writeQueue } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { clearParentAccess } from "@/lib/parents/company-change";
import { clearSeasonRecords } from "@/lib/seasons/company-change";
import { clearMoneyRecords } from "@/lib/money/company-change";
import { clearVolunteerRecords } from "@/lib/volunteer/company-change";
import { clearFormRecords } from "@/lib/forms/company-change";
import { clearCheckRecords } from "@/lib/quickbooks/sandbox-check/view";
import { clearAppRecords } from "@/lib/families/company-change";
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
 * When the cache came from a company other than `realmId`, everything that belonged to that company goes: the cache,
 * the membership shape (its type IDs mean nothing in another company), the roster's run history (so the worker reads
 * the new company at once; `keepRunId` spares the run doing this), all parent access (`clearParentAccess`), what
 * each family was last seen to owe (`family_money`: another company's invoices are never shown), what the seasons
 * record against customers (`clearSeasonRecords`: ticks, waivers and chosen lists), the products and services a
 * payment requirement is met by, with the worker's place in its read of every family (`clearMoneyRecords`), every
 * volunteer sign-up (`clearVolunteerRecords`), and every form made for a family to sign (`clearFormRecords`: the
 * requests and the consents with them), and every staff roster write in the queue, waiting or finished, whose ids are
 * that company's (`write_queue`, counted in the audit row), the records the check of the portal's requests made there
 * (`clearCheckRecords`), and the app's own families, students and links made from its customers (`clearAppRecords`). The same company, or a cache that says no company, keeps it all. The caller
 * owns the transaction and holds ROSTER_LOCK.
 */
export async function clearRosterOfOtherCompanyLocked(tx: Tx, realmId: string, o: { actor: Actor; ip: string | null; keepRunId?: number }): Promise<boolean> {
  const from = await getRosterSource(tx);
  if (from === null || from === realmId) return false;
  // Parent access first: the snapshot it keeps takes the family names from the cache deleted below.
  await clearParentAccess(tx, { fromRealmId: from, toRealmId: realmId, actor: o.actor, ip: o.ip });
  // The app's own families, students and links, made from that company's customers (src/lib/families/).
  await clearAppRecords(tx, { fromRealmId: from, toRealmId: realmId, actor: o.actor, ip: o.ip });
  await tx.delete(qboCustomer);
  await clearVolunteerRecords(tx, { fromRealmId: from, toRealmId: realmId, actor: o.actor, ip: o.ip });
  await tx.delete(qboCustomerType);
  await tx.delete(familyMoney);
  await clearSeasonRecords(tx, { fromRealmId: from, toRealmId: realmId, actor: o.actor, ip: o.ip });
  await clearMoneyRecords(tx, { fromRealmId: from, toRealmId: realmId, actor: o.actor, ip: o.ip });
  await clearFormRecords(tx, { fromRealmId: from, toRealmId: realmId, actor: o.actor, ip: o.ip });
  // The records the check of the portal's requests made in that company (src/lib/quickbooks/sandbox-check/).
  await clearCheckRecords(tx, { actor: o.actor, ip: o.ip });
  await tx.delete(setting).where(eq(setting.key, SHAPE_KEY));
  const writesDeleted = (await tx.delete(writeQueue).returning({ id: writeQueue.id })).length;
  await tx.delete(jobRun).where(o.keepRunId === undefined ? eq(jobRun.job, ROSTER_JOB) : and(eq(jobRun.job, ROSTER_JOB), ne(jobRun.id, o.keepRunId)));
  await setRosterSource(tx, realmId);
  await writeAudit({ actor: o.actor, action: "roster.cleared", targetType: "setting", targetId: SOURCE_KEY, ip: o.ip,
    before: { realmId: from }, after: { reason: "different_company", realmId, writesDeleted } }, tx);
  return true;
}

/**
 * Called once a connection to `realmId` is stored: `clearRosterOfOtherCompanyLocked` in its own transaction. The roster
 * refresh does the same before it saves, so a clear that never ran here (a failure, a restart) still happens first.
 *
 * It takes the roster lock and nothing else, so it waits for a running refresh or shape save. The caller must not hold
 * the connection row lock: a running refresh holds the roster lock and can be waiting for that row.
 */
export async function clearRosterOfOtherCompany(realmId: string, o: { actor: Actor; ip: string | null }): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
    return clearRosterOfOtherCompanyLocked(tx, realmId, o);
  });
}
