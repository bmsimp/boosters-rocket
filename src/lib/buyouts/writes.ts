// The only invoices the portal ever creates and voids: volunteer buy-outs (v1 spec §11.5). It is the only module that
// may name the client's two invoice writes (tests/unit/quickbooks-writes.test.ts). A guardian's choice reaches
// QuickBooks through confirmMyBuyout() and switchMyBuyoutBack(), called only from the parent's own actions
// (src/app/(parent)/volunteer/pay-instead/actions.ts); every write goes on the write queue first and is tried once at
// once, then by the worker's queue job (src/lib/roster/queue.ts), through sendBuyoutWrite(). The family is the
// session's (ctx.familyId): the requirement and the subject are found within it (./my-buyouts.ts), the customer billed
// is the family's own linked customer or its student's, under it in the roster cache, and nothing the browser sends names a customer, an item or an amount. It imports
// no staff-only module (tests/integration/page-guards.test.ts scans this file).
import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { buyout, familyMoney, qboCustomer, requirement, writeQueue, type BuyoutState, type BuyoutWrite, type QueuedWrite } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { customerOfFamily, customerOfStudent, familyLinkedTo } from "@/lib/families/links";
import { activeFamilyOf, studentsStillIn } from "@/lib/families/session-family";
import type { ParentCtx } from "@/lib/guards";
import { formatMoney, toCents } from "@/lib/money/cents";
import { takeRateLimit } from "@/lib/parents/rate-limit";
import { parentActor } from "@/lib/parents/sessions";
import { INVOICE_WRITES, isQboId, qboCreateInvoice, qboInvoices, qboVoidInvoice, WORKER_ACTOR } from "@/lib/quickbooks/client";
import { errorNeedsAdmin, QboError } from "@/lib/quickbooks/endpoints";
import { getConnection } from "@/lib/quickbooks/connection";
import { afterFailedTry, classify } from "@/lib/roster/write-rules";
import { ROSTER_LOCK, shapeHolds } from "@/lib/roster/shape";
import { getRosterSource } from "@/lib/roster/source";
import { isUuid } from "@/lib/seasons/ids";
import { ROSTER_BUSY, takePlace } from "@/lib/volunteer/my-volunteer";
import { findMyBuyout, isChoiceKey } from "./my-buyouts";
import { buyoutRecords } from "./standing";

const SEND_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 8_000;
/** How long the try made at once holds a new item before the worker may take it: longer than one try takes. */
const LEASE_MS = 5 * 60_000;

export type Result = { ok: true; message: string } | { ok: false; errors: string[] };
const no = (...errors: string[]): Result => ({ ok: false, errors });
/** A stamp as a page is given one (quoteStamp(), subjectStamp()): a short string, checked before anything is read. */
const isStamp = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;

/** What a guardian is told. Calm about money, and the same whatever the cause: never that QuickBooks is down. */
export const BUYOUT_COPY = {
  notFromPage: "That didn't go through. Reload the page and try again.",
  notSetUp: "Your family isn't set up in the portal yet. Please ask the club.",
  rateLimited: "That's a lot of tries in a short time. Please wait a few minutes and try again.",
  changed: (amount: string) => `The amount is now ${amount}: it has changed since the page was shown, so nothing was set up. Look it over, and confirm again if you'd still like to pay instead.`,
  notOffered: "Paying instead isn't offered for this any more, so nothing was set up.",
  met: "This is done already, so there's nothing to pay. Thank you!",
  already: "Paying instead is already set up for this. Reload the page to see where it stands.",
  cantNow: "Paying instead can't be set up just now, so nothing was billed. Please try again later, or ask the club.",
  done: (amount: string) => `Done. An invoice from the club for ${amount} will be on your Payments page, with a Pay button.`,
  waiting: (amount: string) => `Thank you. Your invoice for ${amount} is being set up, and will be on your Payments page soon.`,
  refused: "Sorry, the club's invoice couldn't be set up, so nothing has been billed. Please ask the club about paying instead.",
  nothingToSwitch: "There's no buy-out to switch back from. Reload the page to see where it stands.",
  stillMaking: "Your invoice is still being set up. Once it's on your Payments page, you can switch back here.",
  beingCancelled: "Your invoice is already being cancelled.",
  waitingForClub: "Your buy-out is waiting for the club to look at it, so it can't be changed here. Please ask the club.",
  paidSome: "A payment has been made on this invoice, so the portal can't cancel it. The club's treasurer can sort it out in QuickBooks: please get in touch with them.",
  invoiceGone: "We can't find this invoice in the club's books any more, so nothing was changed here. Please ask the club about it.",
  clubLooks: "The club needs to look at this invoice, so nothing was changed. Please ask the club about it.",
  cantCheck: "We couldn't check your invoice just now, so nothing was changed. Please try again in a few minutes.",
  switching: "Done. Your invoice is being cancelled, so you don't need to pay it: it leaves your Payments page once it is. You can sign up for shifts now.",
  switched: "Done. The invoice is cancelled, and nothing is owed for it. You can sign up for shifts now.",
} as const;

