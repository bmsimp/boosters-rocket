import { CopyField } from "@/app/components/sign-in-settings/copy-field";

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
      <li>Open <b>Certificates &amp; secrets</b> &gt; <b>Certificates</b> &gt; <b>Upload certificate</b>, choose the <code>booster-rocket-staff.cer</code> file you downloaded below (Download certificate), and select <b>Add</b>. Booster Rocket made this certificate; its private key never leaves your server.</li>
    </ol>
  );
}

export function GoogleStaffSteps({ appUrl }: { appUrl: string }) {
  return (
    <ol className="steps-list">
      <li>Open <a href="https://console.cloud.google.com/apis/credentials" {...ext}>Credentials in the Google Cloud console</a> for the club&apos;s Google account, and create or pick a project.</li>
      <li>If asked, set up the <b>OAuth consent screen</b> first: app name <b>Booster Rocket</b>, and the club&apos;s support email.</li>
      <li>Select <b>Create credentials</b> &gt; <b>OAuth client ID</b> &gt; <b>Web application</b>. Under <b>Authorized redirect URIs</b>, add:<CopyField label="Redirect URI" value={`${appUrl}/api/auth/staff/callback/google`} /> Then select <b>Create</b>.</li>
      <li>Copy the <b>Client ID</b> and <b>Client secret</b> into the form below.</li>
    </ol>
  );
}

export function ScriptOption({ script, example }: { script: string; example: string }) {
  return (
    <details className="box">
      <summary>Use the PowerShell script instead</summary>
      <p>The script signs you in with the normal Microsoft sign-in page in your browser, does the steps for you, adds Booster Rocket&apos;s certificate to the app, and prints the values to enter below. It needs PowerShell 7 and the Microsoft Graph module (<code>Install-Module Microsoft.Graph.Authentication</code>).</p>
      <p><a className="btn btn-line" href={`/setup/scripts/${script}`} download>Download {script}</a></p>
      <p>On Windows, unblock the downloaded file first:</p>
      <CopyField label="Unblock" value={`Unblock-File .\\${script}`} />
      <CopyField label="Then run" value={example} />
    </details>
  );
}
