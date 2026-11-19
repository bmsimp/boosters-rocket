import { createHmac, randomBytes } from "node:crypto";
import type postgres from "postgres";
import { DEVICE_COOKIE, E2E_SIGNIN, deviceTokenHash } from "./signin-seed";

/**
 * A set-up or reset link for Zelda (the parent scripts/seed-e2e.ts seeds), made the way src/lib/parents/signin-links.ts
 * makes one: 32 random bytes written base64url, stored only as an HMAC-SHA256 keyed with BETTER_AUTH_SECRET over
 * `signin-link:<purpose>:<token>`, one unused per person and purpose. This is test tooling only, as
 * tests/e2e/parent-session.ts reproduces the session cookie's signature: it works because the e2e run knows the test
 * secret. scripts/seed-e2e.ts makes none, so a spec that makes one removes it after (removeZeldaLinks()), with any
 * password it set, and leaves the seed as it found it for the next pass. Since the sign-in release's slice SI-3b the
 * seed gives Zelda a password (tests/e2e/signin-seed.ts) and a remembered device: a spec that needs her with no password
 * takes her row away first (takeZeldaPassword()) and puts it back after (removeZeldaLinks(), which restores it), and
 * removes the devices its sign-ins remembered (removeZeldaDevicesMadeHere()).
 */
export type LinkPurpose = "setup" | "reset";
export const ZELDA_EMAIL = "zelda@example.com";

export const linkTokenHash = (purpose: LinkPurpose, token: string) =>
  createHmac("sha256", process.env.BETTER_AUTH_SECRET!).update(`signin-link:${purpose}:${token}`).digest("hex");

/** A token of a token's shape that names no link: fixed, since a test's title may carry it and titles must not change between loads. */
export const NO_SUCH_LINK = "e2e-no-such-link".padEnd(43, "0");

/** Makes Zelda a live link of `purpose`, in place of any unused one, and returns its token. */
export async function mintZeldaLink(sql: postgres.Sql, purpose: LinkPurpose): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sql.begin(async (tx) => {
    const [p] = await tx`SELECT id FROM parent WHERE email = ${ZELDA_EMAIL} FOR UPDATE`;
    await tx`DELETE FROM parent_signin_token WHERE parent_id = ${p!.id} AND purpose = ${purpose} AND used_at IS NULL`;
    await tx`INSERT INTO parent_signin_token (purpose, parent_id, token_hash, expires_at)
             VALUES (${purpose}, ${p!.id}, ${linkTokenHash(purpose, token)}, now() + interval '1 hour')`;
  });
  return token;
}

/**
 * The key a per-address count of "Set up or reset my password" is kept under, as src/lib/parents/password-request.ts
 * keeps it (hashAskedAddress(): an HMAC-SHA256 keyed with BETTER_AUTH_SECRET over `password-ask:<address>`).
 */
export const askedAddressHash = (address: string) =>
  createHmac("sha256", process.env.BETTER_AUTH_SECRET!).update(`password-ask:${address}`).digest("hex");

/** The session the seed gives Zelda (scripts/seed-e2e.ts), which every other session of hers was made by a spec. */
export const SEEDED_ZELDA_SESSION = "e2e-parent-session";

/** Ends the sessions a spec signed Zelda in with, keeping the one the seed gave her. */
export async function removeZeldaSessionsMadeHere(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM parent_auth_session WHERE id <> ${SEEDED_ZELDA_SESSION}
            AND user_id = (SELECT id FROM parent_auth_user WHERE parent_id = (SELECT id FROM parent WHERE email = ${ZELDA_EMAIL}))`;
}

const ZELDA_USER = (sql: postgres.Sql | postgres.TransactionSql) => sql`(SELECT id FROM parent_auth_user WHERE parent_id = (SELECT id FROM parent WHERE email = ${ZELDA_EMAIL}))`;
/**
 * Where the seed's password row waits while a spec has taken it away: the same row under a provider nothing in the
 * portal reads (every read of a password asks for `credential`). It is kept in the database, not in this module, so
 * the restore works from any worker process: one restarted after a failure, or a pass whose specs never took it (the
 * phone pass runs parent-a11y.spec.ts's afterAll with every test skipped).
 */
const KEPT = "e2e-kept-credential";

/**
 * Takes Zelda's password away, so she has none (a set-up link works only then), keeping the seed's row to put back.
 * Taken twice without a restore, the first kept row stays the seed's, and whatever row she has now goes.
 */
export async function takeZeldaPassword(sql: postgres.Sql): Promise<void> {
  await sql.begin(async (tx) => {
    const [kept] = await tx`SELECT 1 FROM parent_auth_account WHERE provider_id = ${KEPT} AND user_id = ${ZELDA_USER(tx)}`;
    if (kept) await tx`DELETE FROM parent_auth_account WHERE provider_id = 'credential' AND user_id = ${ZELDA_USER(tx)}`;
    else await tx`UPDATE parent_auth_account SET provider_id = ${KEPT} WHERE provider_id = 'credential' AND user_id = ${ZELDA_USER(tx)}`;
  });
}

/**
 * Removes every link of Zelda's and, when a spec took her password away, any password a spec set since, putting the
 * seed's row back (E2E_SIGNIN.password), so the next spec and the next pass find her as the seed left her. When nothing
 * was taken her row is the seed's and is left alone.
 */
export async function removeZeldaLinks(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM parent_signin_token WHERE parent_id = (SELECT id FROM parent WHERE email = ${ZELDA_EMAIL})`;
  await sql.begin(async (tx) => {
    const [kept] = await tx`SELECT 1 FROM parent_auth_account WHERE provider_id = ${KEPT} AND user_id = ${ZELDA_USER(tx)}`;
    if (!kept) return;
    await tx`DELETE FROM parent_auth_account WHERE provider_id = 'credential' AND user_id = ${ZELDA_USER(tx)}`;
    await tx`UPDATE parent_auth_account SET provider_id = 'credential' WHERE provider_id = ${KEPT} AND user_id = ${ZELDA_USER(tx)}`;
  });
}

/** Removes the devices a spec's sign-ins remembered for Zelda, keeping the one the seed gave her. */
export async function removeZeldaDevicesMadeHere(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM parent_device WHERE parent_id = (SELECT id FROM parent WHERE email = ${ZELDA_EMAIL})
            AND token_hash <> ${deviceTokenHash(E2E_SIGNIN.zeldaDevice)}`;
}

/** The cookie of Zelda's seeded remembered device, for context.addCookies(). */
export const zeldaDeviceCookie = (baseURL: string) => ({ name: DEVICE_COOKIE.name, value: E2E_SIGNIN.zeldaDevice, domain: new URL(baseURL).hostname,
  path: DEVICE_COOKIE.path, httpOnly: true, sameSite: "Lax" as const, secure: false });
