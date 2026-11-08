// Seeds one test guardian for the proof of concept. Refuses anywhere but portaltest.
import postgres from "postgres";
import { parseArgs } from "node:util";

const USAGE = "Usage: node scripts/seed-poc-guardian.mjs --name <name> --email <email> --object-id <external-id-object-id> --family <family-id>";
const fail = (msg) => { console.error(msg); process.exit(1); };

const { DATABASE_URL, APP_URL } = process.env;
if (!DATABASE_URL) fail("DATABASE_URL is not set");
if (!APP_URL || !APP_URL.includes("portaltest")) fail("This script only runs against the portaltest proof of concept (APP_URL must contain 'portaltest').");

let values;
try {
  ({ values } = parseArgs({ options: { name: { type: "string" }, email: { type: "string" }, "object-id": { type: "string" }, family: { type: "string" } } }));
} catch {
  fail(USAGE);
}
const name = values.name?.trim();
const email = values.email?.trim().toLowerCase();
const objectId = values["object-id"]?.trim();
const family = values.family?.trim();
if (!name || !email || !objectId || !family) fail(USAGE);

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {}, connect_timeout: 10 });
try {
  const id = await sql.begin(async (tx) => {
    const [g] = await tx`insert into guardian (family_qbo_id, name, email, is_primary, identity_object_id, status)
                         values (${family}, ${name}, ${email}, true, ${objectId}, 'invited') returning id`;
    await tx`insert into audit_log (door, actor_label, action, target_type, target_id, after)
             values ('system', 'seed-poc-guardian', 'guardian.seed', 'guardian', ${g.id},
                     ${sql.json({ name, email, familyQboId: family, identityObjectId: objectId, status: "invited" })})`;
    return g.id;
  });
  console.log(`seeded guardian ${id}`);
} catch (e) {
  if (e && e.code === "23505") {
    console.error("A guardian with that object id already exists. Nothing was changed.");
  } else {
    console.error("Seeding failed:", e instanceof Error ? e.message : String(e));
  }
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
