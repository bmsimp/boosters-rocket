"use client";
import { startTransition, useActionState, useId, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { Notice } from "@/app/components/notice";
import { Button } from "@/app/components/ui/button";
import { Select, TextInput } from "@/app/components/ui/field";

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
        <p><Button disabled={pending} onClick={() => onOffer(state.offer!)}>Use “{state.offer}”</Button></p>
      )}
    </Notice>
  );
}

/** The kinds of member a new member can be, as a dropdown (a flat club with several member types). */
function MemberTypes({ id, types, type, setType }: { id: string; types: { qboId: string; name: string }[]; type: string; setType: (t: string) => void }) {
  return (
    <Select id={id} label="Kind of member" value={type} onChange={(e) => setType(e.target.value)}>
      <option value="">Choose one</option>
      {types.map((t) => <option key={t.qboId} value={t.qboId}>{t.name}</option>)}
    </Select>
  );
}

/** One name and a button: a new family or member, a new student, or a new name for someone. A free name offered is used with one press. */
export function NameForm({ field, label, pendingLabel, initial = "", act, variant = "secondary" }: { field: string; label: string; pendingLabel: string; initial?: string;
  act: (name: string) => Promise<WriteResult>; variant?: "primary" | "secondary" }) {
  const id = useId();
  const [name, setName] = useState(initial);
  const [state, run, pending] = useActionState(async (_: WriteResult | null, asked: string) => {
    const r = await safely(() => act(asked), failed);
    if (r.ok && initial === "") setName("");
    return r;
  }, null);
  const send = (asked: string) => startTransition(() => run(asked));
  return (
    <form onSubmit={noSubmit} className="stack">
      <TextInput id={`${id}-name`} label={field} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      <Outcome state={state} pending={pending} onOffer={(offer) => { setName(offer); send(offer); }} />
      <Button variant={variant} disabled={pending} onClick={() => send(name)}>{pending ? pendingLabel : label}</Button>
    </form>
  );
}

/**
 * A new member of a flat club, of the member type chosen when the club has several (asked only when it will be made in
 * QuickBooks: `types` is empty otherwise). Saved in the portal first (stage 3's slice 9d).
 */
export function MemberForm({ types, act, pendingLabel }: { types: { qboId: string; name: string }[]; act: (name: string, typeQboId: string | null) => Promise<WriteResult>; pendingLabel: string }) {
  const id = useId();
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
      <TextInput id={`${id}-name`} label="The member's name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
      {types.length > 1 && <MemberTypes id={`${id}-type`} types={types} type={type} setType={setType} />}
      <Outcome state={state} pending={pending} onOffer={(offer) => { setName(offer); send(offer); }} />
      <Button variant="secondary" disabled={pending} onClick={() => send(name)}>{pending ? pendingLabel : "Add the member"}</Button>
    </form>
  );
}

/**
 * "Create in QuickBooks and link" (stage 3's slice 9d): one press, with the member type to choose first when a flat
 * club has several. Given only what it shows; the family's id and the roster tag are bound into its action on the
 * server. After a stop part way the answer stays on screen and the page is made again, so pressing again carries on.
 */
export function CreateAndLinkForm({ types, act }: { types: { qboId: string; name: string }[]; act: (typeQboId: string | null) => Promise<WriteResult> }) {
  const id = useId();
  const [type, setType] = useState(types.length === 1 ? types[0]!.qboId : "");
  const [state, run, pending] = useActionState(async () => safely(() => act(types.length ? type || null : null), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      {types.length > 1 && <MemberTypes id={`${id}-type`} types={types} type={type} setType={setType} />}
      <Outcome state={state} pending={pending} />
      <Button variant="secondary" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Making it in QuickBooks…" : "Create in QuickBooks and link"}</Button>
    </form>
  );
}

/** Another family for a student, chosen from the portal's own active families: the form sends the family's app id (stage 3's slice 9f). */
export function MoveForm({ families, act }: { families: { id: string; name: string }[]; act: (toFamilyId: string) => Promise<WriteResult> }) {
  const id = useId();
  const [to, setTo] = useState("");
  const [state, run, pending] = useActionState(async () => safely(() => act(to), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <Select id={`${id}-to`} label="Move to" value={to} onChange={(e) => setTo(e.target.value)}>
        <option value="">Choose a family</option>
        {families.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </Select>
      <Outcome state={state} pending={pending} />
      <Button variant="secondary" disabled={pending || to === ""} onClick={() => startTransition(() => run())}>{pending ? "Moving them in the portal…" : "Move"}</Button>
    </form>
  );
}

/**
 * Making a family inactive with everyone under it, behind a second press that lists who that covers. Given the names it
 * shows and nothing else. After a stop part way the answer stays on screen, the page is made again, and the list then
 * holds whoever is still active, so pressing again carries on. The second press is the pair a removal takes: a danger
 * button and a quiet way back.
 */
export function FamilyInactiveForm({ familyName, names, act }: { familyName: string; names: string[]; act: () => Promise<WriteResult> }) {
  const [sure, setSure] = useState(false);
  const [state, run, pending] = useActionState(async () => safely(() => act(), failed), null);
  const label = `Make ${familyName} inactive`;
  return (
    <form onSubmit={noSubmit} className="stack">
      {!sure ? <Button variant="secondary" onClick={() => setSure(true)}>{label}</Button> : (
        <>
          {names.length ? (
            <>
              <p>This makes these inactive in QuickBooks, in this order, and {familyName} last:</p>
              <ul className="notice-list">{names.map((n, i) => <li key={`${i}-${n}`}>{n}</li>)}</ul>
            </>
          ) : <p>Nobody under {familyName} is active in QuickBooks, so this makes {familyName} alone inactive.</p>}
          <p>Its parents lose access at once. The portal first asks QuickBooks what each of them owes. If anyone has a balance, owed or a credit, or it can&apos;t be read, nobody is made inactive until it&apos;s settled.</p>
          <Outcome state={state} pending={pending} />
          <div className="row-actions">
            <Button variant="danger" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Making them inactive…" : names.length ? "Yes, make them all inactive" : "Yes, make it inactive"}</Button>
            <Button variant="quiet" disabled={pending} onClick={() => setSure(false)}>Keep it active</Button>
          </div>
        </>
      )}
    </form>
  );
}

/** Making someone inactive, behind a second press that says what follows: a danger button and a quiet way back. */
export function DeactivateForm({ label, warning, act }: { label: string; warning: string; act: () => Promise<WriteResult> }) {
  const [sure, setSure] = useState(false);
  const [state, run, pending] = useActionState(async () => safely(() => act(), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      {!sure ? <Button variant="secondary" onClick={() => setSure(true)}>{label}</Button> : (
        <>
          <p>{warning}</p>
          <Outcome state={state} pending={pending} />
          <div className="row-actions">
            <Button variant="danger" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Making it inactive…" : "Yes, make it inactive"}</Button>
            <Button variant="quiet" disabled={pending} onClick={() => setSure(false)}>Keep it active</Button>
          </div>
        </>
      )}
    </form>
  );
}
