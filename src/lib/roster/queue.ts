// Staff only: the write queue (v1 spec §4, §8.4). Staff roster writes that QuickBooks didn't take at the time and may
// take later are tried again here by the worker, carefully: one that QuickBooks may already have made is never simply
// sent again. Its rules are pure, in ./write-rules.ts; the send and what follows it are ./writes.ts's.
import "server-only";
import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { buyout, family, guardian, jobRun, parent, qboCustomer, setting, student, writeQueue, type QueuedWrite, type RosterWrite } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getConnection } from "@/lib/quickbooks/connection";
import { WORKER_ACTOR } from "@/lib/quickbooks/client";
import { QboError } from "@/lib/quickbooks/endpoints";
import { refreshRoster } from "./refresh";
import { getRosterSource, ROSTER_JOB } from "./source";
import { lockRosterAs, rosterTagOf } from "@/lib/seasons/roster-lock";
import { alignAfterWrite, applyWritten, balanceUnread, BEING_SENT_NOW, changeOwnRecord, closeEarlierContacts, CONTACT_AWAITS_READ, contactShown, CREDIT_BALANCE, CUSTOMER_HAS_GUARDIAN, EMAIL_TOO_LONG, FAMILY_HELD, guardianCustomerLinked, guardianOf, isSavedFirst, NAME_UNUSABLE, itemLockFree, madeAfterGivingUp, markMoveMoneyStale, moveMoneyNotes, REFRESH_ASK_KEY,
  replaceRefusedCreates, sendWrite, tryDeactivate, trySavedItem, whileItemHeld, whoStopped, contactStopNow, type ContactNotOffered, type MadeAfterGivingUp, type OwnRecordChange, type SavedTry } from "./writes";
import { afterFailedTry, beforeResend, classify, contactDiffers, heldInCache, type ContactDiffer, type HeldContact } from "./write-rules";
import { isUuid } from "@/lib/seasons/ids";
import { contactSendsMayGo } from "@/lib/parents/take-in-setting";
import { isBuyoutWrite, sendBuyoutWrite } from "@/lib/buyouts/writes";
import { formatMoney } from "@/lib/money/cents";
import { customerOfFamily, familyLinkedTo, linksOf, linksOfCustomers } from "@/lib/families/links";
import { asAppStudentId, type AppFamilyId, type AppStudentId } from "@/lib/families/ids";
import { recordNameWords } from "@/lib/families/words";

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
 * One state change of an item, with its audit row, in one transaction, only while it is still waiting: one staff gave
 * up while its try was under way stays given up, whatever the try came to. A row a company change deleted is left gone.
 * `triedAt` is when this try sent the write (or looked for it): a refresh that started before it may not show it.
 * `resultQboId`: the customer a create was found made as, kept so that it is never sent again (tryItem()).
 */
async function settle(item: Item, to: { state: "stuck" | "waiting"; code: string; sent: boolean; nextTryAt?: Date; resultQboId?: string; request?: RosterWrite }, triedAt: Date): Promise<Step> {
  await db.transaction(async (tx) => {
    // `request`: what this try sent, when it may have been made with another version than the item's (a rename resent
    // after a live read, stage 3's slice 9e), so a later look finds it as sent.
    const [still] = await tx.update(writeQueue).set({ state: to.state, lastCode: short(to.code), sent: to.sent, tries: item.tries + 1, lastTriedAt: triedAt,
      nextTryAt: to.state === "waiting" ? to.nextTryAt! : null, ...(to.resultQboId ? { resultQboId: to.resultQboId } : {}), ...(to.request ? { request: to.request } : {}), updatedAt: new Date() })
      .where(and(eq(writeQueue.id, item.id), eq(writeQueue.state, "waiting"))).returning({ id: writeQueue.id });
    if (!still) return;
    await writeAudit({ actor: WORKER_ACTOR, action: to.state === "stuck" ? "roster.write.stuck" : "roster.write.retry", targetType: "write_queue", targetId: item.id,
      before: { state: item.state, tries: item.tries, code: item.lastCode }, after: { state: to.state, tries: item.tries + 1, code: short(to.code), sent: to.sent } }, tx);
  });
  return to.state;
}

/** Marks an item done, audited, in the transaction given (or one of its own), with the app record a found change made or changed: only while it is still waiting (settle()). */
async function markDone(item: Item, how: "sent" | "found", resultQboId: string | null, tries: number, tx?: Parameters<Parameters<typeof db.transaction>[0]>[0],
  appRecord: OwnRecordChange | null = null): Promise<void> {
  const run = async (t: NonNullable<typeof tx>) => {
    const [still] = await t.update(writeQueue).set({ state: "done", resultQboId, tries, lastTriedAt: new Date(), nextTryAt: null, finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(writeQueue.id, item.id), eq(writeQueue.state, "waiting"))).returning({ id: writeQueue.id });
    if (!still) return;
    await writeAudit({ actor: WORKER_ACTOR, action: "roster.write.done", targetType: "write_queue", targetId: item.id,
      before: { state: item.state, tries: item.tries }, after: { state: "done", how, tries, ...(resultQboId ? { resultQboId } : {}), ...(appRecord ? { appRecord } : {}) } }, t);
  };
  if (tx) await run(tx); else await db.transaction(run);
}

/**
 * One try of one item. One that QuickBooks may already have made (`sent`) is first looked for in the cache, which a
 * refresh has read since its last try: there, it is done; an update whose record moved on otherwise is stuck, nothing
 * overwritten (but a rename or move saved first, and a linked make-inactive, settled by the field); otherwise it is sent
 * again. What QuickBooks refuses now makes it stuck; what may still go through waits
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
  if (!isSavedFirst(item) && !isLinkedDeactivate(item)) return tryRosterItem(item, w, now, refreshedAt);
  // One sender at a time (stage 3's slice 9e): a change saved first is tried only holding the lock its at-once try and
  // "Send the portal's value" hold (whileItemHeld()), and so, since slice 9g, is a make-inactive filed under a student or
  // member, by the lock its record's rename, move and make-inactive hold. While someone holds it, nothing is sent and no
  // try is counted: the item is left for the next wake. So it is while a guardian's Parent customer create finds its
  // family being changed in QuickBooks (FAMILY_HELD: stage 3's slice 9h).
  const step = await whileItemHeld(item, () => tryRosterItem(item, w, now, refreshedAt));
  if (step !== null && step !== FAMILY_HELD) return step;
  await db.update(writeQueue).set({ nextTryAt: now, updatedAt: new Date() }).where(and(eq(writeQueue.id, item.id), eq(writeQueue.state, "waiting")));
  return "skipped";
}

/**
 * A make-inactive filed under the record it is for (stage 3's slice 9g): a student's, under its student record, or a
 * member's, under its own family record. Tried holding that record's "being sent" lock (lockOfItem()).
 */
export const isLinkedDeactivate = (item: Pick<Item, "request" | "studentId" | "familyId">) => {
  const w = item.request;
  return w.op === "deactivate" && ((w.role === "student" && item.studentId !== null) || (w.role === "member" && item.familyId !== null));
};

/** The worker's share of a change saved first, from a try's outcome (trySavedItem(), ./writes.ts). */
function savedStep(t: SavedTry): Step {
  if (t.is === "done") return t.cached ? "done" : "waiting";
  if (t.is === "waiting") return "waiting";
  if (t.is === "found" || t.is === "given_up") return "done";
  // A parent's change of their details the portal may not send yet: left as it was, no try counted.
  if (t.is === "not_yet") return "skipped";
  return "stuck";
}

