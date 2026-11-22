# Plan 1: Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running Boosters Rocket app with Postgres, the CIPP-style permissions system, two separate sign-in doors (staff and parent), the first-admin bootstrap, roles and staff screens, club theming with display modes, the app shell, an audit log, and CI.

**Architecture:** One Next.js (App Router, TypeScript strict) app. Drizzle ORM over Postgres. Two independent Better Auth instances, one per door, each with its own tables, cookie prefix and route base, so a staff session and a parent session can never be confused or linked. Every staff server action is wrapped by a guard that declares its permission, and a test fails the build if one isn't. Styling ports `design/reference/booster.css` with the club colour derived at runtime.

**Tech Stack:** Node 22 LTS, pnpm, Next.js (latest stable via `create-next-app`), TypeScript strict, Drizzle ORM + drizzle-kit, `postgres` (postgres.js) driver, Postgres 16, Better Auth (+ `genericOAuth` plugin), zod, Vitest, Playwright, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-06-booster-rocket-v1-design.md` (sections 1, 3, 4, 5, 7, 12, 13, 16). Visual rules: `DESIGN.md`. Roadmap: `docs/superpowers/plans/2026-11-07-v1-roadmap.md`.

## Global Constraints

- License AGPL-3.0; no dependency with a paid licence or a licence incompatible with AGPL.
- All QuickBooks, Graph and auth secrets stay on the server; nothing secret reaches the browser (spec §12.5).
- A parent-door session never carries a staff role; a staff-door session never reaches parent pages (spec §5.1).
- Unknown identities at either door get the same generic refusal, whatever the reason (spec §5.1).
- Permissions are strings `Area.Object.Level` with Level `Read` or `ReadWrite`; ReadWrite includes Read; exclude always wins; `*` is a wildcard; roles expand against the current registry each time they are used (spec §7).
- Admin is built in, holds every permission, cannot be edited or deleted; the last admin cannot be removed or demoted; only Admin can create, change or assign roles (spec §5.3, §7).
- Every staff server action and API route declares its permission; a test fails the build if one doesn't (spec §7).
- Every write records who (person and door), what, which record, before/after, when, request IP (spec §13).
- Type sizes in rem only; square corners; 2px ink rules; no shadows except inset rules; club colours derived from one club colour (DESIGN.md "Derived Club", "Rem-Only").
- WCAG 2.2 AA; tap targets ≥ 44px; focus ring `club-text`, `club-on` inside the club bar (DESIGN.md Focus).
- Fonts self-hosted (use `next/font/google`, which downloads at build and serves from the app).
- Copy voice: warm, plain neighbour; never scolding (PRODUCT.md).

## Review Focus

1. **Email case and whitespace at staff sign-in.** An invite for `Pat@Club.org ` must match a Google sign-in as `pat@club.org`. Test in Task 6.
2. **Two first sign-ins racing the bootstrap.** Exactly one becomes Admin; the other is refused. Test in Task 7.
3. **A malformed club colour** (`red`, `#12`, `#1234567`, `#FFF`, CSS injection like `#000;}body{display:none`) is normalised or rejected, never written into CSS. Test in Task 5.
4. **Odd role patterns** (empty string, spaces, `Roster..Read`, `*.*.Write`) are rejected on save; a role whose exclude is `*` grants nothing. Test in Task 3.
5. **A staff user disabled mid-session** is refused on their next request, not at their next sign-in. Test in Task 6.

---

## File structure

```
booster-rocket/
  .github/workflows/ci.yml          CI: lint, typecheck, unit+integration tests, build, bundle check, e2e
  docker-compose.yml                Postgres 16 for development and tests
  .env.example                      Every environment variable, documented
  drizzle.config.ts
  vitest.config.ts
  playwright.config.ts
  scripts/check-client-bundle.mjs   Fails if a secret value appears in the client bundle
  drizzle/                          Generated migrations (committed)
  src/
    env.ts                          zod-validated environment
    lib/
      db/client.ts                  postgres.js + Drizzle client
      db/schema.ts                  All tables for this plan
      permissions/registry.ts       The permission universe (code is the full list)
      permissions/rules.ts          Pattern matching, validation, expansion (pure)
      permissions/effective.ts      A staff user's effective permissions (DB)
      audit/log.ts                  writeAudit()
      theme/contrast.ts             Colour math and deriveClubTokens() (pure)
      settings/club.ts              Club settings read/write
      auth/staff-auth.ts            Better Auth instance for the staff door
      auth/parent-auth.ts           Better Auth instance for the parent door
      auth/resolve.ts               Map an auth user to a staff user / guardian (DB)
      auth/bootstrap.ts             First-admin claim
      auth/identity.ts              getStaffIdentity() / getParentIdentity() from request
      guards.ts                     staffAction / parentAction / page guards / registry
      staff/roles.ts                Role and staff-user services
      request.ts                    Request IP helper
    app/
      layout.tsx                    Root: fonts, club CSS vars, display-mode script
      booster.css                   Ported from design/reference/booster.css
      display-script.ts             Inline pre-paint display-mode script (string)
      api/auth/staff/[...all]/route.ts
      api/auth/parent/[...all]/route.ts
      sign-in/page.tsx              Parent door
      refused/page.tsx              The one generic refusal
      (parent)/layout.tsx           Parent shell: club bar + bottom tabs
      (parent)/page.tsx             Parent home (placeholder until Plan 2)
      (parent)/display/page.tsx     Display settings
      staff/sign-in/page.tsx        Staff door
      staff/(app)/layout.tsx        Staff shell
      staff/(app)/page.tsx          Staff home
      staff/(app)/people/page.tsx + actions.ts
      staff/(app)/roles/page.tsx + actions.ts
      staff/(app)/settings/club/page.tsx + actions.ts
      staff/(app)/audit/page.tsx
      components/                   ClubBar, Tabs, Box, ChoiceGroup, SignInButton
  tests/
    setup/global-setup.ts           Migrate the test database
    helpers/db.ts                   resetDb(), seed helpers
    unit/…                          Pure-function tests
    integration/…                   DB-backed tests
    e2e/public-pages.spec.ts        Anonymous pages show no family data
```

---

### Task 1: Scaffold, tooling and CI

**Files:**
- Create: `package.json` (via create-next-app), `docker-compose.yml`, `.env.example`, `vitest.config.ts`, `tests/unit/smoke.test.ts`, `.github/workflows/ci.yml`, `.nvmrc`
- Modify: `tsconfig.json`, `.gitignore`

**Interfaces:**
- Produces: `pnpm test` (Vitest), `pnpm lint`, `pnpm typecheck`, `pnpm build`; Postgres on `localhost:5433` (user/pass/db `booster`/`booster`/`booster`, test db `booster_test`).

- [ ] **Step 1: Create the app in place**

Run from `G:\booster-rocket` (it already holds `docs/`, `design/`, `DESIGN.md`, `PRODUCT.md`, `LICENSE`, `README.md`; create-next-app refuses a non-empty dir, so scaffold into a temp folder and move):

```bash
pnpm dlx create-next-app@latest .scaffold --ts --app --src-dir --eslint --no-tailwind --import-alias "@/*" --use-pnpm --yes
cp -r .scaffold/. . && rm -rf .scaffold
rm -f src/app/page.module.css src/app/globals.css public/*.svg
echo "22" > .nvmrc
```

Expected: `src/app/layout.tsx`, `src/app/page.tsx`, `package.json` exist. Record the Next.js version in the commit message.

- [ ] **Step 2: Strict TypeScript**

In `tsconfig.json` set `"strict": true`, `"noUncheckedIndexedAccess": true`, `"noImplicitOverride": true` under `compilerOptions`. Add to `package.json` scripts:

```json
"typecheck": "tsc --noEmit",
"test": "vitest run",
"test:watch": "vitest",
"e2e": "playwright test",
"db:generate": "drizzle-kit generate",
"db:migrate": "tsx src/lib/db/migrate.ts"
```

- [ ] **Step 3: Postgres for development and tests**

`docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: booster
      POSTGRES_PASSWORD: booster
      POSTGRES_DB: booster
    ports: ["5433:5432"]
    volumes:
      - ./docker/initdb:/docker-entrypoint-initdb.d
      - pgdata:/var/lib/postgresql/data
volumes:
  pgdata:
```

`docker/initdb/01-test-db.sql`:

```sql
CREATE DATABASE booster_test OWNER booster;
```

Run: `docker compose up -d db` then `docker compose exec db psql -U booster -c '\l'`
Expected: both `booster` and `booster_test` listed.

- [ ] **Step 4: Vitest with a smoke test**

```bash
pnpm add -D vitest @vitest/coverage-v8 tsx
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    environment: "node",
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    env: {
      DATABASE_URL: "postgres://booster:booster@localhost:5433/booster_test",
      BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-32",
      APP_URL: "http://localhost:3000",
    },
    fileParallelism: false,
  },
});
```

`tests/unit/smoke.test.ts`:

```ts
import { describe, it, expect } from "vitest";

describe("toolchain", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run: `pnpm test` — Expected: 1 passed.

- [ ] **Step 5: `.env.example`**

```bash
# Database
DATABASE_URL=postgres://booster:booster@localhost:5433/booster
# Public base URL of this deployment, no trailing slash
APP_URL=http://localhost:3000
# 32+ random characters; signs session cookies for both doors
BETTER_AUTH_SECRET=change-me-to-32-or-more-random-characters
# First admin: the first staff sign-in with this verified email becomes Admin (ignored once an admin exists)
BOOTSTRAP_ADMIN_EMAIL=

# Staff door: Microsoft Entra (club workforce tenant). Leave blank to disable.
STAFF_ENTRA_TENANT_ID=
STAFF_ENTRA_CLIENT_ID=
STAFF_ENTRA_CLIENT_SECRET=
# Staff door: Google. Leave blank to disable.
STAFF_GOOGLE_CLIENT_ID=
STAFF_GOOGLE_CLIENT_SECRET=

# Parent door: any OIDC provider. Default documented setup is Entra External ID:
# https://<tenant-id>.ciamlogin.com/<tenant-id>/v2.0/.well-known/openid-configuration
PARENT_OIDC_DISCOVERY_URL=
PARENT_OIDC_CLIENT_ID=
PARENT_OIDC_CLIENT_SECRET=
```

Add `.env`, `.env.local`, `test-results/`, `playwright-report/` to `.gitignore`.

- [ ] **Step 6: CI workflow**

`.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_USER: booster, POSTGRES_PASSWORD: booster, POSTGRES_DB: booster_test }
        ports: ["5433:5432"]
        options: >-
          --health-cmd "pg_isready -U booster" --health-interval 5s --health-timeout 5s --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
```

(Later tasks append build, bundle-check and e2e steps to this job.)

- [ ] **Step 7: Verify and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test` — Expected: all pass.

```bash
git add -A
git commit -m "chore: scaffold Next.js app, Postgres, Vitest and CI"
```

---

### Task 2: Environment, database client and schema

**Files:**
- Create: `src/env.ts`, `src/lib/db/client.ts`, `src/lib/db/schema.ts`, `src/lib/db/migrate.ts`, `drizzle.config.ts`, `tests/setup/global-setup.ts`, `tests/helpers/db.ts`, `tests/integration/schema.test.ts`
- Modify: `vitest.config.ts` (add `globalSetup`)

**Interfaces:**
- Produces: `env` (typed config), `db` (Drizzle client), tables `setting`, `staffUser`, `guardian`, `role`, `roleRule`, `roleAssignment`, `auditLog`, plus Better Auth tables `staffAuthUser/Session/Account/Verification` and `parentAuthUser/Session/Account/Verification`; test helpers `resetDb()`.

- [ ] **Step 1: Install**

```bash
pnpm add drizzle-orm postgres zod
pnpm add -D drizzle-kit
```

- [ ] **Step 2: `src/env.ts`**

```ts
import { z } from "zod";

const optional = z.string().trim().optional().transform((v) => (v ? v : undefined));

const schema = z.object({
  DATABASE_URL: z.string().url(),
  APP_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BOOTSTRAP_ADMIN_EMAIL: optional,
  STAFF_ENTRA_TENANT_ID: optional,
  STAFF_ENTRA_CLIENT_ID: optional,
  STAFF_ENTRA_CLIENT_SECRET: optional,
  STAFF_GOOGLE_CLIENT_ID: optional,
  STAFF_GOOGLE_CLIENT_SECRET: optional,
  PARENT_OIDC_DISCOVERY_URL: optional,
  PARENT_OIDC_CLIENT_ID: optional,
  PARENT_OIDC_CLIENT_SECRET: optional,
});

export type Env = z.infer<typeof schema>;
export const env: Env = schema.parse(process.env);

export const staffEntraEnabled = Boolean(env.STAFF_ENTRA_TENANT_ID && env.STAFF_ENTRA_CLIENT_ID && env.STAFF_ENTRA_CLIENT_SECRET);
export const staffGoogleEnabled = Boolean(env.STAFF_GOOGLE_CLIENT_ID && env.STAFF_GOOGLE_CLIENT_SECRET);
export const parentDoorEnabled = Boolean(env.PARENT_OIDC_DISCOVERY_URL && env.PARENT_OIDC_CLIENT_ID && env.PARENT_OIDC_CLIENT_SECRET);
```

- [ ] **Step 3: `src/lib/db/client.ts`**

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@/env";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { pg?: ReturnType<typeof postgres> };
const pg = globalForDb.pg ?? postgres(env.DATABASE_URL, { max: 10 });
if (process.env.NODE_ENV !== "production") globalForDb.pg = pg;

export const db = drizzle(pg, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
```

- [ ] **Step 4: `src/lib/db/schema.ts`**

```ts
import { pgTable, text, timestamp, boolean, uuid, jsonb, uniqueIndex, index, inet, bigserial } from "drizzle-orm/pg-core";

const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updated = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** Key/value runtime settings (club name, colour, monogram, …). */
export const setting = pgTable("setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updated(),
});

/** People who sign in through the staff door. */
export const staffUser = pgTable("staff_user", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  email: text("email").notNull(), // stored trimmed + lower-cased
  status: text("status", { enum: ["invited", "active", "disabled"] }).notNull().default("invited"),
  authUserId: text("auth_user_id"), // staff_auth_user.id once bound at first sign-in
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  uniqueIndex("staff_user_email_uq").on(t.email),
  uniqueIndex("staff_user_auth_uq").on(t.authUserId),
]);

/** People who sign in through the parent door for a family. Provisioning arrives in Plan 3. */
export const guardian = pgTable("guardian", {
  id: uuid("id").primaryKey().defaultRandom(),
  familyQboId: text("family_qbo_id").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  isPrimary: boolean("is_primary").notNull().default(false),
  identityObjectId: text("identity_object_id"), // External ID user object id (oid claim)
  status: text("status", { enum: ["invited", "active", "disabled"] }).notNull().default("invited"),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [
  uniqueIndex("guardian_object_uq").on(t.identityObjectId),
  index("guardian_family_ix").on(t.familyQboId),
]);

/** Roles. The built-in Admin role has key 'admin' and builtin=true. */
export const role = pgTable("role", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  builtin: boolean("builtin").notNull().default(false),
  createdAt: created(),
  updatedAt: updated(),
}, (t) => [uniqueIndex("role_key_uq").on(t.key)]);

export const roleRule = pgTable("role_rule", {
  id: uuid("id").primaryKey().defaultRandom(),
  roleId: uuid("role_id").notNull().references(() => role.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["include", "exclude"] }).notNull(),
  pattern: text("pattern").notNull(),
}, (t) => [index("role_rule_role_ix").on(t.roleId)]);

