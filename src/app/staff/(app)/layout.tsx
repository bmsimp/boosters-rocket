import { requireStaffPage } from "@/lib/guards";
import { getClubSettings } from "@/lib/settings/club";
import { ClubBar, PageStart, initials } from "../../components/club-bar";
import { PoweredBy } from "../../components/powered-by";
import { StaffTabs } from "../../components/parent-tabs";
import { GROUP_HUBS, staffMenu, staffTabs } from "./staff-menu";
import { HubBack } from "./hub-back";

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const [ctx, club] = await Promise.all([requireStaffPage(), getClubSettings()]);
  const menu = staffMenu(ctx.effective);
  // On a phone, a group's pages lead back to its hub, for a group with one (two pages or more for this person).
  const hubs = menu.flatMap((m) => (m.kind === "group" && m.links.length > 1 ? [{ hub: GROUP_HUBS[m.label]!, label: m.label, pages: m.links.map((l) => l.href) }] : []));
  return (
    <>
      <ClubBar name={club.name} shortName={club.shortName} menu={menu}
        account={{ href: "/staff/account", initials: initials(ctx.name), label: `${initials(ctx.name)}: Your account and display settings, signed in as ${ctx.name}` }} />
      <PageStart />
      <HubBack hubs={hubs} />
      {children}
      <footer className="wrap"><PoweredBy /></footer>
      <StaffTabs tabs={staffTabs(ctx.effective)} />
    </>
  );
}