/** tryItem() for one roster write, under its lock when it is a change saved first. */
async function tryRosterItem(item: Item, w: RosterWrite, now: Date, refreshedAt: Date | null): Promise<Step> {
  const saved = (readFirst: "moved_on" | null) => trySavedItem(item, w as Extract<RosterWrite, { op: "rename" | "create" | "move" | "deactivate" | "contact" }>,
    { by: "worker", readFirst, linkedBy: item.askedBy, actor: WORKER_ACTOR, ip: null, now }).then(savedStep);
  // A linked make-inactive held as maybe sent whose cache row, still active, shows another version than it was sent with
  // (the link's own, which no roster read moves on): settled by the field, the Active flag read live, as a rename or a
  // move saved first is (the lead's decision 2 for slice 9g), and sent at most once more, with the version just read.
  let byTheField = false;
  if (item.sent) {
    if (!refreshedAt || refreshedAt <= item.lastTriedAt) {
      // No roster read since the last try: leave it for the next wake, when one will have run.
      await db.update(writeQueue).set({ nextTryAt: now, updatedAt: new Date() }).where(and(eq(writeQueue.id, item.id), eq(writeQueue.state, "waiting")));
      return "skipped";
    }
    const cache = await db.select().from(qboCustomer);
    const seen = beforeResend(w, cache);
    if (seen.is === "done") return finishFound(item, w, seen.qboId, now);
    // A rename or move saved first whose record moved on is settled by the field, not the version (the lead's decision
    // 3 for slices 9e and 9f): read live and compared with the item's before-value, it is kept refused when the name, or
    // the family QuickBooks has the student under, changed, and sent once otherwise.
    if (seen.is === "stuck" && seen.code === "moved_on" && (w.op === "rename" || w.op === "move") && isSavedFirst(item)) return saved("moved_on");
    // So is a parent's phone and address (stage 3's slice 11b), held as maybe sent, whose fields or version the cache
    // shows moved on: read live and compared field by field, kept when QuickBooks holds something else, sent once otherwise.
    if (seen.is === "stuck" && seen.code === "moved_on" && w.op === "contact") return saved("moved_on");
    // A guardian's Parent customer made inactive (stage 3's slice 9h), held as maybe sent, whose cache row shows another
    // version: settled by the field as a linked make-inactive is, through the one path of a change saved first.
    if (seen.is === "stuck" && seen.code === "moved_on" && w.op === "deactivate" && guardianOf(w) !== null) return saved("moved_on");
    byTheField = seen.is === "stuck" && seen.code === "moved_on" && isLinkedDeactivate(item);
    if (seen.is === "stuck" && !byTheField) return settle(item, { state: "stuck", code: seen.code, sent: item.sent }, now);
    // A create QuickBooks answered with a customer, or one a read found made (`result_qbo_id`, kept when it was held or
    // its finish failed), that isn't there as sent now: QuickBooks made something, so it is never sent again, whatever
    // became of its finish. Staff look at it in QuickBooks.
    if (w.op === "create" && item.resultQboId !== null) return settle(item, { state: "stuck", code: "made_unmatched", sent: true }, now);
  }
  // A guardian's Parent customer made inactive (stage 3's slice 9h) is a change saved first: its balance read again
  // first, by the one rule, and a balance keeps it refused (trySavedItem()), never stuck.
  if (w.op === "deactivate" && guardianOf(w) !== null) return saved(null);
  if (w.op === "deactivate") {
    // Nobody with a balance is made inactive, here as when staff press it (src/lib/roster/writes.ts): the balance is read
    // again first, by the one rule (balanceStops()). Any balance makes the item stuck (`open_balance`, or
    // `credit_balance` for a credit), and nothing is sent; one QuickBooks shows inactive already is found made. A read
    // that may go through later waits for the next try, as a send would; one that won't makes it stuck. A stale answer
    // is settled by the Active flag (tryDeactivate(), stage 3's slice 9g), never simply stuck. One settled by the field
    // (`byTheField`) carries no version of its own, so it is sent with the one its read shows (`checked`).
    const t = await tryDeactivate(byTheField ?{ ...w, syncToken: "" } : w, item.realmId, { mayWait: true, name: "", showAmounts: false, actor: WORKER_ACTOR, ip: null });
    switch (t.is) {
      case "inactive_there": return finishFound(item, w, w.qboId, now);
      case "stopped": {
        if (t.stop.code === "open_balance" || t.stop.code === CREDIT_BALANCE || classify(t.stop.code).kind !== "retry") return settle(item, { state: "stuck", code: t.stop.code, sent: item.sent }, now);
        return settle(item, { ...afterFailedTry(item.tries + 1, item.createdAt, now), code: t.stop.code, sent: item.sent }, now);
      }
      case "stale_again": return settle(item, { ...afterFailedTry(item.tries + 1, item.createdAt, now), code: "fault_5010", sent: item.sent }, new Date());
      case "failed": {
        const failure = classify(t.code);
        if (failure.kind !== "retry") return settle(item, { state: "stuck", code: t.code, sent: item.sent }, new Date());
        // Sent with another version than the item held (a resend after a live read): kept, so a later look finds it as sent.
        return settle(item, { ...afterFailedTry(item.tries + 1, item.createdAt, now), code: t.code, sent: item.sent || t.sent, ...(t.sent ? { request: t.write } : {}) }, new Date());
      }
      case "answer": {
        const { cached } = await applyWritten(t.write, t.answer, { realmId: item.realmId, actor: WORKER_ACTOR, ip: null, queueId: item.id, linkedBy: item.askedBy,
          filed: { familyId: item.familyId, studentId: item.studentId }, ...(t.resent ? { auditExtra: { resent: "stale" } } : {}),
          inside: (tx) => markDone(item, "sent", typeof t.answer.Id === "string" ? t.answer.Id.slice(0, 64) : null, item.tries + 1, tx) });
        return cached ? "done" : "waiting";
      }
    }
  }
  // A change saved first is tried as at once and on a press (the one path): its outcome settles the item.
  if ((w.op === "rename" || w.op === "create" || w.op === "move" || w.op === "contact") && isSavedFirst(item)) return saved(null);
  let answer: Record<string, unknown>;
  // The time of the send itself, not the wake's: the check before a later resend needs a refresh that began after it.
  const triedAt = new Date();
  // A create is marked as maybe sent, at the time of this send, before it goes (as a buy-out's is): staff who give the
  // item up while it is on its way leave it `sent`, so "Create in QuickBooks and link" waits for a roster read that shows
  // whether QuickBooks made it (givenUpMaybeMade() in ./writes.ts) rather than taking it for one that never left. One
  // given up before this point is not sent. A failure that surely sent nothing puts `sent` back as it was.
  if (w.op === "create") {
    const [still] = await db.update(writeQueue).set({ sent: true, lastTriedAt: triedAt, updatedAt: new Date() })
      .where(and(eq(writeQueue.id, item.id), eq(writeQueue.state, "waiting"))).returning({ id: writeQueue.id });
    if (!still) return "skipped";
  }
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
    filed: { familyId: item.familyId, studentId: item.studentId },
    inside: (tx) => markDone(item, "sent", typeof answer.Id === "string" ? answer.Id.slice(0, 64) : null, item.tries + 1, tx) });
  return cached ? "done" : "waiting";
}