export const roleAssignment = pgTable("role_assignment", {
  roleId: uuid("role_id").notNull().references(() => role.id, { onDelete: "cascade" }),
  staffUserId: uuid("staff_user_id").notNull().references(() => staffUser.id, { onDelete: "cascade" }),
  createdAt: created(),
}, (t) => [uniqueIndex("role_assignment_uq").on(t.roleId, t.staffUserId)]);

/** Append-only audit trail (spec §13). */
export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  door: text("door", { enum: ["staff", "parent", "system"] }).notNull(),
  actorId: text("actor_id"),        // staff_user.id, guardian.id, or null for system
  actorLabel: text("actor_label"),  // name/email at the time
  action: text("action").notNull(), // e.g. "role.assign", "signin.refused"
  permission: text("permission"),
  targetType: text("target_type"),
  targetId: text("target_id"),
  before: jsonb("before"),
  after: jsonb("after"),
  ip: inet("ip"),
}, (t) => [index("audit_at_ix").on(t.at)]);

/* ---- Better Auth tables, one set per door (Better Auth core schema) ---- */
function authTables(prefix: "staff_auth" | "parent_auth", extraUser: Record<string, ReturnType<typeof text>> = {}) {
  const user = pgTable(`${prefix}_user`, {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    ...extraUser,
    createdAt: created(),
    updatedAt: updated(),
  });
  const session = pgTable(`${prefix}_session`, {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: created(),
    updatedAt: updated(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  });
  const account = pgTable(`${prefix}_account`, {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: created(),
    updatedAt: updated(),
  });
  const verification = pgTable(`${prefix}_verification`, {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: created(),
    updatedAt: updated(),
  });
  return { user, session, account, verification };
}

const staffAuth = authTables("staff_auth");
export const staffAuthUser = staffAuth.user;
export const staffAuthSession = staffAuth.session;
export const staffAuthAccount = staffAuth.account;
export const staffAuthVerification = staffAuth.verification;

const parentAuth = authTables("parent_auth", { objectId: text("object_id") });
export const parentAuthUser = parentAuth.user;
export const parentAuthSession = parentAuth.session;
export const parentAuthAccount = parentAuth.account;
export const parentAuthVerification = parentAuth.verification;
```

- [ ] **Step 5: Migrations**

`drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "postgres://booster:booster@localhost:5433/booster" },
});
```

`src/lib/db/migrate.ts`:

```ts
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export async function runMigrations(url: string) {
  const pg = postgres(url, { max: 1 });
  await migrate(drizzle(pg), { migrationsFolder: "drizzle" });
  await pg.end();
}

if (process.argv[1]?.endsWith("migrate.ts")) {
  runMigrations(process.env.DATABASE_URL!).then(() => console.log("migrated"));
}
```

Run: `pnpm db:generate` — Expected: `drizzle/0000_*.sql` created containing `CREATE TABLE "staff_user"`, `"parent_auth_user"` with `"object_id"`, etc.

- [ ] **Step 6: Built-in Admin role in a migration**

Run: `pnpm drizzle-kit generate --custom --name seed_admin_role` and put in the generated SQL file:

```sql
INSERT INTO "role" ("key", "name", "builtin") VALUES ('admin', 'Admin', true) ON CONFLICT ("key") DO NOTHING;
```

- [ ] **Step 7: Test setup and helpers**

`tests/setup/global-setup.ts`:

```ts
import { runMigrations } from "../../src/lib/db/migrate";

export default async function setup() {
  await runMigrations("postgres://booster:booster@localhost:5433/booster_test");
}
```

Add `globalSetup: ["tests/setup/global-setup.ts"]` to `test` in `vitest.config.ts`.

`tests/helpers/db.ts`:

```ts
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { role, staffUser, roleAssignment, guardian } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

const TABLES = [
  "audit_log", "role_assignment", "role_rule", "staff_user", "guardian", "setting",
  "staff_auth_session", "staff_auth_account", "staff_auth_verification", "staff_auth_user",
  "parent_auth_session", "parent_auth_account", "parent_auth_verification", "parent_auth_user",
];

/** Empties every table except the built-in Admin role, and removes custom roles. */
export async function resetDb() {
  await db.execute(sql.raw(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} RESTART IDENTITY CASCADE`));
  await db.execute(sql`DELETE FROM "role" WHERE "builtin" = false`);
}

export async function adminRoleId(): Promise<string> {
  const [r] = await db.select().from(role).where(eq(role.key, "admin"));
  if (!r) throw new Error("admin role missing — migrations not applied");
  return r.id;
}

export async function seedStaff(opts: { email: string; name?: string; status?: "invited" | "active" | "disabled"; admin?: boolean }) {
  const [s] = await db.insert(staffUser).values({
    email: opts.email.trim().toLowerCase(),
    name: opts.name ?? opts.email,
    status: opts.status ?? "active",
  }).returning();
  if (opts.admin) await db.insert(roleAssignment).values({ roleId: await adminRoleId(), staffUserId: s!.id });
  return s!;
}

export async function seedGuardian(opts: { name: string; familyQboId: string; objectId?: string; status?: "invited" | "active" | "disabled" }) {
  const [g] = await db.insert(guardian).values({
    name: opts.name, email: `${opts.name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
    familyQboId: opts.familyQboId, identityObjectId: opts.objectId ?? null, status: opts.status ?? "active",
  }).returning();
  return g!;
}
```

- [ ] **Step 8: Write the schema test**

`tests/integration/schema.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { role } from "@/lib/db/schema";
import { resetDb, seedStaff } from "../helpers/db";

describe("schema", () => {
  beforeEach(resetDb);

  it("ships exactly one built-in Admin role", async () => {
    const roles = await db.select().from(role);
    expect(roles.filter((r) => r.builtin)).toEqual([expect.objectContaining({ key: "admin", name: "Admin" })]);
  });

  it("rejects two staff users with the same email", async () => {
    await seedStaff({ email: "pat@club.org" });
    await expect(seedStaff({ email: " PAT@club.org " })).rejects.toThrow();
  });
});
```

- [ ] **Step 9: Run**

Run: `pnpm test` — Expected: schema tests PASS (Admin seeded by migration, duplicate email rejected because `seedStaff` normalises).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(db): environment, Drizzle schema, migrations and test helpers"
```

---

### Task 3: Permission registry and rule expansion

**Files:**
- Create: `src/lib/permissions/registry.ts`, `src/lib/permissions/rules.ts`, `tests/unit/permissions/rules.test.ts`

**Interfaces:**
- Produces:
  - `PERMISSIONS: readonly Permission[]`, `type Permission`, `ADMIN_ONLY: readonly Permission[]`, `GRANTABLE: readonly Permission[]`
  - `type RoleRules = { include: string[]; exclude: string[] }`
  - `validatePattern(p: string): string | null` (error message or null)
  - `validateRules(r: RoleRules): string[]` (list of errors)
  - `matches(pattern: string, permission: string): boolean`
  - `expandRules(r: RoleRules, universe?: readonly Permission[]): Set<Permission>`

- [ ] **Step 1: Write the failing tests**

`tests/unit/permissions/rules.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { matches, expandRules, validatePattern, validateRules } from "@/lib/permissions/rules";
import { GRANTABLE, ADMIN_ONLY } from "@/lib/permissions/registry";

const U = ["Roster.Family.Read", "Roster.Family.ReadWrite", "Roster.Student.Read", "Roster.Student.ReadWrite", "Finance.Balance.Read"] as const;

describe("matches", () => {
  it("matches exact strings and * wildcards across dots", () => {
    expect(matches("Roster.Family.Read", "Roster.Family.Read")).toBe(true);
    expect(matches("Roster.*", "Roster.Student.ReadWrite")).toBe(true);
    expect(matches("*.Read", "Finance.Balance.Read")).toBe(true);
    expect(matches("Roster.*", "Finance.Balance.Read")).toBe(false);
  });
  it("treats regex characters literally", () => {
    expect(matches("Roster.Family.Rea.", "Roster.Family.Read")).toBe(false);
  });
});

describe("expandRules", () => {
  it("includes matches", () => {
    expect(expandRules({ include: ["Roster.*"], exclude: [] }, U)).toEqual(
      new Set(["Roster.Family.Read", "Roster.Family.ReadWrite", "Roster.Student.Read", "Roster.Student.ReadWrite"]));
  });
  it("ReadWrite includes Read", () => {
    expect(expandRules({ include: ["Roster.Family.ReadWrite"], exclude: [] }, U)).toEqual(
      new Set(["Roster.Family.Read", "Roster.Family.ReadWrite"]));
  });
  it("exclude always wins", () => {
    expect(expandRules({ include: ["Roster.*"], exclude: ["Roster.Student.*"] }, U)).toEqual(
      new Set(["Roster.Family.Read", "Roster.Family.ReadWrite"]));
  });
  it("excluding ReadWrite keeps Read", () => {
    expect(expandRules({ include: ["Roster.Family.ReadWrite"], exclude: ["Roster.Family.ReadWrite"] }, U)).toEqual(
      new Set(["Roster.Family.Read"]));
  });
  it("a role excluding * grants nothing", () => {
    expect(expandRules({ include: ["*"], exclude: ["*"] }, U).size).toBe(0);
  });
  it("never grants admin-only permissions, even with *", () => {
    const got = expandRules({ include: ["*"], exclude: [] });
    for (const p of ADMIN_ONLY) expect(got.has(p)).toBe(false);
    expect(got.size).toBe(GRANTABLE.length);
  });
  it("covers permissions added later through wildcards", () => {
    const later = [...U, "Roster.Guardian.Read"] as const;
    expect(expandRules({ include: ["Roster.*"], exclude: [] }, later).has("Roster.Guardian.Read" as never)).toBe(true);
  });
});

describe("validation", () => {
  it.each(["", "   ", "Roster..Read", "*.*.Write", "Roster Family.Read", "Roster.Family.read", "Roster.Family.Read.Extra"])(
    "rejects %j", (p) => expect(validatePattern(p)).not.toBeNull());
  it.each(["*", "Roster.*", "*.Read", "Roster.Family.ReadWrite", "Roster.*.Read"])(
    "accepts %j", (p) => expect(validatePattern(p)).toBeNull());
  it("requires at least one include", () => {
    expect(validateRules({ include: [], exclude: ["*"] })).toContain("A role needs at least one include pattern.");
  });
  it("rejects patterns that only match admin-only permissions", () => {
    expect(validateRules({ include: ["Admin.*"], exclude: [] })).toContain("“Admin.*” only matches Admin permissions, which can't be given to a role.");
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm test tests/unit/permissions` — Expected: FAIL, cannot resolve `@/lib/permissions/rules`.

- [ ] **Step 3: Registry**

`src/lib/permissions/registry.ts`:

```ts
/**
 * The full permission universe. Every staff action declares one of these (see guards.ts).
 * Add new permissions here; wildcard roles pick them up automatically.
 * Format: Area.Object.Level, Level = Read | ReadWrite.
 */
export const PERMISSIONS = [
  "Admin.Roles.ReadWrite",      // admin-only: create/change/assign roles
  "Staff.Users.Read",
  "Staff.Users.ReadWrite",
  "Settings.Club.Read",
  "Settings.Club.ReadWrite",
  "Audit.Log.Read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Never grantable through a custom role; only the built-in Admin holds them. */
export const ADMIN_ONLY: readonly Permission[] = ["Admin.Roles.ReadWrite"];

export const GRANTABLE: readonly Permission[] = PERMISSIONS.filter((p) => !ADMIN_ONLY.includes(p));

export function isPermission(s: string): s is Permission {
  return (PERMISSIONS as readonly string[]).includes(s);
}
```

- [ ] **Step 4: Rules**

`src/lib/permissions/rules.ts`:

```ts
import { GRANTABLE, ADMIN_ONLY, type Permission } from "./registry";

export type RoleRules = { include: string[]; exclude: string[] };

const SEGMENT = /^(\*|[A-Z][A-Za-z]*)$/;
const LEVEL = /^(\*|Read|ReadWrite)$/;

/** Returns an error message for a bad pattern, or null if it's fine. */
export function validatePattern(raw: string): string | null {
  const p = raw.trim();
  if (p === "") return "A pattern can't be empty.";
  if (p !== raw) return `“${raw}” has spaces at the start or end.`;
  if (p === "*") return null;
  const parts = p.split(".");
  if (parts.some((s) => s === "")) return `“${p}” has an empty part.`;
  if (parts.length === 2 && parts[1] === "*" && SEGMENT.test(parts[0]!)) return null; // "Roster.*"
  if (parts.length === 2 && parts[0] === "*" && LEVEL.test(parts[1]!) && parts[1] !== "*") return null; // "*.Read"
  if (parts.length !== 3) return `“${p}” should look like Area.Object.Read or Area.Object.ReadWrite.`;
  const [area, obj, level] = parts as [string, string, string];
  if (!SEGMENT.test(area) || !SEGMENT.test(obj)) return `“${p}” has a part that isn't a word or *.`;
  if (!LEVEL.test(level)) return `“${p}” must end in Read, ReadWrite or *.`;
  return null;
}

function toRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function matches(pattern: string, permission: string): boolean {
  return toRegex(pattern).test(permission);
}

/** Expands rules against the universe. Admin-only permissions are never returned. */
export function expandRules(rules: RoleRules, universe: readonly string[] = GRANTABLE): Set<Permission> {
  const out = new Set<Permission>();
  for (const perm of universe) {
    if (ADMIN_ONLY.includes(perm as Permission)) continue;
    const writeTwin = perm.endsWith(".Read") ? `${perm}Write` : null; // X.Read -> X.ReadWrite
    const included = rules.include.some((inc) => matches(inc, perm) || (writeTwin !== null && matches(inc, writeTwin)));
    if (!included) continue;
    if (rules.exclude.some((exc) => matches(exc, perm))) continue;
    out.add(perm as Permission);
  }
  return out;
}

export function validateRules(rules: RoleRules): string[] {
  const errors: string[] = [];
  if (rules.include.length === 0) errors.push("A role needs at least one include pattern.");
  for (const p of [...rules.include, ...rules.exclude]) {
    const e = validatePattern(p);
    if (e) errors.push(e);
  }
  for (const p of rules.include) {
    if (validatePattern(p)) continue;
    const hitsAdmin = ADMIN_ONLY.some((a) => matches(p, a));
    const hitsGrantable = GRANTABLE.some((g) => matches(p, g));
    if (hitsAdmin && !hitsGrantable) errors.push(`“${p}” only matches Admin permissions, which can't be given to a role.`);
  }
  return errors;
}
```

- [ ] **Step 5: Run to see it pass**

Run: `pnpm test tests/unit/permissions` — Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(permissions): registry and CIPP-style rule expansion"
```

---

### Task 4: Audit log

**Files:**
- Create: `src/lib/audit/log.ts`, `src/lib/request.ts`, `tests/integration/audit.test.ts`

**Interfaces:**
- Consumes: `db`, `Tx`, `auditLog` (Task 2).
- Produces:
  - `type Actor = { door: "staff" | "parent" | "system"; id: string | null; label: string | null }`
  - `type AuditEntry = { actor: Actor; action: string; permission?: string; targetType?: string; targetId?: string; before?: unknown; after?: unknown; ip?: string | null }`
  - `writeAudit(entry: AuditEntry, tx?: Tx): Promise<void>`
  - `requestIp(): Promise<string | null>` (from `x-forwarded-for` first hop, else `x-real-ip`, validated as an IP)

- [ ] **Step 1: Failing test**

