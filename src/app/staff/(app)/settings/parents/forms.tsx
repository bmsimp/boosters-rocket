"use client";
import { startTransition, useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";

// The match row keeps a choice in state, so it uses no form `action`: React resets a form after one, and the select
// would jump back while state kept the choice (see settings/quickbooks/forms.tsx). A single button with nothing to
// type may use a form action.
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failed: Done = { ok: false, errors: [ACTION_FAILED] };
const noSubmit = (e: { preventDefault: () => void }) => e.preventDefault();
function Outcome({ state }: { state: Done | null }) {
  if (!state) return null;
  return state.ok ? <p role="status">{state.message}</p> : <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>;
}

/** One button for one switch. Nothing is typed, so a plain form action is fine. */
export function SwitchButton({ label, pendingLabel, quiet, act }: { label: string; pendingLabel: string; quiet?: boolean; act: () => Promise<Done> }) {
  const [state, run, pending] = useActionState(async () => safely(() => act(), failed), null);
  return (
    <form action={run} className="stack">
      <Outcome state={state} />
      <button className={quiet ? "btn btn-line" : "btn"} disabled={pending}>{pending ? pendingLabel : label}</button>
    </form>
  );
}

/** One old family: accept the chosen counterpart, or reject. The select is state, so a refusal keeps the choice. */
export function MatchRow({ oldId, suggested, families, decide }: {
  oldId: string; suggested: string | null; families: { qboId: string; name: string }[];
  decide: (oldFamilyQboId: string, newFamilyQboId: string | null) => Promise<Done>;
}) {
  const [choice, setChoice] = useState(suggested ?? "");
  const [state, run, pending] = useActionState(async (_: Done | null, to: string | null) => safely(() => decide(oldId, to), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>The same family in the connected company</span>
        <select value={choice} onChange={(e) => setChoice(e.target.value)}>
          <option value="">Choose a family</option>
          {families.map((f) => <option key={f.qboId} value={f.qboId}>{f.name}</option>)}
        </select></label>
      <Outcome state={state} />
      <div className="row-actions">
        <button type="button" className="btn" disabled={pending || !choice} onClick={() => startTransition(() => run(choice))}>Accept</button>
        <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run(null))}>No match</button>
      </div>
    </form>
  );
}
