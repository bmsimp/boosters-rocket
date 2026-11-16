"use client";
import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { MenuEntry } from "@/app/staff/(app)/staff-menu";

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

/** The account control in the club bar: initials that lead to the Display page, marked current while that page is open (DESIGN.md). */
export function AccountLink({ href, initials, label }: { href: string; initials: string; label: string }) {
  const path = usePathname();
  return <Link className="account" href={href} aria-label={label} aria-current={isCurrent(path, href) ? "page" : undefined}>{initials}</Link>;
}

const hrefsOf = (menu: MenuEntry[]) => menu.flatMap((m) => (m.kind === "link" ? [m.href] : m.links.map((l) => l.href)));
const groupId = (i: number) => `staff-menu-${i}`;

/**
 * The staff menu at 760px and wider: Home, Settings and the other single entries as links, and each group as a button
 * that opens its links below it (a disclosure: aria-expanded says whether it is open). Nothing opens on hover. A group
 * closes when one of its links is chosen, on Escape (focus goes back to its button), when focus is tabbed out of it, and
 * when the pointer goes down anywhere outside the menu. One group is open at a time. The group that holds the page the
 * person is on is marked, and the link itself carries aria-current. Closed groups' links are in the page but hidden.
 */
export function StaffNav({ menu }: { menu: MenuEntry[] }) {
  const path = usePathname();
  const current = currentHref(path, hrefsOf(menu));
  const [open, setOpen] = useState<number | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (open === null) return;
    const away = (ev: PointerEvent) => { if (!navRef.current?.contains(ev.target as Node)) setOpen(null); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const onKey = (i: number) => (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && open === i) { ev.preventDefault(); setOpen(null); buttons.current[i]?.focus(); }
  };
  // Only a focus that lands somewhere else closes the group: a click on a link in it, in a browser that doesn't focus
  // links on click, blurs with nowhere to go, and must not close the group before the click arrives.
  const onBlur = (i: number) => (ev: FocusEvent<HTMLDivElement>) => {
    const to = ev.relatedTarget as Node | null;
    if (to && !ev.currentTarget.contains(to) && open === i) setOpen(null);
  };
  return (
    <nav className="top-nav" aria-label="Main" ref={navRef}>
      {menu.map((m, i) => {
        if (m.kind === "link") return <Link key={m.href} href={m.href} aria-current={m.href === current ? "page" : undefined}>{m.label}</Link>;
        const here = m.links.some((l) => l.href === current);
        const isOpen = open === i;
        return (
          <div key={m.label} className="nav-group" onKeyDown={onKey(i)} onBlur={onBlur(i)}>
            <button type="button" ref={(b) => { buttons.current[i] = b; }} className={here ? "nav-group-button here" : "nav-group-button"}
              aria-expanded={isOpen} aria-controls={groupId(i)} onClick={() => setOpen(isOpen ? null : i)}>
              {m.label}{here && <span className="visually-hidden">, current section</span>}
              <svg className="nav-caret" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
            </button>
            <div id={groupId(i)} className="nav-panel" hidden={!isOpen}>
              {m.links.map((l) => (
                <Link key={l.href} href={l.href} aria-current={l.href === current ? "page" : undefined} onClick={() => setOpen(null)}>{l.label}</Link>
              ))}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

/**
 * On narrow screens the top menu is hidden. Parent pages use the bottom tabs; staff pages use this Menu button, which
 * opens the same entries, each group under its name. It closes when a link is chosen or Escape is pressed.
 */
export function StaffMobileMenu({ menu }: { menu: MenuEntry[] }) {
  const path = usePathname();
  const current = currentHref(path, hrefsOf(menu));
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const link = (l: NavItem) => (
    <Link key={l.href} href={l.href} aria-current={l.href === current ? "page" : undefined} onClick={() => setOpen(false)}>{l.label}</Link>
  );
  return (
    <div className="menu-mobile" onKeyDown={(e) => { if (e.key === "Escape" && open) { setOpen(false); button.current?.focus(); } }}>
      <button ref={button} type="button" className="menu-button" aria-expanded={open} aria-controls="mobile-menu" onClick={() => setOpen((o) => !o)}>
        {open ? "Close" : "Menu"}
      </button>
      {open && (
        <nav id="mobile-menu" className="menu-panel" aria-label="Main">
          {menu.map((m, i) => m.kind === "link" ? link(m) : (
            <div key={m.label} className="menu-group" role="group" aria-labelledby={`mobile-group-${i}`}>
              <p id={`mobile-group-${i}`} className="menu-group-name">{m.label}</p>
              {m.links.map(link)}
            </div>
          ))}
        </nav>
      )}
    </div>
  );
}
