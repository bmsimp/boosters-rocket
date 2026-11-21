import Link from "next/link";
import { loadBuyoutsToLook, loadEarlierCompanyBuyouts } from "@/lib/buyouts/staff";
import { formatMoney } from "@/lib/money/cents";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { LocalTime } from "@/app/components/local-time";
import { DataTable } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
import { closeBuyoutAction } from "./buyout-actions";
import { CloseBuyout } from "./close-buyout";
import { familyBuyoutsPage, familyPage, familyProgressPage } from "@/app/staff/(app)/family-pages";

/**
 * The volunteer buy-outs staff must look at (v1 spec §8.4, §11.5): one QuickBooks no longer shows, one whose student
 * moved, one with something paid that the portal wouldn't void, one stuck, and one QuickBooks refused. Each with the
 * family, the requirement and, for staff who may see money, the amount; what to do about it, and, for staff who may
 * change the roster, a close where no unpaid invoice of it stands (src/lib/buyouts/closing.ts). Its own file, so the
 * Reconciliation page takes it with one import. A server component: nothing here is sent to the browser but what it
 * shows, and the close is bound on the server to the buy-out as shown.
 */
export async function BuyoutsToLook({ showAmounts, canChange = false }: { showAmounts: boolean; canChange?: boolean }) {
  // The tag first: the buy-outs listed are that company's or a later one's, never an earlier one's.
  const rosterTag = await currentRosterTag();
  const items = await loadBuyoutsToLook();
  return (
    <section className="box" aria-labelledby="buyouts-h"><h2 id="buyouts-h">Volunteer buy-outs{items.length ? ` (${items.length})` : ""}</h2>
      {items.length === 0 ? <Notice tone="done" live="none">Nothing: every buy-out invoice is where QuickBooks says it should be, as last checked.</Notice> : (
        <DataTable caption="Volunteer buy-outs that need a look" captionHidden rowKey={(b) => b.id} rows={items}
          columns={[
            { key: "family", header: "Family", rowHeader: true, cell: (b) => (b.familyQboId === null ? <>{b.familyName ?? "A family no longer on the roster"}</> : (
              <><Link href={familyPage(b.familyId)}>{b.familyName ?? "A family no longer on the roster"}</Link>
                <span className="when"><Link href={familyBuyoutsPage(b.familyId)}>Its buy-outs</Link></span></>)) },
            { key: "requirement", header: "Requirement", cell: (b) => <>{b.requirement}{b.subjectName ? `, for ${b.subjectName}` : ""}</> },
            ...(showAmounts ? [{ key: "amount", header: "Amount", numeric: true, cell: (b: (typeof items)[number]) => formatMoney(b.amountCents) }] : []),
            { key: "what", header: "What happened", cell: (b) => <>{b.words}{b.code ? ` (${b.code})` : ""}</> },
            { key: "since", header: "Since", cell: (b) => <LocalTime iso={b.at} /> },
            { key: "do", header: "What you can do", cell: (b) => (b.close.may && canChange
              ? <CloseBuyout what={b.close.words} act={closeBuyoutAction.bind(null, b.id, b.tag, rosterTag)} />
              : b.close.may ? <>{b.close.words} Staff who may change the roster can close it.</> : b.close.words) },
          ]} />
      )}
    </section>
  );
}

/**
 * What a change of company left in the earlier QuickBooks company's books, for the treasurer to settle there by hand
 * (stage 4's slice M7b, open question 16): every buy-out of another company than the roster's that leaves something to
 * settle (src/lib/buyouts/staff.ts, loadEarlierCompanyBuyouts()), named by the app's own records, with the requirement,
 * for staff who may see money the amount, the earlier company and the invoice or the note to search for, and what to
 * do. The family's roster page is linked only while it opens (none after a clear until the new company's shape is set;
 * its buy-outs page always opens). Where the family may have paid there, a link to its season page, where a waiver is given; a refund owed offers
 * the close, as Volunteer buy-outs does, for staff who may change the roster. Drawn only when it has a row. Nothing is
 * sent to the browser but what it shows.
 */
export async function EarlierCompanyBuyouts({ showAmounts, canChange = false }: { showAmounts: boolean; canChange?: boolean }) {
  const rosterTag = await currentRosterTag();
  const items = await loadEarlierCompanyBuyouts();
  if (items.length === 0) return null;
  return (
    <section className="box" aria-labelledby="earlier-buyouts-h"><h2 id="earlier-buyouts-h">From the earlier QuickBooks company ({items.length})</h2>
      <p>When the club connected a different QuickBooks company, the portal ended these volunteer buy-outs, or kept them where they were paid, and sent nothing more to the earlier company.
        Each may still have something to settle in that company&apos;s books, by hand: look it up there by its invoice, or by its note.</p>
      <DataTable caption="Volunteer buy-outs from the earlier QuickBooks company" captionHidden rowKey={(b) => b.id} rows={items}
        columns={[
          { key: "family", header: "Family", rowHeader: true, cell: (b) => <>{b.familyPageStands ? <Link href={familyPage(b.familyId)}>{b.familyName}</Link> : b.familyName}
            <span className="when"><Link href={familyBuyoutsPage(b.familyId)}>Its buy-outs</Link></span></> },
          { key: "requirement", header: "Requirement", cell: (b) => <>{b.requirement}{b.subjectName ? `, for ${b.subjectName}` : ""}</> },
          ...(showAmounts ? [{ key: "amount", header: "Amount", numeric: true, cell: (b: (typeof items)[number]) => formatMoney(b.amountCents) }] : []),
          { key: "books", header: "In the earlier company", cell: (b) => <>{b.invoiceQboId ? `Invoice ${b.invoiceQboId}` : `Note: ${b.note ?? ""}`}<span className="when">Company {b.realmId}</span></> },
          { key: "what", header: "What is left to settle", cell: (b) => b.words },
          { key: "since", header: "Since", cell: (b) => <LocalTime iso={b.at} /> },
          { key: "do", header: "What you can do", cell: (b) => (b.close ? (b.close.may && canChange
            ? <CloseBuyout what={b.close.words} act={closeBuyoutAction.bind(null, b.id, b.tag, rosterTag)} />
            : b.close.may ? <>{b.close.words} Staff who may change the roster can close it.</> : b.close.words)
            : <Link href={familyProgressPage(b.familyId, b.seasonId)}>Open the family&apos;s season page<span className="visually-hidden">: {b.familyName}, {b.requirement}</span></Link>) },
        ]} />
    </section>
  );
}
