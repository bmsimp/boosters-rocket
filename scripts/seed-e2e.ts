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
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
