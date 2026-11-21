import type { ParentCtx } from "@/lib/guards";
import type { StoredInvoice } from "@/lib/db/schema";
import { formatMoney } from "@/lib/money/cents";
import { loadFamilyMoney, type FamilyMoney, type MoneyFigures } from "@/lib/money/family-money";
import { buyoutTitleOf, type MyBuyoutInvoices } from "@/lib/money/my-buyout-invoices";
import { CalendarDate } from "../components/calendar-date";
import { LocalTime } from "../components/local-time";
import { DueLine } from "./due-line";
import { Card } from "../components/ui/card";
import { LinkButton } from "../components/ui/button";

/**
 * The money box for Home: what the signed-in family owes, each open invoice with its Pay button, and when QuickBooks
 * gave the figures. A server component, placed first on Home:
 *
 *   const ctx = await requireParentPage();
 *   ...
 *   <MoneyBox ctx={ctx} />
 *
 * The family is ctx.familyId, from the session, and nothing else. It sends the browser only what it shows. A page
 * shows a family's money only when loadMyFamily() returns the family: Home and Payments both ask it first.
 */
export async function MoneyBox({ ctx }: { ctx: Pick<ParentCtx, "familyId"> }) {
  return <MoneySection money={await loadFamilyMoney(ctx.familyId)} more />;
}

// QuickBooks text (the invoice number, a name) only ever becomes a text node or an attribute value here, through React.
const invoiceName = (i: StoredInvoice) => `${i.number ? `Invoice ${i.number}` : "Invoice"}${i.forName ? `, ${i.forName}` : ""}`;
const payName = (i: StoredInvoice) => `${i.number ? `invoice ${i.number}` : "this invoice"}${i.forName ? ` for ${i.forName}` : ""}`;

/** Under an invoice the portal made for one of the family's own buy-outs: what it pays for. Payments passes them (loadMyBuyoutInvoices). */
function BuyoutLine({ title }: { title: string | null }) {
  return title ? <span className="when">Paying instead of volunteering: {title}</span> : null;
}

function OpenLine({ invoice, today, current, filled, buyouts }: { invoice: StoredInvoice; today: string; current: boolean; filled: boolean; buyouts?: MyBuyoutInvoices }) {
  const amount = formatMoney(invoice.balanceCents, invoice.currency);
  // The soonest-due invoice that can be paid is the primary button, the others secondary (their class: "btn pay", "btn btn-line pay").
  const variant = filled ? "primary" : "secondary";
  return (
    <li>
      <span>
        <span className="what">{invoiceName(invoice)}</span>
        <BuyoutLine title={buyoutTitleOf(buyouts, invoice)} />
        {invoice.date && <span className="when">Invoice date <CalendarDate iso={invoice.date} /></span>}
        {invoice.dueDate && <DueLine due={invoice.dueDate} today={today} />}
      </span>
      <span className="amount num">{amount}</span>
      {invoice.payLink && (current ? (
        // A plain link in the same tab: an installed app opens it in the phone's in-app browser, with a way back.
        <LinkButton plain variant={variant} className="pay" href={invoice.payLink} rel="noopener noreferrer" referrerPolicy="no-referrer" aria-label={`Pay ${amount}, ${payName(invoice)}`}>
          Pay{filled && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>}
        </LinkButton>
      ) : (
        <LinkButton plain variant={variant} className="pay" aria-disabled="true" role="link" aria-label={`Pay ${amount}, paused until the figures are up to date`}>Pay</LinkButton>
      ))}
    </li>
  );
}

