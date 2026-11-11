import { createHmac } from "node:crypto";

/**
 * The cookie for the staff session scripts/seed-e2e.ts inserts. Read from the installed libraries (better-auth 1.7.18,
 * better-call 1.4.5):
 *  - the name is `<cookiePrefix>.session_token`; the staff instance sets cookiePrefix `br_staff` (src/lib/auth/staff-auth.ts),
 *    and APP_URL is http://localhost:3100 in the e2e run, so there is no `__Secure-` prefix;
 *  - the value is `encodeURIComponent("<token>.<base64 HMAC-SHA256 of the token, keyed by BETTER_AUTH_SECRET>")`
 *    (better-call's signCookieValue: standard base64, with padding).
 * This is test tooling only: it works because the e2e run knows the test secret and seeded the session row itself.
 */
export function staffSessionCookie() {
  const token = "e2e-staff-session-token";
  const signature = createHmac("sha256", process.env.BETTER_AUTH_SECRET!).update(token).digest("base64");
  return { name: "br_staff.session_token", value: encodeURIComponent(`${token}.${signature}`), domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" as const };
}
