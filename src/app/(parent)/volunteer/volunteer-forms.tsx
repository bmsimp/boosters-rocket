"use client";
import { startTransition, useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "../../components/action-error";

/**
 * The things a parent does on the Volunteer pages: sign someone up for a shift, cancel a sign-up, and check in. Each is given
 * only what it shows: the family's own people and the words for what a place would count toward. The server action is
 * bound to the shift or sign-up on the server, and checks it again against the session's family.
 */
type Result = { ok: true; message: string } | { ok: false; errors: string[] };
const failed: Result = { ok: false, errors: [ACTION_FAILED] };

function Outcome({ state }: { state: Result | null }) {
  if (!state) return null;
  return state.ok ? <p role="status" className="volunteer-done">{state.message}</p> : <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>;
}

export type Choice = { value: string; label: string; taken: boolean; countsToward: { title: string; whoMust: string; counts: string; standing: string }[] };

/** Who will fill the place, each choice with what it would count toward, then the one button that signs them up. */
export function SignUpForm({ choices, act }: { choices: Choice[]; act: (who: string) => Promise<Result> }) {
  const open = choices.filter((c) => !c.taken);
  const [who, setWho] = useState(open[0]?.value ?? "");
  const [state, run, pending] = useActionState(async () => safely(() => act(who), failed), null);
  if (state?.ok) return <Outcome state={state} />;
  if (open.length === 0) return <p>Everyone in your family who could take a place here has one already.</p>;
  const chosen = choices.find((c) => c.value === who);
  return (
    <form onSubmit={(e) => { e.preventDefault(); startTransition(() => run()); }}>
      <fieldset className="setting">
        <legend>Who will do this shift?</legend>
        <p className="hint">Students don&apos;t sign in. You sign them up here.</p>
        <div className="choices" style={{ ["--cols" as string]: 1 }}>
          {choices.map((c) => (
            <label className="choice" key={c.value}>
              <input type="radio" name="who" value={c.value} checked={who === c.value} disabled={c.taken} onChange={() => setWho(c.value)} />
              <span>
                <b>{c.label}{c.taken ? " (signed up already)" : ""}</b>
                <small>{c.countsToward.length === 0 ? "This shift doesn't count toward anything the club asks of your family this season."
                  : c.countsToward.map((t) => `Counts as ${t.counts} toward ${t.title}. ${t.whoMust}. ${t.standing}.`).join(" ")}</small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <Outcome state={state} />
      <button className="btn volunteer-confirm" disabled={pending || !chosen || chosen.taken}>
        {pending ? "Signing up…" : chosen?.value === "me" ? "Sign me up" : `Sign up ${chosen?.label ?? ""}`}
      </button>
    </form>
  );
}

/** Cancel a sign-up, asked twice so a slip of the thumb doesn't give the place away. */
export function CancelSignup({ label, act }: { label: string; act: () => Promise<Result> }) {
  const [asking, setAsking] = useState(false);
  const [state, run, pending] = useActionState(async () => safely(() => act(), failed), null);
  if (state?.ok) return <Outcome state={state} />;
  return (
    <div className="row-actions volunteer-cancel">
      {!asking ? <button type="button" className="btn btn-line" onClick={() => setAsking(true)}>{label}</button> : (
        <>
          <button type="button" className="btn btn-line" disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Cancelling…" : "Yes, cancel it"}</button>
          <button type="button" className="btn btn-line" disabled={pending} onClick={() => setAsking(false)}>Keep it</button>
        </>
      )}
      <Outcome state={state} />
    </div>
  );
}

/** One press checks someone in (or everyone, with `wide`). The action is bound to the code and the sign-up on the server, and checks both again. */
export function CheckInButton({ label, act, wide }: { label: string; act: () => Promise<Result>; wide?: boolean }) {
  const [state, run, pending] = useActionState(async () => safely(() => act(), failed), null);
  if (state?.ok) return <Outcome state={state} />;
  return (
    <div className={wide ? "checkin-all" : "checkin-one"}>
      <button type="button" className={wide ? "btn volunteer-confirm" : "btn btn-club pay"} disabled={pending} onClick={() => startTransition(() => run())}>{pending ? "Checking in…" : label}</button>
      <Outcome state={state} />
    </div>
  );
}
