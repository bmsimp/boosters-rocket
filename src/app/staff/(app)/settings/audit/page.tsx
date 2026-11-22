import Link from "next/link";
import { requireStaffPage } from "@/lib/guards";
import { LocalTime } from "@/app/components/local-time";
import { formatAuditDetails } from "@/lib/audit/format";
import { actionName } from "@/lib/audit/actions";
import { auditActions, auditPage, filtersQuery, hasFilters, parseAuditFilters, parseCursor, recordText } from "@/lib/audit/query";
import { DataTable } from "@/app/components/data-table";
import { Notice } from "@/app/components/notice";
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
      <p className="lede">Every change, sign-in and staff look at a family&apos;s record, newest first. Only Admins can read it, as some rows hold staff notes about parents. Nothing here can be changed.</p>

      <section className="box" aria-labelledby="audit-find-h"><h2 id="audit-find-h">Find</h2>
        <AuditFilterForm actions={actions.map((code) => ({ code, name: actionName(code) }))}
          values={{ action: filters.action ?? "", who: filters.who ?? "", record: recordText(filters.record), from: filters.from?.toISOString() ?? null, to: filters.to?.toISOString() ?? null }} />
        {filtered && <p className="box-foot"><Link href="/staff/settings/audit">Show everything</Link></p>}
      </section>

      <section className="box" aria-labelledby="audit-h"><h2 id="audit-h">{filtered ? `${rowsWord(page.total)} found` : rowsWord(page.total)}</h2>
        {(filters.from || filters.to) && <p className="hint">{filters.from ? <>From <LocalTime iso={filters.from.toISOString()} /></> : "From the start"}{filters.to ? <> to <LocalTime iso={filters.to.toISOString()} /></> : " to now"}.</p>}
        {page.rows.length === 0 ? <Notice tone="info">{page.total > 0 ? "No rows on this page." : filtered ? "Nothing matches. Try fewer filters." : "Nothing has been recorded yet."}</Notice> : (
          <DataTable caption="Newest first" className="audit-table" rows={page.rows} rowKey={(r) => String(r.id)} columns={[
            { key: "when", header: "When", sorted: "descending", cell: (r) => <LocalTime iso={r.at.toISOString()} /> },
            { key: "what", header: "What happened", rowHeader: true, cell: (r) => {
              const details = formatAuditDetails(r.before, r.after);
              return (<>{actionName(r.action) ?? r.action}<span className="when"><code>{r.action}</code></span>
                {details ? <details className="when"><summary>Details</summary><code>{details}</code></details> : null}</>);
            } },
            { key: "who", header: "Who", cell: (r) => <>{r.actorLabel ?? "system"}<span className="when">{r.door}{r.ip ? ` · ${r.ip}` : ""}</span></> },
            { key: "record", header: "Record", cell: (r) => (r.targetType
              ? (r.targetId ? <Link href={`/staff/settings/audit${filtersQuery({ ...filters, record: { type: r.targetType, id: r.targetId } })}`}>{r.targetType} {r.targetId}</Link> : r.targetType)
              : "None") },
          ]} />
        )}
        <div className="row-actions box-foot">
          {page.newer !== null && <Link className="btn btn-line" href={`/staff/settings/audit${filtersQuery(filters, { after: page.newer })}`}>Newer</Link>}
          {page.older !== null && <Link className="btn btn-line" href={`/staff/settings/audit${filtersQuery(filters, { before: page.older })}`}>Older</Link>}
          {/* A plain link, not a Link: it is a file to download, and it must never be fetched ahead of a click (each export is audited). */}
          {page.total > 0 && <a className="btn btn-line" href={`/staff/settings/audit/export${filtersQuery(filters)}`} download>Export {filtered ? `these ${rowsWord(page.total)}` : `all ${rowsWord(page.total)}`} (CSV)</a>}
        </div>
      </section>
    </main>
  );
}
