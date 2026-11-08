/**
 * The full permission universe. Every staff action declares one of these (see guards.ts).
 * Add new permissions here; wildcard roles pick them up automatically.
 * Format: Area.Object.Level, Level = Read | ReadWrite.
 */
export const PERMISSIONS = [
  "Admin.Roles.ReadWrite",      // admin-only: create/change/assign roles
  "Staff.Users.Read",
  "Staff.Users.ReadWrite",
  "Settings.Club.Read",
  "Settings.Club.ReadWrite",
  "Audit.Log.Read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Never grantable through a custom role; only the built-in Admin holds them. */
export const ADMIN_ONLY: readonly Permission[] = ["Admin.Roles.ReadWrite"];

export const GRANTABLE: readonly Permission[] = PERMISSIONS.filter((p) => !ADMIN_ONLY.includes(p));

export function isPermission(s: string): s is Permission {
  return (PERMISSIONS as readonly string[]).includes(s);
}
