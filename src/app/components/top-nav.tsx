"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** "/" and "/staff" are section roots, so only an exact match marks them current; others match by prefix. */
const EXACT = new Set(["/", "/staff"]);

export function isCurrent(path: string, href: string) {
  return path === href || (!EXACT.has(href) && path.startsWith(`${href}/`));
}

export function TopNav({ nav }: { nav: { href: string; label: string }[] }) {
  const path = usePathname();
  return (
    <nav className="top-nav" aria-label="Main">
      {nav.map((n) => <Link key={n.href} href={n.href} aria-current={isCurrent(path, n.href) ? "page" : undefined}>{n.label}</Link>)}
    </nav>
  );
}
