// Closing one membership: a guardian row stops letting its person sign in for its family. The reconcile calls it for
// every link it closes (src/lib/parents/reconcile.ts); stage 3 of the app-owned families spec gives staff a "remove a
// guardian" that will call it too. It is not for parent code. It changes nothing but the row, the person's sessions,
// the family's forms still waiting on them and the audit row, all in the caller's transaction.
import { eq, and, ne } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { guardian, type DisabledReason } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { formsForGoneSigner } from "@/lib/forms/signer-gone";
import { endFamilySessions, endParentSessions } from "./sessions";

/** The parts of a guardian row a close reads. The caller's own object is changed in place to match the row. */
export type MembershipRow = Pick<typeof guardian.$inferSelect,
  "id" | "parentId" | "familyQboId" | "familyId" | "status" | "statusBeforeDisable" | "disabledReason" | "sourceQboId">;

export type CloseMembership = {
  reason: DisabledReason;
  actor: Actor;
  /** Drops the row's `source_qbo_id` too, so another row can carry it; the audit row keeps what it was. */
  dropSource?: boolean;
  /** Added to the audit row's `after`, as the reconcile's rows carry it. */
  cause?: string;
  /**
   * Whether the person still has an open membership once this one is closed. The reconcile answers from the rows it
   * holds locked; left out, the database is asked, in the caller's transaction.
   */
  stillOpenElsewhere?: () => boolean;
};

/**
 * Closes one membership: the row becomes `disabled` with its reason and the status it had (`statusBeforeDisable`), the
 * person's sessions for that family end, and all their sessions when no open row is left; when the row was open, the
 * family's unfinished forms still waiting on them start again (formsForGoneSigner(), by the row's own `family_id`); and
 * `parent.access.ended` is written. In that order, in the caller's transaction, which must hold the row locked. Returns
 * whether it was open and how many sessions ended.
 */
export async function closeMembership(tx: Tx, row: MembershipRow, o: CloseMembership): Promise<{ wasOpen: boolean; sessionsEnded: number }> {
  const wasOpen = row.status !== "disabled";
  const was = row.status === "disabled" ? row.statusBeforeDisable : row.status;
  const droppedSource = row.sourceQboId;
  const set = { status: "disabled" as const, disabledReason: o.reason, statusBeforeDisable: was, ...(o.dropSource ? { sourceQboId: null } : {}) };
  await tx.update(guardian).set({ ...set, updatedAt: new Date() }).where(eq(guardian.id, row.id));
  // The caller's object is the row as it is now, so what it decides next (another close, the person's last open row) reads it.
  Object.assign(row, set);
  let sessionsEnded = await endFamilySessions(row.parentId, row.familyQboId, tx);
  const openElsewhere = o.stillOpenElsewhere ? o.stillOpenElsewhere()
    : (await tx.select({ id: guardian.id }).from(guardian).where(and(eq(guardian.parentId, row.parentId), ne(guardian.status, "disabled"))).limit(1)).length > 0;
  if (!openElsewhere) sessionsEnded += await endParentSessions(row.parentId, tx);
  // A document already made for them keeps a working signing link: their unfinished forms for this family start again.
  const formsReset = wasOpen ? await formsForGoneSigner(tx, { parentId: row.parentId, family: row.familyId, reason: "access_ended", actor: o.actor }) : 0;
  // A dropped source is gone from the row: the audit row keeps what it was.
  await writeAudit({ actor: o.actor, action: "parent.access.ended", targetType: "guardian", targetId: row.id,
    before: o.dropSource ? { status: was, sourceQboId: droppedSource } : { status: was },
    after: { parentId: row.parentId, familyQboId: row.familyQboId, reason: o.reason, sessionsEnded, ...(formsReset ? { formsReset } : {}),
      ...(o.cause === undefined ? {} : { cause: o.cause }) } }, tx);
  return { wasOpen, sessionsEnded };
}
