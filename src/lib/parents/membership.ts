// Closing one membership: a guardian row stops letting its person sign in for its family. Since the reconcile that
// closed rows for what QuickBooks held went (stage 3 of the app-owned families spec), its one caller is staff's "remove
// a guardian" (removeGuardian(), ./guardians.ts, stage 3's slice 7b), with the reason `removed`. It is not for parent
// code. It changes nothing but the row, the person's unused email change requests, and, once no open row is left,
// their unused sign-in codes, unused set-up and reset links and remembered devices, their sessions, the family's forms
// still waiting on them and the audit row, all in the caller's transaction. The caller holds the person's row
// (`parent`) and then the guardian row FOR UPDATE before it calls: what this touches after them (the requests, then the
// codes, then the links, then the devices, then the sessions) comes later in the one order ./sessions.ts gives
// (lockedPerson()).
import { eq, and, isNull, ne } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { guardian, parentEmailChange, type DisabledReason } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import type { AppFamilyId } from "@/lib/families/ids";
import { customerOfFamily } from "@/lib/families/links";
import { formsForGoneSigner } from "@/lib/forms/signer-gone";
import { deleteUnusedSigninCodes, deleteUnusedSigninLinks, endFamilySessions, endParentSessions, forgetDevices } from "./sessions";

/**
 * Deletes the person's unused email change requests asked in `familyId` (none for a row that names no family record),
 * or every unused one ("all"). Returns how many.
 */
async function deleteUnusedRequests(tx: Tx, parentId: string, familyId: AppFamilyId | null | "all"): Promise<number> {
  if (familyId === null) return 0;
  const gone = await tx.delete(parentEmailChange).where(and(eq(parentEmailChange.parentId, parentId), isNull(parentEmailChange.usedAt),
    familyId === "all" ? undefined : eq(parentEmailChange.familyId, familyId))).returning({ id: parentEmailChange.id });
  return gone.length;
}

/** The parts of a guardian row a close reads. The caller's own object is changed in place to match the row. */
export type MembershipRow = Pick<typeof guardian.$inferSelect,
  "id" | "parentId" | "familyId" | "status" | "statusBeforeDisable" | "disabledReason">;

export type CloseMembership = {
  reason: DisabledReason;
  actor: Actor;
  /** Added to the audit row's `after`: what led to the close. */
  cause?: string;
  /** Added to the audit row's `after`: staff's own note on why, kept for staff only (a parent never reads it). */
  note?: string;
  /** The permission and address of the staff member who closed it, for the audit row. */
  permission?: string;
  ip?: string | null;
  /**
   * Whether the person still has an open membership once this one is closed, for a caller that holds the person's rows
   * locked and answers from them; left out, the database is asked, in the caller's transaction.
   */
  stillOpenElsewhere?: () => boolean;
};

/**
 * Closes one membership: the row becomes `disabled` with its reason and the status it had (`statusBeforeDisable`), the
 * person's unused email change requests asked in the row's family record go (every unused request, every unused
 * sign-in code and every unused set-up and reset link, and every remembered device is forgotten, when no open row is
 * left: the lead's choice 10 of the sign-in release; the password stays), so a link or code sent before the close can't
 * work after a reinstate or a new add within its life; the person's sessions that chose the row's family record end (none for a row that names no family record: no session can
 * have chosen one, since the gate lets a session into a family only through its person's row naming it), and all their
 * sessions when no open row is left; when the row was open, the family's unfinished forms still waiting on them start
 * again (formsForGoneSigner(), by the row's own `family_id`); and `parent.access.ended` is written, naming the customer
 * the family's own link names now (`familyQboId`, null for a family with no link or a row in none). In that order, in the caller's transaction, which must hold the row locked. Returns
 * whether it was open and how many sessions ended.
 */
export async function closeMembership(tx: Tx, row: MembershipRow, o: CloseMembership): Promise<{ wasOpen: boolean; sessionsEnded: number }> {
  const wasOpen = row.status !== "disabled";
  const was = row.status === "disabled" ? row.statusBeforeDisable : row.status;
  const set = { status: "disabled" as const, disabledReason: o.reason, statusBeforeDisable: was };
  await tx.update(guardian).set({ ...set, updatedAt: new Date() }).where(eq(guardian.id, row.id));
  // The caller's object is the row as it is now, so what it decides next (another close, the person's last open row) reads it.
  Object.assign(row, set);
  const openElsewhere = o.stillOpenElsewhere ? o.stillOpenElsewhere()
    : (await tx.select({ id: guardian.id }).from(guardian).where(and(eq(guardian.parentId, row.parentId), ne(guardian.status, "disabled"))).limit(1)).length > 0;
  // What hangs on the person, in the order ./sessions.ts gives (lockedPerson()): requests, then codes, then links, then
  // devices, then sessions. A link asked for in this family, or once nothing is left open any request, code, set-up or
  // reset link, must not work again should the row be reinstated, or the person added again, within its life; and a
  // device remembered before asks for the second step again.
  const requestsDeleted = await deleteUnusedRequests(tx, row.parentId, openElsewhere ? row.familyId : "all");
  if (!openElsewhere) await deleteUnusedSigninCodes(row.parentId, tx);
  const linksDeleted = openElsewhere ? 0 : await deleteUnusedSigninLinks(row.parentId, tx);
  const devicesForgotten = openElsewhere ? 0 : await forgetDevices(row.parentId, tx);
  let sessionsEnded = row.familyId === null ? 0 : await endFamilySessions(row.parentId, row.familyId, tx);
  if (!openElsewhere) sessionsEnded += await endParentSessions(row.parentId, tx);
  // A document already made for them keeps a working signing link: their unfinished forms for this family start again.
  const familyQboId = row.familyId === null ? null : await customerOfFamily(row.familyId, tx);
  const formsReset = wasOpen ? await formsForGoneSigner(tx, { parentId: row.parentId, family: row.familyId, reason: "access_ended", actor: o.actor, ip: o.ip ?? null }) : 0;
  await writeAudit({ actor: o.actor, action: "parent.access.ended", permission: o.permission, targetType: "guardian", targetId: row.id, ip: o.ip ?? null,
    before: { status: was },
    after: { parentId: row.parentId, familyId: row.familyId === null ? null : String(row.familyId), familyQboId, reason: o.reason, sessionsEnded,
      ...(requestsDeleted ? { requestsDeleted } : {}), ...(linksDeleted ? { linksDeleted } : {}), ...(devicesForgotten ? { devicesForgotten } : {}), ...(formsReset ? { formsReset } : {}), ...(o.cause === undefined ? {} : { cause: o.cause }), ...(o.note === undefined ? {} : { note: o.note }) } }, tx);
  return { wasOpen, sessionsEnded };
}
