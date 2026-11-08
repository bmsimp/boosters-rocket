"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { saveClubSettings } from "@/lib/settings/club";

export const saveClubAction = staffAction("Settings.Club.ReadWrite", async (ctx, form: FormData) => {
  const r = await saveClubSettings({
    name: String(form.get("name") ?? ""), shortName: String(form.get("shortName") ?? ""),
    color: String(form.get("color") ?? ""), treasurerEmail: String(form.get("treasurerEmail") ?? ""),
  }, { door: "staff", id: ctx.staffUserId, label: ctx.email }, ctx.ip);
  revalidatePath("/", "layout");
  return r;
});
