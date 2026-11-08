// Fails if any secret env value appears in client-delivered files (spec §12.5).
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SECRET_KEYS = ["BETTER_AUTH_SECRET", "STAFF_ENTRA_CLIENT_SECRET", "STAFF_GOOGLE_CLIENT_SECRET", "PARENT_OIDC_CLIENT_SECRET", "DATABASE_URL"];
const secrets = SECRET_KEYS.map((k) => [k, process.env[k]]).filter(([, v]) => v && v.length >= 8);
if (secrets.length === 0) { console.error("No secrets set; run with fake secret values."); process.exit(2); }

const files = [];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p); else files.push(p);
  }
})(".next/static");

let bad = 0;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const [k, v] of secrets) if (text.includes(v)) { console.error(`${k} found in ${f}`); bad++; }
}
if (bad) process.exit(1);
console.log(`checked ${files.length} client files; no secrets found`);
