"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { setBuyout } from "@/lib/buyouts/setup";
import { isUuid } from "@/lib/seasons/ids";

// The buy-out part of a volunteer requirement's page (v1 spec §11.5): its price per unit and the QuickBooks product or
// service it is billed with. Setting a season up is Season.Steps.ReadWrite, as for the rest of a requirement.
const SETUP = "Season.Steps.ReadWrite" as const;
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const NOT_FROM_PAGE: Done = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const short = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/**
 * Offers a buy-out at `price` (the dollars and cents staff typed) billed with `itemQboId`, or with `price` null switches
 * it off for new choices. Every argument came from a browser: the id is checked against the stored list there.
 */
export const setBuyoutAction = staffAction(SETUP, async (ctx: StaffCtx, requirementId: string, rosterTag: string, price: string | null, itemQboId: string | null): Promise<Done> => {
  if (!isUuid(requirementId) || !short(rosterTag, 64) || (price !== null && !short(price, 20)) || (itemQboId !== null && (!short(itemQboId, 32) || !/^\d+$/.test(itemQboId)))) return NOT_FROM_PAGE;
  const r = await setBuyout(requirementId, rosterTag, { price, itemQboId }, { actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: SETUP });
  // Parents see the choice on the Volunteer page.
  if (r.ok) revalidatePath("/", "layout");
  return r;
});
