"use client";
import { startTransition, useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { ActionOutcome } from "@/app/components/notice";

type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failed: Done = { ok: false, errors: [ACTION_FAILED] };

/**
 * Closing a buy-out, asked first: the button opens what closing does, a field for why (kept in the audit log, for staff
 * only) and the confirm. `act` is the action bound to the buy-out as the page showed it; it is given nothing else.
 */
export function CloseBuyout({ what, act }: { what: string; act: (note: string) => Promise<Done> }) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [state, run, pending] = useActionState(async () => safely(() => act(note), failed), null);
  if (state?.ok) return <ActionOutcome state={state} />;
  if (!asking) return <div className="row-actions"><button type="button" className="btn btn-line" onClick={() => setAsking(true)}>Close this buy-out</button></div>;
  return (
    <form className="stack" onSubmit={(e) => e.preventDefault()}>
      <p>{what} Nothing is sent to QuickBooks.</p>
      <label className="field"><span>Why? (kept in the audit log, for staff only)</span>
        <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      {state && <ActionOutcome state={state} />}
      <div className="row-actions">
        <button type="button" className="btn btn-line" aria-disabled={pending} onClick={() => { if (!pending) startTransition(() => run()); }}>{pending ? "Closing…" : "Close it"}</button>
        <button type="button" className="btn btn-line" onClick={() => setAsking(false)}>Keep it</button>
      </div>
    </form>
  );
}
