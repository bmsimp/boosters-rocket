"use client";
import { useId, useState, type ReactNode } from "react";

/**
 * Two (or a few) ways to do one task, such as by hand or with a script: M3 Expressive's connected button group in the
 * open (one radio each, the chosen one round and in the secondary container), and under it only the steps of the way
 * chosen. Nothing is folded away: the choice is the first thing read. The first option is chosen to start unless
 * `initial` names another. An option's `hint`, one line, is read under the group for the chosen way.
 */
export function StepsChoice({ name, legend, options, initial }: {
  name: string; legend: string; options: { value: string; label: string; hint?: string; steps: ReactNode }[]; initial?: string;
}) {
  const [chosen, setChosen] = useState(initial ?? options[0]?.value ?? "");
  const hintId = useId();
  const shown = options.find((o) => o.value === chosen) ?? options[0];
  return (
    <div className="stack">
      <fieldset className="connected" aria-describedby={shown?.hint ? hintId : undefined}>
        <legend>{legend}</legend>
        <div className="connected-options">
          {options.map((o) => (
            <label className="connected-option" key={o.value}>
              <input type="radio" name={name} value={o.value} checked={chosen === o.value} onChange={() => setChosen(o.value)} />{o.label}
            </label>
          ))}
        </div>
        {shown?.hint && <p className="hint connected-hint" id={hintId}>{shown.hint}</p>}
      </fieldset>
      {shown?.steps}
    </div>
  );
}
