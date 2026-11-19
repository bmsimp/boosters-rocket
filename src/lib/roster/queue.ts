// Staff only: the write queue (v1 spec §4, §8.4). Staff roster writes that QuickBooks didn't take at the time and may
// take later are tried again here by the worker, carefully: one that QuickBooks may already have made is never simply
// sent again. Its rules are pure, in ./write-rules.ts; the send and what follows it are ./writes.ts's.
import "server-only";
import { and, asc, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { buyout, jobRun, qboCustomer, setting, writeQueue, type QueuedWrite, type RosterWrite } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getConnection } from "@/lib/quickbooks/connection";
import { WORKER_ACTOR } from "@/lib/quickbooks/client";
import { QboError } from "@/lib/quickbooks/endpoints";
import { refreshRoster } from "./refresh";
import { getRosterSource, ROSTER_JOB } from "./source";
import { lockRosterAs, rosterTagOf } from "@/lib/seasons/roster-lock";
import { afterStudentMoved, applyWritten, changeOwnRecord, owedBy, REFRESH_ASK_KEY, sendWrite, type OwnRecordChange } from "./writes";
import { afterFailedTry, beforeResend, classify } from "./write-rules";
import { isBuyoutWrite, sendBuyoutWrite } from "@/lib/buyouts/writes";
import { formatMoney } from "@/lib/money/cents";
import { customerOfFamily, linksOf } from "@/lib/families/links";
import type { AppFamilyId } from "@/lib/families/ids";

export const WRITE_QUEUE_JOB = "roster.write_queue";
/** How long a try may hold an item before another wake may take it: longer than one send takes. */
const LEASE_MS = 5 * 60_000;
/** At most this many items are tried in one wake, so a long queue doesn't hold the worker up. */
const PER_WAKE = 10;
export const NOTE_MAX = 500;

type Item = typeof writeQueue.$inferSelect;
type Step = "done" | "stuck" | "waiting" | "skipped";

/**
 * When the last roster refresh that worked started, or null. Its start, not its end: a refresh that began before a try
 * may have read QuickBooks before that try's change landed there.
 */
