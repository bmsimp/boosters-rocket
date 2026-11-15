/**
 * Run pages and server actions as a signed-in parent (or staff member) without a browser.
 *
 *   import { asParent, renderPage } from "../helpers/signed-in";   // before any import from src/
 *   const { a } = await seedTwoFamilies();
 *   asParent(a.identity);
 *   const html = await renderPage(ParentHome);
 *
 * Importing this module replaces, for the whole test file, the four things a page or action reaches outside itself for:
 * who is signed in (@/lib/auth/identity), the request (next/headers), cache invalidation (next/cache) and navigation
 * (next/navigation: redirect() and notFound() throw, as they do in Next.js). Everything below the guards is real: the
 * permission check, the audit log, the queries. Every test starts signed out.
 *
 * Import it before the pages and actions under test: a module loaded earlier keeps the real imports. vi.mock is hoisted
 * to the top of this file, so the mocks are in place before this file's own imports and before whatever the test file
 * imports after it. A test file that needs a different mock of one of these four modules writes its own block instead.
 */
import { beforeEach, vi } from "vitest";
import type { ReactNode } from "react";
import { prerender } from "react-dom/static";
import type { ParentIdentity, ParentSessionState, StaffIdentity } from "@/lib/auth/resolve";

const state = vi.hoisted(() => ({
  parent: { status: "none" } as unknown,
  parentSession: false,
  staff: null as unknown,
  staffSession: false,
  ip: "203.0.113.50",
  pathname: "/",
  revalidated: [] as string[],
}));

vi.mock("@/lib/auth/identity", () => ({
  getParentState: async () => state.parent,
  getParentIdentity: async () => { const s = state.parent as ParentSessionState; return s.status === "ok" ? s.identity : null; },
  hasParentSession: async () => state.parentSession,
  getStaffIdentity: async () => state.staff,
  hasStaffSession: async () => state.staffSession,
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "cf-connecting-ip": state.ip }),
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined, delete: () => undefined }),
}));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => { state.revalidated.push(path); } }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw Object.assign(new Error("NEXT_NOT_FOUND"), { notFound: true }); },
  // Client components render on the server too, so their hooks need an answer.
  usePathname: () => state.pathname,
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined, back: () => undefined, forward: () => undefined, prefetch: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
}));

/** Nobody is signed in at either door; the request's address, the path and the revalidated paths are as at the start. Runs before every test. */
export function signedOut(): void {
  state.parent = { status: "none" }; state.parentSession = false;
  state.staff = null; state.staffSession = false;
  state.ip = "203.0.113.50"; state.pathname = "/"; state.revalidated.length = 0;
}
beforeEach(signedOut);

/** A parent with a live session and this family chosen: what seedSignedInParent() and seedTwoFamilies() return as `identity`. */
export function asParent(identity: ParentIdentity): void {
  state.parent = { status: "ok", identity } satisfies ParentSessionState;
  state.parentSession = true;
}

/** The same parent with a live session but no family chosen yet: parent pages send them to /choose-family. */
export function asParentChoosing(identity: ParentIdentity): void {
  state.parent = { status: "choose", parentId: identity.parentId, sessionId: identity.sessionId, name: identity.name, families: identity.families } satisfies ParentSessionState;
  state.parentSession = true;
}

/** A browser that holds a parent session the portal refuses (blocked, or no family left): parent pages send it to /refused. */
export function asRefusedParent(): void {
  state.parent = { status: "none" }; state.parentSession = true;
}

/** A staff member, as seedStaff() returns one. Their permissions are read from the database as usual. */
export function asStaff(staff: { id: string; name: string; email: string }): void {
  state.staff = { door: "staff", staffUserId: staff.id, name: staff.name, email: staff.email } satisfies StaffIdentity;
  state.staffSession = true;
}

/** The request's address, as the audit log records it. */
export function fromIp(ip: string): void { state.ip = ip; }
/** The path client components see from usePathname(). */
export function atPath(pathname: string): void { state.pathname = pathname; }
/** The paths passed to revalidatePath() since the test began. */
export const revalidatedPaths = (): readonly string[] => state.revalidated;

export type PageProps = { params?: Record<string, string | string[]>; searchParams?: Record<string, string | string[] | undefined> };
// A page declares its own props type; the helper passes params and searchParams as the promises Next.js gives it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Page = (props: any) => ReactNode | Promise<ReactNode>;
export type PageOutcome = { html: string } | { redirect: string } | { notFound: true };

/**
 * What asking for a page gives: its HTML, or where it redirects, or a 404. The rendering waits for async server
 * components and data, and its text-node separators (<!-- -->) are dropped so text reads as it does on the page.
 */
export async function pageOutcome(page: Page, props: PageProps = {}): Promise<PageOutcome> {
  try {
    const element = await page({ params: Promise.resolve(props.params ?? {}), searchParams: Promise.resolve(props.searchParams ?? {}) });
    const errors: unknown[] = [];
    const { prelude } = await prerender(element, { onError: (e) => { errors.push(e); } });
    if (errors.length) throw errors[0];
    return { html: (await new Response(prelude).text()).replaceAll("<!-- -->", "") };
  } catch (e) {
    const thrown = e as { url?: unknown; notFound?: unknown } | null;
    if (typeof thrown?.url === "string") return { redirect: thrown.url };
    if (thrown?.notFound === true) return { notFound: true };
    throw e;
  }
}

/** The page's HTML. Fails, saying where it went, if the page redirected or answered 404 instead. */
export async function renderPage(page: Page, props: PageProps = {}): Promise<string> {
  const outcome = await pageOutcome(page, props);
  if ("html" in outcome) return outcome.html;
  throw new Error("redirect" in outcome ? `The page redirected to ${outcome.redirect} instead of rendering` : "The page answered 404 instead of rendering");
}

/** Where a server action (or anything else) redirected, or null if it returned. Other errors are thrown on. */
export async function redirectOf(running: Promise<unknown>): Promise<string | null> {
  try { await running; return null; } catch (e) {
    const url = (e as { url?: unknown } | null)?.url;
    if (typeof url === "string") return url;
    throw e;
  }
}
