import type { Tx } from "@/lib/db/client";
import { requirementCover, requirementProgress, requirementReminder } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";

/**
 * Called inside `clearRosterOfOtherCompanyLocked` (src/lib/roster/source.ts), in its transaction, when a different
 * QuickBooks company is connected. QuickBooks IDs are small numbers that mean a different customer in every company,
 * so nothing a season keeps against them may survive: a tick or a waiver would pass to whoever has the same number in
 * the new company, and a chosen list would show its requirement to another family. Every tick, waiver and chosen list
 * entry is deleted. The seasons, steps and requirements are the club's own and stay. A requirement that was asked of a
 * chosen list stays that way with nobody on it, asked of nobody until staff choose from the new roster, and never
 * becomes one asked of everyone. Each tick and waiver is still in the audit log, from when it was made. The claims of
 * the due-date reminders (requirement_reminder, ./due-reminders.ts) name a family by its QuickBooks id, and go too.
 */
export async function clearSeasonRecords(tx: Tx, o: { fromRealmId: string; toRealmId: string; actor: Actor; ip: string | null }): Promise<void> {
  const progress = await tx.delete(requirementProgress).returning({ metAt: requirementProgress.metAt, waivedAt: requirementProgress.waivedAt });
  const covers = await tx.delete(requirementCover).returning({ requirementId: requirementCover.requirementId });
  const reminders = await tx.delete(requirementReminder).returning({ id: requirementReminder.id });
  if (progress.length === 0 && covers.length === 0 && reminders.length === 0) return;
  await writeAudit({ actor: o.actor, action: "season.records.cleared", targetType: "season", ip: o.ip,
    before: { realmId: o.fromRealmId },
    after: { reason: "different_company", realmId: o.toRealmId, ticks: progress.filter((p) => p.metAt !== null).length, waivers: progress.filter((p) => p.waivedAt !== null).length,
      chosenListEntries: covers.length, requirementsLeftWithNobodyChosen: new Set(covers.map((c) => c.requirementId)).size,
      ...(reminders.length > 0 ? { dueReminderClaims: reminders.length } : {}) } }, tx);
}
