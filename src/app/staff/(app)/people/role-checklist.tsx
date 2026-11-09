"use client";
import { useState } from "react";

export type RoleOption = { id: string; name: string; admin: boolean };

/** A "Roles: Admin, Treasurer" dropdown of checkboxes (name="roleIds"). Admin is shown but locked unless `canGrantAdmin`. */
export function RoleChecklist({ roles, initial, canGrantAdmin, disabled = false }:
  { roles: RoleOption[]; initial: string[]; canGrantAdmin: boolean; disabled?: boolean }) {
  const [picked, setPicked] = useState<string[]>(initial);
  const names = roles.filter((r) => picked.includes(r.id)).map((r) => r.name);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <details className="role-picker">
      <summary aria-disabled={disabled || undefined} onClick={(e) => { if (disabled) e.preventDefault(); }}>Roles: {names.join(", ") || "none"}</summary>
      <div className="role-picker-list">
        {roles.map((r) => {
          const locked = disabled || (r.admin && !canGrantAdmin);
          return (
            <label key={r.id} className="role-picker-item">
              <input type="checkbox" name={locked ? undefined : "roleIds"} value={r.id} checked={picked.includes(r.id)} disabled={locked} onChange={() => toggle(r.id)} />
              <span>{r.name}</span>
              {locked && picked.includes(r.id) && <input type="hidden" name="roleIds" value={r.id} />}
            </label>
          );
        })}
      </div>
    </details>
  );
}
