import { PROVIDER_LABELS, toSummaryView } from "@/app/components/sign-in-settings/labels";
import { ProviderForm } from "@/app/components/sign-in-settings/provider-form";
import type { ProviderKey, ProviderSummary } from "@/lib/auth/providers";
import type { MailSummary } from "@/lib/mail/settings";
import { MailSettingsCard } from "@/app/components/mail-settings/mail-card";
import { MicrosoftMailSetup, SmtpHelp } from "@/app/components/mail-settings/mail-steps";
import {
  saveSetupProviderAction, goToStepAction, saveFirstAdminAction, startCertificateReplacementSetupAction, discardCertificateReplacementSetupAction,
  saveSetupMailAction, sendSetupTestMailAction, saveSetupClubAction,
} from "./actions";
import { ClubForm, type ClubValues } from "@/app/components/club-settings/club-form";
import { MicrosoftStaffSteps, GoogleStaffSteps, ScriptOption } from "./instructions";
import { SetupStaffSignIn, SetupStaffSignOut } from "./setup-buttons";
import { FirstAdminForm } from "./admin-email-form";

type ByKey = Partial<Record<ProviderKey, ProviderSummary>>;
const view = (s?: ProviderSummary) => (s ? toSummaryView(s) : null);
const certificateActions = (key: "staff-microsoft") =>
  ({ replace: startCertificateReplacementSetupAction.bind(null, key), discard: discardCertificateReplacementSetupAction.bind(null, key) });

/** The club's name, short name, color and time zone, asked first on a new installation, by the Club settings' rules. */
export function ClubStep({ initial, timeZones, saved, error }: { initial: ClubValues; timeZones: string[]; saved: boolean; error?: string }) {
  return (
    <>
      <h2 className="page-title">Step 1: Your club</h2>
      <p className="lede">The club&apos;s name and color are on every page, in every email and on the app parents put on their phones. You can change them later under Settings.</p>
      {error === "club_first" && <p role="alert" className="errors">Give the club its name and color first.</p>}
      <section className="box" aria-labelledby="club-h"><h2 id="club-h">Name, color and time zone</h2>
        <ClubForm initial={initial} timeZones={timeZones} save={saveSetupClubAction} submit="Save" />
      </section>
      <form action={goToStepAction.bind(null, "staff")}><button className="btn" disabled={!saved}>Next: staff sign-in</button></form>
    </>
  );
}

export function StaffStep({ n, appUrl, byKey, error }: { n: number; appUrl: string; byKey: ByKey; error?: string }) {
  const ready = Boolean(byKey["staff-microsoft"]?.readable || byKey["staff-google"]?.readable);
  return (
    <>
      <h2 className="page-title">Step {n}: Staff sign-in</h2>
      <p className="lede">Board members and directors sign in with Microsoft, Google, or both. Set up at least one.</p>
      {error === "staff_first" && <p role="alert" className="errors">Save at least one staff sign-in first.</p>}
      <section className="box" aria-labelledby="ms-h"><h2 id="ms-h">{PROVIDER_LABELS["staff-microsoft"]}</h2>
        <MicrosoftStaffSteps appUrl={appUrl} />
        <ScriptOption script="New-BoosterRocketStaffApp.ps1" example="./New-BoosterRocketStaffApp.ps1 -TenantId <your tenant ID or domain>" />
        <ProviderForm providerKey="staff-microsoft" summary={view(byKey["staff-microsoft"])} action={saveSetupProviderAction.bind(null, "staff-microsoft")}
          certificateActions={certificateActions("staff-microsoft")} />
      </section>
      <section className="box" aria-labelledby="g-h"><h2 id="g-h">{PROVIDER_LABELS["staff-google"]}</h2>
        <GoogleStaffSteps appUrl={appUrl} />
        <ProviderForm providerKey="staff-google" summary={view(byKey["staff-google"])} action={saveSetupProviderAction.bind(null, "staff-google")} />
      </section>
      <form action={goToStepAction.bind(null, "mail")}><button className="btn" disabled={!ready}>Next: outgoing mail</button></form>
    </>
  );
}

export function MailStep({ n, summary, error }: { n: number; summary: MailSummary; error?: string }) {
  return (
    <>
      <h2 className="page-title">Step {n}: Outgoing mail</h2>
      <p className="lede">Parents sign in with a code the portal emails them, so the portal has to be able to send mail first. Use Microsoft 365 if the club has it; otherwise use your mail provider&apos;s SMTP settings.</p>
      {error === "mail_first" && <p role="alert" className="errors">Save the mail settings and send a test email before going on.</p>}
      <section className="box" aria-labelledby="mail-h"><h2 id="mail-h">Outgoing mail</h2>
        <MicrosoftMailSetup summary={summary} />
        <MailSettingsCard summary={summary} save={saveSetupMailAction} test={sendSetupTestMailAction} />
        <SmtpHelp />
      </section>
      <div className="stack">
        <form action={goToStepAction.bind(null, "admin")}><button className="btn" disabled={!summary.working}>Next: first Admin</button></form>
        <form action={goToStepAction.bind(null, "staff")}><button className="btn btn-line">Back to staff sign-in</button></form>
      </div>
    </>
  );
}

const ADMIN_ERRORS: Record<string, string> = {
  no_session: "The sign-in didn't complete. Try again.",
  not_matched: "That sign-in worked, but it wasn't the Admin email entered above. Sign out, then sign in with that account.",
  other_email: "You signed in with a different account from the Admin email entered above. Sign out, then sign in with that account.",
  not_admin: "That account is a staff member but not an Admin. Sign in as an Admin.",
};

const SIGNIN_FAILED = "The sign-in didn't complete. Check the staff sign-in values in the staff sign-in step, then try again.";

export function AdminStep({ n, adminEmail, adminName, byKey, error, signinFailed }: {
  n: number; adminEmail: string | null; adminName: string | null; byKey: ByKey; error?: string; signinFailed?: boolean;
}) {
  const message = signinFailed ? SIGNIN_FAILED : error ? ADMIN_ERRORS[error] : undefined;
  return (
    <>
      <h2 className="page-title">Step {n}: First Admin</h2>
      <p className="lede">Enter the name and email of the person who will be Admin, then sign in as them. When that works, setup closes and you&apos;re taken to the staff home.</p>
      <section className="box" aria-labelledby="a-h"><h2 id="a-h">Admin</h2>
        <FirstAdminForm initialName={adminName ?? ""} initialEmail={adminEmail ?? ""} action={saveFirstAdminAction} />
        {adminEmail && <div className="stack">
          {byKey["staff-microsoft"]?.readable && <SetupStaffSignIn provider="microsoft" label="Sign in with Microsoft" />}
          {byKey["staff-google"]?.readable && <SetupStaffSignIn provider="google" label="Sign in with Google" />}
        </div>}
        {message && <><p role="alert" className="errors">{message}</p><SetupStaffSignOut /></>}
      </section>
      <form action={goToStepAction.bind(null, "mail")}><button className="btn btn-line">Back to outgoing mail</button></form>
    </>
  );
}
