import { expect, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parent, parentAuthAccount, parentAuthUser } from "@/lib/db/schema";
import { getParentAuth } from "@/lib/auth/parent-auth";
import { env } from "@/env";
import { normalizeEmail } from "@/lib/email";
import { seedPassword } from "./signin-links";
import type { StepPerson } from "@/lib/parents/signin-codes";

/**
 * Signing a parent in through the door, as a browser does (the sign-in release, slice SI-3b): the password at
 * /portal-password/check, then, on a device the portal doesn't remember, the code it mails, at /portal-code/check with
 * the pending step's cookie. Each test file keeps its own `vi.mock("@/lib/mail/senders", ...)` and passes its outbox.
 */

/** The address a door request comes from, in the client-IP header (cf-connecting-ip, the default CLIENT_IP_HEADER). */
export const DOOR_IP = "203.0.113.30";
/** The password the helper gives a person who has none. */
export const DOOR_PASSWORD = "the parents' long test password";

type Mail = { to: string; subject: string };
/** What a door endpoint answered. */
export type DoorBody = { ok: boolean; next?: string; step?: "code" | "app"; error?: string; ended?: boolean };
/** Request headers beside the content type and origin; by default the client-IP header with DOOR_IP. */
type Headers = Record<string, string>;

/** A request to the parent door, as parent-door.test.ts makes one: the origin, and the visitor's address in its header. */
export async function postDoor(path: string, body: unknown, o: { cookie?: string; headers?: Headers } = {}): Promise<Response> {
  const auth = await getParentAuth();
  return auth.handler(new Request(`${env.APP_URL}/api/auth/parent${path}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin: env.APP_URL, ...(o.headers ?? { "cf-connecting-ip": DOOR_IP }), ...(o.cookie ? { cookie: o.cookie } : {}) },
  }));
}

/** The cookies a response sets, by name (`name=value` only), with a cleared one (empty value) as "". */
export function cookiesSet(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(";")[0]!;
    const at = pair.indexOf("=");
    out[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return out;
}
/** The whole `Set-Cookie` line a response sets for a cookie whose name ends with `name`, or undefined. */
export const setCookieLine = (res: Response, name: string) => res.headers.getSetCookie().find((l) => l.split("=")[0]!.endsWith(name));

/** The door's cookies of a response, as a Cookie header a browser would send back: every `br_parent` cookie with a value. */
export const cookieHeader = (...responses: Response[]) => responses.flatMap((r) => Object.entries(cookiesSet(r)))
  .filter(([name, value]) => name.includes("br_parent") && value !== "").map(([n, v]) => `${n}=${v}`).join("; ");
/** One cookie of a response by the end of its name (`session_token`, `device`, `signin_step`), as `name=value`, or "". */
export function cookieNamed(res: Response, name: string): string {
  const found = Object.entries(cookiesSet(res)).find(([n, v]) => n.endsWith(`.${name}`) && v !== "");
  return found ? `${found[0]}=${found[1]}` : "";
}

/** Gives the person who holds the address the password, unless they have one. */
export async function ensurePassword(email: string, password = DOOR_PASSWORD): Promise<void> {
  const address = normalizeEmail(email);
  if (!address) return;
  const [p] = await db.select({ authUserId: parentAuthUser.id }).from(parent).innerJoin(parentAuthUser, eq(parentAuthUser.parentId, parent.id)).where(eq(parent.email, address));
  if (!p) return;
  const has = await db.select({ id: parentAuthAccount.id }).from(parentAuthAccount)
    .where(and(eq(parentAuthAccount.userId, p.authUserId), eq(parentAuthAccount.providerId, "credential")));
  if (has.length === 0) await seedPassword(p.authUserId, password);
}

/** The code of the newest mail to `to` after the first `since` mails of the outbox. */
export async function codeMailed(outbox: Mail[], to: string, since: number): Promise<string> {
  await vi.waitFor(() => expect(outbox.slice(since).some((m) => m.to === to)).toBe(true));
  const mail = outbox.slice(since).filter((m) => m.to === to).at(-1)!;
  return /sign-in code: (\d{6})/.exec(mail.subject)![1]!;
}

/** The password step: its response, its body, and the Cookie header to send on (the pending step, any device). */
export async function passwordStep(email: string, o: { password?: string; next?: string; cookie?: string; headers?: Headers } = {}) {
  const res = await postDoor("/portal-password/check", { email, password: o.password ?? DOOR_PASSWORD, ...(o.next ? { next: o.next } : {}) }, o);
  return { res, body: (await res.json()) as DoorBody, pending: cookieNamed(res, "signin_step") };
}

/** The code step with a Cookie header (the pending step's, normally): its response and body. */
export async function codeStep(code: string, cookie: string, o: { next?: string; headers?: Headers } = {}) {
  const res = await postDoor("/portal-code/check", { code, ...(o.next ? { next: o.next } : {}) }, { cookie, headers: o.headers });
  return { res, body: (await res.json()) as DoorBody };
}

/**
 * The app step with a Cookie header (the pending step's, normally): an authenticator app's code or a backup code at
 * /portal-app/check (the sign-in release, slice SI-6a). Its response and body.
 */
export async function appStep(code: string, cookie: string, o: { next?: string; headers?: Headers } = {}) {
  const res = await postDoor("/portal-app/check", { code, ...(o.next ? { next: o.next } : {}) }, { cookie, headers: o.headers });
  return { res, body: (await res.json()) as DoorBody };
}

/**
 * Signs the person who holds `email` in through the door: gives them DOOR_PASSWORD when they have no password (so a
 * test that seeded people by hand needs nothing more), posts the password with the device cookie in `cookie` (if any),
 * and, when a code is asked for, reads it from `outbox` and posts it with the pending step. Returns the last response,
 * its body, the session's Cookie header (`cookie`: the session and, once remembered, the device), and the cookies set.
 */
export async function signInThroughDoor(outbox: Mail[], email: string, o: { password?: string; next?: string; cookie?: string; headers?: Headers } = {}) {
  await ensurePassword(email);
  const since = outbox.length;
  const first = await passwordStep(email, o);
  if (!first.body.ok || first.body.step !== "code") {
    return { res: first.res, body: first.body, cookie: cookieHeader(first.res), codeAsked: false, set: cookiesSet(first.res) };
  }
  const code = await codeMailed(outbox, normalizeEmail(email) ?? email, since);
  const sent = [first.pending, o.cookie].filter(Boolean).join("; ");
  const { res, body } = await codeStep(code, sent, o);
  return { res, body, cookie: cookieHeader(res), codeAsked: true, set: cookiesSet(res) };
}

/**
 * The person a pending step proved with this address would name, as the password step hands it on: their id, the
 * address, and their password as checked (given DOOR_PASSWORD first when they have none). For calling the second step's
 * functions (sendSecondStepCode(), verifySigninCode()) directly.
 */
export async function stepPersonFor(email: string): Promise<StepPerson> {
  await ensurePassword(email);
  const address = normalizeEmail(email)!;
  const [row] = await db.select({ parentId: parent.id, credentialId: parentAuthAccount.id,
    updatedAt: sql<Date>`${parentAuthAccount.updatedAt}`.mapWith(parentAuthAccount.updatedAt) }).from(parent)
    .innerJoin(parentAuthUser, eq(parentAuthUser.parentId, parent.id))
    .innerJoin(parentAuthAccount, and(eq(parentAuthAccount.userId, parentAuthUser.id), eq(parentAuthAccount.providerId, "credential")))
    .where(eq(parent.email, address));
  if (!row) throw new Error(`nobody signs in with ${address}`);
  return { parentId: row.parentId, email: address, password: { credentialId: row.credentialId, credentialUpdatedAt: row.updatedAt } };
}
