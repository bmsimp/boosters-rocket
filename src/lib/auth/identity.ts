import "server-only";
import { headers } from "next/headers";
import { staffAuth } from "./staff-auth";
import { parentAuth } from "./parent-auth";
import { resolveStaff, resolveGuardian, type StaffIdentity, type ParentIdentity } from "./resolve";

export async function getStaffIdentity(): Promise<StaffIdentity | null> {
  const session = await staffAuth.api.getSession({ headers: await headers() });
  return session ? resolveStaff(session.user.id) : null;
}

export async function getParentIdentity(): Promise<ParentIdentity | null> {
  const session = await parentAuth.api.getSession({ headers: await headers() });
  return session ? resolveGuardian(session.user.id) : null;
}

/** True when the browser holds a session for that door, even if the identity behind it is refused. */
export async function hasStaffSession(): Promise<boolean> {
  return Boolean(await staffAuth.api.getSession({ headers: await headers() }));
}
export async function hasParentSession(): Promise<boolean> {
  return Boolean(await parentAuth.api.getSession({ headers: await headers() }));
}