`tests/integration/audit.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { resetDb } from "../helpers/db";

describe("writeAudit", () => {
  beforeEach(resetDb);

  it("records who, what, which record, before/after, and IP", async () => {
    await writeAudit({
      actor: { door: "staff", id: "s1", label: "Pat (pat@club.org)" },
      action: "role.assign", permission: "Admin.Roles.ReadWrite",
      targetType: "staff_user", targetId: "s2", before: { roles: [] }, after: { roles: ["Treasurer"] }, ip: "203.0.113.9",
    });
    const [row] = await db.select().from(auditLog);
    expect(row).toMatchObject({
      door: "staff", actorId: "s1", action: "role.assign", targetId: "s2",
      before: { roles: [] }, after: { roles: ["Treasurer"] }, ip: "203.0.113.9",
    });
  });

  it("stores a malformed IP as null rather than failing the write", async () => {
    await writeAudit({ actor: { door: "system", id: null, label: null }, action: "x", ip: "not-an-ip" });
    const [row] = await db.select().from(auditLog);
    expect(row?.ip).toBeNull();
  });
});
```

- [ ] **Step 2: Run** — `pnpm test tests/integration/audit.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/lib/audit/log.ts`:

```ts
import { isIP } from "node:net";
import { db, type Tx } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";

export type Actor = { door: "staff" | "parent" | "system"; id: string | null; label: string | null };
export type AuditEntry = {
  actor: Actor; action: string; permission?: string; targetType?: string; targetId?: string;
  before?: unknown; after?: unknown; ip?: string | null;
};

export async function writeAudit(e: AuditEntry, tx?: Tx): Promise<void> {
  const ip = e.ip && isIP(e.ip) ? e.ip : null;
  await (tx ?? db).insert(auditLog).values({
    door: e.actor.door, actorId: e.actor.id, actorLabel: e.actor.label,
    action: e.action, permission: e.permission ?? null,
    targetType: e.targetType ?? null, targetId: e.targetId ?? null,
    before: (e.before ?? null) as never, after: (e.after ?? null) as never, ip,
  });
}
```

`src/lib/request.ts`:

```ts
import { headers } from "next/headers";
import { isIP } from "node:net";

export async function requestIp(): Promise<string | null> {
  const h = await headers();
  const first = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip")?.trim() ?? null;
  return first && isIP(first) ? first : null;
}
```

- [ ] **Step 4: Run** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(audit): append-only audit log writer"
```

---

### Task 5: Club colour derivation and club settings

**Files:**
- Create: `src/lib/theme/contrast.ts`, `src/lib/settings/club.ts`, `tests/unit/theme/contrast.test.ts`, `tests/integration/club-settings.test.ts`

**Interfaces:**
- Produces:
  - `normalizeHex(input: string): string | null` (`#rrggbb` lower-case, accepts `#rgb`/`rrggbb`; null if invalid)
  - `contrastRatio(a: string, b: string): number`
  - `type ClubTokens = { club; clubOn; textL; textD; textLhc; textDhc; tintL; tintD }` (all `#rrggbb`)
  - `deriveClubTokens(hex: string): ClubTokens` (throws `InvalidColourError` on bad input)
  - `clubCssVars(t: ClubTokens): Record<string, string>` → `--club`, `--club-on`, `--club-text-l`, `--club-text-d`, `--club-text-lhc`, `--club-text-dhc`, `--club-tint-l`, `--club-tint-d`
  - `type ClubSettings = { name: string; shortName: string; colour: string; treasurerEmail: string | null }`
  - `getClubSettings(): Promise<ClubSettings>`; `saveClubSettings(input, actor, ip): Promise<{ ok: true } | { ok: false; errors: string[] }>`

- [ ] **Step 1: Failing unit tests**

`tests/unit/theme/contrast.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { normalizeHex, contrastRatio, deriveClubTokens, clubCssVars } from "@/lib/theme/contrast";

const PAPER_L = "#ffffff", PAPER_D = "#16181c", PAPER_DHC = "#000000";

describe("normalizeHex", () => {
  it.each([["#5B2A86", "#5b2a86"], ["5b2a86", "#5b2a86"], ["#FFF", "#ffffff"], [" #abc ", "#aabbcc"]])("%j → %j", (i, o) => expect(normalizeHex(i)).toBe(o));
  it.each(["red", "#12", "#1234567", "#ggg000", "#000;}body{display:none", ""])("rejects %j", (i) => expect(normalizeHex(i)).toBeNull());
});

describe("contrastRatio", () => {
  it("is 21 for black on white and 1 for equal colours", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });
});

describe("deriveClubTokens", () => {
  it.each(["#5b2a86", "#f2c200", "#003366", "#e0f7fa", "#ff0000", "#000000", "#ffffff"])("holds every contrast floor for %s", (hex) => {
    const t = deriveClubTokens(hex);
    expect(t.club).toBe(hex);
    expect(contrastRatio(t.clubOn, t.club)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.textL, PAPER_L)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.textD, PAPER_D)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.textLhc, PAPER_L)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(t.textDhc, PAPER_DHC)).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(t.textL, t.tintL)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t.textD, t.tintD)).toBeGreaterThanOrEqual(4.5);
  });
  it("keeps a club colour that already passes on white (FZN purple)", () => {
    expect(deriveClubTokens("#5b2a86").textL).toBe("#5b2a86");
    expect(deriveClubTokens("#5b2a86").clubOn).toBe("#ffffff");
  });
  it("uses dark ink on a light club colour (gold)", () => {
    expect(deriveClubTokens("#f2c200").clubOn).toBe("#14161a");
  });
  it("throws on invalid input", () => {
    expect(() => deriveClubTokens("red")).toThrow(/colour/i);
  });
  it("produces CSS variables containing only hex values", () => {
    const vars = clubCssVars(deriveClubTokens("#f2c200"));
    expect(Object.keys(vars)).toEqual(["--club", "--club-on", "--club-text-l", "--club-text-d", "--club-text-lhc", "--club-text-dhc", "--club-tint-l", "--club-tint-d"]);
    for (const v of Object.values(vars)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  });
});
```

- [ ] **Step 2: Run** — `pnpm test tests/unit/theme` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement colour math**

`src/lib/theme/contrast.ts`:

```ts
export class InvalidColourError extends Error {}

const INK = "#14161a";
const WHITE = "#ffffff";
const PAPER_L = "#ffffff";
const PAPER_D = "#16181c";
const PAPER_DHC = "#000000";

export function normalizeHex(input: string): string | null {
  const s = input.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(s)) return `#${s.split("").map((c) => c + c).join("")}`;
  if (/^[0-9a-f]{6}$/.test(s)) return `#${s}`;
  return null;
}

type RGB = [number, number, number];
const toRgb = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
const toHex = (rgb: RGB) => `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;

function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

function rgbToHsl([r, g, b]: RGB): [number, number, number] {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]: [number, number, number]): RGB {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

/** Moves lightness (same hue and saturation) in `direction` until `ratio` is met against `ground`. */
function adjustUntil(hex: string, ground: string, ratio: number, direction: "darker" | "lighter"): string {
  if (contrastRatio(hex, ground) >= ratio) return hex;
  const [h, s, l0] = rgbToHsl(toRgb(hex));
  for (let i = 1; i <= 100; i++) {
    const l = direction === "darker" ? l0 * (1 - i / 100) : l0 + (1 - l0) * (i / 100);
    const candidate = toHex(hslToRgb([h, s, l]));
    if (contrastRatio(candidate, ground) >= ratio) return candidate;
  }
  return direction === "darker" ? "#000000" : "#ffffff";
}

function mix(a: string, b: string, weightA: number): string {
  const [ra, ga, ba] = toRgb(a), [rb, gb, bb] = toRgb(b);
  return toHex([ra * weightA + rb * (1 - weightA), ga * weightA + gb * (1 - weightA), ba * weightA + bb * (1 - weightA)]);
}

export type ClubTokens = {
  club: string; clubOn: string; textL: string; textD: string; textLhc: string; textDhc: string; tintL: string; tintD: string;
};

export function deriveClubTokens(input: string): ClubTokens {
  const club = normalizeHex(input);
  if (!club) throw new InvalidColourError(`“${input}” isn't a colour. Use a hex value like #5b2a86.`);
  const clubOn = contrastRatio(WHITE, club) >= contrastRatio(INK, club) ? WHITE : INK;
  const textL = adjustUntil(club, PAPER_L, 4.5, "darker");
  const textD = adjustUntil(club, PAPER_D, 4.5, "lighter");
  const textLhc = adjustUntil(club, PAPER_L, 7, "darker");
  const textDhc = adjustUntil(club, PAPER_DHC, 7, "lighter");
  const tintL = mix(club, PAPER_L, 0.08);
  const tintD = mix(club, PAPER_D, 0.14);
  return {
    club, clubOn,
    textL: adjustUntil(textL, tintL, 4.5, "darker"),
    textD: adjustUntil(textD, tintD, 4.5, "lighter"),
    textLhc, textDhc, tintL, tintD,
  };
}

export function clubCssVars(t: ClubTokens): Record<string, string> {
  return {
    "--club": t.club, "--club-on": t.clubOn,
    "--club-text-l": t.textL, "--club-text-d": t.textD,
    "--club-text-lhc": t.textLhc, "--club-text-dhc": t.textDhc,
    "--club-tint-l": t.tintL, "--club-tint-d": t.tintD,
  };
}
```

- [ ] **Step 4: Run** — `pnpm test tests/unit/theme` — Expected: PASS. If a case fails, the tint/text order is the cause: text is adjusted against both paper and tint; do not loosen the thresholds.

- [ ] **Step 5: Failing integration test for settings**

`tests/integration/club-settings.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { getClubSettings, saveClubSettings } from "@/lib/settings/club";
import { db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
import { resetDb } from "../helpers/db";

const actor = { door: "staff" as const, id: "s1", label: "Pat" };

describe("club settings", () => {
  beforeEach(resetDb);

  it("has neutral defaults before setup", async () => {
    expect(await getClubSettings()).toEqual({ name: "Boosters Rocket", shortName: "BR", colour: "#5b2a86", treasurerEmail: null });
  });

  it("saves, normalises the colour, and audits before/after", async () => {
    const r = await saveClubSettings({ name: " FZN Band Boosters ", shortName: "FZN", colour: "#F2C200", treasurerEmail: "treasurer@fznband.example" }, actor, null);
    expect(r).toEqual({ ok: true });
    expect(await getClubSettings()).toMatchObject({ name: "FZN Band Boosters", colour: "#f2c200" });
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "settings.club.save", permission: "Settings.Club.ReadWrite" });
  });

  it.each([
    [{ colour: "red" }, "Colour"],
    [{ colour: "#000;}body{display:none" }, "Colour"],
    [{ name: "" }, "Club name"],
    [{ shortName: "TOOLONG" }, "Short name"],
    [{ treasurerEmail: "nope" }, "Treasurer email"],
  ])("rejects %j", async (patch, field) => {
    const r = await saveClubSettings({ name: "Club", shortName: "CL", colour: "#5b2a86", treasurerEmail: null, ...patch }, actor, null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain(field);
  });
});
```

- [ ] **Step 6: Implement settings**

`src/lib/settings/club.ts`:

```ts
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";
import { normalizeHex } from "@/lib/theme/contrast";
import { writeAudit, type Actor } from "@/lib/audit/log";

export type ClubSettings = { name: string; shortName: string; colour: string; treasurerEmail: string | null };

const DEFAULTS: ClubSettings = { name: "Boosters Rocket", shortName: "BR", colour: "#5b2a86", treasurerEmail: null };
const KEY = "club";

const input = z.object({
  name: z.string().trim().min(1, "Club name is required.").max(60, "Club name is too long (60 characters at most)."),
  shortName: z.string().trim().min(1, "Short name is required.").max(4, "Short name must be 4 characters or fewer."),
  colour: z.string().transform((v, ctx) => {
    const hex = normalizeHex(v);
    if (!hex) { ctx.addIssue({ code: "custom", message: "Colour must be a hex value like #5b2a86." }); return z.NEVER; }
    return hex;
  }),
  treasurerEmail: z.string().trim().email("Treasurer email isn't a valid email address.").nullable()
    .or(z.literal("").transform(() => null)),
});

export async function getClubSettings(): Promise<ClubSettings> {
  const [row] = await db.select().from(setting).where(eq(setting.key, KEY));
  return row ? { ...DEFAULTS, ...(row.value as Partial<ClubSettings>) } : DEFAULTS;
}

export async function saveClubSettings(raw: unknown, actor: Actor, ip: string | null):
  Promise<{ ok: true } | { ok: false; errors: string[] }> {
  const parsed = input.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => i.message) };
  const before = await getClubSettings();
  await db.transaction(async (tx) => {
    await tx.insert(setting).values({ key: KEY, value: parsed.data })
      .onConflictDoUpdate({ target: setting.key, set: { value: parsed.data, updatedAt: new Date() } });
    await writeAudit({ actor, action: "settings.club.save", permission: "Settings.Club.ReadWrite",
      targetType: "setting", targetId: KEY, before, after: parsed.data, ip }, tx);
  });
  return { ok: true };
}
```

- [ ] **Step 7: Run** — `pnpm test` — Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(theme): derive club colours per mode; club settings with validation"
```

---

### Task 6: The two sign-in doors and identity resolution

**Files:**
- Create: `src/lib/auth/staff-auth.ts`, `src/lib/auth/parent-auth.ts`, `src/lib/auth/resolve.ts`, `src/lib/auth/identity.ts`, `src/app/api/auth/staff/[...all]/route.ts`, `src/app/api/auth/parent/[...all]/route.ts`, `src/lib/auth/client.ts`, `tests/integration/resolve.test.ts`

