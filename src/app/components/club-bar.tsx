import { AccountLink, StaffNav, TopNav } from "./top-nav";
import type { MenuEntry } from "@/app/staff/(app)/staff-menu";

type NavItem = { href: string; label: string };

/** Where "Skip to the page" goes: the PageStart the frame puts just before the page's own content. */
const PAGE_START = "page-start";

/**
 * The club bar. Parent pages pass `nav`: a row of links, always one 56px row. Staff pages pass `menu` instead: grouped
 * entries (StaffNav) at 760px and wider, where the bar may take more than one row (`bar-rows`) should the entries need
 * it; on a phone the bar holds the club and the initials only, and the staff tab bar (StaffTabs) holds the menu. The sign-in pages pass an empty `nav`: the bar with no menu.
 *
 * A bar with links in it starts with "Skip to the page" (WCAG 2.4.1): the first Tab stop, drawn only while it has the
 * focus, which takes the keyboard past the bar to the PageStart its frame places. A bar with nothing to tab through
 * (the sign-in pages) has nothing to skip, and no link.
 */
export function ClubBar({ name, shortName, nav = [], menu, account }: {
  name: string; shortName: string; nav?: NavItem[]; menu?: MenuEntry[]; account?: { href: string; initials: string; label: string };
}) {
  const skippable = Boolean(menu?.length || nav.length || account);
  return (
    <header className={menu ? "bar bar-rows" : "bar"}>
      {skippable && <a className="skip-link" href={`#${PAGE_START}`}>Skip to the page</a>}
      <div className="wrap">
        <span className="monogram" aria-hidden="true">{shortName}</span>
        <span className="club">{name}</span>
        {menu ? <StaffNav menu={menu} /> : <TopNav nav={nav} />}
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
