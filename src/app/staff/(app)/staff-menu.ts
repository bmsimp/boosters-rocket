import { can, type Effective } from "@/lib/permissions/effective";
import type { Permission } from "@/lib/permissions/registry";
import { SETTINGS_ROOT, settingsHome } from "./settings/sections";

/** `section`: the address whose pages all mark this entry current, where it differs from `href` (Settings). */
export type MenuLink = { href: string; label: string; section?: string };
export type MenuGroup = { label: string; links: MenuLink[] };
/** An entry of the staff menu: a link of its own, or a group of links behind a button. */
export type MenuEntry = ({ kind: "link" } & MenuLink) | ({ kind: "group" } & MenuGroup);

type Rule = MenuLink & { when: (e: Effective) => boolean };
const holds = (p: Permission) => (e: Effective) => can(e, p);
const groups: { label: string; links: Rule[] }[] = [
  { label: "Families", links: [
    { href: "/staff/roster", label: "Roster", when: holds("Roster.Read") },
    { href: "/staff/parents", label: "Parents", when: holds("Parents.ReadWrite") },
    // The page is the linking permission's, and checks Roster.Read itself: a role written with patterns may hold one alone.
    { href: "/staff/links", label: "Accounting links", when: (e) => can(e, "Accounting.Link.ReadWrite") && can(e, "Roster.Read") },
  ] },
  { label: "Season", links: [
    // Two entries: someone who only ticks names off (Season.Progress.*) can't open the set-up pages.
    { href: "/staff/seasons", label: "Seasons", when: holds("Season.Steps.Read") },
    { href: "/staff/seasons/progress", label: "Progress", when: holds("Season.Progress.Read") },
    { href: "/staff/forms", label: "Signed forms", when: holds("Forms.Signature.Read") },
    { href: "/staff/volunteer", label: "Volunteering", when: holds("Volunteer.Event.Read") },
    { href: "/staff/volunteer/credit", label: "Volunteer credit", when: holds("Volunteer.Credit.ReadWrite") },
  ] },
  { label: "Money", links: [
    { href: "/staff/balances", label: "Balances", when: holds("Finance.Balance.Read") },
    { href: "/staff/reconciliation", label: "Reconciliation", when: holds("Roster.Read") },
  ] },
];

/**
 * The staff menu for one person: Home, the groups that hold an entry for them, and Settings as one entry when they may
 * see any part of it (Staff, Roles, the audit log, Health and the design system are under Settings too). Each entry is
 * there only for someone who may open the page it leads to; a group with none is left out. Settings leads to the
 * Overview, or straight to someone's one item when they may not open the Overview (settingsHome()), and is current on
 * every page under /staff/settings. Pure, so the layout and the tests read the same menu.
 */
export function staffMenu(e: Effective): MenuEntry[] {
  const group = (label: string): MenuEntry[] => {
    const g = groups.find((x) => x.label === label)!;
    const links = g.links.filter((l) => l.when(e)).map(({ href, label: l }) => ({ href, label: l }));
    return links.length ? [{ kind: "group", label, links }] : [];
  };
  const settings = settingsHome(e);
  return [
    { kind: "link", href: "/staff", label: "Home" },
    ...group("Families"), ...group("Season"), ...group("Money"),
    ...(settings ? [{ kind: "link" as const, href: settings, label: "Settings", ...(settings === SETTINGS_ROOT ? {} : { section: SETTINGS_ROOT }) }] : []),
  ];
}

/** Every address in the menu, in its order. */
export const menuHrefs = (menu: MenuEntry[]): string[] => menu.flatMap((m) => (m.kind === "link" ? [m.href] : m.links.map((l) => l.href)));
