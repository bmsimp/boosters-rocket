"use client";
import { Fragment, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { MenuEntry, MenuLink } from "@/app/staff/(app)/staff-menu";

/** "/" and "/staff" are section roots, so only an exact match marks them current; others match by prefix. */
const EXACT = new Set(["/", "/staff"]);

export function isCurrent(path: string, href: string) {
  return path === href || (!EXACT.has(href) && path.startsWith(`${href}/`));
}

/**
 * The one link of a menu that is current. Where two match, a section and a page inside it that has a link of its own
 * (/staff/seasons and /staff/seasons/progress), the longer address is the page the person is on.
 */
export function currentHref(path: string, hrefs: readonly string[]): string | null {
  return hrefs.filter((href) => isCurrent(path, href)).sort((a, b) => b.length - a.length)[0] ?? null;
}

type NavItem = { href: string; label: string };

/** The parent bar's links, in one row (the parent bar never wraps and has no groups). */
export function TopNav({ nav }: { nav: NavItem[] }) {
  const path = usePathname();
  // No links, no landmark: the sign-in pages carry the club bar with no menu, and an empty "Main" navigation would
  // only be announced to a screen reader with nothing in it.
  if (nav.length === 0) return null;
  const current = currentHref(path, nav.map((n) => n.href));
  return (
    <nav className="top-nav" aria-label="Main">
      {nav.map((n) => <Link key={n.href} href={n.href} aria-current={n.href === current ? "page" : undefined}>{n.label}</Link>)}
    </nav>
  );
}

/** The account control in the club bar: initials that lead to the Display page, marked current while that page is open. */
export function AccountLink({ href, initials, label }: { href: string; initials: string; label: string }) {
  const path = usePathname();
  return <Link className="account" href={href} aria-label={label} aria-current={isCurrent(path, href) ? "page" : undefined}>{initials}</Link>;
}

/** The address that marks an entry current: its section's where it has one (Settings, for every page under it), else its own. */
const currentKey = (l: MenuLink): string => l.section ?? l.href;
/** What marks each entry current: its section where it has one (Settings), else its address. */
const hrefsOf = (menu: MenuEntry[]) => menu.flatMap((m) => (m.kind === "link" ? [currentKey(m)] : m.links.map(currentKey)));

/** Each page's icon in the rail, by address: line icons in the tab bar's style. A page with none is drawn without one. */
const RAIL_ICONS: Record<string, ReactNode> = {
  "/staff": <path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z" />,
  "/staff/roster": <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  "/staff/parents": <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20c0-3 3-5 6-5s6 2 6 5M15 15c3 0 6 1.5 6 4" /></>,
  "/staff/links": <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  "/staff/messages": <path d="M4 5h16v11H8l-4 4z" />,
  "/staff/seasons": <><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  "/staff/seasons/progress": <path d="M5 12.5l4.5 4.5L19 7.5" />,
  "/staff/forms": <><path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
  "/staff/volunteer": <path d="M12 20s-8-4.6-8-10.2A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 8 2.4C20 15.4 12 20 12 20z" />,
  "/staff/volunteer/credit": <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  "/staff/balances": <path d="M12 3v18M17 7.5c0-1.9-2.2-3-5-3s-5 1.1-5 3 2.2 2.7 5 3.2 5 1.4 5 3.3-2.2 3-5 3-5-1.1-5-3" />,
  "/staff/reconciliation": <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M3 10h18M7 15h3" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" /></>,
};

function RailLink({ link, current, icon }: { link: MenuLink; current: string | null; icon?: ReactNode }) {
  return (
    <Link href={link.href} aria-current={currentKey(link) === current ? "page" : undefined}>
      {icon && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icon}</svg>}
      {link.label}
    </Link>
  );
}

/**
 * The staff menu from 1200px wide: M3's expanded navigation rail, always open (the owner's D5 of 2026-11-26). Home,
 * then each group's label (a name for its group, not a heading of the page) with every one of its pages under it, then Settings: nothing collapses and nothing opens on
 * hover. The page the person is on carries aria-current (the longer address where two match). Below 1200px the rail is
 * not drawn: the staff tab bar and the group hubs hold the menu.
 */
export function StaffRail({ menu }: { menu: MenuEntry[] }) {
  const path = usePathname();
  const current = currentHref(path, hrefsOf(menu));
  return (
    <nav className="staff-rail" aria-label="Main">
      {menu.map((m, i) => {
        if (m.kind === "link") {
          const settings = m.label === "Settings";
          return (
            <Fragment key={m.href}>
              {settings && i > 0 && <hr className="rail-rule" />}
              <RailLink link={m} current={current} icon={RAIL_ICONS[settings ? "settings" : m.href]} />
            </Fragment>
          );
        }
        const headingId = `staff-rail-${i}`;
        return (
          <div key={m.label} role="group" aria-labelledby={headingId} className="rail-section">
            <span id={headingId} className="rail-heading">{m.label}</span>
            {m.links.map((l) => <RailLink key={l.href} link={l} current={current} icon={RAIL_ICONS[l.href]} />)}
          </div>
        );
      })}
    </nav>
  );
}

/** Each group's icon on the compact rail: the icon of the page it stands for most (Parents, Seasons, Balances). */
const GROUP_ICONS: Record<string, string> = { Families: "/staff/parents", Season: "/staff/seasons", Money: "/staff/balances" };

/** One destination of the compact rail: Home, a group (leading to its first page) or Settings, and what marks it current. */
type Destination = { key: string; label: string; href: string; icon: ReactNode; owns: string[] };

/** The compact rail's destinations for one menu: one for each entry, a group's leading to its first page. */
export function compactDestinations(menu: MenuEntry[]): Destination[] {
  return menu.map((m): Destination => m.kind === "link"
    ? { key: m.label, label: m.label, href: m.href, icon: RAIL_ICONS[m.label === "Settings" ? "settings" : m.href], owns: [currentKey(m)] }
    : { key: m.label, label: m.label, href: m.links[0]!.href, icon: RAIL_ICONS[GROUP_ICONS[m.label] ?? ""], owns: m.links.map(currentKey) });
}

/**
 * The staff menu from 1200px on a page with a list pane of its own (Settings' list): M3's collapsed navigation rail,
 * one destination for Home, each group and Settings, the icon on its pill and the label always under it, with no
 * collapse button (the owner's decision of 2026-11-27). A group opens its first page, where the expanded rail is back.
 * The layout draws both rails; booster.css shows this one only where the page holds a list pane (`:has(.list-pane)`),
 * so the page's own shape decides, not a list of addresses. The current destination is the one holding the current page.
 */
export function CompactRail({ menu }: { menu: MenuEntry[] }) {
  const path = usePathname();
  const current = currentHref(path, hrefsOf(menu));
  return (
    <nav className="compact-rail" aria-label="Main">
      {compactDestinations(menu).map((d) => (
        <Link key={d.key} href={d.href} aria-current={current !== null && d.owns.includes(current) ? "page" : undefined}>
          <span className="compact-pill" aria-hidden="true">
            {d.icon && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d.icon}</svg>}
          </span>
          <span className="compact-label">{d.label}</span>
        </Link>
      ))}
    </nav>
  );
}
