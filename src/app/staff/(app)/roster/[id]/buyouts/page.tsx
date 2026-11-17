import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import { loadFamilyBuyouts, type FamilyBuyout } from "@/lib/buyouts/staff";
import { formatMoney } from "@/lib/money/cents";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { LocalTime } from "@/app/components/local-time";
import { DataTable, type Column } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
import { closeBuyoutAction } from "../../../reconciliation/buyout-actions";
import { CloseBuyout } from "../../../reconciliation/close-buyout";

export const metadata = { title: "Buy-outs" };
export const dynamic = "force-dynamic";

const ID_MAX = 64;

/** What the family's figures last said of the invoice, in words; what is owed on it only to staff who may see money. */
function InvoiceWords({ b, money }: { b: FamilyBuyout; money: boolean }) {
  const i = b.invoice;
  const owed = money && i.owedCents !== null ? `: ${formatMoney(i.owedCents)} ${i.kind === "part_paid" ? "still owed" : "owed"}` : "";
  const words = { none: b.state === "refused" ? "None: nothing was billed" : "None made yet", not_read: "Not in the family's figures as last read", open: `Open${owed}`,
    part_paid: `Part paid${owed}`, paid: "Paid", voided: "Voided" }[i.kind];
  return <>{words}{i.readAt ? <span className="when">Read from QuickBooks <LocalTime iso={i.readAt} /></span> : null}</>;
}

/**
 * One family's volunteer buy-outs, every state (v1 spec §11.5): the requirement and who it was for, the amount for
 * staff who may see money, how it stands, its invoice as the family's figures last showed it, and, for staff who may
 * change the roster, a close where no unpaid invoice of it stands (src/lib/buyouts/closing.ts). Reached from the
 * family's roster page and from each buy-out on Reconciliation. A staff read of one family's data: audited before
 * anything is shown. Names are QuickBooks text, shown as text only.
 */
export default async function FamilyBuyoutsPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireStaffPage("Roster.Read");
  const { id } = await params;
  let qboId: string;
  try { qboId = decodeURIComponent(id); } catch { notFound(); }
  if (qboId.length === 0 || qboId.length > ID_MAX) notFound();
  // The tag first: the buy-outs shown are that company's or a later one's, never an earlier one's.
  const rosterTag = await currentRosterTag();
  const { familyName, buyouts } = await loadFamilyBuyouts(qboId);
  if (familyName === null && buyouts.length === 0) notFound();
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "volunteer.buyout.family.read", permission: "Roster.Read",
    targetType: "qbo_customer", targetId: qboId, ip: ctx.ip });
  const money = can(ctx.effective, "Finance.Balance.Read");
  const canChange = can(ctx.effective, "Roster.Family.ReadWrite");
  const columns: Column<FamilyBuyout>[] = [
    { key: "requirement", header: "Requirement", rowHeader: true, cell: (b) => <>{b.requirement}<span className="when">{b.subjectName ? `For ${b.subjectName}` : "For the family"}</span></> },
    ...(money ? [{ key: "amount", header: "Amount", numeric: true, cell: (b: FamilyBuyout) => formatMoney(b.amountCents) }] : []),
    { key: "stands", header: "How it stands", cell: (b) => <>{b.words}{b.flagWords ? <span className="when">{b.flagWords}</span> : null}{b.code ? <span className="when">Last code: {b.code}</span> : null}</> },
    { key: "invoice", header: "Its invoice", cell: (b) => <InvoiceWords b={b} money={money} /> },
    { key: "when", header: "Chosen", cell: (b) => <><LocalTime iso={b.chosenAt} /><span className="when">Changed <LocalTime iso={b.changedAt} /></span></> },
    { key: "do", header: "What you can do", cell: (b) => (b.close.may && canChange
      ? <CloseBuyout what={b.close.words} act={closeBuyoutAction.bind(null, b.id, b.tag, rosterTag)} />
      : b.close.may ? <>{b.close.words} Staff who may change the roster can close it.</> : b.close.words) },
  ];
  return (
    <main className="wrap single">
      <h1 className="page-title">Volunteer buy-outs</h1>
      <p className="lede">{familyName ?? "A family no longer on the roster"}: each time it chose to pay instead of volunteering, and where that stands.{" "}
        {familyName !== null && <Link href={`/staff/roster/${encodeURIComponent(qboId)}`}>Back to the family</Link>}</p>
      <section className="box" aria-labelledby="family-buyouts-h"><h2 id="family-buyouts-h">Buy-outs{buyouts.length ? ` (${buyouts.length})` : ""}</h2>
        {buyouts.length === 0 ? <Notice tone="done" live="none">This family hasn&apos;t chosen to pay instead of volunteering.</Notice>
          : <DataTable caption="The family's buy-outs, newest first" captionHidden columns={columns} rows={buyouts} rowKey={(b) => b.id} />}
      </section>
    </main>
  );
}
