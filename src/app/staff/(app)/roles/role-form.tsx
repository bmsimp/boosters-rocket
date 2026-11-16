"use client";
import { useActionState } from "react";
import { saveRoleAction } from "./actions";
import { ACTION_FAILED, safely } from "@/app/components/action-error";

type R = { id: string; name: string; include: string[]; exclude: string[] };

export function RoleForm({ role }: { role?: R }) {
  const [state, action, pending] = useActionState(async (_: unknown, f: FormData) =>
    safely(() => saveRoleAction(f), { ok: false as const, errors: [ACTION_FAILED] }), null);
  return (
    <form action={action} className="stack">
      {role && <input type="hidden" name="id" value={role.id} />}
      <label className="field"><span>Name</span><input name="name" defaultValue={role?.name} required /></label>
      <label className="field"><span>Include (one per line: a permission&apos;s name, like Roster.Read, or a pattern, like Settings.*)</span>
        <textarea name="include" rows={3} defaultValue={role?.include.join("\n")} /></label>
      <label className="field"><span>Exclude (one per line)</span>
        <textarea name="exclude" rows={2} defaultValue={role?.exclude.join("\n")} /></label>
      {state && !state.ok && <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {state?.ok && <p role="status">Saved.</p>}
      <button className="btn" disabled={pending}>{role ? "Save role" : "Create role"}</button>
    </form>
  );
}
