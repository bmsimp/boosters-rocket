"use client";
import { useActionState } from "react";
import { saveRoleAction } from "./actions";

type R = { id: string; name: string; include: string[]; exclude: string[] };

export function RoleForm({ role }: { role?: R }) {
  const [state, action, pending] = useActionState(async (_: unknown, f: FormData) => saveRoleAction(f), null);
  return (
    <form action={action} className="stack">
      {role && <input type="hidden" name="id" value={role.id} />}
      <label className="field"><span>Name</span><input name="name" defaultValue={role?.name} required /></label>
      <label className="field"><span>Include (one pattern per line, e.g. Roster.*)</span>
        <textarea name="include" rows={3} defaultValue={role?.include.join("\n")} /></label>
      <label className="field"><span>Exclude (one per line)</span>
        <textarea name="exclude" rows={2} defaultValue={role?.exclude.join("\n")} /></label>
      {state && !state.ok && <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {state?.ok && <p role="status">Saved.</p>}
      <button className="btn" disabled={pending}>{role ? "Save role" : "Create role"}</button>
    </form>
  );
}
