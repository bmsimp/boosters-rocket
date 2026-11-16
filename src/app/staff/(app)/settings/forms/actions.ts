"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { checkFormsConnection, newWebhookSecret, parseFormsForm, saveFormsSettings } from "@/lib/forms/settings";

const P = "Settings.Forms.ReadWrite" as const;
const op = (ctx: StaffCtx) => ({ actor: { door: "staff" as const, id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P });
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
// A server action can be called with any values: each is checked for type and size before the library sees it.
const NOT_FROM_PAGE: Done = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

/** Saves Documenso's address and API token. A blank token keeps the saved one. */
export const saveFormsSettingsAction = staffAction(P, async (ctx, origin: string, token: string): Promise<Done> => {
  if (!text(origin, 400) || !text(token, 600)) return NOT_FROM_PAGE;
  const parsed = parseFormsForm({ origin, token });
  if (!parsed.ok) return parsed;
  const saved = await saveFormsSettings(parsed.draft, op(ctx));
  if (!saved.ok) return saved;
  revalidatePath("/", "layout"); // parents' pages say whether forms are ready
  return { ok: true, message: "Saved. Check the connection next." };
});

/** Documenso's health answer, then one call with the token. */
export const checkFormsConnectionAction = staffAction(P, async (): Promise<Done> => {
  const result = await checkFormsConnection();
  revalidatePath("/staff", "layout");
  return result;
});

/**
 * Makes a new webhook secret and returns it to the Admin who asked, once, to paste into Documenso. It is the one
 * secret the portal ever sends to a browser, and only in the answer to this press: the page can't show it again.
 */
export const newWebhookSecretAction = staffAction(P, async (ctx): Promise<{ ok: true; message: string; secret: string } | { ok: false; errors: string[] }> => {
  const made = await newWebhookSecret(op(ctx));
  if (!made.ok) return made;
  revalidatePath("/staff", "layout");
  return { ok: true, message: "Made. Copy it into Documenso now: it isn't shown again.", secret: made.secret };
});
