// Parent-facing: everything here takes one family's id, which the caller takes from the session (ctx.familyQboId), and
// returns that family's money alone. Nothing in a request ever chooses the customers: they are read from the roster
// cache for that family. This module is in the staff-only import scan (tests/integration/page-guards.test.ts).
import { eq, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { familyMoney, qboConnection, qboCustomer, type CustomerCheck, type StoredInvoice } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { isQboId, qboCustomerById, qboInvoices, type QboGetOptions } from "@/lib/quickbooks/client";
import { QboError } from "@/lib/quickbooks/endpoints";
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
/** First key of the per-family advisory lock; the second is a hash of the family's id. */
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
 * `today` is the club's own date (YYYY-MM-DD, clubToday()): the day each due date is said against ("in 8 days", "Was due").
 */
export type FamilyMoney = { familyName: string | null; figures: MoneyFigures | null; today: string };

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
async function readAndKeep(tx: Tx, familyQboId: string, before: MoneyRow | undefined, family: FamilyCustomers | null, how: ReadHow): Promise<ReadOutcome> {
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
    await tx.insert(familyMoney).values({ familyQboId, ...failed }).onConflictDoUpdate({ target: familyMoney.familyQboId, set: failed });
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
  await tx.insert(familyMoney).values({ familyQboId, ...figures }).onConflictDoUpdate({ target: familyMoney.familyQboId, set: figures });
  if (differs && !auditedToday) {
    await writeAudit({ actor: MONEY_ACTOR, action: "money.balance_mismatch", targetType: "family", targetId: familyQboId,
      after: { invoicesCents: outcome.totalCents, balanceWithJobsCents: outcome.balanceWithJobsCents, currency: outcome.currency, ...(customers.length ? { customers } : {}) } }, tx);
  }
  return { ok: true };
}

/** The two keys of the family's advisory lock. */
const familyLock = (familyQboId: string) => sql`${sql.raw(String(MONEY_LOCK))}, hashtext(${familyQboId}::text)`;

/**
 * Asks QuickBooks for one family's figures, for a page load, and keeps them. True when the stored figures are now
 * current.
 *
 * A per-family advisory lock is held from before QuickBooks is asked until the row is saved, so two requests for one
 * family (in two processes) never both go to QuickBooks: the second finds the lock taken and shows what is there.
 */
async function liveRead(familyQboId: string, timeoutMs: number): Promise<boolean> {
  if (!(await takePlace())) return false;
  try {
    return await db.transaction(async (tx) => {
      const [lock] = (await tx.execute(sql`select pg_try_advisory_xact_lock(${familyLock(familyQboId)}) as locked`)) as unknown as { locked: boolean }[];
      if (!lock?.locked) return false;
      const [before] = await tx.select().from(familyMoney).where(eq(familyMoney.familyQboId, familyQboId));
      const family = await familyCustomers(familyQboId, tx);
      // Whoever held the lock a moment ago may have just read it, or just failed to.
      if (isFresh(before, await getRosterSource(tx), family, (await getMoneySettings(tx)).freshSeconds)) return true;
      if (failedJustNow(before)) return false;
      return (await readAndKeep(tx, familyQboId, before, family, { kind: "page", timeoutMs })).ok;
    });
  } finally {
    givePlace();
  }
}

/**
 * One family read from QuickBooks for the worker's run over every family (./sweep.ts), however fresh its figures are,
 * with the customer-by-customer check. It waits its turn for the family's lock (a page load holding it finishes first)
 * and may wait for the connection row; it takes none of the places kept for page loads. A failure's code is its own
 * short code, by which the run decides whether to carry on.
 */
export async function readFamilyForRun(familyQboId: string, o: { pace: () => Promise<void>; timeoutMs?: number }): Promise<ReadOutcome> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${familyLock(familyQboId)})`);
    const [before] = await tx.select().from(familyMoney).where(eq(familyMoney.familyQboId, familyQboId));
    return readAndKeep(tx, familyQboId, before, await familyCustomers(familyQboId, tx), { kind: "run", timeoutMs: o.timeoutMs ?? RUN_CALL_TIMEOUT_MS, pace: o.pace });
  });
}

/** Two page loads for one family in this process share one read: the second waits for the first and shows what it brought. */
const reading = new Map<string, Promise<boolean>>();
function readOnce(familyQboId: string, timeoutMs: number): Promise<boolean> {
  let read = reading.get(familyQboId);
  if (!read) {
    read = liveRead(familyQboId, timeoutMs).finally(() => reading.delete(familyQboId));
    reading.set(familyQboId, read);
  }
  return read;
}

/**
 * What one family owes, for its own parents (v1 spec §8.2). `familyQboId` is ctx.familyQboId from the session.
 *
 * Fresh stored figures are shown at once. Older ones (or none) mean one read from QuickBooks first, with a short
 * timeout; if that can't be done, the last figures QuickBooks gave are shown marked as not current, and with none
 * stored there is nothing to show. Figures from another QuickBooks company are never shown, nor figures that hold an
 * invoice of a customer who is no longer this family's (mayShow), and nothing is shown for an id the roster cache does
 * not hold as an active family.
 */
export async function loadFamilyMoney(familyQboId: string, o: { timeoutMs?: number } = {}): Promise<FamilyMoney> {
  const shown = await figuresToShow(familyQboId, o);
  // The club's day as the page is drawn, after any wait for QuickBooks.
  return { ...shown, today: await clubToday() };
}

async function figuresToShow(familyQboId: string, o: { timeoutMs?: number }): Promise<Omit<FamilyMoney, "today">> {
  const load = async () => {
    const [[row], source, family] = await Promise.all([db.select().from(familyMoney).where(eq(familyMoney.familyQboId, familyQboId)), getRosterSource(), familyCustomers(familyQboId)]);
    return { row, source, family, familyName: family?.familyName ?? null };
  };
  const [stored, settings] = await Promise.all([load(), getMoneySettings()]);
  if (isFresh(stored.row, stored.source, stored.family, settings.freshSeconds)) return { familyName: stored.familyName, figures: figuresOf(stored.row, stored.source, stored.family, true) };
  if (failedJustNow(stored.row)) return { familyName: stored.familyName, figures: figuresOf(stored.row, stored.source, stored.family, false) };
  const current = await readOnce(familyQboId, o.timeoutMs ?? CALL_TIMEOUT_MS);
  // Everything is read again: the roster cache may have been replaced while QuickBooks was answering.
  const after = await load();
  return { familyName: after.familyName, figures: figuresOf(after.row, after.source, after.family, current) };
}
