"use client";
import { ActionOutcome } from "@/app/components/notice";
import { startTransition, useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { CopyField } from "@/app/components/sign-in-settings/copy-field";

// The forms of the Forms settings page. No form `action` on a form with a field: React resets a form after one, and
// what was typed would vanish on a refusal (see ../quickbooks/forms.tsx). Each is given only what it shows: the saved
// API token and webhook secret are never sent here.
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failed = { ok: false as const, errors: [ACTION_FAILED] };
const noSubmit = (e: { preventDefault: () => void }) => e.preventDefault();

function Outcome({ state }: { state: Done | null }) {
  if (!state) return null;
  return <ActionOutcome state={state} />;
}

/** Documenso's address and API token. A saved token is never sent here; a blank field keeps it. */
export function ConnectionForm({ origin: savedOrigin, tokenSaved, save }: { origin: string | null; tokenSaved: boolean; save: (origin: string, token: string) => Promise<Done> }) {
  const [origin, setOrigin] = useState(savedOrigin ?? "");
  const [token, setToken] = useState(""); // never initialized from props: there is no token to give it
  const [state, run, pending] = useActionState(async () => {
    const r = await safely(() => save(origin, token), failed);
    if (r.ok) setToken("");
    return r;
  }, null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>Documenso&apos;s address</span>
        <input name="origin" type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://sign.yourclub.org" value={origin} onChange={(e) => setOrigin(e.target.value)} /></label>
      <label className="field"><span>API token{tokenSaved ? " (leave blank to keep the saved one)" : ""}</span>
        <input name="token" type="password" autoComplete="new-password" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} /></label>
      <Outcome state={state} />
      <button type="button" className="btn" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Saving…" : "Save"}</button>
    </form>
  );
}

/** "Check the connection": Documenso's own health answer, then one call with the saved token. */
export function CheckConnection({ check }: { check: () => Promise<Done> }) {
  const [state, run, pending] = useActionState(async () => safely(() => check(), failed), null);
  return (
    <form action={run} className="one-button">
      <button className="btn btn-outlined" disabled={pending}>{pending ? "Checking…" : "Check the connection"}</button>
      <Outcome state={state} />
    </form>
  );
}

type Made = { ok: true; message: string; secret: string } | { ok: false; errors: string[] };
/** The webhook's address, and a button that makes a new secret and shows it once, both to copy into Documenso. */
export function WebhookSetup({ address, secretSaved, make }: { address: string; secretSaved: boolean; make: () => Promise<Made> }) {
  const [state, run, pending] = useActionState(async () => safely(() => make(), failed as Made), null);
  return (
    <div className="stack">
      <CopyField label="Webhook URL" value={address} />
      {state?.ok && <CopyField label="Secret (shown this once)" value={state.secret} />}
      <form action={run} className="one-button">
        <button className="btn btn-outlined" disabled={pending}>{pending ? "Making…" : secretSaved || state?.ok ? "Make a new secret" : "Make the secret"}</button>
        {state && (<ActionOutcome state={state} />)}
      </form>
      {secretSaved && !state?.ok && <p className="hint">A secret is saved. It can&apos;t be shown again: if Documenso doesn&apos;t have it, make a new one and paste that in. The old one stops working at once.</p>}
    </div>
  );
}
