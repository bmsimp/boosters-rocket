import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { heldAddress } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { appRecordsAudit } from "@/lib/families/in-step";
import type { StaffOp } from "./people";
import { loadDecision, reconcileAccess } from "./reconcile";

export type HoldDecision = "same_person" | "not_same";
type Result = { ok: true } | { ok: false; errors: string[] };

function checkNote(raw: string): { ok: true; note: string } | { ok: false; errors: string[] } {
  const note = raw.trim();
  if (!note) return { ok: false, errors: ["Add a short note saying how you know."] };
  if (note.length > 500) return { ok: false, errors: ["Keep the note to 500 characters."] };
  return { ok: true, note };
}
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])].sort((x, y) => x.localeCompare(y, "en", { numeric: true }));

/**
 * A staff decision on an address that is under more than one family (spec §1 Held addresses). **Same person** approves
 * every family the address is under now; **Not the same person** keeps the held ones held and takes the item off the
 * waiting list. Both act only on the families the caller was shown (`shownFamilyQboIds`). Access changes in the same transaction, through the reconcile.
 */
export async function decideHold(email: string, decision: HoldDecision, shownFamilyQboIds: string[], rawNote: string, o: StaffOp): Promise<Result> {
  const checked = checkNote(rawNote);
  if (!checked.ok) return checked;
  return db.transaction(async (tx): Promise<Result> => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
    const item = (await loadDecision(tx))?.decision.held.find((h) => h.email === email);
    if (!item) return { ok: false, errors: ["That address isn't held any more. Reload the page."] };
    // Decide only on what the staff member was shown: a refresh may have added or removed a family since the page loaded.
    const shown = new Set(shownFamilyQboIds), now = new Set(item.families.map((f) => f.qboId));
    if (shown.size !== now.size || [...now].some((id) => !shown.has(id))) return { ok: false, errors: ["That address has changed since this page loaded. Reload the page and look again."] };
    await tx.insert(heldAddress).values({ email }).onConflictDoNothing();
    const [row] = await tx.select().from(heldAddress).where(eq(heldAddress.email, email)).for("update");
    const all = item.families.map((f) => f.qboId), heldNow = item.families.filter((f) => f.held).map((f) => f.qboId);
    const next = decision === "same_person"
      ? { approvedFamilyQboIds: union(row!.approvedFamilyQboIds, all), rejectedFamilyQboIds: row!.rejectedFamilyQboIds.filter((f) => !all.includes(f)) }
      : { approvedFamilyQboIds: row!.approvedFamilyQboIds, rejectedFamilyQboIds: union(row!.rejectedFamilyQboIds, heldNow) };
    await tx.update(heldAddress).set({ ...next, note: checked.note, decidedBy: o.actor.id, decidedAt: new Date(), updatedAt: new Date() }).where(eq(heldAddress.email, email));
    const r = await reconcileAccess(tx, { cause: "hold" });
    await writeAudit({ actor: o.actor, action: "parent.hold.decided", permission: o.permission, targetType: "held_address", targetId: email, ip: o.ip,
      before: { approved: row!.approvedFamilyQboIds, rejected: row!.rejectedFamilyQboIds },
      after: { decision, familyQboIds: decision === "same_person" ? union([], all) : union([], heldNow), note: checked.note, ...appRecordsAudit(r.appRecords) } }, tx);
    return { ok: true };
  });
}

/** Undoes every decision on the address: it is held again for all its families, and waiting again (spec §1). */
export async function reverseHold(email: string, rawNote: string, o: StaffOp): Promise<Result> {
  const checked = checkNote(rawNote);
  if (!checked.ok) return checked;
  return db.transaction(async (tx): Promise<Result> => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
    const [row] = await tx.select().from(heldAddress).where(eq(heldAddress.email, email)).for("update");
    if (!row || (!row.approvedFamilyQboIds.length && !row.rejectedFamilyQboIds.length)) return { ok: false, errors: ["There is no decision on that address to reverse."] };
    await tx.update(heldAddress).set({ approvedFamilyQboIds: [], rejectedFamilyQboIds: [], note: checked.note, decidedBy: o.actor.id, decidedAt: new Date(), updatedAt: new Date() })
      .where(eq(heldAddress.email, email));
    const r = await reconcileAccess(tx, { cause: "hold" });
    await writeAudit({ actor: o.actor, action: "parent.hold.decided", permission: o.permission, targetType: "held_address", targetId: email, ip: o.ip,
      before: { approved: row.approvedFamilyQboIds, rejected: row.rejectedFamilyQboIds }, after: { decision: "reversed", note: checked.note, ...appRecordsAudit(r.appRecords) } }, tx);
    return { ok: true };
  });
}
