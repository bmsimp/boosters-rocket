import { db } from "@/lib/db/client";
import { accountingLink, qboCustomer } from "@/lib/db/schema";
import { QUICKBOOKS, type AppFamilyId } from "@/lib/families/ids";
import { unlinkFamily } from "@/lib/accounting/link-writes";
import { loadAccountingLinks } from "@/lib/accounting/mapping";
import { getRosterSource } from "@/lib/roster/source";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { staffWith } from "./roster-writes";

/**
 * Stage 4's slice M3b: a family unlinked through the press itself (unlinkFamily(), with the stamp its row on Accounting
 * links offers now), by a staff member holding the linking permission and Roster.Read; it throws with the words when
 * the press is refused. Nothing after it may run the whole import (syncAppRecords()): it would make a second family,
 * carried over, for the old customer.
 */
export async function unlinkThroughThePress(familyId: AppFamilyId, staff: { id: string; email: string }): Promise<string> {
  const row = (await loadAccountingLinks()).rows.find((r) => String(r.familyId) === String(familyId));
  if (!row?.unlink) throw new Error(`the family ${String(familyId)} has no Unlink from the books offered: ${row ? row.status.key : "no row"}`);
  const r = await unlinkFamily({ familyId: String(familyId), linkId: row.unlink.linkId, stamp: row.unlink.stamp }, await currentRosterTag(),
    { actor: { door: "staff", id: staff.id, label: staff.email }, ip: null, permission: "Accounting.Link.ReadWrite", staffUserId: staff.id });
  if (!r.ok) throw new Error(`the unlink was refused: ${r.errors.join(" ")}`);
  return r.message;
}

/**
 * A family's link to a customer written as linkIn() (src/lib/accounting/link-writes.ts) writes it: `confirmed`, by the
 * staff member, aligned with the cache row's version. For a customer whose id isn't digits (seedTwoFamilies()' are
 * not), which linkFamilyToCustomer() refuses before anything else (isQboId()); students are paired by nothing here.
 */
export async function linkAsConfirmed(familyId: AppFamilyId, customerId: string, staffId: string): Promise<void> {
  const realmId = await getRosterSource();
  if (realmId === null) throw new Error("the roster names no company");
  await db.insert(accountingLink).values({ system: QUICKBOOKS, realmId, customerId, familyId, origin: "confirmed", linkedBy: staffId, syncedToken: "0", syncedAt: new Date() });
}

/**
 * A family relinked from its customer to another family customer the cache holds with no family (written here, with no
 * import after it): unlinked through the press, then linked as a confirm links it.
 */
export async function relinkFamily(familyId: AppFamilyId, customer: { qboId: string; name: string; typeQboId: string }): Promise<void> {
  const staff = await staffWith(`relinker.${customer.qboId.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@club.org`, ["Roster.Read", "Accounting.Link.ReadWrite"]);
  await db.insert(qboCustomer).values({ qboId: customer.qboId, displayName: customer.name, active: true, parentQboId: null, typeQboId: customer.typeQboId, syncToken: "0" });
  await unlinkThroughThePress(familyId, staff);
  await linkAsConfirmed(familyId, customer.qboId, staff.id);
}
