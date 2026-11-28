import { getStaffIdentity } from "@/lib/auth/identity";
import { effectivePermissions, can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import { clientIpFrom } from "@/lib/request";
import { BACKUPS_PERMISSION } from "@/lib/backups/status";
import { DOWNLOAD_NAME, takeDownload } from "@/lib/backups/download";

export const dynamic = "force-dynamic";

const notFound = () => new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });

/**
 * A prepared backup, downloaded by the Admin who asked for it on Settings, Backups. A route handler has no page guard,
 * so the staff session and Admin.Backups.ReadWrite (Admin only) are checked here, first. The request's id comes from
 * the address and is found only among the asker's own ready downloads (takeDownload()); it is taken once, audited, sent
 * no-store with a fixed name, and removed from the server's shared folder once sent. Anything else is the same bare 404.
 */
export async function GET(req: Request): Promise<Response> {
  const id = await getStaffIdentity();
  if (!id) return notFound();
  const actor = { door: "staff" as const, id: id.staffUserId, label: id.email }, ip = clientIpFrom(req.headers);
  if (!can(await effectivePermissions(id.staffUserId), BACKUPS_PERMISSION)) {
    await writeAudit({ actor, action: "access.refused", permission: BACKUPS_PERMISSION, ip });
    return notFound();
  }
  const taken = await takeDownload(new URL(req.url).searchParams.get("id"), { actor, ip });
  if (!taken) return notFound();
  return new Response(taken.body, { status: 200, headers: {
    "content-type": "application/x-tar",
    "content-length": String(taken.bytes),
    "content-disposition": `attachment; filename="${DOWNLOAD_NAME}"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  } });
}
