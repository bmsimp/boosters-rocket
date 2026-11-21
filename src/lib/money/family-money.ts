// Parent-facing: everything here takes one family's id, which the caller takes from the session (ctx.familyId, the
// app's own family record), and returns that family's money alone. Nothing in a request ever chooses the customers:
// the family's customer is the one its own family link names, in the roster's company (customerOfFamily(), which
// answers nothing while QuickBooks is connected to another company), found again on each load, and the customers whose
// invoices may show are that customer and its active direct sub-customers of the student or parent type in the roster
// cache. A family with no active record, or with no link, has no figures: nothing is read from QuickBooks for it and
// nothing is written; an active family the portal can tell has no link is told so (`notConnected`). The stored figures are kept by the app's own family (family_money.family_id). This module is in the staff-only import scan
// (tests/integration/page-guards.test.ts).
import { eq, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { familyMoney, qboConnection, qboCustomer, type CustomerCheck, type StoredInvoice } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import type { AppFamilyId } from "@/lib/families/ids";
import { customerOfFamily, familyLinkState } from "@/lib/families/links";
import { activeFamilyOf } from "@/lib/families/session-family";
import { isQboId, qboCustomerById, qboInvoices, type QboGetOptions } from "@/lib/quickbooks/client";
import { QboError } from "@/lib/quickbooks/endpoints";
import { shapeHolds } from "@/lib/roster/shape";
import { getRosterSource } from "@/lib/roster/source";
import { clubToday } from "@/lib/settings/club";
import { currencyOf, toCents } from "./cents";
import { openInvoices, paidInvoices, shownInvoices, utcDay } from "./invoices";
import { safePayLink } from "./pay-link";
import { getMoneySettings } from "./settings";
import { familyCustomers, knowsItems, mayShow, type FamilyCustomers, type MoneyRow } from "./stored";

/** How long one request to QuickBooks may take during a page load, and (at one and a half times that) the whole read. */
const CALL_TIMEOUT_MS = 4_000;
/** How long one request to QuickBooks may take during the worker's read of every family. */
const RUN_CALL_TIMEOUT_MS = 15_000;
/** After a failed try, a page load shows what is stored for this long before QuickBooks is asked again. */
export const RETRY_AFTER_FAILURE_MS = 30_000;
/**
 * Live reads running at once in this process. Each holds a database connection for its lock while QuickBooks answers;
 * the pool has 10, and Intuit allows an app 10 requests at a time. The access token costs them no second connection
 * to wait on: a page load never queues for the connection row (`failFast`, accessTokenForPage in the client), so a
 * token refresh that hangs keeps one connection at most, however many families are loading.
 */
export const MAX_LIVE_READS = 4;
/** How long a page load waits for one of those places before it shows what is stored. */
const PLACE_WAIT_MS = 2_000;
/** First key of the per-family advisory lock; the second is a hash of the app family's own id, in page loads and the run alike. */
const MONEY_LOCK = 7461002;
const MONEY_ACTOR = { door: "system", id: null, label: "portal" } as const;

export type MoneyFigures = {
  /** When QuickBooks gave these figures (ISO). */
  asOf: string;
  /**
   * False when QuickBooks couldn't be read just now: these are the last figures it gave, and paying is switched off.
   * The cause may be an outage, a connection only an Admin can mend, or another read under way; the page is not told
   * which, and says nothing that is true of only one of them.
   */
  current: boolean;
  /** The sum of the open invoices. Not shown as one figure when `currency` is null (invoices in more than one currency). */
  totalCents: number;
  currency: string | null;
  open: StoredInvoice[];
  paid: StoredInvoice[];
  /** QuickBooks' own balance for the family is lower than the invoices add up to: a credit or an unapplied payment. */
  credit: boolean;
};
/**
 * `figures` is null when there is nothing to show: no successful read yet for this family in the connected company.
 * `notConnected` is true only for an active family the portal can tell has no link to a customer (familyLinkState()
 * says `none`): the page says the club hasn't connected the family's payments yet, and `figures` is null. Every other
 * case with no figures (QuickBooks connected to another company, a shape that doesn't hold, a family the cache no
 * longer holds as one, a failed read with nothing stored) leaves it false, and the page says what it always has.
 * `today` is the club's own date (YYYY-MM-DD, clubToday()): the day each due date is said against ("in 8 days", "Was due").
 */
export type FamilyMoney = { familyName: string | null; figures: MoneyFigures | null; notConnected: boolean; today: string };

/**
 * Whether QuickBooks' BalanceWithJobs for the family customer adds up the same customers as the family's total. It
 * counts the family customer and every customer under it, at every depth; the total leaves some of those out on
 * purpose (another family nested under this one, an inactive student, a sponsor, a student's own sub-customer).
 * Compared anyway, a credit or a debt of a customer the family is not shown would be told to it as its own, and
 * audited as a difference that isn't one. So the two are compared only when the cache holds nothing under the family
 * but the customers whose invoices were read.
 */
async function balanceCoversTheSame(familyQboId: string, family: FamilyCustomers, tx: Tx): Promise<boolean> {
  if (family.othersUnder) return false;
  const under = [...family.customers.keys()].filter((id) => id !== familyQboId);
  if (!under.length) return true;
  const [deeper] = await tx.select({ qboId: qboCustomer.qboId }).from(qboCustomer).where(inArray(qboCustomer.parentQboId, under)).limit(1);
  return deeper === undefined;
}

/** The stored figures, when they may be shown (mayShow); otherwise they are treated as absent. */
function figuresOf(row: MoneyRow | undefined, source: string | null, family: FamilyCustomers | null, current: boolean): MoneyFigures | null {
  if (!mayShow(row, source, family)) return null;
  // A stored link is checked again on its way out: the page never trusts the table to hold only good ones.
  const invoices = row.invoices.map((i) => ({ ...i, payLink: safePayLink(i.payLink) }));
  return {
    asOf: row.readAt.toISOString(), current, totalCents: row.totalCents, currency: row.currency,
    open: openInvoices(invoices), paid: paidInvoices(invoices),
    credit: row.currency !== null && row.balanceWithJobsCents !== null && row.balanceWithJobsCents < row.totalCents,
  };
}

/** Fresh: shown at once. A row that doesn't say which products and services its invoices carry is read again, however new. */
const isFresh = (row: MoneyRow | undefined, source: string | null, family: FamilyCustomers | null, freshSeconds: number): boolean =>
  mayShow(row, source, family) && knowsItems(row) && Date.now() - row.readAt.getTime() < freshSeconds * 1000
  // A buy-out invoice was made or voided since the read (src/lib/buyouts/writes.ts): QuickBooks is read again.
  && !(row.staleAt && row.staleAt >= row.readAt);
const failedJustNow = (row: MoneyRow | undefined): boolean =>
  Boolean(row?.failedAt && (!row.readAt || row.failedAt > row.readAt) && Date.now() - row.failedAt.getTime() < RETRY_AFTER_FAILURE_MS);

let live = 0;
const waiting: ((got: boolean) => void)[] = [];
function takePlace(): Promise<boolean> {
  if (live < MAX_LIVE_READS) { live++; return Promise.resolve(true); }
  return new Promise((resolve) => {
    const mine = (got: boolean) => { clearTimeout(timer); resolve(got); };
    const timer = setTimeout(() => { waiting.splice(waiting.indexOf(mine), 1); resolve(false); }, PLACE_WAIT_MS);
    waiting.push(mine);
  });
}
function givePlace(): void {
  const next = waiting.shift();
  if (next) next(true); else live--;
}

/**
 * How a read is made. A parent's page load (`page`) must answer soon and leave nothing queued behind it: short timeouts,
 * `failFast`, and it never waits for the connection row. The worker's read of every family (`run`, ./sweep.ts) may wait
 * for that row, keeps its gentle pace through `pace`, and also compares each customer's own balance with its invoices.
 */
type ReadHow = { kind: "page"; timeoutMs: number } | { kind: "run"; timeoutMs: number; pace: () => Promise<void> };

type Read =
  | { ok: true; realmId: string; invoices: StoredInvoice[]; totalCents: number; currency: string | null; balanceWithJobsCents: number | null; checks: CustomerCheck[] | null }
  | { ok: false; code: string };

/**
 * The cross-check made customer by customer (v1 spec §8.3), for the worker's read: QuickBooks' own balance for each
 * customer whose invoices the family is shown (Customer.Balance, which leaves sub-customers out), beside the sum of
 * that customer's open invoices from the same read. `checks` is null when it couldn't be done for every one of them.
 * A customer whose open invoices are in another currency than its own is not compared. The family customer's
 * BalanceWithJobs comes with its record, and is kept when it covers the same customers as the total.
 */
async function checkCustomers(familyQboId: string, family: FamilyCustomers, invoices: StoredInvoice[], comparable: boolean, o: QboGetOptions):
  Promise<{ checks: CustomerCheck[] | null; balanceWithJobsCents: number | null }> {
  const checks: CustomerCheck[] = [];
  let balanceWithJobsCents: number | null = null;
  for (const [customerQboId, name] of family.customers) {
    let customer: Record<string, unknown> | null;
    try { customer = await qboCustomerById(customerQboId, o); } catch (e) { if (e instanceof QboError) return { checks: null, balanceWithJobsCents }; throw e; }
    const balanceCents = toCents(customer?.Balance);
    if (!customer || balanceCents === null) return { checks: null, balanceWithJobsCents };
    if (customerQboId === familyQboId && comparable) balanceWithJobsCents = toCents(customer.BalanceWithJobs);
    const open = invoices.filter((i) => i.customerQboId === customerQboId && i.balanceCents > 0);
    const currency = currencyOf((customer.CurrencyRef as { value?: unknown } | null | undefined)?.value);
    if (open.some((i) => i.currency !== currency)) continue;
    checks.push({ customerQboId, name, balanceCents, invoicesCents: open.reduce((sum, i) => sum + i.balanceCents, 0), currency });
  }
  return { checks, balanceWithJobsCents };
}

/** One read of a family's invoices from QuickBooks, refused before anything is asked unless it is certain to be the right company. */
async function readFromQuickBooks(familyQboId: string, family: FamilyCustomers | null, tx: Tx, how: ReadHow): Promise<Read> {
  const fail = (code: string): Read => ({ ok: false, code });
  // Never the wrong company: QuickBooks is connected, and to the company the roster cache (and so this family's
  // customer ids) was read from. Every request then checks the company again as it is sent (`realmId`).
  const [connection] = await tx.select({ realmId: qboConnection.realmId, refresh: qboConnection.refreshTokenCiphertext }).from(qboConnection);
  if (!connection?.realmId || !connection.refresh) return fail("not_connected");
  const realmId = await getRosterSource(tx);
  if (realmId === null || realmId !== connection.realmId) return fail("other_company");
  if (!family) return fail("not_a_family");
  const ids = [...family.customers.keys()];
  if (!ids.every(isQboId)) return fail("bad_id");
  const comparable = await balanceCoversTheSame(familyQboId, family, tx);
  const o: QboGetOptions = how.kind === "page"
    ? { timeoutMs: how.timeoutMs, signal: AbortSignal.timeout(how.timeoutMs * 1.5), retry: true, failFast: true, realmId }
    : { timeoutMs: how.timeoutMs, retry: true, realmId, pace: how.pace };
  try {
    const shown = shownInvoices(await qboInvoices(ids, o), family.customers, utcDay());
    if (!shown) return fail("bad_answer");
    if (how.kind === "run") return { ok: true, realmId, ...shown, ...(await checkCustomers(familyQboId, family, shown.invoices, comparable, o)) };
    // QuickBooks' own balance, as a cross-check only (v1 spec §8.3): the figure a parent sees never waits on it. It is
    // not asked for when it would count customers the total leaves out: there is then nothing to compare it with.
    let balanceWithJobsCents: number | null = null;
    if (comparable) {
      try { balanceWithJobsCents = toCents((await qboCustomerById(familyQboId, o))?.BalanceWithJobs); } catch (e) { if (!(e instanceof QboError)) throw e; }
    }
    return { ok: true, realmId, ...shown, balanceWithJobsCents, checks: null };
  } catch (e) {
    // Only a QboError's own short code is kept; anything else (an answer that wasn't the shape expected) gets a fixed one.
    return fail(e instanceof QboError ? e.code : "unexpected");
  }
}

/** The customers whose own balance and open invoices differ, as the audit row names them. */
const differing = (checks: CustomerCheck[] | null) => (checks ?? []).filter((c) => c.balanceCents !== c.invoicesCents)
  .map((c) => ({ customerQboId: c.customerQboId, balanceCents: c.balanceCents, invoicesCents: c.invoicesCents, currency: c.currency }));

export type ReadOutcome = { ok: true } | { ok: false; code: string };

/**
 * Reads one family from QuickBooks and keeps what came back, inside the transaction that holds the family's lock. The
 * row's figures are replaced only by a successful read; a failed try records its time and short code and leaves them
 * alone. A difference in the cross-check is recorded for staff, once per family per day at most (v1 spec §8.3).
 */
async function readAndKeep(tx: Tx, familyId: AppFamilyId, familyQboId: string, before: MoneyRow | undefined, family: FamilyCustomers | null, how: ReadHow): Promise<ReadOutcome> {
  // The figures are as of when QuickBooks was first asked, not when it had answered: a buy-out invoice made while it was
  // answering marks the row behind (staleAt) after this, so the next look reads it again rather than taking these
  // figures, which may not hold it, as current (isFresh, and the daily check of buy-out invoices).
  const askedAt = new Date();
  const read = await readFromQuickBooks(familyQboId, family, tx, how);
  const now = new Date();
  // The company the cache belongs to changed while QuickBooks was answering: these figures are the old company's.
  const outcome: Read = read.ok && (await getRosterSource(tx)) !== read.realmId ? { ok: false, code: "other_company" } : read;
  if (!outcome.ok) {
    // The worker's run listed a family the cache no longer holds as one (made inactive, or moved under another, while
    // the run read): nothing was asked of QuickBooks and nothing failed, so nothing is stamped on a row for it.
    if (how.kind === "run" && outcome.code === "not_a_family") return { ok: false, code: outcome.code };
    const failed = { failedAt: now, failedCode: outcome.code.slice(0, 40), updatedAt: now };
    await tx.insert(familyMoney).values({ familyId, ...failed }).onConflictDoUpdate({ target: familyMoney.familyId, set: failed });
    return { ok: false, code: outcome.code };
  }
  const customers = differing(outcome.checks);
  const differs = (outcome.currency !== null && outcome.balanceWithJobsCents !== null && outcome.balanceWithJobsCents !== outcome.totalCents) || customers.length > 0;
  const auditedToday = before?.mismatchAuditedAt != null && utcDay(before.mismatchAuditedAt) === utcDay(now);
  const figures = {
    realmId: outcome.realmId, readAt: askedAt, invoices: outcome.invoices, totalCents: outcome.totalCents, currency: outcome.currency,
    balanceWithJobsCents: outcome.balanceWithJobsCents, updatedAt: now, ...(differs && !auditedToday ? { mismatchAuditedAt: now } : {}),
    // A page load leaves the worker's customer check as it was: that is a record of its own read, with its own time.
    ...(how.kind === "run" ? { checkedAt: outcome.checks ? now : null, customerChecks: outcome.checks } : {}),
  };
  await tx.insert(familyMoney).values({ familyId, ...figures }).onConflictDoUpdate({ target: familyMoney.familyId, set: figures });
  if (differs && !auditedToday) {
    await writeAudit({ actor: MONEY_ACTOR, action: "money.balance_mismatch", targetType: "family", targetId: String(familyId),
      after: { invoicesCents: outcome.totalCents, balanceWithJobsCents: outcome.balanceWithJobsCents, currency: outcome.currency, ...(customers.length ? { customers } : {}) } }, tx);
  }
  return { ok: true };
}

/** The two keys of the family's advisory lock: by the app family's own id, so a page load and the run exclude each other. */
const familyLock = (familyId: AppFamilyId) => sql`${sql.raw(String(MONEY_LOCK))}, hashtext(${String(familyId)}::text)`;

/** The run's code for a family whose link changed between the run's listing and its lock: passed over, never a failure. */
export const RELINKED = "relinked";

/**
 * Forgets one family's stored figures (stage 4's slice M3b, Unlink from the books), in the caller's transaction, which
 * holds the roster lock: the family's money lock is taken first, waiting for a page load's or the run's read of it to
 * finish (they take no roster lock while they hold it, so the order is always the roster lock, then this one), then
 * its row is deleted. Whether there was one.
 */
export async function forgetFamilyMoney(tx: Tx, familyId: AppFamilyId): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock(${familyLock(familyId)})`);
  return (await tx.delete(familyMoney).where(eq(familyMoney.familyId, familyId)).returning({ familyId: familyMoney.familyId })).length > 0;
}

/** The stored row of one app family. */
const storedRow = async (familyId: AppFamilyId, tx?: Tx): Promise<MoneyRow | undefined> =>
  (await (tx ?? db).select().from(familyMoney).where(eq(familyMoney.familyId, familyId)))[0];

/**
 * Asks QuickBooks for one family's figures, for a page load, and keeps them. True when the stored figures are now
 * current.
 *
 * A per-family advisory lock is held from before QuickBooks is asked until the row is saved, so two requests for one
 * family (in two processes) never both go to QuickBooks: the second finds the lock taken and shows what is there.
 */
async function liveRead(familyId: AppFamilyId, timeoutMs: number): Promise<boolean> {
  if (!(await takePlace())) return false;
  try {
    return await db.transaction(async (tx) => {
      // The family's record and its customer, found again here: with no active record, or no link, nothing is read or written.
      if ((await activeFamilyOf(familyId, tx)) === null) return false;
      const familyQboId = await customerOfFamily(familyId, tx);
      if (familyQboId === null) return false;
      const [lock] = (await tx.execute(sql`select pg_try_advisory_xact_lock(${familyLock(familyId)}) as locked`)) as unknown as { locked: boolean }[];
      if (!lock?.locked) return false;
      // Found again under the lock (stage 4's slice M3b): an unlink or a relink that committed between the first look and
      // the lock leaves nothing to read for the customer found before, so another customer's invoices are never kept for
      // the family. The lock order is the roster lock, then this one: an unlink takes this lock after the roster lock
      // (forgetFamilyMoney()), and nothing that holds this lock takes the roster lock.
      if ((await customerOfFamily(familyId, tx)) !== familyQboId) return false;
      const before = await storedRow(familyId, tx);
      const family = await familyCustomers(familyQboId, tx);
      // Whoever held the lock a moment ago may have just read it, or just failed to.
      if (isFresh(before, await getRosterSource(tx), family, (await getMoneySettings(tx)).freshSeconds)) return true;
      if (failedJustNow(before)) return false;
      return (await readAndKeep(tx, familyId, familyQboId, before, family, { kind: "page", timeoutMs })).ok;
    });
  } finally {
    givePlace();
  }
}

/**
 * One family read from QuickBooks for the worker's run over every family (./sweep.ts), however fresh its figures are,
 * with the customer-by-customer check: `familyId` is the app family the run found linked to the family customer
 * `familyQboId`, whose customers are read. It waits its turn for the family's lock (a page load holding it finishes
 * first) and may wait for the connection row; it takes none of the places kept for page loads. A failure's code is its
 * own short code, by which the run decides whether to carry on.
 */
export async function readFamilyForRun(familyId: AppFamilyId, familyQboId: string, o: { pace: () => Promise<void>; timeoutMs?: number }): Promise<ReadOutcome> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${familyLock(familyId)})`);
    // The family's link, read again under the lock (stage 4's slice M3b): a family unlinked, or linked to another
    // customer, since the run listed it is passed over, with nothing read or stamped (RELINKED, counted as not read).
    if ((await customerOfFamily(familyId, tx)) !== familyQboId) return { ok: false, code: RELINKED };
    const before = await storedRow(familyId, tx);
    return readAndKeep(tx, familyId, familyQboId, before, await familyCustomers(familyQboId, tx), { kind: "run", timeoutMs: o.timeoutMs ?? RUN_CALL_TIMEOUT_MS, pace: o.pace });
  });
}

