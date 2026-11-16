import { and, eq, isNotNull, isNull } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { jobRun, qboItem, requirement, setting } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { MONEY_JOB, RUN_KEY } from "./run-keys";

/**
 * Called inside clearRosterOfOtherCompanyLocked (src/lib/roster/source.ts), in its transaction, when a different
 * QuickBooks company is connected (family_money itself is deleted there). An item id means another product in another
 * company, and a family id another customer: the stored list of products and services goes, every payment requirement
 * is left with no product or service (staff choose again from the new company's list, and until then it reads "No
 * invoice yet"), and the worker's read of every family forgets where it had got to, ending a run under way. Each
 * choice is still in the audit log, from when it was made.
 */
export async function clearMoneyRecords(tx: Tx, o: { fromRealmId: string; toRealmId: string; actor: Actor; ip: string | null }): Promise<void> {
  const items = await tx.delete(qboItem).returning({ qboId: qboItem.qboId });
  const unset = await tx.update(requirement).set({ itemQboId: null, updatedAt: new Date() }).where(isNotNull(requirement.itemQboId)).returning({ id: requirement.id });
  const ended = await tx.update(jobRun).set({ finishedAt: new Date(), outcome: "failed", detail: "Stopped: a different QuickBooks company was connected. (other_company)" })
    .where(and(eq(jobRun.job, MONEY_JOB), isNull(jobRun.outcome))).returning({ id: jobRun.id });
  await tx.delete(setting).where(eq(setting.key, RUN_KEY));
  if (items.length === 0 && unset.length === 0 && ended.length === 0) return;
  await writeAudit({ actor: o.actor, action: "money.records.cleared", targetType: "setting", ip: o.ip, before: { realmId: o.fromRealmId },
    after: { reason: "different_company", realmId: o.toRealmId, items: items.length, paymentRequirementsLeftWithNoItem: unset.length, runsEnded: ended.length } }, tx);
}
