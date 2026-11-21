"use client";
import { createContext, useContext, useRef, useState, useTransition, type ReactNode } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { ActionOutcome } from "@/app/components/notice";
import { ChoiceGroup } from "@/app/components/choice-group";

// The accounting links screen's presses (stage 4's slice M3a): each a button bound to its server action, and what it
// answered. A press re-reads the page, and a family linked or left unlinked changes its row (its button may go), so
// the answers are kept above the list, not beside the button: the newest first, each press its own. Each press is given
// only its words and the bound action, which carries the ids, way of choosing, roster tag and stamp the page drew.
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const failed: Done = { ok: false, errors: [ACTION_FAILED] };

const Answers = createContext<{ outcomes: { n: number; state: Done }[]; add: (r: Done) => void }>({ outcomes: [], add: () => {} });

/** Holds the answers of every press inside it, for LinkAnswersShown to draw. */
export function LinkAnswers({ children }: { children: ReactNode }) {
  const [outcomes, setOutcomes] = useState<{ n: number; state: Done }[]>([]);
  const pressed = useRef(0);
  const add = (r: Done) => { const n = ++pressed.current; setOutcomes((had) => [{ n, state: r }, ...had]); };
  return <Answers.Provider value={{ outcomes, add }}>{children}</Answers.Provider>;
}

/** How a press of its own (the import's, slice M6) adds its answer to the ones above the list. */
export const useLinkAnswer = () => useContext(Answers).add;

/** The answers so far, newest first. */
export function LinkAnswersShown() {
  const { outcomes } = useContext(Answers);
  return <>{outcomes.map((o) => <ActionOutcome key={o.n} state={o.state} />)}</>;
}

/** One press: its words, its words while busy, whom it is about (read out, not drawn) and the bound action. */
export function LinkPress({ label, busy, about, act }: { label: string; busy: string; about: string; act: () => Promise<Done> }) {
  const { add } = useContext(Answers);
  const [pending, start] = useTransition();
  // A refusal is said with the family it is about (an answer that went through names it itself), so answers are told apart.
  const press = () => { if (!pending) start(async () => { const r = await safely(() => act(), failed); add(r.ok ? r : { ok: false, errors: r.errors.map((e) => `${about}: ${e}`) }); }); };
  return (
    <button type="button" className="btn btn-line" aria-disabled={pending} onClick={press}>
      {pending ? busy : label}<span className="visually-hidden">: {about}</span>
    </button>
  );
}

/**
 * Link this guardian (slice M3c): the Parent customers the row offers, as a choice (the one filled in checked, none
 * otherwise), and the press. Each option is given only its words and its own bound action, which carries the guardian
 * row's id, the customer's id, how it was chosen, the roster tag and the stamp the page drew.
 */
export function GuardianLinkPress({ name, who, about, options, suggested }: { name: string; who: string; about: string; suggested: string | null;
  options: { value: string; label: string; hint: string; act: () => Promise<Done> }[] }) {
  const { add } = useContext(Answers);
  const [chosen, setChosen] = useState(suggested ?? "");
  const [pending, start] = useTransition();
  const press = () => {
    if (pending) return;
    const o = options.find((x) => x.value === chosen);
    if (o === undefined) { add({ ok: false, errors: [`${about}: Choose which Parent customer is ${who}'s first. Nothing was linked.`] }); return; }
    start(async () => { const r = await safely(() => o.act(), failed); add(r.ok ? r : { ok: false, errors: r.errors.map((e) => `${about}: ${e}`) }); });
  };
  return (
    <div className="stack">
      <ChoiceGroup name={name} legend={`Which Parent customer is ${who}'s`} cols={1} value={chosen} onChange={setChosen}
        options={options.map((o) => ({ value: o.value, label: o.label, hint: o.hint }))} />
      <div className="row-actions">
        <button type="button" className="btn btn-line" aria-disabled={pending} onClick={press}>
          {pending ? "Linking…" : `Link ${who} to this Parent customer`}<span className="visually-hidden">: {about}</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Give up, for a change kept in the portal (slice M5c): why (kept in the audit log, as Reconciliation's TextAction
 * asks) and the press, bound to Reconciliation's own action with the item's id. A give-up re-reads the page and the
 * kept change leaves its row, taking this press with it, so its answer is kept above the list with every other press's.
 */
export function LinkGiveUp({ about, act }: { about: string; act: (note: string) => Promise<Done> }) {
  const { add } = useContext(Answers);
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const press = () => {
    if (pending) return;
    start(async () => { const r = await safely(() => act(text), failed); if (r.ok) setText(""); add(r.ok ? r : { ok: false, errors: r.errors.map((e) => `${about}: ${e}`) }); });
  };
  return (
    <div className="stack">
      <label className="field"><span>Why? (kept in the audit log)</span>
        <textarea rows={2} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} /></label>
      <button type="button" className="btn btn-line" aria-disabled={pending} onClick={press}>
        {pending ? "Giving up…" : "Give up"}<span className="visually-hidden">: {about}</span>
      </button>
    </div>
  );
}
