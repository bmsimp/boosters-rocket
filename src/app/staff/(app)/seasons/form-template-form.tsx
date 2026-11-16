"use client";
import { startTransition, useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";

// The form that attaches a Documenso template to a form requirement. State is the source of truth and a
// type="button" calls the action, as in ./forms.tsx. It is given only what it shows: template names and ids.
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failed: Done = { ok: false, errors: [ACTION_FAILED] };
const noSubmit = (e: { preventDefault: () => void }) => e.preventDefault();

export function FormTemplateForm({ choices, current, signers: savedSigners, save }: {
  /** Documenso's templates to pick from; null when they couldn't be listed, and the address is pasted instead. */
  choices: { id: string; title: string }[] | null;
  current: string | null; signers: "any" | "every";
  save: (template: string, signers: "any" | "every") => Promise<Done>;
}) {
  const listed = choices !== null && choices.length > 0;
  const [template, setTemplate] = useState(listed ? (choices.find((c) => c.id === current)?.id ?? "") : "");
  const [signers, setSigners] = useState(savedSigners);
  const [state, run, pending] = useActionState(async () => safely(() => save(template, signers), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      {listed ? (
        <label className="field"><span>Template in Documenso</span>
          <select value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="">Choose a template</option>
            {choices.map((c) => <option key={c.id} value={c.id}>{c.title || c.id}</option>)}
          </select></label>
      ) : (
        <label className="field"><span>The address of the template&apos;s page in Documenso</span>
          <input autoComplete="off" spellCheck={false} maxLength={500} value={template} onChange={(e) => setTemplate(e.target.value)} /></label>
      )}
      <fieldset className="field checks">
        <legend>Who must sign</legend>
        <label><input type="radio" name="signers" checked={signers === "any"} onChange={() => setSigners("any")} /> Any one guardian</label>
        <label><input type="radio" name="signers" checked={signers === "every"} onChange={() => setSigners("every")} /> Every guardian who has a sign-in, up to the template&apos;s signers</label>
      </fieldset>
      {state && (state.ok ? <p role="status">{state.message}</p> : <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>)}
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Checking the template…" : current ? "Check and attach again" : "Check and attach"}</button>
    </form>
  );
}
