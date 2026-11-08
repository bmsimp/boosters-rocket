import "server-only";
import { redirect } from "next/navigation";
import { getStaffIdentity, getParentIdentity, hasStaffSession, hasParentSession } from "@/lib/auth/identity";
import type { StaffIdentity, ParentIdentity } from "@/lib/auth/resolve";
import { effectivePermissions, can, type Effective } from "@/lib/permissions/effective";
import type { Permission } from "@/lib/permissions/registry";
import { requestIp } from "@/lib/request";
import { writeAudit } from "@/lib/audit/log";

export class AccessDenied extends Error {
  constructor() { super("Not allowed"); } // same message whatever the reason (spec §5.1)
}

export type StaffCtx = StaffIdentity & { effective: Effective; ip: string | null };
export type ParentCtx = ParentIdentity & { ip: string | null };

type GuardInfo = { door: "staff" | "parent"; permission?: Permission };
const registry = new WeakMap<object, GuardInfo>();
export function guardOf(fn: unknown): GuardInfo | undefined {
  return typeof fn === "function" ? registry.get(fn) : undefined;
}

async function staffCtx(permission?: Permission): Promise<StaffCtx | null> {
  const id = await getStaffIdentity();
  if (!id) return null;
  const effective = await effectivePermissions(id.staffUserId);
  if (permission && !can(effective, permission)) {
    await writeAudit({ actor: { door: "staff", id: id.staffUserId, label: id.email }, action: "access.refused", permission, ip: await requestIp() });
    return null;
  }
  return { ...id, effective, ip: await requestIp() };
}

async function parentCtx(): Promise<ParentCtx | null> {
  const id = await getParentIdentity();
  return id ? { ...id, ip: await requestIp() } : null;
}

export function staffAction<A extends unknown[], R>(permission: Permission, fn: (ctx: StaffCtx, ...args: A) => Promise<R>) {
  const wrapped = async (...args: A): Promise<R> => {
    const ctx = await staffCtx(permission);
    if (!ctx) throw new AccessDenied();
    return fn(ctx, ...args);
  };
  registry.set(wrapped, { door: "staff", permission });
  return wrapped;
}

export function parentAction<A extends unknown[], R>(fn: (ctx: ParentCtx, ...args: A) => Promise<R>) {
  const wrapped = async (...args: A): Promise<R> => {
    const ctx = await parentCtx();
    if (!ctx) throw new AccessDenied();
    return fn(ctx, ...args);
  };
  registry.set(wrapped, { door: "parent" });
  return wrapped;
}

export async function requireStaffPage(permission?: Permission): Promise<StaffCtx> {
  const ctx = await staffCtx(permission);
  if (ctx) return ctx;
  // Signed in but refused (unknown, disabled, or missing permission) → the one generic refusal page.
  redirect((await hasStaffSession()) ? "/refused" : "/staff/sign-in");
}

export async function requireParentPage(): Promise<ParentCtx> {
  const ctx = await parentCtx();
  if (ctx) return ctx;
  redirect((await hasParentSession()) ? "/refused" : "/sign-in");
}
