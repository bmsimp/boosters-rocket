"use client";
import { startTransition, useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { ACTION_FAILED, safely } from "@/app/components/action-error";

// The forms of the staff volunteer pages, built as the season pages' are (../seasons/forms.tsx): state is the source of
// truth and a type="button" calls the action, so a refusal keeps what was typed. Each is given only what it shows.
export type Done = { ok: true; message: string; eventId?: string } | { ok: false; errors: string[] };
const failed: Done = { ok: false, errors: [ACTION_FAILED] };
const noSubmit = (e: { preventDefault: () => void }) => e.preventDefault();

function Outcome({ state }: { state: Done | null }) {
  if (!state) return null;
  return state.ok ? <p role="status">{state.message}</p> : <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>;
}

export type EventFields = { name: string; onDate: string; location: string; description: string; contactName: string; contactEmail: string };

/** An event's details. Adding one goes to its page, to add its shifts. */
export function EventForm({ initial, save, label }: { initial?: EventFields; save: (f: EventFields) => Promise<Done>; label: string }) {
  const router = useRouter();
  const [f, setF] = useState<EventFields>(initial ?? { name: "", onDate: "", location: "", description: "", contactName: "", contactEmail: "" });
  const set = (k: keyof EventFields) => (e: { target: { value: string } }) => setF((old) => ({ ...old, [k]: e.target.value }));
  const [state, run, pending] = useActionState(async () => {
    const r = await safely(() => save(f), failed);
    if (r.ok && r.eventId && !initial) router.push(`/staff/volunteer/${r.eventId}`);
    return r;
  }, null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>Event name, such as Home game concessions</span><input maxLength={100} value={f.name} onChange={set("name")} /></label>
      <label className="field"><span>Date</span><input type="date" value={f.onDate} onChange={set("onDate")} /></label>
      <label className="field"><span>Where</span><input maxLength={200} value={f.location} onChange={set("location")} /></label>
      <label className="field"><span>What volunteers will do (optional)</span><textarea rows={3} maxLength={2000} value={f.description} onChange={set("description")} /></label>
      <label className="field"><span>Who to contact</span><input maxLength={100} value={f.contactName} onChange={set("contactName")} /></label>
      <label className="field"><span>Their email (optional)</span><input type="email" maxLength={254} value={f.contactEmail} onChange={set("contactEmail")} /></label>
      {initial && <p className="hint">A new date or place is emailed to everyone signed up for the event&apos;s shifts.</p>}
      <Outcome state={state} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Saving…" : label}</button>
    </form>
  );
}

export type ShiftFields = { startsAt: string; endsAt: string; places: number; role: string; requirementIds: string[] };
export type RequirementOption = { id: string; label: string };

/** A shift's times, places, role, and the volunteer requirements it can count toward. */
export function ShiftForm({ initial, requirements, save, label }: { initial?: ShiftFields; requirements: RequirementOption[]; save: (f: ShiftFields) => Promise<Done>; label: string }) {
  const [startsAt, setStartsAt] = useState(initial?.startsAt ?? "");
  const [endsAt, setEndsAt] = useState(initial?.endsAt ?? "");
  const [places, setPlaces] = useState(initial ? String(initial.places) : "");
  const [role, setRole] = useState(initial?.role ?? "");
  const [picked, setPicked] = useState(() => new Set(initial?.requirementIds ?? []));
  const toggle = (id: string) => setPicked((old) => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const [state, run, pending] = useActionState(async () => {
    const r = await safely(() => save({ startsAt, endsAt, places: Number(places), role, requirementIds: [...picked] }), failed);
    if (r.ok && !initial) { setStartsAt(""); setEndsAt(""); setPlaces(""); setRole(""); }
    return r;
  }, null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>Starts at</span><input type="time" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} /></label>
      <label className="field"><span>Ends at (before the start means the next morning)</span><input type="time" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} /></label>
      <label className="field"><span>Places</span><input type="number" min={1} max={500} step={1} value={places} onChange={(e) => setPlaces(e.target.value)} /></label>
      <label className="field"><span>Role (optional), such as concessions</span><input maxLength={60} value={role} onChange={(e) => setRole(e.target.value)} /></label>
      <fieldset className="field checks">
        <legend>Counts toward</legend>
        {requirements.length === 0 ? <p>No season has a volunteering requirement yet. Add one to a season&apos;s step, and it can be chosen here.</p>
          : requirements.map((r) => <label key={r.id}><input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} /> {r.label}</label>)}
      </fieldset>
      {initial && <p className="hint">A new start or end is emailed to everyone signed up for this shift.</p>}
      <Outcome state={state} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Saving…" : label}</button>
    </form>
  );
}

/** A copy of the event on another day, with its shifts. Goes to the copy once it is made. */
export function CopyForm({ copy }: { copy: (onDate: string) => Promise<Done> }) {
  const router = useRouter();
  const [onDate, setOnDate] = useState("");
  const [state, run, pending] = useActionState(async () => {
    const r = await safely(() => copy(onDate), failed);
    if (r.ok && r.eventId) router.push(`/staff/volunteer/${r.eventId}`);
    return r;
  }, null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>Date of the copy</span><input type="date" value={onDate} onChange={(e) => setOnDate(e.target.value)} /></label>
      <Outcome state={state} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Copying…" : "Copy this event"}</button>
    </form>
  );
}

/** How many hours before a shift a guardian can still cancel it themselves. */
export function CutoffForm({ initial, save }: { initial: number; save: (hours: string) => Promise<Done> }) {
  const [hours, setHours] = useState(String(initial));
  // Sent as typed: the server reads it strictly, so a cleared field is refused rather than saved as 0 hours.
  const [state, run, pending] = useActionState(async () => safely(() => save(hours), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>Hours before a shift</span><input type="number" min={0} max={720} step={1} value={hours} onChange={(e) => setHours(e.target.value)} /></label>
      <Outcome state={state} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Saving…" : "Save the cut-off"}</button>
    </form>
  );
}
