import { requireStaffPage } from "@/lib/guards";
import { getClubSettings } from "@/lib/settings/club";
import { ClubBar, PageStart, initials } from "../../components/club-bar";
import { staffMenu } from "./staff-menu";

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const [ctx, club] = await Promise.all([requireStaffPage(), getClubSettings()]);
  return (
    <>
      <ClubBar name={club.name} shortName={club.shortName} menu={staffMenu(ctx.effective)}
        account={{ href: "/staff/account", initials: initials(ctx.name), label: `${initials(ctx.name)}: Your account and display settings, signed in as ${ctx.name}` }} />
      <PageStart />
      {children}
    </>
  );
}
