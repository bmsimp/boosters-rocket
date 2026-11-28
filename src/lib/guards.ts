import "server-only";
import { notFound, redirect } from "next/navigation";
import { getStaffIdentity, getParentIdentity, getParentState, hasStaffSession, hasParentSession } from "@/lib/auth/identity";
import type { StaffIdentity, ParentIdentity } from "@/lib/auth/resolve";
import { effectivePermissions, can, type Effective } from "@/lib/permissions/effective";
import type { Permission } from "@/lib/permissions/registry";
import { requestIp } from "@/lib/request";
import { writeAudit } from "@/lib/audit/log";
import { withReturnPath } from "@/lib/auth/return-path";
import { pluginOn } from "@/plugins";

export class AccessDenied extends Error {
  constructor() { super("Not allowed"); } // same message whatever the reason (spec §5.1)
}

export type StaffCtx = StaffIdentity & { effective: Effective; ip: string | null };
export type ParentCtx = ParentIdentity & { ip: string | null };

export type GuardInfo = { door: "staff" | "parent" | "setup" | "setup-unlock" | "before-sign-in" | "enrolment"; permission?: Permission; self?: true };
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

/**
 * A staff member acting on their own record and nothing else (their own name): any signed-in staff member, with no
 * permission to check. The action must read and change only `ctx.staffUserId`'s own row, never an id it is given.
 * Registered as the staff door with `self`, which tests/integration/invariants.test.ts accepts in place of a permission.
 */
export function staffSelfAction<A extends unknown[], R>(fn: (ctx: StaffCtx, ...args: A) => Promise<R>) {
  const wrapped = async (...args: A): Promise<R> => {
    const ctx = await staffCtx();
    if (!ctx) throw new AccessDenied();
    return fn(ctx, ...args);
  };
  registry.set(wrapped, { door: "staff", self: true });
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

export type BeforeSignInCtx = { ip: string | null };

/**
 * An action a visitor takes before they have signed in: choosing a password from a set-up or reset link, and asking
 * for such a link by email ("Set up or reset my password"). There is no session to check, so, as setupUnlockAction()'s
 * (src/lib/setup/guard.ts), its guard is the check its function performs: the link it is given, looked up and checked
 * in full (src/lib/parents/signin-links.ts), limited per address and per link, with one answer for every refusal; or,
 * for the ask, which carries no token, its limits (per address, under a keyed hash, and per IP address) and its one
 * answer for every address (src/lib/parents/password-request.ts). A sign-in it leads to is finished only by the one
 * finish every sign-in goes through (src/lib/auth/parent-signin-finish.ts). The function is given only the visitor's
 * address. Registered as the door
 * "before-sign-in", which tests/integration/invariants.test.ts allows in one file only, src/app/sign-in/password-actions.ts:
 * a new use of it is a decision, with its own checklist in AGENTS.md ("Page or action before sign-in").
 */
export function beforeSignInAction<A extends unknown[], R>(fn: (ctx: BeforeSignInCtx, ...args: A) => Promise<R>) {
  const wrapped = async (...args: A): Promise<R> => fn({ ip: await requestIp() }, ...args);
  registry.set(wrapped, { door: "before-sign-in" });
  return wrapped;
}

export async function requireStaffPage(permission?: Permission): Promise<StaffCtx> {
  const ctx = await staffCtx(permission);
  if (ctx) return ctx;
  // Signed in but refused (unknown, disabled, or missing permission) → the one generic refusal page.
  redirect((await hasStaffSession()) ? "/refused" : "/staff/sign-in");
}

/**
 * The guard of a page a plugin brings (docs/superpowers/specs/2026-11-28-accounting-plugin-design.md, section 3,
 * "Pages"): `notFound()` while the plugin is off, before anything about the visitor is read, so a page of a plugin
 * that is off is not there for anyone; then requireStaffPage() with the page's permission.
 */
export async function requirePluginPage(key: string, permission?: Permission): Promise<StaffCtx> {
  if (!(await pluginOn(key))) notFound();
  return requireStaffPage(permission);
}

/**
 * A second permission a staff page needs beside the one its guard checked (a role written with patterns can hold one
 * without the other): refused as the guard refuses, with the same `access.refused` row naming the permission missing,
 * then the one generic refusal page.
 */
export async function requireStaffAlso(ctx: StaffCtx, permission: Permission): Promise<void> {
  if (can(ctx.effective, permission)) return;
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "access.refused", permission, ip: ctx.ip });
  redirect("/refused");
}