type Item = typeof writeQueue.$inferSelect;
type Row = typeof buyout.$inferSelect;
/** How one try of a queued buy-out write ended. `kept`: a void the portal would not send, because something was paid or the invoice is gone. */
export type BuyoutStep = "done" | "waiting" | "stuck" | "refused" | "kept";

export const isBuyoutWrite = (w: QueuedWrite): w is BuyoutWrite => w.op === "invoice_create" || w.op === "invoice_void";

/** An invoice as the portal reads one back: its id, version, customer, amounts in cents, and its private note. */
type Invoice = { qboId: string; syncToken: string | null; customerQboId: string | null; totalCents: number; balanceCents: number; note: string };
function invoiceOf(raw: Record<string, unknown>): Invoice | null {
  const qboId = typeof raw.Id === "string" && isQboId(raw.Id) ? raw.Id : null;
  const syncToken = typeof raw.SyncToken === "string" && /^\d{1,20}$/.test(raw.SyncToken) ? raw.SyncToken : null;
  const totalCents = toCents(raw.TotalAmt), balanceCents = toCents(raw.Balance);
  if (qboId === null || totalCents === null || balanceCents === null) return null;
  const customer = (raw.CustomerRef as { value?: unknown } | null | undefined)?.value;
  return { qboId, syncToken, customerQboId: typeof customer === "string" ? customer : null, totalCents, balanceCents, note: typeof raw.PrivateNote === "string" ? raw.PrivateNote : "" };
}
/** Whether an invoice is this buy-out's: its private note carries the buy-out's id (INVOICE_WRITES.create). */
const carries = (i: Invoice, buyoutId: string) => i.note.includes(`${INVOICE_WRITES.notePrefix}${buyoutId}`);

/**
 * One customer's invoices, read strictly through the existing reader (qboInvoices). A guardian waiting on a page never
 * waits for the connection row (`failFast`); the worker may. Throws the reader's QboError.
 */
async function invoicesOf(customerQboId: string, realmId: string, mayWait: boolean): Promise<Invoice[]> {
  const raw = await qboInvoices([customerQboId], { realmId, retry: true, timeoutMs: READ_TIMEOUT_MS, signal: AbortSignal.timeout(READ_TIMEOUT_MS * 2), ...(mayWait ? {} : { failFast: true }) });
  return raw.map(invoiceOf).filter((i): i is Invoice => i !== null);
}

/**
 * Whether a buy-out's invoice still stands in QuickBooks, read live for a staff member who asked to close it (./close.ts)
 * on a flag from stored figures alone: `gone` when the customer's invoices, read strictly, hold it no more or hold it
 * voided (nothing owed), `stands` when they hold it with an amount, `unreadable` when QuickBooks couldn't be read. A
 * read only, never waiting for the connection row: the staff member is waiting.
 */
export async function invoiceStandsLive(b: Pick<Row, "customerQboId" | "invoiceQboId" | "realmId">): Promise<"gone" | "stands" | "unreadable"> {
  if (!b.invoiceQboId || !isQboId(b.customerQboId)) return "unreadable";
  let invoices: Invoice[];
  try { invoices = await invoicesOf(b.customerQboId, b.realmId, false); } catch (e) {
    if (e instanceof QboError) return "unreadable";
    throw e;
  }
  const inv = invoices.find((i) => i.qboId === b.invoiceQboId);
  return !inv || inv.totalCents === 0 ? "gone" : "stands";
}

const sendOptions = (realmId: string, mayWait: boolean) => ({ realmId, mayWait, timeoutMs: SEND_TIMEOUT_MS, signal: AbortSignal.timeout(SEND_TIMEOUT_MS * 1.5) });
const short = (code: string) => code.slice(0, 40);

/** The family's stored figures are behind QuickBooks now: its next page load reads QuickBooks (src/lib/money/family-money.ts). */
async function markMoneyStale(tx: Tx, familyId: AppFamilyId): Promise<void> {
  await tx.update(familyMoney).set({ staleAt: new Date(), updatedAt: new Date() }).where(eq(familyMoney.familyId, familyId));
}

/**
 * Every family whose figures may show this buy-out's invoice: the one that chose it (its own record), and for a
 * per-student one the family its student is under now in the roster cache, through that customer's family link (a
 * student who moved takes their invoices with them, and a move QuickBooks made is followed here before the records' step
 * has caught up with it).
 */
export async function markBuyoutMoneyStale(tx: Tx, b: Pick<Row, "familyId" | "studentId" | "customerQboId">): Promise<void> {
  await markMoneyStale(tx, b.familyId);
  if (b.studentId === null) return;
  const [now] = await tx.select({ parentQboId: qboCustomer.parentQboId }).from(qboCustomer).where(eq(qboCustomer.qboId, b.customerQboId));
  if (!now?.parentQboId) return;
  const underNow = await familyLinkedTo(now.parentQboId, tx);
  if (underNow !== null && underNow !== b.familyId) await markMoneyStale(tx, underNow);
}

