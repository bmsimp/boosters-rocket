import postgres from "postgres";
import { createSecretBox } from "../src/lib/crypto/secret-box";
import { mailConfigHash } from "../src/lib/mail/config-hash";

async function main() {
  const sql = postgres(process.env.DATABASE_URL!);
  const [p] = await sql`INSERT INTO parent (name, email) VALUES ('Zelda Quetzalcoatl', 'zelda@example.com')
          ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
  await sql`INSERT INTO parent_auth_user (id, name, email, email_verified, parent_id)
          VALUES (${crypto.randomUUID()}, 'Zelda Quetzalcoatl', 'zelda@example.com', true, ${p!.id}) ON CONFLICT (parent_id) DO NOTHING`;
  await sql`INSERT INTO guardian (family_qbo_id, parent_id, is_primary, status) VALUES ('E2E-FAMILY', ${p!.id}, true, 'active')
          ON CONFLICT (family_qbo_id, parent_id) DO NOTHING`;
  await sql`INSERT INTO guardian (family_qbo_id, parent_id, is_primary, status) VALUES ('E2E-FAMILY-2', ${p!.id}, false, 'active')
          ON CONFLICT (family_qbo_id, parent_id) DO NOTHING`;
  // SMTP to the e2e mail sink (tests/e2e/parent-sign-in.spec.ts), counted as tested.
  const sealed = createSecretBox({ current: process.env.SETTINGS_ENCRYPTION_KEY! }).seal("sink-password", "mail:smtp-password");
  const mail = { method: "smtp", host: "127.0.0.1", port: 2465, security: "tls", username: "sender", from: "boosters@e2e.example.org",
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
          ('30', 'Lincoln High', true, null, '4', null, null, '0')`;
  await sql`INSERT INTO setting (key, value) VALUES ('membership.shape', ${sql.json({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" })})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  await sql`DELETE FROM job_run`;
  await sql`INSERT INTO job_run (job, started_at, finished_at, outcome, detail, started_by) VALUES ('roster.refresh', now(), now(), 'ok', '5 customers, 4 customer types', 'worker')`;
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
