import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { loadRosterPage } from "@/lib/roster/queries";
import { loadOpenWrites, type QueueView } from "@/lib/roster/queue";
import { loadBalances } from "@/lib/money/balances";
import { LocalTime } from "@/app/components/local-time";
import { DataTable, type Column } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
import { WorthALook } from "../balances/worth-a-look";
import { OneButton, TextAction } from "../seasons/forms";
import { giveUpAction, tryAgainAction } from "../roster/write-actions";
import { BuyoutsToLook } from "./buyouts";

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

/** The changes in one state, a row each: what, who asked and when, the tries, the last answer, and what can be done. */
function Writes({ items, caption, canChange }: { items: QueueView[]; caption: string; canChange: boolean }) {
  const columns: Column<QueueView>[] = [
    { key: "what", header: "Change", rowHeader: true, cell: (i) => (
      <>{i.words}<span className="when">{i.state === "stuck" ? "Stuck: it won't be tried again until someone asks" : "Waiting to reach QuickBooks"}</span></>) },
    { key: "asked", header: "Asked", cell: (i) => <><LocalTime iso={i.askedAt} />{i.askedBy ? <span className="when">by {i.askedBy}</span> : null}</> },
    { key: "tries", header: "Tries", cell: (i) => (
      <>{i.tries} {i.tries === 1 ? "time" : "times"}, last <LocalTime iso={i.lastTriedAt} />{i.state === "waiting" && i.nextTryAt ? <span className="when">Next try <LocalTime iso={i.nextTryAt} /></span> : null}</>) },
    { key: "last", header: "Last time", cell: (i) => { const words = codeWords(i.lastCode); return words ? `${words} (${i.lastCode})` : "No answer recorded"; } },
    { key: "family", header: "Family", cell: (i) => (i.familyQboId ? <Link href={`/staff/roster/${encodeURIComponent(i.familyQboId)}`}>Open the family</Link> : "None") },
    ...(canChange ? [{ key: "do", header: "What you can do", quiet: true, cell: (i: QueueView) => (
      <div className="row-actions">
        <OneButton label="Try again now" pendingLabel="Asking…" act={tryAgainAction.bind(null, i.id)} />
        <details className="more"><summary>Give up</summary>
          <TextAction field="Why? (kept in the audit log)" label="Give up" pendingLabel="Giving up…" maxLength={500} multiline act={giveUpAction.bind(null, i.id)} />
        </details>
      </div>) }] : []),
  ];
  return <DataTable caption={caption} captionHidden columns={columns} rows={items} rowKey={(i) => i.id} />;
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
  const [writes, roster, balances] = await Promise.all([loadOpenWrites({ showAmounts: money }), loadRosterPage(), money ? loadBalances() : Promise.resolve(null)]);
  const canChange = can(ctx.effective, "Roster.Family.ReadWrite");
  const stuck = writes.filter((w) => w.state === "stuck"), waiting = writes.filter((w) => w.state === "waiting");
  const hasPage = new Set(!roster.roster ? [] : roster.roster.kind === "flat" ? roster.roster.members.map((m) => m.qboId) : roster.roster.families.map((f) => f.customer.qboId));
  return (
    <main className="wrap single">
      <h1 className="page-title">Reconciliation</h1>
      <p className="lede">Where the portal and QuickBooks don&apos;t agree yet, and what needs someone to look at it.</p>

      <section className="box" aria-labelledby="writes-h"><h2 id="writes-h">Changes waiting to reach QuickBooks</h2>
        {writes.length === 0 ? <Notice tone="done" live="none">Nothing is waiting: every change staff made has reached QuickBooks.</Notice> : (
          <>
            <p>QuickBooks couldn&apos;t take these when they were asked for. The worker tries a waiting change again, at longer and longer gaps;
              one QuickBooks may already have made is first looked for in a fresh copy of the roster, so nothing is made twice or overwritten.
              A stuck change waits for you: try it again, or give it up and make it in QuickBooks.</p>
            {stuck.length > 0 && <><h3 className="table-head">Stuck ({stuck.length})</h3><Writes items={stuck} caption="Stuck changes" canChange={canChange} /></>}
            {waiting.length > 0 && <><h3 className="table-head">Waiting ({waiting.length})</h3><Writes items={waiting} caption="Changes waiting" canChange={canChange} /></>}
          </>
        )}
      </section>

      <BuyoutsToLook showAmounts={money} canChange={canChange} />

      <section className="box" aria-labelledby="attention-h"><h2 id="attention-h">Needs attention in the roster{roster.attention.length ? ` (${roster.attention.length})` : ""}</h2>
        {!roster.roster ? <Notice tone="warning" live="none">The roster can&apos;t be shown right now. <Link href="/staff/roster">Open the roster</Link> to see why.</Notice>
          : roster.attention.length === 0 ? <Notice tone="done" live="none">Nothing: the roster is tidy.</Notice> : (
            <DataTable caption="What to tidy, for each customer" captionHidden rowKey={(a) => a.key} rows={roster.attention.map((a, i) => ({ ...a, key: `${a.rule}-${a.qboId ?? a.name}-${i}` }))}
              columns={[
                { key: "name", header: "Customer", rowHeader: true, cell: (a) => (a.qboId && hasPage.has(a.qboId) ? <Link href={`/staff/roster/${encodeURIComponent(a.qboId)}`}>{a.name}</Link> : a.name) },
                { key: "detail", header: "What to tidy", cell: (a) => a.detail },
              ]} />
          )}
      </section>

      {balances && (
        <section className="box" aria-labelledby="look-h"><h2 id="look-h">Money worth a look</h2>
          {balances.worthALook.length === 0 ? <Notice tone="done" live="none">Nothing: every family&apos;s balance in QuickBooks is what its open invoices add up to, as last checked.</Notice> : (
            <>
              <p>QuickBooks&apos; own balance for these customers isn&apos;t what their open invoices add up to. It may be a credit, a payment not yet applied, or a charge that isn&apos;t an invoice. Parents see the invoices.</p>
              <WorthALook rows={balances.worthALook} />
            </>
          )}
        </section>
      )}
    </main>
  );
}
