"use client";
import { useState } from "react";

export type RoleOption = { id: string; name: string; admin: boolean };

/**
 * A person's roles as a list of tick boxes that is always open (name="roleIds"), so nothing drops down over the rows
 * below it. `legend` names it for a screen reader: "Roles for Ana Rivera".
 */
export function RoleChecklist({ roles, initial, legend, idPrefix }: { roles: RoleOption[]; initial: string[]; legend: string; idPrefix: string }) {
  const [picked, setPicked] = useState<string[]>(initial);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <fieldset className="checks">
      <legend>{legend}</legend>
      {roles.map((r) => (
        <label key={r.id} htmlFor={`${idPrefix}-${r.id}`}>
          <input id={`${idPrefix}-${r.id}`} type="checkbox" name="roleIds" value={r.id} checked={picked.includes(r.id)} onChange={() => toggle(r.id)} />
          <span>{r.name}</span>
        </label>
      ))}
    </fieldset>
  );
}
