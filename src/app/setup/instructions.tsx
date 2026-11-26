import { CopyField } from "@/app/components/sign-in-settings/copy-field";
import { StepsChoice } from "@/app/components/ui";

const ENTRA_APPS = "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade";
const ext = { target: "_blank", rel: "noreferrer" } as const;

export function MicrosoftStaffSteps({ appUrl }: { appUrl: string }) {
  return (
    <ol className="steps-list">
      <li>Open <a href={ENTRA_APPS} {...ext}>App registrations in the Microsoft Entra admin center</a>, signed in as an admin of the club&apos;s Microsoft tenant. Select <b>New registration</b>.</li>
      <li><CopyField label="Name" value="Booster Rocket (staff)" /></li>
      <li>Under <b>Supported account types</b>, choose <b>Accounts in this organizational directory only (Single tenant)</b>.</li>
      <li>Under <b>Redirect URI</b>, choose <b>Web</b> and enter:<CopyField label="Redirect URI" value={`${appUrl}/api/auth/staff/callback/microsoft`} /> Then select <b>Register</b>.</li>
      <li>On the app&apos;s <b>Overview</b>, copy the <b>Application (client) ID</b> and <b>Directory (tenant) ID</b> into the form below.</li>
      <li>Open <b>API permissions</b> &gt; <b>Add a permission</b> &gt; <b>Microsoft Graph</b> &gt; <b>Delegated permissions</b>, tick <b>openid</b>, <b>profile</b>, <b>email</b> and <b>offline_access</b>, and select <b>Add permissions</b>. Then select <b>Grant admin consent</b> and <b>Yes</b>.</li>
      <li>Open <b>Certificates &amp; secrets</b> &gt; <b>Certificates</b> &gt; <b>Upload certificate</b>, choose the <code>booster-rocket-staff.cer</code> file you downloaded below (Download certificate), and select <b>Add</b>. Boosters Rocket made this certificate; its private key never leaves your server.</li>
    </ol>
  );
}

export function GoogleStaffSteps({ appUrl }: { appUrl: string }) {
  return (
    <ol className="steps-list">
      <li>Open <a href="https://console.cloud.google.com/apis/credentials" {...ext}>Credentials in the Google Cloud console</a> for the club&apos;s Google account, and create or pick a project.</li>
      <li>If asked, set up the <b>OAuth consent screen</b> first: app name <b>Boosters Rocket</b>, and the club&apos;s support email.</li>
      <li>Select <b>Create credentials</b> &gt; <b>OAuth client ID</b> &gt; <b>Web application</b>. Under <b>Authorized redirect URIs</b>, add:<CopyField label="Redirect URI" value={`${appUrl}/api/auth/staff/callback/google`} /> Then select <b>Create</b>.</li>
      <li>Copy the <b>Client ID</b> and <b>Client secret</b> into the form below.</li>
    </ol>
  );
}

/**
 * Microsoft staff sign-in's app, made one of two ways, chosen in the open: by hand (MicrosoftStaffSteps) or with the
 * PowerShell script, which does the same steps and prints the values for the form.
 */
export function MicrosoftAppSteps({ appUrl, script, example }: { appUrl: string; script: string; example: string }) {
  return (
    <StepsChoice name="ms-app-way" legend="How to make the app" options={[
      { value: "hand", label: "By hand", hint: "In the Microsoft Entra admin center.", steps: <MicrosoftStaffSteps appUrl={appUrl} /> },
      { value: "script", label: "With the PowerShell script", hint: "It does the steps for you and prints the values to enter below.", steps: (
        <div className="stack">
          <p>It needs PowerShell 7 and the Microsoft Graph module (<code>Install-Module Microsoft.Graph.Authentication</code>); with <code>-SetUpMail</code>, the Exchange Online module too (<code>Install-Module ExchangeOnlineManagement</code>).</p>
          <p><a className="btn btn-line" href={`/setup/scripts/${script}`} download>Download {script}</a></p>
          <CopyField label="On Windows, unblock it first" value={`Unblock-File .\\${script}`} />
          <CopyField label="Then run" value={example} />
        </div>
      ) },
    ]} />
  );
}
