import "server-only";
import "./init";
import { cache } from "react";
import { headers } from "next/headers";
import { requestIp, stampClientIp } from "@/lib/request";
import { getStaffAuth } from "./staff-auth";
import { getParentAuth } from "./parent-auth";
import { resolveStaff, resolveParentSession, type StaffIdentity, type ParentIdentity, type ParentSessionState } from "./resolve";
import { renewParentSession } from "@/lib/parents/sessions";

export async function getStaffIdentity(): Promise<StaffIdentity | null> {
  const session = await (await getStaffAuth()).api.getSession({ headers: stampClientIp(await headers()) });
  return session ? resolveStaff(session.user.id) : null;
}

/**
 * The parent session as this request sees it (spec §2). Cached per request so the layout and page that both guard a
 * parent page resolve it once, and a refusal (which ends sessions or clears the family, and is audited) happens once.
 *
 * This is also where a session is used: one the portal still accepts has its 90 days started again, at most once a day
 * (renewParentSession). Better Auth has already refused, and removed, a session that ran out.
 */
export const getParentState = cache(async (): Promise<ParentSessionState> => {
  const session = await (await getParentAuth()).api.getSession({ headers: stampClientIp(await headers()) });
  if (!session) return { status: "none" };
  const familyQboId = (session.session as { familyQboId?: string | null }).familyQboId ?? null;
  const state = await resolveParentSession({ id: session.session.id, userId: session.user.id, familyQboId }, await requestIp());
  if (state.status !== "none") await renewParentSession({ id: session.session.id, expiresAt: session.session.expiresAt });
  return state;
});

export async function getParentIdentity(): Promise<ParentIdentity | null> {
  const s = await getParentState();
  return s.status === "ok" ? s.identity : null;
}

/** True when the browser holds a session for that door, even if the identity behind it is refused. */
export async function hasStaffSession(): Promise<boolean> {
  return Boolean(await (await getStaffAuth()).api.getSession({ headers: stampClientIp(await headers()) }));
}
export async function hasParentSession(): Promise<boolean> {
  return Boolean(await (await getParentAuth()).api.getSession({ headers: stampClientIp(await headers()) }));
}
