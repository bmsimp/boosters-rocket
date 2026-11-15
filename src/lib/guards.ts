import "server-only";
import { redirect } from "next/navigation";
import { getStaffIdentity, getParentIdentity, getParentState, hasStaffSession, hasParentSession } from "@/lib/auth/identity";
import type { StaffIdentity, ParentIdentity } from "@/lib/auth/resolve";
import { effectivePermissions, can, type Effective } from "@/lib/permissions/effective";
import type { Permission } from "@/lib/permissions/registry";
import { requestIp } from "@/lib/request";
import { writeAudit } from "@/lib/audit/log";
import { withReturnPath } from "@/lib/auth/return-path";

export class AccessDenied extends Error {
  constructor() { super("Not allowed"); } // same message whatever the reason (spec §5.1)
}

export type StaffCtx = StaffIdentity & { effective: Effective; ip: string | null };
export type ParentCtx = ParentIdentity & { ip: string | null };

export type GuardInfo = { door: "staff" | "parent" | "setup" | "setup-unlock"; permission?: Permission };
const registry = new WeakMap<object, GuardInfo>();
export function registerGuard(fn: object, info: GuardInfo): void { registry.set(fn, info); }
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

export type ParentSessionCtx = { parentId: string; sessionId: string; ip: string | null };

/** For the family chooser: a signed-in parent, whether or not a family is chosen yet. */
export function parentSessionAction<A extends unknown[], R>(fn: (ctx: ParentSessionCtx, ...args: A) => Promise<R>) {
  const wrapped = async (...args: A): Promise<R> => {
    const s = await getParentState();
    if (s.status === "none") throw new AccessDenied();
    const parentId = s.status === "ok" ? s.identity.parentId : s.parentId;
    const sessionId = s.status === "ok" ? s.identity.sessionId : s.sessionId;
    return fn({ parentId, sessionId, ip: await requestIp() }, ...args);
  };
  registry.set(wrapped, { door: "parent" });
  return wrapped;
}

/**
 * The guard of a parent page. `returnTo` is the page's own address, which the page passes for itself
 * (`requireParentPage("/payments")`, or with the segment it was asked for, `` requireParentPage(`/forms/${id}`) ``): a
 * visitor who has to sign in or choose a family first is brought back to it afterward. It is checked like any value
 * that travels through the browser (src/lib/auth/return-path.ts), because a page may build it from the address it was
 * asked for. Without it the parent lands on the home page.
 */
export async function requireParentPage(returnTo?: string): Promise<ParentCtx> {
  const s = await getParentState();
  if (s.status === "ok") return { ...s.identity, ip: await requestIp() };
  if (s.status === "choose") redirect(withReturnPath("/choose-family", returnTo));
  redirect((await hasParentSession()) ? "/refused" : withReturnPath("/sign-in", returnTo));
}

/**
 * For the parent layout, which draws what surrounds a page: the signed-in parent, or null when there is none to draw
 * it for. The layout then renders its children alone and sends nobody anywhere: the page inside it calls
 * requireParentPage() with its own address. A redirect from the layout would come first and could not say which page
 * was asked for. A layout was never the guard (it does not run again when the browser moves between pages); the pages
 * guard themselves, and tests/integration/page-guards.test.ts checks that each one does.
 */
export async function parentLayoutCtx(): Promise<ParentCtx | null> {
  return parentCtx();
}
