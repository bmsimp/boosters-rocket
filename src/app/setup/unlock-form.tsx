"use client";
import { useActionState } from "react";
import { unlockSetupAction } from "./actions";

export function UnlockForm() {
  const [state, run, pending] = useActionState(unlockSetupAction, null);
  return (
    <form action={run} className="stack">
      <label className="field"><span>Setup code</span>
        <input name="code" required autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} placeholder="XXXX-XXXX-XXXX" />
      </label>
      {state?.error && <p role="alert" className="errors">{state.error}</p>}
      <button className="btn" disabled={pending}>Unlock</button>
    </form>
  );
}
