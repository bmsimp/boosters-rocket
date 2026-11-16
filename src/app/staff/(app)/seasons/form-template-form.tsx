"use client";
import { startTransition, useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { ActionOutcome } from "@/app/components/notice";
import { ChoiceGroup } from "@/app/components/choice-group";

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
      <ChoiceGroup name="signers" legend="Who must sign" value={signers} onChange={(v) => setSigners(v === "every" ? "every" : "any")} cols={1}
        options={[{ value: "any", label: "Any one guardian" }, { value: "every", label: "Every guardian who has a sign-in", hint: "Up to the template's signers." }]} />
      <ActionOutcome state={state} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Checking the template…" : current ? "Check and attach again" : "Check and attach"}</button>
    </form>
  );
}
