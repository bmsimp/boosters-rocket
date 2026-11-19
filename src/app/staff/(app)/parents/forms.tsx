"use client";
import { startTransition, useActionState, useState } from "react";
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
