"use client";
import { useState, type ReactNode } from "react";
import { ChoiceGroup } from "../choice-group";

/**
 * Two (or a few) ways to do one task, such as by hand or with a script: a ChoiceGroup in the open, and under it only
 * the steps of the way chosen. Nothing is folded away: the choice is the first thing read. The first option is
 * chosen to start unless `initial` names another.
 */
export function StepsChoice({ name, legend, options, initial }: {
  name: string; legend: string; options: { value: string; label: string; hint?: string; steps: ReactNode }[]; initial?: string;
}) {
  const [chosen, setChosen] = useState(initial ?? options[0]?.value ?? "");
  const shown = options.find((o) => o.value === chosen) ?? options[0];
  return (
    <div className="stack">
      <ChoiceGroup name={name} legend={legend} options={options.map(({ value, label, hint }) => ({ value, label, hint }))} value={chosen} onChange={setChosen} />
      {shown?.steps}
    </div>
  );
}