/**
 * An item a refresh shows QuickBooks made already (or, for a make-inactive, QuickBooks shows done), marked done. Its app
 * record follows as one sent now does (changeOwnRecord(), ./writes.ts: a new customer's record and link, `created` by
 * the staff member who asked, a name, an inactive flag), in the same transaction under the roster lock while the cache
 * is still the item's company. A move is the portal's own change, its record moved and its follow-ups run when it was
 * saved (stage 3's slice 9f): found made, it moves nothing and follows nothing again, and, when the portal sent it,
 * marks both families' figures stale (whose invoices each sees follows QuickBooks' tree). `qboId` is the customer it
 * was found as: the one a create made.
 */
type Found = "done" | typeof CUSTOMER_HAS_FAMILY | typeof FAMILY_HAS_CUSTOMER | typeof CUSTOMER_HAS_GUARDIAN;
async function foundDone(item: Item, w: RosterWrite, qboId: string): Promise<Found> {
  return db.transaction(async (tx): Promise<Found> => {
    let appRecord: OwnRecordChange | null = null;
    // Given up while this look was under way: it stays given up, nothing linked, and a create keeps the customer it was
    // found as, for the Reconciliation page (madeAfterGivingUp()). Read FOR UPDATE, so a give-up waits for this look.
    // The roster lock first, then the item, in the order applyWritten() takes them.
    const ours = await lockRosterAs(tx, rosterTagOf(item.realmId));
    const [now] = await tx.select({ state: writeQueue.state }).from(writeQueue).where(eq(writeQueue.id, item.id)).for("update");
    if (now && now.state !== "waiting") {
      // The customer it was found as is kept, and audited in the same transaction; an item that has one already changes nothing.
      if (w.op === "create") {
        const [kept] = await tx.update(writeQueue).set({ resultQboId: qboId, updatedAt: new Date() })
          .where(and(eq(writeQueue.id, item.id), isNull(writeQueue.resultQboId))).returning({ id: writeQueue.id });
        if (kept) {
          await writeAudit({ actor: WORKER_ACTOR, action: "roster.write.found_after_giving_up", targetType: "write_queue", targetId: item.id,
            before: { state: now.state }, after: { state: now.state, resultQboId: qboId, linked: false } }, tx);
        }
      }
      return "done";
    }
    if (ours) {
      // A family's own create (stage 3's slice 9d), found made as a customer another family is linked to already (made
      // a family of on Reconciliation meanwhile, say), or with its own family linked to another customer meanwhile: no
      // second link is made, on either side, and the item is left for staff.
      if (w.op === "create" && (w.role === "family" || w.role === "member") && item.familyId !== null) {
        const holder = await familyLinkedTo(qboId, tx);
        if (holder !== null && String(holder) !== String(item.familyId)) return CUSTOMER_HAS_FAMILY;
        const own = await customerOfFamily(item.familyId, tx);
        if (own !== null && own !== qboId) return FAMILY_HAS_CUSTOMER;
      }
      // A guardian's Parent customer (stage 3's slice 9h) found made, by name, as a customer another guardian row, open or
      // closed, is linked to already (a removed guardian's own, which they take back if reinstated): no second link is
      // made, and the item is left for staff.
      const guardianId = guardianOf(w);
      if (w.op === "create" && guardianId !== null && (await guardianCustomerLinked(tx, item.realmId, qboId, guardianId))) return CUSTOMER_HAS_GUARDIAN;
      // A move found made after the portal sent it: the cache has the student under the family joined now.
      if (w.op === "move" && item.sent) await markMoveMoneyStale(tx, w);
      // The link takes the version of the cache row it was found as, by the rule an answer's takes, only for a change the
      // portal sent (its answer was lost): one found made without a send (a make-inactive QuickBooks shows done already,
      // a name it holds already) was made by someone else, whose version the portal never aligned with.
      const [row] = await tx.select({ syncToken: qboCustomer.syncToken }).from(qboCustomer).where(eq(qboCustomer.qboId, qboId));
      appRecord = await changeOwnRecord(tx, w, qboId, { realmId: item.realmId, linkedBy: item.askedBy, studentId: item.studentId, familyId: item.familyId, syncedToken: row?.syncToken ?? null });
      if (appRecord?.kind === "student" && "linked" in appRecord) {
        await replaceRefusedCreates(tx, asAppStudentId(appRecord.studentId), { op: "create", customerQboId: qboId, queueId: item.id }, { actor: WORKER_ACTOR, ip: null });
      }
      if (item.sent) await alignAfterWrite(tx, w, item.realmId, row?.syncToken ?? null, { familyId: item.familyId, studentId: item.studentId });
    }
    await markDone(item, "found", qboId, item.tries, tx, appRecord);
    // A parent's phone and address found in place (stage 3's slice 11b): no earlier change of them lands after it.
    if (w.op === "contact") await closeEarlierContacts(tx, item, { actor: WORKER_ACTOR, ip: null });
    return "done";
  });
}

/**
 * foundDone(), with what follows when finishing it fails (the record's change, or the link's, that throws):
 * nothing of it is kept, and the item counts the try (`finish_failed`), waiting for a later one at the queue's gaps and
 * stuck after as many tries or as long as any other (afterFailedTry()), so it shows on Reconciliation rather than
 * waiting for good. QuickBooks has the change: nothing is sent for it, and a create keeps the customer it was found as
 * (`result_qbo_id`), so a later read that no longer shows it as sent (renamed or moved in QuickBooks meanwhile) never
 * leads to its being sent again.
 */
async function finishFound(item: Item, w: RosterWrite, qboId: string, now: Date): Promise<Step> {
  let how: Found;
  try {
    how = await foundDone(item, w, qboId);
  } catch {
    return settle(item, { ...afterFailedTry(item.tries + 1, item.createdAt, now), code: "finish_failed", sent: item.sent, ...(w.op === "create" ? { resultQboId: qboId } : {}) }, now);
  }
  // QuickBooks made it, and another family is linked to that customer, or this family to another customer: stuck with
  // its own code, never sent again (`result_qbo_id` keeps the customer), for staff to look at on Reconciliation.
  if (how !== "done") return settle(item, { state: "stuck", code: how, sent: true, resultQboId: qboId }, now);
  return "done";
}
/** The code of a family's create found made as a customer another family is linked to already (finishFound()). */
export const CUSTOMER_HAS_FAMILY = "customer_has_family";
/** The code of a family's create found made while the family it is filed under was linked to another customer meanwhile (finishFound()). */
export const FAMILY_HAS_CUSTOMER = "family_has_customer";

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
 * under, for the link to that family's page (addressed by the record's own id); null when it is filed under none (a
 * create queued before slice 9d) or that page can't stand (an inactive record with no link).
 */
