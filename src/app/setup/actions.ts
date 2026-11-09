"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { setupAction, setupUnlockAction, SETUP_SESSION_ENDED } from "@/lib/setup/guard";
import { verifySetupCode } from "@/lib/setup/code";
import { startSetupSession } from "@/lib/setup/session";
import { getSetupState, updateSetupState, saveAdminEmail, type SetupStep } from "@/lib/setup/state";
import { isProviderKey, parseProviderForm, saveProvider, providerSummaries, type SaveOutcome } from "@/lib/auth/providers";
import { checkFor } from "@/lib/auth/provider-checks";
import { isCertificateProvider, startCertificateReplacement, discardPendingCertificate } from "@/lib/auth/certificates";
import { requestIp } from "@/lib/request";

const UNLOCK_MESSAGES = {
  wrong: "That code isn't right. Check it against what the server printed.",
  slowed: "Too many wrong codes from here. Wait 15 minutes and try again.",
  void: "This code stopped working after too many wrong tries. On the server, run scripts/poc/setup-code.sh for a new one.",
  no_code: "No setup code has been issued yet. On the server, run scripts/poc/setup-code.sh.",
} as const;

export const unlockSetupAction = setupUnlockAction(async (_prev: { error: string } | null, form: FormData): Promise<{ error: string } | null> => {
  if ((await getSetupState()).status !== "open") return { error: "Setup is already finished." };
  const r = await verifySetupCode(String(form.get("code") ?? ""), await requestIp());
  if (!r.ok) return { error: UNLOCK_MESSAGES[r.reason] };
  await startSetupSession(r.codeHash);
  redirect("/setup");
});

const SETUP_ACTOR = { door: "system", id: null, label: "setup" } as const;
const sessionEnded = () => ({ ok: false as const, errors: [SETUP_SESSION_ENDED] });
const FIELD_NAMES = ["tenantId", "clientId", "tenantSubdomain", "secret", "secretExpiresAt"] as const;

export const saveSetupProviderAction = setupAction(async (key: string, form: FormData): Promise<SaveOutcome> => {
  if (!isProviderKey(key)) return { ok: false, errors: ["Unknown sign-in."] };
  const parsed = parseProviderForm(key, Object.fromEntries(FIELD_NAMES.map((n) => [n, String(form.get(n) ?? "")])));
  if (!parsed.ok) return parsed;
  const r = await saveProvider(parsed.draft, { actor: SETUP_ACTOR, ip: await requestIp(), updatedBy: null, check: (d) => checkFor(d) });
  revalidatePath("/setup");
  return r;
}, { onExpired: sessionEnded });


/** Replace certificate on the setup page (for example after reopen-setup.sh, when the old key can't be read). */
export const startCertificateReplacementSetupAction = setupAction(async (key: string): Promise<SaveOutcome> => {
  if (!isProviderKey(key) || !isCertificateProvider(key)) return { ok: false, errors: ["Unknown sign-in."] };
  await startCertificateReplacement(key, { actor: SETUP_ACTOR, ip: await requestIp(), createdBy: null });
  revalidatePath("/setup");
  return { ok: true };
}, { onExpired: sessionEnded });

export const discardCertificateReplacementSetupAction = setupAction(async (key: string): Promise<SaveOutcome> => {
  if (!isProviderKey(key) || !isCertificateProvider(key)) return { ok: false, errors: ["Unknown sign-in."] };
  await discardPendingCertificate(key, { actor: SETUP_ACTOR, ip: await requestIp() });
  revalidatePath("/setup");
  return { ok: true };
}, { onExpired: sessionEnded });

export const goToStepAction = setupAction(async (step: SetupStep): Promise<void> => {
  if (step !== "staff" && step !== "parent" && step !== "admin") redirect("/setup");
  if (step !== "staff") {
    const staffReady = (await providerSummaries()).some((s) => s.readable && s.key !== "parent-oidc");
    if (!staffReady) redirect("/setup?step=staff&error=staff_first");
  }
  await updateSetupState({ step });
  redirect(`/setup?step=${step}`);
});

export const saveAdminEmailAction = setupAction(async (_prev: { error: string } | null, form: FormData): Promise<{ error: string } | null> => {
  const r = await saveAdminEmail(String(form.get("email") ?? ""), await requestIp());
  if (!r.ok) return { error: r.error };
  revalidatePath("/setup");
  return null;
}, { onExpired: () => ({ error: SETUP_SESSION_ENDED }) });
