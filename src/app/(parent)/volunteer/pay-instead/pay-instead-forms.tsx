"use client";
import Link from "next/link";
import { startTransition, useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "../../../components/action-error";

/**
 * The two things a guardian does on the pay-instead page: confirm a buy-out, and switch back to volunteering. Each is
 * given only what it shows: its label. The server action is bound on the server to the requirement, the choice key and
 * the quote's stamp, and checks all of them again against the session's family.
 */
type Result = { ok: true; message: string } | { ok: false; errors: string[] };
const failed: Result = { ok: false, errors: [ACTION_FAILED] };

function Outcome({ state }: { state: Result | null }) {
  if (!state) return null;
  return state.ok
    ? <div role="status" className="volunteer-done"><p>{state.message}</p><p className="buyout-next"><Link href="/payments">Go to Payments</Link> · <Link href="/volunteer">Back to Volunteer</Link></p></div>
    : <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>;
}

/** The one button that asks for the invoice. Pressed once: the page already said what it does. */
export function ConfirmBuyout({ label, act }: { label: string; act: () => Promise<Result> }) {
  const [state, run, pending] = useActionState(async () => safely(() => act(), failed), null);
  if (state?.ok) return <Outcome state={state} />;
  return (
    <div>
      <Outcome state={state} />
      <button type="button" className="btn volunteer-confirm" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Setting it up…" : label}</button>
    </div>
  );
}

/** "Volunteer instead", asked twice so a slip of the thumb doesn't cancel the invoice. */
export function SwitchBack({ act }: { act: () => Promise<Result> }) {
  const [asking, setAsking] = useState(false);
  const [state, run, pending] = useActionState(async () => safely(() => act(), failed), null);
  if (state?.ok) return <Outcome state={state} />;
  return (
    <div className="row-actions volunteer-cancel">
      {!asking ? <button type="button" className="btn btn-line" onClick={() => setAsking(true)}>Volunteer instead</button> : (
        <>
          <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Cancelling the invoice…" : "Yes, cancel the invoice"}</button>
          <button type="button" className="btn btn-line" disabled={pending} onClick={() => setAsking(false)}>Keep paying instead</button>
        </>
      )}
      <Outcome state={state} />
    </div>
  );
}
