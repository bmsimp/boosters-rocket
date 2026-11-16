"use client";
import { startTransition, useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";

// The forms of the staff signed-forms pages, built as the season pages' are: state is the source of truth and a
// type="button" calls the action. Each is given only what it shows: a label, the saved schedule, the reasons to choose.
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failed: Done = { ok: false, errors: [ACTION_FAILED] };
const noSubmit = (e: { preventDefault: () => void }) => e.preventDefault();

function Outcome({ state }: { state: Done | null }) {
  if (!state) return null;
  return state.ok ? <p role="status">{state.message}</p> : <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>;
}

/** "Remind now": one button, and what came of it in words (how many guardians were emailed). */
export function RemindButton({ label, run }: { label: string; run: () => Promise<Done> }) {
  const [state, act, pending] = useActionState(async () => safely(run, failed), null);
  return (
    <div className="one-button">
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => act())}>{pending ? "Sending…" : label}</button>
      <Outcome state={state} />
    </div>
  );
}

const DAYS = [14, 7, 3, 1] as const;

/** A form's reminder schedule: any of 14, 7, 3 and 1 days before it is due, and once a week after it (four times at most). */
export function ScheduleForm({ before, weeklyAfter, hasDueDate, save }: { before: number[]; weeklyAfter: boolean; hasDueDate: boolean; save: (before: number[], weeklyAfter: boolean) => Promise<Done> }) {
  const [days, setDays] = useState<number[]>(before);
  const [weekly, setWeekly] = useState(weeklyAfter);
  const [state, act, pending] = useActionState(async () => safely(() => save(days, weekly), failed), null);
  const toggle = (d: number) => setDays((old) => (old.includes(d) ? old.filter((x) => x !== d) : [...old, d].sort((a, b) => b - a)));
  return (
    <form onSubmit={noSubmit} className="stack">
      <fieldset className="field checks">
        <legend>Remind guardians who haven&apos;t signed</legend>
        {DAYS.map((d) => <label key={d}><input type="checkbox" checked={days.includes(d)} onChange={() => toggle(d)} /> {d === 1 ? "1 day" : `${d} days`} before it&apos;s due</label>)}
        <label><input type="checkbox" checked={weekly} onChange={() => setWeekly((w) => !w)} /> Once a week after it&apos;s due, four times at most</label>
      </fieldset>
      <p className="hint">{hasDueDate ? "Reminders go at 9 in the morning, club time, once parent sign-ins and welcome emails are both switched on." : "This form has no due date, so scheduled reminders won't go until it has one. Set it on the season's page."}</p>
      <Outcome state={state} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => act())}>{pending ? "Saving…" : "Save reminders"}</button>
    </form>
  );
}

/** Starting a form again: why (kept for staff), an optional note, and the one button. */
export function StartAgainForm({ reasons, run }: { reasons: { value: string; label: string }[]; run: (reason: string, note: string) => Promise<Done> }) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [state, act, pending] = useActionState(async () => safely(() => run(reason, note), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <fieldset className="field checks">
        <legend>Why it is being started again</legend>
        {reasons.map((r) => <label key={r.value}><input type="radio" name="restart-reason" checked={reason === r.value} onChange={() => setReason(r.value)} /> {r.label}</label>)}
      </fieldset>
      <label className="field"><span>A note for staff (optional; families never see it)</span><textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      <p className="hint">The document in Documenso is withdrawn, and the family reads only that the form is ready to sign again.</p>
      <Outcome state={state} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => act())}>{pending ? "Starting again…" : "Start again"}</button>
    </form>
  );
}
