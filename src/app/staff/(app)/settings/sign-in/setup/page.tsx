import { requireStaffPage } from "@/lib/guards";
import { env } from "@/env";
import { providerSummaries, pendingOnlySummaries, PROVIDER_KEYS } from "@/lib/auth/providers";
import { usesCertificate } from "@/lib/auth/provider-fields";
import { ProviderForm } from "@/app/components/sign-in-settings/provider-form";
import { PROVIDER_LABELS, toSummaryView } from "@/app/components/sign-in-settings/labels";
import { MicrosoftStaffSteps, GoogleStaffSteps, ScriptOption } from "@/app/setup/instructions";
import { saveSignInProviderAction, removeSignInProviderAction, startCertificateReplacementAction, discardCertificateReplacementAction } from "../actions";
import { RemoveButton } from "../remove-button";

export const metadata = { title: "Set up staff sign-in" };
export const dynamic = "force-dynamic";

/** The steps for each way staff sign in: the app to make at Microsoft or Google, then its values, checked before they are saved. */
export default async function SignInSetupPage() {
  await requireStaffPage("Settings.SignIn.ReadWrite");
  const saved = await providerSummaries();
  const summaries = [...saved, ...(await pendingOnlySummaries(saved.map((x) => x.key)))];
  const appUrl = env.APP_URL.replace(/\/+$/, "");
  const steps = { "staff-microsoft": <MicrosoftStaffSteps appUrl={appUrl} />, "staff-google": <GoogleStaffSteps appUrl={appUrl} /> };
  const scripts = { "staff-microsoft": "New-BoosterRocketStaffApp.ps1" } as const;
  return (
    <main className="wrap single">
      <p className="back-to-settings"><a href="/staff/settings/sign-in">Back to sign-in settings</a></p>
      <h1 className="page-title">Set up staff sign-in</h1>
      <p className="lede">Set up one way or both. Microsoft sign-in uses a certificate Boosters Rocket made; Google uses a client secret, which is never shown again once saved.</p>
      {PROVIDER_KEYS.map((key) => {
        const s = summaries.find((x) => x.key === key);
        return (
          <section key={key} className="box" aria-labelledby={`${key}-h`}><h2 id={`${key}-h`}>{PROVIDER_LABELS[key]}</h2>
            {s?.readable ? <details className="more"><summary>How to set this up or change the app</summary>{steps[key]}</details> : steps[key]}
            {key in scripts && <ScriptOption script={scripts[key as keyof typeof scripts]} example={`./${scripts[key as keyof typeof scripts]} -TenantId <tenant>`} />}
            <ProviderForm providerKey={key} summary={s ? toSummaryView(s) : null} action={saveSignInProviderAction.bind(null, key)}
              certificateActions={usesCertificate(key) ? { replace: startCertificateReplacementAction.bind(null, key), discard: discardCertificateReplacementAction.bind(null, key) } : undefined} />
            {saved.some((x) => x.key === key) && <RemoveButton label={PROVIDER_LABELS[key]} action={removeSignInProviderAction.bind(null, key)} />}
          </section>
        );
      })}
    </main>
  );
}
