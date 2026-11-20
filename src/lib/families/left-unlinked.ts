// The accounting links screen's "Left unlinked" mark on a family (stage 4's slice M3a of
// docs/superpowers/specs/2026-11-18-app-owned-families-design.md, section 4: "Left unlinked (kept out of the bulk
// button)"): `family.accounting_left_unlinked_at` and `_by`. A family that gains a family link is no longer one staff
// chose to leave with none, so every path that gives an existing family record its family link clears the mark, in
// the transaction that makes the link. Those paths are exactly two (every `insert(accountingLink)` with a `familyId`
// under src/, as of slice M3a):
// - linkFamilyToCustomer() (src/lib/accounting/link-writes.ts): Confirm and Pick a different customer, on the screen;
// - changeOwnRecord()'s family branch with `o.familyId` (src/lib/roster/writes.ts): the record staff saved first linked
//   to the customer its create made, whether the create was sent at once (an add on Families by a holder of the
//   linking permission, "Create in QuickBooks and link") or finished by the queue (applyWritten(), foundDone()).
// The import (src/lib/families/roster-import.ts: "Create a family from this", narrowed, or a whole run) and
// changeOwnRecord()'s create filed under no record only make new families, which carry no mark. A new path that links an
// existing family record calls this too. Imports nothing but the schema, so both callers may import it without a cycle.
import { and, eq, isNotNull } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { family } from "@/lib/db/schema";
import type { AppFamilyId } from "./ids";

/**
 * Clears the family's Left unlinked mark, in the caller's transaction. True when it was set (the caller's audit row then
 * says `leftUnlinkedCleared: true`), false when there was none. It writes no audit row of its own: the link's row says it.
 */
export async function clearLeftUnlinked(tx: Tx, familyId: AppFamilyId): Promise<boolean> {
  const cleared = await tx.update(family).set({ accountingLeftUnlinkedAt: null, accountingLeftUnlinkedBy: null, updatedAt: new Date() })
    .where(and(eq(family.id, familyId), isNotNull(family.accountingLeftUnlinkedAt))).returning({ id: family.id });
  return cleared.length > 0;
}