**Interfaces:**
- Consumes: `db`, schema auth tables, `staffUser`, `guardian`, `writeAudit`.
- Produces:
  - `staffAuth`, `parentAuth` (Better Auth instances; base paths `/api/auth/staff`, `/api/auth/parent`; cookie prefixes `br_staff`, `br_parent`)
  - `type StaffIdentity = { door: "staff"; staffUserId: string; name: string; email: string }`
  - `type ParentIdentity = { door: "parent"; guardianId: string; familyQboId: string; name: string }`
  - `resolveStaff(authUserId: string): Promise<StaffIdentity | null>` (binds on first sign-in; bootstrap hook from Task 7)
  - `resolveGuardian(authUserId: string): Promise<ParentIdentity | null>`
  - `getStaffIdentity(): Promise<StaffIdentity | null>`, `getParentIdentity(): Promise<ParentIdentity | null>` (read the request's session for that door only)
  - Client helpers `staffAuthClient`, `parentAuthClient`

- [ ] **Step 1: Install and check the Better Auth API**

```bash
pnpm add better-auth
```

Open the installed `node_modules/better-auth` README/docs and confirm these names exist in this version before writing code: `betterAuth`, `drizzleAdapter` from `better-auth/adapters/drizzle`, `genericOAuth` from `better-auth/plugins`, `toNextJsHandler` from `better-auth/next-js`, options `basePath`, `advanced.cookiePrefix`, `socialProviders.microsoft.tenantId`, `account.accountLinking.enabled`, `user.additionalFields`, generic OAuth `mapProfileToUser`, and `auth.api.getSession({ headers })`. Then run `pnpm dlx @better-auth/cli generate --config src/lib/auth/staff-auth.ts --output /tmp/staff-schema.ts` after Step 3 and diff its columns against `authTables()` in `schema.ts`; if the CLI's core columns differ, change `authTables()` to match the CLI and regenerate the migration (`pnpm db:generate`). Note any renamed option in the commit message.

- [ ] **Step 2: Failing resolution tests**

`tests/integration/resolve.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { staffAuthUser, staffAuthAccount, parentAuthUser, staffUser } from "@/lib/db/schema";
import { resolveStaff, resolveGuardian } from "@/lib/auth/resolve";
import { resetDb, seedStaff, seedGuardian } from "../helpers/db";
import { eq } from "drizzle-orm";

async function staffAuthRow(id: string, email: string, provider: "microsoft" | "google", verified = true) {
  await db.insert(staffAuthUser).values({ id, name: email, email, emailVerified: verified });
  await db.insert(staffAuthAccount).values({ id: `acc-${id}`, accountId: `sub-${id}`, providerId: provider, userId: id });
}

describe("resolveStaff", () => {
  beforeEach(resetDb);

  it("binds an invited staff user on first sign-in, matching email case- and space-insensitively", async () => {
    const s = await seedStaff({ email: "Pat@Club.org ", status: "invited" });
    await staffAuthRow("u1", "pat@club.org", "google");
    const id = await resolveStaff("u1");
    expect(id).toMatchObject({ door: "staff", staffUserId: s.id });
    const [row] = await db.select().from(staffUser).where(eq(staffUser.id, s.id));
    expect(row).toMatchObject({ authUserId: "u1", status: "active" });
  });

  it("refuses an unknown email", async () => {
    await staffAuthRow("u2", "stranger@example.com", "google");
    expect(await resolveStaff("u2")).toBeNull();
  });

  it("refuses an unverified Google email", async () => {
    await seedStaff({ email: "pat@club.org", status: "invited" });
    await staffAuthRow("u3", "pat@club.org", "google", false);
    expect(await resolveStaff("u3")).toBeNull();
  });

  it("refuses a disabled staff user on their next request", async () => {
    const s = await seedStaff({ email: "pat@club.org", status: "active" });
    await staffAuthRow("u4", "pat@club.org", "microsoft");
    expect(await resolveStaff("u4")).not.toBeNull();
    await db.update(staffUser).set({ status: "disabled" }).where(eq(staffUser.id, s.id));
    expect(await resolveStaff("u4")).toBeNull();
  });

  it("does not rebind a staff user already bound to another auth user", async () => {
    await seedStaff({ email: "pat@club.org", status: "invited" });
    await staffAuthRow("u5", "pat@club.org", "google");
    await resolveStaff("u5");
    await db.insert(staffAuthUser).values({ id: "u6", name: "x", email: "pat@club.org", emailVerified: true });
    await db.insert(staffAuthAccount).values({ id: "acc-u6", accountId: "sub-u6", providerId: "microsoft", userId: "u6" });
    expect(await resolveStaff("u6")).toBeNull();
  });
});

describe("resolveGuardian", () => {
  beforeEach(resetDb);

  it("resolves by the External ID object id and activates an invited guardian", async () => {
    const g = await seedGuardian({ name: "Ana Ramirez", familyQboId: "123", objectId: "oid-1", status: "invited" });
    await db.insert(parentAuthUser).values({ id: "p1", name: "Ana", email: "ana@example.com", emailVerified: true, objectId: "oid-1" });
    expect(await resolveGuardian("p1")).toMatchObject({ door: "parent", guardianId: g.id, familyQboId: "123" });
  });

  it("refuses a parent auth user with no matching guardian, or a disabled one", async () => {
    await db.insert(parentAuthUser).values({ id: "p2", name: "X", email: "x@example.com", emailVerified: true, objectId: "oid-unknown" });
    expect(await resolveGuardian("p2")).toBeNull();
    await seedGuardian({ name: "Leo Dad", familyQboId: "9", objectId: "oid-3", status: "disabled" });
    await db.insert(parentAuthUser).values({ id: "p3", name: "L", email: "l@example.com", emailVerified: true, objectId: "oid-3" });
    expect(await resolveGuardian("p3")).toBeNull();
  });

  it("never resolves a parent identity from an email match alone", async () => {
    await seedGuardian({ name: "Ana Ramirez", familyQboId: "123", objectId: "oid-1" });
    await db.insert(parentAuthUser).values({ id: "p4", name: "Ana", email: "ana.ramirez@example.com", emailVerified: true, objectId: null });
    expect(await resolveGuardian("p4")).toBeNull();
  });
});
```

- [ ] **Step 3: The two auth instances**

`src/lib/auth/staff-auth.ts`:

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/lib/db/client";
import { staffAuthUser, staffAuthSession, staffAuthAccount, staffAuthVerification } from "@/lib/db/schema";
import { env, staffEntraEnabled, staffGoogleEnabled } from "@/env";

export const staffAuth = betterAuth({
  appName: "Boosters Rocket staff",
  baseURL: env.APP_URL,
  basePath: "/api/auth/staff",
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user: staffAuthUser, session: staffAuthSession, account: staffAuthAccount, verification: staffAuthVerification },
  }),
  emailAndPassword: { enabled: false },
  account: { accountLinking: { enabled: false } },
  advanced: { cookiePrefix: "br_staff" },
  session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60 },
  socialProviders: {
    ...(staffEntraEnabled ? { microsoft: {
      clientId: env.STAFF_ENTRA_CLIENT_ID!, clientSecret: env.STAFF_ENTRA_CLIENT_SECRET!,
      tenantId: env.STAFF_ENTRA_TENANT_ID!, // single-tenant: only the club's own directory
    } } : {}),
    ...(staffGoogleEnabled ? { google: {
      clientId: env.STAFF_GOOGLE_CLIENT_ID!, clientSecret: env.STAFF_GOOGLE_CLIENT_SECRET!,
    } } : {}),
  },
});
```

`src/lib/auth/parent-auth.ts`:

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins";
import { db } from "@/lib/db/client";
import { parentAuthUser, parentAuthSession, parentAuthAccount, parentAuthVerification } from "@/lib/db/schema";
import { env, parentDoorEnabled } from "@/env";

export const PARENT_PROVIDER_ID = "parent-oidc";

export const parentAuth = betterAuth({
  appName: "Boosters Rocket",
  baseURL: env.APP_URL,
  basePath: "/api/auth/parent",
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user: parentAuthUser, session: parentAuthSession, account: parentAuthAccount, verification: parentAuthVerification },
  }),
  emailAndPassword: { enabled: false },
  account: { accountLinking: { enabled: false } },
  advanced: { cookiePrefix: "br_parent" },
  session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
  user: { additionalFields: { objectId: { type: "string", required: false, input: false } } },
  plugins: parentDoorEnabled ? [genericOAuth({
    config: [{
      providerId: PARENT_PROVIDER_ID,
      discoveryUrl: env.PARENT_OIDC_DISCOVERY_URL!,
      clientId: env.PARENT_OIDC_CLIENT_ID!,
      clientSecret: env.PARENT_OIDC_CLIENT_SECRET!,
      scopes: ["openid", "email", "profile"],
      pkce: true,
      // Entra External ID puts the directory object id in `oid`; that is what Graph provisioning records.
      mapProfileToUser: (profile: Record<string, unknown>) => ({
        objectId: typeof profile.oid === "string" ? profile.oid : null,
      }),
    }],
  })] : [],
});
```

Route handlers — `src/app/api/auth/staff/[...all]/route.ts`:

```ts
import { toNextJsHandler } from "better-auth/next-js";
import { staffAuth } from "@/lib/auth/staff-auth";
export const { GET, POST } = toNextJsHandler(staffAuth);
```

`src/app/api/auth/parent/[...all]/route.ts`:

```ts
import { toNextJsHandler } from "better-auth/next-js";
import { parentAuth } from "@/lib/auth/parent-auth";
export const { GET, POST } = toNextJsHandler(parentAuth);
```

`src/lib/auth/client.ts`:

```ts
"use client";
import { createAuthClient } from "better-auth/react";
import { genericOAuthClient } from "better-auth/client/plugins";

export const staffAuthClient = createAuthClient({ basePath: "/api/auth/staff" });
export const parentAuthClient = createAuthClient({ basePath: "/api/auth/parent", plugins: [genericOAuthClient()] });
```

- [ ] **Step 4: Resolution**

`src/lib/auth/resolve.ts`:

```ts
import { and, eq, isNull, inArray } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { staffUser, staffAuthUser, staffAuthAccount, guardian, parentAuthUser } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";

export type StaffIdentity = { door: "staff"; staffUserId: string; name: string; email: string };
export type ParentIdentity = { door: "parent"; guardianId: string; familyQboId: string; name: string };

/** Hook for the first-admin claim (Task 7). Returns a newly created admin staff user id, or null. */
export type BootstrapHook = (email: string) => Promise<string | null>;
let bootstrapHook: BootstrapHook = async () => null;
export function setBootstrapHook(h: BootstrapHook) { bootstrapHook = h; }

const norm = (e: string) => e.trim().toLowerCase();

export async function resolveStaff(authUserId: string): Promise<StaffIdentity | null> {
  const bound = await db.select().from(staffUser).where(eq(staffUser.authUserId, authUserId));
  if (bound[0]) return bound[0].status === "active" ? toStaff(bound[0]) : null;

  const [au] = await db.select().from(staffAuthUser).where(eq(staffAuthUser.id, authUserId));
  if (!au) return null;
  const accounts = await db.select().from(staffAuthAccount).where(eq(staffAuthAccount.userId, authUserId));
  // Microsoft is single-tenant (club directory), so its email is trusted; Google must say verified.
  const trusted = au.emailVerified || accounts.some((a) => a.providerId === "microsoft");
  if (!trusted) return null;
  const email = norm(au.email);

  const [invite] = await db.select().from(staffUser).where(and(
    eq(staffUser.email, email), isNull(staffUser.authUserId), inArray(staffUser.status, ["invited", "active"])));
  if (invite) {
    const [row] = await db.update(staffUser).set({ authUserId, status: "active", updatedAt: new Date() })
      .where(and(eq(staffUser.id, invite.id), isNull(staffUser.authUserId))).returning();
    return row ? toStaff(row) : null;
  }

  const createdId = await bootstrapHook(email);
  if (!createdId) {
    await writeAudit({ actor: { door: "staff", id: null, label: email }, action: "signin.refused", targetType: "staff_auth_user", targetId: authUserId });
    return null;
  }
  const [row] = await db.update(staffUser).set({ authUserId, updatedAt: new Date() })
    .where(eq(staffUser.id, createdId)).returning();
  return row ? toStaff(row) : null;
}

function toStaff(s: typeof staffUser.$inferSelect): StaffIdentity {
  return { door: "staff", staffUserId: s.id, name: s.name, email: s.email };
}

export async function resolveGuardian(authUserId: string): Promise<ParentIdentity | null> {
  const [au] = await db.select().from(parentAuthUser).where(eq(parentAuthUser.id, authUserId));
  if (!au) return null;
  const [g] = au.objectId ? await db.select().from(guardian).where(eq(guardian.identityObjectId, au.objectId)) : [];
  if (!g || g.status === "disabled") {
    await writeAudit({ actor: { door: "parent", id: null, label: au.email }, action: "signin.refused", targetType: "parent_auth_user", targetId: authUserId });
    return null;
  }
  if (g.status === "invited") await db.update(guardian).set({ status: "active", updatedAt: new Date() }).where(eq(guardian.id, g.id));
  return { door: "parent", guardianId: g.id, familyQboId: g.familyQboId, name: g.name };
}
```

- [ ] **Step 5: Request identity helpers**

`src/lib/auth/identity.ts`:

```ts
import "server-only";
import { headers } from "next/headers";
import { staffAuth } from "./staff-auth";
import { parentAuth } from "./parent-auth";
import { resolveStaff, resolveGuardian, type StaffIdentity, type ParentIdentity } from "./resolve";

export async function getStaffIdentity(): Promise<StaffIdentity | null> {
  const session = await staffAuth.api.getSession({ headers: await headers() });
  return session ? resolveStaff(session.user.id) : null;
}

export async function getParentIdentity(): Promise<ParentIdentity | null> {
  const session = await parentAuth.api.getSession({ headers: await headers() });
  return session ? resolveGuardian(session.user.id) : null;
}

/** True when the browser holds a session for that door, even if the identity behind it is refused. */
export async function hasStaffSession(): Promise<boolean> {
  return Boolean(await staffAuth.api.getSession({ headers: await headers() }));
}
export async function hasParentSession(): Promise<boolean> {
  return Boolean(await parentAuth.api.getSession({ headers: await headers() }));
}
```

Also add to the `resolve.test.ts` file a check that refusals are audited:

```ts
import { auditLog } from "@/lib/db/schema";

it("audits a refused staff sign-in", async () => {
  await resetDb();
  await staffAuthRow("u9", "stranger@example.com", "google");
  await resolveStaff("u9");
  expect((await db.select().from(auditLog)).map((a) => a.action)).toContain("signin.refused");
});
```

Run: `pnpm add server-only`.

- [ ] **Step 6: Run** — `pnpm test tests/integration/resolve.test.ts` — Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(auth): separate staff and parent doors with identity resolution"
```

---

### Task 7: First-admin bootstrap and last-admin protection

**Files:**
- Create: `src/lib/auth/bootstrap.ts`, `src/lib/auth/init.ts`, `tests/integration/bootstrap.test.ts`
- Modify: `src/lib/auth/identity.ts` (import `./init` once)

**Interfaces:**
- Consumes: `setBootstrapHook` (Task 6), `adminRoleId` logic, `writeAudit`.
- Produces: `claimBootstrapAdmin(email: string): Promise<string | null>`; `adminCount(tx?): Promise<number>`.

- [ ] **Step 1: Failing tests**

`tests/integration/bootstrap.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { claimBootstrapAdmin } from "@/lib/auth/bootstrap";
import { db } from "@/lib/db/client";
import { roleAssignment, auditLog } from "@/lib/db/schema";
import { resetDb, seedStaff } from "../helpers/db";

vi.mock("@/env", async (orig) => {
  const real = await orig<typeof import("@/env")>();
  return { ...real, env: { ...real.env, BOOTSTRAP_ADMIN_EMAIL: "First.Admin@Club.org" } };
});

