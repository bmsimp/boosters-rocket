"use client";
import { ActionOutcome, Notice } from "@/app/components/notice";
import { useActionState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { LocalTime } from "@/app/components/local-time";
import { CalendarDate } from "@/app/components/calendar-date";
import { PROVIDER_FIELDS, usesCertificate, type ProviderKey, type SaveOutcome } from "@/lib/auth/provider-fields";
import { FIELD_LABELS, type SummaryView } from "./labels";
import { CertificatePanel, type CertificateActions } from "./certificate-panel";

const REPLACED = "You can now remove the old certificate from the app registration in Entra (Certificates & secrets > Certificates).";

export function ProviderForm({ providerKey, summary, action, certificateActions }: {
  providerKey: ProviderKey; summary: SummaryView | null; action: (form: FormData) => Promise<SaveOutcome>; certificateActions?: CertificateActions;
}) {
  const [state, run, pending] = useActionState(
    async (_: SaveOutcome | null, f: FormData) => safely(() => action(f), { ok: false as const, errors: [ACTION_FAILED] }), null);
  const google = providerKey === "staff-google";
  const cert = usesCertificate(providerKey);
  const fileName = "booster-rocket-staff.cer";
  const switching = Boolean(summary?.pendingCertificate && summary?.certificate);
  return (
    <div className="stack">
      {cert && <CertificatePanel fileName={fileName} summary={summary} actions={certificateActions} />}
      <form action={run} className="stack">
        {PROVIDER_FIELDS[providerKey].map((name) => (
          <label key={name} className="field">
            <span>{google && name === "clientId" ? "Client ID" : FIELD_LABELS[name]}</span>
            <input name={name} defaultValue={summary?.config[name] ?? ""} required autoComplete="off" spellCheck={false} />
          </label>
        ))}
        {!cert && <>
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
        {state && !state.ok && <ActionOutcome state={state} />}
        {state?.ok && <Notice tone="done">{cert ? "Checked and saved. Microsoft accepted the certificate." : "Checked and saved."}{state.replaced && ` ${REPLACED}`}</Notice>}
        <button className="btn" disabled={pending}>{pending ? (google ? "Saving…" : "Checking with Microsoft…") : google ? "Save" : switching ? "Check and switch" : "Check and save"}</button>
      </form>
    </div>
  );
}