export type QueueView = {
  id: string; state: "waiting" | "stuck" | "refused"; write: QueuedWrite; words: string; askedBy: string | null; askedAt: string;
  lastTriedAt: string; nextTryAt: string | null; tries: number; lastCode: string | null;
  /** The family record it is filed under, for the link to that family's page: null when it has none, or that record has no page (inactive, with no link). */
  familyId: AppFamilyId | null;
  /** The student record it is for (a rename, a move, a make-inactive, a student's create), or null. */
  studentId: AppStudentId | null;
  /**
   * For a move that hasn't reached the portal's copy of QuickBooks (waiting, stuck or kept refused): whose invoices each
   * family sees meanwhile, by where the cache has the student now, in words (moveMoneyNotes(), ./writes.ts; open
   * question 14: they follow once QuickBooks takes the move). Null for anything else, and where nobody sees them.
   */
  moneyNote: string | null;
  /**
   * QuickBooks took it, but the portal couldn't take it in then: its transaction failed (`cache_failed`), QuickBooks
   * answered with another record (`answer_other`), or a read found it made and finishing it failed (`finish_failed`).
   * It is on the queue only for the portal to finish on its side after its next read, sending nothing again
   * (waitingWords()).
   */
  finishing: boolean;
  /**
   * A parent's change of their phone and address (stage 3's slice 11b) the portal may not send yet: the take-in, or a
   * read of QuickBooks under the shape saved last, is still to come (contactSendsMayGo()), so the row says so and
   * nothing is sent for it, by the worker or a press.
   */
  awaitsRead: boolean;
  /**
   * For a refused rename: the name the roster cache holds for its customer, what QuickBooks has now; for a refused move,
   * where the cache has the student, by the portal's name of that family where it has a record, else the customer's
   * name (null: none, or neither).
   */
  holds: string | null;
  /**
   * For a refused item, what its row shows that "Send the portal's value" is held to (sealed with the item by
   * portalValueStamp()): a rename's, the name the cache has for its customer; a student's create's, the student's
   * current name in the portal, which the press sends; a move's, the customer the cache has the student under.
   */
  shown: string;
  /**
   * Whether "Send the portal's value" can go through for a refused item, as the cache shows it, and why not
   * (`notOffered`): a rename QuickBooks refused as a taken name (`taken`: a later rename takes its place, and is sent),
   * one of a customer the cache has inactive (`inactive`: the portal never makes one active again), one of a
   * customer the cache doesn't hold at all (`not_on_roster`), or a move into a family that has no customer in
   * QuickBooks yet (`create_family_first`: the press would be refused until the family is made there and linked); a
   * guardian's Parent customer create kept for a taken name (`taken`), a name QuickBooks can't take (`name_unusable`)
   * or an address over its limit (`email_too_long`), whose ways out are a rename of the person or "Give up". A removed
   * guardian's make-inactive is offered whatever the cache shows: inactive there, the press finishes it as found. A
   * kept change of a parent's phone and address whose record is no longer the one it is for (ContactNotOffered: the
   * guardian removed or the family made inactive in the portal, the customer no longer theirs or the family's in
   * QuickBooks, or the books no longer keeping the details there) isn't offered either, in its own words. The press
   * checks it all again.
   */
  mayResend: boolean;
  notOffered: "taken" | "inactive" | "not_on_roster" | "create_family_first" | "email_too_long" | "name_unusable" | ContactNotOffered | null;
  /**
   * For a kept change of a parent's phone and address (stage 3's slice 11b): which of its fields the roster cache holds
   * otherwise than the portal knew, and whether the portal knew any value for each (contactDiffers()), for the words
   * that say so (keptWordsFor()); never the values, which only the compare view shows (compareContact()). Null for
   * anything else. The list's `shown` is empty for such a row: only the compare view binds what QuickBooks holds.
   */
  differs: ContactDiffer[] | null;
};

/** A phone and billing address's columns, which the roster cache, a person's row and a family's row name alike. */
const detailColumns = (t: typeof parent | typeof family | typeof qboCustomer) => ({ phone: t.phone, addressLine1: t.addressLine1, addressLine2: t.addressLine2,
  addressCity: t.addressCity, addressRegion: t.addressRegion, addressPostalCode: t.addressPostalCode, addressCountry: t.addressCountry });
/** The fields a parent's change of their details sends, as `held` holds them, in words: QuickBooks text or the portal's, shown as text only. */
function detailsInWords(held: HeldContact, w: Extract<RosterWrite, { op: "contact" }>): string {
  const parts: string[] = [];
  if (w.change.phone !== undefined) parts.push(held.phone ? `phone ${held.phone}` : "no phone");
  if (w.change.address !== undefined) {
    const a = held.address;
    const line = [a.line1, a.line2, a.city, [a.region, a.postalCode].filter(Boolean).join(" "), a.country].filter(Boolean).join(", ");
    parts.push(line ? `mailing address ${line}` : "no mailing address");
  }
  return parts.join("; ");
}

/** The codes of an item QuickBooks took that the portal still has to finish on its side (QueueView.finishing). */
const FINISHING_CODES = new Set(["cache_failed", "answer_other", "finish_failed"]);

/** Where a waiting or stuck item stands, in words, for the Reconciliation page and a family's page. */
export function waitingWords(i: Pick<QueueView, "state" | "finishing" | "lastCode">): string {
  if (i.state === "refused") {
    const who = whoStopped(i.lastCode);
    // Held back for a balance, an unread balance, or a name or address QuickBooks can't take (a guardian's Parent
    // customer, stage 3's slice 9h): nothing in QuickBooks differs, so the words don't say it does.
    const heldHere = i.lastCode === "open_balance" || i.lastCode === CREDIT_BALANCE || i.lastCode === EMAIL_TOO_LONG || i.lastCode === NAME_UNUSABLE || balanceUnread(i.lastCode);
    return who === "quickbooks" ? "Refused by QuickBooks: the portal keeps its own value"
      : who === "held" ? (heldHere ? "Held back by the portal, which keeps its own value" : "Held back by the portal, as QuickBooks has something else: the portal keeps its own value")
        : "Not sent: the portal couldn't send it to QuickBooks at the time, and keeps its own value";
  }
  if (i.state === "stuck") return "Stuck: it needs someone to look at it";
  return i.finishing ? "Done in QuickBooks: the portal finishes it on its side after its next read of QuickBooks" : "Waiting to reach QuickBooks";
}

/**
 * What a queued write was, in words, with the names the cache has for its ids. Names are QuickBooks text: shown as text
 * only. A buy-out invoice's amount is what a family is billed, so it is said only with `showAmounts` (a staff member
 * holding Finance.Balance.Read), as the Balances pages and the buy-outs table say it.
 */
export function describeWrite(w: QueuedWrite, names: Map<string, string>, o: { showAmounts?: boolean; familyNames?: Map<string, string>; person?: string; family?: string } = {}): string {
  const name = (id: string | null) => (id === null ? "the club" : names.get(id) ?? "a customer no longer on the roster");
  // A move's families by the portal's own name where it has the record (slice 9f), else by the customer's name.
  const familyOf = (record: AppFamilyId | undefined, customer: string) => (record !== undefined && o.familyNames?.has(String(record)) ? o.familyNames.get(String(record))!
    : customer === "" ? "a family with no customer in QuickBooks" : name(customer));
  const who = "role" in w ? { family: "the family", student: "the student", parent: "the parent", member: "the member", other: "the customer" }[w.role] : "";
  switch (w.op) {
    // A guardian's own Parent customer (stage 3's slice 9h): the person, by the name the portal holds for them, and the family.
    case "create": return w.familyQboId === null ? `Make ${who} “${w.name}”` : guardianOf(w) !== null ? `Make the guardian “${w.name}” a parent in QuickBooks under ${name(w.familyQboId)}`
      : `Add ${who} “${w.name}” to ${name(w.familyQboId)}`;
    case "rename": return `Rename ${who} “${w.was}” to “${w.name}”`;
    case "move": return `Move the student ${name(w.qboId)} from ${familyOf(w.fromFamilyId, w.fromFamilyQboId)} to ${familyOf(w.toFamilyId, w.toFamilyQboId)}`;
    case "deactivate": return `Make ${who} ${name(w.qboId)} inactive`;
    // A parent's phone and address (stage 3's slice 11b): the person by the portal's name for them, the family by its
    // record's name (`o.person`, `o.family`), else the customer's name in QuickBooks.
    case "contact": {
      const what = w.change.phone !== undefined && w.change.address !== undefined ? "phone and mailing address" : w.change.phone !== undefined ? "phone" : "mailing address";
      return guardianOf(w) !== null ? `Send ${o.person ?? name(w.qboId)}'s ${what} to their record under ${o.family ?? "their family"}`
        : `Send ${o.family ?? name(w.qboId)}'s ${what}`;
    }
    case "invoice_create": return `Invoice ${name(w.customerQboId)}${o.showAmounts ? ` ${formatMoney(w.units * w.unitCents)}` : ""} for a volunteer buy-out`;
    case "invoice_void": return `Void the volunteer buy-out invoice of ${name(w.customerQboId)}${w.why === "student_moved" ? ", as the student moved to another family" : ""}`;
  }
}

