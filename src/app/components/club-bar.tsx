import { AccountLink, TopNav } from "./top-nav";

type NavItem = { href: string; label: string };

/** Where "Skip to the page" goes: the PageStart the frame puts just before the page's own content. */
const PAGE_START = "page-start";

/**
 * The club bar: M3's small top app bar, 64px, the club's logo tile (in its exact color), its name and the account.
 * Parent pages pass `nav`: their links, shown from 840px (one row; the tab bar below that). Staff pages pass `staff`:
 * their menu is the rail from 1200px and the staff tab bar below it, never the bar. The sign-in pages pass an empty `nav`:
 * the bar with no menu.
 *
 * A bar with links in it starts with "Skip to the page" (WCAG 2.4.1): the first Tab stop, drawn only while it has the
 * focus, which takes the keyboard past the bar (and the rail) to the PageStart its frame places. A bar with nothing to
 * tab through (the sign-in pages) has nothing to skip, and no link.
 */
export function ClubBar({ name, shortName, nav = [], staff = false, account }: {
  name: string; shortName: string; nav?: NavItem[]; staff?: boolean; account?: { href: string; initials: string; label: string };
}) {
  const skippable = Boolean(staff || nav.length || account);
  return (
    <header className={staff ? "bar bar-staff" : "bar"}>
      {skippable && <a className="skip-link" href={`#${PAGE_START}`}>Skip to the page</a>}
      <div className="wrap">
        <span className="monogram" aria-hidden="true">{shortName}</span>
        <span className="club">{name}</span>
        {!staff && <TopNav nav={nav} />}
        {account && <AccountLink href={account.href} initials={account.initials} label={account.label} />}
      </div>
    </header>
  );
}

/**
 * Where the skip link lands: just before the page's own content, after the bar and anything the frame keeps beside it
 * (the Switch family line). Not a control: the focus rests here, and the next Tab goes on into the page.
 */
export function PageStart() {
  return <div id={PAGE_START} className="page-start" tabIndex={-1} />;
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
