import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { staffAuthUser, parentAuthUser } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { clientIpFrom } from "@/lib/request";

type NewSession = { userId: string; ipAddress?: string | null };
type HookContext = { headers?: Headers; request?: Request } | null | undefined;

/**
 * Records a successful sign-in at a door (spec §13). Runs from Better Auth's
 * `databaseHooks.session.create.after`, so it fires once per new session.
 * The provider has authenticated the person; whether the portal then lets them in
 * is decided (and refusals recorded) by resolveStaff / resolveGuardian.
 */
export async function recordSignin(door: "staff" | "parent", session: NewSession, ctx?: HookContext): Promise<void> {
  const table = door === "staff" ? staffAuthUser : parentAuthUser;
  const [u] = await db.select({ email: table.email }).from(table).where(eq(table.id, session.userId));
  const h = ctx?.headers ?? ctx?.request?.headers;
  const ip = (h ? clientIpFrom(h) : null) ?? session.ipAddress ?? null;
  await writeAudit({ actor: { door, id: null, label: u?.email ?? null }, action: "signin",
    targetType: door === "staff" ? "staff_auth_user" : "parent_auth_user", targetId: session.userId, ip });
}

type EndedSession = { userId: string; ipAddress?: string | null };
type SignoutContext = (NonNullable<HookContext> & { path?: string }) | null | undefined;

/**
 * Records a sign-out at a door (spec §13). Runs from Better Auth's `databaseHooks.session.delete.after`, which also
 * fires when sessions are removed for other reasons (an expired session met by get-session, account deletion,
 * revoking sessions). Only the /sign-out endpoint is a person leaving, so every other path is ignored here.
 */
export async function recordSignout(door: "staff" | "parent", session: EndedSession, ctx?: SignoutContext): Promise<void> {
  if (ctx?.path !== "/sign-out") return;
  const table = door === "staff" ? staffAuthUser : parentAuthUser;
  const [u] = await db.select({ email: table.email }).from(table).where(eq(table.id, session.userId));
  const h = ctx.headers ?? ctx.request?.headers;
  const ip = (h ? clientIpFrom(h) : null) ?? session.ipAddress ?? null;
  await writeAudit({ actor: { door, id: null, label: u?.email ?? null }, action: "signout",
    targetType: door === "staff" ? "staff_auth_user" : "parent_auth_user", targetId: session.userId, ip });
}
