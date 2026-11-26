import { requireStaffPage } from "@/lib/guards";
import { env } from "@/env";
import { providerSummaries, pendingOnlySummaries, PROVIDER_KEYS } from "@/lib/auth/providers";
import { usesCertificate } from "@/lib/auth/provider-fields";
import { ProviderForm } from "@/app/components/sign-in-settings/provider-form";
import { PROVIDER_LABELS, toSummaryView } from "@/app/components/sign-in-settings/labels";
import { MicrosoftAppSteps, GoogleStaffSteps } from "@/app/setup/instructions";
import { saveSignInProviderAction, removeSignInProviderAction, startCertificateReplacementAction, discardCertificateReplacementAction } from "../actions";
import { RemoveButton } from "../remove-button";
import { Drawer } from "@/app/components/ui";

export const metadata = { title: "Set up staff sign-in" };
export const dynamic = "force-dynamic";

/** The steps for each way staff sign in: the app to make at Microsoft or Google, then its values, checked before they are saved. */
/** The button that opens a saved provider's set-up steps again, to change its app. */
const APP_WORDS = { "staff-microsoft": "Change the Microsoft app", "staff-google": "Change the Google app" } as const;

export default async function SignInSetupPage() {
  await requireStaffPage("Settings.SignIn.ReadWrite");
  const saved = await providerSummaries();
  const summaries = [...saved, ...(await pendingOnlySummaries(saved.map((x) => x.key)))];
  const appUrl = env.APP_URL.replace(/\/+$/, "");
  const script = "New-BoosterRocketStaffApp.ps1";
  const steps = { "staff-microsoft": <MicrosoftAppSteps appUrl={appUrl} script={script} example={`./${script} -TenantId <tenant>`} />, "staff-google": <GoogleStaffSteps appUrl={appUrl} /> };
  return (
    <main className="wrap single">
      <p className="back-to-settings"><a href="/staff/settings/sign-in">Back to sign-in settings</a></p>
      <h1 className="page-title">Set up staff sign-in</h1>
      <p className="lede">Set up one way or both. Microsoft sign-in uses a certificate Boosters Rocket made; Google uses a client secret, which is never shown again once saved.</p>
      {PROVIDER_KEYS.map((key) => {
        const s = summaries.find((x) => x.key === key);
        return (
          <section key={key} className="box" aria-labelledby={`${key}-h`}><h2 id={`${key}-h`}>{PROVIDER_LABELS[key]}</h2>
            {s?.readable ? <Drawer param="app" value={key} label={APP_WORDS[key]} title={`${PROVIDER_LABELS[key]}: set up or change the app`}>{steps[key]}</Drawer> : steps[key]}
            <ProviderForm providerKey={key} summary={s ? toSummaryView(s) : null} action={saveSignInProviderAction.bind(null, key)}
              certificateActions={usesCertificate(key) ? { replace: startCertificateReplacementAction.bind(null, key), discard: discardCertificateReplacementAction.bind(null, key) } : undefined} />
            {saved.some((x) => x.key === key) && <RemoveButton label={PROVIDER_LABELS[key]} action={removeSignInProviderAction.bind(null, key)} />}
          </section>
        );
      })}
    </main>
  );
}
