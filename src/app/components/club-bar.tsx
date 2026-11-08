import Link from "next/link";

type NavItem = { href: string; label: string; current?: boolean };

export function ClubBar({ name, shortName, nav, account }: {
  name: string; shortName: string; nav: NavItem[]; account?: { href: string; initials: string; label: string; current?: boolean };
}) {
  return (
    <header className="bar">
      <div className="wrap">
        <span className="monogram" aria-hidden="true">{shortName}</span>
        <span className="club">{name}</span>
        <nav className="top-nav" aria-label="Main">
          {nav.map((n) => <Link key={n.href} href={n.href} aria-current={n.current ? "page" : undefined}>{n.label}</Link>)}
        </nav>
        {account && <Link className="account" href={account.href} aria-label={account.label} aria-current={account.current ? "page" : undefined}>{account.initials}</Link>}
      </div>
    </header>
  );
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
