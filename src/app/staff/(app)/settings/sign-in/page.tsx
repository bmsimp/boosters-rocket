import { requireStaffPage } from "@/lib/guards";
import { env } from "@/env";
import { providerSummaries, pendingOnlySummaries, PROVIDER_KEYS } from "@/lib/auth/providers";
import { ProviderForm } from "@/app/components/sign-in-settings/provider-form";
import { PROVIDER_LABELS, toSummaryView } from "@/app/components/sign-in-settings/labels";
import { MicrosoftStaffSteps, GoogleStaffSteps, ParentSteps, ScriptOption } from "@/app/setup/instructions";
import { saveSignInProviderAction, removeSignInProviderAction } from "./actions";
import { RemoveButton } from "./remove-button";

export const metadata = { title: "Sign-in settings" };

export default async function SignInSettingsPage() {
  await requireStaffPage("Settings.SignIn.ReadWrite");
  const saved = await providerSummaries();
  const summaries = [...saved, ...(await pendingOnlySummaries(saved.map((x) => x.key)))];
  const appUrl = env.APP_URL.replace(/\/+$/, "");
  const steps = { "staff-microsoft": <MicrosoftStaffSteps appUrl={appUrl} />, "staff-google": <GoogleStaffSteps appUrl={appUrl} />, "parent-oidc": <ParentSteps appUrl={appUrl} /> };
  const scripts = { "staff-microsoft": "New-BoosterRocketStaffApp.ps1", "parent-oidc": "New-BoosterRocketParentApp.ps1" } as const;
  return (
    <main className="wrap single">
      <h1 className="page-title">Sign-in</h1>
      <p className="lede">How staff and parents sign in. Microsoft sign-in uses a certificate Booster Rocket made; Google uses a client secret, which is never shown again once saved.</p>
      {PROVIDER_KEYS.map((key) => {
        const s = summaries.find((x) => x.key === key);
        return (
          <section key={key} className="box" aria-labelledby={`${key}-h`}><h2 id={`${key}-h`}>{PROVIDER_LABELS[key]}</h2>
            <details><summary>How to set this up or change the app</summary>{steps[key]}</details>
            {key in scripts && <ScriptOption script={scripts[key as keyof typeof scripts]} example={`./${scripts[key as keyof typeof scripts]} -TenantId <tenant>`} />}
            <ProviderForm settings providerKey={key} summary={s ? toSummaryView(s) : null} action={saveSignInProviderAction.bind(null, key)} />
            {saved.some((x) => x.key === key) && <RemoveButton label={PROVIDER_LABELS[key]} action={removeSignInProviderAction.bind(null, key)} />}
          </section>
        );
      })}
    </main>
  );
}
