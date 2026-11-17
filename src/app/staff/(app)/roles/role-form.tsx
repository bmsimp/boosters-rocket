"use client";
import { ActionOutcome } from "@/app/components/notice";
import { startTransition, useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { PERMISSION_AREAS, PERMISSION_WORDS, readTwinOf, withReadTwins } from "@/lib/permissions/words";
import type { Permission } from "@/lib/permissions/registry";
import { deleteRoleAction, saveRoleChecklistAction } from "./actions";

type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failed: Done = { ok: false, errors: [ACTION_FAILED] };
export type RoleView = { id: string; name: string; members: number; granted: Permission[]; patterns: boolean };

function Outcome({ state }: { state: Done | null }) {
  if (!state) return null;
  return <ActionOutcome state={state} />;
}

/**
 * A role's name and what it lets people do, as ticks in plain words, grouped by area. A ReadWrite brings its Read, so
 * ticking one ticks the other and holds it there. The form keeps its values in state and uses no form `action`: React
 * resets a form after one, and a refusal would lose the ticks (see ../settings/quickbooks/forms.tsx).
 */
export function RoleForm({ role }: { role?: RoleView }) {
  const [name, setName] = useState(role?.name ?? "");
  // Started from what a save writes: a change the role holds brings its "see" permission, ticked here as it will be saved.
  const [ticked, setTicked] = useState<Set<Permission>>(new Set(withReadTwins(role?.granted ?? [])));
  const added = withReadTwins(role?.granted ?? []).filter((p) => !(role?.granted ?? []).includes(p));
  const [state, run, pending] = useActionState(async () => {
    const r = await safely(() => saveRoleChecklistAction(role?.id ?? null, name, [...ticked]), failed);
    if (r.ok && !role) { setName(""); setTicked(new Set()); }
    return r;
  }, null);
  const broughtBy = (p: Permission) => [...ticked].find((t) => readTwinOf(t) === p) ?? null;
  const toggle = (p: Permission) => setTicked((now) => {
    const next = new Set(now);
    if (next.has(p)) next.delete(p);
    else { next.add(p); const twin = readTwinOf(p); if (twin) next.add(twin); }
    return next;
  });
  const prefix = role?.id ?? "new";
  return (
    <form onSubmit={(e) => e.preventDefault()} className="stack role-form">
      <label className="field"><span>Name</span>
        <input name="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoComplete="off" /></label>
      {role?.patterns && (
        <p className="role-patterns" role="note">This role was written with patterns, so it also takes up new permissions by itself as they are added. The ticks below are what it gives today. Saving here keeps exactly these ticks, and the role will then no longer take up new permissions by itself.</p>
      )}
      {added.length > 0 && (
        <p className="role-patterns" role="note">It doesn&apos;t give {added.map((p) => `“${PERMISSION_WORDS[p]}”`).join(" or ")} today, though a change it can make comes with it. Saving gives it.</p>
      )}
      {PERMISSION_AREAS.map((a) => (
        <fieldset key={a.area} className="checks role-area">
          <legend>{a.area}</legend>
          {a.permissions.map((p) => {
            const by = broughtBy(p);
            const id = `${prefix}-${p}`;
            return (
              <label key={p} htmlFor={id}>
                <input id={id} type="checkbox" checked={ticked.has(p)} disabled={by !== null} onChange={() => toggle(p)} aria-describedby={by ? `${id}-by` : undefined} />
                <span>{PERMISSION_WORDS[p]}{by && <span id={`${id}-by`} className="hint"> (comes with “{PERMISSION_WORDS[by]}”)</span>}</span>
              </label>
            );
          })}
        </fieldset>
      ))}
      <Outcome state={state} />
      <button type="button" className="btn" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Saving…" : role ? "Save role" : "Make role"}</button>
    </form>
  );
}

/** Delete, with a step that says how many people hold the role before anything is deleted. */
export function DeleteRole({ role }: { role: Pick<RoleView, "id" | "name" | "members"> }) {
  const [asking, setAsking] = useState(false);
  const [state, run, pending] = useActionState(async () => safely(() => deleteRoleAction(role.id), failed), null);
  const held = role.members === 0 ? "Nobody holds it." : `${role.members} ${role.members === 1 ? "person holds" : "people hold"} it and will lose what it lets them do.`;
  if (!asking) return <p><button type="button" className="btn btn-line" onClick={() => setAsking(true)}>Delete role</button></p>;
  return (
    <div className="stack role-delete" role="group" aria-labelledby={`del-${role.id}`}>
      <p id={`del-${role.id}`}><b>Delete {role.name}?</b> {held} Their other roles stay as they are.</p>
      <Outcome state={state} />
      <div className="row-actions">
        <button type="button" className="btn" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Deleting…" : "Yes, delete it"}</button>
        <button type="button" className="btn btn-line" disabled={pending} onClick={() => setAsking(false)}>Keep it</button>
      </div>
    </div>
  );
}
