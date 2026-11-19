import Link from "next/link";
import type { AppFamilyId } from "@/lib/families/ids";
import type { WorthALook as Look } from "@/lib/money/balances";
import { formatMoney } from "@/lib/money/cents";
import { DataTable } from "@/app/components/data-table";
import { LocalTime } from "@/app/components/local-time";
import { familyBalancePage } from "@/app/staff/(app)/family-pages";

type Row = { key: string; familyId: AppFamilyId | null; family: string; first: boolean; customer: string; balanceCents: number; invoicesCents: number; currency: string; checkedAt: string };

/**
 * The customers whose balance in QuickBooks isn't what their open invoices add up to, one row each, the two amounts side
 * by side. On Balances and on Reconciliation, for staff who may see money. Names are QuickBooks text, shown as text.
 */
export function WorthALook({ rows }: { rows: Look[] }) {
  const flat: Row[] = rows.flatMap((w) => w.customers.map((c, i) => ({ key: `${w.familyQboId}|${c.customerQboId}`, familyId: w.familyId, family: w.name, first: i === 0,
    customer: c.name ?? "The family itself", balanceCents: c.balanceCents, invoicesCents: c.invoicesCents, currency: c.currency, checkedAt: w.checkedAt })));
  return (
    <DataTable caption="Each customer's balance in QuickBooks beside its open invoices" captionHidden rows={flat} rowKey={(r) => r.key} columns={[
      { key: "family", header: "Family", rowHeader: true, cell: (r) => (r.familyId === null ? r.family : <Link href={familyBalancePage(r.familyId)}>{r.family}</Link>) },
      { key: "customer", header: "Customer", cell: (r) => r.customer },
      { key: "balance", header: "QuickBooks says", numeric: true, cell: (r) => formatMoney(r.balanceCents, r.currency) },
      { key: "invoices", header: "Open invoices", numeric: true, cell: (r) => formatMoney(r.invoicesCents, r.currency) },
      { key: "checked", header: "Checked", cell: (r) => <LocalTime iso={r.checkedAt} /> },
    ]} />
  );
}
