import type { Tx } from "@/lib/db/client";
import { requirementCover, requirementProgress, requirementReminder } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";

/**
 * Called inside `clearRosterOfOtherCompanyLocked` (src/lib/roster/source.ts), in its transaction, before the app's own
 * families and students are removed: every tick, waiver, chosen list entry and due-date reminder claim names one of
 * them (stage 2 of the app-owned families spec), and the database refuses to remove a record a season row still names.
 * The seasons, steps and requirements are the club's own and stay. A requirement that was asked of a chosen list
 * stays that way with nobody on it, and never becomes one asked of everyone. Each tick and waiver is still in the
 * audit log, from when it was made.
 *
 * Nothing the portal runs reaches it until stage 4 ships: a different company is refused wherever one is connected or
 * read (open question 18). Stage 4 replaces it, when a change of company clears only links and the money cache.
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
