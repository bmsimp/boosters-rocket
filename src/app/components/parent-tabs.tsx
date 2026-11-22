"use client";
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { StaffTab } from "@/app/staff/(app)/staff-menu";
import { PARENT_NAV } from "./parent-nav";
import { isCurrent } from "./top-nav";

const HOME = <path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z" />;
const FAMILY = <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20c0-3 3-5 6-5s6 2 6 5M15 15c3 0 6 1.5 6 4" /></>;
const MONEY = <><rect x="3" y="6" width="18" height="12" /><path d="M3 10h18M7 15h3" /></>;

const ICONS: Record<string, ReactNode> = {
  "/": HOME,
  "/forms": <><path d="M6 3h9l3 3v15H6z" /><path d="M9 13l2 2 4-4" /></>,
  "/payments": MONEY,
  "/volunteer": <path d="M12 20s-8-4.6-8-10.2A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 8 2.4C20 15.4 12 20 12 20z" />,
  "/family": FAMILY,
};

const STAFF_ICONS: Record<StaffTab["key"], ReactNode> = {
  home: HOME,
  families: FAMILY,
  season: <><rect x="3" y="5" width="18" height="16" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  money: MONEY,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1" /></>,
};

/**
 * The bottom tab bar on a phone (`.tabs`, hidden from 760px, where the top nav takes its place): one column a tab, a
 * line icon over its label, the current one in the club's color and weight with its icon on the club's tint.
 */
function TabBar({ tabs, className }: { tabs: { href: string; label: string; icon: ReactNode; current: boolean }[]; className?: string }) {
  return (
    <nav className={className ? `tabs ${className}` : "tabs"} aria-label="Main">
      {tabs.map((t) => (
        <Link key={t.href} href={t.href} aria-current={t.current ? "page" : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">{t.icon}</svg>{t.label}
        </Link>
      ))}
    </nav>
  );
}

export function ParentTabs() {
  const path = usePathname();
  return <TabBar tabs={PARENT_NAV.map((t) => ({ href: t.href, label: t.label, icon: ICONS[t.href], current: isCurrent(path, t.href) }))} />;
}

/**
 * The staff tab bar on a phone, in place of the Menu button: Home, the groups the person has an entry in and Settings
 * (staffTabs()). A tab is current on its hub and on every page of its group; Home only on the staff home.
 */
export function StaffTabs({ tabs }: { tabs: StaffTab[] }) {
  const path = usePathname();
  const here = (t: StaffTab) => (t.exact ? t.owns.includes(path) : t.owns.some((o) => isCurrent(path, o)));
  return <TabBar className="staff-tabs" tabs={tabs.map((t) => ({ href: t.href, label: t.label, icon: STAFF_ICONS[t.key], current: here(t) }))} />;
}