describe("claimBootstrapAdmin", () => {
  beforeEach(resetDb);

  it("makes the matching first sign-in Admin and audits it", async () => {
    const id = await claimBootstrapAdmin("first.admin@club.org");
    expect(id).not.toBeNull();
    expect(await db.select().from(roleAssignment)).toHaveLength(1);
    expect((await db.select().from(auditLog))[0]).toMatchObject({ action: "admin.bootstrap", door: "system" });
  });

  it("refuses any other email", async () => {
    expect(await claimBootstrapAdmin("someone@club.org")).toBeNull();
  });

  it("is ignored once an admin exists", async () => {
    await seedStaff({ email: "existing@club.org", admin: true });
    expect(await claimBootstrapAdmin("first.admin@club.org")).toBeNull();
  });

  it("lets exactly one of two racing sign-ins win", async () => {
    const results = await Promise.all([claimBootstrapAdmin("first.admin@club.org"), claimBootstrapAdmin("first.admin@club.org")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.select().from(roleAssignment)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run** — Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/lib/auth/bootstrap.ts`:

```ts
import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { role, roleAssignment, staffUser } from "@/lib/db/schema";
import { env } from "@/env";
import { writeAudit } from "@/lib/audit/log";

export async function adminCount(tx?: Tx): Promise<number> {
  const rows = await (tx ?? db).execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM role_assignment ra
    JOIN role r ON r.id = ra.role_id JOIN staff_user s ON s.id = ra.staff_user_id
    WHERE r.key = 'admin' AND s.status <> 'disabled'`);
  return Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
}

/** Creates the first Admin if none exists and `email` matches BOOTSTRAP_ADMIN_EMAIL. Returns the staff user id. */
export async function claimBootstrapAdmin(email: string): Promise<string | null> {
  const wanted = env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const got = email.trim().toLowerCase();
  if (!wanted || wanted !== got) return null;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('booster.bootstrap_admin'))`);
    if ((await adminCount(tx)) > 0) return null;
    const [adminRole] = await tx.select().from(role).where(eq(role.key, "admin"));
    if (!adminRole) throw new Error("Admin role missing");
    const [s] = await tx.insert(staffUser).values({ email: got, name: got, status: "active" })
      .onConflictDoUpdate({ target: staffUser.email, set: { status: "active", updatedAt: new Date() } }).returning();
    await tx.insert(roleAssignment).values({ roleId: adminRole.id, staffUserId: s!.id }).onConflictDoNothing();
    await writeAudit({ actor: { door: "system", id: null, label: "bootstrap" }, action: "admin.bootstrap",
      targetType: "staff_user", targetId: s!.id, after: { email: got, role: "Admin" } }, tx);
    return s!.id;
  });
}
```

`src/lib/auth/init.ts`:

```ts
import { setBootstrapHook } from "./resolve";
import { claimBootstrapAdmin } from "./bootstrap";

setBootstrapHook(claimBootstrapAdmin);
```

Add `import "./init";` as the first import in `src/lib/auth/identity.ts`.

- [ ] **Step 4: Run** — `pnpm test` — Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(auth): first-admin bootstrap guarded by an advisory lock"
```

---

### Task 8: Guards, effective permissions and the declared-permission invariant

**Files:**
- Create: `src/lib/permissions/effective.ts`, `src/lib/guards.ts`, `tests/integration/effective.test.ts`, `tests/unit/guards.test.ts`, `tests/integration/invariants.test.ts`

**Interfaces:**
- Consumes: `getStaffIdentity`, `getParentIdentity`, `expandRules`, `PERMISSIONS`, `writeAudit`, `requestIp`.
- Produces:
  - `type Effective = { isAdmin: boolean; permissions: Set<Permission> }`
  - `effectivePermissions(staffUserId: string): Promise<Effective>`; `can(e: Effective, p: Permission): boolean`
  - `class AccessDenied extends Error`
  - `type StaffCtx = StaffIdentity & { effective: Effective; ip: string | null }`; `type ParentCtx = ParentIdentity & { ip: string | null }`
  - `staffAction<A extends unknown[], R>(permission: Permission, fn: (ctx: StaffCtx, ...args: A) => Promise<R>): (...args: A) => Promise<R>`
  - `parentAction<A extends unknown[], R>(fn: (ctx: ParentCtx, ...args: A) => Promise<R>): (...args: A) => Promise<R>`
  - `requireStaffPage(permission?: Permission): Promise<StaffCtx>` (redirects to `/staff/sign-in` or `/refused`)
  - `requireParentPage(): Promise<ParentCtx>` (redirects to `/sign-in` or `/refused`)
  - `guardOf(fn: unknown): { door: "staff" | "parent"; permission?: Permission } | undefined`

- [ ] **Step 1: Failing test for effective permissions**

`tests/integration/effective.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { role, roleRule, roleAssignment } from "@/lib/db/schema";
import { effectivePermissions, can } from "@/lib/permissions/effective";
import { PERMISSIONS } from "@/lib/permissions/registry";
import { resetDb, seedStaff } from "../helpers/db";

describe("effectivePermissions", () => {
  beforeEach(resetDb);

  it("gives Admin every permission, including admin-only", async () => {
    const s = await seedStaff({ email: "a@club.org", admin: true });
    const e = await effectivePermissions(s.id);
    expect(e.isAdmin).toBe(true);
    for (const p of PERMISSIONS) expect(can(e, p)).toBe(true);
  });

  it("unions custom roles and never grants admin-only", async () => {
    const s = await seedStaff({ email: "v@club.org" });
    const [r1] = await db.insert(role).values({ key: "people", name: "People" }).returning();
    const [r2] = await db.insert(role).values({ key: "audit", name: "Audit" }).returning();
    await db.insert(roleRule).values([
      { roleId: r1!.id, kind: "include", pattern: "Staff.*" },
      { roleId: r2!.id, kind: "include", pattern: "*" },
      { roleId: r2!.id, kind: "exclude", pattern: "Staff.*" },
    ]);
    await db.insert(roleAssignment).values([{ roleId: r1!.id, staffUserId: s.id }, { roleId: r2!.id, staffUserId: s.id }]);
    const e = await effectivePermissions(s.id);
    expect(can(e, "Staff.Users.ReadWrite")).toBe(true);
    expect(can(e, "Audit.Log.Read")).toBe(true);
    expect(can(e, "Admin.Roles.ReadWrite")).toBe(false);
  });

  it("gives a staff user with no roles nothing", async () => {
    const s = await seedStaff({ email: "n@club.org" });
    expect((await effectivePermissions(s.id)).permissions.size).toBe(0);
  });
});
```

- [ ] **Step 2: Implement `effective.ts`**

```ts
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { role, roleRule, roleAssignment } from "@/lib/db/schema";
import { expandRules } from "./rules";
import { PERMISSIONS, type Permission } from "./registry";

export type Effective = { isAdmin: boolean; permissions: Set<Permission> };

export async function effectivePermissions(staffUserId: string): Promise<Effective> {
  const rows = await db.select({ roleId: role.id, key: role.key, kind: roleRule.kind, pattern: roleRule.pattern })
    .from(roleAssignment)
    .innerJoin(role, eq(role.id, roleAssignment.roleId))
    .leftJoin(roleRule, eq(roleRule.roleId, role.id))
    .where(eq(roleAssignment.staffUserId, staffUserId));
  if (rows.some((r) => r.key === "admin")) return { isAdmin: true, permissions: new Set(PERMISSIONS) };
  const byRole = new Map<string, { include: string[]; exclude: string[] }>();
  for (const r of rows) {
    const rules = byRole.get(r.roleId) ?? { include: [], exclude: [] };
    if (r.kind && r.pattern) rules[r.kind].push(r.pattern);
    byRole.set(r.roleId, rules);
  }
  const permissions = new Set<Permission>();
  for (const rules of byRole.values()) for (const p of expandRules(rules)) permissions.add(p);
  return { isAdmin: false, permissions };
}

export function can(e: Effective, p: Permission): boolean {
  return e.isAdmin || e.permissions.has(p);
}
```

- [ ] **Step 3: Failing guard tests (identity mocked)**

`tests/unit/guards.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const ident = vi.hoisted(() => ({ staff: null as unknown, parent: null as unknown, perms: new Set<string>(), admin: false }));
vi.mock("@/lib/auth/identity", () => ({
  getStaffIdentity: async () => ident.staff,
  getParentIdentity: async () => ident.parent,
  hasStaffSession: async () => Boolean(ident.staff),
  hasParentSession: async () => Boolean(ident.parent),
}));
vi.mock("@/lib/permissions/effective", () => ({
  effectivePermissions: async () => ({ isAdmin: ident.admin, permissions: ident.perms }),
  can: (e: { isAdmin: boolean; permissions: Set<string> }, p: string) => e.isAdmin || e.permissions.has(p),
}));
vi.mock("@/lib/request", () => ({ requestIp: async () => "203.0.113.1" }));
vi.mock("@/lib/audit/log", () => ({ writeAudit: vi.fn(async () => undefined) }));

import { staffAction, parentAction, guardOf, AccessDenied } from "@/lib/guards";

const STAFF = { door: "staff", staffUserId: "s1", name: "Pat", email: "pat@club.org" };
const PARENT = { door: "parent", guardianId: "g1", familyQboId: "123", name: "Ana" };

beforeEach(() => { ident.staff = null; ident.parent = null; ident.perms = new Set(); ident.admin = false; });

describe("staffAction", () => {
  const act = staffAction("Settings.Club.ReadWrite", async (ctx, x: number) => `${ctx.staffUserId}:${x}`);

  it("runs with the permission", async () => {
    ident.staff = STAFF; ident.perms = new Set(["Settings.Club.ReadWrite"]);
    await expect(act(2)).resolves.toBe("s1:2");
  });
  it("refuses without the permission", async () => {
    ident.staff = STAFF;
    await expect(act(2)).rejects.toBeInstanceOf(AccessDenied);
  });
  it("refuses a parent session even if one exists", async () => {
    ident.parent = PARENT;
    await expect(act(2)).rejects.toBeInstanceOf(AccessDenied);
  });
  it("records its declared permission", () => {
    expect(guardOf(act)).toEqual({ door: "staff", permission: "Settings.Club.ReadWrite" });
  });
});

describe("parentAction", () => {
  const act = parentAction(async (ctx) => ctx.familyQboId);

  it("runs for a parent and scopes to their family", async () => {
    ident.parent = PARENT;
    await expect(act()).resolves.toBe("123");
  });
  it("refuses a staff session, even an admin's", async () => {
    ident.staff = STAFF; ident.admin = true;
    await expect(act()).rejects.toBeInstanceOf(AccessDenied);
  });
});
```

- [ ] **Step 4: Implement `guards.ts`**

```ts
import "server-only";
import { redirect } from "next/navigation";
import { getStaffIdentity, getParentIdentity, hasStaffSession, hasParentSession } from "@/lib/auth/identity";
import type { StaffIdentity, ParentIdentity } from "@/lib/auth/resolve";
import { effectivePermissions, can, type Effective } from "@/lib/permissions/effective";
import type { Permission } from "@/lib/permissions/registry";
import { requestIp } from "@/lib/request";
import { writeAudit } from "@/lib/audit/log";

export class AccessDenied extends Error {
  constructor() { super("Not allowed"); } // same message whatever the reason (spec §5.1)
}

export type StaffCtx = StaffIdentity & { effective: Effective; ip: string | null };
export type ParentCtx = ParentIdentity & { ip: string | null };

type GuardInfo = { door: "staff" | "parent"; permission?: Permission };
const registry = new WeakMap<object, GuardInfo>();
export function guardOf(fn: unknown): GuardInfo | undefined {
  return typeof fn === "function" ? registry.get(fn) : undefined;
}

async function staffCtx(permission?: Permission): Promise<StaffCtx | null> {
  const id = await getStaffIdentity();
  if (!id) return null;
  const effective = await effectivePermissions(id.staffUserId);
  if (permission && !can(effective, permission)) {
    await writeAudit({ actor: { door: "staff", id: id.staffUserId, label: id.email }, action: "access.refused", permission, ip: await requestIp() });
    return null;
  }
  return { ...id, effective, ip: await requestIp() };
}

async function parentCtx(): Promise<ParentCtx | null> {
  const id = await getParentIdentity();
  return id ? { ...id, ip: await requestIp() } : null;
}

export function staffAction<A extends unknown[], R>(permission: Permission, fn: (ctx: StaffCtx, ...args: A) => Promise<R>) {
  const wrapped = async (...args: A): Promise<R> => {
    const ctx = await staffCtx(permission);
    if (!ctx) throw new AccessDenied();
    return fn(ctx, ...args);
  };
  registry.set(wrapped, { door: "staff", permission });
  return wrapped;
}

export function parentAction<A extends unknown[], R>(fn: (ctx: ParentCtx, ...args: A) => Promise<R>) {
  const wrapped = async (...args: A): Promise<R> => {
    const ctx = await parentCtx();
    if (!ctx) throw new AccessDenied();
    return fn(ctx, ...args);
  };
  registry.set(wrapped, { door: "parent" });
  return wrapped;
}

export async function requireStaffPage(permission?: Permission): Promise<StaffCtx> {
  const ctx = await staffCtx(permission);
  if (ctx) return ctx;
  // Signed in but refused (unknown, disabled, or missing permission) → the one generic refusal page.
  redirect((await hasStaffSession()) ? "/refused" : "/staff/sign-in");
}

export async function requireParentPage(): Promise<ParentCtx> {
  const ctx = await parentCtx();
  if (ctx) return ctx;
  redirect((await hasParentSession()) ? "/refused" : "/sign-in");
}
```

- [ ] **Step 5: The declared-permission invariant**

`tests/integration/invariants.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { globSync } from "node:fs";
import path from "node:path";

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("server-only", () => ({}));

import { guardOf } from "@/lib/guards";

const root = path.resolve(__dirname, "../..");
const staffModules = globSync("src/app/staff/**/actions.ts", { cwd: root });
const parentModules = globSync("src/app/(parent)/**/actions.ts", { cwd: root });

describe("every server action is guarded (spec §7, §12)", () => {
  it("finds the action modules", () => {
    expect(staffModules.length).toBeGreaterThan(0);
  });

  it.each(staffModules)("%s exports only staffAction-wrapped functions with a permission", async (file) => {
    const mod = await import(path.join(root, file));
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== "function") continue;
      const g = guardOf(value);
      expect(g, `${file} → ${name} is not wrapped in staffAction`).toBeDefined();
      expect(g?.door, `${file} → ${name}`).toBe("staff");
      expect(g?.permission, `${file} → ${name} declares no permission`).toBeTruthy();
    }
  });

  it.each(parentModules.length ? parentModules : ["(none yet)"])("%s exports only parentAction-wrapped functions", async (file) => {
    if (file === "(none yet)") return;
    const mod = await import(path.join(root, file));
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== "function") continue;
      expect(guardOf(value)?.door, `${file} → ${name}`).toBe("parent");
    }
  });
});
```

(This test needs at least one staff `actions.ts`, so it stays red until Task 9 adds them. That is expected.)

- [ ] **Step 6: Run** — `pnpm test tests/unit/guards.test.ts tests/integration/effective.test.ts` — Expected: PASS. (`invariants.test.ts` fails with "finds the action modules" until Task 9 — expected.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(guards): staff/parent action guards, effective permissions, invariant test"
```

---

### Task 9: Roles and staff-user services and screens

**Files:**
- Create: `src/lib/staff/roles.ts`, `tests/integration/roles.test.ts`, `src/app/staff/(app)/roles/page.tsx`, `src/app/staff/(app)/roles/actions.ts`, `src/app/staff/(app)/people/page.tsx`, `src/app/staff/(app)/people/actions.ts`, `src/app/staff/(app)/settings/club/page.tsx`, `src/app/staff/(app)/settings/club/actions.ts`, `src/app/staff/(app)/audit/page.tsx`

**Interfaces:**
- Consumes: `validateRules`, `adminCount`, `writeAudit`, `staffAction`, `requireStaffPage`, `saveClubSettings`, `getClubSettings`.
- Produces (services; every function takes `actor: Actor` and `ip: string | null` last):
  - `listRoles(): Promise<{ id; key; name; builtin; include: string[]; exclude: string[]; members: number }[]>`
  - `saveRole(input: { id?: string; name: string; include: string[]; exclude: string[] }, actor, ip): Promise<{ ok: true; id: string } | { ok: false; errors: string[] }>`
  - `deleteRole(id: string, actor, ip): Promise<{ ok: boolean; error?: string }>`
  - `assignRole(roleId: string, staffUserId: string, actor, ip)`, `unassignRole(roleId: string, staffUserId: string, actor, ip): Promise<{ ok: boolean; error?: string }>`
  - `listStaff(): Promise<{ id; name; email; status; roles: string[] }[]>`
  - `inviteStaff(input: { name: string; email: string }, actor, ip): Promise<{ ok: true; id: string } | { ok: false; errors: string[] }>`
  - `setStaffStatus(id: string, status: "active" | "disabled", actor, ip): Promise<{ ok: boolean; error?: string }>`

- [ ] **Step 1: Failing service tests**

`tests/integration/roles.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { saveRole, deleteRole, assignRole, unassignRole, listRoles, inviteStaff, setStaffStatus } from "@/lib/staff/roles";
import { resetDb, seedStaff, adminRoleId } from "../helpers/db";
import { db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";

const actor = { door: "staff" as const, id: "a1", label: "Admin" };

describe("roles", () => {
  beforeEach(resetDb);

  it("saves a valid role and audits it", async () => {
    const r = await saveRole({ name: "Roster volunteer", include: ["Staff.*"], exclude: [] }, actor, null);
    expect(r.ok).toBe(true);
    expect((await listRoles()).map((x) => x.name)).toContain("Roster volunteer");
    expect((await db.select().from(auditLog)).map((a) => a.action)).toContain("role.save");
  });

  it("rejects bad patterns with plain messages", async () => {
    const r = await saveRole({ name: "Bad", include: ["Roster..Read"], exclude: [] }, actor, null);
    expect(r.ok).toBe(false);
  });

  it("refuses to edit, delete or rename the built-in Admin role", async () => {
    const id = await adminRoleId();
    expect((await saveRole({ id, name: "Boss", include: ["*"], exclude: [] }, actor, null)).ok).toBe(false);
    expect((await deleteRole(id, actor, null)).ok).toBe(false);
  });

  it("refuses to remove the last active admin", async () => {
    const a = await seedStaff({ email: "only@club.org", admin: true });
    const r = await unassignRole(await adminRoleId(), a.id, actor, null);
    expect(r).toEqual({ ok: false, error: "There must always be at least one admin." });
  });

  it("allows removing an admin when another remains", async () => {
    const a = await seedStaff({ email: "a@club.org", admin: true });
    await seedStaff({ email: "b@club.org", admin: true });
    expect((await unassignRole(await adminRoleId(), a.id, actor, null)).ok).toBe(true);
  });

  it("refuses to disable the last active admin", async () => {
    const a = await seedStaff({ email: "only@club.org", admin: true });
    expect((await setStaffStatus(a.id, "disabled", actor, null)).ok).toBe(false);
  });
});

describe("staff invites", () => {
  beforeEach(resetDb);

  it("normalises email and refuses duplicates", async () => {
    expect((await inviteStaff({ name: "Pat", email: " Pat@Club.org" }, actor, null)).ok).toBe(true);
    const dup = await inviteStaff({ name: "Pat 2", email: "pat@club.org" }, actor, null);
    expect(dup).toEqual({ ok: false, errors: ["Someone with that email is already on the staff list."] });
  });
});
```

- [ ] **Step 2: Implement `src/lib/staff/roles.ts`**

```ts
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db/client";
import { role, roleRule, roleAssignment, staffUser } from "@/lib/db/schema";
import { validateRules } from "@/lib/permissions/rules";
import { adminCount } from "@/lib/auth/bootstrap";
import { writeAudit, type Actor } from "@/lib/audit/log";

const PERM = "Admin.Roles.ReadWrite";
const LAST_ADMIN = "There must always be at least one admin.";

export async function listRoles() {
  const roles = await db.select().from(role).orderBy(sql`${role.builtin} DESC, ${role.name}`);
  const rules = await db.select().from(roleRule);
  const counts = await db.select({ roleId: roleAssignment.roleId, n: sql<number>`count(*)::int` }).from(roleAssignment).groupBy(roleAssignment.roleId);
  return roles.map((r) => ({
    id: r.id, key: r.key, name: r.name, builtin: r.builtin,
    include: rules.filter((x) => x.roleId === r.id && x.kind === "include").map((x) => x.pattern),
    exclude: rules.filter((x) => x.roleId === r.id && x.kind === "exclude").map((x) => x.pattern),
    members: counts.find((c) => c.roleId === r.id)?.n ?? 0,
  }));
}

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "role";

export async function saveRole(input: { id?: string; name: string; include: string[]; exclude: string[] }, actor: Actor, ip: string | null):
  Promise<{ ok: true; id: string } | { ok: false; errors: string[] }> {
  const name = input.name.trim();
  const errors = [...(name ? [] : ["A role needs a name."]), ...validateRules({ include: input.include, exclude: input.exclude })];
  if (input.id) {
    const [existing] = await db.select().from(role).where(eq(role.id, input.id));
    if (!existing) errors.push("That role no longer exists.");
    else if (existing.builtin) errors.push("The Admin role can't be changed.");
  }
  if (errors.length) return { ok: false, errors };

  const before = input.id ? (await listRoles()).find((r) => r.id === input.id) ?? null : null;
  const id = await db.transaction(async (tx) => {
    const [r] = input.id
      ? await tx.update(role).set({ name, updatedAt: new Date() }).where(eq(role.id, input.id)).returning()
      : await tx.insert(role).values({ name, key: `${slug(name)}-${crypto.randomUUID().slice(0, 6)}` }).returning();
    await tx.delete(roleRule).where(eq(roleRule.roleId, r!.id));
    const rows = [
      ...input.include.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })),
      ...input.exclude.map((pattern) => ({ roleId: r!.id, kind: "exclude" as const, pattern })),
    ];
    if (rows.length) await tx.insert(roleRule).values(rows);
    await writeAudit({ actor, action: "role.save", permission: PERM, targetType: "role", targetId: r!.id,
      before, after: { name, include: input.include, exclude: input.exclude }, ip }, tx);
    return r!.id;
  });
  return { ok: true, id };
}

export async function deleteRole(id: string, actor: Actor, ip: string | null) {
  const [r] = await db.select().from(role).where(eq(role.id, id));
  if (!r) return { ok: false, error: "That role no longer exists." };
  if (r.builtin) return { ok: false, error: "The Admin role can't be deleted." };
  await db.transaction(async (tx) => {
    await tx.delete(role).where(eq(role.id, id));
    await writeAudit({ actor, action: "role.delete", permission: PERM, targetType: "role", targetId: id, before: { name: r.name }, ip }, tx);
  });
  return { ok: true };
}

export async function assignRole(roleId: string, staffUserId: string, actor: Actor, ip: string | null) {
  await db.transaction(async (tx) => {
    await tx.insert(roleAssignment).values({ roleId, staffUserId }).onConflictDoNothing();
    await writeAudit({ actor, action: "role.assign", permission: PERM, targetType: "staff_user", targetId: staffUserId, after: { roleId }, ip }, tx);
  });
  return { ok: true };
}

export async function unassignRole(roleId: string, staffUserId: string, actor: Actor, ip: string | null) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('booster.admins'))`);
    const [r] = await tx.select().from(role).where(eq(role.id, roleId));
    if (r?.key === "admin" && (await adminCount(tx)) <= 1) return { ok: false, error: LAST_ADMIN };
    await tx.delete(roleAssignment).where(and(eq(roleAssignment.roleId, roleId), eq(roleAssignment.staffUserId, staffUserId)));
    await writeAudit({ actor, action: "role.unassign", permission: PERM, targetType: "staff_user", targetId: staffUserId, before: { roleId }, ip }, tx);
    return { ok: true };
  });
}

export async function listStaff() {
  const people = await db.select().from(staffUser).orderBy(staffUser.name);
  const links = await db.select({ staffUserId: roleAssignment.staffUserId, name: role.name })
    .from(roleAssignment).innerJoin(role, eq(role.id, roleAssignment.roleId));
  return people.map((p) => ({ id: p.id, name: p.name, email: p.email, status: p.status,
    roles: links.filter((l) => l.staffUserId === p.id).map((l) => l.name) }));
}

const inviteInput = z.object({
  name: z.string().trim().min(1, "Enter their name."),
  email: z.string().trim().toLowerCase().email("That email doesn't look right."),
});

export async function inviteStaff(raw: { name: string; email: string }, actor: Actor, ip: string | null):
  Promise<{ ok: true; id: string } | { ok: false; errors: string[] }> {
  const p = inviteInput.safeParse(raw);
  if (!p.success) return { ok: false, errors: p.error.issues.map((i) => i.message) };
  const [exists] = await db.select().from(staffUser).where(eq(staffUser.email, p.data.email));
  if (exists) return { ok: false, errors: ["Someone with that email is already on the staff list."] };
  const [s] = await db.insert(staffUser).values({ ...p.data, status: "invited" }).returning();
  await writeAudit({ actor, action: "staff.invite", permission: "Staff.Users.ReadWrite", targetType: "staff_user", targetId: s!.id, after: p.data, ip });
  return { ok: true, id: s!.id };
}

export async function setStaffStatus(id: string, status: "active" | "disabled", actor: Actor, ip: string | null) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('booster.admins'))`);
    const [s] = await tx.select().from(staffUser).where(eq(staffUser.id, id));
    if (!s) return { ok: false, error: "That person is no longer on the staff list." };
    if (status === "disabled") {
      const isAdmin = (await tx.execute(sql`SELECT 1 FROM role_assignment ra JOIN role r ON r.id = ra.role_id WHERE r.key='admin' AND ra.staff_user_id=${id}`)).length > 0;
      if (isAdmin && (await adminCount(tx)) <= 1) return { ok: false, error: LAST_ADMIN };
    }
    await tx.update(staffUser).set({ status, updatedAt: new Date() }).where(eq(staffUser.id, id));
    await writeAudit({ actor, action: "staff.status", permission: "Staff.Users.ReadWrite", targetType: "staff_user", targetId: id,
      before: { status: s.status }, after: { status }, ip }, tx);
    return { ok: true };
  });
}
```

- [ ] **Step 3: Run** — `pnpm test tests/integration/roles.test.ts` — Expected: PASS.

- [ ] **Step 4: Server actions (each wrapped and declaring a permission)**

`src/app/staff/(app)/roles/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { saveRole, deleteRole, assignRole, unassignRole } from "@/lib/staff/roles";

