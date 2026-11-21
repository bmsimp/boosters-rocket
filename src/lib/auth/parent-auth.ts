import { betterAuth } from "better-auth";
import { passkey } from "@better-auth/passkey";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/lib/db/client";
import { recordSignout } from "./signin-audit";
import { PASSKEY_CHALLENGE_PATH, PASSKEY_REGISTER_PATH, parentCodePlugin } from "./parent-code-plugin";
import { PARENT_SESSION_SECONDS } from "@/lib/parents/sessions";
import { RATE_LIMITS } from "@/lib/parents/rate-limit";
import { parentAuthUser, parentAuthSession, parentAuthAccount, parentAuthVerification, parentAuthPasskey } from "@/lib/db/schema";
import { env } from "@/env";
import { clientAddress, stampingHandler } from "./client-address";
import { isFinishing } from "./finish-scope";
import { afterPasskeyVerified, afterRegistrationVerified } from "./passkey-check";

/**
 * Every Better Auth route a parent doesn't need. Several write (/update-user, the revoke routes, /unlink-account) and
 * none of them is audited, so they answer 404 (Better Auth matches these exactly, before routing). Left reachable:
 * /get-session, /sign-out, the portal's own door (/portal-password/check, /portal-code/resend, /portal-code/check,
 * /portal-app/check and, since the sign-in release's slice SI-7a, /portal-passkey/check), the passkey library's
 * challenge (/passkey/generate-authenticate-options: it takes no query and no body, and lists in `allowCredentials` only
 * the passkeys of the session the request carries, if any; it writes a row of parent_auth_verification, so it has a cap
 * of its own below, answers as a disabled path while sign-ins are off (parent-code-plugin.ts) and its expired rows are
 * swept at every wake of the worker), /ok, /error, and two routes with a path parameter
 * that can't be listed and can't act here: /callback/:id has no provider to call back to, and /reset-password/:token
 * only redirects with a reset row of Better Auth's own verification table, which the portal never writes (since the
 * sign-in release's slice SI-2 a person may have a password, but it is set and reset by the portal's own links,
 * src/lib/parents/signin-links.ts and password-set.ts, and emailAndPassword stays off, so /sign-in/email, /reset-password
 * and the rest answer 404 with a password present too: tests/integration/parent-door.test.ts). The passkey library's
 * other routes are here too (slice SI-7a): its own verify-authentication makes a session itself (the door runs it in
 * process instead, src/lib/auth/passkey-check.ts, where the guard below refuses its session); its verify-registration
 * is run in process by the portal's /portal-passkey/add (slice SI-7b), never over HTTP; and listing, naming and
 * removing are the portal's own (passkey-settings.ts), so its list, update and delete paths stay off. Since slice SI-7b
 * the library's registration options (/passkey/generate-register-options) are reachable, behind the portal plugin's
 * onRequest (parent-code-plugin.ts), which refuses them, with this list's own 404 and no challenge row made, unless the
 * request carries a live parent session that may add a passkey now (mayAddPasskey(), passkey-settings.ts), and with
 * any query at all (the library would take a `name` query as the passkey's user name). Of the library's own routes,
 * /list-sessions and /unlink-account run its fresh-session middleware too, and /delete-user reads `freshAge` itself
 * (deleteUser(), better-auth's update-user.mjs); freshAge 0 skips both checks, and all three are here.
 */
export const PARENT_DISABLED_PATHS = [
  "/sign-in/social", "/sign-up/email", "/sign-in/email", "/reset-password", "/request-password-reset", "/verify-password",
  "/verify-email", "/send-verification-email", "/change-email", "/change-password", "/update-session", "/update-user",
  "/delete-user", "/delete-user/callback", "/list-sessions", "/revoke-session", "/revoke-sessions", "/revoke-other-sessions",
  "/link-social", "/list-accounts", "/unlink-account", "/refresh-token", "/get-access-token", "/account-info",
  "/passkey/verify-authentication", "/passkey/verify-registration",
  "/passkey/list-user-passkeys", "/passkey/delete-passkey", "/passkey/update-passkey",
];

