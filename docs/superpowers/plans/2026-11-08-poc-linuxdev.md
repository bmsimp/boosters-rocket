# Proof of Concept on linuxdev — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Boosters Rocket in Docker on `linuxdev` at `https://portaltest.rhinoautomator.com` behind the existing Cloudflare tunnel and Cloudflare Access, with repeatable deploy and rollback, and prove staff and parent sign-in for real.

**Architecture:** A multi-stage `Dockerfile` builds a Next.js standalone server on `node:26-slim`, plus a small `tools/` folder (plain-JS migration and seed scripts with only `drizzle-orm` and `postgres`). `docker-compose.poc.yml` runs `db` on a private network and `app` on that network plus `booster-rocket-edge`, which `cloudflared` also joins. Shell scripts on `linuxdev` do first-time setup, deploy (pull → build → migrate → recreate → wait healthy) and rollback.

**Tech Stack:** Docker 29 / Compose v5, `node:26-slim`, Next.js 16.4.5 standalone output, Drizzle migrator, postgres.js, Bash, shellcheck, Vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-08-poc-linuxdev-design.md` (and v1 spec `docs/superpowers/specs/2026-11-06-booster-rocket-v1-design.md`).

## Global Constraints

- Public address `https://portaltest.rhinoautomator.com`; `APP_URL` is exactly that.
- No published ports on any service; the only way in is the tunnel.
- `app` reaches `db` only over the project's private network; `app` and `cloudflared` share only `booster-rocket-edge`.
- No real secret is ever present at image build time; secrets live in `~/booster-rocket/.env.poc` (mode 600, never committed).
- Runtime is Node 26 (`node:26-slim`); the container runs as a non-root user.
- `TZ=America/Chicago` on `app` and `db`.
- `/api/health` returns exactly `{"ok":true}` (200) or `{"ok":false}` (503), nothing else, and writes no audit entry.
- Every create/update/delete and sign-in/sign-out is audited (v1 spec §13); the seed script writes `guardian.seed`.
- US English in code, copy and docs.
- Shell scripts pass `shellcheck` and use `set -euo pipefail`.

## Review Focus

1. **The standalone server binding to the container's hostname.** Next's standalone server listens on `$HOSTNAME`, which Docker sets to the container ID, so `127.0.0.1` health checks fail. The image must set `HOSTNAME=0.0.0.0`. Tested in Task 3's container smoke test.
2. **A missing or world-readable `.env.poc`.** `deploy.sh` must refuse with a plain message, not start containers with empty secrets. Test in Task 4.
3. **Rollback with no previous image** (first deploy, or a pruned image). It must say so plainly and change nothing. Test in Task 4.
4. **Seeding the same External ID object ID twice.** It must refuse with a plain message (the unique index), not a stack trace, and write no audit row. Test in Task 2.
5. **Env files in the build context.** A local `.env.poc` must never be copied into the image. Pinned by `.dockerignore` and the canary check in Task 3.

---

## File structure

```
Dockerfile                         multi-stage image: deps → build → tools → run
.dockerignore                      keeps env files, .git, node_modules, .next, tests, docs out of the context
docker-compose.poc.yml             db, app, migrate (profile tools); networks internal + booster-rocket-edge
.env.poc.example                   every POC variable, documented
next.config.ts                     output: "standalone" when NEXT_OUTPUT=standalone
src/app/api/health/route.ts        GET → {"ok":true} | 503 {"ok":false}
scripts/migrate.mjs                plain-JS migrations (drizzle-orm migrator + postgres)
scripts/seed-poc-guardian.mjs      inserts one invited guardian + guardian.seed audit row
scripts/check-image-secrets.sh     builds the image with a canary .env.poc in context; fails if the canary is inside
scripts/smoke-image.sh             runs the image against throwaway Postgres: non-root, migrates, healthy, reachable by name
scripts/poc/setup.sh               one-time setup on linuxdev
scripts/poc/deploy.sh              deploy and --rollback
docs/runbooks/poc-linuxdev.md      the runbook and test checklist
tests/integration/health.test.ts
tests/integration/migrate-script.test.ts
tests/integration/seed-poc-guardian.test.ts
tests/unit/deploy-script.test.ts   deploy.sh control flow with stub docker/git
.github/workflows/ci.yml           + shellcheck, docker build, image secret check
```

---

### Task 1: Health route and standalone build output

**Files:**
- Create: `src/app/api/health/route.ts`, `tests/integration/health.test.ts`
- Modify: `next.config.ts`

**Interfaces:**
- Consumes: `db` from `@/lib/db/client`.
- Produces: `GET /api/health` → 200 `{"ok":true}` or 503 `{"ok":false}`; `next.config.ts` emits `.next/standalone` only when `NEXT_OUTPUT=standalone` (so `pnpm start` keeps working for e2e).

- [ ] **Step 1: Write the failing test**

`tests/integration/health.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => { vi.resetModules(); vi.doUnmock("@/lib/db/client"); });

describe("GET /api/health", () => {
  it("answers ok when the database responds", async () => {
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe('{"ok":true}');
  });

  it("answers 503 with nothing else when the database is unreachable", async () => {
    vi.doMock("@/lib/db/client", () => ({ db: { execute: async () => { throw new Error("connect ECONNREFUSED secret-host:5432"); } } }));
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toBe('{"ok":false}');
    expect(body).not.toContain("secret-host");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm test tests/integration/health.test.ts`
