import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { mailAttention, mailSummary } from "@/lib/mail/settings";
import { Card, KeyValue, LinkButton, LocalTime, StateWords } from "@/app/components/ui";
import { IntegrationHead, IntegrationHealth } from "../integration-head";
import { healthLines, mailRows, systemStatus } from "../statuses";

export const metadata = { title: "Mail settings" };
export const dynamic = "force-dynamic";

/**
 * Outgoing mail, an integration's page (the Settings spec): its head with the status, what is set, its Health line, and
 * the change. What is set is shown plainly, with no inputs; the steps are on their own page. Mail has no disconnect,
 * and this page adds none.
 */
export default async function MailSettingsPage() {
  const ctx = await requireStaffPage("Settings.Mail.ReadWrite");
  const [summary, attention, rows, lines] = await Promise.all([mailSummary(), mailAttention(), mailRows(), can(ctx.effective, "Admin.Health.Read") ? healthLines() : []]);
  const c = summary.config;
  const words = !attention ? "Working: parents can be sent sign-in codes and password links"
    : attention.kind === "failing" ? `The last email failed: ${attention.lastError ?? "no reason was given"} Parents can't be sent sign-in codes, password links or welcome emails until a send works again.`
    : attention.kind === "not_tested" ? "Saved, but not tested since it changed, so parents can't sign in. Send a test email."
    : "Not set up yet, so parents can't sign in";
  const status = systemStatus(rows);
  return (
    <main className="wrap single">
      <IntegrationHead of={c?.method === "smtp" ? "mail-smtp" : "mail-graph"} title="Outgoing mail"
        status={!c ? status : rows.find((r) => r.key === (c.method === "smtp" ? "mail-smtp" : "mail-graph"))!.status}
        lede={<>How the portal sends sign-in codes, password links and welcome emails. Only Admins can change this, because whoever controls outgoing mail can read parents&apos; sign-in codes and the links that set their passwords.</>} />
      {c && (
      <Card title="What is set" titleId="mail-h">
        {/* The head's badge says whether it works; a problem's reason is said here. */}
        {attention && <StateWords state="todo" words={words} />}
        <KeyValue items={[
          { key: "with", label: "Sends with", value: !c ? "Nothing yet" : c.method === "graph" ? "Microsoft 365" : "SMTP" },
          c?.method === "graph" && { key: "mailbox", label: "Mailbox", value: c.mailbox },
          c?.method === "smtp" && { key: "server", label: "Server", value: <>{c.host}, port <span className="num">{c.port}</span>, {c.security === "tls" ? "TLS" : "STARTTLS"}</> },
          c?.method === "smtp" && { key: "from", label: "From", value: c.from },
          c?.method === "smtp" && { key: "password", label: "Password", value: summary.passwordReadable ? "Saved" : "Saved, but this server can't read it. Enter it again." },
          { key: "tested", label: "Last tested", value: summary.status.verifiedAt ? <LocalTime iso={summary.status.verifiedAt} /> : "Not yet" },
          summary.status.lastSuccessAt ? { key: "sent", label: "Last sent", value: <LocalTime iso={summary.status.lastSuccessAt} /> } : null,
        ]} />
      </Card>
      )}

      <IntegrationHealth here="/staff/settings/mail" line={lines.find((l) => l.key === "mail")} />

      <Card title={c ? "Change" : "Set up"} titleId="mail-change-h">
        <p>{c ? "Open the steps to change how mail is sent, or send a test email." : "Until mail is set up, parents can't sign in. Choose how the portal sends mail, then send a test email."}</p>
        <p className="settings-open"><LinkButton href="/staff/settings/mail/setup" variant="filled">{c ? (attention ? "Open the steps" : "Change") : "Set up"}</LinkButton></p>
      </Card>
    </main>
  );
}
