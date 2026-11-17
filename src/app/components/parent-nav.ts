/**
 * The parent pages that exist, in tab order: the bottom tabs and the top nav list these and nothing else. Add a page
 * here when it is built (its icon is in parent-tabs.tsx); tests/unit/parent-nav.test.ts fails for a tab with no page.
 * Plain data module: keep client-only directives out so server components get the real array.
 */
export const PARENT_NAV: { href: string; label: string }[] = [
  { href: "/", label: "Home" },
  { href: "/forms", label: "Forms" },
  { href: "/payments", label: "Payments" },
  { href: "/volunteer", label: "Volunteer" },
  { href: "/family", label: "Family" },
];
