"use client";
import { Notice } from "@/app/components/notice";
import { useActionState } from "react";
import type { FirstAdminState } from "./actions";

/** The first Admin's name and email. The name is what the staff list and the club bar show, never their email. */
export function FirstAdminForm({ initialName, initialEmail, action }: {
  initialName: string; initialEmail: string; action: (prev: FirstAdminState, f: FormData) => Promise<FirstAdminState>;
}) {
  const [state, run, pending] = useActionState(action, null);
  return (
    <form action={run} className="stack">
      <label className="field"><span>Admin&apos;s name</span><input name="name" required maxLength={100} defaultValue={initialName} autoComplete="name" /></label>
      <label className="field"><span>Admin email</span><input name="email" type="email" required defaultValue={initialEmail} autoComplete="email" /></label>
      {state && "error" in state && <Notice tone="problem">{state.error}</Notice>}
      {/* The save answered in words: the sign-in buttons appear under it, which alone said nothing (docs/walkthrough.md). */}
      {state && "saved" in state && <Notice tone="done">{state.saved}</Notice>}
      <button className="btn btn-line" disabled={pending}>Save name and email</button>
    </form>
  );
}
