import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { familyMoney, jobRun, qboCustomer, qboCustomerType, setting, writeQueue } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { clearMoneyRecords } from "@/lib/money/company-change";
import { endBuyoutsOfEarlierCompany } from "@/lib/buyouts/company-change";
import { clearCheckRecords } from "@/lib/quickbooks/sandbox-check/view";
import { endLinksOfEarlierCompany } from "@/lib/families/company-change";
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
 * The note on every queue item a change of company gave up, kept on the row for the clean-up and later readers (no page
 * shows a given-up item's note yet). True of an item tried before as well: nothing more is sent for it.
 */
export const GIVEN_UP_FOR_COMPANY_NOTE = "Given up: the club connected a different QuickBooks company, so nothing more was sent for this.";

/**
 * When the cache came from a company other than `realmId`, what open question 16 of the app-owned families spec says a
 * change of company clears (stage 4's slice M7a), and nothing else. The same company, or a cache that says no company,
 * keeps it all and answers false. The caller owns the transaction and holds ROSTER_LOCK.
 *
 * Ended: every unpaid live buy-out, `earlier_company`, nothing sent to QuickBooks, its invoice left in the old company's
 * books for the treasurer (endBuyoutsOfEarlierCompany(), src/lib/buyouts/company-change.ts); a paid one keeps counting.
 * Cleared, each naming the old company's customers, products or invoices: every link, moved into the link history as
 * `company_changed` with every "Left unlinked" mark (endLinksOfEarlierCompany(), src/lib/families/company-change.ts);
 * what each family was last seen to owe (`family_money`: another company's invoices are never shown, and a row read
 * from the old company at this moment is never shown either, its `realm_id` not the roster's); QuickBooks' own copies:
 * the customer list and its types, the products and each payment requirement's product, with the money run's place
 * and any run under way (clearMoneyRecords()), the records the check of the portal's requests made there
 * (clearCheckRecords()), the membership shape (its type ids mean nothing in another company), the roster's run history
 * (so the worker reads the new company at once; `keepRunId` spares the run doing this) and the roster's company. Given
 * up, not deleted: every queue item still to go (waiting, stuck or kept refused), of any kind, with one note and one
 * count (`writesGivenUp`); one done or given up is kept as it was. Kept, untouched: the families, students and guardian
 * rows, every sign-in, session, device, code, link, welcome and switch, every email change, the seasons' ticks,
 * waivers, chosen lists and reminders, every volunteer sign-up, credit and reminder, every form request, consent and
 * reminder record, and all kept evidence, which stays its family's (src/lib/forms/evidence-company.ts).
 *
 * The order: no foreign key orders it any more, as nothing the app's records are named by is deleted, but the buy-outs
 * end before the queue is given up. Their update takes each row's lock, so a void queued at that moment for an
 * invoiced one (queueVoid(), which holds no roster lock) either committed first, and its buy-out ends here and its
 * void is given up next, or waits, then finds the buy-out ended and queues nothing; given up first, a void queued
 * after it would be left waiting. The queue is given up in one statement; the links end next, then QuickBooks' copies,
 * and the roster's company last, with the audit row.
 *
 * What runs beside it (stage 4's slice M7a2). A roster write the worker is trying at that moment stays given up (every
 * finish in ./queue.ts and ./writes.ts is guarded by its state), and so does a buy-out write: its finish
 * (src/lib/buyouts/writes.ts) and staff "Give up" (giveUp(), ./queue.ts) take the roster lock shared, then the item,
 * then the buy-out, as closeBuyout() (src/lib/buyouts/close.ts) does, so none of them runs beside this, which holds
 * the roster lock alone; after it, a finish changes an item only while it waits, and the buy-out only by its state
 * guards, so the endings here stand (an invoice made at that moment is recorded on the ended buy-out).
 *
 * Nothing the portal runs reaches it until stage 4's slice M8 turns a change of company back on: a different company
 * is refused wherever one is connected or read (completeConnect() in src/lib/quickbooks/connection.ts, refreshRoster()
 * in ./refresh.ts; open question 18). Its tests call it directly (tests/integration/company-change-step5.test.ts).
 */
export async function clearRosterOfOtherCompanyLocked(tx: Tx, realmId: string, o: { actor: Actor; ip: string | null; keepRunId?: number }): Promise<boolean> {
  const from = await getRosterSource(tx);
  if (from === null || from === realmId) return false;
  const at = { fromRealmId: from, toRealmId: realmId, actor: o.actor, ip: o.ip };
  // Every unpaid live buy-out ends as the earlier company's, under each row's lock, before its queued writes are given up.
  await endBuyoutsOfEarlierCompany(tx, at);
  // Every queue item still to go, whatever its kind, is given up: its ids are the old company's, and it is never sent
  // there now. One done or given up already is kept as it was.
  const now = new Date();
  const writesGivenUp = (await tx.update(writeQueue).set({ state: "given_up", note: GIVEN_UP_FOR_COMPANY_NOTE, nextTryAt: null, finishedAt: now, updatedAt: now })
    .where(inArray(writeQueue.state, ["waiting", "stuck", "refused"])).returning({ id: writeQueue.id })).length;
  // What each family was last seen to owe: the old company's invoices.
  await tx.delete(familyMoney);
  // The links, into their history, and the "Left unlinked" marks (src/lib/families/).
  await endLinksOfEarlierCompany(tx, at);
  await tx.delete(qboCustomer);
  await tx.delete(qboCustomerType);
  await clearMoneyRecords(tx, at);
  // The records the check of the portal's requests made in that company (src/lib/quickbooks/sandbox-check/).
  await clearCheckRecords(tx, { actor: o.actor, ip: o.ip });
  await tx.delete(setting).where(eq(setting.key, SHAPE_KEY));
  await tx.delete(jobRun).where(o.keepRunId === undefined ? eq(jobRun.job, ROSTER_JOB) : and(eq(jobRun.job, ROSTER_JOB), ne(jobRun.id, o.keepRunId)));
  await setRosterSource(tx, realmId);
  await writeAudit({ actor: o.actor, action: "roster.cleared", targetType: "setting", targetId: SOURCE_KEY, ip: o.ip,
    before: { realmId: from }, after: { reason: "different_company", realmId, writesGivenUp } }, tx);
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
