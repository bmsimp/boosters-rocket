import postgres from "postgres";
import { createSecretBox } from "../src/lib/crypto/secret-box";
import { mailConfigHash } from "../src/lib/mail/config-hash";
import { runMigrations } from "../src/lib/db/migrate";
import { assertE2eDatabase, e2eMailPort } from "../tests/e2e/run-config";

/**
 * This script empties the database and seeds it again: test databases only, and in a git worktree never the database
 * every tree shares (tests/e2e/run-config.ts).
 */
function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL ?? "";
  try { assertE2eDatabase(url); } catch (e) {
    console.error(`seed-e2e refuses to run: DATABASE_URL names a database this script must not touch. It deletes and overwrites data.
${(e as Error).message}`);
    process.exit(2);
  }
  return url;
}

async function main() {
  const url = testDatabaseUrl(), mailPort = e2eMailPort();
  // Migrated here, after the check, so a worktree's migrations only ever reach the database the check let through.
  await runMigrations(url);
  const sql = postgres(url);
  // Start from nothing, as vitest's resetDb() does: every table but the built-in roles the migrations make. A vitest
  // run on this database leaves its own people and settings behind, and the specs count what the pages list.
  const tables = (await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'role'`).map((r) => r.tablename as string);
  await sql.unsafe(`TRUNCATE ${tables.map((t) => `"${t.replaceAll('"', '""')}"`).join(", ")} RESTART IDENTITY CASCADE`);
  await sql`DELETE FROM role WHERE builtin = false`;
  const [p] = await sql`INSERT INTO parent (name, email) VALUES ('Zelda Quetzalcoatl', 'zelda@example.com')
          ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
  await sql`INSERT INTO parent_auth_user (id, name, email, email_verified, parent_id)
          VALUES (${crypto.randomUUID()}, 'Zelda Quetzalcoatl', 'zelda@example.com', true, ${p!.id}) ON CONFLICT (parent_id) DO NOTHING`;
  // Each link names the QuickBooks record it came from (E2E-P1, E2E-P2 below), as the reconcile leaves it once parent
  // sign-ins are switched on (tests/e2e/parents.spec.ts): "Your details" then offers "Update my details" in both passes
  // of the run. Those ids are not numbers on purpose. The edit page reads a parent's record from QuickBooks as it
  // opens, and an id that isn't digits is never sent: with the made-up tokens below, a number here would send this
  // run's requests to Intuit's real servers (tests/e2e/family-details.spec.ts checks the id before it opens the page).
  await sql`INSERT INTO guardian (family_qbo_id, parent_id, is_primary, status, source_qbo_id) VALUES ('E2E-FAMILY', ${p!.id}, true, 'active', 'E2E-P1')
          ON CONFLICT (family_qbo_id, parent_id) DO NOTHING`;
  await sql`INSERT INTO guardian (family_qbo_id, parent_id, is_primary, status, source_qbo_id) VALUES ('E2E-FAMILY-2', ${p!.id}, false, 'active', 'E2E-P2')
          ON CONFLICT (family_qbo_id, parent_id) DO NOTHING`;
  // A live session for Zelda with the first family chosen, so the e2e run can open parent pages without the emailed
  // code (tests/e2e/parent-session.ts makes the cookie). Every session she has is deleted first, as the staff one is.
  const [zelda] = await sql`SELECT id FROM parent_auth_user WHERE parent_id = ${p!.id}`;
  await sql`DELETE FROM parent_auth_session WHERE user_id = ${zelda!.id}`;
  await sql`INSERT INTO parent_auth_session (id, token, user_id, family_qbo_id, expires_at)
          VALUES ('e2e-parent-session', 'e2e-parent-session-token', ${zelda!.id}, 'E2E-FAMILY', now() + interval '7 days')`;
  // SMTP to the e2e mail sink (tests/e2e/parent-sign-in.spec.ts), counted as tested.
  const sealed = createSecretBox({ current: process.env.SETTINGS_ENCRYPTION_KEY! }).seal("sink-password", "mail:smtp-password");
  const mail = { method: "smtp", host: "127.0.0.1", port: mailPort, security: "tls", username: "sender", from: "boosters@e2e.example.org",
    passwordCiphertext: sealed.ciphertext, passwordKeyId: sealed.keyId } as const;
  const status = { verifiedHash: mailConfigHash(mail), verifiedAt: new Date().toISOString(), lastSuccessAt: null, lastFailureAt: null, lastError: null };
  await sql`INSERT INTO setting (key, value) VALUES ('mail', ${sql.json(mail)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  await sql`INSERT INTO setting (key, value) VALUES ('mail.status', ${sql.json(status)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  await sql`DELETE FROM signin_code`;
  await sql`DELETE FROM rate_limit_event`;
  await sql`INSERT INTO setting (key, value) VALUES ('club', ${sql.json({ name: "E2E Boosters", shortName: "E2E", color: "#5b2a86", treasurerEmail: null })})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  await sql`INSERT INTO setting (key, value) VALUES ('setup.state', ${sql.json({ status: "finished", step: "admin", adminEmail: null, finishedAt: "2026-11-08T00:00:00Z" })})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;

  // An Admin with a live staff session, so the e2e run can open staff pages (tests/e2e/staff-session.ts makes the cookie).
  // resolveStaff finds the staff_user by auth_user_id and needs it active; the Admin role gives every permission.
  const [staff] = await sql`INSERT INTO staff_user (email, name, status) VALUES ('e2e-admin@example.org', 'E2E Admin', 'active')
          ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, status = 'active' RETURNING id`;
  const authUserId = "e2e-staff-auth-user";
  await sql`INSERT INTO staff_auth_user (id, name, email, email_verified) VALUES (${authUserId}, 'E2E Admin', 'e2e-admin@example.org', true) ON CONFLICT (id) DO NOTHING`;
  await sql`UPDATE staff_user SET auth_user_id = ${authUserId} WHERE id = ${staff!.id}`;
  await sql`INSERT INTO role_assignment (role_id, staff_user_id) SELECT id, ${staff!.id} FROM role WHERE key = 'admin' ON CONFLICT DO NOTHING`;
  await sql`DELETE FROM staff_auth_session WHERE user_id = ${authUserId}`;
  await sql`INSERT INTO staff_auth_session (id, token, user_id, expires_at) VALUES ('e2e-staff-session', 'e2e-staff-session-token', ${authUserId}, now() + interval '7 days')`;

  // QuickBooks as if an Admin had connected a sandbox company. The tokens are made up and never used: nothing in the e2e run reaches Intuit.
  const box = createSecretBox({ current: process.env.SETTINGS_ENCRYPTION_KEY! });
  const secret = box.seal("e2e-client-secret", "qbo:client-secret"), access = box.seal("e2e-access", "qbo:access-token"), refresh = box.seal("e2e-refresh", "qbo:refresh-token");
  await sql`DELETE FROM qbo_connection`;
  await sql`INSERT INTO qbo_connection (environment, client_id, client_secret_ciphertext, client_secret_key_id, realm_id, company_name,
            access_token_ciphertext, access_token_key_id, access_expires_at, refresh_token_ciphertext, refresh_token_key_id, refresh_expires_at, connected_at, last_token_refresh_at)
          VALUES ('sandbox', 'e2e-client-id-1234567890', ${secret.ciphertext}, ${secret.keyId}, '9130000000000001', 'E2E Sandbox Company',
            ${access.ciphertext}, ${access.keyId}, now() + interval '5 years', ${refresh.ciphertext}, ${refresh.keyId}, now() + interval '5 years', now(), now())`;
  await sql`DELETE FROM qbo_customer_type`;
  await sql`DELETE FROM qbo_customer`;
  await sql`INSERT INTO qbo_customer_type (qbo_id, name, active) VALUES ('1','Family',true), ('2','Parent',true), ('3','Student',true), ('4','School',true)`;
  await sql`INSERT INTO qbo_customer (qbo_id, display_name, active, parent_qbo_id, type_qbo_id, email, phone, sync_token) VALUES
          ('10', 'Rivera Family', true, null, '1', null, null, '0'),
          ('11', 'Ana Rivera', true, '10', '2', 'ana@example.com', '555-0101', '0'),
          ('12', 'Leo Rivera', true, '10', '3', null, null, '0'),
          ('20', '<img src=x onerror=alert(1)> Family', true, null, '1', null, null, '0'),
          ('30', 'Lincoln High', true, null, '4', null, null, '0'),
          ('E2E-FAMILY', 'Quetzalcoatl Family', true, null, '1', null, null, '0'),
          ('E2E-P1', 'Zelda Quetzalcoatl', true, 'E2E-FAMILY', '2', 'zelda@example.com', null, '0'),
          ('E2E-S1', 'Xochitl Quetzalcoatl', true, 'E2E-FAMILY', '3', null, null, '0'),
          ('E2E-S2', 'Yaretzi Quetzalcoatl', true, 'E2E-FAMILY', '3', null, null, '0'),
          ('E2E-FAMILY-2', 'Second Family', true, null, '1', null, null, '0'),
          ('E2E-P2', 'Zelda Quetzalcoatl', true, 'E2E-FAMILY-2', '2', 'zelda@example.com', null, '0'),
          ('E2E-S3', 'Wolfgang Secondborn', true, 'E2E-FAMILY-2', '3', null, null, '0'),
          ('40', 'Okafor Family', true, null, '1', null, null, '0'),
          ('41', 'Sam Okafor', true, '40', '2', 'sam@example.com', null, '0'),
          ('50', 'Lee Family', true, null, '1', null, null, '0'),
          ('51', 'Sam Okafor', true, '50', '2', 'sam@example.com', null, '0')`;
  // Zelda is in two families on purpose (the family chooser test), so staff have already said she is one person.
  // Sam's address is under two families and waits for a decision (tests/e2e/parents.spec.ts decides and reverses it).
  // The parents setting is cleared here and nowhere else: tests/e2e/parents.spec.ts switches sign-ins on, and that
  // state must survive the second (desktop) pass of the run.
  await sql`INSERT INTO held_address (email, approved_family_qbo_ids) VALUES ('zelda@example.com', ${sql.json(["E2E-FAMILY", "E2E-FAMILY-2"])})
          ON CONFLICT (email) DO UPDATE SET approved_family_qbo_ids = EXCLUDED.approved_family_qbo_ids`;
  await sql`DELETE FROM held_address WHERE email = 'sam@example.com'`;
  await sql`DELETE FROM setting WHERE key IN ('parents.settings', 'parents.review_notice', 'parents.previous_company')`;
  await sql`INSERT INTO setting (key, value) VALUES ('membership.shape', ${sql.json({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" })})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  // The cache says which company it came from, as a real refresh records it; without this the pages treat it as unread.
  await sql`INSERT INTO setting (key, value) VALUES ('roster.source', ${sql.json({ realmId: "9130000000000001" })})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  // What each of Zelda's two families owes, as figures QuickBooks has just given: an invoice with a pay link, one
  // without, and one paid. The freshness window is set to a week so the rows stay fresh for the whole run: a page load
  // that found them stale would ask Intuit's real servers, with the made-up tokens above. Dates are counted from today
  // so the due words ("in 8 days", "Was due") come out the same whenever the run is.
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  // Each invoice names the customer it was raised on (the family itself, or a student under it in the cache above): a
  // stored invoice of a customer who is not the family's is not shown.
  const invoice = (qboId: string, number: string, customerQboId: string, forName: string | null, cents: number, o: { due?: number; paid?: boolean; payLink?: string } = {}) => ({
    qboId, number, customerQboId, forName, date: day(-30), dueDate: o.due === undefined ? null : day(o.due), totalCents: cents, balanceCents: o.paid ? 0 : cents, currency: "USD", payLink: o.payLink ?? null });
  const families = [
    { id: "E2E-FAMILY", total: 18500, invoices: [
      invoice("902", "QZ-1042", "E2E-FAMILY", null, 10000, { due: -20 }), // soonest due first, as a read from QuickBooks stores them
      invoice("901", "QZ-1041", "E2E-S1", "Xochitl Quetzalcoatl", 8500, { due: 8, payLink: "https://connect.intuit.com/t/scs-v1-e2e-quetzalcoatl-1041" }),
      invoice("903", "QZ-1017", "E2E-FAMILY", null, 15000, { paid: true }) ] },
    { id: "E2E-FAMILY-2", total: 37666, invoices: [
      invoice("911", "SF-2051", "E2E-S3", "Wolfgang Secondborn", 31247, { due: 8, payLink: "https://connect.intuit.com/t/scs-v1-e2e-second-2051" }),
      invoice("912", "SF-2052", "E2E-FAMILY-2", null, 6419, { due: 40 }),
      invoice("913", "SF-2009", "E2E-FAMILY-2", null, 27358, { paid: true }) ] },
  ];
  await sql`INSERT INTO setting (key, value) VALUES ('money.settings', ${sql.json({ freshSeconds: 7 * 86_400 })})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  await sql`DELETE FROM family_money`;
  for (const f of families) {
    await sql`INSERT INTO family_money (family_qbo_id, realm_id, read_at, invoices, total_cents, balance_with_jobs_cents, currency)
            VALUES (${f.id}, '9130000000000001', now(), ${sql.json(f.invoices)}, ${f.total}, ${f.total}, 'USD')`;
  }
  await sql`DELETE FROM job_run`;
  await sql`INSERT INTO job_run (job, started_at, finished_at, outcome, detail, started_by) VALUES ('roster.refresh', now(), now(), 'ok', '16 customers, 4 customer types', 'worker')`;
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
