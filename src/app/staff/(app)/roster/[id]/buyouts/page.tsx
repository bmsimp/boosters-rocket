import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import { familyRecordAt } from "@/lib/families/address";
import { loadFamilyBuyouts, type FamilyBuyout } from "@/lib/buyouts/staff";
import { formatMoney } from "@/lib/money/cents";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { LocalTime } from "@/app/components/local-time";
import { DataTable, type Column } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
import { closeBuyoutAction } from "../../../reconciliation/buyout-actions";
import { CloseBuyout } from "../../../reconciliation/close-buyout";
import { familyPage } from "@/app/staff/(app)/family-pages";

export const metadata = { title: "Buy-outs" };
export const dynamic = "force-dynamic";

/** What the family's figures last said of the invoice, in words; what is owed on it only to staff who may see money. */
function InvoiceWords({ b, money }: { b: FamilyBuyout; money: boolean }) {
  const i = b.invoice;
  const owed = money && i.owedCents !== null ? `: ${formatMoney(i.owedCents)} ${i.kind === "part_paid" ? "still owed" : "owed"}` : "";
  const words = { none: b.state === "refused" ? "None: nothing was billed" : "None made yet", not_read: "Not in the family's figures as last read", open: `Open${owed}`,
    part_paid: `Part paid${owed}`, paid: "Paid", voided: "Voided", earlier_company: i.here
      ? (i.qboId ? `In the QuickBooks company connected now, from before the club switched away and back: invoice ${i.qboId}` : "None the portal knows of: it may have been made in the QuickBooks company connected now")
      : (i.qboId ? `In the earlier QuickBooks company's books: invoice ${i.qboId}` : "None the portal knows of: it may have been made in the earlier QuickBooks company") }[i.kind];
  return <>{words}{i.readAt ? <span className="when">Read from QuickBooks <LocalTime iso={i.readAt} /></span> : null}</>;
}

/**
 * What staff can do about one buy-out: close it where closeVerdict() allows (for staff who may change the roster), or
 * what to do first. A buy-out of an earlier QuickBooks company says what it leaves to settle in that company's books
 * (earlierCompanyLook()), but for a refund owed, whose close is offered as today with the rule's words (the refund is
 * the earlier company's), and one with nothing left to settle, which says what closeVerdict() says.
 */
function WhatToDo({ b, canChange, rosterTag }: { b: FamilyBuyout; canChange: boolean; rosterTag: string }) {
  if (b.earlier && b.earlier.kind !== "refund_owed" && b.earlier.kind !== "nothing_to_settle") return <>{b.earlier.words}{b.earlier.note ? <span className="when">Note: {b.earlier.note}</span> : null}</>;
  const words = b.earlier?.kind === "refund_owed" ? b.earlier.words : b.close.words;
  if (b.close.may && canChange) return <CloseBuyout what={words} act={closeBuyoutAction.bind(null, b.id, b.tag, rosterTag)} />;
  return b.close.may ? <>{words} Staff who may change the roster can close it.</> : <>{words}</>;
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
  // The app's own family id (stage 3 of the app-owned families spec): anything that isn't a family record's answers 404.
  const familyId = await familyRecordAt(id);
  if (!familyId) notFound();
  // The tag first: the buy-outs shown are that company's or a later one's, never an earlier one's.
  const rosterTag = await currentRosterTag();
  const { familyName, recordName, buyouts } = await loadFamilyBuyouts(familyId);
  if (familyName === null && buyouts.length === 0) notFound();
  // Naming the app's family. Older rows name the customer, and the audit page's record filter finds both.
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "volunteer.buyout.family.read", permission: "Roster.Read",
    targetType: "family", targetId: String(familyId), ip: ctx.ip });
  const money = can(ctx.effective, "Finance.Balance.Read");
  const canChange = can(ctx.effective, "Roster.Family.ReadWrite");
  const columns: Column<FamilyBuyout>[] = [
    { key: "requirement", header: "Requirement", rowHeader: true, cell: (b) => <>{b.requirement}<span className="when">{b.subjectName ? `For ${b.subjectName}` : "For the family"}</span></> },
    ...(money ? [{ key: "amount", header: "Amount", numeric: true, cell: (b: FamilyBuyout) => formatMoney(b.amountCents) }] : []),
    { key: "stands", header: "How it stands", cell: (b) => <>{b.words}{b.flagWords ? <span className="when">{b.flagWords}</span> : null}{b.code ? <span className="when">Last code: {b.code}</span> : null}</> },
    { key: "invoice", header: "Its invoice", cell: (b) => <InvoiceWords b={b} money={money} /> },
    { key: "when", header: "Chosen", cell: (b) => <><LocalTime iso={b.chosenAt} /><span className="when">Changed <LocalTime iso={b.changedAt} /></span></> },
    { key: "do", header: "What you can do", cell: (b) => <WhatToDo b={b} canChange={canChange} rosterTag={rosterTag} /> },
  ];
  return (
    <main className="wrap single">
      <h1 className="page-title">Volunteer buy-outs</h1>
      <p className="lede">{familyName ?? recordName}: each time it chose to pay instead of volunteering, and where that stands.{" "}
        {familyName !== null && <Link href={familyPage(familyId)}>Back to the family</Link>}</p>
      <section className="box" aria-labelledby="family-buyouts-h"><h2 id="family-buyouts-h">Buy-outs{buyouts.length ? ` (${buyouts.length})` : ""}</h2>
        {buyouts.length === 0 ? <Notice tone="done" live="none">This family hasn&apos;t chosen to pay instead of volunteering.</Notice>
          : <DataTable caption="The family's buy-outs, newest first" captionHidden columns={columns} rows={buyouts} rowKey={(b) => b.id} />}
      </section>
    </main>
  );
}
