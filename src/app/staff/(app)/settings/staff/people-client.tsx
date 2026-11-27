"use client";
import { ActionOutcome, Notice } from "@/app/components/notice";
import { startTransition, useActionState, useTransition, useState } from "react";
import { inviteStaffAction, setStaffStatusAction, setStaffRolesAction, renameStaffAction, renameMyselfAction } from "./actions";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { RoleChecklist, type RoleOption } from "./role-checklist";

type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failed: Done = { ok: false, errors: [ACTION_FAILED] };

export function InviteForm({ roles }: { roles: RoleOption[] }) {
  const [state, action, pending] = useActionState(async (_: unknown, f: FormData) =>
    safely(() => inviteStaffAction(f), { ok: false as const, errors: [ACTION_FAILED] }), null);
  return (
    <form action={action} className="stack">
      <label className="field"><span>Name</span><input name="name" required maxLength={100} autoComplete="off" /></label>
      <label className="field"><span>Email</span><input name="email" type="email" required autoComplete="off" /></label>
      <RoleChecklist key={state?.ok ? `done-${state.id}` : "new"} roles={roles} initial={[]} legend="Roles" idPrefix="invite" />
      {state && !state.ok && <ActionOutcome state={state} />}
      {state?.ok && <Notice tone="done">Added. They can sign in now.</Notice>}
      <button className="btn" disabled={pending}>Add to staff</button>
    </form>
  );
}

const STATUS_WORDS: Record<string, string> = { invited: "Hasn't signed in yet", active: "Can sign in", disabled: "Sign-in turned off" };

/**
 * A name, with a quiet "Change name" that opens a field and its own Save. With no `id` it is the signed-in person's own
 * name, saved through the action that takes no id, so anyone may change their own name (the staff home can show it too).
 */
export function NameEdit({ id, name }: { id?: string; name: string }) {
  const self = id === undefined;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [state, run, pending] = useActionState(async () => {
    const r = await safely(() => (id === undefined ? renameMyselfAction(value) : renameStaffAction(id, value)), failed);
    if (r.ok) setEditing(false);
    return r;
  }, null);
  if (!editing) {
    return (
      <div className="staff-name-edit">
        <button type="button" className="btn btn-text" onClick={() => { setValue(name); setEditing(true); }}>{self ? "Change my name" : "Change name"}<span className="visually-hidden">{self ? "" : ` for ${name}`}</span></button>
        {state?.ok && <Notice tone="done">Name saved.</Notice>}
      </div>
    );
  }
  return (
    <form className="staff-name-edit" onSubmit={(e) => { e.preventDefault(); startTransition(() => run()); }}>
      <label className="field"><span>{self ? "Your name" : "Name"}</span>
        <input value={value} onChange={(e) => setValue(e.target.value)} required maxLength={100} autoComplete={self ? "name" : "off"} /></label>
      {state && !state.ok && <ActionOutcome state={state} />}
      <div className="row-actions">
        <button className="btn btn-outlined" disabled={pending}>{pending ? "Saving…" : "Save name"}</button>
        <button type="button" className="btn btn-text" disabled={pending} onClick={() => setEditing(false)}>Cancel</button>
      </div>
    </form>
  );
}

type Person = { id: string; name: string; email: string; status: string; roles: { id: string; name: string }[] };

/**
 * One person: who they are, their roles as ticks with their own Save, then turning their sign-in off, which is quieter
 * than Save. Without Staff.Users.ReadWrite the row shows their roles in words, and a person's own row can still change
 * their own name.
 */
export function PersonRow({ person, roles, canEdit, self }: { person: Person; roles: RoleOption[]; canEdit: boolean; self: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => start(async () => {
    const r = await safely(fn, { ok: false, error: ACTION_FAILED });
    setError(r.ok ? null : r.error ?? ACTION_FAILED);
    setSaved(r.ok ? done : null);
  });
  const heldKey = person.roles.map((r) => r.id).sort().join(",");
  const disabled = person.status === "disabled";
  return (
    <li className="staff-person">
      <div className="who">
        <b>{person.name}</b>{self && <span>That&apos;s you</span>}
        <span>{person.email}</span>
        <span>{STATUS_WORDS[person.status] ?? person.status}</span>
        {(canEdit || self) && <NameEdit key={person.name} id={self ? undefined : person.id} name={person.name} />}
      </div>
      {canEdit
        ? <form className="staff-roles" action={(f) => run(() => setStaffRolesAction(person.id, f), "Roles saved.")}>
            <RoleChecklist key={heldKey} roles={roles} initial={person.roles.map((r) => r.id)} legend={`Roles for ${person.name}`} idPrefix={person.id} />
            <button className="btn btn-outlined" disabled={pending}>Save roles<span className="visually-hidden"> for {person.name}</span></button>
          </form>
        : <p>{person.roles.map((r) => r.name).join(", ") || "No roles"}</p>}
      {canEdit && <div>
        <button type="button" className="btn btn-text" disabled={pending}
          onClick={() => run(() => setStaffStatusAction(person.id, disabled ? "active" : "disabled"), disabled ? "Sign-in turned back on." : "Sign-in turned off.")}>
          {disabled ? "Turn sign-in back on" : "Turn off sign-in"}<span className="visually-hidden"> for {person.name}</span></button>
      </div>}
      {error && <Notice tone="problem">{error}</Notice>}
      {saved && !error && <Notice tone="done">{saved}</Notice>}
    </li>
  );
}