Expected: FAIL — cannot resolve `@/app/api/health/route`.

- [ ] **Step 3: Implement the route**

`src/app/api/health/route.ts`:

```ts
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

export const dynamic = "force-dynamic";

const headers = { "content-type": "application/json", "cache-control": "no-store" };

/** Liveness for Docker and the deploy script. Reveals nothing beyond up/down. Not audited. */
export async function GET(): Promise<Response> {
  try {
    await db.execute(sql`select 1`);
    return new Response('{"ok":true}', { status: 200, headers });
  } catch {
    return new Response('{"ok":false}', { status: 503, headers });
  }
}
```

- [ ] **Step 4: Standalone output, opt-in**

`next.config.ts`:

```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Docker image sets NEXT_OUTPUT=standalone; local `pnpm start` and CI e2e keep the default output.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
};

export default nextConfig;
```

- [ ] **Step 5: Run tests and build**

Run: `pnpm test tests/integration/health.test.ts` — Expected: PASS (2 tests).
Run: `pnpm lint && pnpm typecheck && pnpm test` — Expected: all pass, pristine.
Run (with the env from `.github/workflows/ci.yml`'s build step): `NEXT_OUTPUT=standalone pnpm build` — Expected: success and `.next/standalone/server.js` exists. Then `pnpm build` without it — Expected: success, no `.next/standalone`.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/health/route.ts tests/integration/health.test.ts next.config.ts
git commit -m "feat(ops): health route and opt-in standalone build output"
```

---

### Task 2: Plain-JS migration and seed scripts

**Files:**
- Create: `scripts/migrate.mjs`, `scripts/seed-poc-guardian.mjs`, `tests/integration/migrate-script.test.ts`, `tests/integration/seed-poc-guardian.test.ts`

**Interfaces:**
- Consumes: the committed `drizzle/` folder; tables `guardian` and `audit_log` (columns: `family_qbo_id`, `name`, `email`, `identity_object_id`, `status`; `door`, `actor_label`, `action`, `target_type`, `target_id`, `after`).
- Produces:
  - `node scripts/migrate.mjs` — uses `DATABASE_URL`, migrations from `MIGRATIONS_DIR` or `<script dir>/../drizzle`; prints `migrated`; exits 1 on failure.
  - `node scripts/seed-poc-guardian.mjs --name <n> --email <e> --object-id <oid> --family <id>` — needs `DATABASE_URL` and `APP_URL` containing `portaltest`; prints `seeded guardian <id>`; exits 1 with a plain message otherwise.

- [ ] **Step 1: Failing test for the migration script**

`tests/integration/migrate-script.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import postgres from "postgres";

const ADMIN_URL = "postgres://booster:booster@localhost:5433/booster";
const FRESH = "booster_migrate_script_test";
const FRESH_URL = `postgres://booster:booster@localhost:5433/${FRESH}`;

describe("scripts/migrate.mjs", () => {
  beforeAll(async () => {
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${FRESH}`);
    await admin.unsafe(`CREATE DATABASE ${FRESH}`);
    await admin.end();
  });
  afterAll(async () => {
    const admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${FRESH} WITH (FORCE)`);
    await admin.end();
  });

  it("migrates an empty database, including the built-in Admin role", async () => {
    const out = execFileSync("node", ["scripts/migrate.mjs"], { env: { ...process.env, DATABASE_URL: FRESH_URL }, encoding: "utf8" });
    expect(out).toContain("migrated");
    const pg = postgres(FRESH_URL, { max: 1, onnotice: () => {} });
    const [r] = await pg`select key, builtin from role where key = 'admin'`;
    await pg.end();
    expect(r).toEqual({ key: "admin", builtin: true });
  });

  it("is safe to run again", () => {
    const out = execFileSync("node", ["scripts/migrate.mjs"], { env: { ...process.env, DATABASE_URL: FRESH_URL }, encoding: "utf8" });
    expect(out).toContain("migrated");
  });

  it("exits non-zero when the database can't be reached", () => {
    const r = spawnSync("node", ["scripts/migrate.mjs"], { env: { ...process.env, DATABASE_URL: "postgres://nobody:nope@localhost:1/none" }, encoding: "utf8" });
    expect(r.status).toBe(1);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm test tests/integration/migrate-script.test.ts`
Expected: FAIL — `Cannot find module …scripts/migrate.mjs`.

- [ ] **Step 3: Implement `scripts/migrate.mjs`**

```js
// Plain-JS migrations for the production image (no tsx). Same migrator and folder as src/lib/db/migrate.ts.
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import path from "node:path";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const folder = process.env.MIGRATIONS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

const pg = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 10 });
try {
  await migrate(drizzle(pg), { migrationsFolder: folder });
  console.log("migrated");
} catch (e) {
  console.error("migration failed:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await pg.end({ timeout: 5 });
}
```

- [ ] **Step 4: Run** — `pnpm test tests/integration/migrate-script.test.ts` — Expected: PASS (3).

- [ ] **Step 5: Failing test for the seed script**

`tests/integration/seed-poc-guardian.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { db } from "@/lib/db/client";
import { guardian, auditLog } from "@/lib/db/schema";
import { resetDb } from "../helpers/db";

const TEST_URL = "postgres://booster:booster@localhost:5433/booster_test";
const run = (appUrl: string, args: string[]) => spawnSync("node", ["scripts/seed-poc-guardian.mjs", ...args],
  { env: { ...process.env, DATABASE_URL: TEST_URL, APP_URL: appUrl }, encoding: "utf8" });
const ARGS = ["--name", "Test Parent", "--email", "Test.Parent@Example.com", "--object-id", "11111111-2222-3333-4444-555555555555", "--family", "POC-FAMILY-1"];

describe("scripts/seed-poc-guardian.mjs", () => {
  beforeEach(resetDb);

  it("inserts one invited guardian and a guardian.seed audit row", async () => {
    const r = run("https://portaltest.rhinoautomator.com", ARGS);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/seeded guardian [0-9a-f-]{36}/);
    const rows = await db.select().from(guardian);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Test Parent", email: "test.parent@example.com", familyQboId: "POC-FAMILY-1",
      identityObjectId: "11111111-2222-3333-4444-555555555555", status: "invited", isPrimary: true });
    const audits = await db.select().from(auditLog);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ door: "system", action: "guardian.seed", targetType: "guardian", targetId: rows[0]!.id });
  });

  it("refuses outside the POC address and changes nothing", async () => {
    const r = run("https://portal.fznband.org", ARGS);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("only runs against the portaltest proof of concept");
    expect(await db.select().from(guardian)).toHaveLength(0);
  });

  it("refuses a second guardian with the same object id, plainly, and writes no audit row", async () => {
    expect(run("https://portaltest.rhinoautomator.com", ARGS).status).toBe(0);
    const again = run("https://portaltest.rhinoautomator.com", ARGS);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("A guardian with that object id already exists");
    expect(again.stderr).not.toMatch(/\bat \S+\.(m?js|ts):\d+/); // no stack trace
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });

  it("refuses missing arguments", () => {
    const r = run("https://portaltest.rhinoautomator.com", ["--name", "X"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Usage:");
  });
});
```

- [ ] **Step 6: Run to see it fail** — Expected: FAIL (module not found).

- [ ] **Step 7: Implement `scripts/seed-poc-guardian.mjs`**

```js
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
```

- [ ] **Step 8: Run** — `pnpm test tests/integration/seed-poc-guardian.test.ts` — Expected: PASS (4). Then `pnpm lint && pnpm typecheck && pnpm test` — pristine.

If ESLint flags the `.mjs` scripts (e.g. Node globals), add `scripts/**/*.mjs` to the Node-globals override that already covers `scripts/check-client-bundle.mjs` rather than disabling rules.

- [ ] **Step 9: Commit**

```bash
git add scripts/migrate.mjs scripts/seed-poc-guardian.mjs tests/integration/migrate-script.test.ts tests/integration/seed-poc-guardian.test.ts
git commit -m "feat(ops): plain-JS migration and POC guardian seed scripts"
```

---

### Task 3: Dockerfile, .dockerignore and image checks

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `scripts/check-image-secrets.sh`, `scripts/smoke-image.sh`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `NEXT_OUTPUT=standalone` (Task 1); `scripts/migrate.mjs`, `scripts/seed-poc-guardian.mjs` (Task 2).
- Produces: image layout `/app/server.js` (standalone), `/app/.next/static`, `/app/public`, `/app/tools/scripts/{migrate,seed-poc-guardian}.mjs`, `/app/tools/drizzle/`, `/app/tools/node_modules/{drizzle-orm,postgres}`; user `node`; `ENV HOSTNAME=0.0.0.0 PORT=3000 NODE_ENV=production`; `HEALTHCHECK` on `/api/health`. Commands used later: migrate = `node tools/scripts/migrate.mjs`; seed = `node tools/scripts/seed-poc-guardian.mjs …`.

- [ ] **Step 1: `.dockerignore`**

```
.git
.github
.next
node_modules
.env
.env.*
!.env.example
.superpowers
.impeccable
docs
design
tests
test-results
playwright-report
coverage
*.log
```

- [ ] **Step 2: `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1
FROM node:26-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@12 && pnpm --version
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# Placeholders only so the env schema parses during `next build`. No real secret is ever present here.
ENV NEXT_OUTPUT=standalone \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=postgres://build:build@localhost:5432/build \
    APP_URL=https://build.invalid \
    BETTER_AUTH_SECRET=build-placeholder-not-a-secret-0000000000
