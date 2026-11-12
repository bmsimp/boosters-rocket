"use client";
import { useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { LocalTime } from "@/app/components/local-time";
import type { MailSummary } from "@/lib/mail/settings";

type SaveResult = { ok: true } | { ok: false; errors: string[] };
type TestResult = { ok: true } | { ok: false; error: string };

/** Settings for outgoing mail, with Send test email. Used on the setup page and under Settings, Mail. */
export function MailSettingsCard({ summary, save, test }: {
  summary: MailSummary; save: (f: FormData) => Promise<SaveResult>; test: (f: FormData) => Promise<TestResult>;
}) {
  const c = summary.config;
  const [method, setMethod] = useState<"graph" | "smtp">(c?.method ?? (summary.graphAvailable ? "graph" : "smtp"));
  const [saved, runSave, saving] = useActionState(async (_: SaveResult | null, f: FormData) => safely(() => save(f), { ok: false as const, errors: [ACTION_FAILED] }), null);
  const [tested, runTest, testing] = useActionState(async (_: TestResult | null, f: FormData) => safely(() => test(f), { ok: false as const, error: ACTION_FAILED }), null);
  const smtp = c?.method === "smtp" ? c : null;
  return (
    <div className="stack">
      <p className="hint">
        {summary.working && summary.status.verifiedAt ? <>Working. Last tested <LocalTime iso={summary.status.verifiedAt} />.</>
          : c ? "Saved, but not tested with these settings yet. Send a test email." : "Not set up yet."}
      </p>
      <form action={runSave} className="stack">
        <fieldset className="field"><legend>Send with</legend>
          {summary.graphAvailable && <label><input type="radio" name="method" value="graph" checked={method === "graph"} onChange={() => setMethod("graph")} /> Microsoft 365</label>}
          <label><input type="radio" name="method" value="smtp" checked={method === "smtp"} onChange={() => setMethod("smtp")} /> SMTP</label>
        </fieldset>
        {!summary.graphAvailable && <p className="hint">Sending through Microsoft 365 uses staff sign-in with Microsoft. Set that up first to use it.</p>}
        {method === "graph" ? (
          <label className="field"><span>Send as this mailbox</span>
            <input name="mailbox" type="email" required autoComplete="off" defaultValue={c?.method === "graph" ? c.mailbox : ""} placeholder="webmaster@yourclub.org" />
          </label>
        ) : (
          <>
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
        {saved && !saved.ok && <ul role="alert" className="errors">{saved.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
        {saved?.ok && <p role="status">Saved. Send a test email to check it.</p>}
        <button className="btn" disabled={saving}>{saving ? "Saving…" : "Save"}</button>
      </form>
      {c && (
        <form action={runTest} className="stack">
          <label className="field"><span>Send a test email to</span><input name="to" type="email" required autoComplete="email" /></label>
          {tested && !tested.ok && <p role="alert" className="errors">{tested.error}</p>}
          {tested?.ok && <p role="status">Test email sent. Check that it arrived, and look in the spam folder too.</p>}
          <button className="btn btn-line" disabled={testing}>{testing ? "Sending…" : "Send test email"}</button>
        </form>
      )}
    </div>
  );
}
