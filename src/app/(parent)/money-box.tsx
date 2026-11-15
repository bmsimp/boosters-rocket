import Link from "next/link";
import type { ParentCtx } from "@/lib/guards";
import type { StoredInvoice } from "@/lib/db/schema";
import { formatMoney } from "@/lib/money/cents";
import { loadFamilyMoney, type FamilyMoney, type MoneyFigures } from "@/lib/money/family-money";
import { CalendarDate } from "../components/calendar-date";
import { LocalTime } from "../components/local-time";
import { DueLine } from "./due-line";

/**
 * The money box for Home: what the signed-in family owes, each open invoice with its Pay button, and when QuickBooks
 * gave the figures. A server component, placed first on Home:
 *
 *   const ctx = await requireParentPage();
 *   ...
 *   <MoneyBox ctx={ctx} />
 *
 * The family is ctx.familyQboId, from the session, and nothing else. It sends the browser only what it shows.
 */
export async function MoneyBox({ ctx }: { ctx: Pick<ParentCtx, "familyQboId"> }) {
  return <MoneySection money={await loadFamilyMoney(ctx.familyQboId)} more />;
}

// QuickBooks text (the invoice number, a name) only ever becomes a text node or an attribute value here, through React.
const invoiceName = (i: StoredInvoice) => `${i.number ? `Invoice ${i.number}` : "Invoice"}${i.forName ? `, ${i.forName}` : ""}`;
const payName = (i: StoredInvoice) => `${i.number ? `invoice ${i.number}` : "this invoice"}${i.forName ? ` for ${i.forName}` : ""}`;

function OpenLine({ invoice, current, filled }: { invoice: StoredInvoice; current: boolean; filled: boolean }) {
  const amount = formatMoney(invoice.balanceCents, invoice.currency);
  const style = filled ? "btn pay" : "btn btn-line pay";
  return (
    <li>
      <span>
        <span className="what">{invoiceName(invoice)}</span>
        {invoice.date && <span className="when">Invoice date <CalendarDate iso={invoice.date} /></span>}
        {invoice.dueDate && <DueLine due={invoice.dueDate} />}
      </span>
      <span className="amount num">{amount}</span>
      {invoice.payLink && (current ? (
        // A plain link in the same tab: an installed app opens it in the phone's in-app browser, with a way back.
        <a className={style} href={invoice.payLink} rel="noopener noreferrer" referrerPolicy="no-referrer" aria-label={`Pay ${amount}, ${payName(invoice)}`}>
          Pay{filled && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>}
        </a>
      ) : (
        <a className={style} aria-disabled="true" role="link" aria-label={`Pay ${amount}, unavailable while QuickBooks is offline`}>Pay</a>
      ))}
    </li>
  );
}

function Figures({ f }: { f: MoneyFigures }) {
  const total = f.currency === null ? null : formatMoney(f.totalCents, f.currency);
  // QuickBooks pays one invoice at a time: the soonest-due one that can be paid gets the filled button.
  const first = f.open.find((i) => i.payLink !== null)?.qboId;
  const unpayable = f.open.some((i) => i.payLink === null);
  return (
    <>
      <div className="owed">
        {total !== null && <div className="amt num">{total}</div>}
        <div className="asof">{f.open.length ? "Owed now." : "Nothing owed."} From QuickBooks, as of <LocalTime iso={f.asOf} />.</div>
        {!f.current && <p className="offline-note" role="status">We can&apos;t reach QuickBooks right now. These are the last figures we have, and paying will work again shortly.</p>}
      </div>
      {f.open.length > 0 ? (
        <>
          <ul className="lines">
            {f.open.map((i) => <OpenLine key={i.qboId} invoice={i} current={f.current} filled={i.qboId === first} />)}
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

/** What the family owes. `more` adds the way to the Payments page (on Home). */
export function MoneySection({ money, more = false }: { money: FamilyMoney; more?: boolean }) {
  return (
    <section className="box money" aria-labelledby="money-h">
      <h2 id="money-h">{money.familyName ?? "What you owe"}</h2>
      {money.figures
        ? <Figures f={money.figures} />
        : <p className="help" role="status">We can&apos;t show what you owe right now. Please check back in a little while.</p>}
      {more && <div className="box-foot"><Link className="btn btn-line" href="/payments">See your payments</Link></div>}
    </section>
  );
}

/** Invoices paid in the last 12 months (the Payments page). Nothing when there are no figures to show. */
export function PaidSection({ money }: { money: FamilyMoney }) {
  if (!money.figures) return null;
  const { paid } = money.figures;
  return (
    <section className="box paid-box" aria-labelledby="paid-h">
      <h2 id="paid-h">Paid in the last 12 months</h2>
      {paid.length > 0 ? (
        <ul className="lines">
          {paid.map((i) => (
            <li key={i.qboId}>
              <span>
                <span className="what">{invoiceName(i)}</span>
                {i.date && <span className="when">Invoice date <CalendarDate iso={i.date} /></span>}
              </span>
              <span className="amount num">{formatMoney(i.totalCents, i.currency)}<span className="paid">Paid</span></span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="help">No paid invoices from the last 12 months.</p>
      )}
    </section>
  );
}
