import type { ParentIdentity } from "@/lib/auth/resolve";
import { getClubSettings } from "@/lib/settings/club";
import { myFamilyNames } from "@/lib/parents/my-family-names";
import { ClubBar, PageStart, initials } from "./club-bar";
import { ParentTabs } from "./parent-tabs";
import { PARENT_NAV } from "./parent-nav";
import { PoweredBy } from "./powered-by";

/**
 * What surrounds every parent page: the club bar, the Switch family line for a person in more than one family, the
 * footer (the treasurer's address, and the "Powered by Boosters Rocket" badge) and the tabs. The parent layout and the not-found page both draw it, from the session's own identity.
 * Only the family being viewed is named, from the app's own record through the session's guardian row: the others are
 * listed on the chooser.
 */
export async function ParentFrame({ who, children }: { who: Pick<ParentIdentity, "name" | "parentId" | "guardianId" | "families">; children: React.ReactNode }) {
  const many = who.families.length > 1;
  const mine = initials(who.name);
  const [club, names] = await Promise.all([getClubSettings(), many ? myFamilyNames(who.parentId, who.families.map((f) => f.guardianId)) : null]);
  return (
    <>
      {/* The link's name starts with the initials it shows, so a person who says what they see ("click ZQ") reaches it (WCAG 2.5.3). */}
      <ClubBar name={club.name} shortName={club.shortName} nav={PARENT_NAV}
        account={{ href: "/display", initials: mine, label: `${mine}: Your account and display settings, ${who.name}` }} />
      {names && (
        <p className="wrap switch-family">Viewing {names.get(who.guardianId)}. <a href="/choose-family">Switch family</a></p>
      )}
      <PageStart />
      {children}
      <footer className="wrap">
        {club.treasurerEmail && <p>Questions about a charge? Email <a href={`mailto:${club.treasurerEmail}`}>{club.treasurerEmail}</a>.</p>}
        <PoweredBy />
      </footer>
      <ParentTabs />
    </>
  );
}