RUN pnpm build

FROM base AS tools
# Exactly the drizzle-orm and postgres versions the app resolved, nothing else.
COPY --from=deps /app/node_modules/drizzle-orm/package.json /tmp/drizzle-orm.json
COPY --from=deps /app/node_modules/postgres/package.json /tmp/postgres.json
WORKDIR /tools
RUN printf '{"name":"booster-rocket-tools","private":true,"type":"module"}' > package.json \
 && npm install --omit=dev --no-audit --no-fund \
      "drizzle-orm@$(node -p "require('/tmp/drizzle-orm.json').version")" \
      "postgres@$(node -p "require('/tmp/postgres.json').version")"
COPY drizzle ./drizzle
COPY scripts/migrate.mjs scripts/seed-poc-guardian.mjs ./scripts/

FROM node:26-slim AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 TZ=America/Chicago
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --from=tools --chown=node:node /tools ./tools
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
```

If `public/` doesn't exist in the repo, create `public/.gitkeep` so the `COPY` succeeds.

- [ ] **Step 3: Smoke-test script (used locally and in CI)**

`scripts/smoke-image.sh`:

```bash
#!/usr/bin/env bash
# Runs the built image against a throwaway Postgres and checks what cloudflared and Docker will rely on.
#   scripts/smoke-image.sh <image>
set -euo pipefail

