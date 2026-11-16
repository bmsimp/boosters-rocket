import { NextResponse } from "next/server";
import { env } from "@/env";
import { getStaffIdentity, hasStaffSession } from "@/lib/auth/identity";
import { effectivePermissions, can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import { clientIpFrom } from "@/lib/request";
import { evidenceDownload } from "@/lib/signed-forms/evidence";

export const dynamic = "force-dynamic";

/**
 * One file of a signed form's evidence, for staff (v1 spec §9.4): a sealed PDF, the certificate, the audit log as PDF
 * or JSON, or the evidence record. A route handler has no page guard, so the staff session and Forms.Signature.Read are
 * checked here, first; anyone else is sent where the pages send them and gets no bytes. Each download is audited
 * (forms.evidence.download) before a byte is sent. The file name is fixed by the kind of file: no QuickBooks text goes
 * into a header. Never cached.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string; file: string }> }): Promise<Response> {
  const to = (p: string) => NextResponse.redirect(new URL(p, env.APP_URL), { headers: { "cache-control": "no-store" } });
  const who = await getStaffIdentity();
  if (!who) return to((await hasStaffSession()) ? "/refused" : "/staff/sign-in");
  const actor = { door: "staff" as const, id: who.staffUserId, label: who.email }, ip = clientIpFrom(req.headers);
  const permission = "Forms.Signature.Read" as const;
  if (!can(await effectivePermissions(who.staffUserId), permission)) {
    await writeAudit({ actor, action: "access.refused", permission, ip });
    return to("/refused");
  }
  const { id, file } = await params;
  const found = await evidenceDownload(id, file);
  if (!found) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });
  await writeAudit({ actor, action: "forms.evidence.download", permission, targetType: "signed_form_evidence", targetId: id, ip,
    after: { file: found.kind, filename: found.filename, size: found.bytes.byteLength, sha256: found.sha256 } });
  return new Response(new Uint8Array(found.bytes), { status: 200, headers: {
    "content-type": found.contentType === "application/json" ? "application/json; charset=utf-8" : found.contentType,
    "content-disposition": `attachment; filename="${found.filename}"`,
    "content-length": String(found.bytes.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  } });
}
