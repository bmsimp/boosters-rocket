"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { CONTACT_FIELDS, type ContactField, type ContactForm, type ContactValues } from "@/lib/parents/contact-fields";
import { saveDetailsAction } from "./actions";

type Result = { ok: true; message: string } | { ok: false; errors: string[] };
/** What the form shows, the last answer, and a count of answers: the fields are drawn again after each one. */
type State = { shown: ContactForm; result: Result | null; round: number };

/** How a browser or a password manager knows each field, so it can fill it in. */
const FILLS: Record<ContactField, { autoComplete: string; type?: string; inputMode?: "tel" }> = {
  phone: { autoComplete: "tel", type: "tel", inputMode: "tel" },
  line1: { autoComplete: "address-line1" },
  line2: { autoComplete: "address-line2" },
  city: { autoComplete: "address-level2" },
  region: { autoComplete: "address-level1" },
  postalCode: { autoComplete: "postal-code" },
  country: { autoComplete: "country-name" },
};
const OPTIONAL: readonly ContactField[] = ["line2", "country"];

const typed = (f: FormData): ContactValues =>
  Object.fromEntries(CONTACT_FIELDS.map(({ name }) => [name, String(f.get(name) ?? "")])) as ContactValues;

/**
 * What the "Phone and mailing address" box holds: the form, or, when QuickBooks couldn't be asked as the page was
 * drawn (`initial` is null), a line saying so.
 *
 * A save revalidates this page, so Next.js draws it again as the answer comes back, and that second read from
 * QuickBooks can fail though the save worked. A form that is already on the screen therefore stays, with its "Saved"
 * and its own values, whatever the page is drawn with afterward; only a page with no form yet takes one when it comes.
 */
export function DetailsEditor({ initial }: { initial: ContactForm | null }) {
  const [first, setFirst] = useState(initial);
  if (!first && initial) setFirst(initial);
  if (first) return <DetailsForm initial={first} />;
  return (
    <>
      <p className="offline-note" role="status">We can&apos;t reach the club&apos;s books right now, so your details can&apos;t be changed here just yet. Please try again in a little while.</p>
      <div className="box-foot"><a className="btn btn-line" href="/family">Back to Family</a></div>
    </>
  );
}

/**
 * The parent's own phone and mailing address, to change and save. It is given what it shows and nothing else: the
 * values, and the version of the record they were read from, which goes back with a save so that a change made in
 * QuickBooks meanwhile is noticed and not overwritten. No id is here to send: the server knows whose record it is.
 */
function DetailsForm({ initial }: { initial: ContactForm }) {
  const [state, action, pending] = useActionState(async (prev: State, f: FormData): Promise<State> => {
    f.set("version", prev.shown.version);
    const r = await safely(() => saveDetailsAction(f), { ok: false as const, errors: [ACTION_FAILED] });
    // When the answer brings the record as QuickBooks has it now (saved, or changed by someone else), the form shows
    // that. Otherwise it keeps what was typed, so nothing has to be typed twice.
    const shown = "current" in r && r.current ? r.current : { values: typed(f), version: prev.shown.version };
    return { shown, result: r.ok ? { ok: true, message: r.message } : { ok: false, errors: r.errors }, round: prev.round + 1 };
  }, { shown: initial, result: null, round: 0 });
  // Each answer draws the fields again, so the one that had the focus is gone: the answer takes it, and is read out.
  const answer = useRef<HTMLDivElement>(null);
  useEffect(() => { if (state.round > 0) answer.current?.focus(); }, [state.round]);
  return (
    <form action={action} className="stack" onSubmit={(e) => { if (pending) e.preventDefault(); }}>
      {CONTACT_FIELDS.map(({ name, label, max }) => (
        <label className="field" key={`${name}-${state.round}`}>
          <span>{label}{OPTIONAL.includes(name) ? " (optional)" : ""}</span>
          <input name={name} defaultValue={state.shown.values[name]} maxLength={max} {...FILLS[name]} />
        </label>
      ))}
      {state.result && (
        <div ref={answer} tabIndex={-1} key={state.round}>
          {!state.result.ok && <ul role="alert" className="errors">{state.result.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
          {state.result.ok && (
            <p role="status" className="paid-up">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M4 12.5l5 5 11-11" /></svg>
              {state.result.message}
            </p>
          )}
        </div>
      )}
      {/* Busy is aria-disabled, not disabled: a disabled button drops the focus, and the keyboard's place with it. */}
      <button className="btn" aria-disabled={pending || undefined}>{pending ? "Saving…" : "Save my details"}</button>
      <a className="btn btn-line" href="/family">Back to Family</a>
    </form>
  );
}
