"use client";
import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { ACTION_FAILED, safely } from "../../components/action-error";
import { useSay } from "../announce";
import { ActionOutcome, Button, ChoiceGroup, Notice } from "../../components/ui";

/**
 * The things a parent does on the Volunteer pages: sign someone up for a shift, cancel a sign-up, and check in. Each is given
 * only what it shows: the family's own people and the words for what a place would count toward. The server action is
 * bound to the shift or sign-up on the server, and checks it again against the session's family.
 */
type Result = { ok: true; message: string } | { ok: false; errors: string[] };
const failed: Result = { ok: false, errors: [ACTION_FAILED] };

function Outcome({ state }: { state: Result | null }) {
  if (!state) return null;
  return state.ok ? <Done message={state.message} /> : <ActionOutcome state={state} />;
}

/** The words for a thing done, in place of the form that did it: they take the focus, which the form's button had. */
function Done({ message }: { message: string }) {
  const line = useRef<HTMLDivElement>(null);
  useEffect(() => { line.current?.focus(); }, []);
  return <Notice tone="done" ref={line} tabIndex={-1}>{message}</Notice>;
}

const COUNTS_NOTHING = "This shift doesn't count toward anything the club asks of your family this season.";

export type Choice = { value: string; label: string; taken: boolean; countsToward: { title: string; whoMust: string; counts: string; standing: string }[] };

/** Who will fill the place, each choice with what it would count toward, then the one button that signs them up. */
export function SignUpForm({ choices, act }: { choices: Choice[]; act: (who: string) => Promise<Result> }) {
  const open = choices.filter((c) => !c.taken);
  const [who, setWho] = useState(open[0]?.value ?? "");
  const [state, run, pending] = useActionState(async () => safely(() => act(who), failed), null);
  if (state?.ok) return <Outcome state={state} />;
  if (open.length === 0) return <p>Everyone in your family who could take a place here has one already.</p>;
  const chosen = choices.find((c) => c.value === who);
  const countsNothing = choices.every((c) => c.countsToward.length === 0);
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!pending) startTransition(() => run()); }}>
      {/* When the shift counts toward nothing for anyone, that is said once, under the question, not on every tile. */}
      <ChoiceGroup name="who" legend="Who will do this shift?" value={who} onChange={setWho} cols={1}
        hint={countsNothing ? `Students don't sign in. You sign them up here. ${COUNTS_NOTHING}` : "Students don't sign in. You sign them up here."}
        options={choices.map((c) => ({
          value: c.value, label: `${c.label}${c.taken ? " (signed up already)" : ""}`, disabled: c.taken,
          hint: countsNothing ? undefined : c.countsToward.length === 0 ? COUNTS_NOTHING
            : c.countsToward.map((t) => `Counts as ${t.counts} toward ${t.title}. ${t.whoMust}. ${t.standing}.`).join(" "),
        }))} />
      <Outcome state={state} />
      {/* Busy is aria-disabled, not disabled: a disabled button drops the focus, and the keyboard's place with it. */}
      <Button type="submit" className="volunteer-confirm" disabled={!chosen || chosen.taken} busy={pending}>
        {pending ? "Signing up…" : chosen?.value === "me" ? "Sign me up" : `Sign up ${chosen?.label ?? ""}`}
      </Button>
    </form>
  );
}

/**
 * Cancel a sign-up, asked twice so a slip of the thumb doesn't give the place away. The question takes the focus on
 * "Keep it", the choice that changes nothing, inside a group named for what is asked; "Keep it" gives the focus back
 * to the button that asked. A cancelled place leaves the list, and this with it, so the words that say so go to the
 * box's Announcer, which stays.
 */
export function CancelSignup({ label, act }: { label: string; act: () => Promise<Result> }) {
  const say = useSay();
  const [asking, setAsking] = useState(false);
  const moved = useRef(false);
  const ask = useRef<HTMLButtonElement>(null), keep = useRef<HTMLButtonElement>(null);
  const [state, run, pending] = useActionState(async () => {
    const r = await safely(() => act(), failed);
    if (r.ok) say?.(r.message);
    return r;
  }, null);
  useEffect(() => {
    if (!moved.current) return; // not on the first drawing: the focus moves only when the parent asked or answered
    (asking ? keep : ask).current?.focus();
  }, [asking]);
  const toggle = (next: boolean) => { moved.current = true; setAsking(next); };
  if (state?.ok) return say ? null : <Outcome state={state} />;
  return (
    <div className="row-actions volunteer-cancel">
      {!asking ? <Button ref={ask} size="sm" variant="tonal" onClick={() => toggle(true)}>{label}</Button> : (
        <div className="row-actions" role="group" aria-label={`${label}?`}>
          <Button size="sm" variant="danger" busy={pending} onClick={() => { if (!pending) startTransition(() => run()); }}>{pending ? "Cancelling…" : "Yes, cancel it"}</Button>
          <Button ref={keep} size="sm" variant="text" aria-disabled={pending || undefined} onClick={() => { if (!pending) toggle(false); }}>Keep it</Button>
        </div>
      )}
      <Outcome state={state} />
    </div>
  );
}

/**
 * One press checks someone in (or everyone, with `wide`). The action is bound to the code and the sign-up on the server,
 * and checks both again. The page is drawn again without this button once the person reads "Checked in", so the words
 * that say so go to the box's Announcer, which stays.
 */
export function CheckInButton({ label, act, wide, variant = "filled" }: { label: string; act: () => Promise<Result>; wide?: boolean; variant?: "filled" | "tonal" }) {
  const say = useSay();
  const [state, run, pending] = useActionState(async () => {
    const r = await safely(() => act(), failed);
    if (r.ok) say?.(r.message);
    return r;
  }, null);
  if (state?.ok) return say ? null : <Outcome state={state} />;
  return (
    <div className={wide ? "checkin-all" : "checkin-one"}>
      <Button variant={wide ? "filled" : variant} className={wide ? "volunteer-confirm" : "pay"} busy={pending}
        onClick={() => { if (!pending) startTransition(() => run()); }}>{pending ? "Checking in…" : label}</Button>
      <Outcome state={state} />
    </div>
  );
}