/** Two page loads for one family in this process share one read: the second waits for the first and shows what it brought. */
const reading = new Map<string, Promise<boolean>>();
function readOnce(familyId: AppFamilyId, timeoutMs: number): Promise<boolean> {
  const key = String(familyId);
  let read = reading.get(key);
  if (!read) {
    read = liveRead(familyId, timeoutMs).finally(() => reading.delete(key));
    reading.set(key, read);
  }
  return read;
}

/**
 * What one family owes, for its own parents (v1 spec §8.2). `familyId` is ctx.familyId from the session.
 *
 * Fresh stored figures are shown at once. Older ones (or none) mean one read from QuickBooks first, with a short
 * timeout; if that can't be done, the last figures QuickBooks gave are shown marked as not current, and with none
 * stored there is nothing to show. Figures from another QuickBooks company are never shown, nor figures that hold an
 * invoice of a customer who is no longer this family's (mayShow), and nothing is shown for a family whose customer the
 * roster cache does not hold as an active family, nor for one with no active record or no link to a customer (nothing
 * is read or written for it either). Of those, only an active family the portal can tell has no link is `notConnected`.
 */
export async function loadFamilyMoney(familyId: AppFamilyId, o: { timeoutMs?: number } = {}): Promise<FamilyMoney> {
  const shown = await figuresToShow(familyId, o);
  // The club's day as the page is drawn, after any wait for QuickBooks.
  return { ...shown, today: await clubToday() };
}