const actor = (c: { staffUserId: string; email: string }) => ({ door: "staff" as const, id: c.staffUserId, label: c.email });
const lines = (v: FormDataEntryValue | null) => String(v ?? "").split("\n").map((s) => s.trim()).filter(Boolean);

export const saveRoleAction = staffAction("Admin.Roles.ReadWrite", async (ctx, form: FormData) => {
  const r = await saveRole({ id: String(form.get("id") ?? "") || undefined, name: String(form.get("name") ?? ""),
    include: lines(form.get("include")), exclude: lines(form.get("exclude")) }, actor(ctx), ctx.ip);
  revalidatePath("/staff/roles");
  return r;
});

export const deleteRoleAction = staffAction("Admin.Roles.ReadWrite", async (ctx, id: string) => {
  const r = await deleteRole(id, actor(ctx), ctx.ip); revalidatePath("/staff/roles"); return r;
});

export const assignRoleAction = staffAction("Admin.Roles.ReadWrite", async (ctx, roleId: string, staffUserId: string) => {
  const r = await assignRole(roleId, staffUserId, actor(ctx), ctx.ip); revalidatePath("/staff/people"); return r;
});

export const unassignRoleAction = staffAction("Admin.Roles.ReadWrite", async (ctx, roleId: string, staffUserId: string) => {
  const r = await unassignRole(roleId, staffUserId, actor(ctx), ctx.ip); revalidatePath("/staff/people"); return r;
});
```

`src/app/staff/(app)/people/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { inviteStaff, setStaffStatus } from "@/lib/staff/roles";

const actor = (c: { staffUserId: string; email: string }) => ({ door: "staff" as const, id: c.staffUserId, label: c.email });

export const inviteStaffAction = staffAction("Staff.Users.ReadWrite", async (ctx, form: FormData) => {
  const r = await inviteStaff({ name: String(form.get("name") ?? ""), email: String(form.get("email") ?? "") }, actor(ctx), ctx.ip);
  revalidatePath("/staff/people");
  return r;
});

export const setStaffStatusAction = staffAction("Staff.Users.ReadWrite", async (ctx, id: string, status: "active" | "disabled") => {
  const r = await setStaffStatus(id, status, actor(ctx), ctx.ip); revalidatePath("/staff/people"); return r;
});
```

`src/app/staff/(app)/settings/club/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { saveClubSettings } from "@/lib/settings/club";

export const saveClubAction = staffAction("Settings.Club.ReadWrite", async (ctx, form: FormData) => {
  const r = await saveClubSettings({
    name: String(form.get("name") ?? ""), shortName: String(form.get("shortName") ?? ""),
    colour: String(form.get("colour") ?? ""), treasurerEmail: String(form.get("treasurerEmail") ?? ""),
  }, { door: "staff", id: ctx.staffUserId, label: ctx.email }, ctx.ip);
  revalidatePath("/", "layout");
  return r;
});
```

- [ ] **Step 5: Pages**

Pages use the shell from Task 10's components (`Box`); write them now with plain markup and classes from `booster.css`. Each page calls `requireStaffPage(<Read permission>)` first.

`src/app/staff/(app)/roles/page.tsx`:

```tsx
import { requireStaffPage } from "@/lib/guards";
import { listRoles } from "@/lib/staff/roles";
import { GRANTABLE } from "@/lib/permissions/registry";
import { RoleForm } from "./role-form";