const APP_NAME = "Booster Rocket";
/** The portal's address, whose host is the passkeys' relying party id and whose origin is the only one they work at. */
const portal = () => new URL(env.APP_URL);

/**
 * The passkey library's server plugin (the sign-in release, slice SI-7a; the release's one new dependency): the WebAuthn
 * ceremony is its, the sign-in the portal's. The relying party is set here, never left to the library's defaults and
 * never taken from a request: its id is APP_URL's host name and its origin APP_URL's origin, so a passkey belongs to the
 * portal's address (a club that changes it leaves every parent's passkeys behind: docs/runbooks/first-install.md), and
 * a ceremony anywhere else is one refusal at the server; its name is the instance's. User verification is required and
 * a discoverable credential is required, so no address is ever asked (open question 30) and a passkey is two steps in
 * one (question 35); attestation is none (the library's, fixed); no authenticator attachment, so a phone, a computer, a
 * password manager and a security key are all taken. `afterVerification` records the passkey the library verified for
 * the door (afterPasskeyVerified()), and the session the library then asks for is refused by the guard below. Since
 * slice SI-7b a registration (run in process by /portal-passkey/add) needs the session the request carries
 * (`registration.requireSession`, the library's default, left as it is), and `registration.afterVerification`
 * (afterRegistrationVerified()) refuses one outside the portal's add, one not user-verified and a credential already
 * added, before the library inserts the row. The options' user name and display name are the session user's email
 * (the library's: the person's sign-in address); the portal never sends a `name` query, and the onRequest refuses one.
 */
const parentPasskeys = () => passkey({
  rpID: portal().hostname,
  rpName: APP_NAME,
  origin: portal().origin,
  authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
  authentication: { afterVerification: afterPasskeyVerified },
  registration: { afterVerification: afterRegistrationVerified },
});

/**
 * Better Auth's log, with the passkey library's own error lines cut to their words: it logs the error a failed
 * verification threw, whose message can hold the challenge, the origin or the counters (@simplewebauthn/server's), and
 * none of those belongs in a log. Every other line is as the library writes it.
 */
