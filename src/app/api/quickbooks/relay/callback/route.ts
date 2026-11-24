import { NextResponse } from "next/server";
import { env } from "@/env";
import { getStaffIdentity, hasStaffSession } from "@/lib/auth/identity";
import { effectivePermissions, can } from "@/lib/permissions/effective";
import { writeAudit } from "@/lib/audit/log";
import { clientIpFrom } from "@/lib/request";
import { completeRelayConnect } from "@/lib/quickbooks/connection";
import { refreshRoster } from "@/lib/roster/refresh";

export const dynamic = "force-dynamic";

/** The query's one value of `k`, as a string of at most `max` characters; null for none, two, or one too long. */
const one = (q: URLSearchParams, k: string, max: number): string | null => {
  const all = q.getAll(k);
  return all.length === 1 && all[0]!.length <= max ? all[0]! : null;
};

/**
 * Boosters Rocket Connect, the relay, sends the Admin back here after Intuit (its SPEC.md section 2, Connect, step 6),
 * with its redemption code and the portal's own state, or with `error` and the state (docs/superpowers/specs/
 * 2026-11-24-connect-through-boosters-rocket-design.md §5, Connect, 5). The staff session and its permission are checked
 * here first, as the Intuit callback checks them; then completeRelayConnect() spends the state and redeems the code,
 * server to server, before anything is answered. Nothing is stored unless the state matches and was made for the
 * relay. The answer is only ever a redirect to the setup steps, sent no-store; no token is in any address.
 */
export async function GET(req: Request): Promise<Response> {
  const to = (p: string) => {
    const res = NextResponse.redirect(new URL(p, env.APP_URL));
    res.headers.set("cache-control", "no-store");
    return res;
  };
  const id = await getStaffIdentity();
  // Signed in but not resolvable (disabled) goes where the pages send them; only no session at all goes to sign-in.
  if (!id) return to((await hasStaffSession()) ? "/refused" : "/staff/sign-in");
  const actor = { door: "staff" as const, id: id.staffUserId, label: id.email }, ip = clientIpFrom(req.headers);
  const permission = "Settings.QuickBooks.ReadWrite" as const;
  if (!can(await effectivePermissions(id.staffUserId), permission)) {
    await writeAudit({ actor, action: "access.refused", permission, ip });
    return to("/refused");
  }
  const q = new URL(req.url).searchParams;
  const r = await completeRelayConnect({ code: one(q, "code", 300), state: one(q, "state", 300), error: q.has("error") ? (one(q, "error", 40) ?? "denied") : null },
    { staffUserId: id.staffUserId, actor, ip, permission });
  if (!r.ok) return to(`/staff/settings/quickbooks/setup?step=connect&error=${r.reason}`);
  // The first read, so step 3 can list the customer types. If it fails, step 3 says so and offers to read again.
  await refreshRoster({ startedBy: id.staffUserId, actor, ip });
  return to(`/staff/settings/quickbooks/setup?step=shape${r.oldGrantRevoked === false ? "&moved=old_access_kept" : ""}`);
}