/** The queue item finished: done, with what QuickBooks made or changed, audited as the queue audits its own. */
async function itemDone(tx: Tx, item: Item, how: "sent" | "found", resultQboId: string | null, actor: Actor): Promise<void> {
  const [still] = await tx.update(writeQueue).set({ state: "done", resultQboId, tries: item.tries + 1, lastTriedAt: new Date(), nextTryAt: null, finishedAt: new Date(), updatedAt: new Date() })
    .where(eq(writeQueue.id, item.id)).returning({ id: writeQueue.id });
  if (!still) return;
  await writeAudit({ actor, action: "roster.write.done", targetType: "write_queue", targetId: item.id,
    before: { state: item.state, tries: item.tries }, after: { state: "done", how, tries: item.tries + 1, op: item.request.op, ...(resultQboId ? { resultQboId } : {}) } }, tx);
}
/** The queue item closed without being sent again: QuickBooks refused it, or the portal would not send it. */
async function itemClosed(tx: Tx, item: Item, code: string): Promise<void> {
  await tx.update(writeQueue).set({ state: "given_up", lastCode: short(code), tries: item.tries + 1, lastTriedAt: new Date(), nextTryAt: null, finishedAt: new Date(), updatedAt: new Date() })
    .where(eq(writeQueue.id, item.id));
}

/**
 * A try that may go through later: the item waits for its next try (afterFailedTry: 1, 5, 15 and 60 minutes, then every
 * 6 hours), or is stuck once it is old or tried often; a stuck one's buy-out is stuck too, for staff to look at.
 * `sent` is kept once set: a write QuickBooks may have acted on is looked for before it is sent again.
 */
async function tryFailed(item: Item, b: Row, code: string, sent: boolean, now: Date, actor: Actor): Promise<BuyoutStep> {
  const next = afterFailedTry(item.tries + 1, item.createdAt, now);
  await db.transaction(async (tx) => {
    const [still] = await tx.update(writeQueue).set({ state: next.state, lastCode: short(code), sent, tries: item.tries + 1, lastTriedAt: now,
      nextTryAt: next.state === "waiting" ? next.nextTryAt : null, updatedAt: new Date() }).where(eq(writeQueue.id, item.id)).returning({ id: writeQueue.id });
    if (!still) return;
    await writeAudit({ actor, action: next.state === "stuck" ? "roster.write.stuck" : "roster.write.retry", targetType: "write_queue", targetId: item.id,
      before: { state: item.state, tries: item.tries, code: item.lastCode }, after: { state: next.state, tries: item.tries + 1, code: short(code), sent, op: item.request.op } }, tx);
    await tx.update(buyout).set({ lastCode: short(code), ...(next.state === "stuck" ? { state: "stuck" as const } : {}), updatedAt: new Date() }).where(eq(buyout.id, b.id));
    if (next.state === "stuck") {
      await writeAudit({ actor, action: "volunteer.buyout.stuck", targetType: "buyout", targetId: b.id, before: { state: b.state }, after: { state: "stuck", code: short(code), queueId: item.id } }, tx);
    }
  });
  return next.state;
}

/** The invoice is made: the buy-out is invoiced, the item done, the family's figures marked behind, all in one transaction. */
async function created(item: Item, w: Extract<BuyoutWrite, { op: "invoice_create" }>, b: Row, inv: Invoice, how: "sent" | "found", actor: Actor): Promise<BuyoutStep> {
  let movedMeanwhile = false;
  await db.transaction(async (tx) => {
    const elsewhere = inv.customerQboId !== w.customerQboId;
    const [made] = await tx.update(buyout).set({ state: "invoiced", invoiceQboId: inv.qboId, invoiceSyncToken: inv.syncToken, lastCode: null, updatedAt: new Date(),
      ...(elsewhere ? { flag: "other_customer" as const, flaggedAt: new Date() } : {}) })
      .where(and(eq(buyout.id, b.id), inArray(buyout.state, ["being_invoiced", "stuck"]))).returning();
    await itemDone(tx, item, how, inv.qboId, actor);
    if (!made) return;
    await markBuyoutMoneyStale(tx, b);
    await writeAudit({ actor, action: "volunteer.buyout.invoiced", targetType: "buyout", targetId: b.id,
      before: { state: b.state }, after: { state: "invoiced", invoiceQboId: inv.qboId, customerQboId: inv.customerQboId, amountCents: b.amountCents, how, queueId: item.id, ...(elsewhere ? { flag: "other_customer" } : {}) } }, tx);
    // The student moved to another family while the invoice was being made: the old family's choice is not left billed.
    if (made.flag === "student_moved") { await queueVoid(tx, made, "student_moved", { actor, label: "student moved", nextTryAt: new Date() }); movedMeanwhile = true; }
  });
  return movedMeanwhile ? "waiting" : "done";
}

