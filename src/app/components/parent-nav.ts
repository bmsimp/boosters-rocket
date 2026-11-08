/** Plain data module: keep client-only directives out so server components get the real array. */
export const PARENT_NAV: { href: string; label: string }[] = [
  { href: "/", label: "Home" },
  { href: "/forms", label: "Forms" },
  { href: "/payments", label: "Payments" },
  { href: "/family", label: "Family" },
];
