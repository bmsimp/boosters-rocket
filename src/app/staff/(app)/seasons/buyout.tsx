import Link from "next/link";
import { requirementBuyout } from "@/lib/buyouts/setup";
import { perUnitWords, priceText } from "@/lib/buyouts/rules";
import { itemsReadAt, listItems } from "@/lib/money/items";
import { formatMoney } from "@/lib/money/cents";
import { LocalTime } from "@/app/components/local-time";
import { Notice } from "@/app/components/notice";
import { OneButton } from "./forms";
import { readItemsAction } from "./payment-actions";
import { BuyoutForm } from "./buyout-form";
import { setBuyoutAction } from "./buyout-actions";

/**
 * The buy-out box of a volunteer requirement's page (v1 spec §11.5): whether families may pay instead of volunteering,
 * at what price per unit still owed, billed with which QuickBooks product or service. A server component; the form is
 * given only what it shows.
 */
export async function BuyoutBox({ requirementId, unit, rosterTag, canChange }: { requirementId: string; unit: "shifts" | "hours" | null; rosterTag: string; canChange: boolean }) {
  const [b, items, itemsAt] = await Promise.all([requirementBuyout(requirementId), listItems(), itemsReadAt()]);
  const per = perUnitWords(unit);
  const offered = b.unitCents !== null && b.item !== null;
  return (
    <section className="box" aria-labelledby="buyout-h"><h2 id="buyout-h">Paying instead</h2>
      <p>{offered
        ? <>Families may pay instead: {formatMoney(b.unitCents!)} {per} not yet volunteered{unit === "hours" ? ", rounded up to whole hours" : ""}, billed with <b>{b.item!.name ?? `the QuickBooks product or service numbered ${b.item!.qboId}`}</b>. The invoice is made in QuickBooks when a guardian confirms, and the requirement is met once it&apos;s paid.</>
        : <>Families can&apos;t pay instead of volunteering for this. Offer a buy-out to let a guardian choose an invoice instead, priced {per} still owed.</>}</p>
      {b.live > 0 && <p className="hint">{b.live === 1 ? "One buy-out has" : `${b.live} buy-outs have`} been chosen. Changing the price or switching it off leaves {b.live === 1 ? "it as it is" : "them as they are"}.</p>}
      {offered && !b.item!.active && <Notice tone="warning" live="none">It isn&apos;t an active product or service in the list last read from QuickBooks.</Notice>}
      {canChange && (
        <>
          {items.length === 0
            ? <Notice tone="info" live="none">No list of products and services has been read from QuickBooks yet.</Notice>
            : <BuyoutForm per={per} price={b.unitCents !== null ? priceText(b.unitCents) : ""} chosen={b.item?.qboId ?? null} offered={offered}
                items={items.filter((i) => i.active || i.qboId === b.item?.qboId).map((i) => ({ qboId: i.qboId, label: i.active ? i.name : `${i.name} (inactive)` }))}
                save={setBuyoutAction.bind(null, requirementId, rosterTag)} />}
          {itemsAt && <p className="hint">The list was read from QuickBooks <LocalTime iso={itemsAt} />.</p>}
          <OneButton label="Read the list from QuickBooks" pendingLabel="Reading…" act={readItemsAction} />
        </>
      )}
      <p className="hint">Buy-outs that need a look are on the <Link href="/staff/reconciliation">Reconciliation</Link> page.</p>
    </section>
  );
}
