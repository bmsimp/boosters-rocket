import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { writeAudit } from "@/lib/audit/log";
import { familyRecordAt } from "@/lib/families/address";
import type { StoredInvoice } from "@/lib/db/schema";
import { formatMoney } from "@/lib/money/cents";
import { loadFamilyBalance } from "@/lib/money/balances";
import { CalendarDate } from "@/app/components/calendar-date";
import { LocalTime } from "@/app/components/local-time";
import { Notice } from "@/app/components/notice";

export const metadata = { title: "Balances" };
export const dynamic = "force-dynamic";

// QuickBooks text (the invoice number, a name) only ever becomes a text node here, through React.
const invoiceName = (i: StoredInvoice) => `${i.number ? `Invoice ${i.number}` : "Invoice"}${i.forName ? `, ${i.forName}` : ""}`;

function InvoiceLine({ invoice, paid }: { invoice: StoredInvoice; paid: boolean }) {
  return (
    <li>
      <span>
        <span className="what">{invoiceName(invoice)}</span>
        {invoice.date && <span className="when">Invoice date <CalendarDate iso={invoice.date} /></span>}
        {!paid && invoice.dueDate && <span className="when">Due <CalendarDate iso={invoice.dueDate} /></span>}
        {!paid && invoice.balanceCents !== invoice.totalCents && <span className="when">{formatMoney(invoice.totalCents, invoice.currency)} in all, part paid</span>}
      </span>
      <span className="amount num">{formatMoney(paid ? invoice.totalCents : invoice.balanceCents, invoice.currency)}{paid && <span className="paid">Paid</span>}</span>
    </li>
  );
}

export default async function FamilyBalancePage({ params }: { params: Promise<{ familyId: string }> }) {
  const ctx = await requireStaffPage("Finance.Balance.Read");
  const { familyId } = await params;
  // The app's own family id (stage 3 of the app-owned families spec): anything that isn't a family record's answers 404.
  const record = await familyRecordAt(familyId);
  if (!record) notFound();
  const family = await loadFamilyBalance(record);
  if (!family) notFound();
  // A staff read of one family's balance and invoices (v1 spec §13): recorded before anything is shown, naming the app's family.
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "money.family.read", permission: "Finance.Balance.Read",
    targetType: "family", targetId: String(family.familyId), ip: ctx.ip });
  const f = family.figures;
  const total = f && f.currency !== null ? formatMoney(f.totalCents, f.currency) : null;
  return (
    <main className="wrap single">
      <h1 className="page-title">{family.name}</h1>
      <p className="lede">
        {family.members.length ? `With the invoices raised on ${family.members.join(", ")}. ` : ""}
        <Link href="/staff/balances">Back to Balances</Link>
      </p>

      <section className="box" aria-labelledby="owed-h"><h2 id="owed-h">Owed now</h2>
        {f === null ? <Notice tone="info">Nothing has been read from QuickBooks for this family yet, or its students have changed since. The next read of every family will show it.</Notice> : (
          <>
            <div className="owed">
              {total !== null && <div className="amt num">{total}</div>}
              <div className="asof">From QuickBooks, as of <LocalTime iso={f.readAt} />.</div>
            </div>
            {f.open.length === 0 ? <p className="paid-up">Nothing owed.</p> : (
              <>
                <ul className="lines">{f.open.map((i) => <InvoiceLine key={i.qboId} invoice={i} paid={false} />)}</ul>
                {total !== null ? <div className="sum"><span>Total</span><span className="num">{total}</span></div>
                  : <p className="help">These invoices are in more than one currency, so there is no single total.</p>}
              </>
            )}
            {f.credit && <p className="help">QuickBooks&apos; own balance for the family is lower than its invoices: it may hold a credit or a payment not yet applied.</p>}
          </>
        )}
        {family.failed && <Notice tone="warning" live="none">The last try to read this family didn&apos;t work (<LocalTime iso={family.failed.at} />{family.failed.code ? `, ${family.failed.code}` : ""}). These are the last figures QuickBooks gave.</Notice>}
      </section>

      {f !== null && (
        <section className="box" aria-labelledby="paid-h"><h2 id="paid-h">Paid in the last 12 months</h2>
          {f.paid.length === 0 ? <p>No paid invoices from the last 12 months.</p>
            : <ul className="lines">{f.paid.map((i) => <InvoiceLine key={i.qboId} invoice={i} paid />)}</ul>}
        </section>
      )}

      <section className="box" aria-labelledby="check-h"><h2 id="check-h">QuickBooks&apos; own balances</h2>
        {family.check === null ? <p>The worker hasn&apos;t compared this family&apos;s balances in QuickBooks with its invoices yet. It does at its daily read of every family.</p> : (
          <>
            <p>Each customer&apos;s balance in QuickBooks beside what its open invoices add up to, checked <LocalTime iso={family.check.at} />.</p>
            <ul className="lines">{family.check.customers.map((c) => (
              <li key={c.customerQboId}><span>
                <span className="what">{c.name ?? "The family itself"}</span>
                <span className="when">{c.balanceCents === c.invoicesCents ? "The same" : `Different: its open invoices add up to ${formatMoney(c.invoicesCents, c.currency)}`}</span>
              </span><span className="amount num">{formatMoney(c.balanceCents, c.currency)}</span></li>
            ))}</ul>
          </>
        )}
      </section>
    </main>
  );
}