/** The invoice is voided: the buy-out ends, the item is done, the family's figures marked behind. */
async function voided(item: Item, w: Extract<BuyoutWrite, { op: "invoice_void" }>, b: Row, how: "sent" | "found", actor: Actor): Promise<BuyoutStep> {
  await db.transaction(async (tx) => {
    const [ended] = await tx.update(buyout).set({ state: "voided", endReason: w.why, lastCode: null, updatedAt: new Date() })
      .where(and(eq(buyout.id, b.id), inArray(buyout.state, ["being_voided", "stuck"]))).returning({ id: buyout.id });
    await itemDone(tx, item, how, w.invoiceQboId, actor);
    if (!ended) return;
    await markBuyoutMoneyStale(tx, b);
    await writeAudit({ actor, action: "volunteer.buyout.voided", targetType: "buyout", targetId: b.id,
      before: { state: b.state, invoiceQboId: w.invoiceQboId, amountCents: b.amountCents }, after: { state: "voided", why: w.why, how, queueId: item.id } }, tx);
  });
  return "done";
}

/** QuickBooks refused the invoice: not queued. The buy-out is refused, which the guardian reads calmly and staff see on Reconciliation. */
async function createRefused(item: Item, b: Row, code: string, actor: Actor): Promise<BuyoutStep> {
  await db.transaction(async (tx) => {
    await itemClosed(tx, item, code);
    const [ended] = await tx.update(buyout).set({ state: "refused", lastCode: short(code), updatedAt: new Date() })
      .where(and(eq(buyout.id, b.id), inArray(buyout.state, ["being_invoiced", "stuck"]))).returning({ id: buyout.id });
    if (!ended) return;
    await writeAudit({ actor, action: "volunteer.buyout.refused", targetType: "buyout", targetId: b.id, before: { state: b.state }, after: { state: "refused", code: short(code), queueId: item.id } }, tx);
  });
  return "refused";
}

/**
 * A void the portal would not send, or QuickBooks refused: something was paid on the invoice, it is gone from the
 * customer's invoices, or QuickBooks said no. The invoice is left as it is, the buy-out goes back to where it stands
 * (`state`), and it is flagged for the treasurer, who sorts it out in QuickBooks.
 */
async function voidKept(item: Item, b: Row, to: { state: BuyoutState; flag: NonNullable<Row["flag"]>; code: string }, actor: Actor): Promise<BuyoutStep> {
  await db.transaction(async (tx) => {
    await itemClosed(tx, item, to.code);
    const [kept] = await tx.update(buyout).set({ state: to.state, flag: to.flag, flaggedAt: new Date(), lastCode: short(to.code), updatedAt: new Date() })
      .where(and(eq(buyout.id, b.id), inArray(buyout.state, ["being_voided", "stuck"]))).returning({ id: buyout.id });
    if (!kept) return;
    await writeAudit({ actor, action: "volunteer.buyout.kept", targetType: "buyout", targetId: b.id,
      before: { state: b.state }, after: { state: to.state, flag: to.flag, code: short(to.code), queueId: item.id } }, tx);
  });
  return "kept";
}

/**
 * One try of a queued buy-out write: the worker's queue job (`mayWait`) and the try made at once when a guardian asks.
 *
 * The create: one QuickBooks may already have made (`sent`: a timeout, a 5xx, unreachable) is never simply sent again.
 * That customer's invoices are read first, strictly, and one carrying the buy-out's id in its private note is taken as
 * made; otherwise it is sent again. What QuickBooks refuses is not queued: the buy-out is refused.
 *
 * The void: the invoice is read live before every send, and voided only when nothing has been paid on it (its balance
 * is its total), from the version just read. One already voided (a total of 0) is taken as done; one with anything
 * paid, or gone from the customer's invoices, is never voided by the portal: it is flagged for the treasurer.
 */
