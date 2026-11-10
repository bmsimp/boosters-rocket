import { requireParentPage } from "@/lib/guards";
import { getClubSettings } from "@/lib/settings/club";
import { ClubBar, initials } from "../components/club-bar";
import { ParentTabs } from "../components/parent-tabs";
import { familyLabel } from "../components/family-label";
import { PARENT_NAV } from "../components/parent-nav";

export default async function ParentLayout({ children }: { children: React.ReactNode }) {
  const [ctx, club] = await Promise.all([requireParentPage(), getClubSettings()]);
  return (
    <>
      <ClubBar name={club.name} shortName={club.shortName} nav={PARENT_NAV}
        account={{ href: "/display", initials: initials(ctx.name), label: `Your account and display settings, ${ctx.name}` }} />
      {ctx.families.length > 1 && (
        <p className="wrap switch-family">Viewing {familyLabel(ctx.familyQboId)}. <a href="/choose-family">Switch family</a></p>
      )}
      {children}
      <footer className="wrap">{club.treasurerEmail && <>Questions about a charge? Email <a href={`mailto:${club.treasurerEmail}`}>{club.treasurerEmail}</a>. </>}Runs on Booster Rocket.</footer>
      <ParentTabs />
    </>
  );
}
