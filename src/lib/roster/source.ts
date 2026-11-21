import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
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

/**
 * A change of company an Admin asked for, and then the one a connect stored (stage 4's slice M8): one row, never sent to
 * a page. `asked` is written with a connect's state by beginSwitchConnect() (src/lib/quickbooks/connection.ts), with
 * the same hash and expiry, and the roster's company as read then; completeConnect() spends it with the state, and lets
 * a company other than the roster's be connected only against it. `stored` is written by that connect's store, in its
 * transaction, and spent by the clear below, in the clear's (step 3b, or the roster refresh's backstop when 3b never
 * ran). A connection to another company with no such record is never read over the roster's company (refreshRoster()).
 */
export const SWITCH_KEY = "quickbooks.switch";
export type SwitchAsked = { stateHash: string; staffUserId: string; expiresAt: string; fromRealmId: string };
export type SwitchStored = { fromRealmId: string; toRealmId: string; staffUserId: string; at: string };
export type SwitchRecord = { asked: SwitchAsked } | { stored: SwitchStored };

const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;
/** The switch row as stored, or null when there is none or it doesn't read as one. */
export async function getSwitchRecord(tx?: Tx): Promise<SwitchRecord | null> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, SWITCH_KEY));
  const v = row?.value as { asked?: Record<string, unknown>; stored?: Record<string, unknown> } | undefined;
  const a = v?.asked, s = v?.stored;
  if (a && isText(a.stateHash) && isText(a.staffUserId) && isText(a.expiresAt) && isText(a.fromRealmId)) {
    return { asked: { stateHash: a.stateHash, staffUserId: a.staffUserId, expiresAt: a.expiresAt, fromRealmId: a.fromRealmId } };
  }
  if (s && isText(s.fromRealmId) && isText(s.toRealmId) && isText(s.staffUserId) && isText(s.at)) {
    return { stored: { fromRealmId: s.fromRealmId, toRealmId: s.toRealmId, staffUserId: s.staffUserId, at: s.at } };
  }
  return null;
}

/** Whether the switch row is a stored switch from `fromRealmId` to `toRealmId`: the licence to clear for that pair alone. */
export const storedSwitchOf = (r: SwitchRecord | null, fromRealmId: string | null, toRealmId: string | null): boolean =>
  r !== null && "stored" in r && fromRealmId !== null && toRealmId !== null && r.stored.fromRealmId === fromRealmId && r.stored.toRealmId === toRealmId;

/**
 * Drops an ask to switch companies, and only an ask: a stored switch is the clear's to spend, so a new sign-in to
 * Intuit, or a connect that spends its state, never takes from the refresh the switch it is to finish.
 */
export async function dropSwitchAsk(tx: Tx): Promise<void> {
  await tx.delete(setting).where(and(eq(setting.key, SWITCH_KEY), sql`(${setting.value} -> 'asked') is not null`));
}

export async function setSwitchRecord(tx: Tx, value: SwitchRecord): Promise<void> {
  await tx.insert(setting).values({ key: SWITCH_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } });
}

export async function getRosterSource(tx?: Tx): Promise<string | null> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, SOURCE_KEY));
  const realmId = (row?.value as { realmId?: unknown } | undefined)?.realmId;
  return typeof realmId === "string" ? realmId : null;
}

/**
 * True of a queue item filed under the roster cache's company (`write_queue.realm_id` against `roster.source`, read in
 * the same statement, so it costs no extra read and matches nothing while the cache names no company): the one rule
 * every reader of open items holds (stage 4's slice M7a3), so an item a change of company left open (a parent's save
 * that read the old company before the clear committed, until the worker's next wake gives it up: runWriteQueue(),
 * ./queue.ts) never holds a record back, takes a name, lists, counts or is closed as replaced by the new company's
 * change. The roster's company, not the connection's: while QuickBooks is connected to another company, the roster's
 * own items are still its records' pending changes, and still hold them back and show (givenUpMaybeMade(), ./writes.ts,
 * reads none then: what it finds would be sent to the connected company).
 */
export const ofRosterCompany: SQL = sql`${writeQueue.realmId} = (select ${setting.value}->>'realmId' from ${setting} where ${setting.key} = ${SOURCE_KEY})`;

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
 * books for the treasurer (endBuyoutsOfEarlierCompany(), src/lib/buyouts/company-change.ts); a paid one keeps counting,
 * and so does an invoiced one its family's stored figures show paid, which is marked paid first (slice M7b2).
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
 * void is given up next, or waits, then finds the buy-out ended (or, for one marked paid first, paid) and queues nothing; given up first, a void queued
 * after it would be left waiting. The queue is given up in one statement; the links end next, then QuickBooks' copies,
 * and the roster's company last, with the audit row.
 *
 * What runs beside it (stage 4's slice M7a2). A roster write the worker is trying at that moment stays given up (every
 * finish in ./queue.ts and ./writes.ts is guarded by its state), and so does a buy-out write: its finish
 * (src/lib/buyouts/writes.ts) and staff "Give up" (giveUp(), ./queue.ts) take the roster lock shared, then the item,
 * then the buy-out, as closeBuyout() (src/lib/buyouts/close.ts) does, so none of them runs beside this, which holds
 * the roster lock alone; after it, a finish changes an item only while it waits, and the buy-out only by its state
 * guards, so the endings here stand (an invoice made at that moment is recorded on the ended buy-out). A staff insert
 * into the queue after it goes in given up (holdForTheQueue(), enqueue(), ./writes.ts: each takes the roster lock and
 * finds the roster another company's), and the worker gives up any parent's item inserted after it, which takes no
 * roster lock (runWriteQueue(), ./queue.ts). Until it does, every reader of open items reads only the roster's
 * company's (ofRosterCompany above, stage 4's slice M7a3), so such an item holds nothing back, lists or counts nowhere.
 *
 * How it is reached (stage 4's slice M8): an Admin asks on the switch page first (beginSwitchConnect(),
 * src/lib/quickbooks/connection.ts, which records the ask under SWITCH_KEY); the connect that follows stores the
 * connection to the other company against that ask only, records the switch, and then runs this (step 3b of
 * completeConnect(), through clearRosterOfOtherCompany() below); a 3b that never ran is run by the roster refresh, in
 * its save's savepoint, for that recorded switch only (./refresh.ts). It spends the switch row, whatever it holds. A
 * company connected without an ask is refused (`roster_company`), and one stored by hand is never read.
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
  await tx.delete(setting).where(eq(setting.key, SWITCH_KEY));
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
