import Link from "next/link";
import { notFound } from "next/navigation";
import { requireParentPage } from "@/lib/guards";
import { findMyBuyout } from "@/lib/buyouts/my-buyouts";
import { BUYOUT_WORDS, perUnitWords, unitsWords } from "@/lib/buyouts/rules";
import { formatMoney } from "@/lib/money/cents";
import { loadMyFamily } from "@/lib/parents/my-family";
import { getClubSettings } from "@/lib/settings/club";
import { NotSetUpBox } from "../../../../family-boxes";
import { confirmBuyoutAction, switchBackAction } from "../../actions";
import { ConfirmBuyout, SwitchBack } from "../../pay-instead-forms";
import { Announcer } from "../../../../announce";

export const metadata = { title: "Pay instead of volunteering" };
export const dynamic = "force-dynamic";

/**
 * Paying instead of volunteering, for one requirement and one of the family's own (the family, or one student), and
 * switching back (v1 spec §11.5). The requirement and the choice in the address are untrusted: findMyBuyout() looks
 * them up within the session's family and the current season, and anything else answers 404. The amount is worked out
 * on the server, and the confirm works it out again.
 */
export default async function PayInsteadPage({ params }: { params: Promise<{ requirementId: string; choice: string }> }) {
  const { requirementId, choice } = await params;
  const ctx = await requireParentPage(`/volunteer/pay-instead/${encodeURIComponent(requirementId)}/${encodeURIComponent(choice)}`);
  const [family, club] = await Promise.all([loadMyFamily(ctx), getClubSettings()]);
  if (!family) {
    return <main className="wrap single"><h1 className="page-title">Pay instead of volunteering</h1><NotSetUpBox treasurerEmail={club.treasurerEmail} /></main>;
  }
  const found = await findMyBuyout(ctx, requirementId, choice);
  if (!found) notFound();
  const v = found.view;
  const forWhom = v.key === "family" ? "your family" : v.who;
  const b = v.buyout;
  return (
    <main className="wrap single volunteer-page">
      <h1 className="page-title">Pay instead of volunteering</h1>
      <p className="lede">{v.title}, for {forWhom}. <Link href="/volunteer">Back to Volunteer</Link></p>

      <section className="box" aria-labelledby="where-h"><h2 id="where-h">Where it stands</h2>
        <p className="state">{v.standing}</p>
        {v.refusedBefore && <p className="help">The last time, the club&apos;s invoice couldn&apos;t be set up, so nothing was billed. You can try again, or ask the club.</p>}
      </section>

      {/* The answer to a confirm or a switch-back outlives the section it was pressed in: the page redraws into another. */}
      <Announcer>
      {b ? (
        <section className="box" aria-labelledby="buyout-h"><h2 id="buyout-h">Your buy-out</h2>
          <p>{unitsWords(v.unit, b.units)} at {formatMoney(b.unitCents)} {perUnitWords(v.unit)}: <b className="num">{formatMoney(b.amountCents)}</b>.</p>
          {b.state === "being_invoiced" && <p>The club&apos;s invoice is being set up. It will be on your <Link href="/payments">Payments</Link> page soon, with a Pay button. Once it&apos;s there, you can switch back here if you change your mind.</p>}
          {b.clubLooking && b.state !== "paid" && !b.invoicePaid && <p>The club is looking at this invoice, so nothing can be changed here for now. You don&apos;t need to do anything; if you have questions, please ask the club.</p>}
          {b.state === "invoiced" && !b.invoicePaid && !b.clubLooking && <p>The invoice is on your <Link href="/payments">Payments</Link> page, with a Pay button. This is done once it&apos;s paid.</p>}
          {(b.state === "paid" || b.invoicePaid) && <p>{BUYOUT_WORDS.paid}. Thank you!</p>}
          {b.state === "being_voided" && <p>The invoice is being cancelled, so you don&apos;t need to pay it: it leaves your <Link href="/payments">Payments</Link> page once it is. You can sign up for shifts now.</p>}
          {b.state === "stuck" && <p>Something held this up, so it&apos;s waiting for the club to look at it. You don&apos;t need to do anything; if you have questions, please ask the club.</p>}
          {v.may === "switch_back" && (
            <>
              <h3>Changed your mind?</h3>
              <p>You can switch back to volunteering until the invoice is paid. The invoice is then cancelled, and nothing is owed for it.</p>
              <SwitchBack act={switchBackAction.bind(null, v.requirementId, v.key)} />
            </>
          )}
          {b.state === "invoiced" && b.invoicePaid && <p className="help">It&apos;s paid, so it can&apos;t be switched back here. If something isn&apos;t right, the club&apos;s treasurer can sort it out.</p>}
        </section>
      ) : v.quote.ok && v.stamp ? (
        <section className="box" aria-labelledby="cost-h"><h2 id="cost-h">What it costs</h2>
          <p>{unitsWords(v.unit, v.quote.units)} still to do, at {formatMoney(v.quote.unitCents)} {perUnitWords(v.unit)}{v.unit === "hours" ? ", rounded up to whole hours" : ""}:</p>
          <p className="buyout-amount num">{formatMoney(v.quote.amountCents)}</p>
          <h3>What happens when you confirm</h3>
          <ul className="buyout-points">
            <li>An invoice from the club for {formatMoney(v.quote.amountCents)} will appear on your Payments page, with a Pay button.</li>
            <li>The amount is fixed now: volunteering later doesn&apos;t lower it.</li>
            <li>You can switch back to volunteering until it&apos;s paid, and the invoice is then cancelled.</li>
          </ul>
          <ConfirmBuyout label={`Confirm: invoice me ${formatMoney(v.quote.amountCents)}`} act={confirmBuyoutAction.bind(null, v.requirementId, v.key, v.stamp)} />
        </section>
      ) : (
        <section className="box" aria-labelledby="cost-h"><h2 id="cost-h">Nothing to pay</h2>
          <p>{v.quote.ok || v.quote.why === "met" ? "This is done already, so there's nothing to pay. Thank you!" : "Paying instead isn't offered for this right now. If you'd like to, please ask the club."}</p>
        </section>
      )}
      </Announcer>
    </main>
  );
}
