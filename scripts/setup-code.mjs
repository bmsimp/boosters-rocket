#!/usr/bin/env node
// Issues the one-time code that unlocks Booster Rocket's setup page. Ships in the image as tools/scripts/setup-code.mjs.
//   node setup-code.mjs            issue a code while setup is open; refuse (exit 3) once it is finished
//   node setup-code.mjs --if-open  the same, but print nothing and exit 0 once setup is finished (deploy.sh uses this)
//   node setup-code.mjs --reopen   reopen setup (stored sign-in values are kept), then issue a code
// The code is printed here and nowhere else: never to the container log.
import { createHash, randomBytes, randomInt } from "node:crypto";
import postgres from "postgres";

// Must match src/lib/setup/code.ts; tests/integration/setup-code-script.test.ts proves the app accepts these codes.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 12;

const mode = process.argv[2] ?? "";
if (!["", "--if-open", "--reopen"].includes(mode)) {
  console.error(`Unknown option: ${mode}. Use --if-open or --reopen.`);
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(2);
}

const sql = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
let exitCode = 0;
try {
  const [row] = await sql`SELECT value FROM setting WHERE key = 'setup.state'`;
  const state = { status: "open", step: "staff", adminEmail: null, finishedAt: null, ...(row?.value ?? {}) };

  if (mode === "--reopen") {
    const next = { ...state, status: "open", step: "staff", finishedAt: null };
    await sql`INSERT INTO setting (key, value) VALUES ('setup.state', ${sql.json(next)})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    await sql`INSERT INTO audit_log (door, actor_label, action, target_type, target_id, before, after)
              VALUES ('system', 'server', 'setup.reopen', 'setting', 'setup.state', ${sql.json({ status: state.status })}, ${sql.json({ status: "open" })})`;
  } else if (state.status === "finished") {
    if (mode !== "--if-open") {
      console.error("Setup is already finished. To reopen it (for example, nobody can sign in), run this again with --reopen: docker compose run --rm migrate node tools/scripts/setup-code.mjs --reopen in the installation folder (scripts/poc/reopen-setup.sh on the proof of concept).");
      exitCode = 3;
    }
  }

  if (exitCode === 0 && (mode === "--reopen" || state.status !== "finished")) {
    let code = "";
    for (let i = 0; i < LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    const salt = randomBytes(16).toString("hex");
    const hash = createHash("sha256").update(`${salt}:${code}`).digest("hex");
    const value = { hash, salt, issuedAt: new Date().toISOString(), failedTotal: 0 };
    await sql`INSERT INTO setting (key, value) VALUES ('setup.code', ${sql.json(value)})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`;
    await sql`INSERT INTO audit_log (door, actor_label, action, target_type, target_id)
              VALUES ('system', 'server', 'setup.code.issue', 'setting', 'setup.code')`;
    const site = (process.env.APP_URL ?? "").replace(/\/+$/, "") || "the site";
    console.log(`Setup code: ${code.match(/.{4}/g).join("-")}`);
    console.log(`Open ${site}/setup and enter it. It works until setup is finished. Running this again replaces it.`);
  }
} catch (e) {
  console.error(`Couldn't issue a setup code: ${e.message}`);
  exitCode = 1;
} finally {
  await sql.end();
}
process.exit(exitCode);
