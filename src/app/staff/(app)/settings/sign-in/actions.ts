"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { isProviderKey, parseProviderForm, saveProvider, removeProvider, type SaveOutcome } from "@/lib/auth/providers";
import { checkFor } from "@/lib/auth/provider-checks";
import { isCertificateProvider, startCertificateReplacement, discardPendingCertificate } from "@/lib/auth/certificates";

const FIELD_NAMES = ["tenantId", "clientId", "tenantSubdomain", "secret", "secretExpiresAt"] as const;
const P = "Settings.SignIn.ReadWrite" as const;

export const saveSignInProviderAction = staffAction(P, async (ctx, key: string, form: FormData): Promise<SaveOutcome> => {
  if (!isProviderKey(key)) return { ok: false, errors: ["Unknown sign-in."] };
  const parsed = parseProviderForm(key, Object.fromEntries(FIELD_NAMES.map((n) => [n, String(form.get(n) ?? "")])));
  if (!parsed.ok) return parsed;
  const r = await saveProvider(parsed.draft, { actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P, updatedBy: ctx.staffUserId, check: (d) => checkFor(d) });
  revalidatePath("/staff", "layout");
  return r;
});

export const removeSignInProviderAction = staffAction(P, async (ctx, key: string): Promise<SaveOutcome> => {
  if (!isProviderKey(key)) return { ok: false, errors: ["Unknown sign-in."] };
  const r = await removeProvider(key, { actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P });
  revalidatePath("/staff", "layout");
  return r;
});

/** Replace certificate: a new pending certificate to add to the app registration; the active one keeps working until Check and switch. */
export const startCertificateReplacementAction = staffAction(P, async (ctx, key: string): Promise<SaveOutcome> => {
  if (!isProviderKey(key) || !isCertificateProvider(key)) return { ok: false, errors: ["Unknown sign-in."] };
  await startCertificateReplacement(key, { actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, createdBy: ctx.staffUserId, permission: P });
  revalidatePath("/staff", "layout");
  return { ok: true };
});

export const discardCertificateReplacementAction = staffAction(P, async (ctx, key: string): Promise<SaveOutcome> => {
  if (!isProviderKey(key) || !isCertificateProvider(key)) return { ok: false, errors: ["Unknown sign-in."] };
  await discardPendingCertificate(key, { actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P });
  revalidatePath("/staff", "layout");
  return { ok: true };
});
