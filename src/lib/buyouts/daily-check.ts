// Staff and worker only: the daily check of every buy-out's invoice (v1 spec §8.4, the buy-out line), after the
// worker's read of every family (src/lib/money/sweep.ts). It reads every family's buy-outs, so it is never imported by
// parent code (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts). It asks QuickBooks nothing itself: it
// compares each invoiced buy-out with the figures that run has just stored for its family; the voids it asks for go
// through the write queue (./writes.ts).
import "server-only";
import { and, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { buyout, jobRun, qboCustomer, setting, writeQueue } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { linksOf } from "@/lib/families/links";
import { WORKER_ACTOR } from "@/lib/quickbooks/client";
import { MONEY_JOB } from "@/lib/money/run-keys";
import { moneyRows } from "@/lib/money/stored";
import { getRosterSource } from "@/lib/roster/source";
import { movedAwayByTheCheck } from "./closing";
import { judgeInvoice } from "./rules";
import { buyoutRecords } from "./standing";
import { markBuyoutMoneyStale } from "./writes";

export const BUYOUT_CHECK_JOB = "buyouts.check";
/** The money run the check last followed: `{ runId }`, so each run is followed once. */
export const CHECKED_KEY = "buyouts.checked";

/** What one check did: buy-outs marked paid, flagged, ended as voided in QuickBooks, and unflagged. */
export type BuyoutCheck = { ran: boolean; paid: number; flagged: number; voided: number; unflagged: number };
const NOT_RUN: BuyoutCheck = { ran: false, paid: 0, flagged: 0, voided: 0, unflagged: 0 };

/**
 * Flags a per-student buy-out whose customer QuickBooks no longer holds active and directly under the family's, once
 * (a row flagged so already, or by a void, is left as it is), audited in the same transaction. Nothing is sent or
 * queued. Returns whether it flagged it.
 */
async function flagMovedAway(b: typeof buyout.$inferSelect, runId: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [marked] = await tx.update(buyout).set({ flag: "student_moved", flaggedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(buyout.id, b.id), eq(buyout.state, "invoiced"), or(isNull(buyout.flag), inArray(buyout.flag, ["missing", "other_customer"])))).returning({ id: buyout.id });
    if (!marked) return false;
    await writeAudit({ actor: WORKER_ACTOR, action: "volunteer.buyout.flagged", targetType: "buyout", targetId: b.id, before: { flag: b.flag },
      after: { flag: "student_moved", why: "not_under_the_family", ...buyoutRecords(b), requirementId: b.requirementId, invoiceQboId: b.invoiceQboId, amountCents: b.amountCents, runId } }, tx);
    return true;
  });
}

/**
 * Follows the latest money run that read every family, once: each invoiced buy-out of the connected company whose
 * family that run read is judged by what it stored (judgeInvoice). Paid ones become paid; one voided in QuickBooks
 * ends as voided (nothing is owed for it); one QuickBooks no longer shows, or shows on another customer, is flagged for
 * the Reconciliation page with the family, the requirement and the amount, and audited once (a flag already set is not
 * audited again), and that flag is taken off, audited, once a later run finds the invoice where it belongs (its own
 * `student_moved` too, once the student is back under the family: movedAwayByTheCheck(), ./closing.ts). Figures
 * marked behind since they were read (an invoice made or voided after the run read the family) are not judged. Nor is
 * a per-student one whose student QuickBooks holds under another family or inactive: the check voids nothing for a
 * move made in QuickBooks (stage 3's slice 9c), and the family's figures hold no invoice of that customer to judge it
 * by, so it is flagged once (`student_moved`, flagMovedAway()) for Reconciliation, where staff void it in QuickBooks
 * and close it once a live read finds it voided or gone (./closing.ts). What a buy-out bills still follows QuickBooks'
 * tree (open question 14). A paid buy-out is not judged: stored figures keep paid
 * invoices for 12 months only, so its invoice dropping out says nothing. `ran` is true when it followed a run.
 */
