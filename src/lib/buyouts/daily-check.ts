// Staff and worker only: the daily check of every buy-out's invoice (v1 spec §8.4, the buy-out line), after the
// worker's read of every family (src/lib/money/sweep.ts). It reads every family's buy-outs, so it is never imported by
// parent code (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts). It asks QuickBooks nothing itself: it
// compares each invoiced buy-out with the figures that run has just stored for its family; the voids it asks for go
// through the write queue (./writes.ts).
import "server-only";
import { and, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { buyout, jobRun, qboCustomer, setting } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { linksOf } from "@/lib/families/links";
import { WORKER_ACTOR } from "@/lib/quickbooks/client";
import { MONEY_JOB } from "@/lib/money/run-keys";
import { moneyRows } from "@/lib/money/stored";
import { getRosterSource } from "@/lib/roster/source";
import { judgeInvoice } from "./rules";
import { buyoutRecords } from "./standing";
import { markBuyoutMoneyStale, queueVoid } from "./writes";

export const BUYOUT_CHECK_JOB = "buyouts.check";
/** The money run the check last followed: `{ runId }`, so each run is followed once. */
export const CHECKED_KEY = "buyouts.checked";

/** What one check did: buy-outs marked paid, flagged, ended as voided in QuickBooks, set to be voided, and unflagged. */
export type BuyoutCheck = { ran: boolean; paid: number; flagged: number; voided: number; voiding: number; unflagged: number };
const NOT_RUN: BuyoutCheck = { ran: false, paid: 0, flagged: 0, voided: 0, voiding: 0, unflagged: 0 };

/**
 * Follows the latest money run that read every family, once: each invoiced buy-out of the connected company whose
 * family that run read is judged by what it stored (judgeInvoice). Paid ones become paid; one voided in QuickBooks
 * ends as voided (nothing is owed for it); one QuickBooks no longer shows, or shows on another customer, is flagged for
 * the Reconciliation page with the family, the requirement and the amount, and audited once (a flag already set is not
 * audited again), and that flag is taken off, audited, once a later run finds the invoice where it belongs. Figures
 * marked behind since they were read (an invoice made or voided after the run read the family) are not judged. A
 * per-student one whose student QuickBooks moved to another family has its void put on the write queue, as a move made
 * in the portal does: the worker reads the invoice live and voids it only when nothing is paid on it, so the new family
 * is never left an invoice for the old family's choice. A paid buy-out is not judged: stored figures keep paid
 * invoices for 12 months only, so its invoice dropping out says nothing. `ran` is true when it followed a run.
 */
export async function checkBuyoutInvoices(): Promise<BuyoutCheck> {
  const [run] = await db.select().from(jobRun).where(and(eq(jobRun.job, MONEY_JOB), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1);
  if (!run) return NOT_RUN;
  const [seen] = await db.select().from(setting).where(eq(setting.key, CHECKED_KEY));
  if ((seen?.value as { runId?: unknown } | undefined)?.runId === run.id) return NOT_RUN;
  const source = await getRosterSource();
  const rows = source === null ? [] : await db.select().from(buyout).where(and(eq(buyout.state, "invoiced"), eq(buyout.realmId, source)));
  // The family that chose each buy-out is the app's record; its stored figures are still kept by its customer, found
  // through the record's link (until the money slice), and the roster still says where a student is by QuickBooks ids
  // (until stage 3), so a move is read as the cache has it: the invoice's customer no longer under the family's own.
  const links = await linksOf({ families: [...new Set(rows.map((b) => b.familyId))], students: [] });
  const money = await moneyRows([...new Set(links.customerOfFamily.values())]);
  const customers = rows.length === 0 ? [] : await db.select({ qboId: qboCustomer.qboId, parentQboId: qboCustomer.parentQboId, active: qboCustomer.active }).from(qboCustomer)
    .where(inArray(qboCustomer.qboId, [...new Set(rows.map((b) => b.customerQboId))]));
  let paid = 0, flagged = 0, voided = 0, voiding = 0, unflagged = 0;
  for (const b of rows) {
    if (!b.invoiceQboId) continue;
    // A family with no link in the roster's company can't be compared with anything: it is left for a later run.
    const familyQboId = links.customerOfFamily.get(b.familyId);
    if (familyQboId === undefined) continue;
    const perStudent = b.studentId !== null;
    const c = customers.find((x) => x.qboId === b.customerQboId);
    const stillTheFamilys = Boolean(c?.active && c.parentQboId === familyQboId);
    if (perStudent && !stillTheFamilys) {
      // Moved in QuickBooks: the roster cache says so, whatever the figures hold. Its void goes on the queue once; a
      // void that found something paid has flagged it, and it is left for the treasurer.
      if (b.flag === "student_moved") continue;
      if (await db.transaction((tx) => queueVoid(tx, b, "student_moved", { actor: WORKER_ACTOR, label: "student moved", nextTryAt: new Date() }))) voiding++;
      continue;
    }
    const row = money.get(familyQboId);
    // Only a family this run read, from this company: older figures may be from before the invoice was made, and so
    // may figures marked behind since they were read.
    if (!row?.readAt || !row.invoices || row.realmId !== source || row.readAt < run.startedAt || (row.staleAt && row.staleAt >= row.readAt)) continue;
    const verdict = judgeInvoice({ invoiceQboId: b.invoiceQboId, customerQboId: b.customerQboId, perStudent }, row.invoices, stillTheFamilys);
    await db.transaction(async (tx) => {
      if (verdict === "ok" || verdict === "student_moved") {
        // A flag of this check's own that the figures no longer bear out (the invoice was made after the family was read).
        if (b.flag !== "missing" && b.flag !== "other_customer") return;
        const [cleared] = await tx.update(buyout).set({ flag: null, flaggedAt: null, updatedAt: new Date() })
          .where(and(eq(buyout.id, b.id), eq(buyout.state, "invoiced"), eq(buyout.flag, b.flag))).returning({ id: buyout.id });
        if (!cleared) return;
        unflagged++;
        await writeAudit({ actor: WORKER_ACTOR, action: "volunteer.buyout.unflagged", targetType: "buyout", targetId: b.id, before: { flag: b.flag },
          after: { flag: null, invoiceQboId: b.invoiceQboId, runId: run.id } }, tx);
        return;
      }
      if (verdict === "paid") {
        // The figures show it, paid: a flag of this check's own (missing, other_customer) is borne out no more. A flag a
        // void or a move set (paid_before_void, student_moved) is the treasurer's to settle, and stays.
        const ownFlag = b.flag === "missing" || b.flag === "other_customer";
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
  return { ran: true, paid, flagged, voided, voiding, unflagged };
}
