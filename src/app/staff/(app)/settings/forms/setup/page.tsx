import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { formsSummary } from "@/lib/forms/settings";
import { checkFormsConnectionAction, newWebhookSecretAction, saveFormsSettingsAction } from "../actions";
import { CheckConnection, ConnectionForm, WebhookSetup } from "../forms-settings";
import { StateWords } from "@/app/components/state-words";

export const metadata = { title: "Set up forms" };
export const dynamic = "force-dynamic";

/** The four steps that connect the club's Documenso (v1 spec §9). The saved token and webhook secret are never sent here. */
export default async function FormsSetupPage() {
  await requireStaffPage("Settings.Forms.ReadWrite");
  const summary = await formsSummary();
  const failing = Boolean(summary.status.lastApiFailureAt && (!summary.status.lastApiOkAt || summary.status.lastApiFailureAt > summary.status.lastApiOkAt));
  const saved = summary.origin !== null && summary.tokenReadable;
  return (
    <main className="wrap single">
      <p className="back-to-settings"><a href="/staff/settings/forms">Back to forms settings</a></p>
      <h1 className="page-title">Set up forms</h1>
      <p className="lede">Four steps, in order. The first three say whether they are done.</p>

      <section className="box" aria-labelledby="forms-1-h"><h2 id="forms-1-h">1. Documenso&apos;s address and an API token</h2>
        <StateWords state={saved ? "done" : "todo"} words={saved ? "Saved" : summary.origin === null ? "Not saved yet" : "Enter the API token again"} />
        <ol className="steps-list">
          <li>In Documenso, sign in with the account the club keeps for forms. Use an account that belongs to the club, not to one person: if the account that made the token is removed, the token stops working.</li>
          <li>Open the team&apos;s settings, then <b>API Tokens</b>. Create a token that doesn&apos;t expire, and copy it.</li>
          <li>Enter Documenso&apos;s address and paste the token here.</li>
        </ol>
        <p className="hint">The address must be exactly the one Documenso itself is set up with (its own <code>NEXT_PUBLIC_WEBAPP_URL</code>): the same name, https, and port. Under any other address a form opens and then can&apos;t be signed, with no message.</p>
        <ConnectionForm origin={summary.origin} tokenSaved={summary.tokenSaved} save={saveFormsSettingsAction} />
      </section>

      <section className="box" aria-labelledby="forms-2-h"><h2 id="forms-2-h">2. Check the connection</h2>
        <StateWords state={summary.status.lastApiOkAt && !failing ? "done" : "todo"} words={failing ? "The latest call failed" : summary.status.lastApiOkAt ? "Documenso answered" : "Not checked yet"} />
        <p>Asks Documenso whether it is healthy, then makes one call with the token.</p>
        <CheckConnection check={checkFormsConnectionAction} />
      </section>

      <section className="box" aria-labelledby="forms-3-h"><h2 id="forms-3-h">3. Tell Documenso where to send news</h2>
        <StateWords state={summary.webhookSecretSaved ? "done" : "todo"} words={summary.status.lastWebhookAt ? "Done: a webhook has arrived" : summary.webhookSecretSaved ? "Secret made. Done once it is in Documenso" : "Not done yet"} />
        <ol className="steps-list">
          <li>Make the secret below and copy it. It is shown once.</li>
          <li>In Documenso, open the team&apos;s settings, then <b>Webhooks</b>, and add a webhook.</li>
          <li>Paste the webhook URL and the secret, and tick every document event (signed, completed, rejected, cancelled and the rest).</li>
        </ol>
        <p className="hint">A webhook only tells the portal to look: the portal always reads the form from Documenso itself before it records anything. It also asks Documenso every few minutes about each form that is out, so a webhook that never arrives delays nothing for long.</p>
        <WebhookSetup address={summary.webhookAddress} secretSaved={summary.webhookSecretSaved} make={newWebhookSecretAction} />
      </section>

      <section className="box" aria-labelledby="forms-4-h"><h2 id="forms-4-h">4. Attach a template to a form</h2>
        <p>Make each form as a template in Documenso. Then, under <Link href="/staff/seasons">Seasons</Link>, add a requirement of the kind Form and attach the template on its page. The portal checks the template and says what to change if it can&apos;t be used.</p>
        <p className="hint">Documenso&apos;s own emails about a form are switched off by the portal for every form it makes. Documenso still emails staff about their own accounts.</p>
      </section>
    </main>
  );
}
