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