export default async function RolesPage() {
  await requireStaffPage("Admin.Roles.ReadWrite");
  const roles = await listRoles();
  return (
    <main className="wrap single">
      <h1 className="page-title">Roles</h1>
      <p className="lede">A role is a list of permissions to include and exclude. Exclude always wins. Admin always has everything.</p>
      {roles.map((r) => (
        <section className="box" key={r.id} aria-labelledby={`role-${r.id}`}>
          <h2 id={`role-${r.id}`}>{r.name}</h2>
          <p>{r.members} {r.members === 1 ? "person" : "people"}</p>
          {r.builtin ? <p>Holds every permission. Can't be changed or deleted.</p> : <RoleForm role={r} />}
        </section>
      ))}
      <section className="box" aria-labelledby="new-role"><h2 id="new-role">New role</h2><RoleForm /></section>
      <details className="box"><summary>All permissions</summary><ul>{GRANTABLE.map((p) => <li key={p}><code>{p}</code></li>)}</ul></details>
    </main>
  );
}
```

`src/app/staff/(app)/roles/role-form.tsx`:

```tsx
"use client";
import { useActionState } from "react";
import { saveRoleAction } from "./actions";

type R = { id: string; name: string; include: string[]; exclude: string[] };

export function RoleForm({ role }: { role?: R }) {
  const [state, action, pending] = useActionState(async (_: unknown, f: FormData) => saveRoleAction(f), null);
  return (
    <form action={action} className="stack">
      {role && <input type="hidden" name="id" value={role.id} />}
      <label className="field"><span>Name</span><input name="name" defaultValue={role?.name} required /></label>
      <label className="field"><span>Include (one pattern per line, e.g. Roster.*)</span>
        <textarea name="include" rows={3} defaultValue={role?.include.join("\n")} /></label>
      <label className="field"><span>Exclude (one per line)</span>
        <textarea name="exclude" rows={2} defaultValue={role?.exclude.join("\n")} /></label>
      {state && !state.ok && <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {state?.ok && <p role="status">Saved.</p>}
      <button className="btn" disabled={pending}>{role ? "Save role" : "Create role"}</button>
    </form>
  );
}
```

`src/app/staff/(app)/people/page.tsx`:

```tsx
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { listStaff, listRoles } from "@/lib/staff/roles";
import { InviteForm, PersonRow } from "./people-client";

export default async function PeoplePage() {
  const ctx = await requireStaffPage("Staff.Users.Read");
  const [people, roles] = await Promise.all([listStaff(), listRoles()]);
  const canEdit = can(ctx.effective, "Staff.Users.ReadWrite");
  const canAssign = can(ctx.effective, "Admin.Roles.ReadWrite");
  return (
    <main className="wrap single">
      <h1 className="page-title">Staff</h1>
      <section className="box" aria-labelledby="staff-h">
        <h2 id="staff-h">People who sign in as staff</h2>
        <ul className="lines">{people.map((p) => <PersonRow key={p.id} person={p} roles={roles.map(({ id, name }) => ({ id, name }))} canEdit={canEdit} canAssign={canAssign} />)}</ul>
      </section>
      {canEdit && <section className="box" aria-labelledby="invite-h"><h2 id="invite-h">Add someone</h2>
        <p>They sign in with their Microsoft or Google account using this email.</p><InviteForm /></section>}
    </main>
  );
}
```

`src/app/staff/(app)/people/people-client.tsx`:

```tsx
"use client";
import { useActionState, useTransition, useState } from "react";
import { inviteStaffAction, setStaffStatusAction } from "./actions";
import { assignRoleAction, unassignRoleAction } from "../roles/actions";

export function InviteForm() {
  const [state, action, pending] = useActionState(async (_: unknown, f: FormData) => inviteStaffAction(f), null);
  return (
    <form action={action} className="stack">
      <label className="field"><span>Name</span><input name="name" required autoComplete="off" /></label>
      <label className="field"><span>Email</span><input name="email" type="email" required autoComplete="off" /></label>
      {state && !state.ok && <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {state?.ok && <p role="status">Added. They can sign in now.</p>}
      <button className="btn" disabled={pending}>Add to staff</button>
    </form>
  );
}

type Person = { id: string; name: string; email: string; status: string; roles: string[] };

export function PersonRow({ person, roles, canEdit, canAssign }: { person: Person; roles: { id: string; name: string }[]; canEdit: boolean; canAssign: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) => start(async () => { const r = await fn(); setError(r.ok ? null : r.error ?? "That didn't work."); });
  return (
    <li>
      <span><span className="what">{person.name}</span><span className="when">{person.email} · {person.status}</span></span>
      <span>{person.roles.join(", ") || "No roles"}</span>
      {canAssign && <span className="row-actions">{roles.map((r) => person.roles.includes(r.name)
        ? <button key={r.id} className="btn btn-line" disabled={pending} onClick={() => run(() => unassignRoleAction(r.id, person.id))}>Remove {r.name}</button>
        : <button key={r.id} className="btn btn-line" disabled={pending} onClick={() => run(() => assignRoleAction(r.id, person.id))}>Give {r.name}</button>)}</span>}
      {canEdit && <button className="btn btn-line" disabled={pending}
        onClick={() => run(() => setStaffStatusAction(person.id, person.status === "disabled" ? "active" : "disabled"))}>
        {person.status === "disabled" ? "Turn sign-in back on" : "Turn off sign-in"}</button>}
      {error && <p role="alert" className="errors">{error}</p>}
    </li>
  );
}
```

`src/app/staff/(app)/settings/club/page.tsx`:

```tsx
import { requireStaffPage } from "@/lib/guards";
import { getClubSettings } from "@/lib/settings/club";
import { ClubForm } from "./club-form";

export default async function ClubSettingsPage() {
  await requireStaffPage("Settings.Club.Read");
  return (
    <main className="wrap single">
      <h1 className="page-title">Club</h1>
      <section className="box" aria-labelledby="club-h"><h2 id="club-h">Name and colour</h2><ClubForm initial={await getClubSettings()} /></section>
    </main>
  );
}
```

`src/app/staff/(app)/settings/club/club-form.tsx`:

```tsx
"use client";
import { useActionState } from "react";
import { saveClubAction } from "./actions";
import type { ClubSettings } from "@/lib/settings/club";

export function ClubForm({ initial }: { initial: ClubSettings }) {
  const [state, action, pending] = useActionState(async (_: unknown, f: FormData) => saveClubAction(f), null);
  return (
    <form action={action} className="stack">
      <label className="field"><span>Club name</span><input name="name" defaultValue={initial.name} required maxLength={60} /></label>
      <label className="field"><span>Short name (on the round badge, up to 4 letters)</span><input name="shortName" defaultValue={initial.shortName} required maxLength={4} /></label>
      <label className="field"><span>Club colour</span><input name="colour" type="color" defaultValue={initial.colour} /></label>
      <label className="field"><span>Treasurer email (shown to parents for questions)</span><input name="treasurerEmail" type="email" defaultValue={initial.treasurerEmail ?? ""} /></label>
      {state && !state.ok && <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {state?.ok && <p role="status">Saved. Every page now uses these.</p>}
      <button className="btn" disabled={pending}>Save</button>
    </form>
  );
}
```

`src/app/staff/(app)/audit/page.tsx`:

```tsx
import { desc } from "drizzle-orm";
import { requireStaffPage } from "@/lib/guards";
import { db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";

export default async function AuditPage() {
  await requireStaffPage("Audit.Log.Read");
  const rows = await db.select().from(auditLog).orderBy(desc(auditLog.at)).limit(200);
  return (
    <main className="wrap single">
      <h1 className="page-title">Audit log</h1>
      <section className="box" aria-labelledby="audit-h"><h2 id="audit-h">Latest 200 changes</h2>
        <ul className="lines">{rows.map((r) => (
          <li key={r.id}><span><span className="what">{r.action}</span>
            <span className="when">{r.at.toLocaleString("en-US")} · {r.door} · {r.actorLabel ?? "system"}{r.ip ? ` · ${r.ip}` : ""}</span></span>
            <span className="amount">{r.targetType ? `${r.targetType} ${r.targetId ?? ""}` : ""}</span></li>))}
        </ul></section>
    </main>
  );
}
```

- [ ] **Step 6: Run the invariant test**

Run: `pnpm test tests/integration/invariants.test.ts` — Expected: PASS for the three staff `actions.ts` modules (every export wrapped with a permission).

- [ ] **Step 7: Prove the invariant catches a miss**

Temporarily add `export async function leak() { return 1; }` to `people/actions.ts`, run the invariant test, confirm it FAILS naming `leak`, then remove it.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(staff): roles, staff users and club settings with guarded actions"
```

---

### Task 10: Styles, display modes, app shell and sign-in pages

**Files:**
- Create: `src/app/booster.css`, `src/app/display-script.ts`, `src/app/components/club-bar.tsx`, `src/app/components/parent-tabs.tsx`, `src/app/components/choice-group.tsx`, `src/app/sign-in/page.tsx`, `src/app/sign-in/sign-in-button.tsx`, `src/app/staff/sign-in/page.tsx`, `src/app/refused/page.tsx`, `src/app/(parent)/layout.tsx`, `src/app/(parent)/page.tsx`, `src/app/(parent)/display/page.tsx`, `src/app/staff/(app)/layout.tsx`, `src/app/staff/(app)/page.tsx`, `tests/unit/display-script.test.ts`
- Modify: `src/app/layout.tsx`; delete `src/app/page.tsx` (replaced by `(parent)/page.tsx`)

**Interfaces:**
- Consumes: `getClubSettings`, `deriveClubTokens`, `clubCssVars`, `requireParentPage`, `requireStaffPage`, `can`, `staffAuthClient`, `parentAuthClient`, `PARENT_PROVIDER_ID`, `staffEntraEnabled`, `staffGoogleEnabled`, `parentDoorEnabled`.
- Produces: `DISPLAY_SCRIPT: string` (pre-paint mode script), `<ClubBar>`, `<ParentTabs>`, `<ChoiceGroup>`; routes `/`, `/display`, `/sign-in`, `/staff`, `/staff/sign-in`, `/refused`.

- [ ] **Step 1: Port the stylesheet**

Copy `design/reference/booster.css` to `src/app/booster.css`, then in the copy:
1. Delete the `:root[data-club="gold"] { … }` block (demo only).
2. Delete the demo switch blocks: `.only-offline` … `.not-offline` and `.only-late, .only-clear` … `.not-clear` (state toggles move into components in later plans).
3. In the first `:root` block keep the `--club*` declarations as defaults (FZN purple) — runtime values override them on `<html>`.
4. Replace the two `font-family` stacks with the `next/font` variables: `--read: var(--font-read), system-ui, sans-serif;` and `--mark: var(--font-mark), "Arial Narrow", sans-serif;`.
5. Append the staff/form helpers used by Task 9 pages:

```css
/* Pages and forms */
.page-title { font: 700 2rem/1.1 var(--mark); margin-top: var(--s5); }
.lede { color: var(--ink-2); margin-top: var(--s1); max-width: 60ch; }
main.wrap.single { display: block; padding-top: var(--s4); }
main.wrap.single > .box { margin-top: var(--cell); max-width: 760px; }
.stack { display: grid; gap: var(--s4); margin-top: var(--s3); max-width: 520px; }
.field { display: grid; gap: var(--s1); }
.field > span { font: 600 0.9375rem var(--mark); letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }
.field input, .field textarea { font: inherit; color: var(--ink); background: var(--paper); border: var(--rule) solid var(--ink);
  border-radius: 0; min-height: 44px; padding: var(--s2) var(--s3); }
.field input[type="color"] { width: 88px; padding: 2px; }
.field input:focus-visible, .field textarea:focus-visible { outline: var(--ring) solid var(--club-text); outline-offset: 2px; }
.errors { color: var(--late); font-weight: 700; padding-left: 1.2em; }
.row-actions { display: flex; flex-wrap: wrap; gap: var(--s2); grid-column: 1 / -1; }
.signin { max-width: 440px; margin: 0 auto; padding-top: var(--s6); }
.signin .btn { width: 100%; margin-top: var(--s3); }
```

- [ ] **Step 2: Failing test for the display script**

`tests/unit/display-script.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { DISPLAY_SCRIPT } from "@/app/display-script";

function run(saved: unknown) {
  const attrs = new Map<string, string>();
  const root = { setAttribute: (k: string, v: string) => attrs.set(k, v), removeAttribute: (k: string) => attrs.delete(k) };
  const store = new Map<string, string>(saved === undefined ? [] : [["br-display", JSON.stringify(saved)]]);
  const fn = new Function("document", "localStorage", "window", DISPLAY_SCRIPT);
  const win: Record<string, unknown> = {};
  fn({ documentElement: root }, { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) }, win);
  return { attrs, win: win as { BoosterDisplay: { set(k: string, v: string): void } }, store };
}

describe("display script", () => {
  it("sets nothing when following the device", () => {
    expect([...run(undefined).attrs]).toEqual([]);
  });
  it("applies saved overrides", () => {
    expect(Object.fromEntries(run({ theme: "dark", contrast: "more", text: "larger", motion: "reduce" }).attrs)).toEqual(
      { "data-theme": "dark", "data-contrast": "more", "data-text": "larger", "data-motion": "reduce" });
  });
  it("ignores junk values and broken storage", () => {
    expect([...run({ theme: "purple", text: "huge" }).attrs]).toEqual([]);
  });
  it("saves and applies a change", () => {
    const r = run(undefined);
    r.win.BoosterDisplay.set("theme", "light");
    expect(r.attrs.get("data-theme")).toBe("light");
    expect(JSON.parse(r.store.get("br-display")!)).toEqual({ theme: "light" });
  });
});
```

- [ ] **Step 3: Implement `src/app/display-script.ts`**

Port of `design/reference/display.js` without the reference-page hash switches:

```ts
/** Runs before first paint (inlined in <head>). Choices live on this device only. */
export const DISPLAY_SCRIPT = `
(function () {
  var KEY = 'br-display', root = document.documentElement, saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { saved = {}; }
  var map = { theme: ['light', 'dark'], contrast: ['standard', 'more'], text: ['large', 'larger'], motion: ['reduce'] };
  function apply(o) {
    Object.keys(map).forEach(function (k) {
      if (map[k].indexOf(o[k]) >= 0) root.setAttribute('data-' + k, o[k]);
      else root.removeAttribute('data-' + k);
    });
  }
  apply(saved);
  window.BoosterDisplay = {
    get: function () { return Object.assign({ theme: 'device', contrast: 'device', text: 'standard', motion: 'device' }, saved); },
    set: function (k, v) {
      saved[k] = v; apply(saved);
      try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) {}
    }
  };
})();`;
```

Run: `pnpm test tests/unit/display-script.test.ts` — Expected: PASS.

- [ ] **Step 4: Root layout**

`src/app/layout.tsx`:

```tsx
import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible, Barlow_Condensed } from "next/font/google";
import { getClubSettings } from "@/lib/settings/club";
import { deriveClubTokens, clubCssVars } from "@/lib/theme/contrast";
import { DISPLAY_SCRIPT } from "./display-script";
import "./booster.css";

const read = Atkinson_Hyperlegible({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-read", display: "swap" });
const mark = Barlow_Condensed({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-mark", display: "swap" });

export async function generateMetadata(): Promise<Metadata> {
  const club = await getClubSettings();
  return { title: { default: club.name, template: `%s · ${club.name}` } };
}
export const viewport: Viewport = { width: "device-width", initialScale: 1 };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const club = await getClubSettings();
  const vars = clubCssVars(deriveClubTokens(club.colour)); // colour is validated on save; values are hex only
  return (
    <html lang="en" className={`${read.variable} ${mark.variable}`} style={vars as React.CSSProperties} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: DISPLAY_SCRIPT }} /></head>
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 5: Shell components**

`src/app/components/club-bar.tsx`:

```tsx
import Link from "next/link";

type NavItem = { href: string; label: string; current?: boolean };

export function ClubBar({ name, shortName, nav, account }: {
  name: string; shortName: string; nav: NavItem[]; account?: { href: string; initials: string; label: string; current?: boolean };
}) {
  return (
    <header className="bar">
      <div className="wrap">
        <span className="monogram" aria-hidden="true">{shortName}</span>
        <span className="club">{name}</span>
        <nav className="top-nav" aria-label="Main">
          {nav.map((n) => <Link key={n.href} href={n.href} aria-current={n.current ? "page" : undefined}>{n.label}</Link>)}
        </nav>
        {account && <Link className="account" href={account.href} aria-label={account.label} aria-current={account.current ? "page" : undefined}>{account.initials}</Link>}
      </div>
    </header>
  );
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
```

`src/app/components/parent-tabs.tsx`:

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Home", icon: <path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z" /> },
  { href: "/forms", label: "Forms", icon: <><path d="M6 3h9l3 3v15H6z" /><path d="M9 13l2 2 4-4" /></> },
  { href: "/payments", label: "Payments", icon: <><rect x="3" y="6" width="18" height="12" /><path d="M3 10h18M7 15h3" /></> },
  { href: "/family", label: "Family", icon: <><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20c0-3 3-5 6-5s6 2 6 5M15 15c3 0 6 1.5 6 4" /></> },
];

export function ParentTabs() {
  const path = usePathname();
  return (
    <nav className="tabs" aria-label="Main">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} aria-current={path === t.href ? "page" : undefined}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">{t.icon}</svg>{t.label}
        </Link>
      ))}
    </nav>
  );
}

export const PARENT_NAV = TABS.map(({ href, label }) => ({ href, label }));
```

`src/app/components/choice-group.tsx`:

```tsx
"use client";
type Option = { value: string; label: string; hint?: string; size?: string };

export function ChoiceGroup({ name, legend, hint, options, value, onChange, cols }: {
  name: string; legend: string; hint?: string; options: Option[]; value: string; onChange: (v: string) => void; cols?: number;
}) {
  return (
    <fieldset className="setting" style={{ ["--cols" as string]: cols ?? options.length }}>
      <legend>{legend}</legend>
      {hint && <p className="hint">{hint}</p>}
      <div className="choices">
        {options.map((o) => (
          <label className="choice" key={o.value}>
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            <span><b style={o.size ? { fontSize: o.size } : undefined}>{o.label}</b>{o.hint && <small>{o.hint}</small>}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
```

- [ ] **Step 6: Parent shell, home and Display page**

`src/app/(parent)/layout.tsx`:

```tsx
import { requireParentPage } from "@/lib/guards";
import { getClubSettings } from "@/lib/settings/club";
import { ClubBar, initials } from "../components/club-bar";
import { ParentTabs, PARENT_NAV } from "../components/parent-tabs";

export default async function ParentLayout({ children }: { children: React.ReactNode }) {
  const [ctx, club] = await Promise.all([requireParentPage(), getClubSettings()]);
  return (
    <>
      <ClubBar name={club.name} shortName={club.shortName} nav={PARENT_NAV}
        account={{ href: "/display", initials: initials(ctx.name), label: `Your account and display settings, ${ctx.name}` }} />
      {children}
      <footer className="wrap">{club.treasurerEmail && <>Questions about a charge? Email <a href={`mailto:${club.treasurerEmail}`}>{club.treasurerEmail}</a>. </>}Runs on Boosters Rocket.</footer>
      <ParentTabs />
    </>
  );
}
```

`src/app/(parent)/page.tsx`:

```tsx
import { requireParentPage } from "@/lib/guards";

export default async function ParentHome() {
  const ctx = await requireParentPage();
  return (
    <main className="wrap single">
      <h1 className="page-title">Hi, {ctx.name.split(" ")[0]}</h1>
      <section className="box" aria-labelledby="soon-h">
        <h2 id="soon-h">Your family</h2>
        <p>Your students, what's owed and this season's forms will show here once the boosters connect QuickBooks.</p>
      </section>
    </main>
  );
}
```

`src/app/(parent)/display/page.tsx`:

```tsx
import { DisplaySettings } from "./display-settings";

export const metadata = { title: "Display" };

export default function DisplayPage() {
  return (
    <main className="wrap single">
      <h1 className="page-title">Display</h1>
      <p className="lede">Make the portal easier to see and read. Changes apply right away.</p>
      <DisplaySettings />
    </main>
  );
}
```

`src/app/(parent)/display/display-settings.tsx`:

```tsx
"use client";
import { useEffect, useState } from "react";
import { ChoiceGroup } from "../../components/choice-group";

type Prefs = { theme: string; contrast: string; text: string; motion: string };
declare global { interface Window { BoosterDisplay?: { get(): Prefs; set(k: keyof Prefs, v: string): void } } }

export function DisplaySettings() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  useEffect(() => { setPrefs(window.BoosterDisplay?.get() ?? { theme: "device", contrast: "device", text: "standard", motion: "device" }); }, []);
  if (!prefs) return null;
  const set = (k: keyof Prefs) => (v: string) => { window.BoosterDisplay?.set(k, v); setPrefs({ ...prefs, [k]: v }); };
  return (
    <form className="box" aria-label="Display settings" onSubmit={(e) => e.preventDefault()}>
      <ChoiceGroup name="theme" legend="Appearance" hint="Light or dark background." value={prefs.theme} onChange={set("theme")} options={[
        { value: "device", label: "Match my device", hint: "Follows your phone or computer" },
        { value: "light", label: "Light", hint: "Dark text on white" },
        { value: "dark", label: "Dark", hint: "Light text on near-black" }]} />
      <ChoiceGroup name="contrast" legend="Contrast" hint="High contrast makes text and lines as strong as possible and removes the background grid." value={prefs.contrast} onChange={set("contrast")} options={[
        { value: "device", label: "Match my device", hint: "Uses your contrast setting" },
        { value: "standard", label: "Standard" }, { value: "more", label: "High contrast" }]} />
      <ChoiceGroup name="text" legend="Text size" hint="Your browser's own zoom works too." value={prefs.text} onChange={set("text")} options={[
        { value: "standard", label: "Standard" }, { value: "large", label: "Large", size: "1.1875rem" }, { value: "larger", label: "Larger", size: "1.3125rem" }]} />
      <ChoiceGroup name="motion" legend="Motion" hint="Turn off movement and fades." value={prefs.motion} onChange={set("motion")} cols={2} options={[
        { value: "device", label: "Match my device" }, { value: "reduce", label: "Reduce motion" }]} />
      <p className="saved-note">Saved on this device. Sign in somewhere else and you can choose again there.</p>
    </form>
  );
}
```

- [ ] **Step 7: Sign-in and refusal pages**

`src/app/sign-in/sign-in-button.tsx`:

```tsx
"use client";
import { staffAuthClient, parentAuthClient } from "@/lib/auth/client";

export function SignInButton({ door, provider, label, primary }: { door: "staff" | "parent"; provider: string; label: string; primary?: boolean }) {
  const go = () => door === "parent"
    ? parentAuthClient.signIn.oauth2({ providerId: provider, callbackURL: "/", errorCallbackURL: "/refused" })
    : staffAuthClient.signIn.social({ provider: provider as "microsoft" | "google", callbackURL: "/staff", errorCallbackURL: "/refused" });
  return <button type="button" className={primary ? "btn" : "btn btn-line"} onClick={go}>{label}</button>;
}
```

`src/app/sign-in/page.tsx`:

```tsx
import { getClubSettings } from "@/lib/settings/club";
import { parentDoorEnabled } from "@/env";
import { PARENT_PROVIDER_ID } from "@/lib/auth/parent-auth";
import { SignInButton } from "./sign-in-button";

export const metadata = { title: "Sign in" };

export default async function ParentSignIn() {
  const club = await getClubSettings();
  return (
    <main className="wrap signin">
      <h1 className="page-title">{club.name}</h1>
      <p className="lede">Sign in to see your students, what's owed, and this season's forms. We'll email you a code; check your spam folder if it doesn't arrive in a minute.</p>
      {parentDoorEnabled
        ? <SignInButton door="parent" provider={PARENT_PROVIDER_ID} label="Sign in with your email" primary />
        : <p role="status">Sign-in isn't set up yet. Please check back soon.</p>}
      <p className="lede"><a href="/staff/sign-in">Board and staff sign in here</a></p>
    </main>
  );
}
```

`src/app/staff/sign-in/page.tsx`:

```tsx
import { getClubSettings } from "@/lib/settings/club";
import { staffEntraEnabled, staffGoogleEnabled } from "@/env";
import { SignInButton } from "../../sign-in/sign-in-button";

export const metadata = { title: "Staff sign in" };

export default async function StaffSignIn() {
  const club = await getClubSettings();
  return (
    <main className="wrap signin">
      <h1 className="page-title">{club.name} staff</h1>
      <p className="lede">Sign in with the account the boosters added you with.</p>
      {staffEntraEnabled && <SignInButton door="staff" provider="microsoft" label="Sign in with Microsoft" primary />}
      {staffGoogleEnabled && <SignInButton door="staff" provider="google" label="Sign in with Google" primary={!staffEntraEnabled} />}
      {!staffEntraEnabled && !staffGoogleEnabled && <p role="status">No staff sign-in is set up yet.</p>}
    </main>
  );
}
```

`src/app/refused/page.tsx`:

```tsx
export const metadata = { title: "Can't sign you in" };

export default function Refused() {
  return (
    <main className="wrap signin">
      <h1 className="page-title">We can't sign you in with that account</h1>
      <p className="lede">If you think you should have access, contact your booster club and ask them to check the email they have for you.</p>
      <p className="lede"><a href="/sign-in">Back to sign in</a></p>
    </main>
  );
}
```

- [ ] **Step 8: Staff shell and home**

`src/app/staff/(app)/layout.tsx`:

```tsx
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { getClubSettings } from "@/lib/settings/club";
import { ClubBar, initials } from "../../components/club-bar";

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const [ctx, club] = await Promise.all([requireStaffPage(), getClubSettings()]);
  const e = ctx.effective;
  const nav = [
    { href: "/staff", label: "Home" },
    ...(can(e, "Staff.Users.Read") ? [{ href: "/staff/people", label: "Staff" }] : []),
    ...(can(e, "Admin.Roles.ReadWrite") ? [{ href: "/staff/roles", label: "Roles" }] : []),
    ...(can(e, "Settings.Club.Read") ? [{ href: "/staff/settings/club", label: "Club" }] : []),
    ...(can(e, "Audit.Log.Read") ? [{ href: "/staff/audit", label: "Audit" }] : []),
  ];
  return (
    <>
      <ClubBar name={club.name} shortName={club.shortName} nav={nav}
        account={{ href: "/staff", initials: initials(ctx.name), label: `Signed in as ${ctx.name}` }} />
      {children}
    </>
  );
}
```

`src/app/staff/(app)/page.tsx`:

```tsx
import { requireStaffPage } from "@/lib/guards";

export default async function StaffHome() {
  const ctx = await requireStaffPage();
  return (
    <main className="wrap single">
      <h1 className="page-title">Hi, {ctx.name.split(/[ @]/)[0]}</h1>
      <section className="box" aria-labelledby="next-h"><h2 id="next-h">What's here so far</h2>
        <p>{ctx.effective.isAdmin ? "You're an admin. Start by setting the club's name and colour, then add the rest of the board under Staff." : "Use the menu above for the parts you have access to."}</p>
      </section>
    </main>
  );
}
```

Note: the staff layout lives under `staff/(app)/` so `/staff/sign-in` is outside it and never requires a session.

- [ ] **Step 9: Build and look**

Run: `pnpm build` — Expected: build succeeds.
Run: `docker compose up -d db && pnpm db:migrate && pnpm dev`, open `http://localhost:3000/sign-in`, `/staff/sign-in`, `/refused` at 390px and 1440px wide. Expected: club bar absent on sign-in pages, Dot Book type and grid paper, no horizontal scroll. Compare against `design/reference/parent-home.html` for type, rules and colour.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(shell): ported styles, display modes, app shell and sign-in pages"
```

---

### Task 11: Public-page and client-bundle invariants, CI completion

**Files:**
- Create: `scripts/check-client-bundle.mjs`, `playwright.config.ts`, `tests/e2e/public-pages.spec.ts`, `scripts/seed-e2e.ts`
- Modify: `.github/workflows/ci.yml`, `package.json`

**Interfaces:**
- Consumes: the built app; `seedGuardian`-equivalent insert in `scripts/seed-e2e.ts`.
- Produces: CI steps `pnpm build`, `node scripts/check-client-bundle.mjs`, `pnpm e2e`.

- [ ] **Step 1: Bundle secret check**

`scripts/check-client-bundle.mjs`:

```js
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
    statSync(p).isDirectory() ? walk(p) : files.push(p);
  }
})(".next/static");

let bad = 0;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const [k, v] of secrets) if (text.includes(v)) { console.error(`${k} found in ${f}`); bad++; }
}
if (bad) process.exit(1);
console.log(`checked ${files.length} client files; no secrets found`);
```

- [ ] **Step 2: Playwright and the public-pages test**

```bash
pnpm add -D @playwright/test
pnpm exec playwright install --with-deps chromium
```

`playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  use: { baseURL: "http://localhost:3000" },
  webServer: { command: "pnpm start", url: "http://localhost:3000/sign-in", reuseExistingServer: !process.env.CI, timeout: 60_000 },
  projects: [{ name: "phone", use: { viewport: { width: 390, height: 844 } } }, { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } }],
});
```

`scripts/seed-e2e.ts`:

```ts
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);
await sql`INSERT INTO guardian (family_qbo_id, name, email, identity_object_id, status)
          VALUES ('E2E-FAMILY', 'Zelda Quetzalcoatl', 'zelda@example.com', 'oid-e2e', 'active') ON CONFLICT DO NOTHING`;
