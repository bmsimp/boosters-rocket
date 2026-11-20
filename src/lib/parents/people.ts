// Staff only (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts): blocking, unblocking and renaming a person.
// Since stage 3's slice 9h a rename starts sends to QuickBooks (each membership's own Parent customer), through
// src/lib/roster/writes.ts.
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { guardian, parent, parentAuthUser, parentEmailChange } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { guardianChangeWaiting, guardianSentWords, queueForGuardian, sendGuardianSaved, whileGuardiansHeld, type GuardianQueued } from "@/lib/roster/writes";
import { getParentSettings } from "./settings";
import { endParentSessions, deleteUnusedSigninCodes, deleteUnusedSigninLinks, enterableGuardianRows, forgetDevices } from "./sessions";
import { formsForGoneSigner } from "@/lib/forms/signer-gone";
import { holdRoster, personName, type Waits } from "./guardians";

export type StaffOp = { actor: Actor; ip: string | null; permission?: string };

/**
 * No codes, no unused set-up or reset links, no remembered devices, and every session ends. Family links keep their
 * status, and the password stays, so unblocking restores the same access. The reason is for staff only. Every unfinished form still waiting for this person's signature is reset and its document withdrawn,
 * so a signing link the portal handed them earlier can't sign for a family any more (src/lib/forms/signer-gone.ts).
 */
export async function blockPerson(parentId: string, rawReason: string, o: StaffOp): Promise<{ ok: true; sessionsEnded: number } | { ok: false; reason: "not_found" | "invalid" }> {
  const reason = rawReason.trim();
  if (!reason || reason.length > 500) return { ok: false, reason: "invalid" };
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(parent).where(eq(parent.id, parentId)).for("update");
    if (!p) return { ok: false as const, reason: "not_found" as const };
    await tx.update(parent).set({ blocked: true, blockedAt: new Date(), blockedBy: o.actor.id, blockedReason: reason, welcomeOwed: false, updatedAt: new Date() }).where(eq(parent.id, p.id));
    // What hangs on the person, in the order ./sessions.ts gives (lockedPerson()): requests, then codes, then unused
    // set-up and reset links, then remembered devices, then sessions. The password stays, so unblocking restores it.
    await tx.delete(parentEmailChange).where(and(eq(parentEmailChange.parentId, p.id), isNull(parentEmailChange.usedAt)));
    await deleteUnusedSigninCodes(p.id, tx);
    const linksDeleted = await deleteUnusedSigninLinks(p.id, tx);
    const devicesForgotten = await forgetDevices(p.id, tx);
    const sessionsEnded = await endParentSessions(p.id, tx);
    const formsReset = await formsForGoneSigner(tx, { parentId: p.id, family: "every family", reason: "blocked", actor: o.actor, ip: o.ip });
    await writeAudit({ actor: o.actor, action: "parent.block", permission: o.permission, targetType: "parent", targetId: p.id,
      before: { blocked: p.blocked, reason: p.blockedReason }, after: { blocked: true, reason, sessionsEnded, linksDeleted, devicesForgotten, formsReset }, ip: o.ip }, tx);
    return { ok: true as const, sessionsEnded };
  });
}

/**
 * Puts back what blocking cleared: a person never welcomed, who can sign in by the gate's rule (a guardian row that
 * counts, ./sessions.ts), is owed the welcome again when welcomes are on.
 */
export async function unblockPerson(parentId: string, o: StaffOp): Promise<{ ok: true; changed: boolean } | { ok: false; reason: "not_found" }> {
  return db.transaction(async (tx) => {
    const [p] = await tx.select().from(parent).where(eq(parent.id, parentId)).for("update");
    if (!p) return { ok: false as const, reason: "not_found" as const };
    if (!p.blocked) return { ok: true as const, changed: false };
    const open = (await enterableGuardianRows(p.id, tx)).length > 0;
    const owed = !p.welcomedAt && open && (await getParentSettings(tx)).welcome;
    await tx.update(parent).set({ blocked: false, blockedAt: null, blockedBy: null, blockedReason: null, ...(owed ? { welcomeOwed: true } : {}), updatedAt: new Date() }).where(eq(parent.id, p.id));
    await writeAudit({ actor: o.actor, action: "parent.unblock", permission: o.permission, targetType: "parent", targetId: p.id,
      before: { blocked: p.blocked, reason: p.blockedReason }, after: { blocked: false, ...(owed ? { welcomeOwed: true } : {}) }, ip: o.ip }, tx);
    return { ok: true as const, changed: true };
  });
}

