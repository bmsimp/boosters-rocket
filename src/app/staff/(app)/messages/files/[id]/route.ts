import { NextResponse } from "next/server";
import { env } from "@/env";
import { getStaffIdentity, hasStaffSession } from "@/lib/auth/identity";
import { effectivePermissions, can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import { clientIpFrom } from "@/lib/request";
import { fixedFileName, isPicture, MESSAGE_FILE_MIME } from "@/lib/messages/file-types";
import { staffFile } from "@/lib/messages/staff";

export const dynamic = "force-dynamic";

/**
 * A picture or file of a club message, for staff (spec section 7). A route handler has no page guard, so the staff
 * session and Messages.Post.ReadWrite are checked here, first; anyone else is sent where the pages send them and gets no
 * bytes. A posted file of a message that isn't deleted is sent to anyone who may see messages, a held one only to the
 * staff member whose form holds it; anything else answers the same 404. The type is the one read from the bytes when
 * the file was kept, pictures inline and everything else as `attachment.<ext>`, so nothing staff typed reaches a
 * header. Never cached. Not audited: a message's files are the same for every family.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const to = (p: string) => NextResponse.redirect(new URL(p, env.APP_URL), { headers: { "cache-control": "no-store" } });
  const who = await getStaffIdentity();
  if (!who) return to((await hasStaffSession()) ? "/refused" : "/staff/sign-in");
  const permission = "Messages.Post.ReadWrite" as const;
  if (!can(await effectivePermissions(who.staffUserId), permission)) {
    await writeAudit({ actor: { door: "staff", id: who.staffUserId, label: who.email }, action: "access.refused", permission, ip: clientIpFrom(req.headers) });
    return to("/refused");
  }
  const { id } = await params;
  const found = await staffFile(id, who.staffUserId);
  if (!found) return new Response("Not found", { status: 404, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" } });
  return new Response(new Uint8Array(found.bytes), { status: 200, headers: {
    "content-type": MESSAGE_FILE_MIME[found.type],
    "content-disposition": isPicture(found.type) ? `inline; filename="${fixedFileName(found.type)}"` : `attachment; filename="${fixedFileName(found.type)}"`,
    "content-length": String(found.bytes.byteLength),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  } });
}