/**
 * Every waiting, stuck and refused item (a change saved first that QuickBooks refused, stage 3's slice 9e), newest first; for one family (`familyId`, the app's family its staff page's address
 * names), only the items under or about it: an item filed under that record, one whose target is the family's
 * customer, or a move into it (by the family joined's record since slice 9f, `request->>'toFamilyId'`, or by customer, as
 * what is sent names it). The record's customer is found once
 * here, through its own link in the roster's company; with none, only the items filed under the record are found. Each
 * item's family record is offered as the page's link only when it has a link (one lookup for the list). With
 * `showAmounts` a buy-out invoice's words carry its amount (describeWrite).
 */
export async function loadOpenWrites(o: { familyId?: AppFamilyId; showAmounts?: boolean } = {}): Promise<QueueView[]> {
  const customer = o.familyId === undefined ? null : await customerOfFamily(o.familyId);
  const where = and(inArray(writeQueue.state, ["waiting", "stuck", "refused"]), o.familyId === undefined ? undefined
    : or(eq(writeQueue.familyId, o.familyId), sql`${writeQueue.request}->>'toFamilyId' = ${String(o.familyId)}`, customer === null ? undefined : eq(writeQueue.targetQboId, customer),
      customer === null ? undefined : sql`${writeQueue.request}->>'toFamilyQboId' = ${customer}`));
  const rows = await db.select().from(writeQueue).where(where).orderBy(desc(writeQueue.createdAt));
  if (!rows.length) return [];
  const customers = await db.select({ qboId: qboCustomer.qboId, name: qboCustomer.displayName, active: qboCustomer.active, parentQboId: qboCustomer.parentQboId }).from(qboCustomer);
  const names = new Map(customers.map((c) => [c.qboId, c.name]));
  const parentOf = new Map(customers.map((c) => [c.qboId, c.parentQboId]));
  // A move's families by the portal's own names (slice 9f): the records it names, and the families its students are
  // under in the cache, through those customers' family links, for where QuickBooks has a kept move's student.
  const moves = rows.flatMap((r) => (r.request.op === "move" ? [r.request] : []));
  const moveFamilies = [...new Set(moves.flatMap((w) => [w.fromFamilyId, w.toFamilyId].flatMap((f) => (f === undefined ? [] : [f]))))];
  const places = [...new Set(moves.flatMap((w) => { const p = parentOf.get(w.qboId); return p ? [p] : []; }))];
  const placeLinks = places.length ? (await linksOfCustomers({ families: places, students: [] })).familyOfCustomer : new Map<string, AppFamilyId>();
  const named = [...new Set([...moveFamilies, ...placeLinks.values()])];
  const familyNames = new Map((named.length ? await db.select({ id: family.id, name: family.name }).from(family).where(inArray(family.id, named)) : [])
    .map((f) => [String(f.id), recordNameWords(f.name, "family")]));
  const placeOf = (studentQboId: string) => {
    const p = parentOf.get(studentQboId);
    if (!p) return null;
    const record = placeLinks.get(p);
    return (record !== undefined ? familyNames.get(String(record)) : undefined) ?? names.get(p) ?? null;
  };
  const activeHere = new Set(customers.filter((c) => c.active).map((c) => c.qboId));
  const families = [...new Set(rows.map((r) => r.familyId).filter((f): f is AppFamilyId => f !== null))];
  // A family's page stands for an active record, linked or not (stage 3's slice 9d), and for an inactive one the roster
  // still lists through its link: an item is linked to its record's page whenever that page may stand.
  const [links, active] = await Promise.all([linksOf({ families, students: [] }),
    families.length ? db.select({ id: family.id }).from(family).where(and(inArray(family.id, families), eq(family.active, true))) : Promise.resolve([])]);
  const withPage = new Set([...active.map((f) => String(f.id)), ...[...links.customerOfFamily.keys()].map(String)]);
  // A refused student's create is shown, and sent by "Send the portal's value", with the student's current name in the
  // portal (renamed there since, the row says so), never the name first asked for.
  const refusedStudents = [...new Set(rows.flatMap((r) => (r.state === "refused" && r.request.op === "create" && r.studentId !== null ? [r.studentId] : [])))];
  const studentName = new Map((refusedStudents.length ? await db.select({ id: student.id, name: student.name }).from(student).where(inArray(student.id, refusedStudents)) : [])
    .map((s) => [String(s.id), s.name ?? ""]));
  // So is a guardian's refused Parent customer create (stage 3's slice 9h), with the person's current name.
  const refusedGuardians = [...new Set(rows.flatMap((r) => { const g = guardianOf(r.request); return r.state === "refused" && r.request.op === "create" && g !== null ? [g] : []; }))];
  const personName = new Map((refusedGuardians.length ? await db.select({ id: guardian.id, name: parent.name }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId))
    .where(inArray(guardian.id, refusedGuardians)) : []).map((g) => [g.id, g.name]));
  const currentName = (r: (typeof rows)[number]) => {
    const g = guardianOf(r.request);
    return g !== null ? personName.get(g) : r.studentId !== null ? studentName.get(String(r.studentId)) : undefined;
  };
  // A parent's phone and address (stage 3's slice 11b): the person by the portal's name, the family by its record's,
  // and which fields the cache holds otherwise than the portal knew (never the values: the list writes no audit row).
  const contacts = rows.filter((r) => r.request.op === "contact");
  // Whether any of them may be sent now, read once for the list (contactSendsMayGo()).
  const mayGo = contacts.length ? await db.transaction((tx) => contactSendsMayGo(tx)) : true;
  const contactGuardians = [...new Set(contacts.flatMap((r) => { const g = guardianOf(r.request); return g === null ? [] : [g]; }))];
  const contactPeople = new Map((contactGuardians.length ? await db.select({ id: guardian.id, name: parent.name }).from(guardian)
    .innerJoin(parent, eq(parent.id, guardian.parentId)).where(inArray(guardian.id, contactGuardians)) : []).map((g) => [g.id, g]));
  const contactFamilies = [...new Set(contacts.flatMap((r) => (r.familyId === null ? [] : [r.familyId])))];
  const contactFamilyRows = new Map((contactFamilies.length ? await db.select({ id: family.id, name: family.name }).from(family)
    .where(inArray(family.id, contactFamilies)) : []).map((f) => [String(f.id), f]));
  const contactTargets = [...new Set(contacts.flatMap((r) => (r.targetQboId === null ? [] : [r.targetQboId])))];
  const heldThere = new Map((contactTargets.length ? await db.select({ qboId: qboCustomer.qboId, ...detailColumns(qboCustomer) }).from(qboCustomer)
    .where(inArray(qboCustomer.qboId, contactTargets)) : []).map((c) => [c.qboId, heldInCache(c)]));
  const contactWords = (r: (typeof rows)[number]) => {
    const g = guardianOf(r.request);
    const f = r.familyId === null ? undefined : contactFamilyRows.get(String(r.familyId));
    return { person: g === null ? undefined : contactPeople.get(g)?.name, family: f ? recordNameWords(f.name, "family") : undefined };
  };
  const finishingOf = (r: (typeof rows)[number]) => r.state !== "refused" && r.sent && r.lastCode !== null && FINISHING_CODES.has(r.lastCode);
  const moveName = (record: AppFamilyId | undefined, customer: string) => (record !== undefined ? familyNames.get(String(record)) : undefined) ?? (customer ? names.get(customer) : undefined);
  // Whose invoices each family sees meanwhile, by where the cache has each student now: the one function moveStudent()'s answer uses too.
  const moveRows = rows.filter((r) => r.request.op === "move");
  const notes = await moveMoneyNotes(moveRows.map((r) => {
    const w = r.request as Extract<QueuedWrite, { op: "move" }>;
    return { studentQboId: w.qboId, student: names.get(w.qboId) ?? "the student", toFamilyId: w.toFamilyId, to: moveName(w.toFamilyId, w.toFamilyQboId) ?? "the family joined", finishing: finishingOf(r) };
  }));
  const noteOf = new Map(moveRows.map((r, i) => [r.id, notes[i] ?? null]));
  // A refused move into a family with no customer in QuickBooks can't be sent until that family is made there.
  const joined = [...new Set(moveRows.flatMap((r) => { const w = r.request as Extract<QueuedWrite, { op: "move" }>; return r.state === "refused" && w.toFamilyId !== undefined ? [w.toFamilyId] : []; }))];
  const joinedLinked = joined.length ? (await linksOf({ families: joined, students: [] })).customerOfFamily : new Map<AppFamilyId, string>();
  // A kept contact change whose record is no longer the one it is for (the guardian removed, the customer no longer
  // theirs or the family's, the books changed): "Send the portal's value" would be refused, so it isn't offered, in words
  // that say whose record changed (contactStopNow(), the press's own checks without its lock).
  const contactStopsOf = new Map(await Promise.all(contacts.filter((r) => r.state === "refused")
    .map(async (r) => [r.id, await contactStopNow(r.request as Extract<RosterWrite, { op: "contact" }>, r)] as const)));
  return rows.map((r) => {
    const refused = r.state === "refused";
    const request: QueuedWrite = refused && r.request.op === "create" ? { ...r.request, name: currentName(r) ?? r.request.name } : r.request;
    // A guardian's Parent customer create kept as a taken name, or as a name or address QuickBooks can't take: a rename
    // of the person takes its place, so nothing is offered to send it again as it is (stage 3's slice 9h).
    const guardianKept = refused && request.op === "create" && guardianOf(request) !== null && (r.lastCode === "fault_6240" || r.lastCode === NAME_UNUSABLE || r.lastCode === EMAIL_TOO_LONG);
    const contactNotOffered = refused && request.op === "contact" ? (!mayGo ? "awaits_read" : !names.has(request.qboId) ? "not_on_roster" : !activeHere.has(request.qboId) ? "inactive" : contactStopsOf.get(r.id) ?? null) : undefined;
    const notOffered: QueueView["notOffered"] = contactNotOffered !== undefined ? contactNotOffered : guardianKept ? (r.lastCode === EMAIL_TOO_LONG ? "email_too_long" : r.lastCode === NAME_UNUSABLE ? "name_unusable" : "taken")
      : !refused || (request.op !== "rename" && request.op !== "move" && request.op !== "deactivate") ? null : request.op === "rename" && r.lastCode === "fault_6240" ? "taken"
      // A removed guardian's Parent customer QuickBooks has inactive now: the press finishes it as found (sendAgainHolding()).
      : !names.has(request.qboId) ? "not_on_roster" : !activeHere.has(request.qboId) && !(request.op === "deactivate" && guardianOf(request) !== null) ? "inactive"
        : request.op === "move" && request.toFamilyId !== undefined && !joinedLinked.has(request.toFamilyId) ? "create_family_first" : null;
    return {
      id: r.id, state: r.state as QueueView["state"], write: request, words: describeWrite(request, names, { showAmounts: o.showAmounts, familyNames, ...(request.op === "contact" ? contactWords(r) : {}) }),
      askedBy: r.askedByLabel, askedAt: r.createdAt.toISOString(),
      lastTriedAt: r.lastTriedAt.toISOString(), nextTryAt: r.nextTryAt?.toISOString() ?? null, tries: r.tries, lastCode: r.lastCode,
      familyId: r.familyId !== null && withPage.has(String(r.familyId)) ? r.familyId : null,
      studentId: r.studentId, moneyNote: noteOf.get(r.id) ?? null,
      finishing: finishingOf(r),
      awaitsRead: request.op === "contact" && !mayGo,
      holds: !refused ? null : request.op === "rename" ? names.get(request.qboId) ?? null : request.op === "move" ? placeOf(request.qboId) : null,
      shown: !refused ? "" : request.op === "rename" ? names.get(request.qboId) ?? "" : request.op === "create" ? request.name : request.op === "move" ? parentOf.get(request.qboId) ?? "" : "",
      mayResend: refused && notOffered === null,
      notOffered,
      differs: refused && request.op === "contact" ? contactDiffers(heldThere.get(request.qboId) ?? heldInCache({}), request) : null,
    };
  });
}

