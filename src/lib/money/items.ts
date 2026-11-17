// Staff only: QuickBooks' products and services, read for staff to choose what a payment requirement is met by
// (v1 spec §10.2), and the choice itself. Every write is one transaction with its audit row.
import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { qboItem, requirement } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { isQboId, qboItems } from "@/lib/quickbooks/client";
import { getConnection } from "@/lib/quickbooks/connection";
import { QboError } from "@/lib/quickbooks/endpoints";
import { getRosterSource } from "@/lib/roster/source";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { lockRosterAs, ROSTER_MOVED } from "@/lib/seasons/roster-lock";

export type ItemOp = { actor: Actor; ip: string | null; permission?: string };
export type Item = { qboId: string; name: string; type: string | null; active: boolean };
type Done = { ok: true; count?: number } | { ok: false; errors: string[] };
const refuse = (...errors: string[]): { ok: false; errors: string[] } => ({ ok: false, errors });
const GONE = "That isn't there any more. Reload the page.";
/** A category groups products in QuickBooks and is never on an invoice line: it is not offered. */
const NOT_SOLD = new Set(["Category"]);
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** The products and services as last read from the company the roster cache came from, by name. Another company's are never listed. */
export async function listItems(tx?: Tx): Promise<Item[]> {
  const source = await getRosterSource(tx);
  if (source === null) return [];
  return (tx ?? db).select({ qboId: qboItem.qboId, name: qboItem.name, type: qboItem.type, active: qboItem.active }).from(qboItem)
    .where(eq(qboItem.realmId, source)).orderBy(asc(qboItem.name), asc(qboItem.qboId));
}

/** When the list was last read, or null. */
export async function itemsReadAt(): Promise<string | null> {
  const [row] = await db.select({ at: sql<Date | null>`max(${qboItem.readAt})` }).from(qboItem);
  return row?.at ? new Date(row.at).toISOString() : null;
}

/**
 * Reads the products and services from QuickBooks (`select * from Item`, strictly) and replaces the stored list. Only
 * from the company the roster cache came from; the list is saved under the roster lock and only if that is still the
 * company, so a change of company while QuickBooks answered keeps nothing of the old one. An answer with nothing to
 * keep never replaces a stored list that holds items, as the roster refresh never believes an empty roster over one
 * that holds customers: a company doesn't lose every product at once, and the requirements would then name them by
 * number. Staff press for it (Read the list from QuickBooks); the worker's daily read of every family also asks, at
 * its own pace (`pace`, src/lib/money/sweep.ts).
 */
export async function readItems(o: ItemOp & { pace?: () => Promise<void> }): Promise<Done> {
  const c = await getConnection();
  const realmId = await getRosterSource();
  if (!c?.realmId || !c.refreshTokenCiphertext || realmId === null || realmId !== c.realmId) {
    return refuse("QuickBooks needs to be connected, and its roster read, before its products and services can be listed. See QuickBooks under Settings.");
  }
  let raw: Record<string, unknown>[];
  try {
    raw = await qboItems({ realmId, retry: true, ...(o.pace ? { pace: o.pace } : {}) });
  } catch (e) {
    const code = e instanceof QboError ? e.code : "unexpected";
    await writeAudit({ actor: o.actor, action: "money.items.read.failed", permission: o.permission, targetType: "qbo_item", ip: o.ip, after: { code } });
    return refuse(`QuickBooks couldn't be asked for its products and services just now. Try again in a little while. (${code})`);
  }
  const now = new Date();
  const seen = new Set<string>();
  const rows = raw.flatMap((r) => {
    const qboId = text(r.Id, 32), type = text(r.Type, 40);
    if (qboId === null || !isQboId(qboId) || seen.has(qboId) || (type !== null && NOT_SOLD.has(type))) return [];
    seen.add(qboId);
    return [{ qboId, name: text(r.Name, 200) ?? text(r.FullyQualifiedName, 200) ?? `Item ${qboId}`, type, active: r.Active === true || r.Active === "true", realmId, readAt: now }];
  });
  return db.transaction(async (tx): Promise<Done> => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
    if ((await getRosterSource(tx)) !== realmId) return refuse(ROSTER_MOVED);
    if (rows.length === 0) {
      const [held] = await tx.select({ n: sql<number>`count(*)::int` }).from(qboItem).where(eq(qboItem.realmId, realmId));
      if ((held?.n ?? 0) > 0) {
        await writeAudit({ actor: o.actor, action: "money.items.read.failed", permission: o.permission, targetType: "qbo_item", ip: o.ip, after: { code: "no_items", kept: held!.n } }, tx);
        return refuse("QuickBooks answered with no products or services, though the portal has a list read from it before. The list was kept as it was. Try again in a little while. (no_items)");
      }
    }
    await tx.delete(qboItem);
    for (let i = 0; i < rows.length; i += 500) await tx.insert(qboItem).values(rows.slice(i, i + 500));
    await writeAudit({ actor: o.actor, action: "money.items.read", permission: o.permission, targetType: "qbo_item", ip: o.ip, after: { items: rows.length } }, tx);
    return { ok: true, count: rows.length };
  });
}

/** The product or service a payment requirement is met by, with its name when the stored list holds it. */
export async function requirementItem(requirementId: string): Promise<{ qboId: string; name: string | null; active: boolean } | null> {
  const [row] = await db.select({ itemQboId: requirement.itemQboId }).from(requirement).where(eq(requirement.id, requirementId));
  if (!row?.itemQboId) return null;
  const source = await getRosterSource();
  const [item] = source === null ? [] : await db.select().from(qboItem).where(and(eq(qboItem.qboId, row.itemQboId), eq(qboItem.realmId, source)));
  return { qboId: row.itemQboId, name: item?.name ?? null, active: item?.active ?? false };
}

/**
 * Chooses the product or service a payment requirement is met by, from the stored list (or none, with null). Under the
 * roster lock and against the company the page was shown (`rosterTag`): the id is that company's. An item that is
 * inactive in QuickBooks can't be newly chosen.
 */
export async function chooseItem(requirementId: string, rosterTag: string, itemQboId: string | null, o: ItemOp): Promise<Done> {
  return db.transaction(async (tx): Promise<Done> => {
    if (!(await lockRosterAs(tx, rosterTag))) return refuse(ROSTER_MOVED);
    const [r] = await tx.select().from(requirement).where(eq(requirement.id, requirementId)).for("update");
    if (!r) return refuse(GONE);
    if (r.kind !== "payment") return refuse("Only a payment requirement is met by a product or service.");
    const items = await listItems(tx);
    const named = (id: string | null) => (id === null ? null : { qboId: id, name: items.find((i) => i.qboId === id)?.name ?? null });
    if (itemQboId !== null) {
      const item = items.find((i) => i.qboId === itemQboId);
      if (!item) return refuse("That product or service isn't in the list read from QuickBooks. Read the list again and choose from it.");
      if (!item.active && item.qboId !== r.itemQboId) return refuse("That product or service is inactive in QuickBooks. Choose another.");
    }
    if (r.itemQboId === itemQboId) return { ok: true };
    await tx.update(requirement).set({ itemQboId, updatedAt: new Date() }).where(eq(requirement.id, r.id));
    await writeAudit({ actor: o.actor, action: "season.requirement.item", permission: o.permission, targetType: "requirement", targetId: r.id, ip: o.ip,
      before: { title: r.title, item: named(r.itemQboId) }, after: { item: named(itemQboId) } }, tx);
    return { ok: true };
  });
}
