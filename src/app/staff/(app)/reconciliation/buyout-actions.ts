"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { closeBuyout } from "@/lib/buyouts/close";
import { NOTE_MAX } from "@/lib/roster/queue";
import { isUuid } from "@/lib/seasons/ids";

// Closing a buy-out, from Reconciliation and from a family's buy-outs page (src/lib/buyouts/close.ts). Like every other
// action on Reconciliation it needs Roster.Family.ReadWrite, and also Roster.Read, the pages' own permission. A server
// action can be called with any values, not only the ones its page sends: each argument is checked here, and the
// buy-out is looked up again in the close's transaction, under the roster lock.
const P = "Roster.Family.ReadWrite" as const;
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const NOT_FROM_PAGE = { ok: false as const, errors: ["That didn't go through. Reload the page and try again."] };
const TAG_MAX = 64;
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

export const closeBuyoutAction = staffAction(P, async (ctx: StaffCtx, buyoutId: string, shownTag: string, rosterTag: string, note: string): Promise<Done> => {
  if (!can(ctx.effective, "Roster.Read") || !isUuid(buyoutId) || !text(shownTag, TAG_MAX) || !text(rosterTag, TAG_MAX) || typeof note !== "string" || note.length > NOTE_MAX * 4) return NOT_FROM_PAGE;
  const r = await closeBuyout(buyoutId, shownTag, rosterTag, note, { actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P });
  // The family's pages and every staff page that shows the buy-out read the same row.
  if (r.ok) revalidatePath("/", "layout");
  return r;
});
