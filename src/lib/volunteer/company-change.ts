import type { Tx } from "@/lib/db/client";
import { volunteerCredit, volunteerReminder, volunteerSignup } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";

/**
 * Called inside `clearRosterOfOtherCompanyLocked` (src/lib/roster/source.ts), in its transaction and under the roster
 * lock, when a different QuickBooks company is connected. A sign-up, a credit and a reminder's claim name a family and
 * maybe a student by QuickBooks id, a number that means another customer in the new company: every one is deleted,
 * cancelled sign-ups and removed credit too. The events and shifts are the club's own and stay, with all their places
 * free again and their check-in codes as they were. Each row is still in the audit log, from when it was made.
 *
 * A sign-up and a check-in are written holding the roster lock, shared (src/lib/volunteer/my-volunteer.ts,
 * check-in.ts), and staff corrections hold it outright, so one being made at that moment either commits first and is
 * deleted here, or waits and then finds its family gone from the cache.
 */
export async function clearVolunteerRecords(tx: Tx, o: { fromRealmId: string; toRealmId: string; actor: Actor; ip: string | null }): Promise<void> {
  const reminders = await tx.delete(volunteerReminder).returning({ id: volunteerReminder.id });
  const credits = await tx.delete(volunteerCredit).returning({ removedAt: volunteerCredit.removedAt });
  const gone = await tx.delete(volunteerSignup).returning({ cancelledAt: volunteerSignup.cancelledAt });
  if (gone.length + credits.length + reminders.length === 0) return;
  await writeAudit({ actor: o.actor, action: "volunteer.signups.cleared", targetType: "volunteer_signup", ip: o.ip, before: { realmId: o.fromRealmId },
    after: { reason: "different_company", realmId: o.toRealmId, signups: gone.filter((s) => s.cancelledAt === null).length, cancelledSignups: gone.filter((s) => s.cancelledAt !== null).length,
      credits: credits.filter((c) => c.removedAt === null).length, removedCredits: credits.filter((c) => c.removedAt !== null).length, reminders: reminders.length } }, tx);
}
