import { PROVIDER_LABELS, toSummaryView } from "@/app/components/sign-in-settings/labels";
import { ProviderForm } from "@/app/components/sign-in-settings/provider-form";
import type { ProviderKey, ProviderSummary } from "@/lib/auth/providers";
import { saveSetupProviderAction, goToStepAction, saveAdminEmailAction } from "./actions";
import { MicrosoftStaffSteps, GoogleStaffSteps, ParentSteps, ScriptOption } from "./instructions";
import { SetupStaffSignIn, SetupParentTest, SetupStaffSignOut } from "./setup-buttons";
import { AdminEmailForm } from "./admin-email-form";

type ByKey = Partial<Record<ProviderKey, ProviderSummary>>;
const view = (s?: ProviderSummary) => (s ? toSummaryView(s) : null);

export function StaffStep({ appUrl, byKey, error }: { appUrl: string; byKey: ByKey; error?: string }) {
  const ready = Boolean(byKey["staff-microsoft"]?.readable || byKey["staff-google"]?.readable);
  return (
    <>
      <h2 className="page-title">Step 1: Staff sign-in</h2>
      <p className="lede">Board members and directors sign in with Microsoft, Google, or both. Set up at least one.</p>
      {error === "staff_first" && <p role="alert" className="errors">Save at least one staff sign-in first.</p>}
      <section className="box" aria-labelledby="ms-h"><h2 id="ms-h">{PROVIDER_LABELS["staff-microsoft"]}</h2>
        <MicrosoftStaffSteps appUrl={appUrl} />
        <ScriptOption script="New-BoosterRocketStaffApp.ps1" example="./New-BoosterRocketStaffApp.ps1 -TenantId <your tenant ID or domain>" />
        <ProviderForm providerKey="staff-microsoft" summary={view(byKey["staff-microsoft"])} action={saveSetupProviderAction.bind(null, "staff-microsoft")} />
      </section>
      <section className="box" aria-labelledby="g-h"><h2 id="g-h">{PROVIDER_LABELS["staff-google"]}</h2>
        <GoogleStaffSteps appUrl={appUrl} />
        <ProviderForm providerKey="staff-google" summary={view(byKey["staff-google"])} action={saveSetupProviderAction.bind(null, "staff-google")} />
      </section>
      <form action={goToStepAction.bind(null, "parent")}><button className="btn" disabled={!ready}>Next: parent sign-in</button></form>
    </>
  );
}

export function ParentStep({ appUrl, byKey, tested }: { appUrl: string; byKey: ByKey; tested?: string }) {
  const saved = Boolean(byKey["parent-oidc"]?.readable);
  return (
    <>
      <h2 className="page-title">Step 2: Parent sign-in</h2>
      <p className="lede">Parents sign in with a code sent to their email, through Microsoft Entra External ID. You can skip this and do it later under Settings.</p>
      <section className="box" aria-labelledby="p-h"><h2 id="p-h">{PROVIDER_LABELS["parent-oidc"]}</h2>
        <ParentSteps appUrl={appUrl} />
        <ScriptOption script="New-BoosterRocketParentApp.ps1" example="./New-BoosterRocketParentApp.ps1 -TenantId <subdomain>.onmicrosoft.com" />
        <ProviderForm providerKey="parent-oidc" summary={view(byKey["parent-oidc"])} action={saveSetupProviderAction.bind(null, "parent-oidc")} />
        {saved && <div className="box-foot"><SetupParentTest />
          {tested === "ok" && <p role="status">Microsoft sent you back, so parent sign-in works. (There are no families yet, so the portal itself would still refuse that sign-in.)</p>}
          {tested === "failed" && <p role="alert" className="errors">The parent sign-in didn&apos;t complete. Check the redirect URI and that the app is added to the user flow.</p>}
        </div>}
      </section>
      <div className="stack">
        <form action={goToStepAction.bind(null, "admin")}><button className="btn">{saved ? "Next: first Admin" : "Do this later"}</button></form>
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

const SIGNIN_FAILED = "The sign-in didn't complete. Check the staff sign-in values in Step 1, then try again.";

export function AdminStep({ adminEmail, byKey, error, signinFailed }: { adminEmail: string | null; byKey: ByKey; error?: string; signinFailed?: boolean }) {
  const message = signinFailed ? SIGNIN_FAILED : error ? ADMIN_ERRORS[error] : undefined;
  return (
    <>
      <h2 className="page-title">Step 3: First Admin</h2>
      <p className="lede">Enter the email of the person who will be Admin, then sign in as them. When that works, setup closes and you&apos;re taken to the staff home.</p>
      <section className="box" aria-labelledby="a-h"><h2 id="a-h">Admin</h2>
        <AdminEmailForm initial={adminEmail ?? ""} action={saveAdminEmailAction} />
        {adminEmail && <div className="stack">
          {byKey["staff-microsoft"]?.readable && <SetupStaffSignIn provider="microsoft" label="Sign in with Microsoft" />}
          {byKey["staff-google"]?.readable && <SetupStaffSignIn provider="google" label="Sign in with Google" />}
        </div>}
        {message && <><p role="alert" className="errors">{message}</p><SetupStaffSignOut /></>}
      </section>
      <form action={goToStepAction.bind(null, "parent")}><button className="btn btn-line">Back to parent sign-in</button></form>
    </>
  );
}
