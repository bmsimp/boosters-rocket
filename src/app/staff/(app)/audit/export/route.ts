import { NextResponse } from "next/server";
import { env } from "@/env";
import { getStaffIdentity, hasStaffSession } from "@/lib/auth/identity";
import { effectivePermissions, can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import { clientIpFrom } from "@/lib/request";
import { auditExportRows, auditExportScope, parseAuditFilters, recordText } from "@/lib/audit/query";
import { AUDIT_CSV_HEADER, auditCsvLine, csvLine } from "@/lib/audit/csv";

export const dynamic = "force-dynamic";

/**
 * The audit log as a CSV file, with the same filters as the page (/staff/audit). A route handler has no page guard, so
 * the session and the permission are checked here, first: Audit.Log.Read, which only an Admin holds. Anyone else is
 * sent where the pages send them and gets no rows. Every export is itself audited, with its filters and its row count,
 * before a row is sent. Never cached.
 */
export async function GET(req: Request): Promise<Response> {
  const to = (p: string) => NextResponse.redirect(new URL(p, env.APP_URL), { headers: { "cache-control": "no-store" } });
  const id = await getStaffIdentity();
  if (!id) return to((await hasStaffSession()) ? "/refused" : "/staff/sign-in");
  const actor = { door: "staff" as const, id: id.staffUserId, label: id.email }, ip = clientIpFrom(req.headers);
  const permission = "Audit.Log.Read" as const;
  if (!can(await effectivePermissions(id.staffUserId), permission)) {
    await writeAudit({ actor, action: "access.refused", permission, ip });
    return to("/refused");
  }
  const filters = parseAuditFilters(new URL(req.url).searchParams);
  const scope = await auditExportScope(filters);
  await writeAudit({ actor, action: "audit.export", permission, targetType: "audit_log", ip, after: {
    rows: scope.rows, action: filters.action, who: filters.who, from: filters.from?.toISOString() ?? null, to: filters.to?.toISOString() ?? null,
    record: recordText(filters.record) || null } });

  const encoder = new TextEncoder();
  const batches = auditExportRows(filters, scope.upTo);
  const body = new ReadableStream<Uint8Array>({
    // The mark at the start tells a spreadsheet the file is UTF-8, so names with accents open as they were written.
    start(controller) { controller.enqueue(encoder.encode(`﻿${csvLine(AUDIT_CSV_HEADER)}`)); },
    async pull(controller) {
      try {
        const next = await batches.next();
        if (next.done) { controller.close(); return; }
        controller.enqueue(encoder.encode(next.value.map(auditCsvLine).join("")));
      } catch (e) {
        controller.error(e);
      }
    },
    async cancel() { await batches.return(undefined); },
  });
  return new Response(body, { status: 200, headers: {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  } });
}
