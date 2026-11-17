"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { setupAction, setupUnlockAction, SETUP_SESSION_ENDED } from "@/lib/setup/guard";
import { verifySetupCode } from "@/lib/setup/code";
import { startSetupSession } from "@/lib/setup/session";
import { getSetupState, updateSetupState, MAIL_FIRST_URL, saveFirstAdmin, isSetupStep, type SetupStep } from "@/lib/setup/state";
import { clubStepOwed, CLUB_FIRST_URL } from "@/lib/setup/club-step";
import { getClubSettings, saveClubSettings } from "@/lib/settings/club";
import { isProviderKey, parseProviderForm, saveProvider, providerSummaries, type SaveOutcome } from "@/lib/auth/providers";
import { checkFor } from "@/lib/auth/provider-checks";
import { isCertificateProvider, startCertificateReplacement, discardPendingCertificate } from "@/lib/auth/certificates";
import { requestIp } from "@/lib/request";
import { parseMailForm, saveMailSettings, mailWorking, mailFormFields } from "@/lib/mail/settings";
import { sendTestMail, type SendOutcome } from "@/lib/mail/send";

const UNLOCK_MESSAGES = {
  wrong: "That code isn't right. Check it against what the server printed.",
  slowed: "Too many wrong codes from here. Wait 15 minutes and try again.",
  void: "This code stopped working after too many wrong tries. On the server, in the installation folder, run docker compose run --rm migrate node tools/scripts/setup-code.mjs for a new one (docs/runbooks/first-install.md).",
  no_code: "No setup code has been issued yet. On the server, in the installation folder, run docker compose run --rm migrate node tools/scripts/setup-code.mjs (docs/runbooks/first-install.md).",
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
const FIELD_NAMES = ["tenantId", "clientId", "secret", "secretExpiresAt"] as const;

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

type MailSaveResult = { ok: true } | { ok: false; errors: string[] };

export const saveSetupMailAction = setupAction(async (form: FormData): Promise<MailSaveResult> => {
  const parsed = parseMailForm(mailFormFields(form));
  if (!parsed.ok) return parsed;
  const r = await saveMailSettings(parsed.draft, { actor: SETUP_ACTOR, ip: await requestIp() });
  revalidatePath("/setup");
  return r;
}, { onExpired: sessionEnded });

export const sendSetupTestMailAction = setupAction(async (form: FormData): Promise<SendOutcome> => {
  const r = await sendTestMail(String(form.get("to") ?? ""), { actor: SETUP_ACTOR, ip: await requestIp() });
  revalidatePath("/setup");
  return r;
}, { onExpired: () => ({ ok: false as const, error: SETUP_SESSION_ENDED }) });

/**
 * The club's name, short name, color and time zone, by the Club settings' own rules (saveClubSettings). The treasurer's
 * email is not asked here and is kept as it is.
 */
export const saveSetupClubAction = setupAction(async (fields: unknown): Promise<{ ok: true; message: string } | { ok: false; errors: string[] }> => {
  const f = (fields ?? {}) as Record<string, unknown>;
  const text = (k: string) => (typeof f[k] === "string" && (f[k] as string).length <= 200 ? (f[k] as string) : null);
  const [name, shortName, color, timeZone] = [text("name"), text("shortName"), text("color"), text("timeZone")];
  if (name === null || shortName === null || color === null || timeZone === null) return { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
  const { treasurerEmail } = await getClubSettings();
  const r = await saveClubSettings({ name, shortName, color, timeZone, treasurerEmail: treasurerEmail ?? "" }, SETUP_ACTOR, await requestIp());
  if (!r.ok) return r;
  revalidatePath("/", "layout"); // the bar, the page titles and the app's name use it at once
  return { ok: true, message: "Saved. Go on to staff sign-in when you're ready." };
}, { onExpired: sessionEnded });

export const goToStepAction = setupAction(async (step: SetupStep): Promise<void> => {
  if (!isSetupStep(step)) redirect("/setup");
  if (step === "admin" && (await clubStepOwed())) redirect(CLUB_FIRST_URL);
  if (step !== "staff" && step !== "club") {
    const staffReady = (await providerSummaries()).some((s) => s.readable);
    if (!staffReady) redirect("/setup?step=staff&error=staff_first");
  }
  if (step === "admin" && !(await mailWorking())) redirect(MAIL_FIRST_URL);
  await updateSetupState({ step });
  redirect(`/setup?step=${step}`);
});

/** The first Admin's name and email. Not before the club has a name, so the portal never finishes with the default one. */
export const saveFirstAdminAction = setupAction(async (_prev: { error: string } | null, form: FormData): Promise<{ error: string } | null> => {
  if (await clubStepOwed()) return { error: "Give the club its name first (step 1)." };
  const r = await saveFirstAdmin(String(form.get("name") ?? ""), String(form.get("email") ?? ""), await requestIp());
  if (!r.ok) return { error: r.error };
  revalidatePath("/setup");
  return null;
}, { onExpired: () => ({ error: SETUP_SESSION_ENDED }) });
