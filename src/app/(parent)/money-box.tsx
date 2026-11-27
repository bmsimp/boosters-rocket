import type { ParentCtx } from "@/lib/guards";
import type { StoredInvoice } from "@/lib/db/schema";
import { formatMoney } from "@/lib/money/cents";
import { loadFamilyMoney, type FamilyMoney, type MoneyFigures } from "@/lib/money/family-money";
import { buyoutTitleOf, type MyBuyoutInvoices } from "@/lib/money/my-buyout-invoices";
import { CalendarDate } from "../components/calendar-date";
import { LocalTime } from "../components/local-time";
import { DueLine, dueTone } from "./due-line";
import { Card } from "../components/ui/card";
import { LinkButton } from "../components/ui/button";
import { List, ListRow, ListTotal } from "../components/ui/list";

/**
 * The money box (Payments' look): what the signed-in family owes, said beside its title, each open invoice as a row
 * with its Pay button over the total, and when QuickBooks gave the figures. A server component:
 *
 *   const ctx = await requireParentPage("/its-address");
 *   ...
 *   <MoneyBox ctx={ctx} />
 *
 * Home draws the same figures in its own parts below (InvoiceRows in its To do list, HomeTotal under its lists).
 * The family is ctx.familyId, from the session, and nothing else. It sends the browser only what it shows. A page
 * shows a family's money only when loadMyFamily() returns the family: Home and Payments both ask it first.
 */
export async function MoneyBox({ ctx }: { ctx: Pick<ParentCtx, "familyId"> }) {
  return <MoneySection money={await loadFamilyMoney(ctx.familyId)} more />;
}

// QuickBooks text (the invoice number, a name) only ever becomes a text node or an attribute value here, through React.
const invoiceName = (i: StoredInvoice) => `${i.number ? `Invoice ${i.number}` : "Invoice"}${i.forName ? `, ${i.forName}` : ""}`;
const payName = (i: StoredInvoice) => `${i.number ? `invoice ${i.number}` : "this invoice"}${i.forName ? ` for ${i.forName}` : ""}`;

/**
 * The note for figures that are not current, on Home over the To do list (where each Pay is paused in place) and in
 * the money box on Payments. Not current for many reasons, some of which last until a person acts (QuickBooks needs
 * connecting again), and some of which are not an outage at all (another read is under way). So the note says only
 * what is true of every one of them, and promises no time.
 */
export function NotCurrentNote() {
  return <p className="offline-note" role="status">We couldn&apos;t get the latest figures from QuickBooks just now. These are the last ones we have. Paying here is paused until we can. Need to pay sooner? Ask the treasurer.</p>;
}

/**
 * The rows for the open invoices (ListRow), on Home's To do list and in the money box on Payments: what each is, its
 * due line in words, the amount, and a compact Pay, with a ring before it in the tone of its due date. The soonest-due
 * one that can be paid is the primary Pay, the others secondary; while the figures are not current every Pay stays in
 * its place, paused, and says why in its accessible name. Home says the due date, or the invoice's date when it has
 * none; Payments (`dates="both"`) says both.
 */
export function InvoiceRows({ f, today, buyouts, dates = "one" }: { f: MoneyFigures; today: string; buyouts?: MyBuyoutInvoices; dates?: "one" | "both" }) {
  const first = f.open.find((i) => i.payLink !== null)?.qboId;
  return f.open.map((invoice) => {
    const amount = formatMoney(invoice.balanceCents, invoice.currency);
    const filled = invoice.qboId === first;
    const variant = filled ? "filled" : "tonal";
    const buyout = buyoutTitleOf(buyouts, invoice);
    const tone = dueTone(invoice.dueDate, today);
    const dated = invoice.date && <span className="when">Invoice date <CalendarDate iso={invoice.date} /></span>;
    return (
      <ListRow key={invoice.qboId} className="invoice-row" status={{ tone }} title={invoiceName(invoice)} amount={amount}
        meta={[
          invoice.dueDate ? <DueLine due={invoice.dueDate} today={today} /> : dated,
          dates === "both" && invoice.dueDate && dated,
          buyout && <span className="when">Paying instead of volunteering: {buyout}</span>,
        ]}
        action={invoice.payLink && (f.current ? (
          // A plain link in the same tab: an installed app opens it in the phone's in-app browser, with a way back.
          <LinkButton plain size="sm" variant={variant} className="pay" href={invoice.payLink} rel="noopener noreferrer" referrerPolicy="no-referrer" aria-label={`Pay ${amount}, ${payName(invoice)}`}>
            Pay{filled && <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>}
          </LinkButton>
        ) : (
          <LinkButton plain size="sm" variant={variant} className="pay" aria-disabled="true" role="link" aria-label={`Pay ${amount}, paused until the figures are up to date`}>Pay</LinkButton>
        ))} />
    );
  });
}

/** The thanks for a family that owes nothing. */
const PaidUp = () => (
  <p className="paid-up"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M4 12.5l5 5 11-11" /></svg>You&apos;re all paid up. Thank you!</p>
);

