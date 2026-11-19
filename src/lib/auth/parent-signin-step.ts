// The two cookies of a parent's password sign-in (the sign-in release, slice SI-3b), set, read and cleared here and
// nowhere else but through the one finish (parent-signin-finish.ts), which calls this module for them. Server only.
//
// - The pending step: the state between a right password and the emailed code. A signed, HttpOnly cookie of the
//   portal's own (never a session, never a row), naming the person, the address the password was proved with, the
//   `credential` row it was checked against (its id and `updated_at`) and when it ends (CODE_TTL_MS after the right
//   password, never extended). It is made only after a right password (/portal-password/check), so a stranger who knows
//   only an address can never make the portal mail a code; /portal-code/resend and /portal-code/check take the person
//   and the address from it and from nothing the browser sends. A value that is unsigned, mis-signed, malformed or past
//   its end is no pending step. It is cleared by a sign-in that finishes and by a refusal that ends the step.
// - The device: a remembered device's token (src/lib/parents/devices.ts holds only its keyed hash), set when a sign-in that
//   proved a password and a second step, or a set-up link, finishes, for the device's 90 days, and set again with the
//   same token when a password sign-in on the device renews it. One per browser: a second person signing in on a shared
//   browser replaces it with their own, and the first person's row stays until it expires (or is forgotten).
//
// Both are made by Better Auth's createAuthCookie() (so `br_parent.` plus the name, with the `__Secure-` prefix and
// Secure when APP_URL is https, HttpOnly, SameSite=Lax), on the path of the door's endpoints alone, so no page request
// carries them.
import "server-only";
import type { GenericEndpointContext } from "better-auth";
import { CODE_TTL_MS } from "@/lib/parents/signin-codes";
import { isDeviceToken, type DeviceCookie } from "@/lib/parents/devices";

const PENDING = "signin_step";
const DEVICE = "device";
/** Only the door's endpoints read these cookies (parent-auth.ts's basePath). */
const DOOR_PATH = "/api/auth/parent";
const MOST_STORED = 2048;

/** A pending step as the server signed it. */
export type PendingStep = { parentId: string; email: string; credentialId: string; credentialUpdatedAt: Date; endsAt: Date };

const seconds = (ms: number) => Math.max(0, Math.floor(ms / 1000));
const cookieOf = (ctx: GenericEndpointContext, name: string, maxAge?: number) => {
  const c = ctx.context.createAuthCookie(name, maxAge === undefined ? {} : { maxAge });
  return { name: c.name, attributes: { ...c.attributes, path: DOOR_PATH, httpOnly: true, sameSite: "lax" as const } };
};

/** Sets the pending step after a right password: it ends CODE_TTL_MS from `now`, and its cookie with it. */
export async function setPendingStep(ctx: GenericEndpointContext, s: Omit<PendingStep, "endsAt">, now: Date): Promise<void> {
  const endsAt = now.getTime() + CODE_TTL_MS;
  const value = Buffer.from(JSON.stringify({ p: s.parentId, e: s.email, c: s.credentialId, u: s.credentialUpdatedAt.getTime(), x: endsAt })).toString("base64url");
  const c = cookieOf(ctx, PENDING, seconds(CODE_TTL_MS));
  await ctx.setSignedCookie(c.name, value, ctx.context.secret, c.attributes);
}

/** The pending step the request carries, signed by this server and not yet ended, or null. */
export async function readPendingStep(ctx: GenericEndpointContext, now: Date): Promise<PendingStep | null> {
  const c = cookieOf(ctx, PENDING);
  const value = await ctx.getSignedCookie(c.name, ctx.context.secret);
  if (typeof value !== "string" || value.length === 0 || value.length > MOST_STORED) return null;
  try {
    const v = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown> | null;
    const str = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 320;
    const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
    if (!v || !str(v.p) || !str(v.e) || !str(v.c) || !num(v.u) || !num(v.x)) return null;
    // Never longer than a code's life from now, whatever the value says, and nothing past its end.
    if (v.x <= now.getTime() || v.x > now.getTime() + CODE_TTL_MS) return null;
    return { parentId: v.p, email: v.e, credentialId: v.c, credentialUpdatedAt: new Date(v.u), endsAt: new Date(v.x) };
  } catch {
    return null;
  }
}

/** Ends the pending step, when the request carries one (so a sign-in that never had one sets no cookie for it). */
export function clearPendingStep(ctx: GenericEndpointContext): void {
  const c = cookieOf(ctx, PENDING, 0);
  if (ctx.getCookie(c.name) !== null) ctx.setCookie(c.name, "", c.attributes);
}

/** The remembered device's token the request carries, of a device token's shape, or null. */
export function readDeviceToken(ctx: GenericEndpointContext): string | null {
  const token = ctx.getCookie(cookieOf(ctx, DEVICE).name);
  return isDeviceToken(token) ? token : null;
}

/** Sets the device's cookie, for as long as its row lives. */
export function setDeviceCookie(ctx: GenericEndpointContext, d: DeviceCookie, now: Date): void {
  const c = cookieOf(ctx, DEVICE, seconds(d.expiresAt.getTime() - now.getTime()));
  ctx.setCookie(c.name, d.token, c.attributes);
}
