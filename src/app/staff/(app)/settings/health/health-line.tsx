import { Fragment } from "react";
import type { HealthLine, HealthState } from "@/lib/health/report";
import { LocalTime } from "@/app/components/local-time";

/** The state as a word with a small picture beside it. The word carries the meaning; the color and the picture only repeat it. */
export function StateWord({ state, word }: { state: HealthState; word: string }) {
  if (!word) return null;
  return (
    <span className={`state ${state === "ok" ? "done" : state === "attention" ? "todo" : ""}`.trim()}>
      <svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {state === "ok" ? <path d="M3 8.5l3.2 3.2L13 5" /> : state === "attention" ? <path d="M8 2.5l6 10.5H2L8 2.5zM8 7v2.5M8 11.6v.1" /> : <path d="M4 8h8" />}
      </svg>
      {word}
    </span>
  );
}

/** One Health line's words: what it says, when each thing last worked, its notes and its fix. */
export function HealthLineWords({ line: l }: { line: HealthLine }) {
  return (
    <>
      <span className="when">{l.says}</span>
      {l.times.length > 0 && <span className="when">{l.times.map((t, i) => (
        <Fragment key={t.label}>{i > 0 ? " · " : ""}{t.label}: {t.at ? <LocalTime iso={t.at} /> : "never"}</Fragment>))}</span>}
      {l.notes.map((n) => <span className="when" key={n}>{n}</span>)}
      {l.fix && <span className="when"><a className="link-line" href={l.fix.href}>{l.fix.label}</a></span>}
    </>
  );
}