export async function sendBuyoutWrite(item: Item, now: Date, o: { mayWait: boolean; actor?: Actor }): Promise<BuyoutStep> {
  const w = item.request;
  if (!isBuyoutWrite(w)) throw new Error("sendBuyoutWrite: not a buy-out write");
  const actor = o.actor ?? WORKER_ACTOR;
  const [b] = await db.select().from(buyout).where(eq(buyout.id, w.buyoutId));
  if (!b) {
    // Its buy-out was deleted with the rest of another company's records: nothing is sent for it.
    await db.transaction((tx) => itemClosed(tx, item, "gone"));
    return "refused";
  }
  if (w.op === "invoice_create") {
    if (item.sent) {
      let found: Invoice | undefined;
      try { found = (await invoicesOf(w.customerQboId, item.realmId, o.mayWait)).find((i) => carries(i, b.id)); } catch (e) {
        if (!(e instanceof QboError)) throw e;
        return tryFailed(item, b, `check_${e.code}`, true, now, actor);
      }
      if (found) return created(item, w, b, found, "found", actor);
    }
    // Marked as maybe sent before it goes: a try cut off mid-send (a restart) leaves the item `sent`, so whoever takes
    // it next looks for the invoice by the buy-out's id before sending again. A failure that surely sent nothing puts it back.
    if (!item.sent) await db.update(writeQueue).set({ sent: true, updatedAt: new Date() }).where(eq(writeQueue.id, item.id));
    let answer: Record<string, unknown>;
    try {
      // The bill-to address is the one the queued create carries: the chooser's own, as it was when they chose.
      answer = await qboCreateInvoice({ customerQboId: w.customerQboId, itemQboId: w.itemQboId, units: w.units, unitCents: w.unitCents, buyoutId: b.id, billEmail: w.billEmail }, sendOptions(item.realmId, o.mayWait));
    } catch (e) {
      if (!(e instanceof QboError)) throw e;
      const f = classify(e.code);
      if (f.kind !== "retry") return createRefused(item, b, e.code, actor);
      return tryFailed(item, b, e.code, item.sent || f.sent, now, actor);
    }
    const inv = invoiceOf(answer);
    // An answer the portal can't read may still be an invoice made: it is looked for before anything is sent again.
    if (!inv) return tryFailed(item, b, "bad_answer", true, now, actor);
    return created(item, w, b, inv, "sent", actor);
  }
  let invoices: Invoice[];
  try { invoices = await invoicesOf(w.customerQboId, item.realmId, o.mayWait); } catch (e) {
    if (!(e instanceof QboError)) throw e;
    const f = classify(e.code);
    if (f.kind !== "retry") return voidKept(item, b, { state: "invoiced", flag: w.why === "student_moved" ? "student_moved" : "void_refused", code: e.code }, actor);
    return tryFailed(item, b, `check_${e.code}`, item.sent, now, actor);
  }
  const inv = invoices.find((i) => i.qboId === w.invoiceQboId);
  if (!inv) return voidKept(item, b, { state: "stuck", flag: w.why === "student_moved" ? "student_moved" : "missing", code: "invoice_gone" }, actor);
  if (inv.totalCents === 0) return voided(item, w, b, "found", actor);
  if (inv.balanceCents < inv.totalCents) {
    return voidKept(item, b, { state: inv.balanceCents <= 0 ? "paid" : "invoiced", flag: w.why === "student_moved" ? "student_moved" : "paid_before_void", code: "paid" }, actor);
  }
  // A void is sent from the version just read; an invoice read without one is read again at the next try.
  if (inv.syncToken === null) return tryFailed(item, b, "check_bad_answer", item.sent, now, actor);
  try {
    await qboVoidInvoice(inv.qboId, inv.syncToken, sendOptions(item.realmId, o.mayWait));
  } catch (e) {
    if (!(e instanceof QboError)) throw e;
    const f = classify(e.code);
    if (f.kind !== "retry") return voidKept(item, b, { state: "invoiced", flag: w.why === "student_moved" ? "student_moved" : "void_refused", code: e.code }, actor);
    return tryFailed(item, b, e.code, item.sent || f.sent, now, actor);
  }
  return voided(item, w, b, "sent", actor);
}

/**
 * A queue item for a buy-out write, in the transaction given, filed under the app's family that chose the buy-out
 * (`buyout.family_id`): never a family from the browser. `nextTryAt` in the future holds it for the try made at once.
 */
async function queueItem(tx: Tx, w: BuyoutWrite, o: { realmId: string; familyId: AppFamilyId; label: string | null; nextTryAt: Date }): Promise<Item> {
  const [item] = await tx.insert(writeQueue).values({
    realmId: o.realmId, request: w, targetQboId: null, familyId: o.familyId, studentId: null, sent: false, tries: 0, lastCode: null, nextTryAt: o.nextTryAt,
    askedBy: null, askedByLabel: o.label,
  }).returning();
  return item!;
}

/**
 * Puts the void of an invoiced buy-out on the queue, in the caller's transaction: the buy-out reads "being cancelled"
 * until it is voided. A student who moves (./moved.ts) and a guardian who switches back come here. The item is filed
 * under the buy-out's own family record, which every buy-out names, so a void is always queued for an invoiced one.
 * Null only when the buy-out is no longer invoiced (or has no invoice to void): nothing is queued and it is left as it is.
 */
