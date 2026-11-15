import { createHmac } from "node:crypto";

/**
 * The cookie for the parent session scripts/seed-e2e.ts inserts: Zelda, with the family E2E-FAMILY chosen. Made the way
 * tests/e2e/staff-session.ts makes the staff one, read from the installed libraries (better-auth 1.7.18, better-call 1.4.5):
 *  - the name is `<cookiePrefix>.session_token`; the parent instance sets cookiePrefix `br_parent` (src/lib/auth/parent-auth.ts),
 *    and APP_URL is http://localhost:3100 in the e2e run, so there is no `__Secure-` prefix;
 *  - the value is `encodeURIComponent("<token>.<base64 HMAC-SHA256 of the token, keyed by BETTER_AUTH_SECRET>")`
 *    (better-call's signCookieValue: standard base64, with padding).
 * This is test tooling only: it works because the e2e run knows the test secret and seeded the session row itself.
 * Use: `await context.addCookies([parentSessionCookie()])`, then open a parent page.
 */
export const PARENT_SESSION_TOKEN = "e2e-parent-session-token";
export const PARENT_SESSION_FAMILY = "E2E-FAMILY";

export function parentSessionCookie(token = PARENT_SESSION_TOKEN) {
  const signature = createHmac("sha256", process.env.BETTER_AUTH_SECRET!).update(token).digest("base64");
  return { name: "br_parent.session_token", value: encodeURIComponent(`${token}.${signature}`), domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" as const };
}
