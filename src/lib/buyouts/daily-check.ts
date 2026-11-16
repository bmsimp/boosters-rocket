// Staff and worker only: the daily check of every buy-out's invoice (v1 spec §8.4, the buy-out line), after the
// worker's read of every family (src/lib/money/sweep.ts). It reads every family's buy-outs, so it is never imported by
// parent code (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts). It asks QuickBooks nothing itself: it
// compares each invoiced buy-out with the figures that run has just stored for its family.
import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { buyout, jobRun, qboCustomer, setting } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { WORKER_ACTOR } from "@/lib/quickbooks/client";
import { MONEY_JOB } from "@/lib/money/run-keys";
import { moneyRows } from "@/lib/money/stored";
import { getRosterSource } from "@/lib/roster/source";

export const BUYOUT_CHECK_JOB = "buyouts.check";
/** The money run the check last followed: `{ runId }`, so each run is followed once. */
export const CHECKED_KEY = "buyouts.checked";

type Flag = "missing" | "other_customer" | "student_moved";

/**
 * What the figures a run stored say about one invoiced buy-out, pure: `paid` (its balance is 0), `ok` (still there,
 * on its customer, with something to pay), or a flag: the invoice is on another customer than the buy-out's
 * (`other_customer`), or QuickBooks no longer shows it to the family, because it was voided or deleted there
 * (`missing`) or because the student it was billed to has moved to another family (`student_moved`).
 */
export function judgeInvoice(b: { invoiceQboId: string; customerQboId: string; perStudent: boolean },
  invoices: readonly { qboId: string; customerQboId: string; totalCents: number; balanceCents: number }[], customerStillTheFamilys: boolean): "paid" | "ok" | Flag {
  const inv = invoices.find((i) => i.qboId === b.invoiceQboId);
  if (!inv) return b.perStudent && !customerStillTheFamilys ? "student_moved" : "missing";
  if (inv.customerQboId !== b.customerQboId) return "other_customer";
  if (inv.totalCents > 0 && inv.balanceCents <= 0) return "paid";
  return "ok";
}

/**
 * Follows the latest money run that read every family, once: each invoiced buy-out of the connected company whose
 * family that run read is judged by what it stored (judgeInvoice). Paid ones become paid; one QuickBooks no longer
 * shows is flagged for the Reconciliation page with the family, the requirement and the amount, and audited once (a
 * flag already set is not audited again). A paid buy-out is not judged: stored figures keep paid invoices for 12 months
 * only, so its invoice dropping out says nothing. Nothing is voided here. True when it followed a run.
 */
export async function checkBuyoutInvoices(): Promise<{ ran: boolean; paid: number; flagged: number }> {
  const [run] = await db.select().from(jobRun).where(and(eq(jobRun.job, MONEY_JOB), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1);
  if (!run) return { ran: false, paid: 0, flagged: 0 };
  const [seen] = await db.select().from(setting).where(eq(setting.key, CHECKED_KEY));
  if ((seen?.value as { runId?: unknown } | undefined)?.runId === run.id) return { ran: false, paid: 0, flagged: 0 };
  const source = await getRosterSource();
  const rows = source === null ? [] : await db.select().from(buyout).where(and(eq(buyout.state, "invoiced"), eq(buyout.realmId, source)));
  const money = await moneyRows([...new Set(rows.map((b) => b.familyQboId))]);
  const customers = rows.length === 0 ? [] : await db.select({ qboId: qboCustomer.qboId, parentQboId: qboCustomer.parentQboId, active: qboCustomer.active }).from(qboCustomer)
    .where(inArray(qboCustomer.qboId, [...new Set(rows.map((b) => b.customerQboId))]));
  let paid = 0, flagged = 0;
  for (const b of rows) {
    const row = money.get(b.familyQboId);
    // Only a family this run read, from this company: older figures may be from before the invoice was made.
    if (!b.invoiceQboId || !row?.readAt || !row.invoices || row.realmId !== source || row.readAt < run.startedAt) continue;
    const perStudent = b.subjectQboId !== b.familyQboId;
    const c = customers.find((x) => x.qboId === b.customerQboId);
    const verdict = judgeInvoice({ invoiceQboId: b.invoiceQboId, customerQboId: b.customerQboId, perStudent }, row.invoices, Boolean(c?.active && c.parentQboId === b.familyQboId));
    if (verdict === "ok") continue;
    await db.transaction(async (tx) => {
      if (verdict === "paid") {
        const [done] = await tx.update(buyout).set({ state: "paid", updatedAt: new Date() }).where(and(eq(buyout.id, b.id), eq(buyout.state, "invoiced"))).returning({ id: buyout.id });
        if (!done) return;
        paid++;
        await writeAudit({ actor: WORKER_ACTOR, action: "volunteer.buyout.paid", targetType: "buyout", targetId: b.id, before: { state: "invoiced" },
          after: { state: "paid", invoiceQboId: b.invoiceQboId, amountCents: b.amountCents, runId: run.id } }, tx);
        return;
      }
      if (b.flag === verdict) return;
      const [marked] = await tx.update(buyout).set({ flag: verdict, flaggedAt: new Date(), updatedAt: new Date() }).where(and(eq(buyout.id, b.id), eq(buyout.state, "invoiced"))).returning({ id: buyout.id });
      if (!marked) return;
      flagged++;
      await writeAudit({ actor: WORKER_ACTOR, action: "volunteer.buyout.flagged", targetType: "buyout", targetId: b.id, before: { flag: b.flag },
        after: { flag: verdict, familyQboId: b.familyQboId, requirementId: b.requirementId, invoiceQboId: b.invoiceQboId, amountCents: b.amountCents, runId: run.id } }, tx);
    });
  }
  const value = { runId: run.id };
  await db.insert(setting).values({ key: CHECKED_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } });
  return { ran: true, paid, flagged };
}
