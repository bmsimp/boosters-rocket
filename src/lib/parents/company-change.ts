import { z } from "zod";
import { eq, inArray, isNotNull, ne } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { guardian, heldAddress, parent, parentAuthSession, qboCustomer, setting } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getParentSettings, putParentSettings, PARENTS_KEY } from "./settings";

// This module is called from src/lib/roster/source.ts, so it must import nothing from src/lib/roster/.

export const PREVIOUS_COMPANY_KEY = "parents.previous_company";
export const PREVIOUS_COMPANY_KEEP_MS = 90 * 86_400_000;

const family = z.object({
  qboId: z.string(), name: z.string(),
  people: z.array(z.object({ parentId: z.string(), name: z.string(), email: z.string(), welcomedAt: z.string().nullable() })),
  decision: z.enum(["matched", "rejected"]).nullable(), matchedTo: z.string().nullable(),
});
const stored = z.object({ realmId: z.string(), newRealmId: z.string(), at: z.string(), families: z.array(family),
  approvals: z.array(z.object({ email: z.string(), familyQboIds: z.array(z.string()) })) });
export type PreviousFamily = z.infer<typeof family>;
/** Names and addresses from the company the club left, and its realm IDs: never sent to a page as a whole. */
export type PreviousCompany = z.infer<typeof stored>;

const numeric = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

export async function getPreviousCompany(tx?: Tx): Promise<PreviousCompany | null> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, PREVIOUS_COMPANY_KEY));
  const parsed = stored.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
}

/** Writes the snapshot. The caller audits in the same transaction. */
export async function putPreviousCompany(tx: Tx, value: PreviousCompany): Promise<void> {
  const v = stored.parse(value);
  await tx.insert(setting).values({ key: PREVIOUS_COMPANY_KEY, value: v }).onConflictDoUpdate({ target: setting.key, set: { value: v, updatedAt: new Date() } });
}

/**
 * Called inside `clearRosterOfOtherCompany`, under the roster lock and before the cache is deleted (the family names
 * come from it). QuickBooks IDs are small numbers that mean a different customer in every company, so nothing keyed by
 * them may survive: every link closes (keeping its old IDs, which the reconcile never matches again), every approval
 * and "already welcomed" goes into the snapshot and out of the live tables, and sign-ins and welcomes switch off until
 * an Admin has looked at the new company (spec §6).
 */
export async function clearParentAccess(tx: Tx, o: { fromRealmId: string; toRealmId: string; actor: Actor; ip: string | null }): Promise<void> {
  const open = await tx.select({ g: guardian, p: parent }).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId))
    .where(ne(guardian.status, "disabled")).orderBy(guardian.id).for("update");
  const ids = [...new Set(open.map((r) => r.g.familyQboId))].sort(numeric);
  const names = new Map((ids.length ? await tx.select({ qboId: qboCustomer.qboId, name: qboCustomer.displayName }).from(qboCustomer).where(inArray(qboCustomer.qboId, ids)) : [])
    .map((c) => [c.qboId, c.name]));
  const families: PreviousFamily[] = ids.map((qboId) => ({
    qboId, name: names.get(qboId) ?? `Family ${qboId}`, decision: null, matchedTo: null,
    people: open.filter((r) => r.g.familyQboId === qboId).sort((a, b) => a.p.email.localeCompare(b.p.email))
      .map((r) => ({ parentId: r.p.id, name: r.p.name, email: r.p.email, welcomedAt: r.p.welcomedAt?.toISOString() ?? null })),
  }));
  const approvals = (await tx.select().from(heldAddress).orderBy(heldAddress.email)).filter((h) => h.approvedFamilyQboIds.length)
    .map((h) => ({ email: h.email, familyQboIds: h.approvedFamilyQboIds }));

  for (const { g } of open) {
    await tx.update(guardian).set({ status: "disabled", disabledReason: "company_changed", statusBeforeDisable: g.status === "disabled" ? null : g.status, updatedAt: new Date() })
      .where(eq(guardian.id, g.id));
  }
  const ended = await tx.delete(parentAuthSession).returning({ id: parentAuthSession.id });
  const holds = await tx.delete(heldAddress).returning({ email: heldAddress.email });
  const welcomed = await tx.update(parent).set({ welcomedAt: null, updatedAt: new Date() }).where(isNotNull(parent.welcomedAt)).returning({ id: parent.id });
  await tx.update(parent).set({ welcomeOwed: false, welcomeTriedAt: null });
  const before = await getParentSettings(tx);
  await putParentSettings(tx, { ...before, signin: false, welcome: false });
  await putPreviousCompany(tx, { realmId: o.fromRealmId, newRealmId: o.toRealmId, at: new Date().toISOString(), families, approvals });
  await writeAudit({ actor: o.actor, action: "parent.access.cleared", targetType: "setting", targetId: PARENTS_KEY, ip: o.ip,
    before: { signin: before.signin, welcome: before.welcome },
    after: { reason: "different_company", signin: false, welcome: false, links: open.length, people: new Set(open.map((r) => r.p.id)).size,
      sessionsEnded: ended.length, holdsDeleted: holds.length, welcomesCleared: welcomed.length, familiesKept: families.length, approvalsKept: approvals.length } }, tx);
}

export async function deletePreviousCompany(o: { actor: Actor; ip: string | null; permission?: string; reason: "admin" | "expired" }): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx.delete(setting).where(eq(setting.key, PREVIOUS_COMPANY_KEY)).returning({ key: setting.key });
    if (!rows.length) return false;
    await writeAudit({ actor: o.actor, action: "settings.parents.save", permission: o.permission, targetType: "setting", targetId: PREVIOUS_COMPANY_KEY, ip: o.ip,
      after: { previousCompany: "deleted", reason: o.reason } }, tx);
    return true;
  });
}

/** The snapshot holds names and addresses from a company the club left; it goes 90 days after the switch (spec §6). */
export async function expirePreviousCompany(now: Date = new Date()): Promise<boolean> {
  const prev = await getPreviousCompany();
  if (!prev || now.getTime() - Date.parse(prev.at) < PREVIOUS_COMPANY_KEEP_MS) return false;
  return deletePreviousCompany({ actor: { door: "system", id: null, label: "worker" }, ip: null, reason: "expired" });
}