async function figuresToShow(familyId: AppFamilyId, o: { timeoutMs?: number }): Promise<Omit<FamilyMoney, "today">> {
  // The family's customer is found through its own link on each load, never carried from one to the next; the
  // customers whose invoices may show are those of that customer (mayShow checks every stored invoice against them).
  // A family with no active record has no figures to show (its name is still the cache's, as before); one with no link
  // has neither. An active family the portal can tell has no link (familyLinkState(): `none`, told from `unknown` by the
  // roster's company and the connection, never by the lookup's silence alone) is `notConnected`, decided before the
  // shape is asked about: with no link there are no invoices of its own whatever the shape. Nothing is read from
  // QuickBooks and nothing is written for it.
  const load = async () => {
    const [active, link, holds] = await Promise.all([activeFamilyOf(familyId), familyLinkState(familyId), shapeHolds()]);
    if (link.state !== "linked") return { shows: false, notConnected: active !== null && link.state === "none", row: undefined, source: null, family: null, familyName: null };
    if (!holds) return { shows: false, notConnected: false, row: undefined, source: null, family: null, familyName: null };
    const [source, family] = await Promise.all([getRosterSource(), familyCustomers(link.customerId)]);
    const row = active === null ? undefined : await storedRow(familyId);
    return { shows: active !== null, notConnected: false, row, source, family, familyName: family?.familyName ?? null };
  };
  const [stored, settings] = await Promise.all([load(), getMoneySettings()]);
  const answer = (from: { familyName: string | null; notConnected: boolean }, figures: MoneyFigures | null) =>
    ({ familyName: from.familyName, figures, notConnected: from.notConnected });
  if (!stored.shows) return answer(stored, null);
  if (isFresh(stored.row, stored.source, stored.family, settings.freshSeconds)) return answer(stored, figuresOf(stored.row, stored.source, stored.family, true));
  if (failedJustNow(stored.row)) return answer(stored, figuresOf(stored.row, stored.source, stored.family, false));
  const current = await readOnce(familyId, o.timeoutMs ?? CALL_TIMEOUT_MS);
  // Everything is read again: the roster cache may have been replaced while QuickBooks was answering.
  const after = await load();
  if (!after.shows) return answer(after, null);
  return answer(after, figuresOf(after.row, after.source, after.family, current));
}
