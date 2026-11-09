"use client";
import { useState } from "react";

export type RoleOption = { id: string; name: string; admin: boolean };

/** A "Roles: Admin, Treasurer" dropdown of checkboxes (name="roleIds"). */
export function RoleChecklist({ roles, initial }: { roles: RoleOption[]; initial: string[] }) {
  const [picked, setPicked] = useState<string[]>(initial);
  const names = roles.filter((r) => picked.includes(r.id)).map((r) => r.name);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  return (
    <details className="role-picker">
      <summary>Roles: {names.join(", ") || "none"}</summary>
      <div className="role-picker-list">
        {roles.map((r) => (
          <label key={r.id} className="role-picker-item">
            <input type="checkbox" name="roleIds" value={r.id} checked={picked.includes(r.id)} onChange={() => toggle(r.id)} />
            <span>{r.name}</span>
          </label>
        ))}
      </div>
    </details>
  );
}
