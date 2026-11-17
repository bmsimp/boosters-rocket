import { notFound, redirect } from "next/navigation";
import { env } from "@/env";
import { getSetupState, isSetupStep, MAIL_FIRST_URL, SETUP_STEPS, type SetupStep } from "@/lib/setup/state";
import { hasSetupSession } from "@/lib/setup/session";
import { providerSummaries, pendingOnlySummaries, type ProviderKey, type ProviderSummary } from "@/lib/auth/providers";
import { UnlockForm } from "./unlock-form";
import { mailSummary, mailWorking } from "@/lib/mail/settings";
import { StaffStep, MailStep, AdminStep, ClubStep } from "./steps";
import { PortalAddress } from "../components/portal-address";
import { clubStepOwed, setupAsksForClub, CLUB_FIRST_URL } from "@/lib/setup/club-step";
import { getClubSettings, timeZoneChoices } from "@/lib/settings/club";

export const metadata = { title: "Set up Booster Rocket" };
export const dynamic = "force-dynamic";

const NAMES: Record<SetupStep, string> = { club: "Your club", staff: "Staff sign-in", mail: "Outgoing mail", admin: "First Admin" };

/** The address is part of setting the portal up: it is shown at every step, and checked against the one this browser used. */
function AddressBox() {
  return <section className="box" aria-labelledby="setup-address-h"><h2 id="setup-address-h">This portal&apos;s address</h2><PortalAddress /></section>;
}

/** What the club step's form starts from: the saved values, or blank ones on a new installation, never the default name. */
async function clubValues() {
  const { name, shortName, color, timeZone } = await getClubSettings();
  return (await clubStepOwed()) ? { name: "", shortName: "", color, timeZone } : { name, shortName, color, timeZone };
}

export default async function SetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getSetupState();
  if (state.status !== "open") notFound();
  if (!(await hasSetupSession())) {
    return (
      <main className="wrap signin setup-page">
        <h1 className="page-title">Set up Booster Rocket</h1>
        <p className="lede">Enter the setup code from your server. To get one, run <code>docker compose run --rm migrate node tools/scripts/setup-code.mjs</code> in the installation folder (the first installation runbook, <code>docs/runbooks/first-install.md</code>, says how).</p>
        <UnlockForm />
        <AddressBox />
      </main>
    );
  }
  const sp = await searchParams;
  const one = (k: string) => { const v = sp[k]; return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined; };
  const asked = one("step");
  // The club step is asked only on a new installation; a setup reopened on an existing one starts at staff sign-in.
  const withClub = await setupAsksForClub();
  const steps = SETUP_STEPS.filter((s) => withClub || s !== "club");
  const wanted: SetupStep = isSetupStep(asked) ? asked : state.step;
  const step: SetupStep = steps.includes(wanted) ? wanted : "staff";
  const n = (s: SetupStep) => steps.indexOf(s) + 1;
  if (step === "admin" && (await clubStepOwed())) redirect(CLUB_FIRST_URL);
  if (step === "admin" && !(await mailWorking())) redirect(MAIL_FIRST_URL);
  const saved = await providerSummaries();
  const byKey = Object.fromEntries([...saved, ...(await pendingOnlySummaries(saved.map((s) => s.key)))].map((s) => [s.key, s])) as Partial<Record<ProviderKey, ProviderSummary>>;
  const appUrl = env.APP_URL.replace(/\/+$/, "");
  return (
    <main className="wrap single setup-page">
      <h1 className="page-title">Set up Booster Rocket</h1>
      <ol className="setup-progress">{steps.map((s) => <li key={s} aria-current={s === step ? "step" : undefined}>{`${n(s)}. ${NAMES[s]}`}</li>)}</ol>
      {step === "club" && <ClubStep initial={await clubValues()} timeZones={timeZoneChoices((await getClubSettings()).timeZone)} saved={!(await clubStepOwed())} error={one("error")} />}
      {step === "staff" && <StaffStep n={n("staff")} appUrl={appUrl} byKey={byKey} error={one("error")} />}
      {step === "mail" && <MailStep n={n("mail")} summary={await mailSummary()} error={one("error")} />}
      {step === "admin" && <AdminStep n={n("admin")} adminEmail={state.adminEmail} adminName={state.adminName} byKey={byKey} error={one("error")} signinFailed={one("signin") === "failed"} />}
      <AddressBox />
    </main>
  );
}
