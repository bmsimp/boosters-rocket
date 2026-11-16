import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { loadRosterPage } from "@/lib/roster/queries";
import { loadOpenWrites, type QueueView } from "@/lib/roster/queue";
import { loadBalances } from "@/lib/money/balances";
import { formatMoney } from "@/lib/money/cents";
import { LocalTime } from "@/app/components/local-time";
import { OneButton, TextAction } from "../seasons/forms";
import { giveUpAction, tryAgainAction } from "../roster/write-actions";

export const metadata = { title: "Reconciliation" };
export const dynamic = "force-dynamic";

/** What a short code means to staff. The code itself is shown beside it, for whoever looks into it further. */
const CODE_WORDS: Record<string, string> = {
  token_busy: "QuickBooks was busy with another request", http_429: "QuickBooks asked the portal to slow down", unreachable: "QuickBooks couldn't be reached",
  timeout: "QuickBooks didn't answer in time", bad_answer: "QuickBooks' answer couldn't be read", moved_on: "the record changed in QuickBooks since, so it wasn't sent again",
  gone: "the record is no longer on the roster", fault_5010: "the record changed in QuickBooks since", fault_6240: "the name is taken in QuickBooks",
};
const codeWords = (code: string | null) => (code === null ? null
  : CODE_WORDS[code] ?? (/^http_5\d\d/.test(code) ? "QuickBooks had a problem of its own" : /^token_/.test(code) ? "the portal couldn't get a key to QuickBooks" : "QuickBooks refused it"));

function Item({ item, canChange }: { item: QueueView; canChange: boolean }) {
  const words = codeWords(item.lastCode);
  return (
    <li>
      <div>
        <span className="what">{item.words}</span>
        <span className="when">{item.state === "stuck" ? "Stuck: it won't be tried again until someone asks" : "Waiting to reach QuickBooks"}</span>
        <span className="when">Asked <LocalTime iso={item.askedAt} />{item.askedBy ? ` by ${item.askedBy}` : ""} · tried {item.tries} {item.tries === 1 ? "time" : "times"}, last <LocalTime iso={item.lastTriedAt} />
          {item.state === "waiting" && item.nextTryAt ? <> · next try <LocalTime iso={item.nextTryAt} /></> : null}</span>
        {words && <span className="when">Last time: {words} ({item.lastCode})</span>}
        {item.familyQboId && <span className="when"><Link href={`/staff/roster/${encodeURIComponent(item.familyQboId)}`}>Open the family</Link></span>}
      </div>
      {canChange && (
        <div className="row-actions">
          <OneButton label="Try again now" pendingLabel="Asking…" act={tryAgainAction.bind(null, item.id)} />
          <details className="more"><summary>Give up</summary>
            <TextAction field="Why? (kept in the audit log)" label="Give up" pendingLabel="Giving up…" maxLength={500} multiline act={giveUpAction.bind(null, item.id)} />
          </details>
        </div>
      )}
    </li>
  );
}

/**
 * What doesn't line up between the portal and QuickBooks, in one place (v1 spec §6.3, §8.3): staff changes still
 * waiting to reach QuickBooks or stuck, the roster's Needs attention list, and, for staff who may see money, the
 * families whose QuickBooks balance isn't what their invoices add up to. It lists many families, so opening it is not
 * audited as a read of one; each family's own page is. Names are QuickBooks text, shown as text only.
 */
export default async function ReconciliationPage() {
  const ctx = await requireStaffPage("Roster.Read");
  const money = can(ctx.effective, "Finance.Balance.Read");
  const [writes, roster, balances] = await Promise.all([loadOpenWrites(), loadRosterPage(), money ? loadBalances() : Promise.resolve(null)]);
  const canChange = can(ctx.effective, "Roster.Family.ReadWrite");
  const stuck = writes.filter((w) => w.state === "stuck"), waiting = writes.filter((w) => w.state === "waiting");
  const hasPage = new Set(!roster.roster ? [] : roster.roster.kind === "flat" ? roster.roster.members.map((m) => m.qboId) : roster.roster.families.map((f) => f.customer.qboId));
  return (
    <main className="wrap single">
      <h1 className="page-title">Reconciliation</h1>
      <p className="lede">Where the portal and QuickBooks don&apos;t agree yet, and what needs someone to look at it.</p>

      <section className="box" aria-labelledby="writes-h"><h2 id="writes-h">Changes waiting to reach QuickBooks</h2>
        {writes.length === 0 ? <p>Nothing is waiting: every change staff made has reached QuickBooks.</p> : (
          <>
            <p>QuickBooks couldn&apos;t take these when they were asked for. The worker tries a waiting change again, at longer and longer gaps;
              one QuickBooks may already have made is first looked for in a fresh copy of the roster, so nothing is made twice or overwritten.
              A stuck change waits for you: try it again, or give it up and make it in QuickBooks.</p>
            {stuck.length > 0 && <><h3>Stuck ({stuck.length})</h3><ul className="lines">{stuck.map((w) => <Item key={w.id} item={w} canChange={canChange} />)}</ul></>}
            {waiting.length > 0 && <><h3>Waiting ({waiting.length})</h3><ul className="lines">{waiting.map((w) => <Item key={w.id} item={w} canChange={canChange} />)}</ul></>}
          </>
        )}
      </section>

      <section className="box" aria-labelledby="attention-h"><h2 id="attention-h">Needs attention in the roster{roster.attention.length ? ` (${roster.attention.length})` : ""}</h2>
        {!roster.roster ? <p>The roster can&apos;t be shown right now. <Link href="/staff/roster">Open the roster</Link> to see why.</p>
          : roster.attention.length === 0 ? <p>Nothing: the roster is tidy.</p> : (
            <ul className="lines">{roster.attention.map((a, i) => (
              <li key={`${a.rule}-${a.qboId ?? a.name}-${i}`}><div>
                {a.qboId && hasPage.has(a.qboId) ? <Link className="what" href={`/staff/roster/${encodeURIComponent(a.qboId)}`}>{a.name}</Link> : <span className="what">{a.name}</span>}
                <span className="when">{a.detail}</span></div></li>))}</ul>
          )}
      </section>

      {balances && (
        <section className="box" aria-labelledby="look-h"><h2 id="look-h">Money worth a look</h2>
          {balances.worthALook.length === 0 ? <p>Nothing: every family&apos;s balance in QuickBooks is what its open invoices add up to, as last checked.</p> : (
            <>
              <p>QuickBooks&apos; own balance for these customers isn&apos;t what their open invoices add up to. It may be a credit, a payment not yet applied, or a charge that isn&apos;t an invoice. Parents see the invoices.</p>
              <ul className="lines">{balances.worthALook.map((w) => (
                <li key={w.familyQboId}><span>
                  <Link className="what" href={`/staff/balances/${encodeURIComponent(w.familyQboId)}`}>{w.name}</Link>
                  {w.customers.map((c) => (
                    <span key={c.customerQboId} className="when">{c.name ?? "The family itself"}: QuickBooks says {formatMoney(c.balanceCents, c.currency)}, its open invoices add up to {formatMoney(c.invoicesCents, c.currency)}</span>
                  ))}
                  <span className="when">Checked <LocalTime iso={w.checkedAt} /></span>
                </span></li>
              ))}</ul>
            </>
          )}
        </section>
      )}
    </main>
  );
}
