import Link from "next/link";
import { loadBuyoutsToLook } from "@/lib/buyouts/staff";
import { formatMoney } from "@/lib/money/cents";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { LocalTime } from "@/app/components/local-time";
import { DataTable } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
import { closeBuyoutAction } from "./buyout-actions";
import { CloseBuyout } from "./close-buyout";

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
            { key: "family", header: "Family", rowHeader: true, cell: (b) => (
              <><Link href={`/staff/roster/${encodeURIComponent(b.familyQboId)}`}>{b.familyName ?? "A family no longer on the roster"}</Link>
                <span className="when"><Link href={`/staff/roster/${encodeURIComponent(b.familyQboId)}/buyouts`}>Its buy-outs</Link></span></>) },
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
