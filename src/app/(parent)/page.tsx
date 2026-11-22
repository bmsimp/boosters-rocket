import { requireParentPage } from "@/lib/guards";
import { loadMyFamily } from "@/lib/parents/my-family";
import { canChangeMyEmail } from "@/lib/parents/email-change";
import { firstName } from "@/lib/parents/first-name";
import { getClubSettings } from "@/lib/settings/club";
import { loadMySeason } from "@/lib/seasons/my-season";
import { Fragment } from "react";
import { DetailsBox, NotSetUpBox } from "./family-boxes";
import { loadFamilyMoney } from "@/lib/money/family-money";
import { loadMyBuyoutInvoices } from "@/lib/money/my-buyout-invoices";
import { HomeTotal } from "./money-box";
import { HomeStudents, HomeToDo } from "./home-parts";
import { SeasonRuler, currentStep } from "./season-parts";
import { LocalTime } from "../components/local-time";
import { passkeyOfferFor } from "@/lib/parents/passkey-offer";
import { PasskeyOffer } from "./passkey-offer";
import { PageHeader } from "../components/ui/page-header";

export const metadata = { title: "Home" };

/**
 * Home. The season ruler for the club's current season, then the family's name with one quiet line (the season's step
 * and when the money figures are from), then, in the order a phone shows them: To do (the open invoices with their
 * Pay, and what the current step still asks), the students with where each stands, the total owed once, and the
 * parent's own details. At 760px and wider the styles for `.home` put the lists on the left and the total and details
 * on the right. A family the portal may not show gets the greeting and the not-set-up box alone.
 *
 * Home is where everyone lands after signing in, so its guard carries no return address. That is why the passkey offer
 * (the sign-in release, slice SI-8) is here, after the heading and before the lists: drawn only in a session made in
 * the last 10 minutes by a sign-in that proved the password and a second step, to a person who may add a passkey with
 * one tap and holds none, at most once a month on a device and not after their third "Not now" (passkeyOfferFor(),
 * src/lib/parents/passkey-offer.ts). It is given only APP_URL's origin.
 */
export default async function ParentHome() {
  const ctx = await requireParentPage();
  const [family, club, ownEmail, offer] = await Promise.all([loadMyFamily(ctx), getClubSettings(), canChangeMyEmail(ctx), passkeyOfferFor(ctx)]);
  // The family's money first: a read that brings stale figures up to date is made before the season's payment lines
  // are worked out from the same row, so the money and those lines never disagree on one page.
  const money = family ? await loadFamilyMoney(ctx.familyId) : null;
  // A buy-out's invoice is named as such, from the family's own buy-outs only, as on Payments.
  const buyouts = money ? await loadMyBuyoutInvoices(ctx.familyId) : undefined;
  // The club's current season as it stands for this family: only for a family the portal may show, and null when no
  // season is current. With none there is no ruler, and nothing in its place.
  const season = family ? await loadMySeason(ctx) : null;
  const step = currentStep(season);
  if (!family) {
    const first = firstName(ctx.name);
    return (
      <main className="wrap home">
        <PageHeader className="home-head" title={first ? `Hi, ${first}` : "Hi"} />
        {offer.offered && <PasskeyOffer portalOrigin={offer.portalOrigin} />}
        {/* When the portal may not show the family, nothing of it is shown, money included. */}
        <NotSetUpBox treasurerEmail={club.treasurerEmail} />
      </main>
    );
  }
  const asOf = money?.figures?.asOf;
  const meta = [
    season && (step ? `${season.name} · ${step.name}` : season.name),
    asOf && <>Payments as of <LocalTime iso={asOf} /></>,
  ].filter(Boolean);
  return (
    <>
      {season && <SeasonRuler season={season} />}
      <main className="wrap home">
        <PageHeader className="home-head" title={family.name}
          lede={meta.length > 0 ? meta.map((m, i) => <Fragment key={i}>{i > 0 && <span aria-hidden="true"> · </span>}{m}</Fragment>) : undefined} />
        {offer.offered && <PasskeyOffer portalOrigin={offer.portalOrigin} />}
        <div className="home-lists">
          <HomeToDo money={money} buyouts={buyouts} season={season} students={family.students} />
          <HomeStudents students={family.students} season={season} />
        </div>
        <div className="home-side">
          {money && <HomeTotal money={money} buyouts={buyouts} />}
          <DetailsBox who={family.me} treasurerEmail={club.treasurerEmail} ownEmail={ownEmail && "family"} />
        </div>
      </main>
    </>
  );
}
