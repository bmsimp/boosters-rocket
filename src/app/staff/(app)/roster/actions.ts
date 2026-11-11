"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { refreshRoster } from "@/lib/roster/refresh";

const P = "Roster.Read" as const;

export const refreshRosterAction = staffAction(P, async (ctx): Promise<{ ok: true; message: string } | { ok: false; error: string }> => {
  const r = await refreshRoster({ startedBy: ctx.staffUserId, actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, manual: true });
  // A refusal changed nothing, so the page isn't rendered again: on a family's page that would write a second
  // roster.family.read row for one visit.
  if (r.ok || (r.reason !== "too_soon" && r.reason !== "running")) revalidatePath("/staff", "layout");
  if (r.ok) return { ok: true, message: `Read ${r.customers} customers from QuickBooks.` };
  return { ok: false, error:
    r.reason === "running" ? "A refresh is already under way. Try again in a minute."
    : r.reason === "too_soon" ? "A refresh ran less than 5 minutes ago. Try again shortly."
    : r.reason === "not_connected" ? "QuickBooks isn't connected. An Admin can connect it under QuickBooks."
    : `The refresh didn't work: ${r.error ?? "no reason was recorded"}` };
});
