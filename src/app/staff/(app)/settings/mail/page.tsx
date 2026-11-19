import { requireStaffPage } from "@/lib/guards";
import { mailAttention, mailSummary } from "@/lib/mail/settings";
import { StateWords } from "@/app/components/state-words";
import { LocalTime } from "@/app/components/local-time";
import { BackToSettings } from "../back-to-settings";

export const metadata = { title: "Mail settings" };
export const dynamic = "force-dynamic";

/** What is set, shown plainly, with no inputs (the pattern the QuickBooks page set). The steps are on their own page. */
export default async function MailSettingsPage() {
  await requireStaffPage("Settings.Mail.ReadWrite");
  const [summary, attention] = await Promise.all([mailSummary(), mailAttention()]);
  const c = summary.config;
  const words = !attention ? "Working: parents can be sent sign-in codes and password links"
    : attention.kind === "failing" ? `The last email failed: ${attention.lastError ?? "no reason was given"} Parents can't be sent sign-in codes, password links or welcome emails until a send works again.`
    : attention.kind === "not_tested" ? "Saved, but not tested since it changed, so parents can't sign in. Send a test email."
    : "Not set up yet, so parents can't sign in";
  return (
    <main className="wrap single">
      <BackToSettings />
      <h1 className="page-title">Outgoing mail</h1>
      <p className="lede">How the portal sends sign-in codes, password links and welcome emails. Only Admins can change this, because whoever controls outgoing mail can read parents&apos; sign-in codes and the links that set their passwords.</p>
      <section className="box" aria-labelledby="mail-h"><h2 id="mail-h">What is set</h2>
        <StateWords state={attention ? "todo" : "done"} words={words} />
        <dl className="details">
          <dt>Sends with</dt><dd>{!c ? "Nothing yet" : c.method === "graph" ? "Microsoft 365" : "SMTP"}</dd>
          {c?.method === "graph" && <><dt>Mailbox</dt><dd>{c.mailbox}</dd></>}
          {c?.method === "smtp" && <><dt>Server</dt><dd>{c.host}, port <span className="num">{c.port}</span>, {c.security === "tls" ? "TLS" : "STARTTLS"}</dd>
            <dt>From</dt><dd>{c.from}</dd>
            <dt>Password</dt><dd>{summary.passwordReadable ? "Saved" : "Saved, but this server can't read it. Enter it again."}</dd></>}
          <dt>Last tested</dt><dd>{summary.status.verifiedAt ? <LocalTime iso={summary.status.verifiedAt} /> : "Not yet"}</dd>
          {summary.status.lastSuccessAt && <><dt>Last sent</dt><dd><LocalTime iso={summary.status.lastSuccessAt} /></dd></>}
        </dl>
        <p className="settings-open"><a className="btn" href="/staff/settings/mail/setup">{c ? (attention ? "Open the steps" : "Change") : "Set up"}</a></p>
      </section>
    </main>
  );
}
