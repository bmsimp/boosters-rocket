"use client";
import { useActionState } from "react";

/** The first Admin's name and email. The name is what the staff list and the club bar show, never their email. */
export function FirstAdminForm({ initialName, initialEmail, action }: {
  initialName: string; initialEmail: string; action: (prev: { error: string } | null, f: FormData) => Promise<{ error: string } | null>;
}) {
  const [state, run, pending] = useActionState(action, null);
  return (
    <form action={run} className="stack">
      <label className="field"><span>Admin&apos;s name</span><input name="name" required maxLength={100} defaultValue={initialName} autoComplete="name" /></label>
      <label className="field"><span>Admin email</span><input name="email" type="email" required defaultValue={initialEmail} autoComplete="email" /></label>
      {state?.error && <p role="alert" className="errors">{state.error}</p>}
      <button className="btn btn-line" disabled={pending}>Save name and email</button>
    </form>
  );
}