IMAGE="${1:?usage: scripts/smoke-image.sh <image>}"
NET="br-smoke-$$"
cleanup() { docker rm -f "$NET-app" "$NET-db" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

uid="$(docker run --rm "$IMAGE" node -e "process.stdout.write(String(process.getuid()))")"
[ "$uid" != "0" ] || fail "the image runs as root"
docker run --rm "$IMAGE" sh -c "test -f /app/server.js && test -f /app/tools/scripts/migrate.mjs && test -f /app/tools/drizzle/meta/_journal.json" \
  || fail "expected files missing from the image"

docker network create "$NET" >/dev/null
docker run -d --name "$NET-db" --network "$NET" -e POSTGRES_USER=b -e POSTGRES_PASSWORD=b -e POSTGRES_DB=b postgres:16 >/dev/null
for _ in $(seq 1 30); do docker exec "$NET-db" pg_isready -U b -d b >/dev/null 2>&1 && break; sleep 1; done

DB="postgres://b:b@$NET-db:5432/b"
docker run --rm --network "$NET" -e DATABASE_URL="$DB" "$IMAGE" node tools/scripts/migrate.mjs | grep -q migrated || fail "migrations didn't run"

docker run -d --name "$NET-app" --network "$NET" -e DATABASE_URL="$DB" \
  -e APP_URL=https://portaltest.rhinoautomator.com -e BETTER_AUTH_SECRET=smoke-secret-smoke-secret-smoke-secret-1 "$IMAGE" >/dev/null

status=starting
for _ in $(seq 1 45); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$NET-app")"
  [ "$status" = "healthy" ] && break
  sleep 2
done
[ "$status" = "healthy" ] || { docker logs "$NET-app" >&2; fail "container health is $status (the server must listen on 0.0.0.0)"; }

local_body="$(docker exec "$NET-app" node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(t=>process.stdout.write(t))")"
[ "$local_body" = '{"ok":true}' ] || fail "health on 127.0.0.1 returned: $local_body"

by_name="$(docker run --rm --network "$NET" "$IMAGE" node -e "fetch('http://$NET-app:3000/api/health').then(r=>r.text()).then(t=>process.stdout.write(t))")"
[ "$by_name" = '{"ok":true}' ] || fail "health by container name (what cloudflared does) returned: $by_name"

echo "ok: image runs as non-root, migrates, is healthy, and answers on 127.0.0.1 and by name"
```

Run locally (Docker Desktop is running on this PC):

```bash
docker build -t booster-rocket-app:local .
bash scripts/smoke-image.sh booster-rocket-app:local
```

Expected: the final `ok:` line. Record the output in the report. This is Review Focus #1: prove it bites by temporarily removing `HOSTNAME=0.0.0.0` from the Dockerfile, rebuilding, and confirming the script fails; then restore it.

- [ ] **Step 4: The canary secret check**

`scripts/check-image-secrets.sh`:

```bash
#!/usr/bin/env bash
# Builds the image with a canary .env.poc in the build context and fails if the canary ends up inside.
set -euo pipefail

