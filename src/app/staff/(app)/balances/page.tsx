import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { writeAudit } from "@/lib/audit/log";
import { formatMoney } from "@/lib/money/cents";
import { loadBalances, SEARCH_MAX, type BalanceRow } from "@/lib/money/balances";
import { moneyRunView, type MoneyRunView } from "@/lib/money/sweep";
import { CalendarDate } from "@/app/components/calendar-date";
import { LocalTime } from "@/app/components/local-time";
import { OneButton } from "../seasons/forms";
import { askForMoneyRunAction } from "./actions";

export const metadata = { title: "Balances" };
export const dynamic = "force-dynamic";

const familyHref = (qboId: string) => `/staff/balances/${encodeURIComponent(qboId)}`;
const familiesWord = (n: number) => `${n} ${n === 1 ? "family" : "families"}`;

function Run({ run }: { run: MoneyRunView }) {
  return (
    <section className="box" aria-labelledby="run-h"><h2 id="run-h">Reading from QuickBooks</h2>
      <p>The worker reads every family&apos;s invoices from QuickBooks once a day, one family at a time. A parent opening their own page reads theirs again too.</p>
      {run.running
        ? <p role="status">Reading every family now: {familiesWord(run.running.read)} read so far{run.running.failed ? `, ${run.running.failed} couldn't be read` : ""}. Started <LocalTime iso={run.running.startedAt} />.</p>
        : run.asked ? <p role="status">A read of every family is asked for. The worker starts it within a minute.</p> : null}
      {run.last
        ? <p className="hint">Last finished <LocalTime iso={run.last.finishedAt} />{run.last.ok ? "" : ", part way"}: {run.last.detail ?? ""}</p>
        : <p className="hint">Every family hasn&apos;t been read in one go yet.</p>}
      {!run.running && !run.asked && <div className="box-foot"><OneButton label="Read every family now" pendingLabel="Asking…" act={askForMoneyRunAction} /></div>}
    </section>
  );
}

function Line({ row }: { row: BalanceRow }) {
  const f = row.figures;
  return (
    <li>
      <span>
        <Link className="what" href={familyHref(row.familyQboId)}>{row.name}</Link>
        <span className="when">
          {f === null ? "Not read from QuickBooks yet"
            : <>{f.openCount === 0 ? "Nothing owed" : <>{f.openCount === 1 ? "1 open invoice" : `${f.openCount} open invoices`}{f.oldestDue && <>, oldest due <CalendarDate iso={f.oldestDue} /></>}</>} · Read <LocalTime iso={f.readAt} /></>}
          {row.failedAt && <> · The last try to read it didn&apos;t work (<LocalTime iso={row.failedAt} />)</>}
        </span>
      </span>
      <span className="amount num">{f === null ? "" : f.currency === null ? "More than one currency" : formatMoney(f.totalCents, f.currency)}</span>
    </li>
  );
}

export default async function BalancesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireStaffPage("Finance.Balance.Read");
  const sp = await searchParams;
  const owing = sp.owing === "1";
  const search = typeof sp.q === "string" ? sp.q.slice(0, SEARCH_MAX) : "";
  // A staff read of family data (v1 spec §13): every family's balance, recorded before anything is shown.
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "money.balances.read", permission: "Finance.Balance.Read",
    targetType: "family_money", ip: ctx.ip, after: { onlyOwing: owing, search: search || null } });
  const [balances, run] = await Promise.all([loadBalances({ owing, search }), moneyRunView()]);
  const filtered = owing || search !== "";
  return (
    <main className="wrap single">
      <h1 className="page-title">Balances</h1>
      <p className="lede">What each family owes, from the figures QuickBooks last gave. Opening this page asks QuickBooks nothing.</p>

      <Run run={run} />

      {balances.worthALook.length > 0 && (
        <section className="box" aria-labelledby="look-h"><h2 id="look-h">Worth a look</h2>
          <p>QuickBooks&apos; own balance for these customers isn&apos;t what their open invoices add up to. It may be a credit, a payment not yet applied, or a charge that isn&apos;t an invoice. Parents see the invoices.</p>
          <ul className="lines">{balances.worthALook.map((w) => (
            <li key={w.familyQboId}><span>
              <Link className="what" href={familyHref(w.familyQboId)}>{w.name}</Link>
              {w.customers.map((c) => (
                <span key={c.customerQboId} className="when">{c.name ?? "The family itself"}: QuickBooks says {formatMoney(c.balanceCents, c.currency)}, its open invoices add up to {formatMoney(c.invoicesCents, c.currency)}</span>
              ))}
              <span className="when">Checked <LocalTime iso={w.checkedAt} /></span>
            </span></li>
          ))}</ul>
        </section>
      )}

      <section className="box" aria-labelledby="families-h"><h2 id="families-h">Families</h2>
        <form method="get" action="/staff/balances" className="stack">
          <label className="field"><span>Find a family or a student</span><input name="q" type="search" maxLength={SEARCH_MAX} defaultValue={search} /></label>
          <fieldset className="checks"><label><input type="checkbox" name="owing" value="1" defaultChecked={owing} /> Only families that owe something</label></fieldset>
          <div className="row-actions"><button className="btn btn-line">Show</button>{filtered && <Link className="btn btn-line" href="/staff/balances">Show every family</Link>}</div>
        </form>
        {!balances.roster ? <p role="status">The roster can&apos;t be shown right now. Check QuickBooks under Roster.</p>
          : balances.rows.length === 0 ? <p>{filtered ? "No family matches." : "There are no families on the roster."}</p>
          : <>
              <p className="hint">{filtered ? `${balances.rows.length} of ${familiesWord(balances.families)}` : familiesWord(balances.families)}.</p>
              <ul className="lines">{balances.rows.map((r) => <Line key={r.familyQboId} row={r} />)}</ul>
            </>}
      </section>
    </main>
  );
}