/**
 * What the compare view of one kept change of a parent's phone and address shows (stage 3's slice 11b, the lead's
 * decision 5 on the second read): what QuickBooks holds of the fields it sends (the roster cache's) and what the portal
 * holds now, each in words, as text, and `shown`, the digest of QuickBooks' that "Send the portal's value" is bound to
 * (contactShown(), keyed with the server's secret).
 */
export type ContactCompare = { id: string; quickbooks: string; portal: string; shown: string };
/**
 * The compare view of one kept contact change, for the Reconciliation page, which offers it only to a holder of
 * Parents.ReadWrite (and checks it before it calls this): the item must be a kept (`refused`) contact change whose record
 * still stands (the membership open in an active family whose row the item is filed under, or the family record
 * active), or null, with nothing written. Otherwise a staff read of one person's (or one family's) details: audited
 * (`parent.details.compared`, targeting the person, or the family for a family's details, naming the item) in the same
 * transaction, before anything of them is read.
 */
export async function compareContact(rawItemId: string, o: { actor: Actor; ip: string | null }): Promise<ContactCompare | null> {
  if (!isUuid(rawItemId)) return null;
  const itemId = rawItemId.toLowerCase();
  return db.transaction(async (tx) => {
    const [item] = await tx.select().from(writeQueue).where(and(eq(writeQueue.id, itemId), eq(writeQueue.state, "refused")));
    if (!item || item.request.op !== "contact" || item.familyId === null) return null;
    const w = item.request;
    const g = guardianOf(w);
    let target: { type: "parent" | "family"; id: string };
    if (g !== null) {
      const [row] = await tx.select({ parentId: guardian.parentId, status: guardian.status, familyId: guardian.familyId }).from(guardian).where(eq(guardian.id, g));
      if (!row || row.status === "disabled" || row.familyId === null || String(row.familyId) !== String(item.familyId)) return null;
      target = { type: "parent", id: row.parentId };
    } else target = { type: "family", id: String(item.familyId) };
    const [f] = await tx.select({ active: family.active }).from(family).where(eq(family.id, item.familyId));
    if (!f?.active) return null;
    await writeAudit({ actor: o.actor, action: "parent.details.compared", permission: "Parents.ReadWrite", ip: o.ip, targetType: target.type, targetId: target.id,
      after: { queueId: item.id } }, tx);
    const [mine] = target.type === "parent"
      ? await tx.select(detailColumns(parent)).from(parent).where(eq(parent.id, target.id))
      : await tx.select(detailColumns(family)).from(family).where(eq(family.id, item.familyId));
    const [there] = await tx.select(detailColumns(qboCustomer)).from(qboCustomer).where(eq(qboCustomer.qboId, w.qboId));
    const held = heldInCache(there ?? {});
    return { id: item.id, quickbooks: detailsInWords(held, w), portal: detailsInWords(heldInCache(mine ?? {}), w), shown: contactShown(held, w) };
  });
}