CANARY="CANARY-$(date +%s)-do-not-ship"
IMAGE="booster-rocket-app:secret-check"
cleanup() { rm -f .env.poc.canary-test .env.poc; docker image rm -f "$IMAGE" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [ -e .env.poc ]; then
  echo "Refusing: a real .env.poc exists in this directory. Run this in a clean checkout." >&2
  exit 2
fi
printf 'BETTER_AUTH_SECRET=%s\nDATABASE_URL=postgres://x:%s@db/x\n' "$CANARY" "$CANARY" > .env.poc

docker build -q -t "$IMAGE" . >/dev/null
if docker run --rm --entrypoint sh "$IMAGE" -c "grep -rIl --exclude-dir=proc --exclude-dir=sys -- '$CANARY' / 2>/dev/null" | grep -q .; then
  echo "FAIL: the canary secret was found inside the image." >&2
  exit 1
fi
echo "ok: no env-file secrets inside the image"
```

Run it: `bash scripts/check-image-secrets.sh` — Expected: `ok: no env-file secrets inside the image`. Then prove it bites: temporarily remove `.env.*` from `.dockerignore`, run again — Expected: `FAIL: the canary secret was found inside the image.` — restore `.dockerignore`.

- [ ] **Step 5: CI**

Add to `.github/workflows/ci.yml`, a second job so it runs in parallel with `test`:

```yaml
  image:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: Build the production image
        run: docker build -t booster-rocket-app:ci .
      - name: Smoke-test the image
        run: bash scripts/smoke-image.sh booster-rocket-app:ci
      - name: No env-file secrets in the image
        run: bash scripts/check-image-secrets.sh
```

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore scripts/check-image-secrets.sh scripts/smoke-image.sh .github/workflows/ci.yml
git add public/.gitkeep   # only if Step 2 created it
git commit -m "feat(ops): production Docker image with secret-free builds"
```

---

### Task 4: POC compose file, setup and deploy scripts

**Files:**
- Create: `docker-compose.poc.yml`, `.env.poc.example`, `scripts/poc/setup.sh`, `scripts/poc/deploy.sh`, `tests/unit/deploy-script.test.ts`
- Modify: `.github/workflows/ci.yml` (shellcheck step), `vitest.config.mts` only if needed to include the new test (it already globs `tests/unit/**`)

**Interfaces:**
- Consumes: the image from Task 3 (`node tools/scripts/migrate.mjs`, healthcheck).
- Produces:
  - Compose project `booster-rocket`; container `booster-rocket-app`; image tags `booster-rocket-app:current` and `booster-rocket-app:previous`; volume `booster-rocket-pgdata`; networks `booster-rocket-internal` (project) and `booster-rocket-edge` (external).
  - `scripts/poc/deploy.sh` — env `BR_DIR` (default the repo root, `$(dirname "$0")/../..`), `BR_HEALTH_TIMEOUT` (seconds, default 120). Exit codes: 0 ok; 2 refused (dirty tree, env file missing/permissions); 3 migration failed (app untouched); 4 app unhealthy after timeout; 5 nothing to roll back to.
  - `scripts/poc/setup.sh` — idempotent first-time setup.

- [ ] **Step 1: `docker-compose.poc.yml`**

```yaml
name: booster-rocket

services:
  db:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_DB: booster
      POSTGRES_USER: booster
      POSTGRES_PASSWORD: ${DB_PASSWORD:?DB_PASSWORD is required}
      TZ: America/Chicago
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks: [internal]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U booster -d booster"]
      interval: 5s
      timeout: 5s
      retries: 10

  app:
    build: .
    image: booster-rocket-app:current
    container_name: booster-rocket-app
    restart: unless-stopped
    env_file: .env.poc
    environment:
      DATABASE_URL: postgresql://booster:${DB_PASSWORD}@db:5432/booster
      TZ: America/Chicago
    depends_on:
      db: { condition: service_healthy }
    networks: [internal, edge]

  migrate:
    # Same image as app (a separate `build:` here would go stale; profile services aren't rebuilt by `compose build`).
    image: booster-rocket-app:current
    profiles: ["tools"]
    env_file: .env.poc
    environment:
      DATABASE_URL: postgresql://booster:${DB_PASSWORD}@db:5432/booster
    depends_on:
      db: { condition: service_healthy }
    networks: [internal]
    command: ["node", "tools/scripts/migrate.mjs"]
    restart: "no"

volumes:
  pgdata:
    name: booster-rocket-pgdata

networks:
  internal:
    name: booster-rocket-internal
  edge:
    name: booster-rocket-edge
    external: true
```

The scripts always invoke compose as `docker compose -f docker-compose.poc.yml --env-file .env.poc …` so `${DB_PASSWORD}` resolves from the same file.

- [ ] **Step 2: `.env.poc.example`**

```bash
# Boosters Rocket proof of concept on linuxdev. Copy to .env.poc (setup.sh does this), chmod 600, never commit.
# setup.sh fills BETTER_AUTH_SECRET and DB_PASSWORD with fresh random values.

APP_URL=https://portaltest.rhinoautomator.com
BETTER_AUTH_SECRET=
DB_PASSWORD=
BOOTSTRAP_ADMIN_EMAIL=

# Staff door: Microsoft, app registration in the band's Entra tenant (runbook step 2).
STAFF_ENTRA_TENANT_ID=
STAFF_ENTRA_CLIENT_ID=
STAFF_ENTRA_CLIENT_SECRET=

# Parent door: Entra External ID (runbook step 3).
# https://<tenant-id>.ciamlogin.com/<tenant-id>/v2.0/.well-known/openid-configuration
PARENT_OIDC_DISCOVERY_URL=
PARENT_OIDC_CLIENT_ID=
PARENT_OIDC_CLIENT_SECRET=
```

- [ ] **Step 3: Failing test for `deploy.sh`**

`tests/unit/deploy-script.test.ts` runs the real script with stub `docker` and `git` on `PATH`. Each stub appends its arguments to a log file and returns codes controlled by env vars.

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = path.resolve("scripts/poc/deploy.sh");
let dir: string, bin: string, log: string;

function stub(name: string, body: string) {
  const p = path.join(bin, name);
  writeFileSync(p, `#!/usr/bin/env bash\necho "${name} $*" >> "${log.replace(/\\/g, "/")}"\n${body}\n`);
  chmodSync(p, 0o755);
}

function run(args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, BR_DIR: dir, BR_HEALTH_TIMEOUT: "2", ...env },
  });
}
const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "br-deploy-"));
  bin = path.join(dir, "bin"); mkdirSync(bin);
  log = path.join(dir, "calls.log");
  writeFileSync(path.join(dir, ".env.poc"), "DB_PASSWORD=x\n"); chmodSync(path.join(dir, ".env.poc"), 0o600);
  copyFileSync(path.resolve("docker-compose.poc.yml"), path.join(dir, "docker-compose.poc.yml"));
  stub("git", `case "$1" in status) printf "%s" "\${GIT_DIRTY:-}";; rev-parse) echo abc1234;; *) exit 0;; esac`);
  stub("docker", `
    case "$*" in
      *"run --rm migrate"*) exit \${MIGRATE_FAIL:-0};;
      *"inspect --format"*) echo "\${HEALTH:-healthy}";;
      *"image inspect booster-rocket-app:previous"*) exit \${NO_PREVIOUS:-0};;
      *"image inspect booster-rocket-app:current"*) exit \${NO_CURRENT:-0};;
      *) exit 0;;
    esac`);
});

