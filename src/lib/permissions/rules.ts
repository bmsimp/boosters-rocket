import { GRANTABLE, ADMIN_ONLY, isPermission, type Permission } from "./registry";

export type RoleRules = { include: string[]; exclude: string[] };

const SEGMENT = /^(\*|[A-Z][A-Za-z]*)$/;
const LEVEL = /^(\*|Read|ReadWrite)$/;

/**
 * Returns an error message for a bad pattern, or null if it's fine. A permission's own name is always a pattern,
 * whatever its shape (Roster.Read has two parts): without that, the only way to give it was a wildcard, which also takes
 * in every permission added later. Whether a name may be given at all is settled elsewhere: expandRules() never returns
 * an Admin-only permission, and validateRules() refuses an include that matches nothing else.
 */
export function validatePattern(raw: string): string | null {
  const p = raw.trim();
  if (p === "") return "A pattern can't be empty.";
  if (p !== raw) return `“${raw}” has spaces at the start or end.`;
  if (p === "*" || isPermission(p)) return null;
  const parts = p.split(".");
  if (parts.some((s) => s === "")) return `“${p}” has an empty part.`;
  if (parts.length === 2 && parts[1] === "*" && SEGMENT.test(parts[0]!)) return null; // "Roster.*"
  if (parts.length === 2 && parts[0] === "*" && LEVEL.test(parts[1]!) && parts[1] !== "*") return null; // "*.Read"
  if (parts.length !== 3) return `“${p}” isn't a permission's name, or a pattern like Roster.* or Area.Object.Read. The names are under All permissions.`;
  const [area, obj, level] = parts as [string, string, string];
  if (!SEGMENT.test(area) || !SEGMENT.test(obj)) return `“${p}” has a part that isn't a word or *.`;
  if (!LEVEL.test(level)) return `“${p}” must end in Read, ReadWrite or *.`;
  return null;
}

function toRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function matches(pattern: string, permission: string): boolean {
  return toRegex(pattern).test(permission);
}

/** Expands rules against the universe. Admin-only permissions are never returned. */
export function expandRules(rules: RoleRules, universe: readonly string[] = GRANTABLE): Set<Permission> {
  const out = new Set<Permission>();
  for (const perm of universe) {
    if (ADMIN_ONLY.includes(perm as Permission)) continue;
    const writeTwin = perm.endsWith(".Read") ? `${perm}Write` : null; // X.Read -> X.ReadWrite
    const included = rules.include.some((inc) => matches(inc, perm) || (writeTwin !== null && matches(inc, writeTwin)));
    if (!included) continue;
    if (rules.exclude.some((exc) => matches(exc, perm))) continue;
    out.add(perm as Permission);
  }
  return out;
}

export function validateRules(rules: RoleRules): string[] {
  const errors: string[] = [];
  if (rules.include.length === 0) errors.push("A role needs at least one include pattern.");
  for (const p of [...rules.include, ...rules.exclude]) {
    const e = validatePattern(p);
    if (e) errors.push(e);
  }
  for (const p of rules.include) {
    if (validatePattern(p)) continue;
    const hitsAdmin = ADMIN_ONLY.some((a) => matches(p, a));
    const hitsGrantable = GRANTABLE.some((g) => matches(p, g));
    if (hitsAdmin && !hitsGrantable) errors.push(`“${p}” only matches Admin permissions, which can't be given to a role.`);
  }
  return errors;
}
