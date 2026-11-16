import { requireParentPage } from "@/lib/guards";
import { loadMyFamily } from "@/lib/parents/my-family";
import { canChangeMyEmail } from "@/lib/parents/email-change";
import { firstName } from "@/lib/parents/first-name";
import { getClubSettings } from "@/lib/settings/club";
import { loadMySeason } from "@/lib/seasons/my-season";
import { DetailsBox, FamilyStepBox, NotSetUpBox, RosterAsOf, StudentsBox } from "./family-boxes";
import { loadFamilyMoney } from "@/lib/money/family-money";
import { MoneySection } from "./money-box";
import { SeasonRuler } from "./season-parts";

export const metadata = { title: "Home" };

/**
 * Home. The season ruler for the club's current season, the greeting, then boxes in the order a phone shows them: what
 * the family owes first, then its students (with where each stands in the current step) and the parent's own details.
 * The money box is headed with the family's name, as in design/reference/parent-home.html.
 * At 760px and wider the styles for `.home` put it on the left, with the students and details on the right.
 *
 * Home is where everyone lands after signing in, so its guard carries no return address.
 */
export default async function ParentHome() {
  const ctx = await requireParentPage();
  const [family, club, ownEmail] = await Promise.all([loadMyFamily(ctx), getClubSettings(), canChangeMyEmail(ctx)]);
  // The family's money first: a read that brings stale figures up to date is made before the season's payment lines
  // are worked out from the same row, so the money box and those lines never disagree on one page.
  const money = family ? await loadFamilyMoney(ctx.familyQboId) : null;
  // The club's current season as it stands for this family: only for a family the roster may show, and null when no
  // season is current. With none there is no ruler, and nothing in its place.
  const season = family ? await loadMySeason(ctx, family.students) : null;
  const first = firstName(ctx.name);
  return (
    <>
      {season && <SeasonRuler season={season} />}
      <main className="wrap home">
        <div className="home-head">
          <h1 className="page-title">{first ? `Hi, ${first}` : "Hi"}</h1>
        </div>
        {family ? (
          <>
            {/* Only for a family the roster may show: when it may not, nothing of it is shown, money included. */}
            {money && <MoneySection money={money} more />}
            {family.students ? <StudentsBox students={family.students} season={season} /> : season && <FamilyStepBox season={season} />}
            <DetailsBox who={family.me ?? { name: ctx.name, email: ctx.email, phone: null }} treasurerEmail={club.treasurerEmail} ownEmail={ownEmail && "family"} />
            <RosterAsOf family={family} />
          </>
        ) : <NotSetUpBox treasurerEmail={club.treasurerEmail} />}
      </main>
    </>
  );
}
