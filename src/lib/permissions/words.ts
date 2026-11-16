import { ADMIN_ONLY, GRANTABLE, type Permission } from "./registry";

/**
 * Every permission in plain words, for the roles checklist: what ticking it lets someone do. One entry per permission
 * in the registry, Admin-only ones too (the Roles page says what only an Admin can do). tests/unit/permission-words.test.ts
 * fails for a permission with no words, so a new permission is written here when it is added to registry.ts.
 */
export const PERMISSION_WORDS: Record<Permission, string> = {
  "Admin.Roles.ReadWrite": "Make, change and delete roles",
  "Staff.Users.Read": "See who is on the staff list",
  "Staff.Users.ReadWrite": "Add staff, give them roles, and turn their sign-in off",
  "Settings.Club.Read": "See the club settings",
  "Settings.Club.ReadWrite": "Change club settings",
  "Audit.Log.Read": "See the audit log",
  "Admin.Health.Read": "See the Health page",
  "Settings.SignIn.ReadWrite": "Change how staff sign in",
  "Settings.Mail.ReadWrite": "Change outgoing mail",
  "Settings.QuickBooks.ReadWrite": "Connect QuickBooks and choose the membership shape",
  "Settings.Forms.ReadWrite": "Connect the club's Documenso",
  "Roster.Read": "See the roster: families, students and parents",
  "Roster.Family.ReadWrite": "Add, rename, move and make inactive families, students and parents in QuickBooks",
  "Settings.Parents.ReadWrite": "Switch parent sign-ins and welcome emails on or off",
  "Parents.ReadWrite": "Decide held addresses, block a parent, and resend a welcome email",
  "Season.Steps.Read": "See the seasons, their steps and requirements",
  "Season.Steps.ReadWrite": "Set seasons up: steps, requirements and the current season",
  "Season.Progress.Read": "See which families have met each requirement",
  "Season.Progress.ReadWrite": "Tick checklist items off and waive a requirement",
  "Finance.Balance.Read": "See what every family owes, and ask for a fresh read from QuickBooks",
  "Volunteer.Event.Read": "See volunteer events, shifts and who signed up",
  "Volunteer.Event.ReadWrite": "Make, change and cancel volunteer events and shifts",
  "Forms.Signature.Read": "See who has signed each form, and download signed forms",
  "Forms.Signature.ReadWrite": "Remind guardians to sign, and start an unfinished form again",
  "Volunteer.Credit.ReadWrite": "Add, remove and correct a family's volunteer credit",
};

/** The areas of the checklist, in the order the Roles page shows them. Each grantable permission is in exactly one. */
export const PERMISSION_AREAS: { area: string; permissions: readonly Permission[] }[] = [
  { area: "Families", permissions: ["Roster.Read", "Roster.Family.ReadWrite", "Parents.ReadWrite"] },
  { area: "Seasons", permissions: ["Season.Steps.Read", "Season.Steps.ReadWrite", "Season.Progress.Read", "Season.Progress.ReadWrite"] },
  { area: "Forms", permissions: ["Forms.Signature.Read", "Forms.Signature.ReadWrite"] },
  { area: "Volunteering", permissions: ["Volunteer.Event.Read", "Volunteer.Event.ReadWrite", "Volunteer.Credit.ReadWrite"] },
  { area: "Money", permissions: ["Finance.Balance.Read"] },
  { area: "Staff and club", permissions: ["Staff.Users.Read", "Settings.Club.Read", "Settings.Club.ReadWrite"] },
];

/**
 * The permission a ticked one brings with it: a ReadWrite brings its Read (rules.ts gives X.Read to a role that names
 * X.ReadWrite), so the checklist shows the Read ticked too and saves both, and what is saved is what is granted.
 */
export function readTwinOf(p: Permission): Permission | null {
  if (!p.endsWith(".ReadWrite")) return null;
  const twin = `${p.slice(0, -"ReadWrite".length)}Read`;
  return (GRANTABLE as readonly string[]).includes(twin) ? (twin as Permission) : null;
}

/** The words for each Admin-only permission, for the Roles page's note on what a role can't be given. */
export const ADMIN_ONLY_WORDS: readonly string[] = ADMIN_ONLY.map((p) => PERMISSION_WORDS[p]);
