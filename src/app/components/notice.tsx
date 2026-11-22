import type { ReactNode, Ref } from "react";
import type { Tone as StatusTone } from "./ui/tone";

/**
 * The notice primitive (DESIGN.md, Notices): a status that stands apart from the text around it. Four tones, each with
 * its own word and icon, so the color only repeats what they say: information, something that needs attention, done,
 * and a problem (something that didn't go through). A notice with a title is a section with its own heading, and its
 * word is then read out but not drawn, as the heading says it. No hooks: server pages and client forms both use it.
 */
export type Tone = "info" | "warning" | "done" | "problem";

/**
 * A notice speaks the product's one status vocabulary (src/app/components/ui/tone.ts): info is info (blue), warning is
 * due, done is done and problem is late. The prop keeps its own names; the class and the colors follow the status tone.
 */
export const NOTICE_STATUS_TONE: Record<Tone, StatusTone> = { info: "info", warning: "due", done: "done", problem: "late" };

export const TONE_WORDS: Record<Tone, string> = { info: "Note", warning: "Needs attention", done: "Done", problem: "Problem" };

const ICONS: Record<Tone, ReactNode> = {
  info: <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="10" cy="10" r="8" /><path d="M10 9v5" /><circle cx="10" cy="6" r=".8" fill="currentColor" /></svg>,
  warning: <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><path d="M10 2.5l8 14.5H2L10 2.5z" /><path d="M10 8v4" /><circle cx="10" cy="14.6" r=".8" fill="currentColor" /></svg>,
  done: <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M4 10.5l4 4 8-9" /></svg>,
  problem: <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="10" cy="10" r="8" /><path d="M7 7l6 6M13 7l-6 6" /></svg>,
};

type Live = "status" | "alert" | "none";

export function Notice({ tone, title, titleId, level = 2, live, className, children, ref, tabIndex }: {
  tone: Tone;
  /** A heading for a notice that is a section of its own (the staff home's warnings). */
  title?: ReactNode; titleId?: string; level?: 2 | 3;
  /** How it is announced. A problem is an alert, anything else a status; "none" for one that is simply part of the page. */
  live?: Live;
  className?: string;
  children?: ReactNode;
  /**
   * For an answer that takes the focus once it is drawn (the form that was pressed is gone, and the keyboard's place
   * with it): its element, and `tabIndex={-1}` so it can hold the focus. The notice itself is then what is focused and read.
   */
  ref?: Ref<HTMLDivElement>; tabIndex?: number;
}) {
  const announced = live ?? (tone === "problem" ? "alert" : "status");
  const role = announced === "none" ? undefined : announced;
  const cls = ["notice", `notice-${NOTICE_STATUS_TONE[tone]}`, className].filter(Boolean).join(" ");
  const Heading = level === 3 ? "h3" : "h2";
  if (title) {
    return (
      <section ref={ref as Ref<HTMLElement>} tabIndex={tabIndex} className={cls} role={role} aria-labelledby={titleId}>
        {ICONS[tone]}
        <div className="notice-body">
          <Heading id={titleId} className="notice-title"><span className="visually-hidden">{TONE_WORDS[tone]}: </span>{title}</Heading>
          {children}
        </div>
      </section>
    );
  }
  return (
    <div ref={ref} tabIndex={tabIndex} className={cls} role={role}>
      {ICONS[tone]}
      <div className="notice-body"><span className="notice-word">{TONE_WORDS[tone]}</span> {children}</div>
    </div>
  );
}

/**
 * What a server action answered, as a notice: done with its message, or a problem with its sentences. An answer that
 * went through but isn't finished says so in its own `status` (a change saved in the portal first: `waiting` for
 * QuickBooks, or the portal can't tell yet, is information; `attention`, refused, held back or given up meanwhile,
 * needs attention); an answer with none is done, as every other page's is.
 */
export function ActionOutcome({ state, ref }: { state: { ok: true; message: string; status?: "waiting" | "attention" } | { ok: false; errors: string[] } | null;
  /** Given, the answer takes the focus where the caller puts it there (a form drawn again after its answer: Notice's `ref`). */
  ref?: Ref<HTMLDivElement> }) {
  if (!state) return null;
  const focus = ref ? { ref, tabIndex: -1 } : {};
  if (state.ok) return <Notice tone={state.status === "attention" ? "warning" : state.status === "waiting" ? "info" : "done"} {...focus}>{state.message}</Notice>;
  return (
    <Notice tone="problem" {...focus}>
      {state.errors.length === 1 ? state.errors[0] : <ul className="notice-list">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
    </Notice>
  );
}
