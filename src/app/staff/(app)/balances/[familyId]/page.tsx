import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { writeAudit } from "@/lib/audit/log";
import { familyRecordAt } from "@/lib/families/address";
import type { StoredInvoice } from "@/lib/db/schema";
import { formatMoney } from "@/lib/money/cents";
import { loadFamilyBalance } from "@/lib/money/balances";
import { CalendarDate, Card, List, ListRow, ListTotal, LocalTime, Notice, PageHeader } from "@/app/components/ui";

export const metadata = { title: "Balances" };
export const dynamic = "force-dynamic";

// QuickBooks text (the invoice number, a name) only ever becomes a text node here, through React.
const invoiceName = (i: StoredInvoice) => `${i.number ? `Invoice ${i.number}` : "Invoice"}${i.forName ? `, ${i.forName}` : ""}`;

/** One invoice as a row: what it is, its dates (and that it is part paid) on the meta line, and its amount; a paid one says "Paid" first, in the done tone. */
function InvoiceLine({ invoice, paid }: { invoice: StoredInvoice; paid: boolean }) {
  return (
    <ListRow status={paid ? { tone: "done", words: "Paid" } : undefined} title={invoiceName(invoice)} meta={[
      invoice.date && <>Invoice date <CalendarDate iso={invoice.date} /></>,
      !paid && invoice.dueDate && <>Due <CalendarDate iso={invoice.dueDate} /></>,
      !paid && invoice.balanceCents !== invoice.totalCents && `${formatMoney(invoice.totalCents, invoice.currency)} in all, part paid`,
    ]} amount={formatMoney(paid ? invoice.totalCents : invoice.balanceCents, invoice.currency)} />
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
      <PageHeader title={family.name} back={{ href: "/staff/balances", label: "Back to Balances" }}
        lede={family.members.length ? `With the invoices raised on ${family.members.join(", ")}.` : undefined} />

      <Card className="money" title="Owed now" titleId="owed-h" headActions={f !== null && total !== null && <span className="amt num">{total}</span>}>
        {f === null ? <Notice tone="info">Nothing has been read from QuickBooks for this family yet, or its students have changed since. The next read of every family will show it.</Notice> : (
          <>
            <p className="asof">From QuickBooks, as of <LocalTime iso={f.readAt} />.</p>
            {f.open.length === 0 ? <p className="paid-up">Nothing owed.</p> : (
              <>
                <List>{f.open.map((i) => <InvoiceLine key={i.qboId} invoice={i} paid={false} />)}</List>
                {total !== null ? <ListTotal label="Total" amount={total} />
                  : <p className="help">These invoices are in more than one currency, so there is no single total.</p>}
              </>
            )}
            {f.credit && <p className="help">QuickBooks&apos; own balance for the family is lower than its invoices: it may hold a credit or a payment not yet applied.</p>}
          </>
        )}
        {family.failed && <Notice tone="warning" live="none">The last try to read this family didn&apos;t work (<LocalTime iso={family.failed.at} />{family.failed.code ? `, ${family.failed.code}` : ""}). These are the last figures QuickBooks gave.</Notice>}
      </Card>

      {f !== null && (
        <Card title="Paid in the last 12 months" titleId="paid-h">
          {f.paid.length === 0 ? <p>No paid invoices from the last 12 months.</p>
            : <List>{f.paid.map((i) => <InvoiceLine key={i.qboId} invoice={i} paid />)}</List>}
        </Card>
      )}

      <Card title={<>QuickBooks&apos; own balances</>} titleId="check-h">
        {family.check === null ? <p>The worker hasn&apos;t compared this family&apos;s balances in QuickBooks with its invoices yet. It does at its daily read of every family.</p> : (
          <>
            <p>Each customer&apos;s balance in QuickBooks beside what its open invoices add up to, checked <LocalTime iso={family.check.at} />.</p>
            <List>{family.check.customers.map((c) => (
              <ListRow key={c.customerQboId} status={{ tone: c.balanceCents === c.invoicesCents ? "done" : "due" }} title={c.name ?? "The family itself"}
                meta={c.balanceCents === c.invoicesCents ? "The same" : `Different: its open invoices add up to ${formatMoney(c.invoicesCents, c.currency)}`}
                amount={formatMoney(c.balanceCents, c.currency)} />
            ))}</List>
          </>
        )}
      </Card>
    </main>
  );
}
