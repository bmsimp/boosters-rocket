"use client";
import { ActionOutcome, Notice } from "@/app/components/notice";
import { useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { LocalTime } from "@/app/components/local-time";
import type { MailSummary } from "@/lib/mail/settings";

type SaveResult = { ok: true } | { ok: false; errors: string[] };
type TestResult = { ok: true } | { ok: false; error: string };

/**
 * How the portal sends: Microsoft 365 as one mailbox, or SMTP. One of the mail steps (mail-guide.tsx), on the setup
 * page and under Settings alike; `testStep` is the number the next step has there, which depends on whether Microsoft
 * 365's step is shown. The saved password is never sent here; a blank field keeps it. With only SMTP to choose, there
 * is no choice to draw.
 */
export function MailSaveForm({ summary, save, testStep }: { summary: MailSummary; save: (f: FormData) => Promise<SaveResult>; testStep: number }) {
  const c = summary.config;
  const [method, setMethod] = useState<"graph" | "smtp">(c?.method ?? (summary.graphAvailable ? "graph" : "smtp"));
  const [saved, runSave, saving] = useActionState(async (_: SaveResult | null, f: FormData) => safely(() => save(f), { ok: false as const, errors: [ACTION_FAILED] }), null);
  const smtp = c?.method === "smtp" ? c : null;
  return (
    <form action={runSave} className="stack">
      {summary.graphAvailable ? (
        <fieldset className="checks"><legend>Send with</legend>
          <label><input type="radio" name="method" value="graph" checked={method === "graph"} onChange={() => setMethod("graph")} /> Microsoft 365</label>
          <label><input type="radio" name="method" value="smtp" checked={method === "smtp"} onChange={() => setMethod("smtp")} /> SMTP</label>
        </fieldset>
      ) : (
        <>
          <input type="hidden" name="method" value="smtp" />
          <p className="hint">The portal sends by SMTP. Sending through Microsoft 365 instead uses staff sign-in with Microsoft: set that up first to use it.</p>
        </>
      )}
      {method === "graph" ? (
        <label className="field"><span>Send as this mailbox</span>
          <input name="mailbox" type="email" required autoComplete="off" defaultValue={c?.method === "graph" ? c.mailbox : ""} placeholder="webmaster@yourclub.org" />
        </label>
      ) : (
        <>
          <p className="hint">Use the settings your mail provider gives for sending from an app, often with an app password. Mail reaches inboxes reliably only when the From address&apos;s domain has your provider&apos;s SPF and DKIM records.</p>
          <label className="field"><span>Host</span><input name="host" required autoComplete="off" spellCheck={false} defaultValue={smtp?.host ?? ""} placeholder="smtp.example.org" /></label>
          <label className="field"><span>Port</span><input name="port" inputMode="numeric" required defaultValue={smtp?.port ?? 587} /></label>
          <label className="field"><span>Security</span>
            <select name="security" defaultValue={smtp?.security ?? "starttls"}>
              <option value="starttls">STARTTLS (usually port 587)</option>
              <option value="tls">TLS (usually port 465)</option>
            </select>
          </label>
          <label className="field"><span>Username</span><input name="username" required autoComplete="off" spellCheck={false} defaultValue={smtp?.username ?? ""} /></label>
          <label className="field"><span>Password{summary.passwordSaved && summary.passwordReadable ? " (leave blank to keep the saved one; enter it again if you change the host, port or username)" : ""}</span>
            <input name="password" type="password" autoComplete="new-password" required={!(summary.passwordSaved && summary.passwordReadable)} />
          </label>
          {summary.passwordSaved && !summary.passwordReadable && <p className="hint">The saved password can&apos;t be read with this server&apos;s encryption key. Enter it again.</p>}
          <label className="field"><span>From address</span><input name="from" type="email" required autoComplete="off" defaultValue={smtp?.from ?? ""} placeholder="boosters@yourclub.org" /></label>
        </>
      )}
      {saved && !saved.ok && <ActionOutcome state={saved} />}
      {saved?.ok && <Notice tone="done">Saved. Send a test email next, in step {testStep}.</Notice>}
      <button className="btn" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
    </form>
  );
}

/** Send test email, the last of the mail steps; `saveStep` is the number of the step before it. Mail works once a test sent with the saved settings goes through. */
export function MailTestForm({ summary, test, saveStep }: { summary: MailSummary; test: (f: FormData) => Promise<TestResult>; saveStep: number }) {
  const [tested, runTest, testing] = useActionState(async (_: TestResult | null, f: FormData) => safely(() => test(f), { ok: false as const, error: ACTION_FAILED }), null);
  if (!summary.config) return <p className="hint">Save the settings in step {saveStep} first.</p>;
  return (
    <form action={runTest} className="stack">
      <p className="hint">{summary.working && summary.status.verifiedAt ? <>Working. Last tested <LocalTime iso={summary.status.verifiedAt} />.</> : "Saved, but not tested with these settings yet."}</p>
      <label className="field"><span>Send a test email to</span><input name="to" type="email" required autoComplete="email" /></label>
      {tested && !tested.ok && <Notice tone="problem">{tested.error}</Notice>}
      {tested?.ok && <Notice tone="done">Test email sent. Check that it arrived, and look in the spam folder too.</Notice>}
      <button className="btn btn-line" disabled={testing}>{testing ? "Sending…" : "Send test email"}</button>
    </form>
  );
}
