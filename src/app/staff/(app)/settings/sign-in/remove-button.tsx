"use client";
import { useActionState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import type { SaveOutcome } from "@/lib/auth/provider-fields";

export function RemoveButton({ label, action }: { label: string; action: () => Promise<SaveOutcome> }) {
  const [state, run, pending] = useActionState(async () => safely(action, { ok: false as const, errors: [ACTION_FAILED] }), null);
  return (
    <form action={run} onSubmit={(e) => { if (!confirm(`Remove ${label}? People who sign in this way won't be able to until it's set up again.`)) e.preventDefault(); }}>
      {state && !state.ok && <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      <button className="btn btn-line" disabled={pending}>Remove</button>
    </form>
  );
}
