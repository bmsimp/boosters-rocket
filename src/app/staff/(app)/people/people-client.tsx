"use client";
import { useActionState, useTransition, useState } from "react";
import { inviteStaffAction, setStaffStatusAction } from "./actions";
import { assignRoleAction, unassignRoleAction } from "../roles/actions";

export function InviteForm() {
  const [state, action, pending] = useActionState(async (_: unknown, f: FormData) => inviteStaffAction(f), null);
  return (
    <form action={action} className="stack">
      <label className="field"><span>Name</span><input name="name" required autoComplete="off" /></label>
      <label className="field"><span>Email</span><input name="email" type="email" required autoComplete="off" /></label>
      {state && !state.ok && <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {state?.ok && <p role="status">Added. They can sign in now.</p>}
      <button className="btn" disabled={pending}>Add to staff</button>
    </form>
  );
}

type Person = { id: string; name: string; email: string; status: string; roles: string[] };

export function PersonRow({ person, roles, canEdit, canAssign }: { person: Person; roles: { id: string; name: string }[]; canEdit: boolean; canAssign: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => start(async () => { const r = await fn(); setError(r.ok ? null : r.error ?? "That didn't work."); });
  return (
    <li>
      <span><span className="what">{person.name}</span><span className="when">{person.email} · {person.status}</span></span>
      <span>{person.roles.join(", ") || "No roles"}</span>
      {canAssign && <span className="row-actions">{roles.map((r) => person.roles.includes(r.name)
        ? <button key={r.id} className="btn btn-line" disabled={pending} onClick={() => run(() => unassignRoleAction(r.id, person.id))}>Remove {r.name}</button>
        : <button key={r.id} className="btn btn-line" disabled={pending} onClick={() => run(() => assignRoleAction(r.id, person.id))}>Give {r.name}</button>)}</span>}
      {canEdit && <button className="btn btn-line" disabled={pending}
        onClick={() => run(() => setStaffStatusAction(person.id, person.status === "disabled" ? "active" : "disabled"))}>
        {person.status === "disabled" ? "Turn sign-in back on" : "Turn off sign-in"}</button>}
      {error && <p role="alert" className="errors">{error}</p>}
    </li>
  );
}
