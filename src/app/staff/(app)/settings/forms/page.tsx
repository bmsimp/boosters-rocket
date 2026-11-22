import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { apiFailing, formsSummary } from "@/lib/forms/settings";
import { Card, KeyValue, LinkButton, LocalTime } from "@/app/components/ui";
import { IntegrationHead, IntegrationHealth } from "../integration-head";
import { documensoRow, healthLines } from "../statuses";

export const metadata = { title: "Forms settings" };
export const dynamic = "force-dynamic";

/**
 * How the portal reaches the club's own Documenso, where forms are signed (v1 spec §9), an integration's page (the
 * Settings spec): its head with the status, what is set, its Health line, and the change. Admin only: the API token
 * can read every signed form. The saved token and webhook secret are never sent to this page; it shows only whether
 * each is saved. It shows no family's data, so opening it is not audited. The steps are on their own page
 * (setup/page.tsx). Documenso has no disconnect, and this page adds none.
 */
export default async function FormsSettingsPage() {
  const ctx = await requireStaffPage("Settings.Forms.ReadWrite");
  const [summary, row, lines] = await Promise.all([formsSummary(), documensoRow(), can(ctx.effective, "Admin.Health.Read") ? healthLines() : []]);
  const when = (iso: string | null) => (iso ? <LocalTime iso={iso} /> : "Not yet");
  const failing = apiFailing(summary.status);
  return (
    <main className="wrap single">
      <IntegrationHead of="documenso" title="Documenso" status={row.status}
        lede={<>Parents sign the club&apos;s forms inside the portal, in a Documenso the club runs itself. This page connects the two. Only Admins can change it, because the API token can read every signed form.</>} />

      {summary.origin !== null && (
      <Card title="Connection" titleId="forms-conn-h">
        {(
          <KeyValue items={[
            { key: "origin", label: "Documenso", value: <code>{summary.origin}</code> },
            { key: "token", label: "API token", value: summary.tokenReadable ? "Saved" : "Saved, but it can't be opened with this server's encryption key. Enter it again." },
            { key: "answered", label: "Last answered", value: <>{when(summary.status.lastApiOkAt)}{failing ? <> (the latest call failed, <LocalTime iso={summary.status.lastApiFailureAt!} />)</> : null}</> },
            { key: "secret", label: "Webhook secret", value: summary.webhookSecretSaved ? "Saved" : "Not made yet" },
            { key: "webhook", label: "Last webhook", value: when(summary.status.lastWebhookAt) },
          ]} />
        )}
      </Card>
      )}

      <IntegrationHealth here="/staff/settings/forms" line={lines.find((l) => l.key === "forms")} />

      <Card title={summary.origin === null ? "Set up" : "Change"} titleId="forms-change-h">
        <p>{summary.origin === null ? "Until forms are set up, parents read that forms aren't ready, and nothing else changes for them. Four steps: Documenso's address and an API token, a check, the webhook, and a template for each form." : "Open the steps to change the address or the API token, check the connection again, or make a new webhook secret."}</p>
        <p className="settings-open"><LinkButton href="/staff/settings/forms/setup" variant="primary">{summary.origin === null ? "Set up" : "Change"}</LinkButton></p>
      </Card>
    </main>
  );
}