/**
 * The creates staff gave up that QuickBooks made all the same, each with no record linked to its customer
 * (madeAfterGivingUp(), ./writes.ts), for the Reconciliation page to say so. `familyPage` is the family record it was
 * filed under, for the link to that family's page, only while that record is active (its page stands).
 */
export type GivenUpMadeView = MadeAfterGivingUp & { familyPage: AppFamilyId | null };
export async function loadMadeAfterGivingUp(): Promise<GivenUpMadeView[]> {
  return db.transaction(async (tx) => {
    const made = await madeAfterGivingUp(tx);
    const families = [...new Set(made.flatMap((m) => (m.familyId === null ? [] : [m.familyId])))];
    const active = new Set((families.length ? await tx.select({ id: family.id }).from(family).where(and(inArray(family.id, families), eq(family.active, true))) : []).map((f) => String(f.id)));
    return made.map((m) => ({ ...m, familyPage: m.familyId !== null && active.has(String(m.familyId)) ? m.familyId : null }));
  });
}

/** How many items are waiting, how many are stuck, and how many changes the portal keeps that QuickBooks refused, for the Health page. */
export async function queueCounts(): Promise<{ waiting: number; stuck: number; refused: number }> {
  const rows = await db.select({ state: writeQueue.state, n: sql<number>`count(*)::int` }).from(writeQueue).where(inArray(writeQueue.state, ["waiting", "stuck", "refused"])).groupBy(writeQueue.state);
  const n = (state: string) => rows.find((r) => r.state === state)?.n ?? 0;
  return { waiting: n("waiting"), stuck: n("stuck"), refused: n("refused") };
}

export type QueueOp = { actor: Actor; ip: string | null; permission: string };
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const GONE: Done = { ok: false, errors: ["That is no longer waiting: it went through, or was given up. Reload the page."] };
/** Why "Try again now" isn't offered on a family's create to a staff member who may not link families to accounting. */
export const TRY_AGAIN_NEEDS_LINKING = "Trying this again makes the family in QuickBooks and links it to the portal's family, which takes the permission to link families to accounting. Someone who holds it can try it again.";
/** A family's or member's create: trying it again makes a family's customer in QuickBooks and links it (tryAgainNow()). */
export const isFamilyCreateItem = (w: QueuedWrite) => w.op === "create" && (w.role === "family" || w.role === "member");

/**
 * "Try again now": a waiting or stuck item is tried at the worker's next wake, within a minute. A stuck one gets one more
 * try: if that fails too, it is stuck again. The worker does the try, so a staff member never waits on QuickBooks here.
 * A family's or member's create (isFamilyCreateItem()) makes its customer in QuickBooks and links a family to it, so
 * only a staff member who may link families to accounting (`mayLink`, Accounting.Link.ReadWrite: the lead's decision in
 * stage 3's slice 9d) may ask for it, checked here under the item's row lock, as the page offers it.
 */
