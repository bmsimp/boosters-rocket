import { GRANTABLE, isPermission, type Permission } from "./registry";
import { expandRules, type RoleRules } from "./rules";
import { readTwinOf } from "./words";

/**
 * A role as the checklist shows it. `granted` is what its rules give today, worked out by the same expandRules() that
 * decides access, so the ticks never claim more or less than the role really gives. `patterns` is true when the rules are
 * more than a list of exact names (a wildcard, or any exclude): such a role takes up new permissions by itself, and a
 * checklist save turns it into plain names.
 */
export type RoleChecklistView = { granted: Permission[]; patterns: boolean };

export function checklistView(rules: RoleRules): RoleChecklistView {
  const granted = [...expandRules(rules)].sort((a, b) => GRANTABLE.indexOf(a) - GRANTABLE.indexOf(b));
  const patterns = rules.exclude.length > 0 || rules.include.some((p) => !(GRANTABLE as readonly string[]).includes(p));
  return { granted, patterns };
}

export type ChecklistRules = { ok: true; rules: RoleRules } | { ok: false; errors: string[] };

/**
 * The rules a checklist save writes: each ticked permission as an include rule of its exact name, with the Read a
 * ReadWrite brings, and no excludes. Anything that isn't a permission a role may hold is refused, not dropped: the page
 * only offers those, so anything else did not come from it.
 */
export function rulesFromChecklist(ticked: readonly unknown[]): ChecklistRules {
  if (ticked.length > GRANTABLE.length * 2) return { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
  const chosen = new Set<Permission>();
  for (const t of ticked) {
    if (typeof t !== "string" || !isPermission(t) || !GRANTABLE.includes(t)) return { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
    chosen.add(t);
    const twin = readTwinOf(t);
    if (twin) chosen.add(twin);
  }
  if (chosen.size === 0) return { ok: false, errors: ["Tick at least one thing this role lets people do."] };
  return { ok: true, rules: { include: GRANTABLE.filter((p) => chosen.has(p)), exclude: [] } };
}
