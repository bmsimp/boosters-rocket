"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { chooseItem, readItems } from "@/lib/money/items";
import { isUuid } from "@/lib/seasons/ids";

// The payment part of the requirement pages: the list of QuickBooks products and services, and the one a payment
// requirement is met by. Setting a season up is Season.Steps.ReadWrite, as for the rest of a requirement.
const SETUP = "Season.Steps.ReadWrite" as const;
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const NOT_FROM_PAGE: Done = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const op = (ctx: StaffCtx) => ({ actor: { door: "staff" as const, id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: SETUP });
const short = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** Reads the products and services from QuickBooks again. It takes no argument. */
export const readItemsAction = staffAction(SETUP, async (ctx): Promise<Done> => {
  const r = await readItems(op(ctx));
  if (!r.ok) return r;
  revalidatePath("/staff/seasons", "layout");
  return { ok: true, message: r.count === 1 ? "Read 1 product or service." : `Read ${r.count ?? 0} products and services.` };
});

/** Chooses (or, with null, clears) what a payment requirement is met by. The id is checked against the stored list there. */
export const chooseItemAction = staffAction(SETUP, async (ctx, requirementId: string, rosterTag: string, itemQboId: string | null): Promise<Done> => {
  if (!isUuid(requirementId) || !short(rosterTag, 64) || (itemQboId !== null && (!short(itemQboId, 32) || !/^\d+$/.test(itemQboId)))) return NOT_FROM_PAGE;
  const r = await chooseItem(requirementId, rosterTag, itemQboId, op(ctx));
  if (!r.ok) return r;
  // Parents see whether it is paid on Home and on the Season page.
  revalidatePath("/", "layout");
  return { ok: true, message: itemQboId === null ? "Saved. No product or service is chosen, so it reads \"No invoice yet\" for everyone." : "Saved." };
});