export async function checkBuyoutInvoices(): Promise<BuyoutCheck> {
  const [run] = await db.select().from(jobRun).where(and(eq(jobRun.job, MONEY_JOB), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1);
  if (!run) return NOT_RUN;
  const [seen] = await db.select().from(setting).where(eq(setting.key, CHECKED_KEY));
  if ((seen?.value as { runId?: unknown } | undefined)?.runId === run.id) return NOT_RUN;
  const source = await getRosterSource();
  const rows = source === null ? [] : await db.select().from(buyout).where(and(eq(buyout.state, "invoiced"), eq(buyout.realmId, source)));
  // The family that chose each buy-out is the app's record, and its stored figures are kept by that record; whose
  // invoices they hold is still QuickBooks' tree (open question 14), read through the record's link: an invoice's
  // customer no longer active and directly under the family's own isn't among them.
  const families = [...new Set(rows.map((b) => b.familyId))];
  const [links, money] = await Promise.all([linksOf({ families, students: [] }), moneyRows(families)]);
  const customers = rows.length === 0 ? [] : await db.select({ qboId: qboCustomer.qboId, parentQboId: qboCustomer.parentQboId, active: qboCustomer.active }).from(qboCustomer)
    .where(inArray(qboCustomer.qboId, [...new Set(rows.map((b) => b.customerQboId))]));
  // The buy-outs a void was ever queued for: a `student_moved` flag beside one is a move's or a void's, never the check's own.
  const voidsFor = rows.length === 0 ? new Set<string>() : new Set((await db.select({ id: sql<string>`${writeQueue.request}->>'buyoutId'` }).from(writeQueue)
    .where(and(sql`${writeQueue.request}->>'op' = 'invoice_void'`, inArray(sql<string>`${writeQueue.request}->>'buyoutId'`, rows.map((b) => b.id))))).map((r) => r.id));
  let paid = 0, flagged = 0, voided = 0, unflagged = 0;
  for (const b of rows) {
    if (!b.invoiceQboId) continue;
    // A family with no link in the roster's company can't be compared with anything: it is left for a later run.
    const familyQboId = links.customerOfFamily.get(b.familyId);
    if (familyQboId === undefined) continue;
    const perStudent = b.studentId !== null;
    const c = customers.find((x) => x.qboId === b.customerQboId);
    const stillTheFamilys = Boolean(c?.active && c.parentQboId === familyQboId);
    // Billed to a customer QuickBooks no longer holds active and directly under the family's (moved, or made inactive,
    // in QuickBooks): the family's figures don't hold that customer's invoices, so they say nothing about it. A move
    // made in QuickBooks is no longer followed (stage 3's slice 9c): nothing is voided for it (stage 4 shows it as a
    // difference; a move staff make voids it then, buyoutsForMovedStudent(), ./moved.ts). It is flagged for staff once
    // (`student_moved`), so Reconciliation lists it and its close can read the invoice live (./closing.ts, `moved_away`).
    if (perStudent && !stillTheFamilys) {
      if (b.flag !== null && b.flag !== "missing" && b.flag !== "other_customer") continue; // a void's or a move's flag stays
      if (await flagMovedAway(b, run.id)) flagged++;
      continue;
    }
    const row = money.get(b.familyId);
    // Only a family this run read, from this company: older figures may be from before the invoice was made, and so
    // may figures marked behind since they were read.
    if (!row?.readAt || !row.invoices || row.realmId !== source || row.readAt < run.startedAt || (row.staleAt && row.staleAt >= row.readAt)) continue;
    const verdict = judgeInvoice({ invoiceQboId: b.invoiceQboId, customerQboId: b.customerQboId, perStudent }, row.invoices, stillTheFamilys);
    // A flag of this check's own: an invoice it didn't find, or found on another customer, and a student it found no
    // longer under the family, who is back (stillTheFamilys, or this point isn't reached).
    const ownFlag = b.flag === "missing" || b.flag === "other_customer"
      || movedAwayByTheCheck({ state: b.state, flag: b.flag, lastCode: b.lastCode, items: voidsFor.has(b.id) ? [{ op: "invoice_void" }] : [] });
    await db.transaction(async (tx) => {
      if (verdict === "ok" || verdict === "student_moved") {
        // A flag of this check's own that the figures no longer bear out (the invoice was made after the family was read,
        // or the student is back under the family in QuickBooks).
        if (!ownFlag || b.flag === null) return;
        const [cleared] = await tx.update(buyout).set({ flag: null, flaggedAt: null, updatedAt: new Date() })
          .where(and(eq(buyout.id, b.id), eq(buyout.state, "invoiced"), eq(buyout.flag, b.flag))).returning({ id: buyout.id });
        if (!cleared) return;
        unflagged++;
        await writeAudit({ actor: WORKER_ACTOR, action: "volunteer.buyout.unflagged", targetType: "buyout", targetId: b.id, before: { flag: b.flag },
          after: { flag: null, invoiceQboId: b.invoiceQboId, runId: run.id } }, tx);
        return;
      }
      if (verdict === "paid") {
        // The figures show it, paid: a flag of this check's own (missing, other_customer, its own student_moved) is borne
        // out no more. A flag a void or a staff move set (paid_before_void, their student_moved) is the treasurer's to
        // settle, and stays.
        const [done] = await tx.update(buyout).set({ state: "paid", ...(ownFlag ? { flag: null, flaggedAt: null } : {}), updatedAt: new Date() })
          .where(and(eq(buyout.id, b.id), eq(buyout.state, "invoiced"))).returning({ id: buyout.id });
        if (!done) return;
        paid++;
        await writeAudit({ actor: WORKER_ACTOR, action: "volunteer.buyout.paid", targetType: "buyout", targetId: b.id, before: { state: "invoiced", ...(ownFlag ? { flag: b.flag } : {}) },
          after: { state: "paid", ...(ownFlag ? { flag: null } : {}), invoiceQboId: b.invoiceQboId, amountCents: b.amountCents, runId: run.id } }, tx);
        return;
      }
      if (verdict === "voided") {
        // Voided in QuickBooks (the treasurer cancelled it there): nothing is owed, and the family may volunteer or choose again.
        const [ended] = await tx.update(buyout).set({ state: "voided", endReason: "voided_in_quickbooks", flag: null, flaggedAt: null, updatedAt: new Date() })
          .where(and(eq(buyout.id, b.id), eq(buyout.state, "invoiced"))).returning({ id: buyout.id });
        if (!ended) return;
        voided++;
        await markBuyoutMoneyStale(tx, b);
        await writeAudit({ actor: WORKER_ACTOR, action: "volunteer.buyout.voided", targetType: "buyout", targetId: b.id,
          before: { state: "invoiced", invoiceQboId: b.invoiceQboId, amountCents: b.amountCents }, after: { state: "voided", why: "voided_in_quickbooks", runId: run.id } }, tx);
        return;
      }
      if (b.flag === verdict) return;
      // Only a row not flagged so already: two wakes following the same run both read it unflagged, and the second's
      // update, made once the first's is committed, then changes nothing and audits nothing.
      const [marked] = await tx.update(buyout).set({ flag: verdict, flaggedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(buyout.id, b.id), eq(buyout.state, "invoiced"), or(isNull(buyout.flag), ne(buyout.flag, verdict)))).returning({ id: buyout.id });
      if (!marked) return;
      flagged++;
      await writeAudit({ actor: WORKER_ACTOR, action: "volunteer.buyout.flagged", targetType: "buyout", targetId: b.id, before: { flag: b.flag },
        after: { flag: verdict, ...buyoutRecords(b), requirementId: b.requirementId, invoiceQboId: b.invoiceQboId, amountCents: b.amountCents, runId: run.id } }, tx);
    });
  }
  const value = { runId: run.id };
  await db.insert(setting).values({ key: CHECKED_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } });
  return { ran: true, paid, flagged, voided, unflagged };
}