function parentLog(level: "debug" | "info" | "warn" | "error", message: string, ...args: unknown[]) {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [Better Auth]: ${message}`;
  const rest = message.startsWith("Failed to verify") ? [] : args;
  if (level === "error") console.error(line, ...rest);
  else if (level === "warn") console.warn(line, ...rest);
  else console.log(line, ...rest);
}

// The portal's own door: a password and, on a new device, an emailed code (spec §1 and the sign-in release, slice
// SI-3b), an authenticator app's code or a backup code in its place (SI-6a), and a passkey, alone or as that second
// step (SI-7a); the External ID door is gone.
function buildParentAuth() {
  return betterAuth({
    appName: APP_NAME,
    baseURL: env.APP_URL,
    basePath: "/api/auth/parent",
    secret: env.BETTER_AUTH_SECRET,
    logger: { log: parentLog },
    database: drizzleAdapter(db, {
      provider: "pg",
      // `passkey` is the passkey library's model key, matched by name (slice SI-7a).
      schema: { user: parentAuthUser, session: parentAuthSession, account: parentAuthAccount, verification: parentAuthVerification, passkey: parentAuthPasskey },
    }),
    emailAndPassword: { enabled: false },
    disabledPaths: PARENT_DISABLED_PATHS,
    // A cheap in-memory cap per IP and path in front of the database limits (signin-codes.ts), so a flood is turned
    // away before it reaches Postgres (one per endpoint of the door, parent-code-plugin.ts). Better Auth turns its limiter on only when NODE_ENV is production; that default
    // is kept, so the integration tests don't meet it. A minute here allows what the database allows in 15 minutes
    // (RATE_LIMITS in src/lib/parents/rate-limit.ts), so this cap is never the first one a room full of parents on one
    // Wi-Fi address meets: 20 a minute turned the twenty-first parent of a registration night away.
    rateLimit: { customRules: {
      "/portal-password/check": { window: 60, max: RATE_LIMITS.password_try_ip.max },
      "/portal-code/resend": { window: 60, max: RATE_LIMITS.code_send_ip.max },
      "/portal-code/check": { window: 60, max: RATE_LIMITS.code_check_ip.max },
      "/portal-app/check": { window: 60, max: RATE_LIMITS.code_check_ip.max },
      "/portal-passkey/check": { window: 60, max: RATE_LIMITS.code_check_ip.max },
      // The passkey library's challenge, which every visitor may ask for and which writes a row of
      // parent_auth_verification each time, is held to the passkey check's own cap (slice SI-7a). With no client
      // address (CLIENT_IP_HEADER none) no cap per address can work: the worker's sweep of expired challenges at every
      // wake (sweepExpiredChallenges(), src/lib/jobs/cleanup.ts) bounds the table to about five minutes of requests.
      [PASSKEY_CHALLENGE_PATH]: { window: 60, max: RATE_LIMITS.code_check_ip.max },
      // Adding a passkey (slice SI-7b): the library's registration options, which write a challenge row only for a
      // signed-in parent who proved it's them in the last 10 minutes, and the portal's add, at the code request's cap;
      // asking again with a passkey at the code check's.
      [PASSKEY_REGISTER_PATH]: { window: 60, max: RATE_LIMITS.code_send_ip.max },
      "/portal-passkey/add": { window: 60, max: RATE_LIMITS.code_send_ip.max },
      "/portal-passkey/again": { window: 60, max: RATE_LIMITS.code_check_ip.max },
    } },
    account: { accountLinking: { enabled: false } },
    // The visitor's address comes from the portal's one reading of it (client-address.ts), not from a header named here.
    advanced: { cookiePrefix: "br_parent", ipAddress: clientAddress() },
    databaseHooks: {
      session: {
        // The guard (slice SI-7a): a session is made only inside the one finish (whileFinishing(), finish-scope.ts), so
        // no library route, the passkey library's own sign-in included, makes one, over HTTP or by auth.api. Refused
        // here, before any row exists, it writes and audits nothing.
        create: { before: async () => (isFinishing() ? undefined : false) },
        // The portal writes the parent `signin` row itself, with the family entered (family-choice.ts).
        delete: { after: (session, ctx) => recordSignout("parent", session, ctx) },
      },
    },
    // Spec §1: 90 days, renewed by use; no cookie cache, so ended sessions stop at the next request. Better Auth only
    // sets the row's first expiry and refuses a row past it. Its own refresh stays off: the portal renews the row
    // itself (renewParentSession in src/lib/parents/sessions.ts, called from identity.ts), and the cookie is set once,
    // at sign-in, to outlive it, by the one finish every sign-in goes through (parent-signin-finish.ts).
    // `familyId` is the app's own family record the session chose (`parent_auth_session.family_id`, a uuid), null until
    // it chooses: never a QuickBooks id. input: false, so no route takes it from the browser: only the portal writes it
    // (family-choice.ts), and the gate clears it (src/lib/auth/resolve.ts). It is returned, as every field is unless
    // `returned: false`, which would hide it from api.getSession() too, where the gate reads it (identity.ts): so
    // /get-session answers the session's own family id, or null, beside its expiry and its user.
    // `freshAge: 0` (slice SI-7b): the library's fresh-session middleware, which the passkey registration runs and which
    // would otherwise refuse a session made more than a day ago, is skipped. Freshness is the portal's own window
    // (sessionProvedRecently(), asking-again.ts), read before the options and again at the add.
    session: {
      expiresIn: PARENT_SESSION_SECONDS,
      disableSessionRefresh: true,
      freshAge: 0,
      additionalFields: { familyId: { type: "string", required: false, input: false } },
    },
    // Every sign-in user belongs to a person record, set when the person is made. input: false: a parent can't change the
    // person link through /update-user.
    user: { additionalFields: { parentId: { type: "string", required: true, input: false } } },
    plugins: [parentCodePlugin(), parentPasskeys()],
  });
}

export type ParentAuth = ReturnType<typeof buildParentAuth>;
let built: ParentAuth | null = null;

/** The parent Better Auth instance. */
export async function getParentAuth(): Promise<ParentAuth> {
  built ??= stampingHandler(buildParentAuth());
  return built;
}
