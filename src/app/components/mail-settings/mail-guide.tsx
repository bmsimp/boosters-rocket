import type { MailSummary } from "@/lib/mail/settings";
import { StateWords } from "@/app/components/state-words";
import { MailSaveForm, MailTestForm } from "./mail-card";
import { MicrosoftMailSetup, SmtpHelp } from "./mail-steps";

type SaveResult = { ok: true } | { ok: false; errors: string[] };
type TestResult = { ok: true } | { ok: false; error: string };

/**
 * Outgoing mail as one guided task, the same on the setup page and under Settings: a list of the steps with what is done
 * in words, then each step in its own box, in order. Microsoft 365's step is there only when staff sign in with
 * Microsoft, since the portal sends as a mailbox through that app; it can't be checked by itself, so it counts as done
 * when a test email sent through Microsoft 365 has gone through.
 */
export async function MailGuide({ summary, save, test }: { summary: MailSummary; save: (f: FormData) => Promise<SaveResult>; test: (f: FormData) => Promise<TestResult> }) {
  const c = summary.config;
  const m365 = summary.graphAvailable;
  const steps = [
    ...(m365 ? [{ id: "mail-m365-h", name: "Let Microsoft 365 send for the portal", done: c?.method === "smtp" || (summary.working && c?.method === "graph"),
      words: c?.method === "smtp" ? "Not needed: the portal sends by SMTP" : summary.working ? "Done" : "Done once a test email goes through" }] : []),
    { id: "mail-save-h", name: "Choose how the portal sends", done: c !== null, words: c ? "Saved" : "Not saved yet" },
    { id: "mail-test-h", name: "Send a test email", done: summary.working, words: summary.working ? "Done: mail works" : c ? "Not tested with these settings yet" : "Save the settings first" },
  ];
  const n = (id: string) => steps.findIndex((s) => s.id === id) + 1;
  return (
    <>
      <ol className="mail-steps">
        {steps.map((s) => <li key={s.id}><a href={`#${s.id}`}>{s.name}</a> <StateWords state={s.done ? "done" : "todo"} words={s.words} /></li>)}
      </ol>
      {m365 && (
        <section className="box" aria-labelledby="mail-m365-h"><h2 id="mail-m365-h">Step 1: Let Microsoft 365 send for the portal</h2>
          <p className="hint">Only if the portal sends with Microsoft 365. To send by SMTP instead, skip to step 2.</p>
          <MicrosoftMailSetup summary={summary} />
        </section>
      )}
      <section className="box" aria-labelledby="mail-save-h"><h2 id="mail-save-h">Step {n("mail-save-h")}: Choose how the portal sends</h2>
        <MailSaveForm summary={summary} save={save} />
        <SmtpHelp />
      </section>
      <section className="box" aria-labelledby="mail-test-h"><h2 id="mail-test-h">Step {n("mail-test-h")}: Send a test email</h2>
        <MailTestForm summary={summary} test={test} />
      </section>
    </>
  );
}