export async function tryAgainNow(id: string, o: QueueOp & { mayLink?: boolean }): Promise<Done> {
  return db.transaction(async (tx) => {
    const [item] = await tx.select().from(writeQueue).where(and(eq(writeQueue.id, id), inArray(writeQueue.state, ["waiting", "stuck", "refused"]))).for("update");
    if (!item) return GONE;
    // A change QuickBooks refused is never tried again by the worker: it is sent again only on purpose, or given up.
    if (item.state === "refused") return { ok: false as const, errors: [REFUSED_NOT_AGAIN] };
    if (isFamilyCreateItem(item.request) && !o.mayLink) return { ok: false as const, errors: [TRY_AGAIN_NEEDS_LINKING] };
    // A parent's change of their details the portal may not send yet (stage 3's slice 11b): nothing would be sent.
    if (item.request.op === "contact" && !(await contactSendsMayGo(tx))) return { ok: false as const, errors: [CONTACT_AWAITS_READ] };
    // One sender at a time (stage 3's slice 9e): a change saved first that is being sent at this moment (at once, by
    // "Send the portal's value", or by the worker, each holding its lock) isn't asked for again; the lock is held shared
    // to the end of this transaction, so no send starts before this ask is committed.
    if (isSavedFirst(item) && !(await itemLockFree(tx, item))) return { ok: false as const, errors: [BEING_SENT_NOW] };
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
  const [item] = await tx.select().from(writeQueue).where(and(eq(writeQueue.id, id), inArray(writeQueue.state, ["waiting", "stuck", "refused"]))).for("update");
  if (!item) return GONE;
  await tx.update(writeQueue).set({ state: "given_up", note, nextTryAt: null, finishedAt: new Date(), updatedAt: new Date() }).where(eq(writeQueue.id, id));
  // A buy-out whose invoice write is given up waits for the treasurer: its outcome in QuickBooks isn't known.
  if (isBuyoutWrite(item.request)) await tx.update(buyout).set({ state: "stuck", flag: "given_up", flaggedAt: new Date(), updatedAt: new Date() }).where(and(eq(buyout.id, item.request.buyoutId), inArray(buyout.state, ["being_invoiced", "being_voided", "stuck"])));
  await writeAudit({ actor: o.actor, action: "roster.write.given_up", permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: id,
    before: { state: item.state, tries: item.tries, code: item.lastCode, op: item.request.op }, after: { state: "given_up", note } }, tx);
  // A change QuickBooks refused (stage 3's slice 9e) was never made there: the portal keeps its own value.
  if (item.state === "refused") return { ok: true as const, message: refusedGivenUpWords(item) };
  // A guardian's Parent customer change waiting or stuck (stage 3's slice 9h): QuickBooks has it only if a try got through.
  if (guardianOf(item.request) !== null) return { ok: true as const, message: `${refusedGivenUpWords(item)} QuickBooks has the change only if a try got through, which the roster's copy of QuickBooks shows after its next read.` };
  // A rename saved in the portal first (stage 3's slice 9e) left the portal holding the new name already: renaming it
  // back to QuickBooks' name would undo the portal's value, which a change that didn't get through never does.
  // A family's phone and address (stage 3's slice 11b), waiting or stuck: the portal keeps its details.
  if (item.request.op === "contact") return { ok: true as const, message: `${CONTACT_GIVEN_UP} QuickBooks has the change only if a try got through, which the roster's copy of QuickBooks shows after its next read.` };
  if (item.request.op === "move" && isSavedFirst(item)) {
    return { ok: true as const, message: `Given up. Nothing more will be sent for it. The portal keeps the student in the family it moved them to. ${MOVE_FOLLOWED_STAYS} QuickBooks has the move only if a try got through, which the roster's copy of QuickBooks shows after its next read; if it didn't, QuickBooks keeps them where it has them, and until it has the move the family QuickBooks has them under still sees their invoices. ${GIVEN_UP_NEXT.move}` };
  }
  if (item.request.op === "rename" && isSavedFirst(item)) {
    return { ok: true as const, message: "Given up. Nothing more will be sent for it. The portal keeps the name it saved. QuickBooks has it only if a try got through, which the roster's copy of QuickBooks shows after its next read; if it didn't, the two names differ, and a later rename on the record's family's page is checked against QuickBooks' name first: while they differ it is held back and listed on this page, where “Send the portal's value” sends it. Or rename it in QuickBooks." };
  }
  // Since stage 3's slice 9c no roster read changes the app's own records: a roster change QuickBooks did make is in its
  // copy of the roster after the next read, but the portal's own family or student keeps what it had, until staff bring
  // it into line from the family's page (a move or a make-inactive QuickBooks has already sends nothing there).
  return { ok: true as const, message: isBuyoutWrite(item.request) ? "Given up. Nothing more will be sent for it; if QuickBooks did make the change, the next roster refresh shows it."
    : `Given up. Nothing more will be sent for it. If QuickBooks did make the change, the roster's copy of QuickBooks shows it after its next read, but the portal's own family or student stays as it was. ${givenUpNext(item)}`.trim() };
}

/**
 * What staff can do next once a create is given up, by what it was made for: a family or member, or a student, the
 * portal saved first (filed under its record: stage 3's slice 9d) stays in the portal unlinked; any other new customer
 * (a student added to a linked family, a parent, a create queued before slice 9d) has no record in the portal.
 */
function givenUpNext(item: Item): string {
  const w = item.request;
  if (guardianOf(w) !== null) return GUARDIAN_GIVEN_UP[w.op === "create" ? "create" : w.op === "deactivate" ? "deactivate" : w.op === "contact" ? "contact" : "rename"].replace(/^Given up\. Nothing more will be sent for it\. /, "");
  if (w.op !== "create") return GIVEN_UP_NEXT[w.op] ?? "";
  // Given up, it is never linked, even when QuickBooks made it (the lead's decision in stage 3's slice 9d): after the
  // next roster read this page lists a customer it made (madeAfterGivingUp()), and no second one is made for it.
  const readFirst = "After the next roster read, this page says whether QuickBooks made its customer anyway: if it did, nothing is linked to it, and a second one isn't made";
  if ((w.role === "family" || w.role === "member") && item.familyId !== null) {
    return `The ${w.role} the portal saved first stays in the portal, unlinked. ${readFirst} (“Create a family from this” under Customers with no family brings it in); if it didn't, press “Create in QuickBooks and link” on the ${w.role}'s page.`;
  }
  if (w.role === "student" && item.studentId !== null) {
    return `The student the portal saved first stays in the portal, unlinked. ${readFirst} (“Link the student to it” there links the student to it); if it didn't, press “Create in QuickBooks and link” on their family's page.`;
  }
  return "If QuickBooks made the new customer, it has no record in the portal: look for it in QuickBooks.";
}

/**
 * What a refused change given up leaves (stage 3's slice 9e): the portal keeps its own value and QuickBooks its own,
 * and the difference waits for the mapping screen; a student saved first stays in the portal, unlinked.
 */
function refusedGivenUpWords(item: Item): string {
  const w = item.request;
  // A guardian's own Parent customer (stage 3's slice 9h): the guardian's access is the portal's and stays as it is.
  if (guardianOf(w) !== null) return GUARDIAN_GIVEN_UP[w.op === "create" ? "create" : w.op === "deactivate" ? "deactivate" : w.op === "contact" ? "contact" : "rename"];
  if (w.op === "contact") return CONTACT_GIVEN_UP;
  if (w.op === "move") return `Given up. Nothing more will be sent for it. The portal keeps the student in the family it moved them to, and QuickBooks keeps them where it has them: until QuickBooks has the move, the family QuickBooks has them under still sees their invoices. ${MOVE_FOLLOWED_STAYS} ${GIVEN_UP_NEXT.move}`;
  if (w.op === "create") return "Given up. Nothing more will be sent for it. The student the portal saved first stays in the portal, unlinked: to make them in QuickBooks later, press “Create in QuickBooks and link” on their family's page.";
  return "Given up. Nothing more will be sent for it. The portal keeps its own name, and QuickBooks keeps the one it has. A later rename on the record's family's page is checked against QuickBooks' name first: while the two differ it is held back and listed on this page, where “Send the portal's value” sends it. Or rename it in QuickBooks.";
}
/**
 * What giving up a parent's phone and address change leaves (stage 3's slice 11b): the portal keeps its details, and
 * QuickBooks the ones it has, for stage 4's mapping screen to show as a difference.
 */
const CONTACT_GIVEN_UP = "Given up. Nothing more will be sent for it. The portal keeps its own phone and mailing address, and QuickBooks keeps the details it has, for the mapping screen to show as a difference. Or change them in QuickBooks.";
/**
 * What giving up a guardian's Parent customer change leaves (stage 3's slice 9h): the guardian's access in the portal is
 * as the portal has it; a Parent customer left active, or never made, waits for the mapping screen to show the difference.
 */
const GUARDIAN_GIVEN_UP = {
  create: "Given up. Nothing more will be sent for it. The guardian keeps their access in the portal, with no Parent customer of their own in QuickBooks: if QuickBooks made one anyway, nothing in the portal is linked to it, and the mapping screen will show it.",
  deactivate: "Given up. Nothing more will be sent for it. The guardian stays removed in the portal, and their Parent customer stays active in QuickBooks, for the mapping screen to show as a difference. Or make it inactive in QuickBooks once its balance is settled.",
  rename: "Given up. Nothing more will be sent for it. The portal keeps the person's new name, and QuickBooks keeps the name it has on their Parent customer, for the mapping screen to show as a difference. Or rename it in QuickBooks.",
  contact: CONTACT_GIVEN_UP,
} as const;
/** Why "Try again now" isn't taken for a change QuickBooks refused. */
export const REFUSED_NOT_AGAIN = "This change didn't go through and is kept in the portal, so it isn't tried again by itself: use “Send the portal's value” to send it again on purpose, or “Give up”.";

/** A move given up undoes none of its follow-ups, which ran when the portal saved it (slice 9f): said, so staff know a buy-out invoice is voided all the same. */
const MOVE_FOLLOWED_STAYS = "What followed the move when the portal saved it stays as it is: their unfinished forms started again, their places to come given up, any unpaid volunteer buy-out invoice of theirs queued to be voided and any other buy-out of theirs flagged for the club.";

/** What staff can do once a roster change QuickBooks may have made is given up, by what it was (a create: givenUpNext()). */
const GIVEN_UP_NEXT: Partial<Record<QueuedWrite["op"], string>> = {
  move: "To bring the two into line later, move the student again on their family's page: the move is checked against where QuickBooks has them, and a move to the family QuickBooks has them in sends nothing. Or move them in QuickBooks.",
  deactivate: "To bring the portal's own record into line, open the family's page and make them inactive there: nothing is sent when QuickBooks has them inactive already.",
  rename: "To bring the portal's own record into line, rename it on the family's page to the name QuickBooks has: nothing is sent.",
};
