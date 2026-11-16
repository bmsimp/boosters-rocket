"use client";
import { startTransition, useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";

// The forms that change the roster in QuickBooks. As on the season pages, no form `action` on a form with a field: React
// resets a form after one, and what was typed would vanish on a refusal. Each is given only what it shows, and the
// action it calls has the ids and the version bound in on the server.

/** What a roster write answers (src/lib/roster/writes.ts): a free name to offer when the one asked for is taken, or the record as QuickBooks has it now. */
export type WriteResult =
  | { ok: true; message: string; queued?: true }
  | { ok: false; errors: string[]; offer?: string; current?: { name: string; active: boolean; familyName: string | null } };
const failed: WriteResult = { ok: false, errors: [ACTION_FAILED] };
const noSubmit = (e: { preventDefault: () => void }) => e.preventDefault();

function Outcome({ state, onOffer, pending }: { state: WriteResult | null; onOffer?: (name: string) => void; pending: boolean }) {
  if (!state) return null;
  if (state.ok) return <p role="status">{state.message}</p>;
  return (
    <div role="alert" className="stack">
      <ul className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>
      {state.current && (
        <p>Now in QuickBooks: {state.current.name}{state.current.familyName ? `, in ${state.current.familyName}` : ""}{state.current.active ? "" : ", inactive"}.</p>
      )}
      {state.offer && onOffer && (
        <button type="button" className="btn" disabled={pending} onClick={() => onOffer(state.offer!)}>Use “{state.offer}”</button>
      )}
    </div>
  );
}

/** One name and a button: a new family or member, a new student, or a new name for someone. A free name offered is used with one press. */
export function NameForm({ field, label, pendingLabel, initial = "", act }: { field: string; label: string; pendingLabel: string; initial?: string; act: (name: string) => Promise<WriteResult> }) {
  const [name, setName] = useState(initial);
  const [state, run, pending] = useActionState(async (_: WriteResult | null, asked: string) => {
    const r = await safely(() => act(asked), failed);
    if (r.ok && initial === "") setName("");
    return r;
  }, null);
  const send = (asked: string) => startTransition(() => run(asked));
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>{field}</span><input maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <Outcome state={state} pending={pending} onOffer={(offer) => { setName(offer); send(offer); }} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => send(name)}>{pending ? pendingLabel : label}</button>
    </form>
  );
}

/** A new member of a flat club, of the member type chosen when the club has several. */
export function MemberForm({ types, act }: { types: { qboId: string; name: string }[]; act: (name: string, typeQboId: string | null) => Promise<WriteResult> }) {
  const [name, setName] = useState("");
  const [type, setType] = useState(types.length === 1 ? types[0]!.qboId : "");
  const [state, run, pending] = useActionState(async (_: WriteResult | null, asked: string) => {
    const r = await safely(() => act(asked, type || null), failed);
    if (r.ok) setName("");
    return r;
  }, null);
  const send = (asked: string) => startTransition(() => run(asked));
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>The member&apos;s name, as QuickBooks will show it</span><input maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
      {types.length > 1 && (
        <label className="field"><span>Kind of member</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Choose one</option>
            {types.map((t) => <option key={t.qboId} value={t.qboId}>{t.name}</option>)}
          </select></label>
      )}
      <Outcome state={state} pending={pending} onOffer={(offer) => { setName(offer); send(offer); }} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => send(name)}>{pending ? "Making it in QuickBooks…" : "Make the member"}</button>
    </form>
  );
}

/** A new parent: their name, and their own email address, which they sign in with. */
export function ParentForm({ act }: { act: (name: string, email: string) => Promise<WriteResult> }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [state, run, pending] = useActionState(async (_: WriteResult | null, asked: string) => {
    const r = await safely(() => act(asked, email), failed);
    if (r.ok) { setName(""); setEmail(""); }
    return r;
  }, null);
  const send = (asked: string) => startTransition(() => run(asked));
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>The parent&apos;s name, as QuickBooks will show it</span><input maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>Their own email address (they sign in with it)</span><input type="email" maxLength={100} autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <Outcome state={state} pending={pending} onOffer={(offer) => { setName(offer); send(offer); }} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => send(name)}>{pending ? "Adding in QuickBooks…" : "Add the parent"}</button>
    </form>
  );
}

/** Another family for a student, chosen from the roster's active families. */
export function MoveForm({ families, act }: { families: { qboId: string; name: string }[]; act: (toFamilyQboId: string) => Promise<WriteResult> }) {
  const [to, setTo] = useState("");
  const [state, run, pending] = useActionState(async () => safely(() => act(to), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>Move to</span>
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Choose a family</option>
          {families.map((f) => <option key={f.qboId} value={f.qboId}>{f.name}</option>)}
        </select></label>
      <Outcome state={state} pending={pending} />
      <button type="button" className="btn btn-line" disabled={pending || to === ""} onClick={() => startTransition(() => run())}>{pending ? "Moving in QuickBooks…" : "Move"}</button>
    </form>
  );
}

/** Making someone inactive, behind a second press that says what follows. */
export function DeactivateForm({ label, warning, act }: { label: string; warning: string; act: () => Promise<WriteResult> }) {
  const [sure, setSure] = useState(false);
  const [state, run, pending] = useActionState(async () => safely(() => act(), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      {!sure ? <button type="button" className="btn btn-line" onClick={() => setSure(true)}>{label}</button> : (
        <>
          <p>{warning}</p>
          <Outcome state={state} pending={pending} />
          <div className="row-actions">
            <button type="button" className="btn" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Making it inactive…" : "Yes, make it inactive"}</button>
            <button type="button" className="btn btn-line" disabled={pending} onClick={() => setSure(false)}>Keep it active</button>
          </div>
        </>
      )}
    </form>
  );
}
