import { requireStaffPage } from "@/lib/guards";
import { formsSummary } from "@/lib/forms/settings";
import { LocalTime } from "@/app/components/local-time";
import { StateWords } from "@/app/components/state-words";
import { BackToSettings } from "../back-to-settings";

export const metadata = { title: "Forms settings" };
export const dynamic = "force-dynamic";

/**
 * How the portal reaches the club's own Documenso, where forms are signed (v1 spec §9). Admin only: the API token can
 * read every signed form. The saved token and webhook secret are never sent to this page; it shows only whether each
 * is saved. It shows no family's data, so opening it is not audited. What is set is shown plainly here; the steps that
 * set it up or change it are on their own page (setup/page.tsx), the pattern the QuickBooks page set.
 */
export default async function FormsSettingsPage() {
  await requireStaffPage("Settings.Forms.ReadWrite");
  const summary = await formsSummary();
  const when = (iso: string | null) => (iso ? <LocalTime iso={iso} /> : "Not yet");
  const failing = Boolean(summary.status.lastApiFailureAt && (!summary.status.lastApiOkAt || summary.status.lastApiFailureAt > summary.status.lastApiOkAt));
  return (
    <main className="wrap single">
      <BackToSettings />
      <h1 className="page-title">Forms</h1>
      <p className="lede">Parents sign the club&apos;s forms inside the portal, in a Documenso the club runs itself. This page connects the two. Only Admins can change it, because the API token can read every signed form.</p>

      <section className="box" aria-labelledby="forms-conn-h"><h2 id="forms-conn-h">Connection</h2>
        {summary.origin === null ? <StateWords state="todo" words="Not set up yet" />
          : !summary.tokenReadable || failing || !summary.status.lastApiOkAt ? <StateWords state="todo" words={failing ? "The latest call to Documenso failed" : !summary.tokenReadable ? "The API token can't be read" : "Saved, but not checked yet"} />
          : <StateWords state="done" words="Connected" />}
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

      <section className="box" aria-labelledby="forms-change-h"><h2 id="forms-change-h">{summary.origin === null ? "Set up" : "Change"}</h2>
        <p>{summary.origin === null ? "Four steps: Documenso's address and an API token, a check, the webhook, and a template for each form." : "Open the steps to change the address or the API token, check the connection again, or make a new webhook secret."}</p>
        <p className="settings-open"><a className="btn" href="/staff/settings/forms/setup">{summary.origin === null ? "Set up" : "Change"}</a></p>
      </section>
    </main>
  );
}