async function lastGoodRefresh(): Promise<Date | null> {
  const [r] = await db.select({ at: jobRun.startedAt }).from(jobRun).where(and(eq(jobRun.job, ROSTER_JOB), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1);
  return r?.at ?? null;
}

async function refreshAsked(): Promise<Date | null> {
  const [row] = await db.select().from(setting).where(eq(setting.key, REFRESH_ASK_KEY));
  const at = (row?.value as { at?: unknown } | undefined)?.at;
  return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? new Date(at) : null;
}

/** Takes an item for one try, so an overlapping wake leaves it alone: its next try is pushed past the try's length. */
async function claim(id: string, now: Date): Promise<Item | null> {
  const [item] = await db.update(writeQueue).set({ nextTryAt: new Date(now.getTime() + LEASE_MS), updatedAt: new Date() })
    .where(and(eq(writeQueue.id, id), eq(writeQueue.state, "waiting"), lte(writeQueue.nextTryAt, now))).returning();
  return item ?? null;
}

const short = (code: string) => code.slice(0, 40);

/**
 * One state change of an item, with its audit row, in one transaction. A row a company change deleted is left gone.
 * `triedAt` is when this try sent the write (or looked for it): a refresh that started before it may not show it.
 */
async function settle(item: Item, to: { state: "stuck" | "waiting"; code: string; sent: boolean; nextTryAt?: Date }, triedAt: Date): Promise<Step> {
  await db.transaction(async (tx) => {
    const [still] = await tx.update(writeQueue).set({ state: to.state, lastCode: short(to.code), sent: to.sent, tries: item.tries + 1, lastTriedAt: triedAt,
      nextTryAt: to.state === "waiting" ? to.nextTryAt! : null, updatedAt: new Date() }).where(eq(writeQueue.id, item.id)).returning({ id: writeQueue.id });
    if (!still) return;
    await writeAudit({ actor: WORKER_ACTOR, action: to.state === "stuck" ? "roster.write.stuck" : "roster.write.retry", targetType: "write_queue", targetId: item.id,
      before: { state: item.state, tries: item.tries, code: item.lastCode }, after: { state: to.state, tries: item.tries + 1, code: short(to.code), sent: to.sent } }, tx);
  });
  return to.state;
}

/** Marks an item done, audited, in the transaction given (or one of its own), with the app record a found change made or changed. */
async function markDone(item: Item, how: "sent" | "found", resultQboId: string | null, tries: number, tx?: Parameters<Parameters<typeof db.transaction>[0]>[0],
  appRecord: OwnRecordChange | null = null): Promise<void> {
  const run = async (t: NonNullable<typeof tx>) => {
    const [still] = await t.update(writeQueue).set({ state: "done", resultQboId, tries, lastTriedAt: new Date(), nextTryAt: null, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(writeQueue.id, item.id)).returning({ id: writeQueue.id });
    if (!still) return;
    await writeAudit({ actor: WORKER_ACTOR, action: "roster.write.done", targetType: "write_queue", targetId: item.id,
      before: { state: item.state, tries: item.tries }, after: { state: "done", how, tries, ...(resultQboId ? { resultQboId } : {}), ...(appRecord ? { appRecord } : {}) } }, t);
  };
  if (tx) await run(tx); else await db.transaction(run);
}

/**
 * One try of one item. One that QuickBooks may already have made (`sent`) is first looked for in the cache, which a
 * refresh has read since its last try: there, it is done; an update whose record moved on otherwise is stuck, nothing
 * overwritten; otherwise it is sent again. What QuickBooks refuses now makes it stuck; what may still go through waits
 * for its next try, or is stuck once it is old or tried often (afterFailedTry).
 */
async function tryItem(item: Item, now: Date, refreshedAt: Date | null): Promise<Step> {
  // A buy-out's invoice write is tried by its own module, which reads the customer's invoices, not the roster, before
  // anything that may already have been made is sent again (src/lib/buyouts/writes.ts).
  if (isBuyoutWrite(item.request)) {
    const step = await sendBuyoutWrite(item, now, { mayWait: true });
    return step === "waiting" || step === "stuck" ? step : "done";
  }
  const w = item.request as RosterWrite;
  if (item.sent) {
    if (!refreshedAt || refreshedAt <= item.lastTriedAt) {
      // No roster read since the last try: leave it for the next wake, when one will have run.
      await db.update(writeQueue).set({ nextTryAt: now, updatedAt: new Date() }).where(eq(writeQueue.id, item.id));
      return "skipped";
    }
    const cache = await db.select().from(qboCustomer);
    const seen = beforeResend(w, cache);
    if (seen.is === "done") { await foundDone(item, w, seen.qboId); return "done"; }
    if (seen.is === "stuck") return settle(item, { state: "stuck", code: seen.code, sent: item.sent }, now);
  }
  if (w.op === "deactivate") {
    // Nobody with a balance is made inactive, here as when staff press it (src/lib/roster/writes.ts): what the customer
    // owes is read first. One who owes makes the item stuck (`open_balance`), and nothing is sent; one QuickBooks shows
    // inactive already is done. A read that may go through later waits for the next try, as a send would.
    const owed = await owedBy(w.qboId, item.realmId, { mayWait: true });
    if (!owed.ok) {
      if (classify(owed.code).kind !== "retry") return settle(item, { state: "stuck", code: owed.code, sent: item.sent }, now);
      return settle(item, { ...afterFailedTry(item.tries + 1, item.createdAt, now), code: owed.code, sent: item.sent }, now);
    }
    if (owed.cents > 0) return settle(item, { state: "stuck", code: "open_balance", sent: item.sent }, now);
    if (!owed.active) { await foundDone(item, w, w.qboId); return "done"; }
  }
  let answer: Record<string, unknown>;
  // The time of the send itself, not the wake's: the check before a later resend needs a refresh that began after it.
  const triedAt = new Date();
  try {
    answer = await sendWrite(w, item.realmId, { mayWait: true });
  } catch (e) {
    if (!(e instanceof QboError)) throw e;
    const failure = classify(e.code);
    // Once a try may have reached QuickBooks, the item stays `sent`: a later try that sent nothing (a 429, a token that
    // couldn't be had) or was refused says nothing about the earlier one, which may still have been made.
    if (failure.kind !== "retry") return settle(item, { state: "stuck", code: e.code, sent: item.sent }, triedAt);
    const next = afterFailedTry(item.tries + 1, item.createdAt, now);
    return settle(item, { ...next, code: e.code, sent: item.sent || failure.sent }, triedAt);
  }
  const { cached } = await applyWritten(w, answer, { realmId: item.realmId, actor: WORKER_ACTOR, ip: null, queueId: item.id, linkedBy: item.askedBy,
    inside: (tx) => markDone(item, "sent", typeof answer.Id === "string" ? answer.Id.slice(0, 64) : null, item.tries + 1, tx) });
  return cached ? "done" : "waiting";
}

/**
 * An item a refresh shows QuickBooks made already (or, for a make-inactive, QuickBooks shows done), marked done. Its app
 * record follows as one sent now does (changeOwnRecord(), ./writes.ts: a new customer's record and link, `created` by
 * the staff member who asked, a name, a student's family, an inactive flag), and a move still has its follow-ups (the
 * student's forms, volunteer places and buy-outs, afterStudentMoved()), first: all in the same transaction under the
 * roster lock while the cache is still the item's company; the guardians whose places were given up are told after
 * the commit. `qboId` is the customer it was found as: the one a create made.
 */
async function foundDone(item: Item, w: RosterWrite, qboId: string): Promise<void> {
  let tell: (() => Promise<unknown>) | null = null;
  await db.transaction(async (tx) => {
    let appRecord: OwnRecordChange | null = null;
    if (await lockRosterAs(tx, rosterTagOf(item.realmId))) {
      if (w.op === "move") {
        ({ tell } = await afterStudentMoved(tx, { studentQboId: w.qboId, fromFamilyQboId: w.fromFamilyQboId, toFamilyQboId: w.toFamilyQboId, cause: `roster.write.found#${w.qboId}` },
          { actor: WORKER_ACTOR, ip: null }));
      }
      appRecord = await changeOwnRecord(tx, w, qboId, { realmId: item.realmId, linkedBy: item.askedBy });
    }
    await markDone(item, "found", qboId, item.tries, tx, appRecord);
  });
  if (tell) await (tell as () => Promise<unknown>)().catch(() => undefined);
}

/**
 * The worker's share of the queue at one wake: a roster refresh first when one was asked for (a family made inactive)
 * or a waiting item needs one before it can be looked for, then up to PER_WAKE items whose time has come. Only items of
 * the company QuickBooks is connected to, which the cache came from, are tried. In the wake's answer only when it did
 * something.
 */
export async function runWriteQueue(now: Date = new Date()): Promise<{ ran: boolean; ok: boolean }> {
  const [conn, source] = await Promise.all([getConnection(), getRosterSource()]);
  if (!conn?.realmId || !conn.refreshTokenCiphertext || source !== conn.realmId) return { ran: false, ok: true };
  const due = await db.select().from(writeQueue).where(and(eq(writeQueue.state, "waiting"), eq(writeQueue.realmId, source), lte(writeQueue.nextTryAt, now)))
    .orderBy(asc(writeQueue.nextTryAt)).limit(PER_WAKE);
  const asked = await refreshAsked();
  let refreshedAt = await lastGoodRefresh();
  let ran = false, ok = true;
  const needsRead = due.some((i) => i.sent && !isBuyoutWrite(i.request) && (!refreshedAt || refreshedAt <= i.lastTriedAt));
  if ((asked && (!refreshedAt || refreshedAt <= asked)) || needsRead) {
    const r = await refreshRoster({ startedBy: "worker", actor: WORKER_ACTOR, ip: null });
    ran = ran || r.ok || r.reason === "failed";
    if (!r.ok && r.reason === "failed") ok = false;
    refreshedAt = await lastGoodRefresh();
  }
  if (asked && refreshedAt && refreshedAt > asked) await db.delete(setting).where(and(eq(setting.key, REFRESH_ASK_KEY), sql`(${setting.value}->>'at')::timestamptz <= ${refreshedAt.toISOString()}::timestamptz`));
  for (const row of due) {
    const item = await claim(row.id, now);
    if (!item) continue;
    try {
      const step = await tryItem(item, now, refreshedAt);
      if (step !== "skipped") ran = true;
    } catch {
      // Nothing of the error is kept. The lease runs out and the item is tried again at a later wake.
      ran = true; ok = false;
    }
  }
  return { ran, ok };
}

/**
 * An item as the Reconciliation page and a family's page show it. `familyId` is the family record the item is filed
 * under, for the link to that family's page (addressed by the record's own id); null when it is filed under none (a new
 * family or member) or the record has no link in the roster's company.
 */
export type QueueView = {
  id: string; state: "waiting" | "stuck"; write: QueuedWrite; words: string; askedBy: string | null; askedAt: string;
  lastTriedAt: string; nextTryAt: string | null; tries: number; lastCode: string | null;
  /** The family record it is filed under, for the link to that family's page: null when it has none, or that record no link in the roster's company (no page). */
  familyId: AppFamilyId | null;
};

/**
 * What a queued write was, in words, with the names the cache has for its ids. Names are QuickBooks text: shown as text
 * only. A buy-out invoice's amount is what a family is billed, so it is said only with `showAmounts` (a staff member
 * holding Finance.Balance.Read), as the Balances pages and the buy-outs table say it.
 */
export function describeWrite(w: QueuedWrite, names: Map<string, string>, o: { showAmounts?: boolean } = {}): string {
  const name = (id: string | null) => (id === null ? "the club" : names.get(id) ?? "a customer no longer on the roster");
  const who = "role" in w ? { family: "the family", student: "the student", parent: "the parent", member: "the member", other: "the customer" }[w.role] : "";
  switch (w.op) {
    case "create": return w.familyQboId === null ? `Make ${who} “${w.name}”` : `Add ${who} “${w.name}” to ${name(w.familyQboId)}`;
    case "rename": return `Rename ${who} “${w.was}” to “${w.name}”`;
    case "move": return `Move the student ${name(w.qboId)} from ${name(w.fromFamilyQboId)} to ${name(w.toFamilyQboId)}`;
    case "deactivate": return `Make ${who} ${name(w.qboId)} inactive`;
    case "invoice_create": return `Invoice ${name(w.customerQboId)}${o.showAmounts ? ` ${formatMoney(w.units * w.unitCents)}` : ""} for a volunteer buy-out`;
    case "invoice_void": return `Void the volunteer buy-out invoice of ${name(w.customerQboId)}${w.why === "student_moved" ? ", as the student moved to another family" : ""}`;
  }
}

/**
 * Every waiting and stuck item, newest first; for one family (`familyId`, the app's family its staff page's address
 * names), only the items under or about it: an item filed under that record, one whose target is the family's
 * customer, or a move into it (what is sent names the family moved to by customer). The record's customer is found once
 * here, through its own link in the roster's company; with none, only the items filed under the record are found. Each
 * item's family record is offered as the page's link only when it has a link (one lookup for the list). With
 * `showAmounts` a buy-out invoice's words carry its amount (describeWrite).
 */
export async function loadOpenWrites(o: { familyId?: AppFamilyId; showAmounts?: boolean } = {}): Promise<QueueView[]> {
  const customer = o.familyId === undefined ? null : await customerOfFamily(o.familyId);
  const where = and(inArray(writeQueue.state, ["waiting", "stuck"]), o.familyId === undefined ? undefined
    : or(eq(writeQueue.familyId, o.familyId), customer === null ? undefined : eq(writeQueue.targetQboId, customer),
      customer === null ? undefined : sql`${writeQueue.request}->>'toFamilyQboId' = ${customer}`));
  const rows = await db.select().from(writeQueue).where(where).orderBy(desc(writeQueue.createdAt));
  if (!rows.length) return [];
  const names = new Map((await db.select({ qboId: qboCustomer.qboId, name: qboCustomer.displayName }).from(qboCustomer)).map((c) => [c.qboId, c.name]));
  const families = [...new Set(rows.map((r) => r.familyId).filter((f): f is AppFamilyId => f !== null))];
  const links = await linksOf({ families, students: [] });
  return rows.map((r) => ({
    id: r.id, state: r.state as "waiting" | "stuck", write: r.request, words: describeWrite(r.request, names, { showAmounts: o.showAmounts }), askedBy: r.askedByLabel, askedAt: r.createdAt.toISOString(),
    lastTriedAt: r.lastTriedAt.toISOString(), nextTryAt: r.nextTryAt?.toISOString() ?? null, tries: r.tries, lastCode: r.lastCode,
    familyId: r.familyId !== null && links.customerOfFamily.has(r.familyId) ? r.familyId : null,
  }));
}

/** How many items are waiting, and how many are stuck, for the Health page. */
export async function queueCounts(): Promise<{ waiting: number; stuck: number }> {
  const rows = await db.select({ state: writeQueue.state, n: sql<number>`count(*)::int` }).from(writeQueue).where(inArray(writeQueue.state, ["waiting", "stuck"])).groupBy(writeQueue.state);
  return { waiting: rows.find((r) => r.state === "waiting")?.n ?? 0, stuck: rows.find((r) => r.state === "stuck")?.n ?? 0 };
}

export type QueueOp = { actor: Actor; ip: string | null; permission: string };
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const GONE: Done = { ok: false, errors: ["That is no longer waiting: it went through, or was given up. Reload the page."] };

/**
 * "Try again now": a waiting or stuck item is tried at the worker's next wake, within a minute. A stuck one gets one more
 * try: if that fails too, it is stuck again. The worker does the try, so a staff member never waits on QuickBooks here.
 */
export async function tryAgainNow(id: string, o: QueueOp): Promise<Done> {
  return db.transaction(async (tx) => {
    const [item] = await tx.select().from(writeQueue).where(and(eq(writeQueue.id, id), inArray(writeQueue.state, ["waiting", "stuck"]))).for("update");
    if (!item) return GONE;
    const now = new Date();
    // A buy-out write whose first try, made at once for the guardian, may still be under way: trying it again now could
    // send it twice. It is the worker's once that try's hold runs out.
    if (isBuyoutWrite(item.request) && item.state === "waiting" && item.tries === 0 && item.nextTryAt && item.nextTryAt > now) {
      return { ok: false as const, errors: ["It is being tried right now. Reload the page in a few minutes to see how it went."] };
    }
    // Its count of tries and its age are kept, so a stuck item that fails again is stuck again at once.
    await tx.update(writeQueue).set({ state: "waiting", nextTryAt: now, updatedAt: now }).where(eq(writeQueue.id, id));
    await writeAudit({ actor: o.actor, action: "roster.write.again", permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: id,
      before: { state: item.state, tries: item.tries, code: item.lastCode }, after: { state: "waiting" } }, tx);
    return { ok: true as const, message: "It will be tried again within a minute." };
  });
}

/** "Give up": the item is never tried again. The note says why, for staff, and is kept in the audit log. */
export async function giveUp(id: string, rawNote: string, o: QueueOp): Promise<Done> {
  const note = rawNote.trim();
  if (!note) return { ok: false, errors: ["Say why, in a few words. The note is kept in the audit log."] };
  if (note.length > NOTE_MAX) return { ok: false, errors: [`The note is too long (${NOTE_MAX} characters at most).`] };
  return db.transaction((tx) => giveUpIn(tx, id, note, o));
}

/**
 * The giving up itself, in the caller's transaction, with a note already checked: giveUp() above, and a buy-out staff
 * close (src/lib/buyouts/close.ts), which gives up its stuck item in the same transaction as it ends the buy-out.
 */
export async function giveUpIn(tx: Tx, id: string, note: string, o: QueueOp): Promise<Done> {
  const [item] = await tx.select().from(writeQueue).where(and(eq(writeQueue.id, id), inArray(writeQueue.state, ["waiting", "stuck"]))).for("update");
  if (!item) return GONE;
  await tx.update(writeQueue).set({ state: "given_up", note, nextTryAt: null, finishedAt: new Date(), updatedAt: new Date() }).where(eq(writeQueue.id, id));
  // A buy-out whose invoice write is given up waits for the treasurer: its outcome in QuickBooks isn't known.
  if (isBuyoutWrite(item.request)) await tx.update(buyout).set({ state: "stuck", flag: "given_up", flaggedAt: new Date(), updatedAt: new Date() }).where(and(eq(buyout.id, item.request.buyoutId), inArray(buyout.state, ["being_invoiced", "being_voided", "stuck"])));
  await writeAudit({ actor: o.actor, action: "roster.write.given_up", permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: id,
    before: { state: item.state, tries: item.tries, code: item.lastCode, op: item.request.op }, after: { state: "given_up", note } }, tx);
  return { ok: true as const, message: "Given up. Nothing more will be sent for it; if QuickBooks did make the change, the next roster refresh shows it." };
}
