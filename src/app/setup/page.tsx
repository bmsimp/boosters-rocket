import { notFound } from "next/navigation";
import { env } from "@/env";
import { getSetupState, type SetupStep } from "@/lib/setup/state";
import { hasSetupSession } from "@/lib/setup/session";
import { providerSummaries, type ProviderKey, type ProviderSummary } from "@/lib/auth/providers";
import { UnlockForm } from "./unlock-form";
import { StaffStep, ParentStep, AdminStep } from "./steps";

export const metadata = { title: "Set up Booster Rocket" };
export const dynamic = "force-dynamic";

const STEPS: { step: SetupStep; label: string }[] = [
  { step: "staff", label: "1. Staff sign-in" }, { step: "parent", label: "2. Parent sign-in" }, { step: "admin", label: "3. First Admin" },
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
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const asked = one("step");
  const step: SetupStep = asked === "staff" || asked === "parent" || asked === "admin" ? asked : state.step;
  const byKey = Object.fromEntries((await providerSummaries()).map((s) => [s.key, s])) as Partial<Record<ProviderKey, ProviderSummary>>;
  const appUrl = env.APP_URL.replace(/\/+$/, "");
  return (
    <main className="wrap single">
      <h1 className="page-title">Set up Booster Rocket</h1>
      <ol className="setup-progress">{STEPS.map((s) => <li key={s.step} aria-current={s.step === step ? "step" : undefined}>{s.label}</li>)}</ol>
      {step === "staff" && <StaffStep appUrl={appUrl} byKey={byKey} error={one("error")} />}
      {step === "parent" && <ParentStep appUrl={appUrl} byKey={byKey} tested={one("tested")} />}
      {step === "admin" && <AdminStep adminEmail={state.adminEmail} byKey={byKey} error={one("error")} />}
    </main>
  );
}
