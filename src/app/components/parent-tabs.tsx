"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PARENT_NAV } from "./parent-nav";
import { isCurrent } from "./top-nav";

const ICONS: Record<string, React.ReactNode> = {
  "/": <path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z" />,
  "/forms": <><path d="M6 3h9l3 3v15H6z" /><path d="M9 13l2 2 4-4" /></>,
  "/payments": <><rect x="3" y="6" width="18" height="12" /><path d="M3 10h18M7 15h3" /></>,
  "/volunteer": <path d="M12 20s-8-4.6-8-10.2A4.3 4.3 0 0 1 12 7.4a4.3 4.3 0 0 1 8 2.4C20 15.4 12 20 12 20z" />,
  "/family": <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20c0-3 3-5 6-5s6 2 6 5M15 15c3 0 6 1.5 6 4" /></>,
};

export function ParentTabs() {
  const path = usePathname();
  return (
    <nav className="tabs" aria-label="Main">
      {PARENT_NAV.map((t) => (
        <Link key={t.href} href={t.href} aria-current={isCurrent(path, t.href) ? "page" : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">{ICONS[t.href]}</svg>{t.label}
        </Link>
      ))}
    </nav>
  );
}
