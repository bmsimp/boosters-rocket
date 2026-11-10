/**
 * The full permission universe. Every staff action declares one of these (see guards.ts).
 * Add new permissions here; wildcard roles pick them up automatically.
 * Format: Area.Object.Level, Level = Read | ReadWrite.
 */
export const PERMISSIONS = [
  "Admin.Roles.ReadWrite",      // admin-only: create, change and delete roles
  "Staff.Users.Read",
  "Staff.Users.ReadWrite",      // admin-only: invite staff, assign roles, turn sign-in on or off
  "Settings.Club.Read",
  "Settings.Club.ReadWrite",
  "Audit.Log.Read",
  "Settings.SignIn.ReadWrite",  // admin-only: change how staff and parents sign in (sign-in settings)
  "Settings.Mail.ReadWrite",    // admin-only: change outgoing mail; whoever controls it can read parents' sign-in codes
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Never grantable through a custom role; only the built-in Admin holds them. */
export const ADMIN_ONLY: readonly Permission[] = ["Admin.Roles.ReadWrite", "Staff.Users.ReadWrite", "Settings.SignIn.ReadWrite", "Settings.Mail.ReadWrite"];

export const GRANTABLE: readonly Permission[] = PERMISSIONS.filter((p) => !ADMIN_ONLY.includes(p));

export function isPermission(s: string): s is Permission {
  return (PERMISSIONS as readonly string[]).includes(s);
}