await sql`INSERT INTO setting (key, value) VALUES ('club', ${sql.json({ name: "E2E Boosters", shortName: "E2E", colour: "#5b2a86", treasurerEmail: null })})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
await sql.end();
```

`tests/e2e/public-pages.spec.ts`:

```ts
import { test, expect } from "@playwright/test";

const PUBLIC = ["/sign-in", "/staff/sign-in", "/refused"];

for (const path of PUBLIC) {
  test(`${path} shows no family data to an anonymous visitor`, async ({ page }) => {
    await page.goto(path);
    const html = await page.content();
    expect(html).not.toContain("Zelda");
    expect(html).not.toContain("Quetzalcoatl");
    expect(html).not.toContain("E2E-FAMILY");
    await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
  });
}

test("parent and staff pages send an anonymous visitor to sign in", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/display");
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/staff/roles");
  await expect(page).toHaveURL(/\/staff\/sign-in$/);
});

test("no horizontal scroll on the sign-in page", async ({ page }) => {
  await page.goto("/sign-in");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflow).toBe(false);
});
```

- [ ] **Step 3: Complete CI**

Append to the `test` job in `.github/workflows/ci.yml`:

```yaml
      - name: Build with fake secrets
        env:
          DATABASE_URL: postgres://booster:booster@localhost:5433/booster_test
          APP_URL: http://localhost:3000
          BETTER_AUTH_SECRET: ci-fake-secret-ci-fake-secret-1234567890
          STAFF_GOOGLE_CLIENT_ID: ci-google-id
          STAFF_GOOGLE_CLIENT_SECRET: ci-fake-google-secret-abcdef
          PARENT_OIDC_DISCOVERY_URL: https://login.example.com/.well-known/openid-configuration
          PARENT_OIDC_CLIENT_ID: ci-parent-id
          PARENT_OIDC_CLIENT_SECRET: ci-fake-parent-secret-abcdef
        run: |
          pnpm build
          node scripts/check-client-bundle.mjs
      - name: E2E
        env:
          DATABASE_URL: postgres://booster:booster@localhost:5433/booster_test
          APP_URL: http://localhost:3000
          BETTER_AUTH_SECRET: ci-fake-secret-ci-fake-secret-1234567890
        run: |
          pnpm exec playwright install --with-deps chromium
          pnpm tsx scripts/seed-e2e.ts
          pnpm e2e
```

- [ ] **Step 4: Run locally**

Run (with the dev DB up and migrated against `booster_test`):

```bash
export DATABASE_URL=postgres://booster:booster@localhost:5433/booster_test APP_URL=http://localhost:3000 BETTER_AUTH_SECRET=local-fake-secret-local-fake-secret-123
export STAFF_GOOGLE_CLIENT_SECRET=local-fake-google-secret PARENT_OIDC_CLIENT_SECRET=local-fake-parent-secret
pnpm build && node scripts/check-client-bundle.mjs && pnpm tsx scripts/seed-e2e.ts && pnpm e2e
```

Expected: bundle check prints "no secrets found"; all e2e tests pass on both projects.

- [ ] **Step 5: Full suite and commit**

Run: `pnpm lint && pnpm typecheck && pnpm test` — Expected: all pass.

```bash
git add -A
git commit -m "test: public-page and client-bundle invariants; complete CI"
git push
```

Expected: the CI run on GitHub is green.

---

## Manual check before calling Plan 1 done

With real (or test) Entra and Google apps configured in `.env.local`:
1. Set `BOOTSTRAP_ADMIN_EMAIL` to your own; sign in at `/staff/sign-in`; you land on `/staff` as Admin.
2. Set the club name and colour; the bar and current-set colour change; try a light colour (gold) and check dark mode.
3. Invite a second person; sign in as them; they see only Home until given a role.
4. Try to remove your own Admin role while you are the only admin; it refuses with "There must always be at least one admin."
5. Sign in at `/sign-in` with an External ID test user whose `oid` is not in `guardian`; you land on `/refused`.
