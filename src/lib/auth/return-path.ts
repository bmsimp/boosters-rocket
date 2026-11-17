/**
 * Where a parent lands after signing in: the page they asked for, when that is a parent page of this portal.
 *
 * The value travels through the browser (the `next` parameter of /sign-in and /choose-family, the sign-in form's
 * request, the device's storage), so anyone can write anything into it. It is checked every time it is read, and a
 * value that fails is dropped: the parent lands on the home page. No imports: the sign-in form (a client component)
 * uses this file too.
 */
export const RETURN_PARAM = "next";
export const MAX_RETURN_PATH = 512;

/**
 * First segments that are not parent pages: the staff side, setup, the API, the pages before sign-in, and what Next.js
 * and the installable app serve. tests/unit/return-path.test.ts reads src/app from disk and fails when a folder there
 * that holds a page or a route handler outside src/app/(parent)/ is missing from this list.
 */
export const NOT_PARENT_SECTIONS: readonly string[] = ["api", "staff", "setup", "sign-in", "choose-family", "refused", "icons", "_next"];

/**
 * The whole value, written out: a path of plain segments and, optionally, a plain query string. Everything else is
 * refused by not being listed, which is what keeps it on this site:
 *  - it starts with exactly one "/", so no scheme ("https:", "javascript:") and no "//host";
 *  - no backslash (browsers read "/\host" as "//host"), no control character, space or tab (browsers drop them, which
 *    can turn "/<tab>/host" into "//host"), no "@", ":" or "#", nothing outside ASCII;
 *  - no "%" in the path, so nothing can be hidden there in an encoded form ("%2F", "%5C", "%2e%2e", "%73taff");
 *  - no "." in the path, so no "." or ".." segment and no file ("/sw.js").
 * A query may hold percent-encoded bytes: it is never part of where the address leads.
 */
const SHAPE = /^\/(?:[A-Za-z0-9_~-]+(?:\/[A-Za-z0-9_~-]+)*\/?)?(?:\?(?:[A-Za-z0-9._~=&+-]|%[0-9A-Fa-f]{2})*)?$/;
const NOT_PARENT = new Set(NOT_PARENT_SECTIONS);

/** The value itself when it is a parent path on this site; null for anything else. Pure, and total: any input is answered. */
export function safeReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_RETURN_PATH) return null;
  if (!SHAPE.test(raw)) return null;
  const first = raw.slice(1).split(/[/?]/, 1)[0]!.toLowerCase();
  if (first.startsWith("_") || NOT_PARENT.has(first)) return null;
  return raw;
}

/** Where to go after signing in: the return path when it is safe, the parent home when it is not. */
export const landingPath = (raw: unknown): string => safeReturnPath(raw) ?? "/";

/** /sign-in or /choose-family, carrying the return path when there is a safe one. "/" is where everyone lands anyway, so it is not carried. */
export function withReturnPath(page: "/sign-in" | "/choose-family", raw: unknown): string {
  const next = safeReturnPath(raw);
  return next && next !== "/" ? `${page}?${RETURN_PARAM}=${encodeURIComponent(next)}` : page;
}
