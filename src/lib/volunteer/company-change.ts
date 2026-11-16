import type { Tx } from "@/lib/db/client";
import { volunteerSignup } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";

/**
 * Called inside `clearRosterOfOtherCompanyLocked` (src/lib/roster/source.ts), in its transaction and under the roster
 * lock, when a different QuickBooks company is connected. A sign-up names a family and maybe a student by
 * QuickBooks id, a number that means another customer in the new company: every sign-up is deleted, cancelled ones
 * too. The events and shifts are the club's own and stay, with all their places free again. Each sign-up is still in
 * the audit log, from when it was made.
 *
 * A sign-up is written holding the roster lock, shared (src/lib/volunteer/my-volunteer.ts), so one being made at that
 * moment either commits first and is deleted here, or waits and then finds its family gone from the cache.
 */
export async function clearVolunteerRecords(tx: Tx, o: { fromRealmId: string; toRealmId: string; actor: Actor; ip: string | null }): Promise<void> {
  const gone = await tx.delete(volunteerSignup).returning({ cancelledAt: volunteerSignup.cancelledAt });
  if (gone.length === 0) return;
  await writeAudit({ actor: o.actor, action: "volunteer.signups.cleared", targetType: "volunteer_signup", ip: o.ip, before: { realmId: o.fromRealmId },
    after: { reason: "different_company", realmId: o.toRealmId, signups: gone.filter((s) => s.cancelledAt === null).length, cancelledSignups: gone.filter((s) => s.cancelledAt !== null).length } }, tx);
}
