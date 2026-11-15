import { AccountLink, TopNav } from "./top-nav";

type NavItem = { href: string; label: string };

export function ClubBar({ name, shortName, nav, account, mobileMenu = false }: {
  name: string; shortName: string; nav: NavItem[]; mobileMenu?: boolean; account?: { href: string; initials: string; label: string };
}) {
  return (
    <header className="bar">
      <div className="wrap">
        <span className="monogram" aria-hidden="true">{shortName}</span>
        <span className="club">{name}</span>
        <TopNav nav={nav} mobileMenu={mobileMenu} />
        {account && <AccountLink href={account.href} initials={account.initials} label={account.label} />}
      </div>
    </header>
  );
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
