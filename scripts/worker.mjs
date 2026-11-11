#!/usr/bin/env node
// Booster Rocket's worker. Ships in the image as tools/scripts/worker.mjs and runs as its own container.
// It has no job logic and no dependencies: every minute it asks the app to run whichever scheduled jobs are due
// (POST /api/internal/worker). The token is derived from BETTER_AUTH_SECRET, which the app derives the same way
// (src/lib/jobs/worker-token.ts).
//   node worker.mjs          loop until stopped
//   node worker.mjs --once   wake once; exit 0 if the app answered, 1 if not
import { createHmac } from "node:crypto";

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) { console.error("BETTER_AUTH_SECRET is required."); process.exit(2); }
const url = `${(process.env.WORKER_APP_URL ?? "http://app:3000").replace(/\/+$/, "")}/api/internal/worker`;
const token = createHmac("sha256", secret).update("booster-rocket-worker:v1").digest("hex");
const EVERY_MS = 60_000;
const stamp = () => new Date().toISOString();
let failing = false;

async function wake() {
  try {
    const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    for (const r of Array.isArray(body.ran) ? body.ran : []) console.log(`${stamp()} ran ${r.job}: ${r.ok ? "ok" : "failed"}`);
    if (failing) console.log(`${stamp()} the app is answering again`);
    failing = false;
    return true;
  } catch (e) {
    if (!failing) console.error(`${stamp()} couldn't reach the app: ${e instanceof Error ? e.message : "unknown error"}`); // once per outage, not once a minute
    failing = true;
    return false;
  }
}

if (process.argv[2] === "--once") process.exit((await wake()) ? 0 : 1);

let stopping = false;
let timer = null;
const stop = () => { stopping = true; if (timer) clearTimeout(timer); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
console.log(`${stamp()} worker started; waking every ${EVERY_MS / 1000} seconds`);
while (!stopping) {
  await wake();
  if (stopping) break;
  await new Promise((r) => { timer = setTimeout(r, EVERY_MS); });
}
console.log(`${stamp()} worker stopped`);
