"use client";
import { useActionState, useTransition, useState } from "react";
import { inviteStaffAction, setStaffStatusAction, setStaffRolesAction } from "./actions";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { RoleChecklist, type RoleOption } from "./role-checklist";

export function InviteForm({ roles }: { roles: RoleOption[] }) {
  const [state, action, pending] = useActionState(async (_: unknown, f: FormData) =>
    safely(() => inviteStaffAction(f), { ok: false as const, errors: [ACTION_FAILED] }), null);
  return (
    <form action={action} className="stack">
      <label className="field"><span>Name</span><input name="name" required autoComplete="off" /></label>
      <label className="field"><span>Email</span><input name="email" type="email" required autoComplete="off" /></label>
      <RoleChecklist key={state?.ok ? `done-${state.id}` : "new"} roles={roles} initial={[]} />
      {state && !state.ok && <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {state?.ok && <p role="status">Added. They can sign in now.</p>}
      <button className="btn" disabled={pending}>Add to staff</button>
    </form>
  );
}

type Person = { id: string; name: string; email: string; status: string; roles: { id: string; name: string }[] };

export function PersonRow({ person, roles, canEdit }:
  { person: Person; roles: RoleOption[]; canEdit: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => start(async () => {
    const r = await safely(fn, { ok: false, error: ACTION_FAILED });
    setError(r.ok ? null : r.error ?? ACTION_FAILED);
    setSaved(r.ok);
  });
  const heldKey = person.roles.map((r) => r.id).sort().join(",");
  return (
    <li>
      <span><span className="what">{person.name}</span><span className="when">{person.email} · {person.status}</span></span>
      {canEdit
        ? <form className="row-actions" action={(f) => run(() => setStaffRolesAction(person.id, f))}>
            <RoleChecklist key={heldKey} roles={roles} initial={person.roles.map((r) => r.id)} />
            <button className="btn btn-line" disabled={pending}>Save</button>
          </form>
        : <span>{person.roles.map((r) => r.name).join(", ") || "No roles"}</span>}
      {canEdit && <button className="btn btn-line" disabled={pending}
        onClick={() => run(() => setStaffStatusAction(person.id, person.status === "disabled" ? "active" : "disabled"))}>
        {person.status === "disabled" ? "Turn sign-in back on" : "Turn off sign-in"}</button>}
      {error && <p role="alert" className="errors">{error}</p>}
      {saved && !error && <p role="status">Roles saved.</p>}
    </li>
  );
}
