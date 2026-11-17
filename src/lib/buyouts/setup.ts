// Staff only: offering a buy-out on a volunteer requirement (v1 spec §11.5): its price per unit still owed and the
// QuickBooks product or service it is billed with, picked from the list step 4 reads (qbo_item). Season.Steps.ReadWrite,
// as the rest of a requirement. A write is one transaction with its audit row.
import "server-only";
import { and, count, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { buyout, requirement } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { listItems } from "@/lib/money/items";
import { lockRosterAs, ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { LIVE_STATES, parsePrice } from "./rules";

export type BuyoutOp = { actor: Actor; ip: string | null; permission: string };
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const refuse = (...errors: string[]): Done => ({ ok: false, errors });

/** A requirement's buy-out as its staff page shows it: the price, the item with its name, and how many buy-outs stand. */
export async function requirementBuyout(requirementId: string): Promise<{ unitCents: number | null; item: { qboId: string; name: string | null; active: boolean } | null; live: number }> {
  const [r] = await db.select({ unitCents: requirement.buyoutUnitCents, itemQboId: requirement.itemQboId }).from(requirement).where(eq(requirement.id, requirementId));
  const [live] = await db.select({ n: count() }).from(buyout).where(and(eq(buyout.requirementId, requirementId), inArray(buyout.state, [...LIVE_STATES])));
  const item = r?.itemQboId ? (await listItems()).find((i) => i.qboId === r.itemQboId) ?? null : null;
  return { unitCents: r?.unitCents ?? null, item: r?.itemQboId ? { qboId: r.itemQboId, name: item?.name ?? null, active: item?.active ?? false } : null, live: live?.n ?? 0 };
}

/**
 * Offers a buy-out on a volunteer requirement, changes its price or item, or (with `price: null`) switches it off for
 * new choices. Buy-outs already chosen keep the price and item they were chosen at. Under the roster lock and against
 * the company the page was shown (`rosterTag`): the item id is that company's, and must be an active one in the list
 * read from QuickBooks (an inactive one already chosen may stay). `price` is the text staff typed, in dollars and cents.
 */
export async function setBuyout(requirementId: string, rosterTag: string, ask: { price: string | null; itemQboId: string | null }, o: BuyoutOp): Promise<Done> {
  const unitCents = ask.price === null ? null : parsePrice(ask.price);
  if (ask.price !== null && unitCents === null) return refuse("Enter the price in dollars and cents, more than $0 and at most $10,000.00 (for example 25.00).");
  if (unitCents !== null && ask.itemQboId === null) return refuse("Choose the product or service the buy-out is billed with.");
  return db.transaction(async (tx): Promise<Done> => {
    if (!(await lockRosterAs(tx, rosterTag))) return refuse(ROSTER_MOVED);
    const [r] = await tx.select().from(requirement).where(eq(requirement.id, requirementId)).for("update");
    if (!r) return refuse("That isn't there any more. Reload the page.");
    if (r.kind !== "volunteer" || r.amount === null || r.amountUnit === null) return refuse("Only a volunteer requirement with an amount can offer a buy-out.");
    const items = await listItems(tx);
    const itemQboId = unitCents === null ? r.itemQboId : ask.itemQboId;
    if (unitCents !== null) {
      const item = items.find((i) => i.qboId === itemQboId);
      if (!item) return refuse("That product or service isn't in the list read from QuickBooks. Read the list again and choose from it.");
      if (!item.active && item.qboId !== r.itemQboId) return refuse("That product or service is inactive in QuickBooks. Choose another.");
    }
    if (r.buyoutUnitCents === unitCents && r.itemQboId === itemQboId) return { ok: true, message: "Nothing changed." };
    await tx.update(requirement).set({ buyoutUnitCents: unitCents, itemQboId, updatedAt: new Date() }).where(eq(requirement.id, r.id));
    const named = (id: string | null) => (id === null ? null : { qboId: id, name: items.find((i) => i.qboId === id)?.name ?? null });
    await writeAudit({ actor: o.actor, action: "season.requirement.buyout", permission: o.permission, targetType: "requirement", targetId: r.id, ip: o.ip,
      before: { title: r.title, unitCents: r.buyoutUnitCents, item: named(r.itemQboId) }, after: { unitCents, item: named(itemQboId) } }, tx);
    return { ok: true, message: unitCents === null ? "Switched off. Families can't choose a buy-out for this now; any already chosen stay as they are." : "Saved. Families can choose to pay instead of volunteering." };
  });
}
