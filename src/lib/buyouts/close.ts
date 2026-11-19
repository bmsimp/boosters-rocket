// Staff only: closing a buy-out from Reconciliation or its family's buy-outs page (v1 spec §11.5), called only from
// src/app/staff/(app)/reconciliation/buyout-actions.ts. It sends nothing to QuickBooks and never voids or changes an
// invoice (on a "missing" flag from stored figures alone it first reads the customer's invoices, a GET): it ends the buy-out in the portal, as voided with its own end reason (`closed_by_staff`), so it leaves the
// live indexes (`buyout_family_live_uq`, `buyout_student_live_uq`) and the family can choose again or volunteer. It is allowed only where ./closing.ts says
// no unpaid invoice of the buy-out stands. It gives up a stuck queue item through the queue's own giving up, so it is
// never imported by parent code (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts).
import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { buyout } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { giveUpIn, NOTE_MAX, type QueueOp } from "@/lib/roster/queue";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { currentRosterTag, ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { takePlace } from "@/lib/volunteer/my-volunteer";
import { closeTag, itemsOf, verdictOf } from "./staff";
import { buyoutRecords } from "./standing";
import { invoiceStandsLive } from "./writes";

type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const no = (...errors: string[]): Done => ({ ok: false, errors });

export const CLOSE_COPY = {
  noNote: "Say why, in a few words. The note is kept in the audit log, for staff only.",
  tooLong: `The note is too long (${NOTE_MAX} characters at most).`,
  gone: "That buy-out isn't there any more. Reload the page.",
  changed: "This buy-out has changed since the page was shown, so nothing was closed. Reload the page to see where it stands now.",
  busy: "The roster is being brought up to date from QuickBooks just now, so nothing was closed. Try again in a minute.",
  stands: "QuickBooks shows this invoice again, so nothing was closed: it may still be owed. The next daily check takes the flag off.",
  standsMoved: "QuickBooks still shows this invoice with something on it, so nothing was closed: it may still be owed. Void it in QuickBooks first if it shouldn't be billed, then close it.",
  unreadable: "QuickBooks couldn't be read just now to check the invoice is gone, so nothing was closed. Try again in a minute.",
  done: "Closed. Nothing was sent to QuickBooks. The family can choose to pay instead again, or volunteer.",
} as const;

/**
 * Closes one buy-out. `shownTag` is the buy-out as the page showed it (closeTag) and `rosterTag` the roster's company
 * as the page read it. In one transaction, holding the roster lock shared, as the other buy-out writes do (no refresh or
 * change of company runs between the look and the write): the buy-out and its queue items are read again and locked,
 * the close is refused if the buy-out changed since the page was shown or the rule no longer allows it, its stuck item
 * is given up with the note (giveUpIn), and the buy-out ends, audited with before and after and the note.
 */
export async function closeBuyout(id: string, shownTag: string, rosterTag: string, rawNote: string, o: QueueOp): Promise<Done> {
  const note = rawNote.trim();
  if (!note) return no(CLOSE_COPY.noNote);
  if (note.length > NOTE_MAX) return no(CLOSE_COPY.tooLong);
  // A "missing" flag from one money run's stored figures alone (looks_gone), and a student the daily check found no
  // longer under the family (moved_away), are read again live, before the transaction (no request to QuickBooks is
  // made holding the roster lock); the transaction then refuses if the buy-out changed since.
  let readGone = false;
  const [seen] = await db.select().from(buyout).where(eq(buyout.id, id));
  const liveFirst = (why: string) => why === "looks_gone" || why === "moved_away";
  const shownWhy = seen && closeTag(seen) === shownTag ? verdictOf(seen, (await itemsOf([id])).get(id) ?? []).why : null;
  if (seen && shownWhy !== null && liveFirst(shownWhy)) {
    const live = await invoiceStandsLive(seen);
    if (live !== "gone") return no(live === "unreadable" ? CLOSE_COPY.unreadable : shownWhy === "moved_away" ? CLOSE_COPY.standsMoved : CLOSE_COPY.stands);
    readGone = true;
  }
  const done = await takePlace(async (tx): Promise<Done> => {
    await tx.execute(sql`set local lock_timeout = '10s'`);
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${ROSTER_LOCK})`);
    if ((await currentRosterTag(tx)) !== rosterTag) return no(ROSTER_MOVED);
    // Its queue items first, then the buy-out, in the order the queue's own writes lock them (giveUp, a failed try), so
    // no "Try again now" or worker's claim can slip between the look and the close.
    const items = (await itemsOf([id], tx)).get(id) ?? [];
    const [b] = await tx.select().from(buyout).where(eq(buyout.id, id)).for("update");
    if (!b) return no(CLOSE_COPY.gone);
    if (closeTag(b) !== shownTag) return no(CLOSE_COPY.changed);
    const verdict = verdictOf(b, items);
    if (!verdict.may || (liveFirst(verdict.why) && !readGone)) return no(CLOSE_COPY.changed, verdict.words);
    const given: string[] = [];
    for (const item of items.filter((i) => i.state === "stuck")) {
      const r = await giveUpIn(tx, item.id, note, o);
      if (!r.ok) throw new Error("closeBuyout: a stuck item could not be given up"); // it was read under the same transaction
      given.push(item.id);
    }
    await tx.update(buyout).set({ state: "voided", endReason: "closed_by_staff", flag: null, flaggedAt: null, updatedAt: new Date() }).where(eq(buyout.id, b.id));
    await writeAudit({ actor: o.actor, action: "volunteer.buyout.closed", permission: o.permission, ip: o.ip, targetType: "buyout", targetId: b.id,
      before: { state: b.state, flag: b.flag, code: b.lastCode, invoiceQboId: b.invoiceQboId, amountCents: b.amountCents, ...buyoutRecords(b), requirementId: b.requirementId },
      after: { state: "voided", why: "closed_by_staff", close: verdict.why, ...(readGone ? { readLive: "gone" } : {}), note, givenUp: given } }, tx);
    return { ok: true, message: CLOSE_COPY.done };
  });
  return done === "busy" ? no(CLOSE_COPY.busy) : done;
}
