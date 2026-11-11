import { NextResponse } from "next/server";
import { env } from "@/env";
import { getStaffIdentity, hasStaffSession } from "@/lib/auth/identity";
import { effectivePermissions, can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import { clientIpFrom } from "@/lib/request";
import { completeConnect } from "@/lib/quickbooks/connection";
import { refreshRoster } from "@/lib/roster/refresh";

export const dynamic = "force-dynamic";

/** Intuit sends the Admin back here after they approve (or refuse) access (spec §3). Nothing is stored unless the state matches. */
export async function GET(req: Request): Promise<Response> {
  const to = (p: string) => NextResponse.redirect(new URL(p, env.APP_URL));
  const id = await getStaffIdentity();
  // Signed in but not resolvable (disabled) goes where the pages send them; only no session at all goes to sign-in.
  if (!id) return to((await hasStaffSession()) ? "/refused" : "/staff/sign-in");
  const actor = { door: "staff" as const, id: id.staffUserId, label: id.email }, ip = clientIpFrom(req.headers);
  if (!can(await effectivePermissions(id.staffUserId), "Settings.QuickBooks.ReadWrite")) {
    await writeAudit({ actor, action: "access.refused", permission: "Settings.QuickBooks.ReadWrite", ip });
    return to("/refused");
  }
  const q = new URL(req.url).searchParams;
  const r = await completeConnect({ code: q.get("code"), state: q.get("state"), realmId: q.get("realmId"), error: q.get("error") }, { staffUserId: id.staffUserId, actor, ip });
  if (!r.ok) return to(`/staff/settings/quickbooks/setup?step=connect&error=${r.reason}`);
  // The first read, so step 3 can list the customer types. If it fails, step 3 says so and offers to read again.
  await refreshRoster({ startedBy: id.staffUserId, actor, ip });
  return to("/staff/settings/quickbooks/setup?step=shape");
}