describe("scripts/poc/deploy.sh", () => {
  it("pulls, builds, migrates, recreates the app and waits for health, in that order", () => {
    const r = run();
    expect(r.status).toBe(0);
    const c = calls();
    const order = ["git pull --ff-only", "docker image tag booster-rocket-app:current booster-rocket-app:previous", "compose -f docker-compose.poc.yml --env-file .env.poc build app",
      "run --rm migrate", "up -d --no-deps --force-recreate app", "inspect --format"];
    let at = -1;
    for (const step of order) { const i = c.indexOf(step, at + 1); expect(i, `missing or out of order: ${step}\n${c}`).toBeGreaterThan(at); at = i; }
    expect(r.stdout).toContain("Deployed abc1234");
  });

  it("refuses when the checkout has local changes, before touching anything", () => {
    const r = run([], { GIT_DIRTY: " M src/app/page.tsx\n" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("local changes");
    expect(calls()).not.toContain("docker");
    expect(calls()).not.toContain("git pull");
  });

  it("stops when migrations fail and leaves the running app alone", () => {
    const r = run([], { MIGRATE_FAIL: "1" });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("Migrations failed");
    expect(calls()).not.toContain("up -d");
  });

  it("fails loudly when the app never becomes healthy", () => {
    const r = run([], { HEALTH: "unhealthy" });
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("didn't become healthy");
  });

  it("refuses when .env.poc is missing", () => {
    rmSync(path.join(dir, ".env.poc"));
    const r = run();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(".env.poc is missing");
    expect(calls()).not.toContain("docker");
  });

  it.skipIf(process.platform === "win32")("refuses when .env.poc is readable by others", () => {
    chmodSync(path.join(dir, ".env.poc"), 0o644);
    const r = run();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("chmod 600");
  });

  it("rolls back to the previous image", () => {
    const r = run(["--rollback"]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("docker image tag booster-rocket-app:previous booster-rocket-app:current");
    expect(calls()).toContain("up -d --no-deps --force-recreate app");
    expect(calls()).not.toContain("git pull");
  });

  it("says plainly when there is nothing to roll back to, and changes nothing", () => {
    const r = run(["--rollback"], { NO_PREVIOUS: "1" });
    expect(r.status).toBe(5);
    expect(r.stderr).toContain("No previous image");
    expect(calls()).not.toContain("up -d");
    expect(calls()).not.toContain("image tag");
  });

  it("skips tagging a previous image on the very first deploy", () => {
    const r = run([], { NO_CURRENT: "1" });
    expect(r.status).toBe(0);
    expect(calls()).not.toContain("image tag booster-rocket-app:current booster-rocket-app:previous");
  });
});
```

- [ ] **Step 4: Run to see it fail** — `pnpm test tests/unit/deploy-script.test.ts` — Expected: FAIL (script missing).

- [ ] **Step 5: Implement `scripts/poc/deploy.sh`**

```bash
#!/usr/bin/env bash
# Deploys (or rolls back) the Boosters Rocket proof of concept on linuxdev.
#   scripts/poc/deploy.sh             pull main, build, migrate, recreate app, wait healthy
#   scripts/poc/deploy.sh --rollback  return to the previous image
# Exit codes: 0 ok, 2 refused, 3 migrations failed (app untouched), 4 app unhealthy, 5 nothing to roll back to.
set -euo pipefail

BR_DIR="${BR_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
BR_HEALTH_TIMEOUT="${BR_HEALTH_TIMEOUT:-120}"
APP_IMAGE="booster-rocket-app"
COMPOSE=(docker compose -f docker-compose.poc.yml --env-file .env.poc)

cd "$BR_DIR"

say() { printf '%s\n' "$*"; }
die() { local code="$1"; shift; printf '%s\n' "$*" >&2; exit "$code"; }

check_env_file() {
  [ -f .env.poc ] || die 2 ".env.poc is missing. Run scripts/poc/setup.sh first."
  if [ "$(uname -s)" = "Linux" ]; then
    local mode
    mode="$(stat -c '%a' .env.poc)"
    [ "$mode" = "600" ] || die 2 ".env.poc must be private: run chmod 600 .env.poc (it is $mode)."
  fi
}

wait_healthy() {
  local waited=0 status
  while [ "$waited" -lt "$BR_HEALTH_TIMEOUT" ]; do
    status="$(docker inspect --format '{{.State.Health.Status}}' booster-rocket-app 2>/dev/null || echo missing)"
    [ "$status" = "healthy" ] && return 0
    sleep 2
    waited=$((waited + 2))
  done
  die 4 "The app didn't become healthy within ${BR_HEALTH_TIMEOUT}s. Check: docker logs booster-rocket-app. To go back: scripts/poc/deploy.sh --rollback"
}

recreate_app() {
  "${COMPOSE[@]}" up -d --no-deps --force-recreate app
  wait_healthy
}

if [ "${1:-}" = "--rollback" ]; then
  check_env_file
  docker image inspect "$APP_IMAGE:previous" >/dev/null 2>&1 || die 5 "No previous image to roll back to. Nothing was changed."
  docker image tag "$APP_IMAGE:previous" "$APP_IMAGE:current"
  recreate_app
  say "Rolled back to the previous image."
  exit 0
fi

[ -z "$(git status --porcelain)" ] || die 2 "This checkout has local changes. Commit or discard them before deploying."
check_env_file

git pull --ff-only
if docker image inspect "$APP_IMAGE:current" >/dev/null 2>&1; then
  docker image tag "$APP_IMAGE:current" "$APP_IMAGE:previous"
fi
"${COMPOSE[@]}" build app
"${COMPOSE[@]}" run --rm migrate || die 3 "Migrations failed. The running app was not touched."
recreate_app
say "Deployed $(git rev-parse --short HEAD)."
```

- [ ] **Step 6: Implement `scripts/poc/setup.sh`**

```bash
#!/usr/bin/env bash
# One-time setup for the Boosters Rocket proof of concept on linuxdev. Safe to run again.
set -euo pipefail

BR_DIR="${BR_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$BR_DIR"

need() { command -v "$1" >/dev/null 2>&1 || { printf 'Missing: %s\n' "$1" >&2; exit 2; }; }
need docker; need git; need openssl

if ! docker network inspect booster-rocket-edge >/dev/null 2>&1; then
  docker network create booster-rocket-edge >/dev/null
  echo "Created network booster-rocket-edge."
else
  echo "Network booster-rocket-edge already exists."
fi

if [ ! -f .env.poc ]; then
  umask 077
  sed -e "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -hex 32)|" \
      -e "s|^DB_PASSWORD=.*|DB_PASSWORD=$(openssl rand -hex 24)|" .env.poc.example > .env.poc
  chmod 600 .env.poc
  echo "Created .env.poc with fresh secrets. Fill in the Microsoft values from the runbook."
else
  echo ".env.poc already exists; left as is."
fi

cat <<'EOF'

One manual step: let cloudflared reach the app.
In ~/n8n/docker-compose.yml add `booster-rocket-edge` under the cloudflared service's networks:
      - booster-rocket-edge
and under the top-level networks:
  booster-rocket-edge:
    external: true
Then run:  docker compose -f ~/n8n/docker-compose.yml up -d cloudflared

When .env.poc is complete, deploy with:  scripts/poc/deploy.sh
EOF
```

`chmod +x scripts/poc/*.sh` and commit the executable bit (`git update-index --chmod=+x scripts/poc/setup.sh scripts/poc/deploy.sh`).

- [ ] **Step 7: Run tests and shellcheck**

Run: `pnpm test tests/unit/deploy-script.test.ts` — Expected: PASS (the permission case is skipped on Windows, runs in CI).
Run: `docker run --rm -v "$PWD:/mnt" -w /mnt koalaman/shellcheck:stable scripts/poc/setup.sh scripts/poc/deploy.sh scripts/check-image-secrets.sh scripts/smoke-image.sh` — Expected: no output.
Run: `docker compose -f docker-compose.poc.yml --env-file .env.poc.example config -q` after setting `DB_PASSWORD` in a temp copy, to validate the compose file — Expected: exit 0.

- [ ] **Step 8: CI shellcheck**

Add to the `test` job in `.github/workflows/ci.yml`, after `pnpm lint`:

```yaml
      - run: shellcheck scripts/poc/setup.sh scripts/poc/deploy.sh scripts/check-image-secrets.sh scripts/smoke-image.sh
```

- [ ] **Step 9: Full suite and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test` — pristine.

```bash
git add docker-compose.poc.yml .env.poc.example scripts/poc tests/unit/deploy-script.test.ts .github/workflows/ci.yml
git commit -m "feat(ops): POC compose file with setup, deploy and rollback scripts"
```

---

### Task 5: The runbook

**Files:**
- Create: `docs/runbooks/poc-linuxdev.md`

**Interfaces:**
- Consumes: everything above; exact routes `/api/auth/staff/callback/microsoft` and `/api/auth/parent/callback/parent-oidc` (verify both against Better Auth 1.7.18's route shapes in `node_modules/better-auth` — the generic OAuth callback path may be `/oauth2/callback/parent-oidc` under the parent base path; use whatever the installed version actually serves, and state it).
- Produces: the document the owner follows, with the spec §6 checklist and a results table.

- [ ] **Step 1: Verify the callback URLs**

Read Better Auth's route definitions in `node_modules/better-auth/dist` for social callbacks and the generic OAuth plugin's callback, and confirm the full redirect URIs for:
- staff Microsoft: `https://portaltest.rhinoautomator.com/api/auth/staff/<path>`
- parent OIDC: `https://portaltest.rhinoautomator.com/api/auth/parent/<path>`
Record the evidence (file and line) in the task report. If the parent path is `/oauth2/callback/parent-oidc`, use that.

- [ ] **Step 2: Check current dashboard steps**

Using Microsoft Learn (learn.microsoft.com) and Cloudflare's docs (developers.cloudflare.com), confirm the current click paths for:
- registering a single-tenant web app with a client secret in Entra ID;
- creating an external tenant in Entra External ID, registering an app, creating a user flow with **Email one-time passcode** and **disabling sign-up** (`isSignUpAllowed: false` on the user flow via Microsoft Graph or the admin center, whichever the docs currently show);
- adding a public hostname to a remotely managed Cloudflare tunnel (leave HTTP Host Header unset);
- creating a Cloudflare Access self-hosted application with an Allow policy for specific emails and One-time PIN.
Cite each source URL in the runbook.

- [ ] **Step 3: Write `docs/runbooks/poc-linuxdev.md`**

Sections, in this order, each written as numbered steps for a non-developer:

1. **What this is** — two sentences; test data only.
2. **First-time setup on linuxdev** — `git clone git@github.com:bmsimp/booster-rocket.git ~/booster-rocket`, `cd ~/booster-rocket`, `scripts/poc/setup.sh`, the n8n compose edit (the exact YAML), `docker compose -f ~/n8n/docker-compose.yml up -d cloudflared`, and how to confirm the tunnel re-registered (`docker logs cloudflared | grep "Registered tunnel connection"`).
3. **Staff sign-in (band's Entra tenant)** — the verified steps; which `.env.poc` keys get the tenant ID (GUID), client ID and secret; set `BOOTSTRAP_ADMIN_EMAIL`.
4. **Parent sign-in (Entra External ID)** — create the external tenant (United States), app registration, user flow (email one-time passcode, sign-up off), the discovery URL format, which `.env.poc` keys to fill.
5. **Test parents** — create two users in the external tenant; copy the first one's Object ID; then:
   `docker compose -f docker-compose.poc.yml --env-file .env.poc run --rm migrate node tools/scripts/seed-poc-guardian.mjs --name "<name>" --email "<email>" --object-id "<object id>" --family POC-FAMILY-1`
6. **Cloudflare** — public hostname `portaltest.rhinoautomator.com` → `http://booster-rocket-app:3000`, HTTP Host Header unset; Access application with the email list and One-time PIN.
7. **Deploy** — `scripts/poc/deploy.sh`; what success looks like; `--rollback`; where logs are (`docker logs booster-rocket-app`).
8. **The test checklist** — spec §6 steps 1–8 verbatim as checkboxes, plus how to read the audit log (staff → Audit).
9. **Troubleshooting** — a table: symptom → likely cause → fix. Must include: `signin.refused` reasons `missing_object_id`, `no_guardian`, `disabled`; `parent.object_id_unverified` reasons (`subject_mismatch`, `expired`, bad issuer/audience, `missing_oid`, `user_missing`); Microsoft error for a wrong redirect URI; staff app accidentally multi-tenant (app refuses to start: tenant must be a GUID); sign-up left on in External ID; Cloudflare 502 (edge network not attached to cloudflared, or app unhealthy); server action/origin errors (HTTP Host Header set in the tunnel, or `APP_URL` wrong).
10. **Results** — a table with columns Date · Commit · Step · Pass/Fail · Notes, empty rows for steps 1–8.

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/poc-linuxdev.md
git commit -m "docs(runbook): proof of concept on linuxdev"
```

---

### Task 6: First deployment and the real test (controller with the owner)

Not a subagent task: it needs the owner's dashboards and decisions. The controller drives `linuxdev` over SSH; the owner does the Entra, External ID and Cloudflare steps.

- [ ] **Step 1:** Push `main`; confirm both CI jobs (`test`, `image`) are green.
- [ ] **Step 2:** On linuxdev (controller, over SSH): clone, run `scripts/poc/setup.sh`.
- [ ] **Step 3:** Owner approves the edit to `~/n8n/docker-compose.yml`; controller applies it (backing up the file first as `docker-compose.yml.bak-booster`), recreates `cloudflared`, and confirms the tunnel re-registered.
- [ ] **Step 4:** Owner follows runbook sections 3–6 and fills in the Microsoft values in `.env.poc` (the controller never asks for or handles client secrets in chat; the owner pastes them into the file on linuxdev directly).
- [ ] **Step 5:** Controller runs `scripts/poc/deploy.sh` and confirms the app is healthy.
- [ ] **Step 6:** Owner and controller walk the checklist; controller records results in the runbook's Results table and commits.
- [ ] **Step 7:** Any failure is diagnosed from the audit log reasons and container logs; fixes go through the normal implement-and-review loop.
