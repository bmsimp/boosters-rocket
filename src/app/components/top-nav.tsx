"use client";
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** "/" and "/staff" are section roots, so only an exact match marks them current; others match by prefix. */
const EXACT = new Set(["/", "/staff"]);

export function isCurrent(path: string, href: string) {
  return path === href || (!EXACT.has(href) && path.startsWith(`${href}/`));
}

type NavItem = { href: string; label: string };

export function TopNav({ nav, mobileMenu = false }: { nav: NavItem[]; mobileMenu?: boolean }) {
  const path = usePathname();
  // No links, no landmark: the sign-in pages carry the club bar with no menu, and an empty "Main" navigation would
  // only be announced to a screen reader with nothing in it.
  if (nav.length === 0) return null;
  return (
    <>
      <nav className="top-nav" aria-label="Main">
        {nav.map((n) => <Link key={n.href} href={n.href} aria-current={isCurrent(path, n.href) ? "page" : undefined}>{n.label}</Link>)}
      </nav>
      {mobileMenu && <MobileMenu nav={nav} path={path} />}
    </>
  );
}

/** The account control in the club bar: initials that lead to the Display page, marked current while that page is open (DESIGN.md). */
export function AccountLink({ href, initials, label }: { href: string; initials: string; label: string }) {
  const path = usePathname();
  return <Link className="account" href={href} aria-label={label} aria-current={isCurrent(path, href) ? "page" : undefined}>{initials}</Link>;
}

/**
 * On narrow screens the top menu is hidden. Parent pages use the bottom tabs; staff pages use this Menu button,
 * which opens the same links. It closes when a link is chosen or Escape is pressed.
 */
function MobileMenu({ nav, path }: { nav: NavItem[]; path: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="menu-mobile" onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      <button type="button" className="menu-button" aria-expanded={open} aria-controls="mobile-menu" onClick={() => setOpen((o) => !o)}>
        {open ? "Close" : "Menu"}
      </button>
      {open && (
        <nav id="mobile-menu" className="menu-panel" aria-label="Main">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} aria-current={isCurrent(path, n.href) ? "page" : undefined} onClick={() => setOpen(false)}>{n.label}</Link>
          ))}
        </nav>
      )}
    </div>
  );
}