export async function queueVoid(tx: Tx, b: Row, why: "switched_back" | "student_moved", o: { actor: Actor; label: string | null; nextTryAt: Date; ip?: string | null }): Promise<Item | null> {
  if (!b.invoiceQboId) return null;
  const [moving] = await tx.update(buyout).set({ state: "being_voided", updatedAt: new Date() }).where(and(eq(buyout.id, b.id), eq(buyout.state, "invoiced"))).returning({ id: buyout.id });
  if (!moving) return null;
  const item = await queueItem(tx, { op: "invoice_void", buyoutId: b.id, invoiceQboId: b.invoiceQboId, customerQboId: b.customerQboId, why },
    { realmId: b.realmId, familyId: b.familyId, label: o.label, nextTryAt: o.nextTryAt });
  await writeAudit({ actor: o.actor, action: why === "switched_back" ? "volunteer.buyout.switch_back" : "volunteer.buyout.moved", targetType: "buyout", targetId: b.id, ip: o.ip ?? null,
    before: { state: "invoiced", invoiceQboId: b.invoiceQboId, amountCents: b.amountCents }, after: { state: "being_voided", why, queueId: item.id } }, tx);
  return item;
}

/** Whether a Postgres error is a lock that wasn't free in time; Drizzle wraps the driver's error, so its cause is read too. */
const codeOf = (e: unknown): unknown => (typeof e === "object" && e !== null ? (e as { code?: unknown }).code ?? codeOf((e as { cause?: unknown }).cause) : undefined);

/** A buy-out for this subject: the family's own (no student), or this student's. */
const forSubject = (t: { studentId: AppStudentId | null }) => (t.studentId === null ? isNull(buyout.studentId) : eq(buyout.studentId, t.studentId));

/** Can a write go now: QuickBooks connected, not waiting for an Admin, and to the company the roster cache came from. */
async function writable(tx: Tx, realmId: string): Promise<boolean> {
  const [c, source] = await Promise.all([getConnection(tx), getRosterSource(tx)]);
  return Boolean(c?.realmId && c.refreshTokenCiphertext && !errorNeedsAdmin(c.lastError) && source === c.realmId && source === realmId);
}

/**
 * A guardian confirms "Pay instead of volunteering" for one requirement and one of the family's own subjects. Every
 * argument came from a browser: the requirement and the key are looked up within the session's family, the stamp of
 * the subject the page showed (subjectStamp()) must name the subject the key names now, or nothing is done and the
 * reload words are said, and the quote is worked out again; the stamp of the quote the page showed must match it, or
 * nothing is done and the new amount is said. While the membership shape doesn't hold (shapeHolds(): none, or one
 * naming a customer type QuickBooks no longer has) the family is not set up for it, before and under the lock. In one transaction, holding the roster lock shared (no refresh or change of company runs between the checks and
 * the write): the requirement is read again, the customer billed is checked to be the family's own and active, the
 * family's record to be the session's and active and a student's record to be active and in it, the buy-out is
 * recorded as being invoiced by those records (at most one stands per requirement and family, or requirement and
 * student: `buyout_family_live_uq`, `buyout_student_live_uq`, so two confirms at once make one), the create is put on
 * the write queue, and the choice is audited. The create is then tried
 * once at once, never waiting for the connection row; the worker's queue job does the rest.
 */
