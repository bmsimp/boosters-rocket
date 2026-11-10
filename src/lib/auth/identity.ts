import "server-only";
import "./init";
import { cache } from "react";
import { headers } from "next/headers";
import { requestIp } from "@/lib/request";
import { getStaffAuth } from "./staff-auth";
import { getParentAuth } from "./parent-auth";
import { resolveStaff, resolveParentSession, type StaffIdentity, type ParentIdentity, type ParentSessionState } from "./resolve";

export async function getStaffIdentity(): Promise<StaffIdentity | null> {
  const session = await (await getStaffAuth()).api.getSession({ headers: await headers() });
  return session ? resolveStaff(session.user.id) : null;
}

/**
 * The parent session as this request sees it (spec §2). Cached per request so the layout and page that both guard a
 * parent page resolve it once, and a refusal (which ends sessions or clears the family, and is audited) happens once.
 */
export const getParentState = cache(async (): Promise<ParentSessionState> => {
  const session = await (await getParentAuth()).api.getSession({ headers: await headers() });
  if (!session) return { status: "none" };
  const familyQboId = (session.session as { familyQboId?: string | null }).familyQboId ?? null;
  return resolveParentSession({ id: session.session.id, userId: session.user.id, familyQboId }, await requestIp());
});

export async function getParentIdentity(): Promise<ParentIdentity | null> {
  const s = await getParentState();
  return s.status === "ok" ? s.identity : null;
}

/** True when the browser holds a session for that door, even if the identity behind it is refused. */
export async function hasStaffSession(): Promise<boolean> {
  return Boolean(await (await getStaffAuth()).api.getSession({ headers: await headers() }));
}
export async function hasParentSession(): Promise<boolean> {
  return Boolean(await (await getParentAuth()).api.getSession({ headers: await headers() }));
}
