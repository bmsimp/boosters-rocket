"use client";
import { startTransition, useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { ActionOutcome } from "@/app/components/notice";

// No form `action` on the forms with a text field: React resets a form after one, and the note would vanish on a
// refusal. State is the source of truth; a type="button" calls the action inside startTransition (see
// settings/quickbooks/forms.tsx).
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
type Decision = "same_person" | "not_same";
const failed: Done = { ok: false, errors: [ACTION_FAILED] };
const noSubmit = (e: { preventDefault: () => void }) => e.preventDefault();
function Outcome({ state }: { state: Done | null }) {
  if (!state) return null;
  return <ActionOutcome state={state} />;
}

/**
 * One held address: a note and the two answers (spec §4 To review). `familyQboIds` is every family the page showed
 * under the address, held or not: the decision is refused if the address has moved since.
 */
export function HoldForm({ email, familyQboIds, decide }: {
  email: string; familyQboIds: string[]; decide: (email: string, decision: Decision, shownFamilyQboIds: string[], note: string) => Promise<Done>;
}) {
  const [note, setNote] = useState("");
  const [state, run, pending] = useActionState(async (_: Done | null, decision: Decision) => safely(() => decide(email, decision, familyQboIds, note), failed), null);
  return (
    <form onSubmit={noSubmit}>
      <fieldset className="decide">
        <legend>Is it one person?</legend>
        <label className="field"><span>How do you know? (staff only)</span>
          <textarea name="note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <Outcome state={state} />
        <div className="row-actions">
          <button type="button" className="btn" disabled={pending} onClick={() => startTransition(() => run("same_person"))}>Same person</button>
          <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run("not_same"))}>Not the same person</button>
        </div>
      </fieldset>
    </form>
  );
}

/** A text field and one button: used to reverse a decision and to block a person. */
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
