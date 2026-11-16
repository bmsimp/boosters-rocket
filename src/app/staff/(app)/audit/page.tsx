import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { LocalTime } from "@/app/components/local-time";
import { formatAuditDetails } from "@/lib/audit/format";
import { actionName } from "@/lib/audit/actions";
import { auditActions, auditPage, filtersQuery, hasFilters, parseAuditFilters, parseCursor, recordText } from "@/lib/audit/query";
import { AuditFilterForm } from "./filter-form";

export const metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

const rowsWord = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "row" : "rows"}`;

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireStaffPage("Audit.Log.Read");
  const sp = await searchParams;
  const filters = parseAuditFilters(sp);
  const [page, actions] = await Promise.all([auditPage(filters, { before: parseCursor(sp, "before"), after: parseCursor(sp, "after") }), auditActions()]);
  const filtered = hasFilters(filters);
  return (
    <main className="wrap single">
      <h1 className="page-title">Audit log</h1>
      <p className="lede">Every change, every sign-in and every time staff open a family&apos;s record, newest first. Only Admins can read it: some rows hold notes that staff wrote about parents. Nothing here can be changed or removed.</p>

      <section className="box" aria-labelledby="audit-find-h"><h2 id="audit-find-h">Find</h2>
        <AuditFilterForm actions={actions.map((code) => ({ code, name: actionName(code) }))}
          values={{ action: filters.action ?? "", who: filters.who ?? "", record: recordText(filters.record), from: filters.from?.toISOString() ?? null, to: filters.to?.toISOString() ?? null }} />
        {filtered && <p className="box-foot"><Link href="/staff/audit">Show everything</Link></p>}
      </section>

      <section className="box" aria-labelledby="audit-h"><h2 id="audit-h">{filtered ? `${rowsWord(page.total)} found` : rowsWord(page.total)}</h2>
        {(filters.from || filters.to) && <p className="hint">{filters.from ? <>From <LocalTime iso={filters.from.toISOString()} /></> : "From the start"}{filters.to ? <> to <LocalTime iso={filters.to.toISOString()} /></> : " to now"}.</p>}
        {page.rows.length === 0 ? <p>{page.total > 0 ? "No rows on this page." : filtered ? "Nothing matches. Try fewer filters." : "Nothing has been recorded yet."}</p> : (
          <ul className="lines">{page.rows.map((r) => {
            const details = formatAuditDetails(r.before, r.after);
            return (
              <li key={r.id}><div><span className="what">{actionName(r.action) ?? r.action}</span>
                <span className="when"><LocalTime iso={r.at.toISOString()} /> · {r.door} · {r.actorLabel ?? "system"}{r.ip ? ` · ${r.ip}` : ""} · <code>{r.action}</code></span>
                {details ? <details className="when"><summary>Details</summary><code>{details}</code></details> : null}</div>
                <span className="amount">{r.targetType
                  ? (r.targetId ? <Link href={`/staff/audit${filtersQuery({ ...filters, record: { type: r.targetType, id: r.targetId } })}`}>{r.targetType} {r.targetId}</Link> : r.targetType)
                  : ""}</span></li>);
          })}</ul>
        )}
        <div className="row-actions box-foot">
          {page.newer !== null && <Link className="btn btn-line" href={`/staff/audit${filtersQuery(filters, { after: page.newer })}`}>Newer</Link>}
          {page.older !== null && <Link className="btn btn-line" href={`/staff/audit${filtersQuery(filters, { before: page.older })}`}>Older</Link>}
          {/* A plain link, not a Link: it is a file to download, and it must never be fetched ahead of a click (each export is audited). */}
          {page.total > 0 && <a className="btn btn-line" href={`/staff/audit/export${filtersQuery(filters)}`} download>Export {filtered ? `these ${rowsWord(page.total)}` : `all ${rowsWord(page.total)}`} (CSV)</a>}
        </div>
      </section>
    </main>
  );
}
