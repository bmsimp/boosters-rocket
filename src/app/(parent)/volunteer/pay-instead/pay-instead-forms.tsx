"use client";
import Link from "next/link";
import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { ACTION_FAILED, safely } from "../../../components/action-error";
import { useSay } from "../../announce";

/**
 * The two things a guardian does on the pay-instead page: confirm a buy-out, and switch back to volunteering. Each is
 * given only what it shows: its label. The server action is bound on the server to the requirement, the choice key and
 * the quote's stamp, and checks all of them again against the session's family. A confirm or a switch-back that works
 * redraws the page into another section, without this button, so the words that say so go to the page's Announcer,
 * which stays, says them and takes the focus. Busy buttons are aria-disabled, never disabled: a disabled button drops
 * the focus, and the keyboard's place with it.
 */
type Result = { ok: true; message: string } | { ok: false; errors: string[] };
const failed: Result = { ok: false, errors: [ACTION_FAILED] };

function Outcome({ state }: { state: Result | null }) {
  if (!state) return null;
  return state.ok
    ? <div role="status" className="volunteer-done"><p>{state.message}</p><p className="buyout-next"><Link href="/payments">Go to Payments</Link> · <Link href="/volunteer">Back to Volunteer</Link></p></div>
    : <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>;
}

/** Runs the action once at a time, and tells the page's Announcer what a success says. */
function useAct(act: () => Promise<Result>) {
  const say = useSay();
  const [state, run, pending] = useActionState(async () => {
    const r = await safely(() => act(), failed);
    if (r.ok) say?.(r.message);
    return r;
  }, null);
  return { say, state, pending, press: () => { if (!pending) startTransition(() => run()); } };
}

/** The one button that asks for the invoice. Pressed once: the page already said what it does. */
export function ConfirmBuyout({ label, act }: { label: string; act: () => Promise<Result> }) {
  const { say, state, pending, press } = useAct(act);
  if (state?.ok) return say ? null : <Outcome state={state} />;
  return (
    <div>
      <Outcome state={state} />
      <button type="button" className="btn volunteer-confirm" aria-disabled={pending || undefined} onClick={press}>{pending ? "Setting it up…" : label}</button>
    </div>
  );
}

/**
 * "Volunteer instead", asked twice so a slip of the thumb doesn't cancel the invoice. The question takes the focus on
 * "Keep paying instead", the choice that changes nothing, inside a group named for what is asked; that button gives
 * the focus back to the one that asked.
 */
export function SwitchBack({ act }: { act: () => Promise<Result> }) {
  const [asking, setAsking] = useState(false);
  const moved = useRef(false);
  const ask = useRef<HTMLButtonElement>(null), keep = useRef<HTMLButtonElement>(null);
  const { say, state, pending, press } = useAct(act);
  useEffect(() => {
    if (!moved.current) return; // not on the first drawing: the focus moves only when the guardian asked or answered
    (asking ? keep : ask).current?.focus();
  }, [asking]);
  const toggle = (next: boolean) => { moved.current = true; setAsking(next); };
  if (state?.ok) return say ? null : <Outcome state={state} />;
  return (
    <div className="row-actions volunteer-cancel">
      {!asking ? <button ref={ask} type="button" className="btn btn-line" onClick={() => toggle(true)}>Volunteer instead</button> : (
        <div className="row-actions" role="group" aria-label="Volunteer instead?">
          <button type="button" className="btn btn-line" aria-disabled={pending || undefined} onClick={press}>{pending ? "Cancelling the invoice…" : "Yes, cancel the invoice"}</button>
          <button ref={keep} type="button" className="btn btn-line" aria-disabled={pending || undefined} onClick={() => { if (!pending) toggle(false); }}>Keep paying instead</button>
        </div>
      )}
      <Outcome state={state} />
    </div>
  );
}
