import { AccountLink, TopNav } from "./top-nav";

type NavItem = { href: string; label: string };

/**
 * The club bar. `mobileMenu` is set on staff pages: on a phone their links are behind a Menu button, and at 760px and
 * wider the bar may take more than one row (`bar-rows`), because a staff menu can hold more links than a row has room
 * for. The parent bar is always one row.
 */
export function ClubBar({ name, shortName, nav, account, mobileMenu = false }: {
  name: string; shortName: string; nav: NavItem[]; mobileMenu?: boolean; account?: { href: string; initials: string; label: string };
}) {
  return (
    <header className={mobileMenu ? "bar bar-rows" : "bar"}>
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
