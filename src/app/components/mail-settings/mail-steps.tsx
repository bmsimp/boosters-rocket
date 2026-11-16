import { CopyField } from "@/app/components/sign-in-settings/copy-field";
import { loadProviders } from "@/lib/auth/providers";
import type { MailSummary } from "@/lib/mail/settings";

const ext = { target: "_blank", rel: "noreferrer" } as const;
const RBAC = "https://learn.microsoft.com/exchange/permissions-exo/application-rbac";

/** The same steps the staff script's -SetUpMail part does, by hand (spec §3). */
export function GraphMailSteps() {
  return (
    <ol className="steps-list">
      <li>Pick the mailbox the portal sends as, for example <code>webmaster@yourclub.org</code>. It must be a real mailbox in the club&apos;s Microsoft 365.</li>
      <li>In the Entra admin center, open <b>Enterprise applications</b> &gt; <b>Booster Rocket (staff)</b> and copy its <b>Application ID</b> and <b>Object ID</b> (not the ones on App registrations).</li>
      <li>On <b>App registrations</b> &gt; <b>Booster Rocket (staff)</b> &gt; <b>API permissions</b>, check there is no Microsoft Graph <b>Mail.Send</b> permission of type <b>Application</b>. If there is, remove it and revoke its admin consent: it would let the app send as anyone.</li>
      <li>In PowerShell, as an Exchange administrator, connect to Exchange Online:<CopyField label="Connect" value="Connect-ExchangeOnline" /></li>
      <li>Point Exchange at the app:<CopyField label="Service principal" value={'New-ServicePrincipal -AppId <Application ID> -ObjectId <Object ID> -DisplayName "Booster Rocket (staff)"'} /></li>
      <li>Make a scope that holds only the mailbox:<CopyField label="Scope" value={`New-ManagementScope -Name "Booster Rocket mail sender" -RecipientRestrictionFilter "PrimarySmtpAddress -eq '<mailbox>'"`} /></li>
      <li>Let the app send as that mailbox only:<CopyField label="Role assignment" value={'New-ManagementRoleAssignment -App <Object ID> -Role "Application Mail.Send" -CustomResourceScope "Booster Rocket mail sender"'} /></li>
      <li>Check it: <code>InScope</code> should say <code>True</code>.<CopyField label="Check" value="Test-ServicePrincipalAuthorization -Identity <Object ID> -Resource <mailbox>" /></li>
      <li>Microsoft can take from 30 minutes to 2 hours to apply the change. Then send a test email in the last step. (<a href={RBAC} {...ext}>Microsoft&apos;s guide to RBAC for Applications</a>.)</li>
    </ol>
  );
}

export function SmtpNotes() {
  return (
    <div className="stack">
      <p>Use the SMTP settings your mail provider gives for sending from an app: host, port, STARTTLS or TLS, a username and password (often an app password), and the From address.</p>
      <p>Mail only reaches inboxes reliably when the From address&apos;s domain has your provider&apos;s SPF and DKIM records. Follow your provider&apos;s instructions, for example Google Workspace&apos;s <a href="https://support.google.com/a/answer/33786" {...ext}>SPF</a> and <a href="https://support.google.com/a/answer/174124" {...ext}>DKIM</a> pages.</p>
    </div>
  );
}

const SCRIPT = "New-BoosterRocketStaffApp.ps1";

/**
 * What an Admin does so Microsoft 365 lets the portal send as one mailbox: numbered steps, in the open until
 * mail works, with the club's own tenant ID (and the saved mailbox, once there is one) already in the command.
 * Renders nothing when staff don't sign in with Microsoft, because that method isn't offered then.
 */
export async function MicrosoftMailSetup({ summary }: { summary: MailSummary }) {
  const tenant = (await loadProviders()).staffMicrosoft?.config.tenantId;
  if (!tenant) return null;
  const mailbox = summary.config?.method === "graph" ? summary.config.mailbox : null;
  const steps = (
    <>
      <p>Microsoft 365 won&apos;t send for the portal until an administrator allows it. Do these steps in order. You need a Windows PC with PowerShell 7 and an account that is an Exchange administrator for the club.</p>
      <ol className="steps-list">
        <li><b>Download the script.</b> If an older copy is in your Downloads folder, delete it first.
          <p><a className="btn btn-line" href={`/setup/scripts/${SCRIPT}`} download>Download {SCRIPT}</a></p></li>
        <li><b>Open PowerShell 7 in the folder it downloaded to and run these three commands,</b> one at a time. The first is only needed once on each PC.
          <CopyField label="1. Install what the script needs" value="Install-Module Microsoft.Graph.Authentication, ExchangeOnlineManagement -Scope CurrentUser" />
          <CopyField label="2. Let Windows run the downloaded file" value={"Unblock-File .\\" + SCRIPT} />
          <CopyField label="3. Run it" value={`./${SCRIPT} -TenantId ${tenant} -SetUpMail -Mailbox ${mailbox ?? "<mailbox>"}`} />
          {!mailbox && <p className="hint">Replace <code>&lt;mailbox&gt;</code> with the address the portal should send from, for example <code>webmaster@yourclub.org</code>. It must be a real mailbox in the club&apos;s Microsoft 365.</p>}</li>
        <li><b>Sign in when the Microsoft page opens</b> (it opens twice), as the Exchange administrator. The script is finished when it prints &quot;The app can now send as …, and only as …&quot;. If it stops with a message instead, do what the message says and run it again.</li>
        <li><b>Wait.</b> Microsoft takes from 30 minutes to 2 hours to apply the change. A test email sent sooner can fail with <code>ErrorAccessDenied</code>; that only means it is too soon.</li>
        <li><b>Come back to this page.</b> In the next step, under <b>Send with</b>, choose <b>Microsoft 365</b>, enter the same mailbox and select <b>Save</b>. Then select <b>Send test email</b> in the step after it. When the test email arrives, parents can sign in.</li>
      </ol>
      <details><summary>Do the script&apos;s part by hand instead</summary><GraphMailSteps /></details>
    </>
  );
  if (summary.working) return <details><summary>Microsoft 365: let the app send as one mailbox (already done; open to do it again)</summary>{steps}</details>;
  return <section className="stack" aria-labelledby="m365-mail-h"><h3 id="m365-mail-h">Microsoft 365: let the app send as one mailbox</h3>{steps}</section>;
}

/** What to have ready for SMTP; sits under the mail card. */
export function SmtpHelp() {
  return <details><summary>SMTP: before you start</summary><SmtpNotes /></details>;
}
