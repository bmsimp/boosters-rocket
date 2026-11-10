import { CopyField } from "@/app/components/sign-in-settings/copy-field";
import { ScriptOption } from "@/app/setup/instructions";

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
      <li>Microsoft can take from 30 minutes to 2 hours to apply the change. Then send a test email above. (<a href={RBAC} {...ext}>Microsoft&apos;s guide to RBAC for Applications</a>.)</li>
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

/** The two help blocks under the mail card. `tenant` is the placeholder shown in the script's example command. */
export function MailHelp({ tenant }: { tenant: string }) {
  return (
    <>
      <details><summary>Microsoft 365: let the app send as one mailbox</summary>
        <ScriptOption script="New-BoosterRocketStaffApp.ps1" example={`./New-BoosterRocketStaffApp.ps1 -TenantId ${tenant} -SetUpMail -Mailbox webmaster@yourclub.org`} />
        <GraphMailSteps />
      </details>
      <details><summary>SMTP: before you start</summary><SmtpNotes /></details>
    </>
  );
}
