import { requireStaffPage } from "@/lib/guards";
import { getClubSettings } from "@/lib/settings/club";
import { ClubBar, initials } from "../../components/club-bar";
import { staffMenu } from "./staff-menu";

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const [ctx, club] = await Promise.all([requireStaffPage(), getClubSettings()]);
  return (
    <>
      <ClubBar name={club.name} shortName={club.shortName} menu={staffMenu(ctx.effective)}
        account={{ href: "/staff", initials: initials(ctx.name), label: `${initials(ctx.name)}: Staff home, signed in as ${ctx.name}` }} />
      {children}
    </>
  );
}
