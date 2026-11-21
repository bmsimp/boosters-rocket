import { requireParentPage } from "@/lib/guards";
import { loadMyFamily } from "@/lib/parents/my-family";
import { canChangeMyEmail } from "@/lib/parents/email-change";
import { firstName } from "@/lib/parents/first-name";
import { getClubSettings } from "@/lib/settings/club";
import { loadMySeason } from "@/lib/seasons/my-season";
import { DetailsBox, FamilyStepBox, NotSetUpBox, StudentsBox } from "./family-boxes";
import { loadFamilyMoney } from "@/lib/money/family-money";
import { loadMyBuyoutInvoices } from "@/lib/money/my-buyout-invoices";
import { MoneySection } from "./money-box";
import { SeasonRuler } from "./season-parts";
import { passkeyOfferFor } from "@/lib/parents/passkey-offer";
import { PasskeyOffer } from "./passkey-offer";
import { PageHeader } from "../components/ui/page-header";

export const metadata = { title: "Home" };

/**
 * Home. The season ruler for the club's current season, the greeting, then boxes in the order a phone shows them: what
 * the family owes first, then its students (with where each stands in the current step) and the parent's own details.
 * The money box is headed with the family's name, as in design/reference/parent-home.html.
 * At 760px and wider the styles for `.home` put it on the left, with the students and details on the right.
 *
 * Home is where everyone lands after signing in, so its guard carries no return address. That is why the passkey offer
 * (the sign-in release, slice SI-8) is here, after the greeting and before the boxes: drawn only in a session made in
 * the last 10 minutes by a sign-in that proved the password and a second step, to a person who may add a passkey with
 * one tap and holds none, at most once a month on a device and not after their third "Not now" (passkeyOfferFor(),
 * src/lib/parents/passkey-offer.ts). It is given only APP_URL's origin.
 */
export default async function ParentHome() {
  const ctx = await requireParentPage();
  const [family, club, ownEmail, offer] = await Promise.all([loadMyFamily(ctx), getClubSettings(), canChangeMyEmail(ctx), passkeyOfferFor(ctx)]);
  // The family's money first: a read that brings stale figures up to date is made before the season's payment lines
  // are worked out from the same row, so the money box and those lines never disagree on one page.
  const money = family ? await loadFamilyMoney(ctx.familyId) : null;
  // A buy-out's invoice is named as such, from the family's own buy-outs only, as on Payments.
  const buyouts = money ? await loadMyBuyoutInvoices(ctx.familyId) : undefined;
  // The club's current season as it stands for this family: only for a family the portal may show, and null when no
  // season is current. With none there is no ruler, and nothing in its place.
  const season = family ? await loadMySeason(ctx) : null;
  const first = firstName(ctx.name);
  return (
    <>
      {season && <SeasonRuler season={season} />}
      <main className="wrap home">
        <PageHeader className="home-head" title={first ? `Hi, ${first}` : "Hi"} />
        {offer.offered && <PasskeyOffer portalOrigin={offer.portalOrigin} />}
        {family ? (
          <>
            {/* Only for a family the portal may show: when it may not, nothing of it is shown, money included. */}
            {money && <MoneySection money={money} buyouts={buyouts} more />}
            {family.students ? <StudentsBox students={family.students} season={season} /> : season && <FamilyStepBox season={season} />}
            <DetailsBox who={family.me} treasurerEmail={club.treasurerEmail} ownEmail={ownEmail && "family"} />
          </>
        ) : <NotSetUpBox treasurerEmail={club.treasurerEmail} />}
      </main>
    </>
  );
}
