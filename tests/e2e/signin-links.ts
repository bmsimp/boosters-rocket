import { createHmac, randomBytes } from "node:crypto";
import type postgres from "postgres";

/**
 * A set-up or reset link for Zelda (the parent scripts/seed-e2e.ts seeds), made the way src/lib/parents/signin-links.ts
 * makes one: 32 random bytes written base64url, stored only as an HMAC-SHA256 keyed with BETTER_AUTH_SECRET over
 * `signin-link:<purpose>:<token>`, one unused per person and purpose. This is test tooling only, as
 * tests/e2e/parent-session.ts reproduces the session cookie's signature: it works because the e2e run knows the test
 * secret. scripts/seed-e2e.ts makes none, so a spec that makes one removes it after (removeZeldaLinks()), with any
 * password it set, and leaves the seed as it found it for the next pass.
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

/** Removes every link of Zelda's and her password, which the seed gives her none of. */
export async function removeZeldaLinks(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM parent_signin_token WHERE parent_id = (SELECT id FROM parent WHERE email = ${ZELDA_EMAIL})`;
  await sql`DELETE FROM parent_auth_account WHERE provider_id = 'credential'
            AND user_id = (SELECT id FROM parent_auth_user WHERE parent_id = (SELECT id FROM parent WHERE email = ${ZELDA_EMAIL}))`;
}
