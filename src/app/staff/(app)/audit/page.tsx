import { desc } from "drizzle-orm";
import { requireStaffPage } from "@/lib/guards";
import { db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
import { LocalTime } from "@/app/components/local-time";
import { formatAuditDetails } from "@/lib/audit/format";

export default async function AuditPage() {
  await requireStaffPage("Audit.Log.Read");
  const rows = await db.select().from(auditLog).orderBy(desc(auditLog.at)).limit(200);
  return (
    <main className="wrap single">
      <h1 className="page-title">Audit log</h1>
      <section className="box" aria-labelledby="audit-h"><h2 id="audit-h">Latest 200 changes</h2>
        <ul className="lines">{rows.map((r) => (
          <li key={r.id}><div><span className="what">{r.action}</span>
            <span className="when"><LocalTime iso={r.at.toISOString()} /> · {r.door} · {r.actorLabel ?? "system"}{r.ip ? ` · ${r.ip}` : ""}</span>
            {(() => { const d = formatAuditDetails(r.before, r.after); return d ? <details className="when"><summary>Details</summary><code>{d}</code></details> : null; })()}</div>
            <span className="amount">{r.targetType ? `${r.targetType} ${r.targetId ?? ""}` : ""}</span></li>))}
        </ul></section>
    </main>
  );
}
