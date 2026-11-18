import { isNotNull } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { accountingLink, family, guardian, student } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";

// This module is called from src/lib/roster/source.ts, so it must import nothing from src/lib/roster/.

/**
 * Called inside clearRosterOfOtherCompanyLocked(), under the roster lock: the app's own records and their links were
 * made from the company that is no longer the cache's, and a link names that company's customers, so every one goes,
 * with the families and students and each guardian row's family. Until stage 4 nothing else remembers them: the next
 * roster read makes them again from the new company (keepAppRecordsInStep(), ./in-step.ts), in the transaction that
 * stores its cache. Audited with counts when there was anything to clear.
 */
export async function clearAppRecords(tx: Tx, o: { fromRealmId: string; toRealmId: string; actor: Actor; ip: string | null }): Promise<void> {
  const memberships = (await tx.update(guardian).set({ familyId: null }).where(isNotNull(guardian.familyId)).returning({ id: guardian.id })).length;
  const links = (await tx.delete(accountingLink).returning({ id: accountingLink.id })).length;
  const students = (await tx.delete(student).returning({ id: student.id })).length;
  const families = (await tx.delete(family).returning({ id: family.id })).length;
  if (memberships + links + students + families === 0) return;
  await writeAudit({ actor: o.actor, action: "accounting.links.cleared", targetType: "accounting_link", ip: o.ip,
    before: { realmId: o.fromRealmId }, after: { reason: "different_company", realmId: o.toRealmId, links, families, students, memberships } }, tx);
}
