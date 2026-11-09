import { NextResponse } from "next/server";
import { env } from "@/env";
import { getSetupState, finishSetup } from "@/lib/setup/state";
import { hasSetupSession, SETUP_COOKIE } from "@/lib/setup/session";
import { getStaffIdentity, hasStaffSession } from "@/lib/auth/identity";
import { effectivePermissions } from "@/lib/permissions/effective";
import { clientIpFrom } from "@/lib/request";

export const dynamic = "force-dynamic";

/** Step 3 returns here from the staff sign-in. Safe to visit again: it finishes setup once the right Admin is signed in. */
export async function GET(req: Request) {
  const to = (p: string) => NextResponse.redirect(new URL(p, env.APP_URL));
  const state = await getSetupState();
  if (state.status !== "open") return to("/staff");
  if (!(await hasSetupSession())) return to("/setup");
  if (!state.adminEmail) return to("/setup?step=admin");
  const id = await getStaffIdentity();
  if (!id) return to(`/setup?step=admin&error=${(await hasStaffSession()) ? "not_matched" : "no_session"}`);
  if (id.email !== state.adminEmail) return to("/setup?step=admin&error=other_email");
  if (!(await effectivePermissions(id.staffUserId)).isAdmin) return to("/setup?step=admin&error=not_admin");
  await finishSetup({ staffUserId: id.staffUserId, email: id.email, ip: clientIpFrom(req.headers) });
  const res = to("/staff");
  res.cookies.delete(SETUP_COOKIE);
  return res;
}
