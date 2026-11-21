import { isNotNull, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { family } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { isUuid } from "@/lib/seasons/ids";

// This module is called from src/lib/roster/source.ts, so it must import nothing from src/lib/roster/.

/**
 * Called inside clearRosterOfOtherCompanyLocked(), under the roster lock, in its transaction (stage 4's slice M7a, open
 * question 16): every link names a customer of the company that is no longer the cache's, so every one ends. It is moved
 * into the link history (`accounting_link_ended`) as it was, with its own id, company, customer, record, origin,
 * `linked_at` and `linked_by`, ended at the database's time, by the staff member who connected the new company (null
 * for anyone else) and `company_changed`, in one statement that deletes it: no live link names the old company, and the
 * audit page's record filter still has what each record was linked to. The links' QuickBooks versions (`synced_token`,
 * `synced_at`) are not carried, as an unlink carries none. The history already there is kept.
 *
 * "Left unlinked" (the accounting links screen's mark, src/lib/families/left-unlinked.ts) was said of the old company's
 * books, so it is cleared too: the new company's are asked afresh on the screen.
 *
 * Nothing else of the app's records changes: every family, student and guardian row stays as it was, with its family.
 * Staff link them to the new company's customers on the accounting links screen. Reached since stage 4's slice M8 by a
 * switch an Admin asked for on the switch page (src/lib/roster/source.ts says how). Audited with counts when there was anything to end or clear.
 */
export async function endLinksOfEarlierCompany(tx: Tx, o: { fromRealmId: string; toRealmId: string; actor: Actor; ip: string | null }): Promise<void> {
  const endedBy = o.actor.door === "staff" && isUuid(o.actor.id) ? o.actor.id : null;
  const moved = Array.from(await tx.execute<{ family_id: string | null; student_id: string | null; guardian_id: string | null }>(sql`
    WITH gone AS (DELETE FROM accounting_link RETURNING *)
    INSERT INTO accounting_link_ended (id, system, realm_id, customer_id, family_id, student_id, guardian_id, origin, linked_at, linked_by, ended_at, ended_by, ended_how)
    SELECT id, system, realm_id, customer_id, family_id, student_id, guardian_id, origin, linked_at, linked_by, statement_timestamp(), ${endedBy}::uuid, 'company_changed'
    FROM gone
    RETURNING family_id, student_id, guardian_id`) as ArrayLike<{ family_id: string | null; student_id: string | null; guardian_id: string | null }>);
  const leftUnlinked = await tx.update(family).set({ accountingLeftUnlinkedAt: null, accountingLeftUnlinkedBy: null, updatedAt: new Date() })
    .where(isNotNull(family.accountingLeftUnlinkedAt)).returning({ id: family.id });
  if (moved.length === 0 && leftUnlinked.length === 0) return;
  await writeAudit({ actor: o.actor, action: "accounting.links.cleared", targetType: "accounting_link", ip: o.ip,
    before: { realmId: o.fromRealmId },
    after: { reason: "different_company", realmId: o.toRealmId, links: moved.length, endedAs: "company_changed",
      familyLinks: moved.filter((l) => l.family_id !== null).length, studentLinks: moved.filter((l) => l.student_id !== null).length,
      guardianLinks: moved.filter((l) => l.guardian_id !== null).length, leftUnlinkedCleared: leftUnlinked.length,
      familiesKept: true, studentsKept: true, membershipsKept: true } }, tx);
}
