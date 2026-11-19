"use client";
import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { ActionOutcome } from "@/app/components/notice";

// No form `action` on the forms with a text field: React resets a form after one, and the note would vanish on a
// refusal. State is the source of truth; a type="button" calls the action inside startTransition (see
// settings/quickbooks/forms.tsx).
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failed: Done = { ok: false, errors: [ACTION_FAILED] };
const noSubmit = (e: { preventDefault: () => void }) => e.preventDefault();
function Outcome({ state }: { state: Done | null }) {
  if (!state) return null;
  return <ActionOutcome state={state} />;
}

/** A text field and one button: used to block a person. */
export function NoteAction({ label, field, pendingLabel, act }: { label: string; field: string; pendingLabel: string; act: (text: string) => Promise<Done> }) {
  const [text, setText] = useState("");
  const [state, run, pending] = useActionState(async () => safely(() => act(text), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>{field}</span><textarea rows={2} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <Outcome state={state} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? pendingLabel : label}</button>
    </form>
  );
}

/** One button, nothing to type: a plain form action is fine here. */
export function OneButton({ label, pendingLabel, act }: { label: string; pendingLabel: string; act: () => Promise<Done> }) {
  const [state, run, pending] = useActionState(async () => safely(() => act(), failed), null);
  return (
    <form action={run} className="stack">
      <Outcome state={state} />
      <button className="btn btn-line" disabled={pending}>{pending ? pendingLabel : label}</button>
    </form>
  );
}

/**
 * Remove or reinstate one guardian row (./guardian-change.tsx). One component for both, kept mounted across the change
 * (the row's key is its guardian row's id), so the answer stays on the page when the action's refresh swaps Remove for
 * Reinstate or back, and the focus, whose button is gone, moves to that answer.
 */
export function GuardianChangeControls({ name, open, reinstatable, remove, reinstate }: {
  name: string; open: boolean; reinstatable: boolean; remove: (note: string) => Promise<Done>; reinstate: () => Promise<Done>;
}) {
  const [note, setNote] = useState("");
  const [state, run, pending] = useActionState(async (_: Done | null, what: "remove" | "reinstate") => {
    const r = await safely(() => (what === "remove" ? remove(note) : reinstate()), failed);
    if (r.ok) setNote("");
    return r;
  }, null);
  const said = useRef<HTMLDivElement>(null);
  useEffect(() => { if (state?.ok) said.current?.focus(); }, [state]);
  if (!state && !open && !reinstatable) return null;
  return (
    <div className="stack">
      {state ? <div ref={said} tabIndex={-1}><ActionOutcome state={state} /></div> : null}
      {open ? (
        <details className="more"><summary>Remove<span className="visually-hidden"> {name}</span></summary>
          <p>They can&apos;t sign in to this family any more, and are signed out of it at once, whatever the family owes. Forms still waiting for their signature start again.</p>
          <form onSubmit={noSubmit} className="stack">
            <label className="field"><span>Why? (staff only)</span><textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
            <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run("remove"))}>{pending ? "Removing…" : "Remove"}</button>
          </form>
        </details>
      ) : reinstatable ? (
        <form action={() => run("reinstate")} className="stack">
          <button className="btn btn-line" disabled={pending}>{pending ? "Reinstating…" : `Reinstate ${name}`}</button>
        </form>
      ) : null}
    </div>
  );
}

/**
 * Add a guardian to a family: a name and an email address, sent to the action as typed (the server checks both). After
 * an add the fields are emptied, so a second guardian can be typed in; after a refusal they stay as they were.
 */
export function AddGuardianForm({ act }: { act: (name: string, email: string) => Promise<Done> }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [state, run, pending] = useActionState(async () => {
    const r = await safely(() => act(name, email), failed);
    if (r.ok) { setName(""); setEmail(""); }
    return r;
  }, null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>Name</span><input type="text" maxLength={100} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>Email address they sign in with</span><input type="email" maxLength={320} autoComplete="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <Outcome state={state} />
      <button type="button" className="btn" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Adding…" : "Add guardian"}</button>
    </form>
  );
}

/** A person's name, changed in the portal: the field starts from the name they have. */
export function NameForm({ name: current, act }: { name: string; act: (name: string) => Promise<Done> }) {
  const [name, setName] = useState(current);
  const [state, run, pending] = useActionState(async () => safely(() => act(name), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>Name</span><input type="text" maxLength={100} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <Outcome state={state} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Saving…" : "Save name"}</button>
    </form>
  );
}
