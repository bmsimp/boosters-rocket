"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { saveClubSettings } from "@/lib/settings/club";

const NOT_FROM_PAGE = { ok: false as const, errors: ["That didn't go through. Reload the page and try again."] };

/** The club's name, short name, color, treasurer's email and time zone, by saveClubSettings' rules. Every value is checked for type and size first. */
export const saveClubAction = staffAction("Settings.Club.ReadWrite", async (ctx, values: unknown) => {
  const v = (values ?? {}) as Record<string, unknown>;
  const text = (k: string) => (typeof v[k] === "string" && (v[k] as string).length <= 320 ? (v[k] as string) : null);
  const fields = { name: text("name"), shortName: text("shortName"), color: text("color"), treasurerEmail: text("treasurerEmail") ?? "", timeZone: text("timeZone") };
  if (fields.name === null || fields.shortName === null || fields.color === null || fields.timeZone === null) return NOT_FROM_PAGE;
  const r = await saveClubSettings(fields, { door: "staff", id: ctx.staffUserId, label: ctx.email }, ctx.ip);
  if (!r.ok) return r;
  revalidatePath("/", "layout");
  return { ok: true as const, message: "Saved. Every page now uses these." };
});