function Figures({ f, today, buyouts }: { f: MoneyFigures; today: string; buyouts?: MyBuyoutInvoices }) {
  const total = f.currency === null ? null : formatMoney(f.totalCents, f.currency);
  // QuickBooks pays one invoice at a time: the soonest-due one that can be paid gets the filled button.
  const first = f.open.find((i) => i.payLink !== null)?.qboId;
  const unpayable = f.open.some((i) => i.payLink === null);
  return (
    <>
      <div className="owed">
        {total !== null && <div className="amt num">{total}</div>}
        <div className="asof">{f.open.length ? "Owed now." : "Nothing owed."} From QuickBooks, as of <LocalTime iso={f.asOf} />.</div>
        {/* Not current for many reasons, some of which last until a person acts (QuickBooks needs connecting again), and
            some of which are not an outage at all (another read is under way). So the note says only what is true of
            every one of them, and promises no time. */}
        {!f.current && <p className="offline-note" role="status">We couldn&apos;t get the latest figures from QuickBooks just now. These are the last ones we have. Paying here is paused until we can. Need to pay sooner? Ask the treasurer.</p>}
      </div>
      {f.open.length > 0 ? (
        <>
          <ul className="lines">
            {f.open.map((i) => <OpenLine key={i.qboId} invoice={i} today={today} current={f.current} filled={i.qboId === first} buyouts={buyouts} />)}
          </ul>
          {total !== null
            ? <div className="sum"><span>Total</span><span className="num">{total}</span></div>
            : <p className="help">These invoices are in more than one currency, so there is no single total.</p>}
          <p className="help">
            {first !== undefined && <>Each invoice opens on QuickBooks&apos; secure payment page. </>}
            {unpayable && <>An invoice with no Pay button can&apos;t be paid online. The treasurer can tell you how to pay it. </>}
            Need more time? Ask the treasurer. They&apos;re happy to work something out.
          </p>
        </>
      ) : (
        <p className="paid-up"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M4 12.5l5 5 11-11" /></svg>You&apos;re all paid up. Thank you!</p>
      )}
      {f.credit && <p className="help">The boosters may be holding a credit for you. The treasurer can tell you how it will be applied.</p>}
    </>
  );
}

/**
 * What the family owes. `more` adds the way to the Payments page (on Home). `buyouts`, the family's own buy-out invoices
 * (loadMyBuyoutInvoices(ctx.familyId)), names each one as the volunteering buy-out it is.
 */
export function MoneySection({ money, more = false, buyouts }: { money: FamilyMoney; more?: boolean; buyouts?: MyBuyoutInvoices }) {
  return (
    <Card className="money" title={money.familyName ?? "What you owe"} titleId="money-h"
      actions={more && !money.notConnected && <LinkButton variant="secondary" href="/payments">See your payments</LinkButton>}>
      {money.figures
        ? <Figures f={money.figures} today={money.today} buyouts={buyouts} />
        : money.notConnected
          // A family with no link to the club's books: no figures, no Pay, and no reason given beyond the plain fact.
          // The way to Payments is left off, since it would show only these words again.
          ? <p className="help" role="status">The club hasn&apos;t connected your payments to the portal yet. Until then, the treasurer can tell you what you owe.</p>
          : <p className="help" role="status">We can&apos;t show what you owe right now. Please check back in a little while.</p>}
    </Card>
  );
}

/** Invoices paid in the last 12 months (the Payments page). Nothing when there are no figures to show. */
export function PaidSection({ money, buyouts }: { money: FamilyMoney; buyouts?: MyBuyoutInvoices }) {
  if (!money.figures) return null;
  const { paid } = money.figures;
  return (
    <Card className="paid-box" title="Paid in the last 12 months" titleId="paid-h">
      {paid.length > 0 ? (
        <ul className="lines">
          {paid.map((i) => (
            <li key={i.qboId}>
              <span>
                <span className="what">{invoiceName(i)}</span>
                <BuyoutLine title={buyoutTitleOf(buyouts, i)} />
                {i.date && <span className="when">Invoice date <CalendarDate iso={i.date} /></span>}
              </span>
              <span className="amount num">{formatMoney(i.totalCents, i.currency)}<span className="paid">Paid</span></span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="help">No paid invoices from the last 12 months.</p>
      )}
    </Card>
  );
}
