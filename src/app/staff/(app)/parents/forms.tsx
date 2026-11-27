"use client";
import Link from "next/link";
import { startTransition, useActionState, useEffect, useId, useRef, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { ActionOutcome, Notice } from "@/app/components/notice";
import { Button } from "@/app/components/ui/button";
import { ConfirmDialog } from "@/app/components/ui/sheet";
import { Checkbox, TextArea, TextInput } from "@/app/components/ui/field";
import { CONTACT_FIELDS, type ContactForm, type ContactValues } from "@/lib/parents/contact-fields";

// No form `action` on the forms with a text field: React resets a form after one, and the note would vanish on a
// refusal. State is the source of truth; a type="button" calls the action inside startTransition (see
// settings/quickbooks/forms.tsx).
type Done = { ok: true; message: string; status?: "waiting" | "attention" } | { ok: false; errors: string[] };
const failed: Done = { ok: false, errors: [ACTION_FAILED] };
const noSubmit = (e: { preventDefault: () => void }) => e.preventDefault();
function Outcome({ state }: { state: Done | null }) {
  if (!state) return null;
  return <ActionOutcome state={state} />;
}

/** A text field and one button: used to block a person (`variant="danger"`: it takes their sign-in away). */
export function NoteAction({ label, field, pendingLabel, act, variant = "outlined" }: { label: string; field: string; pendingLabel: string; act: (text: string) => Promise<Done>;
  variant?: "outlined" | "danger" }) {
  const id = useId();
  const [text, setText] = useState("");
  const [state, run, pending] = useActionState(async () => safely(() => act(text), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <TextArea id={`${id}-note`} label={field} rows={2} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} />
      <Outcome state={state} />
      <Button variant={variant} disabled={pending} onClick={() => startTransition(() => run())}>{pending ? pendingLabel : label}</Button>
    </form>
  );
}

/**
 * An Admin's reset of a parent's sign-in (the sign-in release, slice SI-9a): the call-back box, required, the reason
 * (staff only) and one press. Given only the bound action: no id, address or count. The server refuses an unticked box
 * or an empty reason in words, so the button is never held back for them. After a reset the box and the reason are
 * emptied, so a second press needs both again.
 */
export function ResetSigninForm({ act }: { act: (reason: string, calledBack: boolean) => Promise<Done> }) {
  const id = useId();
  const [calledBack, setCalledBack] = useState(false);
  const [reason, setReason] = useState("");
  const [state, run, pending] = useActionState(async () => {
    const r = await safely(() => act(reason, calledBack), failed);
    if (r.ok) { setCalledBack(false); setReason(""); }
    return r;
  }, null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <fieldset className="checks"><legend>Before you reset</legend>
        <Checkbox id={`${id}-called`} required checked={calledBack} onChange={(e) => setCalledBack(e.target.checked)}
          label=" I called them back on a number the club already holds, and they asked for this" />
      </fieldset>
      <TextArea id={`${id}-reason`} label="Why? (staff only)" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      <Outcome state={state} />
      <Button variant="danger" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Resetting…" : "Reset sign-in"}</Button>
    </form>
  );
}

/** One button, nothing to type: a plain form action is fine here. */
export function OneButton({ label, pendingLabel, act }: { label: string; pendingLabel: string; act: () => Promise<Done> }) {
  const [state, run, pending] = useActionState(async () => safely(() => act(), failed), null);
  return (
    <form action={run} className="stack">
      <Outcome state={state} />
      <Button type="submit" variant="outlined" disabled={pending}>{pending ? pendingLabel : label}</Button>
    </form>
  );
}

/**
 * Remove or reinstate one guardian row (./guardian-change.tsx). One component for both, kept mounted across the change
 * (the row's key is its guardian row's id), so the answer stays on the page when the action's refresh swaps Remove for
 * Reinstate or back, and the focus, whose button is gone, moves to that answer.
 */
export function GuardianChangeControls({ name, removeLabel, open, reinstatable, remove, reinstate }: {
  name: string; removeLabel: string; open: boolean; reinstatable: boolean; remove: (note: string) => Promise<Done>; reinstate: () => Promise<Done>;
}) {
  const [removed, setRemoved] = useState<Done | null>(null);
  const [state, run, pending] = useActionState(async () => safely(reinstate, failed), null);
  const answer = state ?? removed;
  const said = useRef<HTMLDivElement>(null);
  // Once the row's change is drawn (Remove's button gone with its dialog), the focus is put on the answer.
  useEffect(() => { if (answer?.ok) said.current?.focus(); }, [answer, open]);
  if (!answer && !open && !reinstatable) return null;
  return (
    <div className="stack row-change">
      {/* A remove's answer is kept here, so it outlives the dialog, which goes when the row can no longer be removed. */}
      {answer ? <ActionOutcome state={answer} ref={said} /> : null}
      {open ? (
        <ConfirmDialog label={removeLabel} confirmLabel="Remove" busyLabel="Removing…" size="sm" answerHere={false}
          consequence="They can't sign in to this family any more and are signed out of it at once, and forms waiting for their signature start again."
          reason={{ label: "Why? (staff only)", maxLength: 500 }}
          act={async (note) => { const r = await safely(() => remove(note ?? ""), failed); if (r.ok) setRemoved(r); return r; }} />
      ) : reinstatable ? (
        <form action={() => run()} className="stack">
          <Button type="submit" variant="outlined" disabled={pending}>{pending ? "Reinstating…" : `Reinstate ${name}`}</Button>
        </form>
      ) : null}
    </div>
  );
}

/** An add's answer: done, refused, or a question (the address belongs to a person already: `samePerson` is who). */
type AddDone = Done | { ok: false; errors: string[]; samePerson: string };

/**
 * Add a guardian to a family: a name and an email address, sent to the action as typed (the server checks both). After
 * an add the fields are emptied, so a second guardian can be typed in; after a refusal they stay as they were. An
 * address that belongs to a person already is answered with who that is and nothing changed; "Yes, add them" sends
 * that person's id back with the same address, and is offered only while the address is the one asked about.
 */
export function AddGuardianForm({ act }: { act: (name: string, email: string, samePerson: string | null) => Promise<AddDone> }) {
  const id = useId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [asked, setAsked] = useState<{ email: string; parentId: string } | null>(null);
  const [state, run, pending] = useActionState(async (_: AddDone | null, confirm: boolean) => {
    const same = confirm && asked && asked.email === email ? asked.parentId : null;
    const r = await safely(() => act(name, email, same), failed as AddDone);
    if (r.ok) { setName(""); setEmail(""); }
    setAsked(!r.ok && "samePerson" in r ? { email, parentId: r.samePerson } : null);
    return r;
  }, null);
  const question = state && !state.ok && "samePerson" in state ? state : null;
  const asking = question !== null && asked !== null && asked.email === email;
  return (
    <form onSubmit={noSubmit} className="stack">
      <TextInput id={`${id}-name`} label="Name" maxLength={100} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
      <TextInput id={`${id}-email`} label="Email address they sign in with" type="email" maxLength={320} autoComplete="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} />
      {question ? (asking ? <Notice tone="warning">{question.errors[0]}</Notice> : null) : <Outcome state={state} />}
      {/* One primary at a time: while the portal asks whether it is the same person, "Yes, add them" is it. */}
      {asking ? <Button disabled={pending} onClick={() => startTransition(() => run(true))}>{pending ? "Adding…" : "Yes, add them"}</Button> : null}
      <Button variant={asking ? "outlined" : "filled"} disabled={pending} onClick={() => startTransition(() => run(false))}>{pending ? "Adding…" : "Add guardian"}</Button>
    </form>
  );
}

/** A person's name, changed in the portal: the field starts from the name they have. */
export function NameForm({ name: current, act }: { name: string; act: (name: string) => Promise<Done> }) {
  const id = useId();
  const [name, setName] = useState(current);
  const [state, run, pending] = useActionState(async () => safely(() => act(name), failed), null);
  return (
    <form onSubmit={noSubmit} className="stack">
      <TextInput id={`${id}-name`} label="Name" maxLength={100} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
      <Outcome state={state} />
      <Button variant="outlined" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Saving…" : "Save name"}</Button>
    </form>
  );
}

/** What a staff save of a guardian's phone and mailing address answers (the person's page, and a family's page in books with no parent type). */
export type DetailsDone = { ok: true; message: string; status?: "waiting" | "attention"; current: ContactForm; compare: string[] } | { ok: false; errors: string[]; current?: ContactForm };
const detailsFailed: DetailsDone = { ok: false, errors: [ACTION_FAILED] };

/**
 * A guardian's phone and mailing address as the portal holds them, changed by staff (stage 3's slice 11c): the seven
 * fields and the version they were read at, which goes back with the save so a change saved meanwhile (by the parent, or
 * someone else here) is noticed and not overwritten. Given only those: whose details they are is bound into `act` on the
 * server. After an answer that brings the details as they stand (saved, or changed meanwhile), the fields show those;
 * otherwise what was typed stays. A kept change's compare view is linked for a reader who may open it (`compare`).
 */
export function DetailsForm({ initial, act }: { initial: ContactForm; act: (sent: Record<string, string>) => Promise<DetailsDone> }) {
  const id = useId();
  const [shown, setShown] = useState(initial);
  const [values, setValues] = useState<ContactValues>(initial.values);
  const [state, run, pending] = useActionState(async () => {
    const r = await safely(() => act({ ...values, version: shown.version }), detailsFailed);
    if (r.current) { setShown(r.current); setValues(r.current.values); }
    return r;
  }, null);
  return (
    <form onSubmit={noSubmit} className="stack">
      {CONTACT_FIELDS.map(({ name, label, max }) => (
        <TextInput key={name} id={`${id}-${name}`} label={label} type={name === "phone" ? "tel" : "text"} maxLength={max} autoComplete="off" value={values[name]}
          onChange={(e) => setValues({ ...values, [name]: e.target.value })} />
      ))}
      <Outcome state={state} />
      {state?.ok && state.compare.map((c) => (
        <Link key={c} className="link-line" href={`/staff/reconciliation?compare=${c}#writes-h`}>Compare the two on the Reconciliation page</Link>
      ))}
      <Button variant="outlined" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Saving, then sending to QuickBooks…" : "Save details"}</Button>
    </form>
  );
}

/**
 * "Let its guardians sign in", on a family's page, for staff with `Roster.Family.ReadWrite` (stage 4's slice M4b): one
 * press, given only the bound action (releaseSigninHoldAction(), which carries the family's id), and its answer.
 */
export function ReleaseHoldControl({ release }: { release: () => Promise<Done> }) {
  const [state, run, pending] = useActionState(async () => safely(() => release(), failed), null);
  const said = useRef<HTMLDivElement>(null);
  useEffect(() => { if (state?.ok) said.current?.focus(); }, [state]);
  return (
    <div className="stack">
      {state ? <ActionOutcome state={state} ref={said} /> : null}
      {state?.ok ? null : (
        <form action={run} className="row-actions">
          <Button type="submit" disabled={pending}>{pending ? "Letting them in…" : "Let its guardians sign in"}</Button>
        </form>
      )}
    </div>
  );
}