export async function confirmMyBuyout(ctx: ParentCtx, requirementId: unknown, key: unknown, subject: unknown, stamp: unknown): Promise<Result> {
  if (!isUuid(requirementId) || !isChoiceKey(key) || !isStamp(subject) || !isStamp(stamp)) return no(BUYOUT_COPY.notFromPage);
  if (!(await shapeHolds())) return no(BUYOUT_COPY.notSetUp);
  const actor = parentActor({ id: ctx.parentId, email: ctx.email });
  const take = await takeRateLimit("buyout_parent", ctx.parentId);
  if (take === "first_refusal") await writeAudit({ actor, action: "volunteer.buyout.limit", targetType: "parent", targetId: ctx.parentId, after: { code: "rate_limited" }, ip: ctx.ip });
  if (take !== "taken") return no(BUYOUT_COPY.rateLimited);
  const t = await findMyBuyout(ctx, requirementId, key);
  // Which subject first: a key that has come to name another student since the page was drawn is the reload words,
  // never the price-changed ones (the quote's stamp below speaks for the price alone).
  if (!t || t.view.subjectStamp !== subject) return no(BUYOUT_COPY.notFromPage);
  if (t.view.buyout) return no(BUYOUT_COPY.already);
  const q = t.view.quote;
  if (!q.ok) return no(q.why === "met" ? BUYOUT_COPY.met : BUYOUT_COPY.notOffered);
  const amount = formatMoney(q.amountCents);
  if (t.view.stamp !== stamp) return no(BUYOUT_COPY.changed(amount));
  const made = await takePlace(async (tx): Promise<{ r: Result; item?: Item }> => {
    await tx.execute(sql`set local lock_timeout = '10s'`);
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${ROSTER_LOCK})`);
    // The membership shape, read again under the lock (a shape save holds it): while it can't say whose customers are
    // the family's, nothing is billed (shapeHolds(), as money shows no figures then).
    if (!(await shapeHolds(tx))) return { r: no(BUYOUT_COPY.notSetUp) };
    if (!(await writable(tx, t.realmId))) return { r: no(BUYOUT_COPY.cantNow) };
    const [r] = await tx.select().from(requirement).where(eq(requirement.id, t.requirement.id)).for("share");
    if (!r || r.kind !== "volunteer" || r.buyoutUnitCents === null || r.itemQboId === null) return { r: no(BUYOUT_COPY.notOffered) };
    if (r.buyoutUnitCents !== q.unitCents || r.itemQboId !== t.itemQboId || r.amount !== t.requirement.amount || r.amountUnit !== t.requirement.amountUnit) return { r: no(BUYOUT_COPY.changed(amount)) };
    // Whose it is: the session's own family record, still active, and for a per-student requirement the student's own
    // record, still active and in that family, as the page found them (sessionFamily()), read again under the lock.
    if ((r.appliesTo === "family") !== (t.studentId === null) || String(ctx.familyId) !== String(t.familyId) || (await activeFamilyOf(ctx.familyId, tx)) === null) return { r: no(BUYOUT_COPY.notFromPage) };
    // Who is billed, read again under the lock: the family's own linked customer, or the student's own linked customer,
    // active and directly under the family's now (QuickBooks' tree: open question 14).
    const familyCustomer = await customerOfFamily(t.familyId, tx);
    const subjectCustomer = t.studentId === null ? familyCustomer : await customerOfStudent(t.studentId, tx);
    const [customer] = familyCustomer === null || subjectCustomer !== t.customerQboId ? [] : await tx.select({ qboId: qboCustomer.qboId, parentQboId: qboCustomer.parentQboId }).from(qboCustomer)
      .where(and(eq(qboCustomer.qboId, t.customerQboId), eq(qboCustomer.active, true)));
    const ours = customer && (r.appliesTo === "family" ? customer.qboId === familyCustomer : customer.parentQboId === familyCustomer);
    if (!ours) return { r: no(BUYOUT_COPY.notFromPage) };
    if (t.studentId !== null && !(await studentsStillIn(t.familyId, [t.studentId], tx)).has(String(t.studentId))) return { r: no(BUYOUT_COPY.notFromPage) };
    const [row] = await tx.insert(buyout).values({
      requirementId: r.id, familyId: t.familyId, studentId: t.studentId, customerQboId: t.customerQboId, itemQboId: r.itemQboId,
      unitCents: q.unitCents, units: q.units, amountCents: q.amountCents, state: "being_invoiced", realmId: t.realmId, chosenBy: ctx.parentId, chosenByLabel: ctx.email,
    }).onConflictDoNothing().returning();
    if (!row) {
      // Another confirm for the same requirement and subject was first (another guardian of the family, or a second
      // press). A live buy-out of another family's (a student who moved here in QuickBooks, still flagged there) is
      // never told: the guardian reads only that it can't be set up now.
      const [ours] = await tx.select({ id: buyout.id }).from(buyout).where(and(eq(buyout.requirementId, r.id), forSubject(t),
        eq(buyout.familyId, t.familyId), inArray(buyout.state, ["being_invoiced", "invoiced", "paid", "being_voided", "stuck"])));
      return { r: no(ours ? BUYOUT_COPY.already : BUYOUT_COPY.cantNow) };
    }
    // The invoice's bill-to address is the confirming guardian's own sign-in address, from their session (never from the
    // browser), kept with the queued create so every try sends the same one. It gives the invoice its Pay link; its
    // email status stays not set, so nothing is emailed. It goes into no audit row.
    // The item is filed under the family checked above, under the lock: the session's own active record.
    const item = await queueItem(tx, { op: "invoice_create", buyoutId: row.id, customerQboId: row.customerQboId, itemQboId: row.itemQboId, units: row.units, unitCents: row.unitCents,
      billEmail: ctx.email },
      { realmId: row.realmId, familyId: t.familyId, label: ctx.email, nextTryAt: new Date(Date.now() + LEASE_MS) });
    await writeAudit({ actor, action: "volunteer.buyout.chosen", targetType: "buyout", targetId: row.id, ip: ctx.ip,
      after: { state: "being_invoiced", requirementId: r.id, title: r.title, ...buyoutRecords(row), customerQboId: row.customerQboId, itemQboId: row.itemQboId,
        units: row.units, unitCents: row.unitCents, amountCents: row.amountCents, queueId: item.id } }, tx);
    return { r: { ok: true, message: "" }, item };
  }).catch((e: unknown): { r: Result; item?: Item } => { if (codeOf(e) === "23505") return { r: no(BUYOUT_COPY.already) }; throw e; });
  if (made === "busy") return no(ROSTER_BUSY);
  if (!made.item) return made.r;
  const step = await sendBuyoutWrite(made.item, new Date(), { mayWait: false, actor });
  if (step === "done") return { ok: true, message: BUYOUT_COPY.done(amount) };
  if (step === "refused") return no(BUYOUT_COPY.refused);
  return { ok: true, message: BUYOUT_COPY.waiting(amount) };
}

/**
 * A guardian switches back to volunteering, before the buy-out's invoice is paid. The requirement and the key are found
 * within the session's family, and the buy-out is the family's own. The stamp the page was given (subjectStamp()) must
 * name the subject the key names now: a key that has come to name another of the family's students since the page was
 * drawn is refused with the reload words, and nothing is read or voided; so is everything while the membership shape
 * doesn't hold (shapeHolds(), checked again in the void's transaction), with the not-set-up words. The invoice is read live first: only one with
 * nothing paid on it (its balance is its total) is voided; a paid or part-paid one is the treasurer's to sort out, in
 * QuickBooks. The void goes on the write queue in one transaction with its audit row, and is tried once at once (it
 * reads the invoice again just before it is sent). A buy-out still being invoiced can't be switched back until the
 * create's outcome is known.
 */
export async function switchMyBuyoutBack(ctx: ParentCtx, requirementId: unknown, key: unknown, stamp: unknown): Promise<Result> {
  if (!isUuid(requirementId) || !isChoiceKey(key) || !isStamp(stamp)) return no(BUYOUT_COPY.notFromPage);
  if (!(await shapeHolds())) return no(BUYOUT_COPY.notSetUp);
  const actor = parentActor({ id: ctx.parentId, email: ctx.email });
  const take = await takeRateLimit("buyout_parent", ctx.parentId);
  if (take === "first_refusal") await writeAudit({ actor, action: "volunteer.buyout.limit", targetType: "parent", targetId: ctx.parentId, after: { code: "rate_limited" }, ip: ctx.ip });
  if (take !== "taken") return no(BUYOUT_COPY.rateLimited);
  const t = await findMyBuyout(ctx, requirementId, key);
  if (!t || t.view.subjectStamp !== stamp) return no(BUYOUT_COPY.notFromPage);
  if (!t.view.buyout) return no(BUYOUT_COPY.nothingToSwitch);
  const [b] = await db.select().from(buyout).where(and(eq(buyout.familyId, t.familyId), eq(buyout.requirementId, t.requirement.id), forSubject(t),
    inArray(buyout.state, ["being_invoiced", "invoiced", "paid", "being_voided", "stuck"])));
  if (!b) return no(BUYOUT_COPY.nothingToSwitch);
  if (b.state === "being_invoiced") return no(BUYOUT_COPY.stillMaking);
  if (b.state === "being_voided") return no(BUYOUT_COPY.beingCancelled);
  if (b.state === "stuck") return no(BUYOUT_COPY.waitingForClub);
  if (b.state === "paid" || t.view.buyout.invoicePaid) return no(BUYOUT_COPY.paidSome);
  if (!b.invoiceQboId || b.flag !== null) return no(BUYOUT_COPY.clubLooks);
  if (!(await db.transaction((tx) => writable(tx, b.realmId)))) return no(BUYOUT_COPY.cantCheck);
  let invoices: Invoice[];
  try { invoices = await invoicesOf(b.customerQboId, b.realmId, false); } catch (e) { if (e instanceof QboError) return no(BUYOUT_COPY.cantCheck); throw e; }
  const inv = invoices.find((i) => i.qboId === b.invoiceQboId);
  // Gone from the customer's invoices: nothing is changed, and the parent is not told anything was paid. Something paid
  // on it: the treasurer's to sort out. One voided in QuickBooks already (a total of 0) goes on: the void below finds it
  // voided and the buy-out ends, as the guardian asked.
  if (!inv) return no(BUYOUT_COPY.invoiceGone);
  if (inv.totalCents > 0 && inv.balanceCents < inv.totalCents) return no(BUYOUT_COPY.paidSome);
  const item = await db.transaction(async (tx) => (await shapeHolds(tx))
    ? queueVoid(tx, b, "switched_back", { actor, label: ctx.email, nextTryAt: new Date(Date.now() + LEASE_MS), ip: ctx.ip }) : "not_set_up" as const);
  if (item === "not_set_up") return no(BUYOUT_COPY.notSetUp);
  if (!item) return no(BUYOUT_COPY.nothingToSwitch);
  const step = await sendBuyoutWrite(item, new Date(), { mayWait: false, actor });
  if (step === "done") return { ok: true, message: BUYOUT_COPY.switched };
  if (step === "kept") {
    // Why the void was kept is in the buy-out's code: only a payment is told as one.
    const [after] = await db.select({ lastCode: buyout.lastCode }).from(buyout).where(eq(buyout.id, b.id));
    return no(after?.lastCode === "paid" ? BUYOUT_COPY.paidSome : after?.lastCode === "invoice_gone" ? BUYOUT_COPY.invoiceGone : BUYOUT_COPY.clubLooks);
  }
  return { ok: true, message: BUYOUT_COPY.switching };
}
