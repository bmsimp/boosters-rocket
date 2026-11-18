import type { Tx } from "@/lib/db/client";
import { buyout, volunteerCredit, volunteerReminder, volunteerSignup } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";

/**
 * Called inside `clearRosterOfOtherCompanyLocked` (src/lib/roster/source.ts), in its transaction and under the roster
 * lock, when a different QuickBooks company is connected, before the app's own families and students are removed: a
 * sign-up, a credit and a reminder's claim name one of them (stage 2 of the app-owned families spec), and the database
 * refuses to remove a record one still names. Every one is deleted, cancelled sign-ups and removed credit too.
 * Nothing the portal runs reaches it until stage 4 ships: a different company is refused wherever one is connected or
 * read (open question 18), and stage 4 replaces it, when a change of company clears only links and the money cache.
 * The events and shifts are the club's own and stay, with all their places free again and their check-in codes as
 * they were. Each row is still in the audit log, from when it was made. Every buy-out goes too (src/lib/buyouts/): its
 * customer, item and invoice are the old company's; its queued invoice writes go with the write queue's own clearing
 * there.
 *
 * A sign-up and a check-in are written holding the roster lock, shared (src/lib/volunteer/my-volunteer.ts,
 * check-in.ts), and staff corrections hold it outright, so one being made at that moment either commits first and is
 * deleted here, or waits and then finds its family gone from the cache.
 */
export async function clearVolunteerRecords(tx: Tx, o: { fromRealmId: string; toRealmId: string; actor: Actor; ip: string | null }): Promise<void> {
  const reminders = await tx.delete(volunteerReminder).returning({ id: volunteerReminder.id });
  const credits = await tx.delete(volunteerCredit).returning({ removedAt: volunteerCredit.removedAt });
  const gone = await tx.delete(volunteerSignup).returning({ cancelledAt: volunteerSignup.cancelledAt });
  const buyouts = await tx.delete(buyout).returning({ id: buyout.id });
  if (gone.length + credits.length + reminders.length + buyouts.length === 0) return;
  await writeAudit({ actor: o.actor, action: "volunteer.signups.cleared", targetType: "volunteer_signup", ip: o.ip, before: { realmId: o.fromRealmId },
    after: { reason: "different_company", realmId: o.toRealmId, signups: gone.filter((s) => s.cancelledAt === null).length, cancelledSignups: gone.filter((s) => s.cancelledAt !== null).length,
      credits: credits.filter((c) => c.removedAt === null).length, removedCredits: credits.filter((c) => c.removedAt !== null).length, reminders: reminders.length,
      buyouts: buyouts.length } }, tx);
}
