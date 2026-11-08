import { requireParentPage } from "@/lib/guards";
import { getClubSettings } from "@/lib/settings/club";
import { ClubBar, initials } from "../components/club-bar";
import { ParentTabs } from "../components/parent-tabs";
import { PARENT_NAV } from "../components/parent-nav";

export default async function ParentLayout({ children }: { children: React.ReactNode }) {
  const [ctx, club] = await Promise.all([requireParentPage(), getClubSettings()]);
  return (
    <>
      <ClubBar name={club.name} shortName={club.shortName} nav={PARENT_NAV}
        account={{ href: "/display", initials: initials(ctx.name), label: `Your account and display settings, ${ctx.name}` }} />
      {children}
      <footer className="wrap">{club.treasurerEmail && <>Questions about a charge? Email <a href={`mailto:${club.treasurerEmail}`}>{club.treasurerEmail}</a>. </>}Runs on Booster Rocket.</footer>
      <ParentTabs />
    </>
  );
}
