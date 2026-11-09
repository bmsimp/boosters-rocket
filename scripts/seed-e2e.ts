import postgres from "postgres";

async function main() {
  const sql = postgres(process.env.DATABASE_URL!);
  await sql`INSERT INTO guardian (family_qbo_id, name, email, identity_object_id, status)
          VALUES ('E2E-FAMILY', 'Zelda Quetzalcoatl', 'zelda@example.com', 'oid-e2e', 'active') ON CONFLICT DO NOTHING`;
  await sql`INSERT INTO setting (key, value) VALUES ('club', ${sql.json({ name: "E2E Boosters", shortName: "E2E", color: "#5b2a86", treasurerEmail: null })})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  await sql`INSERT INTO setting (key, value) VALUES ('setup.state', ${sql.json({ status: "finished", step: "admin", adminEmail: null, finishedAt: "2026-11-08T00:00:00Z" })})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
