import { notFound, redirect } from "next/navigation";
import { env } from "@/env";
import { getSetupState, isSetupStep, MAIL_FIRST_URL, type SetupStep } from "@/lib/setup/state";
import { hasSetupSession } from "@/lib/setup/session";
import { providerSummaries, pendingOnlySummaries, type ProviderKey, type ProviderSummary } from "@/lib/auth/providers";
import { UnlockForm } from "./unlock-form";
import { mailSummary, mailWorking } from "@/lib/mail/settings";
import { StaffStep, MailStep, AdminStep } from "./steps";

export const metadata = { title: "Set up Booster Rocket" };
export const dynamic = "force-dynamic";

const STEPS: { step: SetupStep; label: string }[] = [
  { step: "staff", label: "1. Staff sign-in" }, { step: "mail", label: "2. Outgoing mail" }, { step: "admin", label: "3. First Admin" },
];

export default async function SetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getSetupState();
  if (state.status !== "open") notFound();
  if (!(await hasSetupSession())) {
    return (
      <main className="wrap signin">
        <h1 className="page-title">Set up Booster Rocket</h1>
        <p className="lede">Enter the setup code from your server. <code>deploy.sh</code> prints it after a deploy, or run <code>scripts/poc/setup-code.sh</code> for a new one.</p>
        <UnlockForm />
      </main>
    );
  }
  const sp = await searchParams;
  const one = (k: string) => { const v = sp[k]; return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined; };
  const asked = one("step");
  const step: SetupStep = isSetupStep(asked) ? asked : state.step;
  if (step === "admin" && !(await mailWorking())) redirect(MAIL_FIRST_URL);
  const saved = await providerSummaries();
  const byKey = Object.fromEntries([...saved, ...(await pendingOnlySummaries(saved.map((s) => s.key)))].map((s) => [s.key, s])) as Partial<Record<ProviderKey, ProviderSummary>>;
  const appUrl = env.APP_URL.replace(/\/+$/, "");
  return (
    <main className="wrap single">
      <h1 className="page-title">Set up Booster Rocket</h1>
      <ol className="setup-progress">{STEPS.map((s) => <li key={s.step} aria-current={s.step === step ? "step" : undefined}>{s.label}</li>)}</ol>
      {step === "staff" && <StaffStep appUrl={appUrl} byKey={byKey} error={one("error")} />}
      {step === "mail" && <MailStep summary={await mailSummary()} error={one("error")} />}
      {step === "admin" && <AdminStep adminEmail={state.adminEmail} byKey={byKey} error={one("error")} signinFailed={one("signin") === "failed"} />}
    </main>
  );
}
