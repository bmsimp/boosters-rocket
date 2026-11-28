// Staff only (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts): blocking, unblocking and renaming a person.
// Since stage 3's slice 9h a rename starts sends to QuickBooks (each membership's own Parent customer), through
// src/lib/roster/writes.ts.
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { guardian, parent, parentAuthUser, parentEmailChange } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { guardianChangeWaiting, guardianMaySend, guardianSentWords, sendGuardianSaved, whileGuardiansHeld, type GuardianQueued } from "@/lib/roster/writes";
import { guardianSaved } from "@/lib/families/guardian-events";
import { getParentSettings } from "./settings";
import { endParentSessions, deleteUnusedSigninCodes, deleteUnusedSigninLinks, enterableGuardianRows, forgetDevices } from "./sessions";
import { formsForGoneSigner } from "@/lib/forms/signer-gone";
import { holdRoster, personName, type Waits } from "./guardians";

export type StaffOp = { actor: Actor; ip: string | null; permission?: string };

/**
 * No codes, no unused set-up or reset links, no remembered devices, and every session ends. Family links keep their
 * status, and the password stays, and so (since the sign-in release's slice SI-6a) do the authenticator app and the
 * backup codes, and (since slice SI-7a) the passkeys, so unblocking restores the same access. The reason is for staff only. Every unfinished form still waiting for this person's signature is reset and its document withdrawn,
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

/**
 * `busy`: a roster read held the roster lock past the wait; `qbo_pending`: a change to one of their Parent customers is
 * waiting or stuck; `being_changed`: someone holds one of their guardian rows' "being sent" locks at this moment;
 * `raced`: their memberships changed while the rename was getting ready (an add or removal at that moment). Each its
 * own cause, said in its own words.
 */
export type RenamePersonResult = { ok: true; changed: boolean; quickbooks: string[] } | { ok: false; reason: "not_found" | "invalid" | "busy" | "qbo_pending" | "being_changed" | "raced" };

/** The person's open guardian rows (their memberships), read unlocked before the rename takes their "being sent" locks, and again under the person's lock. */
const openRowsOf = (q: Pick<Tx, "select">, parentId: string) =>
  q.select({ guardianId: guardian.id, familyId: guardian.familyId }).from(guardian).where(and(eq(guardian.parentId, parentId), ne(guardian.status, "disabled"))).orderBy(asc(guardian.id));

/**
 * Changes a person's name: `parent.name` and the sign-in account's name, which mirrors it, in one transaction under the
 * person's row, audited `parent.name.changed` with before and after (stage 3's slice 7b). The same name, once tidied,
 * changes and records nothing. Since stage 3's slice 9h the name follows to the Parent customer of each of their open
 * memberships that has one of its own (the save's event, guardianSaved(), whose handler is queueForGuardian()'s rename,
 * src/lib/roster/writes.ts): in that transaction,
 * after the person's row, the roster lock shared (at most ROSTER_WAIT_MS, else `busy`, nothing written), each such
 * customer's rename queued as a change saved first (and a create kept as a taken name made again under the new name,
 * only where the new name is free by the portal's knowledge), named in the audit row (`queueIds`); then, after the
 * commit, each tried at once while every one of those rows' "being sent" locks is held from before the save. Refused,
 * changing nothing, while a change to any of those Parent customers is waiting or stuck (`qbo_pending`), or any of
 * those locks is held (`being_changed`). Nothing is queued for a Parent customer QuickBooks has inactive, and a rename
 * is not checked against QuickBooks' names first: its answer decides. Only where something could be sent for them
 * (guardianMaySend(): a membership in a linked family, in books with a parent type, or an item of theirs on the queue)
 * are those locks taken: otherwise they are renamed as before slice 9h, whatever the roster is doing.
 */
export async function renamePerson(parentId: string, rawName: string, o: StaffOp, w: Waits = {}): Promise<RenamePersonResult> {
  const name = personName(rawName);
  if (name === null) return { ok: false, reason: "invalid" };
  const rows = await openRowsOf(db, parentId);
  if (!(await guardianMaySend(rows))) {
    // Nothing could be sent for them, read unlocked and again under the person's lock: the portal's rename alone.
    const plain = await saveName(parentId, name, o, null, w);
    if (plain.ok !== "sends") return plain.ok ? { ok: true, changed: plain.changed, quickbooks: [] } : plain;
  }
  const r = await whileGuardiansHeld(rows.map((x) => x.guardianId), async (hold): Promise<RenamePersonResult> => {
    const saved = await saveName(parentId, name, o, rows.map((x) => x.guardianId), w);
    if (saved.ok === "sends") return { ok: false, reason: "raced" };
    if (!saved.ok) return saved;
    if (!saved.changed) return { ok: true, changed: false, quickbooks: [] };
    return { ok: true, changed: true, quickbooks: guardianSentWords(await sendGuardianSaved(saved.queued, o, { hold, rosterWaitMs: w.rosterWaitMs }), "rename", name) };
  });
  return r ?? { ok: false, reason: "being_changed" };
}

/**
 * renamePerson()'s save. `held`: the guardian rows whose "being sent" locks the caller holds, or null for none, when the
 * unlocked read found nothing that could be sent: should something be sendable by now, nothing is written (`sends`).
 */
type SavedName = { ok: true; changed: boolean; queued: GuardianQueued[] } | { ok: "sends" } | Exclude<RenamePersonResult, { ok: true }>;
async function saveName(parentId: string, name: string, o: StaffOp, held: string[] | null, w: Waits): Promise<SavedName> {
  return db.transaction(async (tx): Promise<SavedName> => {
    const [p] = await tx.select().from(parent).where(eq(parent.id, parentId)).for("update");
    if (!p) return { ok: false, reason: "not_found" };
    if (p.name === name) return { ok: true, changed: false, queued: [] };
    const now = await openRowsOf(tx, p.id);
    const sends = await guardianMaySend(now, tx);
    if (sends && held === null) return { ok: "sends" };
    if (sends) {
      if (!(await holdRoster(tx, w))) return { ok: false, reason: "busy" };
      // The rows whose locks are held must be the person's open rows still: another add or removal meanwhile is `raced`.
      if (now.map((x) => x.guardianId).join() !== held!.join()) return { ok: false, reason: "raced" };
      if (await guardianChangeWaiting(tx, now.map((x) => x.guardianId))) return { ok: false, reason: "qbo_pending" };
    }
    await tx.update(parent).set({ name, updatedAt: new Date() }).where(eq(parent.id, p.id));
    await tx.update(parentAuthUser).set({ name, updatedAt: new Date() }).where(eq(parentAuthUser.parentId, p.id));
    const queued = sends && now.length ? await guardianSaved(tx, { record: "guardian", change: "renamed", rows: now, name, was: p.name, email: p.email }, o) : [];
    const queueIds = queued.flatMap((q) => (q.item ? [q.item.id] : []));
    await writeAudit({ actor: o.actor, action: "parent.name.changed", permission: o.permission, targetType: "parent", targetId: p.id,
      before: { name: p.name }, after: { name, ...(queueIds.length ? { queueIds } : {}) }, ip: o.ip }, tx);
    return { ok: true, changed: true, queued };
  });
}

// Staff do not change a parent's address in the portal yet (the app-owned families spec's open question 8 is a later
// slice). A parent changes their own through src/lib/parents/email-change.ts.
