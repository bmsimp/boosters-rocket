import { can, type Effective } from "@/lib/permissions/effective";
import type { Permission } from "@/lib/permissions/registry";

/**
 * The parts of the one Settings page, in its order, each with the permission that shows it and the page that sets it up
 * or changes it. A section is shown only to someone who holds its permission; the Settings menu entry is shown to anyone
 * who has at least one. Pure, so the menu, the page and the tests read the same list.
 */
export const SETTINGS_SECTIONS = [
  { key: "club", title: "Club", permission: "Settings.Club.Read", href: "/staff/settings/club" },
  { key: "sign-in", title: "Staff sign-in", permission: "Settings.SignIn.ReadWrite", href: "/staff/settings/sign-in" },
  { key: "mail", title: "Outgoing mail", permission: "Settings.Mail.ReadWrite", href: "/staff/settings/mail" },
  { key: "quickbooks", title: "QuickBooks", permission: "Settings.QuickBooks.ReadWrite", href: "/staff/settings/quickbooks" },
  { key: "parents", title: "Parent sign-ins", permission: "Settings.Parents.ReadWrite", href: "/staff/settings/parents" },
  { key: "forms", title: "Forms (Documenso)", permission: "Settings.Forms.ReadWrite", href: "/staff/settings/forms" },
] as const satisfies readonly { key: string; title: string; permission: Permission; href: string }[];

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];
export type SettingsKey = SettingsSection["key"];

export function settingsSections(e: Effective): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => can(e, s.permission));
}
