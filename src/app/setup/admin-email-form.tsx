"use client";
import { useActionState } from "react";

export function AdminEmailForm({ initial, action }: { initial: string; action: (prev: { error: string } | null, f: FormData) => Promise<{ error: string } | null> }) {
  const [state, run, pending] = useActionState(action, null);
  return (
    <form action={run} className="stack">
      <label className="field"><span>Admin email</span><input name="email" type="email" required defaultValue={initial} autoComplete="email" /></label>
      {state?.error && <p role="alert" className="errors">{state.error}</p>}
      <button className="btn btn-line" disabled={pending}>Save email</button>
    </form>
  );
}
