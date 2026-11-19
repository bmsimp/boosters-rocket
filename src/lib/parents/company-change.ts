import { and, eq, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { guardian, parent, parentAuthSession, parentEmailChange, signinCode } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getParentSettings, putParentSettings, PARENTS_KEY } from "./settings";

// This module is called from src/lib/roster/source.ts, so it must import nothing from src/lib/roster/.

/**
 * Called inside `clearRosterOfOtherCompany`, under the roster lock, as the first part of the clear. QuickBooks IDs are
 * small numbers that mean a different customer in every company, and every guardian row still holds the old company's
 * (`family_qbo_id`, `source_qbo_id`), so every link closes (keeping its old IDs, which nothing matches again), every
 * session, unused code and change of sign-in address goes (each names the app's own family by a `restrict` key, and
 * the app's records go next), "already welcomed" is cleared, and sign-ins and welcomes switch off until an Admin has
 * looked at the new company. Since stage 2 of the app-owned families spec nothing the portal runs reaches this (a
 * different company is refused before the clear); stage 4 decides what a change of company still does to sign-ins.
 */
export async function clearParentAccess(tx: Tx, o: { fromRealmId: string; toRealmId: string; actor: Actor; ip: string | null }): Promise<void> {
  const open = await tx.select({ g: guardian, p: parent }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId))
    .where(ne(guardian.status, "disabled")).orderBy(guardian.id).for("update");

  // A link that had already closed holds the old company's IDs too, so it is marked as well, so it is never taken for
  // one of the new company's. What it was before it closed stays.
  const closedMarked = await tx.update(guardian).set({ disabledReason: "company_changed", updatedAt: new Date() })
    .where(and(eq(guardian.status, "disabled"), sql`${guardian.disabledReason} is distinct from 'company_changed'`)).returning({ id: guardian.id });
  for (const { g } of open) {
    await tx.update(guardian).set({ status: "disabled", disabledReason: "company_changed", statusBeforeDisable: g.status as "invited" | "active", updatedAt: new Date() })
      .where(eq(guardian.id, g.id));
  }
  // Every session, and every change of sign-in address below, names the app's own family it chose or was asked in:
  // they go here, before clearAppRecords() removes the families (their restrict keys would stop it).
  const ended = await tx.delete(parentAuthSession).returning({ id: parentAuthSession.id });
  const codes = await tx.delete(signinCode).where(isNull(signinCode.usedAt)).returning({ id: signinCode.id });
  // A change of sign-in address names the record it would change: another company's customer now (email-change.ts).
  await tx.delete(parentEmailChange);
  const welcomed = await tx.update(parent).set({ welcomedAt: null, updatedAt: new Date() }).where(isNotNull(parent.welcomedAt)).returning({ id: parent.id });
  await tx.update(parent).set({ welcomeOwed: false, welcomeTriedAt: null });
  const before = await getParentSettings(tx);
  await putParentSettings(tx, { ...before, signin: false, welcome: false });
  await writeAudit({ actor: o.actor, action: "parent.access.cleared", targetType: "setting", targetId: PARENTS_KEY, ip: o.ip,
    before: { signin: before.signin, welcome: before.welcome },
    after: { reason: "different_company", fromRealmId: o.fromRealmId, toRealmId: o.toRealmId, signin: false, welcome: false, links: open.length,
      closedLinksMarked: closedMarked.length, people: new Set(open.map((r) => r.p.id)).size, sessionsEnded: ended.length, codesDeleted: codes.length,
      welcomesCleared: welcomed.length } }, tx);
}
