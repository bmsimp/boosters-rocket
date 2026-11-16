import Link from "next/link";
import { loadBuyoutsToLook } from "@/lib/buyouts/staff";
import { formatMoney } from "@/lib/money/cents";
import { LocalTime } from "@/app/components/local-time";

/**
 * The volunteer buy-outs staff must look at (v1 spec §8.4, §11.5): one QuickBooks no longer shows, one whose student
 * moved, one with something paid that the portal wouldn't void, one stuck, and one QuickBooks refused. Each with the
 * family, the requirement and, for staff who may see money, the amount. Its own file, so the Reconciliation page takes
 * it with one import. A server component: nothing here is sent to the browser but what it shows.
 */
export async function BuyoutsToLook({ showAmounts }: { showAmounts: boolean }) {
  const items = await loadBuyoutsToLook();
  return (
    <section className="box" aria-labelledby="buyouts-h"><h2 id="buyouts-h">Volunteer buy-outs{items.length ? ` (${items.length})` : ""}</h2>
      {items.length === 0 ? <p>Nothing: every buy-out invoice is where QuickBooks says it should be, as last checked.</p> : (
        <ul className="lines">{items.map((b) => (
          <li key={b.id}><div>
            <Link className="what" href={`/staff/roster/${encodeURIComponent(b.familyQboId)}`}>{b.familyName ?? "A family no longer on the roster"}</Link>
            <span className="when">{b.requirement}{b.subjectName ? `, for ${b.subjectName}` : ""}{showAmounts ? ` · ${formatMoney(b.amountCents)}` : ""}</span>
            <span className="when">{b.words}{b.code ? ` (${b.code})` : ""}</span>
            <span className="when">Since <LocalTime iso={b.at} /></span>
          </div></li>))}</ul>
      )}
    </section>
  );
}
