import { requireStaffPage } from "@/lib/guards";
import { getClubSettings } from "@/lib/settings/club";
import { ClubBar, PageStart, initials } from "../../components/club-bar";
import { PoweredBy } from "../../components/powered-by";
import { StaffTabs } from "../../components/parent-tabs";
import { CompactRail, StaffRail } from "../../components/top-nav";
import { GROUP_HUBS, staffMenu, staffTabs } from "./staff-menu";
import { HubBack } from "./hub-back";

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const [ctx, club] = await Promise.all([requireStaffPage(), getClubSettings()]);
  const menu = staffMenu(ctx.effective);
  // On a phone, a group's pages lead back to its hub, for a group with one (two pages or more for this person).
  const hubs = menu.flatMap((m) => (m.kind === "group" && m.links.length > 1 ? [{ hub: GROUP_HUBS[m.label]!, label: m.label, pages: m.links.map((l) => l.href) }] : []));
  return (
    <>
      <ClubBar name={club.name} shortName={club.shortName} staff
        account={{ href: "/staff/account", initials: initials(ctx.name), label: `${initials(ctx.name)}: Your account and display settings, signed in as ${ctx.name}` }} />
      {/* From 1200px the rail beside the page, in a pane (D5): the expanded rail, or the compact one on a page with a list
          pane of its own (booster.css picks by the page's shape); below it, the page alone and the tab bar. */}
      <div className="staff-frame">
        <StaffRail menu={menu} />
        <CompactRail menu={menu} />
        <div className="staff-pane">
          <PageStart />
          <HubBack hubs={hubs} />
          {children}
          <footer className="wrap"><PoweredBy /></footer>
        </div>
      </div>
      <StaffTabs tabs={staffTabs(ctx.effective)} />
    </>
  );
}
