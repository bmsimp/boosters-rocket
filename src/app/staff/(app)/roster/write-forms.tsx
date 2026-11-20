"use client";
import { startTransition, useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { Notice } from "@/app/components/notice";

// The forms that change the roster in QuickBooks. As on the season pages, no form `action` on a form with a field: React
// resets a form after one, and what was typed would vanish on a refusal. Each is given only what it shows, and the
// action it calls has the ids and the version bound in on the server.

/** What a roster write answers (src/lib/roster/writes.ts): a free name to offer when the one asked for is taken, or the record as QuickBooks has it now. */
export type WriteResult =
  | { ok: true; message: string; queued?: true; unlinked?: true; status?: "waiting" | "attention" }
  | { ok: false; errors: string[]; offer?: string; current?: { name: string; active: boolean; familyName: string | null } };
const failed: WriteResult = { ok: false, errors: [ACTION_FAILED] };
const noSubmit = (e: { preventDefault: () => void }) => e.preventDefault();

function Outcome({ state, onOffer, pending }: { state: WriteResult | null; onOffer?: (name: string) => void; pending: boolean }) {
  if (!state) return null;
  // `unlinked`: saved in the portal, but not (or not yet) in QuickBooks: the words say why, and what to do next.
  // `status`, a change saved first: "Done" only when the portal and QuickBooks both hold it (ActionOutcome()'s rule).
  if (state.ok) {
    const tone = state.unlinked || state.status === "attention" ? "warning" : state.queued || state.status === "waiting" ? "info" : "done";
    return <Notice tone={tone}>{state.message}</Notice>;
  }
  return (
    <Notice tone="problem">
      {state.errors.length === 1 ? state.errors[0] : <ul className="notice-list">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {state.current && (
        <p>Now in QuickBooks: {state.current.name}{state.current.familyName ? `, in ${state.current.familyName}` : ""}{state.current.active ? "" : ", inactive"}.</p>
      )}
      {state.offer && onOffer && (
        <p><button type="button" className="btn" disabled={pending} onClick={() => onOffer(state.offer!)}>Use “{state.offer}”</button></p>
      )}
    </Notice>
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

/**
 * A new member of a flat club, of the member type chosen when the club has several (asked only when it will be made in
 * QuickBooks: `types` is empty otherwise). Saved in the portal first (stage 3's slice 9d).
 */
export function MemberForm({ types, act, pendingLabel }: { types: { qboId: string; name: string }[]; act: (name: string, typeQboId: string | null) => Promise<WriteResult>; pendingLabel: string }) {
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
      <label className="field"><span>The member&apos;s name</span><input maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
      {types.length > 1 && (
        <label className="field"><span>Kind of member</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Choose one</option>
            {types.map((t) => <option key={t.qboId} value={t.qboId}>{t.name}</option>)}
          </select></label>
      )}
      <Outcome state={state} pending={pending} onOffer={(offer) => { setName(offer); send(offer); }} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => send(name)}>{pending ? pendingLabel : "Add the member"}</button>
    </form>
  );
}

/**
 * "Create in QuickBooks and link" (stage 3's slice 9d): one press, with the member type to choose first when a flat
 * club has several. Given only what it shows; the family's id and the roster tag are bound into its action on the
 * server. After a stop part way the answer stays on screen and the page is made again, so pressing again carries on.
 */
export function CreateAndLinkForm({ types, act }: { types: { qboId: string; name: string }[]; act: (typeQboId: string | null) => Promise<WriteResult> }) {
  const [type, setType] = useState(types.length === 1 ? types[0]!.qboId : "");
  const [state, run, pending] = useActionState(async () => safely(() => act(types.length ? type || null : null), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      {types.length > 1 && (
        <label className="field"><span>Kind of member</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Choose one</option>
            {types.map((t) => <option key={t.qboId} value={t.qboId}>{t.name}</option>)}
          </select></label>
      )}
      <Outcome state={state} pending={pending} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Making it in QuickBooks…" : "Create in QuickBooks and link"}</button>
    </form>
  );
}

/** A new parent: their name, and their own email address, kept on their QuickBooks record (it gives them no sign-in). */
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
      <label className="field"><span>Their own email address</span><input type="email" maxLength={100} autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <Outcome state={state} pending={pending} onOffer={(offer) => { setName(offer); send(offer); }} />
      <button type="button" className="btn btn-line" disabled={pending} onClick={() => send(name)}>{pending ? "Adding in QuickBooks…" : "Add the parent"}</button>
    </form>
  );
}

/** Another family for a student, chosen from the portal's own active families: the form sends the family's app id (stage 3's slice 9f). */
export function MoveForm({ families, act }: { families: { id: string; name: string }[]; act: (toFamilyId: string) => Promise<WriteResult> }) {
  const [to, setTo] = useState("");
  const [state, run, pending] = useActionState(async () => safely(() => act(to), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <label className="field"><span>Move to</span>
        <select value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">Choose a family</option>
          {families.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select></label>
      <Outcome state={state} pending={pending} />
      <button type="button" className="btn btn-line" disabled={pending || to === ""} onClick={() => startTransition(() => run())}>{pending ? "Moving them in the portal…" : "Move"}</button>
    </form>
  );
}

/**
 * Making a family inactive with everyone under it, behind a second press that lists who that covers. Given the names it
 * shows and nothing else. After a stop part way the answer stays on screen, the page is made again, and the list then
 * holds whoever is still active, so pressing again carries on.
 */
export function FamilyInactiveForm({ familyName, names, act }: { familyName: string; names: string[]; act: () => Promise<WriteResult> }) {
  const [sure, setSure] = useState(false);
  const [state, run, pending] = useActionState(async () => safely(() => act(), failed), null);
  const label = `Make ${familyName} inactive`;
  return (
    <form onSubmit={noSubmit} className="stack">
      {!sure ? <button type="button" className="btn btn-line" onClick={() => setSure(true)}>{label}</button> : (
        <>
          {names.length ? (
            <>
              <p>This makes these inactive in QuickBooks, in this order, and {familyName} last:</p>
              <ul className="notice-list">{names.map((n, i) => <li key={`${i}-${n}`}>{n}</li>)}</ul>
            </>
          ) : <p>Nobody under {familyName} is active in QuickBooks, so this makes {familyName} alone inactive.</p>}
          <p>Its parents lose access to the portal at once. Before anything is changed, the portal asks QuickBooks what each of them owes: if anyone has a balance, owed or a credit, or the portal can&apos;t read it, nobody is made inactive until it is settled in QuickBooks.</p>
          <Outcome state={state} pending={pending} />
          <div className="row-actions">
            <button type="button" className="btn" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Making them inactive…" : names.length ? "Yes, make them all inactive" : "Yes, make it inactive"}</button>
            <button type="button" className="btn btn-line" disabled={pending} onClick={() => setSure(false)}>Keep it active</button>
          </div>
        </>
      )}
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
