/**
 * The request a page is rendered for, made up; everything that reads it is real.
 *
 *   import { fromBrowser } from "../helpers/page-request";        // before any import from src/
 *   fromBrowser(cookie);                                           // the cookie a sign-in answered with
 *   const state = await getParentState();                          // src/lib/auth/identity.ts, as a page calls it
 *
 * Importing this module replaces next/headers for the whole test file, and nothing else: the session is read by Better
 * Auth from the cookie, re-checked and renewed as in the running app. Use it to test sign-in and the session itself.
 * To run a page or an action as a parent who is simply signed in, use tests/helpers/signed-in.ts instead, which
 * replaces the session read: the two can't be imported into one test file.
 *
 * vi.mock is hoisted to the top of this file, so the mock is in place before whatever the test file imports after it.
 * Every test starts with no cookie.
 */
import { beforeEach, vi } from "vitest";

const DEFAULT_IP = "203.0.113.30";
/** A cookie a server action set through cookies().set(), as Next.js is given it. */
export type ActionCookie = { name: string; value: string; options: Record<string, unknown> };
const request = vi.hoisted(() => ({ cookie: "", ip: "203.0.113.30", set: [] as ActionCookie[] }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ ...(request.cookie ? { cookie: request.cookie } : {}), "cf-connecting-ip": request.ip }),
  // An action's cookies().set() is recorded (by name and value, with its options, or as one object), and nothing else.
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, delete: () => undefined,
    set: (name: string | ({ name: string; value: string } & Record<string, unknown>), value?: string, options?: Record<string, unknown>) => {
      if (typeof name === "string") request.set.push({ name, value: value ?? "", options: options ?? {} });
      else { const { name: n, value: v, ...rest } = name; request.set.push({ name: n, value: v, options: rest }); }
    } }),
}));

beforeEach(() => { request.cookie = ""; request.ip = DEFAULT_IP; request.set.length = 0; });

/** The next page requests come from a browser holding this cookie (`name=value; name=value`), from this address. */
export function fromBrowser(cookie: string, ip = DEFAULT_IP): void {
  request.cookie = cookie; request.ip = ip;
}

/** The cookies a response set, as a browser sends them back: the `Cookie` header for the next request. */
export function cookiesSetBy(res: Response, prefix = "br_parent"): string {
  return res.headers.getSetCookie().map((c) => c.split(";")[0]!).filter((c) => c.startsWith(prefix)).join("; ");
}

/** The cookies server actions set since the test began (cookies().set()), in the order they were set. */
export const cookiesSetByActions = (): readonly ActionCookie[] => request.set;

/**
 * Those cookies as a browser sends them back: the `Cookie` header for the next request, for fromBrowser(). The value is
 * written as Next.js writes it on the answer (encodeURIComponent), and a cookie set to expire (Max-Age 0) is left out.
 */
export function cookieFromActions(prefix = "br_parent"): string {
  const kept = new Map<string, string>();
  for (const c of request.set) {
    if (!c.name.startsWith(prefix)) continue;
    if (c.options.maxAge === 0) kept.delete(c.name); else kept.set(c.name, encodeURIComponent(c.value));
  }
  return [...kept].map(([n, v]) => `${n}=${v}`).join("; ");
}
