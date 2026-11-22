"use client";
import { useActionState, useEffect, useRef } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { CONTACT_FIELDS, type ContactField, type ContactForm, type ContactValues } from "@/lib/parents/contact-fields";
import { ActionOutcome, Button, LinkButton, TextInput } from "@/app/components/ui";
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
 * The parent's phone and mailing address (their own, or their family's), to change and save. It is given what it shows
 * and nothing else: the values, and the version they were read at, which goes back with a save so that a change saved
 * meanwhile (from another device, or by another parent of the family) is noticed and not overwritten. No id is here to
 * send: the server knows whose details they are.
 *
 * A save revalidates this page, so Next.js draws it again as the answer comes back; the form keeps its own state (the
 * values the answer brought and its "Saved") whatever the page is drawn with afterward.
 */
export function DetailsEditor({ initial }: { initial: ContactForm }) {
  const [state, action, pending] = useActionState(async (prev: State, f: FormData): Promise<State> => {
    f.set("version", prev.shown.version);
    const r = await safely(() => saveDetailsAction(f), { ok: false as const, errors: [ACTION_FAILED] });
    // When the answer brings the details as the portal holds them now (saved, or changed meanwhile), the form shows
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
        <TextInput key={`${name}-${state.round}`} id={`contact-${name}`} label={<>{label}{OPTIONAL.includes(name) ? " (optional)" : ""}</>}
          name={name} defaultValue={state.shown.values[name]} maxLength={max} {...FILLS[name]} />
      ))}
      {state.result && <ActionOutcome key={state.round} state={state.result} ref={answer} />}
      {/* Busy is aria-disabled, not disabled: a disabled button drops the focus, and the keyboard's place with it. */}
      <div className="row-actions">
        <Button type="submit" busy={pending}>{pending ? "Saving…" : "Save my details"}</Button>
        <LinkButton plain variant="secondary" href="/family">Back to Family</LinkButton>
      </div>
    </form>
  );
}
