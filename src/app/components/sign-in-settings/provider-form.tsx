"use client";
import { useActionState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { LocalTime } from "@/app/components/local-time";
import { PROVIDER_FIELDS, type ProviderKey, type SaveOutcome } from "@/lib/auth/provider-fields";
import { FIELD_LABELS, type SummaryView } from "./labels";

export function ProviderForm({ providerKey, summary, action }: {
  providerKey: ProviderKey; summary: SummaryView | null; action: (form: FormData) => Promise<SaveOutcome>;
}) {
  const [state, run, pending] = useActionState(
    async (_: SaveOutcome | null, f: FormData) => safely(() => action(f), { ok: false as const, errors: [ACTION_FAILED] }), null);
  const google = providerKey === "staff-google";
  return (
    <form action={run} className="stack">
      {PROVIDER_FIELDS[providerKey].map((name) => (
        <label key={name} className="field">
          <span>{google && name === "clientId" ? "Client ID" : FIELD_LABELS[name]}</span>
          <input name={name} defaultValue={summary?.config[name] ?? ""} required autoComplete="off" spellCheck={false} />
        </label>
      ))}
      <label className="field">
        <span>Client secret{summary?.readable ? " (leave blank to keep the saved one)" : ""}</span>
        <input name="secret" type="password" autoComplete="new-password" required={!summary?.readable} />
      </label>
      {summary && (
        <p className="hint">
          {summary.readable
            ? <>Secret saved <LocalTime iso={summary.secretUpdatedAt} />{summary.secretExpiresAt && <>, expires <LocalTime iso={summary.secretExpiresAt} /></>}.</>
            : "The saved secret can't be read with this server's encryption key. Enter it again."}
        </p>
      )}
      <label className="field">
        <span>Secret expiry date (optional)</span>
        <input name="secretExpiresAt" type="date" />
      </label>
      {state && !state.ok && <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {state?.ok && <p role="status">Checked and saved.</p>}
      <button className="btn" disabled={pending}>{pending ? (google ? "Saving…" : "Checking with Microsoft…") : google ? "Save" : "Check and save"}</button>
    </form>
  );
}
