import { can, type Effective } from "@/lib/permissions/effective";
import type { Permission } from "@/lib/permissions/registry";

/** The rail's groups, in their order (docs/superpowers/specs/2026-11-22-settings-redesign-design.md). Sentence case. */
export const SETTINGS_GROUPS = ["Club", "People and access", "Connections", "Administration"] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

type Item = {
  key: string;
  /** "page": an entry of the rail. "integration": a system the portal talks to, a row of the Integrations page (`under`). */
  kind: "page" | "integration";
  group: SettingsGroup;
  title: string;
  /** Words a person might type in Find a setting besides the title: matched in the browser, nothing else. */
  keywords: readonly string[];
  /** The permission that shows the item, the same as its page's guard. */
  see: Permission;
  /** The permission that changes what the page shows, or null where nothing on it can be changed. */
  change: Permission | null;
  href: string;
  /** The addresses the item stands for in the rail (its own, and its pages'): what marks it current. */
  owns: readonly string[];
  /** An integration's entry in the rail. */
  under?: "integrations";
};

/**
 * Everything under Settings, in the rail's order: its pages, each with the permission that shows it (its page's guard)
 * and the one that changes it, and the four systems the portal talks to, each a row of the Integrations page with its
 * own permission. An item is shown only to someone who holds its `see` permission; the Settings menu entry is shown to
 * anyone who has at least one. Pure, so the menu, the rail, the pages and the tests read the same list.
 *
 * Integrations itself is guarded by the QuickBooks permission (the spec's decision 4): every integration permission is
 * Admin only, so holding one is holding all four (tests/unit/settings-sections.test.ts).
 */
export const SETTINGS_ITEMS = [
  { key: "club", kind: "page", group: "Club", title: "Club", keywords: ["name", "short name", "color", "colour", "time zone", "treasurer"],
    see: "Settings.Club.Read", change: "Settings.Club.ReadWrite", href: "/staff/settings/club", owns: ["/staff/settings/club"] },
  { key: "messages", kind: "page", group: "Club", title: "Messages", keywords: ["announcements", "news", "email families"],
    see: "Settings.Club.Read", change: "Settings.Messages.ReadWrite", href: "/staff/settings/messages", owns: ["/staff/settings/messages"] },
  { key: "staff", kind: "page", group: "People and access", title: "Staff", keywords: ["people", "board", "directors", "invite", "add someone", "block"],
    see: "Staff.Users.Read", change: "Staff.Users.ReadWrite", href: "/staff/settings/staff", owns: ["/staff/settings/staff"] },
  { key: "roles", kind: "page", group: "People and access", title: "Roles", keywords: ["permissions", "access", "treasurer", "admin"],
    see: "Admin.Roles.ReadWrite", change: "Admin.Roles.ReadWrite", href: "/staff/settings/roles", owns: ["/staff/settings/roles"] },
  { key: "parents", kind: "page", group: "People and access", title: "Parent sign-ins", keywords: ["passwords", "codes", "welcome", "strict", "passkeys", "authenticator", "level"],
    see: "Settings.Parents.ReadWrite", change: "Settings.Parents.ReadWrite", href: "/staff/settings/parents", owns: ["/staff/settings/parents"] },
  { key: "integrations", kind: "page", group: "Connections", title: "Integrations", keywords: ["connections", "services"],
    see: "Settings.QuickBooks.ReadWrite", change: null, href: "/staff/settings/integrations",
    owns: ["/staff/settings/integrations", "/staff/settings/quickbooks", "/staff/settings/forms", "/staff/settings/mail", "/staff/settings/sign-in"] },
  { key: "quickbooks", kind: "integration", under: "integrations", group: "Connections", title: "QuickBooks Online", keywords: ["QuickBooks", "Intuit", "books", "accounting", "sandbox", "roster", "Boosters Rocket", "connect", "relay", "register"],
    see: "Settings.QuickBooks.ReadWrite", change: "Settings.QuickBooks.ReadWrite", href: "/staff/settings/quickbooks", owns: ["/staff/settings/quickbooks"] },
  { key: "forms", kind: "integration", under: "integrations", group: "Connections", title: "Documenso", keywords: ["Documenso", "forms", "signing", "webhook"],
    see: "Settings.Forms.ReadWrite", change: "Settings.Forms.ReadWrite", href: "/staff/settings/forms", owns: ["/staff/settings/forms"] },
  { key: "mail", kind: "integration", under: "integrations", group: "Connections", title: "Outgoing mail", keywords: ["mail", "email", "SMTP", "Microsoft 365", "mailbox"],
    see: "Settings.Mail.ReadWrite", change: "Settings.Mail.ReadWrite", href: "/staff/settings/mail", owns: ["/staff/settings/mail"] },
  { key: "sign-in", kind: "integration", under: "integrations", group: "Connections", title: "Staff sign-in", keywords: ["Microsoft", "Google", "Entra", "certificate", "client secret"],
    see: "Settings.SignIn.ReadWrite", change: "Settings.SignIn.ReadWrite", href: "/staff/settings/sign-in", owns: ["/staff/settings/sign-in"] },
  { key: "audit", kind: "page", group: "Administration", title: "Audit log", keywords: ["export", "history", "who changed"],
    see: "Audit.Log.Read", change: null, href: "/staff/settings/audit", owns: ["/staff/settings/audit"] },
  { key: "health", kind: "page", group: "Administration", title: "Health", keywords: ["backup", "worker", "version", "working"],
    see: "Admin.Health.Read", change: null, href: "/staff/settings/health", owns: ["/staff/settings/health"] },
  { key: "backups", kind: "page", group: "Administration", title: "Backups", keywords: ["backup", "restore", "download", "off-site", "storage", "S3", "schedule", "copy"],
    see: "Admin.Backups.ReadWrite", change: "Admin.Backups.ReadWrite", href: "/staff/settings/backups", owns: ["/staff/settings/backups"] },
  { key: "design-system", kind: "page", group: "Administration", title: "Design system", keywords: ["gallery", "components", "samples"],
    see: "Settings.Club.Read", change: null, href: "/staff/settings/design-system", owns: ["/staff/settings/design-system"] },
] as const satisfies readonly Item[];

export type SettingsItem = (typeof SETTINGS_ITEMS)[number];
export type SettingsKey = SettingsItem["key"];
export type PageKey = Extract<SettingsItem, { kind: "page" }>["key"];
export type IntegrationKey = Extract<SettingsItem, { kind: "integration" }>["key"];

/** The items a person may see, pages and integrations both, in the list's order. */
export function settingsItems(e: Effective): SettingsItem[] {
  return SETTINGS_ITEMS.filter((s) => can(e, s.see));
}

/** The rail's entries a person may see. */
export const railItems = (e: Effective) => settingsItems(e).filter((s): s is Extract<SettingsItem, { kind: "page" }> => s.kind === "page");

/** The integrations a person may see, each a row (or two) of the Integrations page. */
export const integrationItems = (e: Effective) => settingsItems(e).filter((s): s is Extract<SettingsItem, { kind: "integration" }> => s.kind === "integration");

/** Every page under Settings is Settings in the staff menu. */
export const SETTINGS_ROOT = "/staff/settings";

/**
 * Where the Settings menu entry leads: the Overview (whose guard is the Club's read) for anyone who may open it, or else
 * straight to their first item, so nobody is sent to a refusal (today only someone who holds Staff.Users.Read alone).
 * Null when they may see nothing under Settings.
 */
export function settingsHome(e: Effective): string | null {
  if (can(e, "Settings.Club.Read")) return SETTINGS_ROOT;
  return railItems(e)[0]?.href ?? null;
}