export type RenamePersonResult = { ok: true; changed: boolean; quickbooks: string[] } | { ok: false; reason: "not_found" | "invalid" | "busy" | "qbo_pending" };

/** The person's open guardian rows (their memberships), read unlocked before the rename takes their "being sent" locks, and again under the person's lock. */
const openRowsOf = (q: Pick<Tx, "select">, parentId: string) =>
  q.select({ guardianId: guardian.id, familyId: guardian.familyId }).from(guardian).where(and(eq(guardian.parentId, parentId), ne(guardian.status, "disabled"))).orderBy(asc(guardian.id));

/**
 * Changes a person's name: `parent.name` and the sign-in account's name, which mirrors it, in one transaction under the
 * person's row, audited `parent.name.changed` with before and after (stage 3's slice 7b). The same name, once tidied,
 * changes and records nothing. Since stage 3's slice 9h the name follows to the Parent customer of each of their open
 * memberships that has one of its own (queueForGuardian()'s rename, src/lib/roster/writes.ts): in that transaction,
 * after the person's row, the roster lock shared (at most ROSTER_WAIT_MS, else `busy`, nothing written), each such
 * customer's rename queued as a change saved first (and a create kept as a taken name made again under the new name),
 * named in the audit row (`queueIds`); then, after the commit, each tried at once while every one of those rows'
 * "being sent" locks is held from before the save. Refused, changing nothing, while a change to any of those Parent
 * customers is waiting or stuck, or any of those locks is held (`qbo_pending`). Nothing is queued for a Parent customer
 * QuickBooks has inactive, and the name is not checked against QuickBooks' names first: its answer decides.
 */
export async function renamePerson(parentId: string, rawName: string, o: StaffOp, w: Waits = {}): Promise<RenamePersonResult> {
  const name = personName(rawName);
  if (name === null) return { ok: false, reason: "invalid" };
  const rows = await openRowsOf(db, parentId);
  const r = await whileGuardiansHeld(rows.map((x) => x.guardianId), async (): Promise<RenamePersonResult> => {
    type Saved = { ok: true; changed: boolean; queued: GuardianQueued[] } | Exclude<RenamePersonResult, { ok: true }>;
    const saved = await db.transaction(async (tx): Promise<Saved> => {
      const [p] = await tx.select().from(parent).where(eq(parent.id, parentId)).for("update");
      if (!p) return { ok: false, reason: "not_found" };
      if (p.name === name) return { ok: true, changed: false, queued: [] };
      if (!(await holdRoster(tx, w))) return { ok: false, reason: "busy" };
      // The rows whose locks are held must be the person's open rows still: another add or removal meanwhile is busy.
      const now = await openRowsOf(tx, p.id);
      if (now.map((x) => x.guardianId).join() !== rows.map((x) => x.guardianId).join()) return { ok: false, reason: "busy" };
      if (await guardianChangeWaiting(tx, now.map((x) => x.guardianId))) return { ok: false, reason: "qbo_pending" };
      await tx.update(parent).set({ name, updatedAt: new Date() }).where(eq(parent.id, p.id));
      await tx.update(parentAuthUser).set({ name, updatedAt: new Date() }).where(eq(parentAuthUser.parentId, p.id));
      const queued = now.length ? await queueForGuardian(tx, { op: "rename", rows: now, name, was: p.name, email: p.email }, o) : [];
      const queueIds = queued.flatMap((q) => (q.item ? [q.item.id] : []));
      await writeAudit({ actor: o.actor, action: "parent.name.changed", permission: o.permission, targetType: "parent", targetId: p.id,
        before: { name: p.name }, after: { name, ...(queueIds.length ? { queueIds } : {}) }, ip: o.ip }, tx);
      return { ok: true, changed: true, queued };
    });
    if (!saved.ok) return saved;
    if (!saved.changed) return { ok: true, changed: false, quickbooks: [] };
    return { ok: true, changed: true, quickbooks: guardianSentWords(await sendGuardianSaved(saved.queued, o), "rename", name) };
  });
  return r ?? { ok: false, reason: "qbo_pending" };
}

// Staff do not change a parent's address in the portal yet (the app-owned families spec's open question 8 is a later
// slice). A parent changes their own through src/lib/parents/email-change.ts.
