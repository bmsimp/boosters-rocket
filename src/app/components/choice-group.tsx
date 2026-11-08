"use client";
type Option = { value: string; label: string; hint?: string; size?: string };

export function ChoiceGroup({ name, legend, hint, options, value, onChange, cols }: {
  name: string; legend: string; hint?: string; options: Option[]; value: string; onChange: (v: string) => void; cols?: number;
}) {
  return (
    <fieldset className="setting" style={{ ["--cols" as string]: cols ?? options.length }}>
      <legend>{legend}</legend>
      {hint && <p className="hint">{hint}</p>}
      <div className="choices">
        {options.map((o) => (
          <label className="choice" key={o.value}>
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span><b style={o.size ? { fontSize: o.size } : undefined}>{o.label}</b>{o.hint && <small>{o.hint}</small>}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
