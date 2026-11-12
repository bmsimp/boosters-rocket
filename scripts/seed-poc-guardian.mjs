// Seeds one test guardian for the proof of concept: the person (made once per email) and their row in one family.
// Refuses anywhere but portaltest. It sends no email; the tester signs in at /sign-in with a code.
import postgres from "postgres";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";

const USAGE = "Usage: node scripts/seed-poc-guardian.mjs --name <name> --email <email> --family <family-id>";
const fail = (msg) => { console.error(msg); process.exit(1); };

const { DATABASE_URL, APP_URL } = process.env;
if (!DATABASE_URL) fail("DATABASE_URL is not set");
if (!APP_URL || !APP_URL.includes("portaltest")) fail("This script only runs against the portaltest proof of concept (APP_URL must contain 'portaltest').");

let values;
try {
  ({ values } = parseArgs({ options: { name: { type: "string" }, email: { type: "string" }, family: { type: "string" } } }));
} catch {
  fail(USAGE);
}
const name = values.name?.trim();
// Trimmed and lowercased, as the portal stores every parent email (normalizeEmail in src/lib/setup/state.ts, which a
// plain .mjs script can't import). Sign-in looks the address up in this form.
const email = values.email?.trim().toLowerCase();
const family = values.family?.trim();
if (!name || !email || !family) fail(USAGE);

class AlreadyThere extends Error {}
const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {}, connect_timeout: 10 });
const actor = "seed-poc-guardian";
try {
  const id = await sql.begin(async (tx) => {
    let [p] = await tx`select id from parent where email = ${email}`;
    if (!p) {
      [p] = await tx`insert into parent (name, email) values (${name}, ${email}) returning id`;
      await tx`insert into parent_auth_user (id, name, email, email_verified, parent_id) values (${randomUUID()}, ${name}, ${email}, true, ${p.id})`;
      await tx`insert into audit_log (door, actor_label, action, target_type, target_id, after)
               values ('system', ${actor}, 'parent.seed', 'parent', ${p.id}, ${sql.json({ name, email })})`;
    }
    const [g] = await tx`insert into guardian (family_qbo_id, parent_id, is_primary, status) values (${family}, ${p.id}, true, 'invited')
                         on conflict (family_qbo_id, parent_id) do nothing returning id`;
    if (!g) throw new AlreadyThere();
    await tx`insert into audit_log (door, actor_label, action, target_type, target_id, after)
             values ('system', ${actor}, 'guardian.seed', 'guardian', ${g.id}, ${sql.json({ parentId: p.id, familyQboId: family, status: "invited" })})`;
    return g.id;
  });
  console.log(`seeded guardian ${id}`);
} catch (e) {
  if (e instanceof AlreadyThere) console.error("That person is already a guardian in that family. Nothing was changed.");
  else console.error("Seeding failed:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
