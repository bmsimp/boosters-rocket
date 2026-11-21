import type { ReactNode } from "react";

export type Step = {
  key: string;
  label: ReactNode;
  /** Finished and behind the current step: ticked, in the done green. */
  done?: boolean;
  /** The step things are on now: the club's color, aria-current="step". */
  current?: boolean;
  /** Read out after the label: ", current set", ", done", ", not finished", or nothing. The track says it to the eye. */
  words: string;
  /** Drawn under the current step's label (the season ruler's students on it); give it aria-hidden when the words are elsewhere. */
  marker?: ReactNode;
};

const Tick = () => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M3 8.5l3 3 7-7" /></svg>;

/**
 * A step indicator (the season ruler's `ol.sets`): a thin track in segments, each step's number and name under it,
 * done steps ticked in green and the current one in the club's color. Not a control. More than six steps show
 * numbers only on a phone (`many`), and the page's heading names the current one.
 */
export function StepIndicator({ steps }: { steps: Step[] }) {
  return (
    <ol className={steps.length > 6 ? "sets many" : "sets"} style={{ ["--count" as string]: steps.length }}>
      {steps.map((step, i) => (
        <li key={step.key} className={step.done ? "done" : undefined} aria-current={step.current ? "step" : undefined}>
          <span className="n">{step.done && <Tick />}{i + 1}</span>
          <span className="label">{step.label}</span>
          <span className="visually-hidden">{step.words}</span>
          {step.marker}
        </li>
      ))}
    </ol>
  );
}