/**
 * requireStaffAlso() for a server action: a second permission the action needs beside the one its staffAction() guard
 * checked, refused as that guard refuses, with the same `access.refused` row naming the permission missing, then
 * AccessDenied, which the page's safely() turns into the one generic answer.
 */
export async function requireStaffActionAlso(ctx: StaffCtx, permission: Permission): Promise<void> {
  if (can(ctx.effective, permission)) return;
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "access.refused", permission, ip: ctx.ip });
  throw new AccessDenied();
}

export type ParentSessionCtx ={ parentId: string; sessionId: string; ip: string | null };

/**
 * For the family chooser: a signed-in parent, whether or not a family is chosen yet. An enrolling session (Strict's
 * enrolment, since the sign-in release's slice SI-10a) is refused, as no session is: it may choose no family.
 */
export function parentSessionAction<A extends unknown[], R>(fn: (ctx: ParentSessionCtx, ...args: A) => Promise<R>) {
  const wrapped = async (...args: A): Promise<R> => {
    const s = await getParentState();
    if (s.status === "none" || s.status === "enrol") throw new AccessDenied();
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
  // Strict's enrolment (slice SI-10a): a session a password alone made reaches no family page, only the step that adds
  // a passkey or an authenticator app, which carries the page asked for on.
  if (s.status === "enrol") redirect(withReturnPath("/one-more-step", returnTo));
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

/**
 * Strict's enrolment (the sign-in release, slice SI-10a): a session made under Strict by a password alone, for a person
 * with no second factor, which may do exactly two things, add a passkey or set up an authenticator app, and reach
 * nothing else (the gate's `enrol`, src/lib/auth/resolve.ts). Its ctx is the person and the session, and the address
 * the session's person holds, as the factor's presses take them (passkey-settings.ts, authenticator-settings.ts): no
 * name, no family.
 */
export type EnrolmentCtx = { parentId: string; sessionId: string; email: string; ip: string | null };

/**
 * The guard of /one-more-step (src/app/one-more-step/page.tsx), the page an enrolling session reaches: its ctx for an
 * enrolling session; a session that is whole (a family chosen or to choose) is sent home, where the gate takes it on;
 * none (or one the gate has just ended, its window passed) to sign in.
 */
export async function requireEnrolmentPage(): Promise<EnrolmentCtx> {
  const s = await getParentState();
  if (s.status === "enrol") return { parentId: s.parentId, sessionId: s.sessionId, email: s.email, ip: await requestIp() };
  if (s.status === "ok" || s.status === "choose") redirect("/");
  redirect("/sign-in");
}

/**
 * An action an enrolling session takes on /one-more-step: admitted only for the gate's `enrol`, never for a whole
 * session or none. Registered as the door "enrolment", which tests/integration/invariants.test.ts allows in one file
 * only, src/app/one-more-step/actions.ts: a new use of it is a decision. The function is given the person and session
 * from the gate, never from the browser.
 */
export function enrolmentAction<A extends unknown[], R>(fn: (ctx: EnrolmentCtx, ...args: A) => Promise<R>) {
  const wrapped = async (...args: A): Promise<R> => {
    const s = await getParentState();
    if (s.status !== "enrol") throw new AccessDenied();
    return fn({ parentId: s.parentId, sessionId: s.sessionId, email: s.email, ip: await requestIp() }, ...args);
  };
  registry.set(wrapped, { door: "enrolment" });
  return wrapped;
}
