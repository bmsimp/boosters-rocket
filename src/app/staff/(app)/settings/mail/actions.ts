"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { parseMailForm, saveMailSettings, mailFormFields } from "@/lib/mail/settings";
import { sendTestMail, type SendOutcome } from "@/lib/mail/send";

const P = "Settings.Mail.ReadWrite" as const;

export const saveMailSettingsAction = staffAction(P, async (ctx, form: FormData): Promise<{ ok: true } | { ok: false; errors: string[] }> => {
  const parsed = parseMailForm(mailFormFields(form));
  if (!parsed.ok) return parsed;
  const r = await saveMailSettings(parsed.draft, { actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P });
  revalidatePath("/staff", "layout");
  return r;
});

export const sendTestMailAction = staffAction(P, async (ctx, form: FormData): Promise<SendOutcome> => {
  const r = await sendTestMail(String(form.get("to") ?? ""), { actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P });
  revalidatePath("/staff", "layout");
  return r;
});
