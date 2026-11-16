import { AccountLink, StaffMobileMenu, StaffNav, TopNav } from "./top-nav";
import type { MenuEntry } from "@/app/staff/(app)/staff-menu";

type NavItem = { href: string; label: string };

/**
 * The club bar. Parent pages pass `nav`: a row of links, always one 56px row. Staff pages pass `menu` instead: grouped
 * entries (StaffNav), behind a Menu button on a phone, and at 760px and wider the bar may take more than one row
 * (`bar-rows`) should the entries need it. The sign-in pages pass an empty `nav`: the bar with no menu.
 */
export function ClubBar({ name, shortName, nav = [], menu, account }: {
  name: string; shortName: string; nav?: NavItem[]; menu?: MenuEntry[]; account?: { href: string; initials: string; label: string };
}) {
  return (
    <header className={menu ? "bar bar-rows" : "bar"}>
      <div className="wrap">
        <span className="monogram" aria-hidden="true">{shortName}</span>
        <span className="club">{name}</span>
        {menu ? <><StaffNav menu={menu} /><StaffMobileMenu menu={menu} /></> : <TopNav nav={nav} />}
        {account && <AccountLink href={account.href} initials={account.initials} label={account.label} />}
      </div>
    </header>
  );
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
