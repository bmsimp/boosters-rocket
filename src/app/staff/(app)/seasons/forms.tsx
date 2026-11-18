"use client";
import { startTransition, useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { ActionOutcome } from "@/app/components/notice";
import { ChoiceGroup } from "@/app/components/choice-group";

// The forms of the season pages. No form `action` on a form with a field: React resets a form after one, and what was
// typed would vanish on a refusal. State is the source of truth; a type="button" calls the action inside
// startTransition (as in ../parents/forms.tsx). Each is given only what it shows.
export type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failed: Done = { ok: false, errors: [ACTION_FAILED] };
const noSubmit = (e: { preventDefault: () => void }) => e.preventDefault();

function Outcome({ state }: { state: Done | null }) {
  if (!state) return null;
  return <ActionOutcome state={state} />;
}

/** One button, nothing to type. `goTo` is where to go once it has worked, for a page whose subject is then gone. */
export function OneButton({ label, pendingLabel, act, goTo, primary = false }: { label: string; pendingLabel: string; act: () => Promise<Done>; goTo?: string; primary?: boolean }) {
  const router = useRouter();
  const [state, run, pending] = useActionState(async () => {
    const r = await safely(() => act(), failed);
    if (r.ok && goTo) router.push(goTo);
    return r;
  }, null);
  return (
    <form action={run} className="one-button">
      <button className={primary ? "btn" : "btn btn-line"} disabled={pending}>{pending ? pendingLabel : label}</button>
      <Outcome state={state} />
    </form>
  );
}

/** A text field and one button: a name to add or change, or the reason for a waiver. */
export function TextAction({ field, label, pendingLabel, initial = "", maxLength, multiline = false, act }: {
  field: string; label: string; pendingLabel: string; initial?: string; maxLength: number; multiline?: boolean; act: (text: string) => Promise<Done>;
}) {
  const [text, setText] = useState(initial);
  const [state, run, pending] = useActionState(async () => {
    const r = await safely(() => act(text), failed);
    if (r.ok && initial === "") setText(""); // a field for adding starts empty again; a field for changing keeps what was saved
    return r;
  }, null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>{field}</span>
        {multiline ? <textarea rows={2} maxLength={maxLength} value={text} onChange={(e) => setText(e.target.value)} />
          : <input maxLength={maxLength} value={text} onChange={(e) => setText(e.target.value)} />}</label>
      <Outcome state={state} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? pendingLabel : label}</button>
    </form>
  );
}

/**
 * A new season: its name, and how it starts. `lastName` is the season a copy would be taken from, when there is one.
 * Once it is made, the page goes on to the new season, where its steps are set up, as a new volunteer event does.
 */
export function NewSeasonForm({ lastName, create }: { lastName: string | null; create: (name: string, start: "empty" | "template" | "last") => Promise<Done & { seasonId?: string }> }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [state, run, pending] = useActionState(async (_: Done | null, start: "empty" | "template" | "last") => {
    const r = await safely(() => create(name, start), failed);
    if (r.ok) setName("");
    if (r.ok && "seasonId" in r && r.seasonId) router.push(`/staff/seasons/${r.seasonId}`);
    return r;
  }, null);
  const go = (start: "empty" | "template" | "last") => () => startTransition(() => run(start));
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>Season name, such as Fall 2027</span><input maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <Outcome state={state} />
      <div className="row-actions">
        {lastName !== null && <button type="button" className="btn" disabled={pending} onClick={go("last")}>Copy {lastName}</button>}
        <button type="button" className={lastName === null ? "btn" : "btn btn-line"} disabled={pending} onClick={go("template")}>Start from the template</button>
        <button type="button" className="btn btn-line" disabled={pending} onClick={go("empty")}>Start with no steps</button>
      </div>
    </form>
  );
}

/** A step's name and its optional dates. An empty date is no date. */
export function StepForm({ initial, save }: { initial: { name: string; startsOn: string | null; endsOn: string | null }; save: (name: string, startsOn: string | null, endsOn: string | null) => Promise<Done> }) {
  const [name, setName] = useState(initial.name);
  const [startsOn, setStartsOn] = useState(initial.startsOn ?? "");
  const [endsOn, setEndsOn] = useState(initial.endsOn ?? "");
  const [state, run, pending] = useActionState(async () => safely(() => save(name, startsOn || null, endsOn || null), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>Step name</span><input maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>Starts on (optional)</span><input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></label>
      <label className="field"><span>Ends on (optional)</span><input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} /></label>
      <Outcome state={state} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Saving…" : "Save step"}</button>
    </form>
  );
}

export type RequirementFields = { title: string; required: boolean; amount: number | null; amountUnit: "shifts" | "hours" | null; dueOn: string | null };
export type KindChoice = { value: string; label: string; available: boolean };

