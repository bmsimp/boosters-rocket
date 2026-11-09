"use client";
import { useActionState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { LocalTime } from "@/app/components/local-time";
import { CalendarDate } from "@/app/components/calendar-date";
import { PROVIDER_FIELDS, usesCertificate, type ProviderKey, type SaveOutcome } from "@/lib/auth/provider-fields";
import { FIELD_LABELS, type SummaryView } from "./labels";
import { CertificatePanel } from "./certificate-panel";

export function ProviderForm({ providerKey, summary, action, settings = false }: {
  providerKey: ProviderKey; summary: SummaryView | null; action: (form: FormData) => Promise<SaveOutcome>; settings?: boolean;
}) {
  const [state, run, pending] = useActionState(
    async (_: SaveOutcome | null, f: FormData) => safely(() => action(f), { ok: false as const, errors: [ACTION_FAILED] }), null);
  const google = providerKey === "staff-google";
  const cert = usesCertificate(providerKey);
  const fileName = providerKey === "parent-oidc" ? "booster-rocket-parents.cer" : "booster-rocket-staff.cer";
  const switching = settings && Boolean(summary?.pendingCertificate && summary?.certificate);
  return (
    <form action={run} className="stack">
      {PROVIDER_FIELDS[providerKey].map((name) => (
        <label key={name} className="field">
          <span>{google && name === "clientId" ? "Client ID" : FIELD_LABELS[name]}</span>
          <input name={name} defaultValue={summary?.config[name] ?? ""} required autoComplete="off" spellCheck={false} />
        </label>
      ))}
      {cert ? <CertificatePanel fileName={fileName} summary={summary} settings={settings} /> : <>
        <label className="field">
          <span>Client secret{summary?.readable ? " (leave blank to keep the saved one)" : ""}</span>
          <input name="secret" type="password" autoComplete="new-password" required={!summary?.readable} />
        </label>
        {summary && (
          <p className="hint">
            {summary.readable
              ? <>Secret saved <LocalTime iso={summary.credentialUpdatedAt} />{summary.expiresAt && <>, expires <CalendarDate iso={summary.expiresAt} /></>}.</>
              : "The saved secret can't be read with this server's encryption key. Enter it again."}
          </p>
        )}
        <label className="field">
          <span>Secret expiry date (optional)</span>
          <input name="secretExpiresAt" type="date" />
        </label>
      </>}
      {state && !state.ok && <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {state?.ok && <p role="status">{cert ? "Checked and saved. Microsoft accepted the certificate." : "Checked and saved."}</p>}
      <button className="btn" disabled={pending}>{pending ? (google ? "Saving…" : "Checking with Microsoft…") : google ? "Save" : switching ? "Check and switch" : "Check and save"}</button>
    </form>
  );
}
