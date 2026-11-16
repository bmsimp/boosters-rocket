import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { formsSummary } from "@/lib/forms/settings";
import { LocalTime } from "@/app/components/local-time";
import { checkFormsConnectionAction, newWebhookSecretAction, saveFormsSettingsAction } from "./actions";
import { CheckConnection, ConnectionForm, WebhookSetup } from "./forms-settings";

export const metadata = { title: "Forms settings" };
export const dynamic = "force-dynamic";

/**
 * How the portal reaches the club's own Documenso, where forms are signed (v1 spec §9). Admin only: the API token can
 * read every signed form. The saved token and webhook secret are never sent to this page; it shows only whether each
 * is saved. It shows no family's data, so opening it is not audited.
 */
export default async function FormsSettingsPage() {
  await requireStaffPage("Settings.Forms.ReadWrite");
  const summary = await formsSummary();
  const when = (iso: string | null) => (iso ? <LocalTime iso={iso} /> : "Not yet");
  const failing = Boolean(summary.status.lastApiFailureAt && (!summary.status.lastApiOkAt || summary.status.lastApiFailureAt > summary.status.lastApiOkAt));
  return (
    <main className="wrap single">
      <h1 className="page-title">Forms</h1>
      <p className="lede">Parents sign the club&apos;s forms inside the portal, in a Documenso the club runs itself. This page connects the two. Only Admins can change it, because the API token can read every signed form.</p>

      <section className="box" aria-labelledby="forms-conn-h"><h2 id="forms-conn-h">Connection</h2>
        {summary.origin === null ? <p>Forms aren&apos;t set up yet. Until they are, parents read that forms aren&apos;t ready, and nothing else changes for them.</p> : (
          <dl className="details">
            <dt>Documenso</dt><dd><code>{summary.origin}</code></dd>
            <dt>API token</dt><dd>{summary.tokenReadable ? "Saved" : "Saved, but it can't be opened with this server's encryption key. Enter it again."}</dd>
            <dt>Last answered</dt><dd>{when(summary.status.lastApiOkAt)}{failing ? <> (the latest call failed, <LocalTime iso={summary.status.lastApiFailureAt!} />)</> : null}</dd>
            <dt>Webhook secret</dt><dd>{summary.webhookSecretSaved ? "Saved" : "Not made yet"}</dd>
            <dt>Last webhook</dt><dd>{when(summary.status.lastWebhookAt)}</dd>
          </dl>
        )}
      </section>

      <section className="box" aria-labelledby="forms-1-h"><h2 id="forms-1-h">1. Documenso&apos;s address and an API token</h2>
        <ol className="steps-list">
          <li>In Documenso, sign in with the account the club keeps for forms. Use an account that belongs to the club, not to one person: if the account that made the token is removed, the token stops working.</li>
          <li>Open the team&apos;s settings, then <b>API Tokens</b>. Create a token that doesn&apos;t expire, and copy it.</li>
          <li>Enter Documenso&apos;s address and paste the token here.</li>
        </ol>
        <p className="hint">The address must be exactly the one Documenso itself is set up with (its own <code>NEXT_PUBLIC_WEBAPP_URL</code>): the same name, https, and port. Under any other address a form opens and then can&apos;t be signed, with no message.</p>
        <ConnectionForm origin={summary.origin} tokenSaved={summary.tokenSaved} save={saveFormsSettingsAction} />
      </section>

      <section className="box" aria-labelledby="forms-2-h"><h2 id="forms-2-h">2. Check the connection</h2>
        <p>Asks Documenso whether it is healthy, then makes one call with the token.</p>
        <CheckConnection check={checkFormsConnectionAction} />
      </section>

      <section className="box" aria-labelledby="forms-3-h"><h2 id="forms-3-h">3. Tell Documenso where to send news</h2>
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
