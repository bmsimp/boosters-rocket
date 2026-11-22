"use client";
import { useState } from "react";
import { ChoiceGroup } from "../../../components/choice-group";

/** The gallery's ChoiceGroup sample: it holds its own choice, as a page's form would. Nothing is saved. */
export function ChoiceSample() {
  const [value, setValue] = useState("standard");
  return (
    <ChoiceGroup name="ds-text-size" legend="Text size" hint="A sample: choosing changes nothing." value={value} onChange={setValue} cols={3}
      options={[
        { value: "standard", label: "Standard", hint: "As the device sets it" },
        { value: "large", label: "Large", hint: "A step bigger" },
        { value: "larger", label: "Larger", hint: "Two steps bigger" },
      ]} />
  );
}

/** The same with an option that can't be chosen now: a place someone has already taken. */
export function TakenChoiceSample() {
  const [value, setValue] = useState("me");
  return (
    <ChoiceGroup name="ds-who" legend="Who will do this shift?" hint="A sample: one option is taken." value={value} onChange={setValue} cols={1}
      options={[
        { value: "me", label: "Me (Sam Sample)", hint: "Counts as 1 shift toward Spring volunteering." },
        { value: "alex", label: "Alex Sample (signed up already)", hint: "Counts as 1 shift toward Spring volunteering.", disabled: true },
      ]} />
  );
}
