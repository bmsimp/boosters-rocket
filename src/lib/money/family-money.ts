// Parent-facing: everything here takes one family's id, which the caller takes from the session (ctx.familyQboId), and
// returns that family's money alone. Nothing in a request ever chooses the customers: they are read from the roster
// cache for that family. This module is in the staff-only import scan (tests/integration/page-guards.test.ts).
import { eq, inArray, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { familyMoney, qboConnection, qboCustomer, type StoredInvoice } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { isQboId, qboCustomerById, qboInvoices, type QboGetOptions } from "@/lib/quickbooks/client";
import { QboError } from "@/lib/quickbooks/endpoints";
import { getShape } from "@/lib/roster/shape";
import { getRosterSource } from "@/lib/roster/source";
import { toCents } from "./cents";
import { openInvoices, paidInvoices, shownInvoices, utcDay } from "./invoices";
import { safePayLink } from "./pay-link";
import { getMoneySettings } from "./settings";

/** How long one request to QuickBooks may take during a page load, and (at one and a half times that) the whole read. */
const CALL_TIMEOUT_MS = 4_000;
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

type Row = typeof familyMoney.$inferSelect;

export type MoneyFigures = {
  /** When QuickBooks gave these figures (ISO). */
  asOf: string;
  /** False when QuickBooks couldn't be asked just now: these are the last figures it gave, and paying is switched off. */
  current: boolean;
  /** The sum of the open invoices. Not shown as one figure when `currency` is null (invoices in more than one currency). */
  totalCents: number;
  currency: string | null;
  open: StoredInvoice[];
  paid: StoredInvoice[];
  /** QuickBooks' own balance for the family is lower than the invoices add up to: a credit or an unapplied payment. */
  credit: boolean;
};
/** `figures` is null when there is nothing to show: no successful read yet for this family in the connected company. */
export type FamilyMoney = { familyName: string | null; figures: MoneyFigures | null };

type FamilyCustomers = {
  familyName: string;
  /** The customers whose invoices are the family's, each with the name to show beside its invoices (null for the family itself). */
  customers: Map<string, string | null>;
  /** The cache holds a customer directly under the family that is not one of those. */
  othersUnder: boolean;
};

/**
 * Whose invoices are a family's (v1 spec §8.2). Layered: the family customer and its active direct sub-customers of the
 * student or the parent type. A sub-customer of the family type is another family and is never included. Flat: the
 * member's own customer. Null when the cache doesn't hold this id as a family.
 */
async function familyCustomers(familyQboId: string, tx?: Tx): Promise<FamilyCustomers | null> {
  const shape = await getShape(tx);
  if (!shape) return null;
  const rows = await (tx ?? db).select({ qboId: qboCustomer.qboId, name: qboCustomer.displayName, active: qboCustomer.active, parentQboId: qboCustomer.parentQboId, typeQboId: qboCustomer.typeQboId })
    .from(qboCustomer).where(or(eq(qboCustomer.qboId, familyQboId), eq(qboCustomer.parentQboId, familyQboId)));
  const family = rows.find((r) => r.qboId === familyQboId);
  if (!family || family.typeQboId === null) return null;
  const customers = new Map<string, string | null>([[family.qboId, null]]);
  const under = rows.filter((r) => r.qboId !== familyQboId && r.parentQboId === familyQboId);
  if (shape.kind === "flat") return shape.memberTypeIds.includes(family.typeQboId) ? { familyName: family.name, customers, othersUnder: under.length > 0 } : null;
  if (family.typeQboId !== shape.familyTypeId) return null;
  const included = [shape.studentTypeId, shape.parentTypeId].filter((t): t is string => t !== null);
  for (const r of under) {
    if (r.active && r.typeQboId !== null && included.includes(r.typeQboId)) customers.set(r.qboId, r.name);
  }
  return { familyName: family.name, customers, othersUnder: under.length > customers.size - 1 };
}

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

/** The stored figures, unless they came from another QuickBooks company than the roster cache: those are treated as absent. */
function figuresOf(row: Row | undefined, source: string | null, current: boolean): MoneyFigures | null {
  if (!row?.readAt || !row.invoices || row.totalCents === null || row.realmId === null || row.realmId !== source) return null;
  // A stored link is checked again on its way out: the page never trusts the table to hold only good ones.
  const invoices = row.invoices.map((i) => ({ ...i, payLink: safePayLink(i.payLink) }));
  return {
    asOf: row.readAt.toISOString(), current, totalCents: row.totalCents, currency: row.currency,
    open: openInvoices(invoices), paid: paidInvoices(invoices),
    credit: row.currency !== null && row.balanceWithJobsCents !== null && row.balanceWithJobsCents < row.totalCents,
  };
}

const isFresh = (row: Row | undefined, source: string | null, freshSeconds: number): boolean =>
  Boolean(row?.readAt && row.realmId !== null && row.realmId === source && Date.now() - row.readAt.getTime() < freshSeconds * 1000);
const failedJustNow = (row: Row | undefined): boolean =>
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

type Read =
  | { ok: true; realmId: string; invoices: StoredInvoice[]; totalCents: number; currency: string | null; balanceWithJobsCents: number | null }
  | { ok: false; code: string };

/** One read of a family's invoices from QuickBooks, refused before anything is asked unless it is certain to be the right company. */
async function readFromQuickBooks(familyQboId: string, tx: Tx, timeoutMs: number): Promise<Read> {
  const fail = (code: string): Read => ({ ok: false, code });
  // Never the wrong company: QuickBooks is connected, and to the company the roster cache (and so this family's
  // customer ids) was read from. Every request then checks the company again as it is sent (`realmId`).
  const [connection] = await tx.select({ realmId: qboConnection.realmId, refresh: qboConnection.refreshTokenCiphertext }).from(qboConnection);
  if (!connection?.realmId || !connection.refresh) return fail("not_connected");
  const realmId = await getRosterSource(tx);
  if (realmId === null || realmId !== connection.realmId) return fail("other_company");
  const family = await familyCustomers(familyQboId, tx);
  if (!family) return fail("not_a_family");
  const ids = [...family.customers.keys()];
  if (!ids.every(isQboId)) return fail("bad_id");
  const comparable = await balanceCoversTheSame(familyQboId, family, tx);
  const o: QboGetOptions = { timeoutMs, signal: AbortSignal.timeout(timeoutMs * 1.5), retry: true, failFast: true, realmId };
  try {
    const shown = shownInvoices(await qboInvoices(ids, o), family.customers, utcDay());
    if (!shown) return fail("bad_answer");
    // QuickBooks' own balance, as a cross-check only (v1 spec §8.3): the figure a parent sees never waits on it. It is
    // not asked for when it would count customers the total leaves out: there is then nothing to compare it with.
    let balanceWithJobsCents: number | null = null;
    if (comparable) {
      try { balanceWithJobsCents = toCents((await qboCustomerById(familyQboId, o))?.BalanceWithJobs); } catch (e) { if (!(e instanceof QboError)) throw e; }
    }
    return { ok: true, realmId, ...shown, balanceWithJobsCents };
  } catch (e) {
    // Only a QboError's own short code is kept; anything else (an answer that wasn't the shape expected) gets a fixed one.
    return fail(e instanceof QboError ? e.code : "unexpected");
  }
}

/**
 * Asks QuickBooks for one family's figures and keeps them. True when the stored figures are now current. The row's
 * figures are replaced only by a successful read; a failed try records its time and short code and leaves them alone.
 *
 * A per-family advisory lock is held from before QuickBooks is asked until the row is saved, so two requests for one
 * family (in two processes) never both go to QuickBooks: the second finds the lock taken and shows what is there.
 */
async function liveRead(familyQboId: string, timeoutMs: number): Promise<boolean> {
  if (!(await takePlace())) return false;
  try {
    return await db.transaction(async (tx) => {
      const [lock] = (await tx.execute(sql`select pg_try_advisory_xact_lock(${sql.raw(String(MONEY_LOCK))}, hashtext(${familyQboId}::text)) as locked`)) as unknown as { locked: boolean }[];
      if (!lock?.locked) return false;
      const [before] = await tx.select().from(familyMoney).where(eq(familyMoney.familyQboId, familyQboId));
      // Whoever held the lock a moment ago may have just read it, or just failed to.
      if (isFresh(before, await getRosterSource(tx), (await getMoneySettings(tx)).freshSeconds)) return true;
      if (failedJustNow(before)) return false;
      const read = await readFromQuickBooks(familyQboId, tx, timeoutMs);
      const now = new Date();
      // The company the cache belongs to changed while QuickBooks was answering: these figures are the old company's.
      const outcome: Read = read.ok && (await getRosterSource(tx)) !== read.realmId ? { ok: false, code: "other_company" } : read;
      if (!outcome.ok) {
        const failed = { failedAt: now, failedCode: outcome.code.slice(0, 40), updatedAt: now };
        await tx.insert(familyMoney).values({ familyQboId, ...failed }).onConflictDoUpdate({ target: familyMoney.familyQboId, set: failed });
        return false;
      }
      // The cross-check (v1 spec §8.3): a difference is recorded for staff, once per family per day at most.
      const differs = outcome.currency !== null && outcome.balanceWithJobsCents !== null && outcome.balanceWithJobsCents !== outcome.totalCents;
      const auditedToday = before?.mismatchAuditedAt != null && utcDay(before.mismatchAuditedAt) === utcDay(now);
      const figures = {
        realmId: outcome.realmId, readAt: now, invoices: outcome.invoices, totalCents: outcome.totalCents, currency: outcome.currency,
        balanceWithJobsCents: outcome.balanceWithJobsCents, updatedAt: now, ...(differs && !auditedToday ? { mismatchAuditedAt: now } : {}),
      };
      await tx.insert(familyMoney).values({ familyQboId, ...figures }).onConflictDoUpdate({ target: familyMoney.familyQboId, set: figures });
      if (differs && !auditedToday) {
        await writeAudit({ actor: MONEY_ACTOR, action: "money.balance_mismatch", targetType: "family", targetId: familyQboId,
          after: { invoicesCents: outcome.totalCents, balanceWithJobsCents: outcome.balanceWithJobsCents, currency: outcome.currency } }, tx);
      }
      return true;
    });
  } finally {
    givePlace();
  }
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
 * stored there is nothing to show. Figures from another QuickBooks company are never shown.
 */
export async function loadFamilyMoney(familyQboId: string, o: { timeoutMs?: number } = {}): Promise<FamilyMoney> {
  const load = async () => {
    const [[row], source] = await Promise.all([db.select().from(familyMoney).where(eq(familyMoney.familyQboId, familyQboId)), getRosterSource()]);
    return { row, source };
  };
  const [stored, settings, family] = await Promise.all([load(), getMoneySettings(), familyCustomers(familyQboId)]);
  const familyName = family?.familyName ?? null;
  if (isFresh(stored.row, stored.source, settings.freshSeconds)) return { familyName, figures: figuresOf(stored.row, stored.source, true) };
  if (failedJustNow(stored.row)) return { familyName, figures: figuresOf(stored.row, stored.source, false) };
  const current = await readOnce(familyQboId, o.timeoutMs ?? CALL_TIMEOUT_MS);
  const after = await load();
  return { familyName, figures: figuresOf(after.row, after.source, current) };
}