/**
 * Home's total: what the family owes said once, in tabular figures, with where and when the figures are from, what to
 * do about an invoice that can't be paid here, the paid-up thanks, and the way to Payments. With no figures it says so
 * in the same words as the money box on Payments: a family the club hasn't connected reads that, and nothing else.
 */
export function HomeTotal({ money, buyouts }: { money: FamilyMoney; buyouts?: MyBuyoutInvoices }) {
  const f = money.figures;
  if (!f) return <MoneySection money={money} buyouts={buyouts} more title="What you owe" />;
  const total = f.currency === null ? null : formatMoney(f.totalCents, f.currency);
  const payable = f.open.some((i) => i.payLink !== null);
  const unpayable = f.open.some((i) => i.payLink === null);
  return (
    <Card className="money" title="Total owed" titleId="money-h" headActions={total !== null && <span className="amt num">{total}</span>}
      actions={<LinkButton variant="outlined" href="/payments">See your payments</LinkButton>}>
      <p className="asof">{f.open.length ? "Owed now." : "Nothing owed."} From QuickBooks, as of <LocalTime iso={f.asOf} />.</p>
      {total === null && <p className="help">These invoices are in more than one currency, so there is no single total.</p>}
      {f.open.length > 0 ? (
        <p className="help">
          {payable && <>Each invoice opens on QuickBooks&apos; secure payment page. </>}
          {unpayable && <>No Pay button? The treasurer can tell you how to pay that one. </>}
          Need more time? Ask the treasurer. They&apos;re happy to work something out.
        </p>
      ) : (
        <PaidUp />
      )}
      {f.credit && <p className="help">The boosters may be holding a credit for you. Ask the treasurer how it will be used.</p>}
    </Card>
  );
}

/**
 * The money box's figures on Payments: when they are from, then each open invoice as a row (InvoiceRows, as on Home)
 * over its Total (ListTotal), then what to do about paying. The total itself is said beside the card's title.
 */
function Figures({ f, today, buyouts }: { f: MoneyFigures; today: string; buyouts?: MyBuyoutInvoices }) {
  const total = f.currency === null ? null : formatMoney(f.totalCents, f.currency);
  const payable = f.open.some((i) => i.payLink !== null);
  const unpayable = f.open.some((i) => i.payLink === null);
  return (
    <>
      <p className="asof">{f.open.length ? "Owed now." : "Nothing owed."} From QuickBooks, as of <LocalTime iso={f.asOf} />.</p>
      {!f.current && <NotCurrentNote />}
      {f.open.length > 0 ? (
        <>
          <List><InvoiceRows f={f} today={today} buyouts={buyouts} dates="both" /></List>
          {total !== null
            ? <ListTotal label="Total" amount={total} />
            : <p className="help">These invoices are in more than one currency, so there is no single total.</p>}
          <p className="help">
            {payable && <>Each invoice opens on QuickBooks&apos; secure payment page. </>}
            {unpayable && <>No Pay button? The treasurer can tell you how to pay that one. </>}
            Need more time? Ask the treasurer. They&apos;re happy to work something out.
          </p>
        </>
      ) : <PaidUp />}
      {f.credit && <p className="help">The boosters may be holding a credit for you. Ask the treasurer how it will be used.</p>}
    </>
  );
}

/**
 * What the family owes. `more` adds the way to the Payments page (on Home). `buyouts`, the family's own buy-out invoices
 * (loadMyBuyoutInvoices(ctx.familyId)), names each one as the volunteering buy-out it is.
 */
export function MoneySection({ money, more = false, buyouts, title }: { money: FamilyMoney; more?: boolean; buyouts?: MyBuyoutInvoices; title?: string }) {
  const f = money.figures;
  // The total, said once beside the title, in tabular figures: none for invoices in more than one currency.
  const total = f && f.currency !== null ? formatMoney(f.totalCents, f.currency) : null;
  return (
    <Card className="money" title={title ?? money.familyName ?? "What you owe"} titleId="money-h"
      headActions={total !== null && <span className="amt num">{total}</span>}
      actions={more && !money.notConnected && <LinkButton variant="outlined" href="/payments">See your payments</LinkButton>}>
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

/**
 * Invoices paid in the last 12 months (the Payments page): a row each, its "Paid" in words with the done ring, what it
 * was and its date, and what it came to. Nothing when there are no figures to show.
 */
export function PaidSection({ money, buyouts }: { money: FamilyMoney; buyouts?: MyBuyoutInvoices }) {
  if (!money.figures) return null;
  const { paid } = money.figures;
  return (
    <Card className="paid-box" title="Paid in the last 12 months" titleId="paid-h">
      {paid.length > 0 ? (
        <List>
          {paid.map((i) => {
            const buyout = buyoutTitleOf(buyouts, i);
            return (
              <ListRow key={i.qboId} status={{ tone: "done", words: "Paid" }} title={invoiceName(i)} amount={formatMoney(i.totalCents, i.currency)}
                meta={[i.date && <span className="when">Invoice date <CalendarDate iso={i.date} /></span>, buyout && <span className="when">Paying instead of volunteering: {buyout}</span>]} />
            );
          })}
        </List>
      ) : (
        <p className="help">No paid invoices from the last 12 months.</p>
      )}
    </Card>
  );
}
