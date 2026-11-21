import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { hashPassword } from "better-auth/crypto";

/**
 * Strict's enrolment in the browser run (the sign-in release, slice SI-10a). scripts/seed-e2e.ts stores Standard and
 * stays so: a spec that needs Strict stores it at its start and puts Standard back after (storeLevel()), and never uses
 * Zelda, whose seeded session the gate would sign out at Strict (she has neither a passkey nor an app). It uses a guardian
 * of its own instead, made here with a password and no second factor, in the seeded family E2E-FAMILY (so no other
 * family's strings appear: tests/e2e/parent-session.spec.ts), and removed after with everything she signed in with
 * (removeStrictParent(): her sessions, passkeys, app and backup codes go with her row). Playwright runs one worker
 * (playwright.config.ts), so nothing else runs while Strict is stored.
 */
export const STRICT_PARENT = { name: "Wren Strictland", first: "Wren", email: "wren.strictland@example.com", password: "wren's long enrolment password, kettle orchard 8821" } as const;

/** Stores the club's sign-in level, keeping every other setting as the seed left it. */
export async function storeLevel(sql: postgres.Sql, level: "standard" | "strict"): Promise<void> {
  await sql`UPDATE setting SET value = jsonb_set(value, '{level}', to_jsonb(${level}::text)) WHERE key = 'parents.settings'`;
}

/** Removes the guardian and everything of hers: her row in E2E-FAMILY, her counts, then her person (the rest goes with it). */
export async function removeStrictParent(sql: postgres.Sql): Promise<void> {
  await sql`DELETE FROM guardian WHERE parent_id IN (SELECT id FROM parent WHERE email = ${STRICT_PARENT.email})`;
  await sql`DELETE FROM rate_limit_event WHERE subject IN (SELECT id::text FROM parent WHERE email = ${STRICT_PARENT.email})`;
  await sql`DELETE FROM parent WHERE email = ${STRICT_PARENT.email}`;
}

/** Makes the guardian afresh: a person, a sign-in account, a password, and an active row in E2E-FAMILY's own record. */
export async function makeStrictParent(sql: postgres.Sql): Promise<{ parentId: string; authUserId: string }> {
  await removeStrictParent(sql);
  const [p] = await sql`INSERT INTO parent (name, email, welcomed_at) VALUES (${STRICT_PARENT.name}, ${STRICT_PARENT.email}, now()) RETURNING id`;
  const parentId = p!.id as string;
  const authUserId = randomUUID();
  await sql`INSERT INTO parent_auth_user (id, name, email, email_verified, parent_id) VALUES (${authUserId}, ${STRICT_PARENT.name}, ${STRICT_PARENT.email}, true, ${parentId})`;
  await sql`INSERT INTO parent_auth_account (id, account_id, provider_id, user_id, password)
            VALUES (${randomUUID()}, ${authUserId}, 'credential', ${authUserId}, ${await hashPassword(STRICT_PARENT.password)})`;
  await sql`INSERT INTO guardian (family_qbo_id, family_id, parent_id, is_primary, status)
            SELECT 'E2E-FAMILY', family_id, ${parentId}, false, 'active' FROM guardian WHERE family_qbo_id = 'E2E-FAMILY' AND family_id IS NOT NULL LIMIT 1`;
  return { parentId, authUserId };
}

/**
 * An enrolling session for the guardian, as the door's finish makes one (enrol_until half an hour on, no proof, no
 * device, and her one family entered, as completeParentSignin() enters it), with the token given: for a page opened
 * without signing in through the form (tests/e2e/parent-a11y.spec.ts). With no family, the page she goes on to once
 * enrolled would be the chooser, not Home.
 */
export async function enrollingSession(sql: postgres.Sql, authUserId: string, token: string): Promise<void> {
  await sql`INSERT INTO parent_auth_session (id, token, user_id, expires_at, enrol_until, family_id)
            SELECT ${`e2e-enrolling-${randomUUID()}`}, ${token}, ${authUserId}, now() + interval '1 day', now() + interval '30 minutes', g.family_id
            FROM guardian g JOIN parent_auth_user u ON u.parent_id = g.parent_id
            WHERE u.id = ${authUserId} AND g.family_qbo_id = 'E2E-FAMILY' AND g.family_id IS NOT NULL`;
}
