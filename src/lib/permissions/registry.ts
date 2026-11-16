/**
 * The full permission universe. Every staff action declares one of these (see guards.ts).
 * Add new permissions here; wildcard roles pick them up automatically.
 * Format: Area.Object.Level, Level = Read | ReadWrite. A few older names have two parts (Roster.Read): a role can be
 * given any name in this list as it is written (rules.ts).
 */
export const PERMISSIONS = [
  "Admin.Roles.ReadWrite",      // admin-only: create, change and delete roles
  "Staff.Users.Read",
  "Staff.Users.ReadWrite",      // admin-only: invite staff, assign roles, turn sign-in on or off
  "Settings.Club.Read",
  "Settings.Club.ReadWrite",
  "Audit.Log.Read",             // admin-only: read and export the audit log; its rows hold staff-only notes (block reasons, held-address notes)
  "Admin.Health.Read",          // admin-only: the health page (the worker, QuickBooks, mail, backups, the portal's address)
  "Settings.SignIn.ReadWrite",  // admin-only: change how staff and parents sign in (sign-in settings)
  "Settings.Mail.ReadWrite",    // admin-only: change outgoing mail; whoever controls it can read parents' sign-in codes
  "Settings.QuickBooks.ReadWrite", // admin-only: connect QuickBooks and choose the membership shape; it reaches the club's books
  "Settings.Forms.ReadWrite",      // admin-only: connect the club's Documenso; its API token can read every signed form
  "Roster.Read",                   // see families, students and parents (or members) as QuickBooks lists them
  "Roster.Family.ReadWrite",       // create, rename, move and make inactive families, students and parents (or members) in QuickBooks, and retry or give up a waiting write
  "Settings.Parents.ReadWrite",    // admin-only: switch parent sign-ins and welcome emails on, and review company matches
  "Parents.ReadWrite",             // decide held addresses, block and unblock a parent, resend a welcome email
  "Season.Steps.Read",             // see the seasons, their steps and the requirements in them
  "Season.Steps.ReadWrite",        // create and change seasons, steps and requirements, and choose the current season
  "Season.Progress.Read",          // see which families and students have met each requirement
  "Season.Progress.ReadWrite",     // tick checklist items off, and waive a requirement for a family or student
  "Finance.Balance.Read",          // see what every family owes and each family's invoices, and ask for every family to be read from QuickBooks again
  "Volunteer.Event.Read",          // see volunteer events and shifts, and who has signed up for each shift
  "Volunteer.Event.ReadWrite",     // create, change, copy and cancel events and shifts, and set the cancelling cut-off
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Never grantable through a custom role; only the built-in Admin holds them. */
export const ADMIN_ONLY: readonly Permission[] = ["Admin.Roles.ReadWrite", "Staff.Users.ReadWrite", "Settings.SignIn.ReadWrite", "Settings.Mail.ReadWrite", "Settings.QuickBooks.ReadWrite", "Settings.Parents.ReadWrite", "Audit.Log.Read", "Admin.Health.Read", "Settings.Forms.ReadWrite"];

export const GRANTABLE: readonly Permission[] = PERMISSIONS.filter((p) => !ADMIN_ONLY.includes(p));

export function isPermission(s: string): s is Permission {
  return (PERMISSIONS as readonly string[]).includes(s);
}