/**
 * A requirement's settings (v1 spec §10.1). With `kinds` it is the form for a new one, which also asks the kind and
 * who it applies to: both are fixed once it is made. A kind that can't be met yet is listed and can't be picked.
 * An amount is asked only of a volunteering requirement. With `perStudent` false (a club whose roster lists no
 * students) a new one can only be asked of each family.
 */
export function RequirementForm({ kinds, kind, initial, perStudent = true, add, save }: {
  kinds?: KindChoice[]; kind?: string; initial?: RequirementFields; perStudent?: boolean;
  add?: (kind: string, appliesTo: "family" | "student", fields: RequirementFields) => Promise<Done>;
  save?: (fields: RequirementFields) => Promise<Done>;
}) {
  const [chosenKind, setKind] = useState(kind ?? kinds?.find((k) => k.available)?.value ?? "checklist");
  const [appliesTo, setAppliesTo] = useState<"family" | "student">(perStudent ? "student" : "family");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [required, setRequired] = useState(initial?.required ?? true);
  const [amount, setAmount] = useState(initial?.amount === null || initial?.amount === undefined ? "" : String(initial.amount));
  const [unit, setUnit] = useState<"shifts" | "hours">(initial?.amountUnit ?? "shifts");
  const [dueOn, setDueOn] = useState(initial?.dueOn ?? "");
  const volunteer = chosenKind === "volunteer";
  const [state, run, pending] = useActionState(async () => {
    const fields: RequirementFields = { title, required, amount: volunteer ? Number(amount) : null, amountUnit: volunteer ? unit : null, dueOn: dueOn || null };
    const r = await safely(() => (add ? add(chosenKind, appliesTo, fields) : save!(fields)), failed);
    if (r.ok && add) { setTitle(""); setDueOn(""); }
    return r;
  }, null);
  return (
    <form onSubmit={noSubmit} className="stack">
      {kinds && (
        <label className="field"><span>Kind</span>
          <select value={chosenKind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map((k) => <option key={k.value} value={k.value} disabled={!k.available}>{k.label}{k.available ? "" : " (coming later)"}</option>)}
          </select></label>
      )}
      <label className="field"><span>What it is, in your club&apos;s words</span><input maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
      {add && (
        <ChoiceGroup name="applies-to" legend="Asked of" value={appliesTo} onChange={(v) => setAppliesTo(v === "family" ? "family" : "student")}
          options={[...(perStudent ? [{ value: "student", label: "Each student" }] : []), { value: "family", label: "Each family, once" }]} />
      )}
      <ChoiceGroup name="required" legend="Required or optional" hint="An optional one is shown, and never holds the step open." value={required ? "required" : "optional"}
        onChange={(v) => setRequired(v === "required")} options={[{ value: "required", label: "Required" }, { value: "optional", label: "Optional" }]} />
      {volunteer && (
        <>
          <label className="field"><span>How much</span><input type="number" min={1} max={1000} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <ChoiceGroup name="unit" legend="Counted in" value={unit} onChange={(v) => setUnit(v === "hours" ? "hours" : "shifts")}
            options={[{ value: "shifts", label: "Shifts" }, { value: "hours", label: "Hours" }]} />
        </>
      )}
      <label className="field"><span>Due date (optional)</span><input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} /></label>
      <Outcome state={state} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Saving…" : add ? "Add requirement" : "Save requirement"}</button>
    </form>
  );
}

/** Who a requirement is asked of: everyone, or those ticked in a list from the roster, by the app's own ids. */
export function CoverageForm({ covers, chosen, candidates, noun, save }: {
  covers: "everyone" | "chosen"; chosen: string[]; candidates: { id: string; label: string }[]; noun: "families" | "students";
  save: (covers: "everyone" | "chosen", subjectIds: string[]) => Promise<Done>;
}) {
  const [mode, setMode] = useState(covers);
  const [picked, setPicked] = useState(() => new Set(chosen));
  const [state, run, pending] = useActionState(async () => safely(() => save(mode, mode === "chosen" ? [...picked] : []), failed), null);
  const toggle = (id: string) => setPicked((old) => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return (
    <form onSubmit={noSubmit} className="stack">
      <ChoiceGroup name="covers" legend="Asked of" value={mode} onChange={(v) => setMode(v === "chosen" ? "chosen" : "everyone")}
        options={[{ value: "everyone", label: "Everyone" }, { value: "chosen", label: `Only the ${noun} I choose` }]} />
      {mode === "chosen" && (
        <fieldset className="field checks">
          <legend>Choose {noun} ({picked.size} chosen)</legend>
          {candidates.length === 0 ? <p>The roster lists no {noun} to choose from.</p>
            : candidates.map((c) => <label key={c.id}><input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} /> {c.label}</label>)}
        </fieldset>
      )}
      <Outcome state={state} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Saving…" : "Save who it is asked of"}</button>
    </form>
  );
}
