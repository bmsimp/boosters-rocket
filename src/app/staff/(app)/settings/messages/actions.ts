"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { setMessagesEmailAllowed } from "@/lib/settings/messages";

type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const NOT_FROM_PAGE: Done = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };

/** Allow messages to be emailed to families, or stop it (Admin only). The page sends a boolean; anything else is refused. */
export const setMessagesEmailAction = staffAction("Settings.Messages.ReadWrite", async (ctx, on: unknown): Promise<Done> => {
  if (typeof on !== "boolean") return NOT_FROM_PAGE;
  await setMessagesEmailAllowed(on, { actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip });
  revalidatePath("/staff", "layout");
  return { ok: true, message: on ? "Saved. Messages can be emailed to families: the post form offers it, ticked." : "Saved. Messages are no longer emailed to families." };
});
