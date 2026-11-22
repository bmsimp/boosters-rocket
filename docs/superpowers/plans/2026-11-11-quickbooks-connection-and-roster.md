# QuickBooks Connection and Roster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Admin connects the club's QuickBooks company, chooses the shape of its membership by customer type, and
staff see the club's families, students and parents (or members) read-only with a clean-up list, kept fresh by a worker.

**Architecture:** A new `src/lib/quickbooks/*` module owns the Intuit OAuth exchange, sealed token storage, token refresh
under a row lock, and GET-only API calls. `src/lib/roster/*` owns the cache refresh, the membership shape, a pure model
that turns cached customers into families or members, and the Needs attention rules. Scheduled work lives in the app
(`src/lib/jobs/*`) behind one internal endpoint; the worker container is a dependency-free script in the same image that
calls that endpoint every minute, so all job logic is ordinary app code under Vitest. Settings use a static view plus a
three-step flow.

**Tech Stack:** Next.js 16.4.5, React 19, TypeScript strict, Drizzle 0.45 + Postgres 16, Better Auth 1.7.18 (staff door
only is touched), Zod 4, Vitest, Playwright, Docker Compose. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-10-quickbooks-connection-and-roster-design.md`

## Global Constraints

- **The portal writes nothing to QuickBooks.** Every request to the QuickBooks API is a GET. The only POSTs go to
  Intuit's token and revoke endpoints.
- Intuit endpoints: authorize `https://appcenter.intuit.com/connect/oauth2`; token
  `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`; revoke
  `https://developer.api.intuit.com/v2/oauth2/tokens/revoke`; API `https://quickbooks.api.intuit.com` (production) and
  `https://sandbox-quickbooks.api.intuit.com` (sandbox). Scope `com.intuit.quickbooks.accounting`. Every API call carries
  `minorversion=75`. Task 1 checks these against the sandbox; if one is wrong, fix `endpoints.ts` and say so.
- The redirect address is `<APP_URL without a trailing slash>/api/quickbooks/callback`.
- The `state` sent to Intuit is single use, tied to the Admin who started the connect, and refused after **10 minutes**.
- The client secret and both tokens are sealed with `secretBox()` using the purpose strings `qbo:client-secret`,
  `qbo:access-token` and `qbo:refresh-token`. **None of them, and no QuickBooks or Intuit response body, ever reaches a
  browser, a log line or an audit row.** Errors are reduced to a fixed sentence and a short code before they are stored.
- Every token refresh saves the refresh token Intuit returns, under a row lock on `qbo_connection`. The access token is
  refreshed when it is expired or within **5 minutes** of expiring.
- Connecting a different company than the one already connected is refused until an Admin disconnects.
- Shape: **flat** (one or more member types) or **layered** (family type required; student type and parent type each
  optional). Types are stored by QuickBooks ID, never by name. A type has at most one role.
- Email and phone are cached **only** for customers whose type the shape names.
- A refresh replaces the cache in one transaction, never runs twice at once, and leaves the old cache in place when it fails.
- Worker: wakes every **60 seconds**. A job is due when its last successful run is more than **24 hours** old; a failed
  job is retried at most once every **15 minutes**. **Refresh now** runs at most once every **5 minutes**.
- Staff warning (Admins): the last token refresh failed; the connection expires within **30 days**; the last roster
  refresh failed or the roster is more than **48 hours** old; the shape names a type QuickBooks no longer has.
- Permissions: `Settings.QuickBooks.ReadWrite` is Admin-only (on `ADMIN_ONLY`). `Roster.Read` is grantable.
- Audit actions: `settings.quickbooks.save`, `quickbooks.connect`, `quickbooks.connect_refused`, `quickbooks.disconnect`,
  `settings.membership.save`, `quickbooks.token_refresh.failed`, `roster.refresh`, `roster.refresh.failed`,
  `roster.family.read`. Staff actor: `{ door: "staff", id: staffUserId, label: email }`. Worker actor:
  `{ door: "system", id: null, label: "worker" }`.
- QuickBooks names are free text anyone with QuickBooks access can edit: render them as text only (React children, never
  `dangerouslySetInnerHTML`).
- There is **no test-only path in the app.** Integration tests replace `qboEndpoints` with `vi.mock`, pointing the real
  client at a stub server. No environment variable switches the app to other endpoints.
- Every server action module under `src/app/staff/` exports only `staffAction`-wrapped functions
  (`tests/integration/invariants.test.ts`).
- Next.js 16 differs from training data: before writing a page, layout, route handler or server action, read the matching
  guide in `node_modules/next/dist/docs/` (AGENTS.md).
- US English. Times stored UTC; shown with `LocalTime`; no zone in display code.
- UI problems found along the way go in `docs/ui-backlog.md`; this plan does not restyle Sign-in or Mail.
- Commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`, and the build with
  `DATABASE_URL=postgres://booster:booster@localhost:5433/booster_test APP_URL=http://localhost:3100 BETTER_AUTH_SECRET=ci-fake-secret-ci-fake-secret-1234567890 SETTINGS_ENCRYPTION_KEY=Y2ktZmFrZS1rZXktY2ktZmFrZS1rZXktY2ktZmFrZSE= pnpm build`.
  E2E: `pnpm db:migrate`, `pnpm tsx scripts/seed-e2e.ts`, `pnpm e2e` (same environment). The test Postgres is the one
  already on `localhost:5433`; don't start another. The full suite takes about 5 minutes: run one heavy command at a time,
  and give any test with 20 or more sequential database round trips an explicit 30-second timeout.
- The code blocks in this plan are the design, written against the files as they stood on 2026-11-11. Where the compiler,
  the linter or an installed library disagrees, make the smallest change that keeps the behavior and say so in your report.
- Write files with LF line endings.
- Commit trailer, exactly: `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

## Review Focus

1. The worker's daily token refresh and a staff request both find the access token expired at the same moment. Intuit's
   refresh token works once, so exactly one refresh must be sent, and the other caller must use the tokens the first one
   saved (Task 3 test "two callers at once spend the refresh token once").
2. An Admin opens the connect step in two tabs and clicks **Sign in to Intuit** in both, or a return from Intuit is
   replayed. Only the most recent `state` works, once; the other return is refused with a plain message and nothing is
   stored (Task 3 tests "only the latest state works" and "a state works once").
3. QuickBooks answers the first page of customers and then fails on the second. The roster staff see must be the old
   one, whole, not half of the new one, and the failure must show in the warning (Task 4 test "a failure on a later page
   keeps the old cache").
4. Somebody deletes or merges the `Parent` customer type in QuickBooks. The roster must say the shape needs attention
   rather than quietly showing every family with no parents (Task 5 test "a shape naming a missing type is broken").
5. A customer is named `<img src=x onerror=alert(1)>` or `Smith & "Sons"`. The name must appear as those characters on
   the roster list, the family page and Needs attention (Task 8 test "renders hostile names as text").

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/db/schema.ts`, `drizzle/0007_quickbooks.sql` | `qbo_connection`, `qbo_customer_type`, `qbo_customer`, `job_run`. |
| `src/lib/permissions/registry.ts` | `Settings.QuickBooks.ReadWrite` (Admin-only), `Roster.Read`. |
| `src/lib/quickbooks/endpoints.ts` | Intuit URLs, scope, minor version, `QboError`, `qboEndpoints()` (the one seam tests replace). |
| `src/lib/quickbooks/connection.ts` | The Intuit app's keys, the connect state, exchanging the code, disconnecting, the view for pages. |
| `src/lib/quickbooks/client.ts` | Token requests, refresh under a row lock, GET-only API calls, paged queries. |
| `src/lib/roster/shape.ts` | The membership shape: type, parse, save, problems, words. |
| `src/lib/roster/refresh.ts` | Reading customers and types into the cache. |
| `src/lib/roster/model.ts` | Pure: cached customers + shape → families, members, outside count. |
| `src/lib/roster/attention.ts` | Pure: the Needs attention rules. |
| `src/lib/roster/queries.ts` | Loads the cache, the shape and portal sign-ins for pages; the shape preview. |
| `src/lib/jobs/runner.ts` | Which jobs are due, running them, `job_run`, the worker's last wake. |
| `src/lib/quickbooks/health.ts` | The staff warning rule. |
| `src/app/api/internal/worker/route.ts` | The endpoint the worker calls. |
| `src/app/api/quickbooks/callback/route.ts` | The return from Intuit. |
| `scripts/worker.mjs` | The worker loop (no dependencies). |
| `src/app/staff/(app)/settings/quickbooks/*` | The settings view, the three steps, their actions. |
| `src/app/staff/(app)/roster/*` | Roster list, family or member page, Needs attention, **Refresh now**. |
| `src/app/staff/(app)/quickbooks-warning.tsx` | The staff home warning. |
| `tests/helpers/qbo-stub.ts` | A stub Intuit and QuickBooks server for integration tests. |
| `Dockerfile`, `docker-compose.poc.yml`, `scripts/poc/deploy.sh` | The worker container. |
| `docs/runbooks/poc-linuxdev.md`, roadmap, v1 spec | QuickBooks section and supersession notes. |

---

### Task 1: Check the design against the Intuit sandbox (needs the owner)

This task answers spec §8 before anything is built on it. It needs a live access token, which only the owner can get, so
**the executor stops here and asks the owner to do Step 2**, then continues.

**Files:**
- Create: `spikes/qbo-check.mjs` (deleted again in Step 5)
- Modify: `docs/superpowers/specs/2026-11-10-quickbooks-connection-and-roster-design.md` (§8 gains an Answers column)

**Interfaces:**
- Consumes: nothing.
- Produces: the answers in spec §8, which Tasks 3 to 5 rely on.

- [ ] **Step 1: Write the check script**

```js
// spikes/qbo-check.mjs: throwaway. Answers the questions in spec §8 against an Intuit sandbox company. GET only.
const token = process.env.QBO_ACCESS_TOKEN, realm = process.env.QBO_REALM_ID;
if (!token || !realm) { console.error("Set QBO_ACCESS_TOKEN and QBO_REALM_ID."); process.exit(2); }
const base = `https://sandbox-quickbooks.api.intuit.com/v3/company/${realm}`;
async function get(path) {
  const res = await fetch(`${base}/${path}${path.includes("?") ? "&" : "?"}minorversion=75`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text: text.slice(0, 300) };
}
const q = (s) => get(`query?query=${encodeURIComponent(s)}`);
const say = (label, value) => console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

const info = await get(`companyinfo/${realm}`);
say("company", info.json?.CompanyInfo?.CompanyName ?? `HTTP ${info.status} ${info.text}`);

const types = await q("select * from CustomerType");
say("1a. CustomerType query status", String(types.status));
say("1a. customer types", (types.json?.QueryResponse?.CustomerType ?? []).map((t) => ({ Id: t.Id, Name: t.Name, Active: t.Active })));

const all = await q("select * from Customer where Active in (true, false) startposition 1 maxresults 1000");
const customers = all.json?.QueryResponse?.Customer ?? [];
say("4. customers returned with maxresults 1000", String(customers.length));
say("4. inactive customers returned", String(customers.filter((c) => c.Active === false || c.Active === "false").length));
say("1b. customers carrying CustomerTypeRef", String(customers.filter((c) => c.CustomerTypeRef?.value).length));
say("1b. a typed customer", customers.find((c) => c.CustomerTypeRef?.value) ?? "none");
const subs = customers.filter((c) => c.ParentRef?.value);
say("5. sub-customers", String(subs.length));
say("5. a sub-customer (Id, ParentRef, Level, Job, FullyQualifiedName)", subs.slice(0, 3).map((c) => ({ Id: c.Id, ParentRef: c.ParentRef, Level: c.Level, Job: c.Job, FullyQualifiedName: c.FullyQualifiedName })));
const deep = subs.find((c) => Number(c.Level) >= 2);
say("5. a customer two levels down", deep ? { Id: deep.Id, ParentRef: deep.ParentRef, Level: deep.Level } : "none in this company");
const over = await q("select * from Customer startposition 1 maxresults 1001");
say("4. maxresults 1001", `HTTP ${over.status}${over.status === 200 ? "" : " " + over.text}`);
say("field names on a customer", customers[0] ? Object.keys(customers[0]) : "no customers");
```

- [ ] **Step 2: Ask the owner for a sandbox token and shape the sandbox like FZN**

Stop and give the owner these steps, word for word:

1. Sign in at https://developer.intuit.com, open the app that holds the development keys, and note its sandbox company.
2. In that sandbox company (https://app.sandbox.qbo.intuit.com), create customer types `Family`, `Parent`, `Student`,
   `School` and `Vendor` (**Sales** > **Customers** > **Customer types**). Make one customer of type `Family` with two
   sub-customers, one typed `Parent` (with an email) and one typed `Student`; make one customer typed `School`; and make
   one customer inactive.
3. Open the OAuth 2.0 Playground (https://developer.intuit.com/app/developer/playground), choose the app, tick
   **Accounting**, and go through it to **Get tokens**.
4. Copy the **Access token** and the **Realm ID** it shows. In a terminal in `G:\booster-rocket`:
   `$env:QBO_ACCESS_TOKEN = "<access token>"; $env:QBO_REALM_ID = "<realm id>"; node spikes/qbo-check.mjs`
5. Paste the output back. It contains names from the sandbox company and no token. Also copy what the playground's
   token response shows for `expires_in` and `x_refresh_token_expires_in` (the two numbers only).

The access token lasts an hour and is never written to a file. Do not ask the owner to paste a token into the chat.

- [ ] **Step 3: Read the output against spec §8**

Expected, if the design holds:
- `1a` status `200` and the five types listed, each with `Id` and `Name`.
- `1b` the typed customers carry `CustomerTypeRef` with a `value` equal to a type `Id`.
- `4` both active and inactive customers are returned; `maxresults 1001` is refused or capped.
- `5` a sub-customer's `ParentRef.value` is its direct parent's `Id`.
- `x_refresh_token_expires_in` is a number of seconds.

- [ ] **Step 4: Record the answers in the spec**

Add an **Answer (2026-11-11, sandbox)** column to the table in spec §8 and fill each row with what the output showed,
including the customer field names the code will read (`Id`, `DisplayName`, `Active`, `ParentRef.value`,
`CustomerTypeRef.value`, `PrimaryEmailAddr.Address`, `PrimaryPhone.FreeFormNumber`, `SyncToken`,
`MetaData.LastUpdatedTime`) if any differs. **If an answer contradicts the design** (for example customer types can't be
listed), stop: the spec section it bears on is revised with the owner before Task 2.

- [ ] **Step 5: Delete the script and commit**

```bash
git rm -q --cached spikes/qbo-check.mjs 2>/dev/null; rm -rf spikes
git add docs/superpowers/specs/2026-11-10-quickbooks-connection-and-roster-design.md
git commit -m "docs(spec): answers from the Intuit sandbox for the QuickBooks design

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 2: Tables, migration and permissions

**Files:**
- Modify: `src/lib/db/schema.ts`, `src/lib/permissions/registry.ts`, `tests/helpers/db.ts`
- Create: `drizzle/0007_quickbooks.sql` (generated), `tests/integration/quickbooks-schema.test.ts`
- Modify: `tests/unit/permissions/registry.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - tables `qboConnection`, `qboCustomerType`, `qboCustomer`, `jobRun` exported from `src/lib/db/schema.ts`, with the
    column names shown in Step 3;
  - `type QboEnvironment = "sandbox" | "production"` exported from `src/lib/db/schema.ts`;
  - permissions `"Settings.QuickBooks.ReadWrite"` and `"Roster.Read"`;
  - `resetDb()` empties the four new tables.

- [ ] **Step 1: Write the failing tests**

`tests/integration/quickbooks-schema.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { qboConnection, qboCustomer, qboCustomerType, jobRun } from "@/lib/db/schema";
import { resetDb } from "../helpers/db";

describe("QuickBooks tables", () => {
  beforeEach(resetDb);

  it("holds at most one connection row", async () => {
    const row = { environment: "sandbox" as const, clientId: "id", clientSecretCiphertext: "c", clientSecretKeyId: "k" };
    await db.insert(qboConnection).values(row);
    await expect(db.insert(qboConnection).values(row)).rejects.toThrow();
    expect(await db.select().from(qboConnection)).toHaveLength(1);
  });

  it("keeps customers and types by their QuickBooks ID, and a job run with its outcome", async () => {
    await db.insert(qboCustomerType).values({ qboId: "5", name: "Family", active: true });
    await db.insert(qboCustomer).values({ qboId: "12", displayName: "Rivera Family", active: true, typeQboId: "5", syncToken: "0" });
    await db.insert(qboCustomer).values({ qboId: "13", displayName: "Ana Rivera", active: true, parentQboId: "12", syncToken: "0" });
    await expect(db.insert(qboCustomer).values({ qboId: "12", displayName: "Again", active: true, syncToken: "0" })).rejects.toThrow();
    const [run] = await db.insert(jobRun).values({ job: "roster.refresh", startedBy: "worker" }).returning();
    expect(run!.outcome).toBeNull();
    expect(run!.finishedAt).toBeNull();
  });

  it("is emptied by resetDb", async () => {
    await db.insert(qboCustomerType).values({ qboId: "5", name: "Family", active: true });
    await db.insert(jobRun).values({ job: "roster.refresh", startedBy: "worker" });
    await resetDb();
    expect(await db.select().from(qboCustomerType)).toHaveLength(0);
    expect(await db.select().from(jobRun)).toHaveLength(0);
  });
});
```

Add to `tests/unit/permissions/registry.test.ts`:

```ts
describe("QuickBooks and roster permissions", () => {
  it("Settings.QuickBooks.ReadWrite exists, and only the built-in Admin can hold it", () => {
    expect(PERMISSIONS).toContain("Settings.QuickBooks.ReadWrite");
    expect(ADMIN_ONLY).toContain("Settings.QuickBooks.ReadWrite");
    expect(expandRules({ include: ["*"], exclude: [] }).has("Settings.QuickBooks.ReadWrite")).toBe(false);
    expect(validateRules({ include: ["Settings.QuickBooks.ReadWrite"], exclude: [] }))
      .toContain("“Settings.QuickBooks.ReadWrite” only matches Admin permissions, which can't be given to a role.");
  });
  it("Roster.Read can be given to a custom role", () => {
    expect(GRANTABLE).toContain("Roster.Read");
    expect(expandRules({ include: ["Roster.*"], exclude: [] }).has("Roster.Read")).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run tests/integration/quickbooks-schema.test.ts tests/unit/permissions/registry.test.ts`
Expected: FAIL. The schema test can't import `qboConnection`; the registry test fails on `toContain("Settings.QuickBooks.ReadWrite")`.

- [ ] **Step 3: Add the tables**

In `src/lib/db/schema.ts`, after the `parentEmailChange` table:

```ts
export type QboEnvironment = "sandbox" | "production";

/**
 * The club's QuickBooks connection (spec §2, §3): the Intuit app's keys and, once connected, the company and its tokens.
 * One row at most (`id` is always "singleton"). The secret and both tokens are sealed (src/lib/crypto/secret-box.ts).
 */
export const qboConnection = pgTable("qbo_connection", {
  id: text("id").primaryKey().default("singleton"),
  environment: text("environment", { enum: ["sandbox", "production"] }).notNull(),
  clientId: text("client_id").notNull(),
  clientSecretCiphertext: text("client_secret_ciphertext").notNull(),
  clientSecretKeyId: text("client_secret_key_id").notNull(),
  // A connect in progress: the state sent to Intuit (SHA-256), who started it, and when it stops being accepted.
  stateHash: text("state_hash"),
  stateStaffUserId: uuid("state_staff_user_id"),
  stateExpiresAt: timestamp("state_expires_at", { withTimezone: true }),
  // Set while connected; all null again after a disconnect.
  realmId: text("realm_id"),
  companyName: text("company_name"),
  accessTokenCiphertext: text("access_token_ciphertext"),
  accessTokenKeyId: text("access_token_key_id"),
  accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
  refreshTokenCiphertext: text("refresh_token_ciphertext"),
  refreshTokenKeyId: text("refresh_token_key_id"),
  refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }),
  connectedAt: timestamp("connected_at", { withTimezone: true }),
  connectedBy: uuid("connected_by"),                 // staff_user.id
  lastTokenRefreshAt: timestamp("last_token_refresh_at", { withTimezone: true }),
  lastError: text("last_error"),                     // a fixed sentence and a short code, never a response body
  lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
  updatedAt: updated(),
});

/** A reference copy of QuickBooks' customer types (spec §2). Replaced on every refresh. */
export const qboCustomerType = pgTable("qbo_customer_type", {
  qboId: text("qbo_id").primaryKey(),
  name: text("name").notNull(),
  active: boolean("active").notNull(),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A reference copy of QuickBooks' customers (spec §2). Never a source of truth. Email and phone are kept only for
 * customers whose type the membership shape names.
 */
export const qboCustomer = pgTable("qbo_customer", {
  qboId: text("qbo_id").primaryKey(),
  displayName: text("display_name").notNull(),
  active: boolean("active").notNull(),
  parentQboId: text("parent_qbo_id"),
  typeQboId: text("type_qbo_id"),
  email: text("email"),
  phone: text("phone"),
  syncToken: text("sync_token").notNull(),
  qboUpdatedAt: timestamp("qbo_updated_at", { withTimezone: true }),
  refreshedAt: timestamp("refreshed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("qbo_customer_parent_ix").on(t.parentQboId), index("qbo_customer_type_ix").on(t.typeQboId)]);

/** One row per run of a scheduled or hand-started job (spec §4). `outcome` is null while it runs. */
export const jobRun = pgTable("job_run", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  job: text("job").notNull(),                        // "quickbooks.token_refresh" | "roster.refresh"
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  outcome: text("outcome", { enum: ["ok", "failed"] }),
  detail: text("detail"),                            // counts, or a fixed sentence and a code
  startedBy: text("started_by").notNull(),           // "worker" or a staff_user.id
}, (t) => [index("job_run_job_ix").on(t.job, t.startedAt)]);
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate --name quickbooks`
Expected: creates `drizzle/0007_quickbooks.sql` with four `CREATE TABLE` statements and three `CREATE INDEX` statements,
and adds entry `0007_quickbooks` to `drizzle/meta/_journal.json`. It must contain no `ALTER` or `DROP` of an existing table;
if it does, the schema edit touched something else: undo that and generate again.

Then apply it to the test database:
`DATABASE_URL=postgres://booster:booster@localhost:5433/booster_test APP_URL=http://localhost:3100 BETTER_AUTH_SECRET=ci-fake-secret-ci-fake-secret-1234567890 SETTINGS_ENCRYPTION_KEY=Y2ktZmFrZS1rZXktY2ktZmFrZS1rZXktY2ktZmFrZSE= pnpm db:migrate`
Expected: `migrated`.

- [ ] **Step 5: Add the permissions and the test helper tables**

`src/lib/permissions/registry.ts`: add to `PERMISSIONS`, after `"Settings.Mail.ReadWrite"`:

```ts
  "Settings.QuickBooks.ReadWrite", // admin-only: connect QuickBooks and choose the membership shape; it reaches the club's books
  "Roster.Read",                   // see families, students and parents (or members) as QuickBooks lists them
```

and add `"Settings.QuickBooks.ReadWrite"` to the `ADMIN_ONLY` array.

`tests/helpers/db.ts`: add `"qbo_connection", "qbo_customer", "qbo_customer_type", "job_run"` to `TABLES`, after
`"parent_email_change"`.

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm vitest run tests/integration/quickbooks-schema.test.ts tests/unit/permissions/registry.test.ts tests/integration/invariants.test.ts`
Expected: PASS.

- [ ] **Step 7: Full checks and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all clean; the suite passes with the new tests added.

```bash
git add src/lib/db/schema.ts src/lib/permissions/registry.ts drizzle tests/helpers/db.ts tests/integration/quickbooks-schema.test.ts tests/unit/permissions/registry.test.ts
git commit -m "feat(db): tables for the QuickBooks connection, the customer cache and job runs

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 3: The QuickBooks connection

**Files:**
- Create: `src/lib/quickbooks/endpoints.ts`, `src/lib/quickbooks/client.ts`, `src/lib/quickbooks/connection.ts`
- Create: `tests/helpers/qbo-stub.ts`, `tests/integration/quickbooks-connection.test.ts`, `tests/integration/quickbooks-client.test.ts`, `tests/unit/quickbooks-read-only.test.ts`

**Interfaces:**
- Consumes: `qboConnection`, `QboEnvironment` (Task 2); `secretBox()`, `SecretBoxError` from `@/lib/crypto/secret-box`;
  `writeAudit`, `Actor` from `@/lib/audit/log`; `env` from `@/env`.
- Produces:
  - `endpoints.ts`: `qboEndpoints(): QboEndpoints`, `QBO_SCOPE`, `QBO_MINOR_VERSION`, `class QboError extends Error { code: string }`.
  - `client.ts`: `QBO_AAD`, `WORKER_ACTOR`, `tokenRequest(form, app)`, `sealTokens(t)`,
    `accessToken(o?: { force?: boolean }): Promise<{ token: string; realmId: string; environment: QboEnvironment }>`,
    `qboGet(path: string, params?: Record<string, string>): Promise<unknown>`,
    `qboQueryAll(entity: "Customer" | "CustomerType", where?: string): Promise<Record<string, unknown>[]>`, `QBO_PAGE = 1000`.
  - `connection.ts`: `type QboOp = { actor: Actor; ip: string | null; permission?: string }`, `getConnection(tx?)`,
    `parseQboAppForm(f, hasSecret)`, `saveQboApp(draft, o)`, `qboRedirectUri()`,
    `beginConnect(staffUserId): Promise<{ ok: true; url: string } | { ok: false; reason: "not_configured" }>`,
    `completeConnect(p, o): Promise<{ ok: true } | { ok: false; reason: ConnectRefusal }>` with
    `type ConnectRefusal = "state" | "denied" | "other_company" | "intuit" | "not_configured"`,
    `disconnect(o): Promise<{ ok: true; revoked: boolean } | { ok: false; reason: "not_connected" }>`,
    `connectionView(): Promise<QboConnectionView>`.
  - `tests/helpers/qbo-stub.ts`: `startQboStub(): Promise<QboStub>`, `seedConnected(stub, o?)`.

- [ ] **Step 1: Write the stub Intuit and QuickBooks server**

`tests/helpers/qbo-stub.ts`:

```ts
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "@/lib/db/client";
import { qboConnection } from "@/lib/db/schema";
import { secretBox } from "@/lib/crypto/secret-box";

export type StubCall = { method: string; path: string; query: URLSearchParams; auth: string; body: string };
export type QboStub = {
  base: string; calls: StubCall[];
  customers: Record<string, unknown>[]; types: Record<string, unknown>[]; companyName: string;
  codes: Set<string>;           // authorization codes the token endpoint accepts, once each
  accessTokens: Set<string>;    // bearer tokens the API accepts
  refreshTokens: Set<string>;   // refresh tokens the token endpoint accepts, once each (Intuit rotates them)
  failToken: string | null;     // answer token requests with this OAuth error
  failQueryFrom: number | null; // answer query number N and later with HTTP 500 (1 is the first query)
  tokenDelayMs: number; refreshExpiresIn: number;
  tokenCalls(): StubCall[]; apiCalls(): StubCall[]; reset(): void; close(): Promise<void>;
};

/** Intuit's token and revoke endpoints and the QuickBooks query API, enough for the portal's real client to talk to. */
export async function startQboStub(): Promise<QboStub> {
  let issued = 0, queries = 0;
  const stub = { calls: [], customers: [], types: [], companyName: "Stub Boosters", codes: new Set(), accessTokens: new Set(), refreshTokens: new Set(),
    failToken: null, failQueryFrom: null, tokenDelayMs: 0, refreshExpiresIn: 8_640_000 } as unknown as QboStub;
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const url = new URL(req.url!, "http://stub");
      const call: StubCall = { method: req.method!, path: url.pathname, query: url.searchParams, auth: req.headers.authorization ?? "", body };
      stub.calls.push(call);
      const json = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (url.pathname === "/token") {
        if (stub.tokenDelayMs) await new Promise((r) => setTimeout(r, stub.tokenDelayMs));
        const form = new URLSearchParams(body);
        if (stub.failToken) return json(400, { error: stub.failToken, error_description: "a description the portal must never store" });
        const grant = form.get("grant_type");
        const ok = grant === "authorization_code" ? stub.codes.delete(form.get("code") ?? "") : grant === "refresh_token" ? stub.refreshTokens.delete(form.get("refresh_token") ?? "") : false;
        if (!ok) return json(400, { error: "invalid_grant" });
        issued++;
        stub.accessTokens.add(`at-${issued}`); stub.refreshTokens.add(`rt-${issued}`);
        return json(200, { access_token: `at-${issued}`, refresh_token: `rt-${issued}`, expires_in: 3600, x_refresh_token_expires_in: stub.refreshExpiresIn, token_type: "bearer" });
      }
      if (url.pathname === "/revoke") return json(200, {});
      if (!url.pathname.startsWith("/v3/company/")) return json(404, {});
      if (!stub.accessTokens.has(call.auth.replace(/^Bearer /, ""))) return json(401, { fault: { error: [{ code: "3200" }] } });
      if (url.pathname.includes("/companyinfo/")) return json(200, { CompanyInfo: { CompanyName: stub.companyName } });
      if (url.pathname.endsWith("/query")) {
        queries++;
        if (stub.failQueryFrom !== null && queries >= stub.failQueryFrom) return json(500, { Fault: { Error: [{ Message: "a message the portal must never store" }] } });
        const q = url.searchParams.get("query") ?? "";
        const entity = /from (\w+)/i.exec(q)?.[1] ?? "";
        const start = Number(/startposition (\d+)/i.exec(q)?.[1] ?? 1), max = Number(/maxresults (\d+)/i.exec(q)?.[1] ?? 100);
        const all = entity === "CustomerType" ? stub.types
          : /active in \(true, ?false\)/i.test(q) ? stub.customers : stub.customers.filter((c) => c.Active !== false);
        const page = all.slice(start - 1, start - 1 + max);
        return json(200, { QueryResponse: page.length ? { [entity]: page, startPosition: start, maxResults: page.length } : {} });
      }
      return json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  stub.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  stub.tokenCalls = () => stub.calls.filter((c) => c.path === "/token");
  stub.apiCalls = () => stub.calls.filter((c) => c.path.startsWith("/v3/"));
  stub.reset = () => {
    issued = 0; queries = 0; stub.calls.length = 0; stub.customers = []; stub.types = []; stub.companyName = "Stub Boosters";
    stub.codes.clear(); stub.accessTokens.clear(); stub.refreshTokens.clear(); stub.failToken = null; stub.failQueryFrom = null; stub.tokenDelayMs = 0; stub.refreshExpiresIn = 8_640_000;
  };
  stub.close = () => new Promise<void>((r) => server.close(() => r()));
  return stub;
}

/** A connection row as if an Admin had connected a company: sealed tokens the stub accepts. */
export async function seedConnected(stub: QboStub, o: { realmId?: string; accessExpiresInMs?: number; refreshExpiresInMs?: number; connectedBy?: string | null } = {}) {
  const box = secretBox();
  const secret = box.seal("stub-secret", "qbo:client-secret"), access = box.seal("at-seed", "qbo:access-token"), refresh = box.seal("rt-seed", "qbo:refresh-token");
  stub.accessTokens.add("at-seed"); stub.refreshTokens.add("rt-seed");
  const now = Date.now();
  await db.insert(qboConnection).values({
    environment: "sandbox", clientId: "stub-client-id", clientSecretCiphertext: secret.ciphertext, clientSecretKeyId: secret.keyId,
    realmId: o.realmId ?? "9130000000000001", companyName: stub.companyName,
    accessTokenCiphertext: access.ciphertext, accessTokenKeyId: access.keyId, accessExpiresAt: new Date(now + (o.accessExpiresInMs ?? 3_600_000)),
    refreshTokenCiphertext: refresh.ciphertext, refreshTokenKeyId: refresh.keyId, refreshExpiresAt: new Date(now + (o.refreshExpiresInMs ?? 100 * 86_400_000)),
    connectedAt: new Date(now), connectedBy: o.connectedBy ?? null, lastTokenRefreshAt: new Date(now),
  });
}
```

Every integration test file that reaches QuickBooks starts with this block. It is how the real client is pointed at the
stub; the app has no other way to be redirected. Later tasks call it **the stub block**:

```ts
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
```

- [ ] **Step 2: Write the failing tests**

`tests/integration/quickbooks-connection.test.ts`:

```ts
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { db } from "@/lib/db/client";
import { auditLog, qboConnection } from "@/lib/db/schema";
import { parseQboAppForm, saveQboApp, beginConnect, completeConnect, disconnect, connectionView, qboRedirectUri } from "@/lib/quickbooks/connection";
import { resetDb, seedStaff } from "../helpers/db";
import { startQboStub, seedConnected, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const REALM = "9130000000000001";
const audits = async (action: string) => (await db.select().from(auditLog)).filter((r) => r.action === action);
const allAuditText = async () => JSON.stringify(await db.select().from(auditLog));
const row = async () => (await db.select().from(qboConnection))[0]!;

describe("connecting QuickBooks", () => {
  let admin: Awaited<ReturnType<typeof seedStaff>>;
  let op: { actor: { door: "staff"; id: string; label: string }; ip: string; permission: string };
  beforeEach(async () => {
    await resetDb(); stub.reset();
    admin = await seedStaff({ email: "admin@example.org", admin: true });
    op = { actor: { door: "staff", id: admin.id, label: admin.email }, ip: "203.0.113.9", permission: "Settings.QuickBooks.ReadWrite" };
  });
  const app = () => saveQboApp({ clientId: "ABclientid1234567890", clientSecret: "s3cret-value-1234567890", environment: "sandbox" }, op);
  const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
  const start = async () => { const r = await beginConnect(admin.id); if (!r.ok) throw new Error("not configured"); return stateOf(r.url); };
  const finish = (state: string | null, extra: Partial<{ code: string | null; realmId: string | null; error: string | null }> = {}) => {
    stub.codes.add("code-1");
    return completeConnect({ code: "code-1", realmId: REALM, error: null, state, ...extra }, { staffUserId: admin.id, actor: op.actor, ip: op.ip });
  };

  it("reads the Intuit app form", () => {
    expect(parseQboAppForm({ clientId: " ABclientid1234567890 ", clientSecret: " s ", environment: "sandbox" }, false))
      .toEqual({ ok: true, draft: { clientId: "ABclientid1234567890", clientSecret: "s", environment: "sandbox" } });
    expect(parseQboAppForm({ clientId: "ABclientid1234567890", clientSecret: "", environment: "production" }, true))
      .toEqual({ ok: true, draft: { clientId: "ABclientid1234567890", clientSecret: null, environment: "production" } });
    const bad = parseQboAppForm({ clientId: "no spaces allowed", clientSecret: "", environment: "live" }, false);
    expect(bad.ok).toBe(false);
    expect(bad.ok ? [] : bad.errors).toHaveLength(3);
  });

  it("saves the keys with the secret sealed, and audits without it", async () => {
    expect(await app()).toEqual({ ok: true });
    const c = await row();
    expect(c.clientId).toBe("ABclientid1234567890");
    expect(c.clientSecretCiphertext).not.toContain("s3cret");
    expect((await audits("settings.quickbooks.save"))[0]).toMatchObject({ after: { clientId: "ABclientid1234567890", environment: "sandbox", secretChanged: true } });
    expect(await allAuditText()).not.toContain("s3cret");
    expect(await saveQboApp({ clientId: "ABclientid1234567890", clientSecret: null, environment: "sandbox" }, op)).toEqual({ ok: true });
    expect((await row()).clientSecretCiphertext).toBe(c.clientSecretCiphertext);
  });

  it("sends the Admin to Intuit with a state it only keeps hashed", async () => {
    await app();
    const r = await beginConnect(admin.id);
    expect(r.ok).toBe(true);
    const url = new URL(r.ok ? r.url : "http://x");
    expect(`${url.origin}${url.pathname}`).toBe(`${stub.base}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "ABclientid1234567890", response_type: "code", scope: "com.intuit.quickbooks.accounting", redirect_uri: qboRedirectUri() });
    const state = url.searchParams.get("state")!;
    expect(state.length).toBeGreaterThanOrEqual(40);
    expect((await row()).stateHash).not.toBe(state);
  });

  it("refuses to start before the keys are saved", async () => {
    expect(await beginConnect(admin.id)).toEqual({ ok: false, reason: "not_configured" });
  });

  it("stores sealed tokens and the company on a good return", async () => {
    await app();
    expect(await finish(await start())).toEqual({ ok: true });
    const c = await row();
    expect(c).toMatchObject({ realmId: REALM, companyName: "Stub Boosters", connectedBy: admin.id, stateHash: null });
    expect(c.accessTokenCiphertext).not.toContain("at-1");
    expect(c.refreshExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 99 * 86_400_000);
    expect((await audits("quickbooks.connect"))[0]).toMatchObject({ after: { companyName: "Stub Boosters", realmId: REALM, environment: "sandbox" }, ip: "203.0.113.9" });
    const text = await allAuditText();
    for (const secret of ["at-1", "rt-1", "code-1", "s3cret"]) expect(text).not.toContain(secret);
    const token = stub.tokenCalls()[0]!;
    expect(token.auth).toBe(`Basic ${Buffer.from("ABclientid1234567890:s3cret-value-1234567890").toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(token.body))).toEqual({ grant_type: "authorization_code", code: "code-1", redirect_uri: qboRedirectUri() });
    expect(await connectionView()).toMatchObject({ configured: true, connected: true, companyName: "Stub Boosters", environment: "sandbox" });
  });

  it.each([
    ["a wrong state", async () => { await start(); return "not-the-state"; }],
    ["no state", async () => { await start(); return null; }],
    ["a state another Admin started", async () => { const other = await seedStaff({ email: "other@example.org", admin: true }); const r = await beginConnect(other.id); return r.ok ? stateOf(r.url) : null; }],
    ["a state more than 10 minutes old", async () => { const s = await start(); await db.update(qboConnection).set({ stateExpiresAt: new Date(Date.now() - 1000) }); return s; }],
  ])("refuses %s, stores nothing and audits it", async (_name, make) => {
    await app();
    expect(await finish(await make())).toEqual({ ok: false, reason: "state" });
    expect((await row()).realmId).toBeNull();
    expect(stub.tokenCalls()).toHaveLength(0);
    expect((await audits("quickbooks.connect_refused"))[0]).toMatchObject({ after: { reason: "state" } });
  });

  it("a state works once", async () => {
    await app();
    const s = await start();
    expect(await finish(s)).toEqual({ ok: true });
    expect(await finish(s)).toEqual({ ok: false, reason: "state" });
    expect(stub.tokenCalls()).toHaveLength(1);
  });

  it("only the latest state works", async () => {
    await app();
    const first = await start(), second = await start();
    expect(await finish(first)).toEqual({ ok: false, reason: "state" });
    expect(await finish(second)).toEqual({ ok: true });
  });

  it("refuses when the Admin said no at Intuit", async () => {
    await app();
    expect(await finish(await start(), { code: null, error: "access_denied" })).toEqual({ ok: false, reason: "denied" });
    expect((await audits("quickbooks.connect_refused"))[0]).toMatchObject({ after: { reason: "denied" } });
  });

  it("refuses a different company than the one connected, and keeps the connection", async () => {
    await seedConnected(stub, { realmId: REALM });
    const before = await row();
    expect(await finish(await start(), { realmId: "9130000000000002" })).toEqual({ ok: false, reason: "other_company" });
    expect(await row()).toMatchObject({ realmId: REALM, accessTokenCiphertext: before.accessTokenCiphertext });
    expect(stub.tokenCalls()).toHaveLength(0);
  });

  it("refuses when Intuit won't take the code, with Intuit's code and none of its text", async () => {
    await app();
    const s = await start();
    stub.failToken = "invalid_client";
    expect(await finish(s)).toEqual({ ok: false, reason: "intuit" });
    expect((await audits("quickbooks.connect_refused"))[0]).toMatchObject({ after: { reason: "intuit", code: "invalid_client" } });
    expect(await allAuditText()).not.toContain("a description the portal must never store");
  });

  it("won't change the Client ID or the environment while connected", async () => {
    await seedConnected(stub);
    const r = await saveQboApp({ clientId: "ABotherclient1234567", clientSecret: null, environment: "sandbox" }, op);
    expect(r).toEqual({ ok: false, errors: ["Disconnect QuickBooks before changing the Client ID or the environment."] });
    expect(await saveQboApp({ clientId: "stub-client-id", clientSecret: "a-new-secret-value-123", environment: "sandbox" }, op)).toEqual({ ok: true });
  });

  it("disconnects: asks Intuit to revoke, forgets the tokens, keeps the keys", async () => {
    await seedConnected(stub);
    expect(await disconnect(op)).toEqual({ ok: true, revoked: true });
    expect(stub.calls.some((c) => c.path === "/revoke" && c.method === "POST" && JSON.parse(c.body).token === "rt-seed")).toBe(true);
    expect(await row()).toMatchObject({ clientId: "stub-client-id", realmId: null, accessTokenCiphertext: null, refreshTokenCiphertext: null, companyName: null });
    expect((await audits("quickbooks.disconnect"))[0]).toMatchObject({ before: { companyName: "Stub Boosters" }, after: { revoked: true } });
    expect(await connectionView()).toMatchObject({ configured: true, connected: false });
    expect(await disconnect(op)).toEqual({ ok: false, reason: "not_connected" });
  });
});
```

`tests/integration/quickbooks-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});

import { db } from "@/lib/db/client";
import { auditLog, qboConnection } from "@/lib/db/schema";
import { accessToken, qboGet, qboQueryAll } from "@/lib/quickbooks/client";
import { QboError } from "@/lib/quickbooks/endpoints";
import { resetDb } from "../helpers/db";
import { startQboStub, seedConnected, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());
beforeEach(async () => { await resetDb(); stub.reset(); });

const row = async () => (await db.select().from(qboConnection))[0]!;
const codeOf = async (p: Promise<unknown>) => { try { await p; return "no error"; } catch (e) { return e instanceof QboError ? e.code : `other: ${String(e)}`; } };

describe("the QuickBooks client", () => {
  it("uses a fresh access token without asking Intuit", async () => {
    await seedConnected(stub);
    expect((await accessToken()).token).toBe("at-seed");
    expect(stub.tokenCalls()).toHaveLength(0);
  });

  it("refreshes a token that is within 5 minutes of expiring, and saves the new refresh token", async () => {
    await seedConnected(stub, { accessExpiresInMs: 4 * 60_000 });
    expect((await accessToken()).token).toBe("at-1");
    expect(Object.fromEntries(new URLSearchParams(stub.tokenCalls()[0]!.body))).toEqual({ grant_type: "refresh_token", refresh_token: "rt-seed" });
    await db.update(qboConnection).set({ accessExpiresAt: new Date(Date.now() - 1000) });
    expect((await accessToken()).token).toBe("at-2");
    expect(Object.fromEntries(new URLSearchParams(stub.tokenCalls()[1]!.body))).toMatchObject({ refresh_token: "rt-1" });
    expect((await row()).lastTokenRefreshAt!.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it("two callers at once spend the refresh token once", async () => {
    await seedConnected(stub, { accessExpiresInMs: -1000 });
    stub.tokenDelayMs = 150;
    const [a, b] = await Promise.all([accessToken(), accessToken()]);
    expect(a.token).toBe("at-1");
    expect(b.token).toBe("at-1");
    expect(stub.tokenCalls()).toHaveLength(1);
  });

  it("records a refused refresh with Intuit's code, never its text, and throws", async () => {
    await seedConnected(stub, { accessExpiresInMs: -1000 });
    stub.failToken = "invalid_grant";
    expect(await codeOf(accessToken())).toBe("invalid_grant");
    const c = await row();
    expect(c.lastError).toBe("Intuit no longer accepts this connection. Connect QuickBooks again. (invalid_grant)");
    expect(c.lastErrorAt).not.toBeNull();
    const audit = (await db.select().from(auditLog)).filter((r) => r.action === "quickbooks.token_refresh.failed");
    expect(audit[0]).toMatchObject({ door: "system", after: { code: "invalid_grant" } });
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain("a description the portal must never store");
  });

  it("clears the recorded error when a later refresh works", async () => {
    await seedConnected(stub, { accessExpiresInMs: -1000 });
    stub.failToken = "server_error";
    await codeOf(accessToken());
    stub.failToken = null;
    await accessToken();
    expect((await row()).lastError).toBeNull();
  });

  it("says QuickBooks isn't connected when there is no connection", async () => {
    expect(await codeOf(accessToken())).toBe("not_connected");
  });

  it("refreshes once and tries again when QuickBooks says the token is no good", async () => {
    await seedConnected(stub);
    stub.accessTokens.delete("at-seed");
    expect(await qboGet("companyinfo/9130000000000001")).toEqual({ CompanyInfo: { CompanyName: "Stub Boosters" } });
    expect(stub.tokenCalls()).toHaveLength(1);
    expect(stub.apiCalls().map((c) => c.auth)).toEqual(["Bearer at-seed", "Bearer at-1"]);
    expect(stub.apiCalls().every((c) => c.query.get("minorversion") === "75")).toBe(true);
  });

  it("reads every page of a query", { timeout: 30_000 }, async () => {
    await seedConnected(stub);
    stub.customers = Array.from({ length: 2050 }, (_, i) => ({ Id: String(i + 1), DisplayName: `Customer ${i + 1}`, Active: i % 10 !== 0 }));
    const rows = await qboQueryAll("Customer", "Active in (true, false)");
    expect(rows).toHaveLength(2050);
    expect(stub.apiCalls().map((c) => /startposition (\d+)/.exec(c.query.get("query")!)![1])).toEqual(["1", "1001", "2001"]);
  });

  it("turns a QuickBooks failure into a short code", async () => {
    await seedConnected(stub);
    stub.failQueryFrom = 1;
    expect(await codeOf(qboQueryAll("Customer"))).toBe("http_500");
  });

  it("sends nothing but GET to the QuickBooks API", async () => {
    await seedConnected(stub, { accessExpiresInMs: -1000 });
    await qboGet("companyinfo/9130000000000001");
    await qboQueryAll("CustomerType");
    expect(stub.apiCalls().length).toBeGreaterThan(0);
    expect(stub.apiCalls().every((c) => c.method === "GET")).toBe(true);
  });
});
```

`tests/unit/quickbooks-read-only.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const read = (dir: string) => (existsSync(path.resolve(dir)) ? readdirSync(path.resolve(dir), { recursive: true }).map(String) : [])
  .filter((f) => /\.tsx?$/.test(f)).map((f) => ({ file: `${dir}/${f.replaceAll("\\", "/")}`, text: readFileSync(path.resolve(dir, f), "utf8") }));

describe("the portal writes nothing to QuickBooks (spec §3)", () => {
  const sources = [...read("src/lib/quickbooks"), ...read("src/lib/roster"), ...read("src/lib/jobs")];
  it("finds the QuickBooks code", () => { expect(sources.length).toBeGreaterThan(2); });
  it("uses no write method anywhere", () => {
    for (const s of sources) expect(s.text, s.file).not.toMatch(/method:\s*["'](PUT|PATCH|DELETE)["']/);
  });
  it("writes nothing to the log, so no token or response body can end up there (spec §7)", () => {
    for (const s of sources) expect(s.text, s.file).not.toMatch(/console\.\w+\(/);
  });
  it("posts only to Intuit's token and revoke endpoints", () => {
    const posts = sources.flatMap((s) => [...s.text.matchAll(/method:\s*["']POST["']/g)].map(() => s.file));
    expect(posts.sort()).toEqual(["src/lib/quickbooks/client.ts", "src/lib/quickbooks/connection.ts"]);
    const client = sources.find((s) => s.file === "src/lib/quickbooks/client.ts")!.text;
    expect(client.slice(client.indexOf("export async function qboGet"))).not.toMatch(/method:\s*["']POST["']/);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm vitest run tests/integration/quickbooks-connection.test.ts tests/integration/quickbooks-client.test.ts tests/unit/quickbooks-read-only.test.ts`
Expected: FAIL. The modules under `src/lib/quickbooks/` don't exist.

- [ ] **Step 4: Write `src/lib/quickbooks/endpoints.ts`**

```ts
import type { QboEnvironment } from "@/lib/db/schema";

export type QboEndpoints = { authorize: string; token: string; revoke: string; api: Record<QboEnvironment, string> };

const INTUIT: QboEndpoints = {
  authorize: "https://appcenter.intuit.com/connect/oauth2",
  token: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
  revoke: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
  api: { sandbox: "https://sandbox-quickbooks.api.intuit.com", production: "https://quickbooks.api.intuit.com" },
};

/** Where Intuit and QuickBooks live. A function so integration tests can replace it (vi.mock) with a stub server; the app has no other switch. */
export function qboEndpoints(): QboEndpoints { return INTUIT; }

export const QBO_SCOPE = "com.intuit.quickbooks.accounting";
export const QBO_MINOR_VERSION = "75";

/** A QuickBooks or Intuit failure, already reduced to a sentence that is safe to show and a short code (spec §2). */
export class QboError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = "QboError"; }
}
```

- [ ] **Step 5: Write `src/lib/quickbooks/client.ts`**

```ts
import { db } from "@/lib/db/client";
import { qboConnection, type QboEnvironment } from "@/lib/db/schema";
import { secretBox, SecretBoxError } from "@/lib/crypto/secret-box";
import { writeAudit } from "@/lib/audit/log";
import { qboEndpoints, QboError, QBO_MINOR_VERSION } from "./endpoints";

const TIMEOUT_MS = 15_000;
const REFRESH_EARLY_MS = 5 * 60_000;
export const QBO_PAGE = 1000;
export const QBO_AAD = { secret: "qbo:client-secret", access: "qbo:access-token", refresh: "qbo:refresh-token" } as const;
export const WORKER_ACTOR = { door: "system", id: null, label: "worker" } as const;

export type TokenSet = { accessToken: string; refreshToken: string; accessExpiresAt: Date; refreshExpiresAt: Date };
export type QboApp = { clientId: string; clientSecret: string };

/** One request to Intuit's token endpoint (a code exchange or a refresh). Failures keep Intuit's error code and none of its text. */
export async function tokenRequest(form: Record<string, string>, app: QboApp): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetch(qboEndpoints().token, {
      method: "POST", body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error",
      headers: { authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString("base64")}`, accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    });
  } catch {
    throw new QboError("Couldn't reach Intuit.", "unreachable");
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; x_refresh_token_expires_in?: unknown; error?: unknown };
  if (!res.ok || typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
    const code = typeof body.error === "string" && /^[a-z_]{1,40}$/.test(body.error) ? body.error : `http_${res.status}`;
    throw new QboError(code === "invalid_grant" ? "Intuit no longer accepts this connection. Connect QuickBooks again." : "Intuit refused the request.", code);
  }
  const seconds = (v: unknown, fallback: number) => (typeof v === "number" && v > 0 ? v : fallback);
  const now = Date.now();
  return {
    accessToken: body.access_token, refreshToken: body.refresh_token,
    accessExpiresAt: new Date(now + seconds(body.expires_in, 3600) * 1000),
    refreshExpiresAt: new Date(now + seconds(body.x_refresh_token_expires_in, 100 * 86_400) * 1000),
  };
}

/** The columns that hold a token set, sealed, with the refresh recorded and any earlier error cleared. */
export function sealTokens(t: TokenSet) {
  const box = secretBox();
  const access = box.seal(t.accessToken, QBO_AAD.access), refresh = box.seal(t.refreshToken, QBO_AAD.refresh);
  return {
    accessTokenCiphertext: access.ciphertext, accessTokenKeyId: access.keyId, accessExpiresAt: t.accessExpiresAt,
    refreshTokenCiphertext: refresh.ciphertext, refreshTokenKeyId: refresh.keyId, refreshExpiresAt: t.refreshExpiresAt,
    lastTokenRefreshAt: new Date(), lastError: null, lastErrorAt: null, updatedAt: new Date(),
  };
}

type Access = { token: string; realmId: string; environment: QboEnvironment };

/**
 * A usable access token. Refreshes it when it is expired or within 5 minutes of expiring (or when `force` is set), under
 * a lock on the connection row: Intuit's refresh token works once, so two callers must never both spend it (spec §4).
 */
export async function accessToken(o: { force?: boolean } = {}): Promise<Access> {
  const r = await db.transaction(async (tx): Promise<{ ok: true; access: Access } | { ok: false; error: QboError }> => {
    const [c] = await tx.select().from(qboConnection).for("update");
    if (!c?.realmId || !c.refreshTokenCiphertext || !c.refreshTokenKeyId) return { ok: false, error: new QboError("QuickBooks isn't connected.", "not_connected") };
    const box = secretBox();
    try {
      if (!o.force && c.accessTokenCiphertext && c.accessTokenKeyId && c.accessExpiresAt && c.accessExpiresAt.getTime() - Date.now() > REFRESH_EARLY_MS) {
        return { ok: true, access: { token: box.open({ ciphertext: c.accessTokenCiphertext, keyId: c.accessTokenKeyId }, QBO_AAD.access), realmId: c.realmId, environment: c.environment } };
      }
      const t = await tokenRequest(
        { grant_type: "refresh_token", refresh_token: box.open({ ciphertext: c.refreshTokenCiphertext, keyId: c.refreshTokenKeyId }, QBO_AAD.refresh) },
        { clientId: c.clientId, clientSecret: box.open({ ciphertext: c.clientSecretCiphertext, keyId: c.clientSecretKeyId }, QBO_AAD.secret) });
      await tx.update(qboConnection).set(sealTokens(t));
      return { ok: true, access: { token: t.accessToken, realmId: c.realmId, environment: c.environment } };
    } catch (e) {
      const error = e instanceof QboError ? e
        : e instanceof SecretBoxError ? new QboError("The saved QuickBooks keys can't be read with this server's encryption key. Connect QuickBooks again.", "unreadable")
        : null;
      if (!error) throw e;
      // Returned, not thrown, so this record of the failure is committed.
      await tx.update(qboConnection).set({ lastError: `${error.message} (${error.code})`, lastErrorAt: new Date(), updatedAt: new Date() });
      await writeAudit({ actor: WORKER_ACTOR, action: "quickbooks.token_refresh.failed", targetType: "qbo_connection", targetId: "singleton", after: { code: error.code } }, tx);
      return { ok: false, error };
    }
  });
  if (!r.ok) throw r.error;
  return r.access;
}

/** GET one QuickBooks API path. This module has no way to send anything else to the API (spec §3). */
export async function qboGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    const a = await accessToken({ force: attempt === 1 });
    const url = new URL(`${qboEndpoints().api[a.environment]}/v3/company/${encodeURIComponent(a.realmId)}/${path}`);
    for (const [k, v] of Object.entries({ ...params, minorversion: QBO_MINOR_VERSION })) url.searchParams.set(k, v);
    let res: Response;
    try {
      res = await fetch(url, { method: "GET", headers: { authorization: `Bearer ${a.token}`, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
    } catch {
      throw new QboError("Couldn't reach QuickBooks.", "unreachable");
    }
    if (res.status === 401 && attempt === 0) continue; // the token was revoked or replaced: refresh once and try again
    if (!res.ok) throw new QboError("QuickBooks refused the request.", `http_${res.status}`);
    try { return await res.json(); } catch { throw new QboError("QuickBooks sent an answer the portal couldn't read.", "bad_answer"); }
  }
}

/** Every row of an entity, a page at a time. `where` is fixed text from this codebase, never anything a person typed. */
export async function qboQueryAll(entity: "Customer" | "CustomerType", where = ""): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let start = 1; ; start += QBO_PAGE) {
    const body = (await qboGet("query", { query: `select * from ${entity}${where ? ` where ${where}` : ""} startposition ${start} maxresults ${QBO_PAGE}` })) as { QueryResponse?: Record<string, unknown> };
    const rows = body.QueryResponse?.[entity];
    const page = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    out.push(...page);
    if (page.length < QBO_PAGE) return out;
  }
}
```

- [ ] **Step 6: Write `src/lib/quickbooks/connection.ts`**

```ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/env";
import { db, type Tx } from "@/lib/db/client";
import { qboConnection, type QboEnvironment } from "@/lib/db/schema";
import { secretBox, SecretBoxError } from "@/lib/crypto/secret-box";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { qboEndpoints, QboError, QBO_SCOPE } from "./endpoints";
import { QBO_AAD, qboGet, sealTokens, tokenRequest, type TokenSet } from "./client";

export type QboOp = { actor: Actor; ip: string | null; permission?: string };
export type QboAppDraft = { clientId: string; clientSecret: string | null; environment: QboEnvironment };
export type ConnectRefusal = "state" | "denied" | "other_company" | "intuit" | "not_configured";
export type QboConnectionView = {
  configured: boolean; clientId: string | null; environment: QboEnvironment | null; connected: boolean; companyName: string | null;
  connectedAt: string | null; lastTokenRefreshAt: string | null; refreshExpiresAt: string | null; lastError: string | null; lastErrorAt: string | null;
};

const STATE_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 15_000;
const TARGET = { targetType: "qbo_connection", targetId: "singleton" } as const;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;
const DISCONNECTED = {
  realmId: null, companyName: null, accessTokenCiphertext: null, accessTokenKeyId: null, accessExpiresAt: null, refreshTokenCiphertext: null,
  refreshTokenKeyId: null, refreshExpiresAt: null, connectedAt: null, connectedBy: null, lastTokenRefreshAt: null, lastError: null, lastErrorAt: null,
  stateHash: null, stateStaffUserId: null, stateExpiresAt: null,
} as const;

export async function getConnection(tx?: Tx) {
  const [c] = await (tx ?? db).select().from(qboConnection);
  return c ?? null;
}

/** The address Intuit returns the Admin to. It must be listed, exactly, on the Intuit app. */
export function qboRedirectUri(): string { return `${env.APP_URL.replace(/\/+$/, "")}/api/quickbooks/callback`; }

/** What the settings pages may show: never the secret, a token or the company's ID. */
export async function connectionView(): Promise<QboConnectionView> {
  const c = await getConnection();
  return {
    configured: c !== null, clientId: c?.clientId ?? null, environment: c?.environment ?? null, connected: Boolean(c?.realmId && c.refreshTokenCiphertext),
    companyName: c?.companyName ?? null, connectedAt: iso(c?.connectedAt), lastTokenRefreshAt: iso(c?.lastTokenRefreshAt),
    refreshExpiresAt: iso(c?.refreshExpiresAt), lastError: c?.lastError ?? null, lastErrorAt: iso(c?.lastErrorAt),
  };
}

export function parseQboAppForm(f: Record<string, string>, hasSecret: boolean): { ok: true; draft: QboAppDraft } | { ok: false; errors: string[] } {
  const clientId = (f.clientId ?? "").trim(), secret = (f.clientSecret ?? "").trim(), environment = (f.environment ?? "").trim();
  const errors: string[] = [];
  if (!/^[\w-]{10,200}$/.test(clientId)) errors.push("Enter the Client ID from your Intuit app's Keys and credentials page.");
  if (!secret && !hasSecret) errors.push("Enter the Client secret from your Intuit app's Keys and credentials page.");
  if (secret.length > 500) errors.push("That Client secret is too long.");
  if (environment !== "sandbox" && environment !== "production") errors.push("Choose sandbox or production.");
  return errors.length ? { ok: false, errors } : { ok: true, draft: { clientId, clientSecret: secret || null, environment: environment as QboEnvironment } };
}

/** Saves the Intuit app's keys. A blank secret keeps the saved one. */
export async function saveQboApp(d: QboAppDraft, o: QboOp): Promise<{ ok: true } | { ok: false; errors: string[] }> {
  return db.transaction(async (tx) => {
    const [c] = await tx.select().from(qboConnection).for("update");
    if (c?.realmId && (c.clientId !== d.clientId || c.environment !== d.environment)) {
      return { ok: false as const, errors: ["Disconnect QuickBooks before changing the Client ID or the environment."] };
    }
    if (!c && !d.clientSecret) return { ok: false as const, errors: ["Enter the Client secret from your Intuit app's Keys and credentials page."] };
    const sealed = d.clientSecret ? secretBox().seal(d.clientSecret, QBO_AAD.secret) : null;
    const secret = sealed ? { clientSecretCiphertext: sealed.ciphertext, clientSecretKeyId: sealed.keyId } : {};
    if (c) await tx.update(qboConnection).set({ clientId: d.clientId, environment: d.environment, ...secret, updatedAt: new Date() });
    else await tx.insert(qboConnection).values({ clientId: d.clientId, environment: d.environment, clientSecretCiphertext: sealed!.ciphertext, clientSecretKeyId: sealed!.keyId });
    await writeAudit({ actor: o.actor, action: "settings.quickbooks.save", permission: o.permission, ...TARGET, ip: o.ip,
      before: c ? { clientId: c.clientId, environment: c.environment } : null,
      after: { clientId: d.clientId, environment: d.environment, secretChanged: sealed !== null } }, tx);
    return { ok: true as const };
  });
}

/** Starts a connect: a new single-use state for this Admin (replacing any earlier one) and the Intuit address to send them to. */
export async function beginConnect(staffUserId: string): Promise<{ ok: true; url: string } | { ok: false; reason: "not_configured" }> {
  const state = randomBytes(32).toString("base64url");
  const [c] = await db.update(qboConnection).set({ stateHash: sha256(state), stateStaffUserId: staffUserId, stateExpiresAt: new Date(Date.now() + STATE_TTL_MS), updatedAt: new Date() }).returning();
  if (!c) return { ok: false, reason: "not_configured" };
  const q = new URLSearchParams({ client_id: c.clientId, response_type: "code", scope: QBO_SCOPE, redirect_uri: qboRedirectUri(), state });
  return { ok: true, url: `${qboEndpoints().authorize}?${q}` };
}

/** Finishes a connect when Intuit sends the Admin back (spec §3 Rules for the connection). */
export async function completeConnect(
  p: { code: string | null; state: string | null; realmId: string | null; error: string | null },
  o: { staffUserId: string; actor: Actor; ip: string | null },
): Promise<{ ok: true } | { ok: false; reason: ConnectRefusal }> {
  const refuse = async (reason: ConnectRefusal, code?: string) => {
    await writeAudit({ actor: o.actor, action: "quickbooks.connect_refused", ...TARGET, after: code ? { reason, code } : { reason }, ip: o.ip });
    return { ok: false as const, reason };
  };
  // 1. Spend the state. It is cleared only when it matches, so a stray return can't cancel a connect in progress.
  const claim = await db.transaction(async (tx): Promise<{ ok: true; clientId: string; clientSecret: string; environment: QboEnvironment } | { ok: false; reason: ConnectRefusal }> => {
    const [c] = await tx.select().from(qboConnection).for("update");
    if (!c) return { ok: false, reason: "not_configured" };
    const given = Buffer.from(sha256(p.state ?? ""), "hex"), kept = Buffer.from(c.stateHash ?? "", "hex");
    const good = Boolean(p.state) && kept.length === given.length && timingSafeEqual(given, kept)
      && c.stateStaffUserId === o.staffUserId && c.stateExpiresAt !== null && c.stateExpiresAt.getTime() > Date.now();
    if (!good) return { ok: false, reason: "state" };
    await tx.update(qboConnection).set({ stateHash: null, stateStaffUserId: null, stateExpiresAt: null, updatedAt: new Date() });
    if (p.error || !p.code || !p.realmId) return { ok: false, reason: "denied" };
    if (c.realmId && c.realmId !== p.realmId) return { ok: false, reason: "other_company" };
    try {
      return { ok: true, clientId: c.clientId, environment: c.environment, clientSecret: secretBox().open({ ciphertext: c.clientSecretCiphertext, keyId: c.clientSecretKeyId }, QBO_AAD.secret) };
    } catch (e) {
      if (e instanceof SecretBoxError) return { ok: false, reason: "not_configured" };
      throw e;
    }
  });
  if (!claim.ok) return refuse(claim.reason);
  // 2. Exchange the code. No row lock is held while Intuit answers.
  let tokens: TokenSet;
  try {
    tokens = await tokenRequest({ grant_type: "authorization_code", code: p.code!, redirect_uri: qboRedirectUri() }, claim);
  } catch (e) {
    if (e instanceof QboError) return refuse("intuit", e.code);
    throw e;
  }
  // 3. Store the connection, unless another company got connected while Intuit was answering.
  const stored = await db.transaction(async (tx) => {
    const [c] = await tx.select().from(qboConnection).for("update");
    if (!c || (c.realmId && c.realmId !== p.realmId)) return false;
    await tx.update(qboConnection).set({ realmId: p.realmId, connectedAt: new Date(), connectedBy: o.staffUserId, ...sealTokens(tokens) });
    return true;
  });
  if (!stored) return refuse("other_company");
  // 4. The company's name, for people. The connection stands even if this read fails.
  let companyName: string | null = null;
  try {
    const info = (await qboGet(`companyinfo/${encodeURIComponent(p.realmId!)}`)) as { CompanyInfo?: { CompanyName?: unknown } };
    if (typeof info.CompanyInfo?.CompanyName === "string") companyName = info.CompanyInfo.CompanyName.slice(0, 200);
  } catch (e) {
    if (!(e instanceof QboError)) throw e;
  }
  await db.update(qboConnection).set({ companyName, updatedAt: new Date() });
  await writeAudit({ actor: o.actor, action: "quickbooks.connect", ...TARGET, after: { companyName, realmId: p.realmId, environment: claim.environment }, ip: o.ip });
  return { ok: true };
}

/** Asks Intuit to revoke the tokens, then forgets them. The keys and the cache stay (spec §3). */
export async function disconnect(o: QboOp): Promise<{ ok: true; revoked: boolean } | { ok: false; reason: "not_connected" }> {
  const c = await getConnection();
  if (!c?.realmId || !c.refreshTokenCiphertext || !c.refreshTokenKeyId) return { ok: false, reason: "not_connected" };
  let revoked = false;
  try {
    const box = secretBox();
    const secret = box.open({ ciphertext: c.clientSecretCiphertext, keyId: c.clientSecretKeyId }, QBO_AAD.secret);
    const token = box.open({ ciphertext: c.refreshTokenCiphertext, keyId: c.refreshTokenKeyId }, QBO_AAD.refresh);
    const res = await fetch(qboEndpoints().revoke, {
      method: "POST", body: JSON.stringify({ token }), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error",
      headers: { authorization: `Basic ${Buffer.from(`${c.clientId}:${secret}`).toString("base64")}`, accept: "application/json", "content-type": "application/json" },
    });
    revoked = res.ok;
  } catch {
    revoked = false; // Intuit unreachable or the keys unreadable: the tokens are still deleted here
  }
  await db.transaction(async (tx) => {
    await tx.update(qboConnection).set({ ...DISCONNECTED, updatedAt: new Date() });
    await writeAudit({ actor: o.actor, action: "quickbooks.disconnect", permission: o.permission, ...TARGET, before: { companyName: c.companyName, realmId: c.realmId }, after: { revoked }, ip: o.ip }, tx);
  });
  return { ok: true, revoked };
}
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm vitest run tests/integration/quickbooks-connection.test.ts tests/integration/quickbooks-client.test.ts tests/unit/quickbooks-read-only.test.ts`
Expected: PASS.

- [ ] **Step 8: Full checks and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all clean.

```bash
git add src/lib/quickbooks tests/helpers/qbo-stub.ts tests/integration/quickbooks-connection.test.ts tests/integration/quickbooks-client.test.ts tests/unit/quickbooks-read-only.test.ts
git commit -m "feat(quickbooks): connect a company, keep its tokens sealed and fresh, read-only API calls

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 4: The membership shape and the cache refresh

**Files:**
- Create: `src/lib/roster/shape.ts`, `src/lib/roster/refresh.ts`
- Modify: `tests/helpers/qbo-stub.ts` (adds `fznCompany()`)
- Create: `tests/unit/roster-shape.test.ts`, `tests/integration/roster-refresh.test.ts`

**Interfaces:**
- Consumes: `getConnection`, `QboOp` (Task 3 `connection.ts`); `qboQueryAll`, `WORKER_ACTOR` (Task 3 `client.ts`); `QboError`;
  tables `qboCustomer`, `qboCustomerType`, `jobRun`, `setting`.
- Produces:
  - `shape.ts`: `SHAPE_KEY = "membership.shape"`,
    `type MembershipShape = { kind: "flat"; memberTypeIds: string[] } | { kind: "layered"; familyTypeId: string; studentTypeId: string | null; parentTypeId: string | null }`,
    `type TypeRow = { qboId: string; name: string; active: boolean }`,
    `getShape(tx?): Promise<MembershipShape | null>`, `shapeTypeIds(s: MembershipShape | null): string[]`,
    `parseShapeForm(f: ShapeForm, types: TypeRow[]): { ok: true; shape: MembershipShape } | { ok: false; errors: string[] }` with
    `type ShapeForm = { kind?: string; family?: string; student?: string; parent?: string; members?: string[] }`,
    `missingTypes(s, types): string[]`, `describeShape(s, types): string`, `saveShape(shape, o: QboOp): Promise<void>`.
  - `refresh.ts`: `ROSTER_JOB = "roster.refresh"`, `ROSTER_LOCK = 7461001`,
    `type RefreshResult = { ok: true; customers: number; types: number } | { ok: false; reason: "running" | "not_connected" | "too_soon" | "failed"; error?: string }`,
    `refreshRoster(o: { startedBy: string; actor: Actor; ip: string | null; manual?: boolean }): Promise<RefreshResult>`.
  - `qbo-stub.ts`: `fznCompany(): { types: Record<string, unknown>[]; customers: Record<string, unknown>[] }` and
    `FZN_SHAPE` (layered: family `"1"`, student `"3"`, parent `"2"`).

- [ ] **Step 1: Add the FZN-shaped fixture to the stub helper**

Append to `tests/helpers/qbo-stub.ts`:

```ts
export const FZN_SHAPE = { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" } as const;

/** A small company shaped like FZN's: Family at the top, Parent and Student under it, School and Vendor beside them. */
export function fznCompany() {
  const type = (Id: string, Name: string) => ({ Id, Name, Active: true });
  const c = (Id: string, DisplayName: string, typeId: string | null, extra: Record<string, unknown> = {}) => ({
    Id, DisplayName, Active: true, SyncToken: "0", MetaData: { LastUpdatedTime: "2026-11-01T12:00:00-06:00" },
    ...(typeId ? { CustomerTypeRef: { value: typeId } } : {}), ...extra,
  });
  const under = (id: string) => ({ ParentRef: { value: id }, Job: true });
  return {
    types: [type("1", "Family"), type("2", "Parent"), type("3", "Student"), type("4", "School"), type("5", "Vendor")],
    customers: [
      c("10", "Rivera Family", "1"),
      c("11", "Ana Rivera", "2", { ...under("10"), PrimaryEmailAddr: { Address: " Ana@Example.com " }, PrimaryPhone: { FreeFormNumber: "555-0101" } }),
      c("12", "Leo Rivera", "3", under("10")),
      c("20", "Chen Family", "1"),
      c("21", "Mei Chen", "2", under("20")),
      c("30", "Lincoln High", "4", { PrimaryEmailAddr: { Address: "office@lincoln.example" }, PrimaryPhone: { FreeFormNumber: "555-0199" } }),
      c("40", "Old Family", "1", { Active: false }),
      c("50", "Stray Student", "3"),
      c("60", "No Type At All", null),
    ],
  };
}
```

- [ ] **Step 2: Write the failing tests**

`tests/unit/roster-shape.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseShapeForm, shapeTypeIds, missingTypes, describeShape, type TypeRow } from "@/lib/roster/shape";

const types: TypeRow[] = [
  { qboId: "1", name: "Family", active: true }, { qboId: "2", name: "Parent", active: true }, { qboId: "3", name: "Student", active: true },
  { qboId: "4", name: "School", active: true },
];

describe("the membership shape", () => {
  it("reads a layered shape, with student and parent optional", () => {
    expect(parseShapeForm({ kind: "layered", family: "1", student: "3", parent: "2" }, types))
      .toEqual({ ok: true, shape: { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" } });
    expect(parseShapeForm({ kind: "layered", family: "1", student: "", parent: "" }, types))
      .toEqual({ ok: true, shape: { kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: null } });
  });
  it("reads a flat shape with one or several types, without repeats", () => {
    expect(parseShapeForm({ kind: "flat", members: ["3"] }, types)).toEqual({ ok: true, shape: { kind: "flat", memberTypeIds: ["3"] } });
    expect(parseShapeForm({ kind: "flat", members: ["3", "2", "3"] }, types)).toEqual({ ok: true, shape: { kind: "flat", memberTypeIds: ["3", "2"] } });
  });
  it.each([
    [{ kind: "layered", family: "", student: "3" }, "Choose which customer type is a family."],
    [{ kind: "layered", family: "9" }, "Choose customer types from the list."],
    [{ kind: "layered", family: "1", student: "1" }, "A customer type can have only one role."],
    [{ kind: "layered", family: "1", student: "3", parent: "3" }, "A customer type can have only one role."],
    [{ kind: "flat", members: [] }, "Choose at least one customer type for members."],
    [{ kind: "flat", members: ["9"] }, "Choose customer types from the list."],
    [{ kind: "other" }, "Choose flat or layered."],
  ])("refuses %j", (form, message) => {
    expect(parseShapeForm(form, types)).toEqual({ ok: false, errors: [message] });
  });
  it("lists the types a shape names", () => {
    expect(shapeTypeIds(null)).toEqual([]);
    expect(shapeTypeIds({ kind: "flat", memberTypeIds: ["3", "2"] })).toEqual(["3", "2"]);
    expect(shapeTypeIds({ kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: "2" })).toEqual(["1", "2"]);
  });
  it("finds types QuickBooks no longer has", () => {
    expect(missingTypes({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "8" }, types)).toEqual(["8"]);
    expect(missingTypes({ kind: "flat", memberTypeIds: ["3"] }, types)).toEqual([]);
  });
  it("says the shape in words", () => {
    expect(describeShape({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" }, types))
      .toBe("Layered: families are Family, students are Student, parents are Parent.");
    expect(describeShape({ kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: null }, types))
      .toBe("Layered: families are Family. Students and parents aren't identified in QuickBooks.");
    expect(describeShape({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null }, types))
      .toBe("Layered: families are Family, students are Student. Parents aren't identified in QuickBooks.");
    expect(describeShape({ kind: "flat", memberTypeIds: ["3", "2"] }, types)).toBe("Flat: members are Student and Parent.");
    expect(describeShape({ kind: "flat", memberTypeIds: ["8"] }, types)).toBe("Flat: members are a type QuickBooks no longer has.");
  });
});
```

`tests/integration/roster-refresh.test.ts` (starts with **the stub block** from Task 3, then):

```ts
import { sql, eq, desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, jobRun, qboCustomer, qboCustomerType, setting } from "@/lib/db/schema";
import { refreshRoster, ROSTER_JOB, ROSTER_LOCK } from "@/lib/roster/refresh";
import { saveShape, getShape, SHAPE_KEY } from "@/lib/roster/shape";
import { resetDb } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, FZN_SHAPE, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
const staffOp = { actor: { door: "staff" as const, id: "5a1e7a2e-0000-4000-8000-000000000001", label: "admin@example.org" }, ip: "203.0.113.9", permission: "Settings.QuickBooks.ReadWrite" };
const customers = async () => Object.fromEntries((await db.select().from(qboCustomer)).map((c) => [c.qboId, c]));
const lastRun = async () => (await db.select().from(jobRun).where(eq(jobRun.job, ROSTER_JOB)).orderBy(desc(jobRun.id)).limit(1))[0]!;
const audits = async (action: string) => (await db.select().from(auditLog)).filter((r) => r.action === action);

describe("the roster refresh", () => {
  beforeEach(async () => {
    await resetDb(); stub.reset();
    Object.assign(stub, fznCompany());
    await seedConnected(stub);
  });

  it("copies every customer and type, active and inactive", async () => {
    expect(await refreshRoster(worker)).toEqual({ ok: true, customers: 9, types: 5 });
    const c = await customers();
    expect(Object.keys(c).sort()).toEqual(["10", "11", "12", "20", "21", "30", "40", "50", "60"]);
    expect(c["11"]).toMatchObject({ displayName: "Ana Rivera", active: true, parentQboId: "10", typeQboId: "2", syncToken: "0" });
    expect(c["11"]!.qboUpdatedAt!.toISOString()).toBe("2026-11-01T18:00:00.000Z");
    expect(c["40"]!.active).toBe(false);
    expect(c["60"]!.typeQboId).toBeNull();
    expect((await db.select().from(qboCustomerType)).map((t) => t.name).sort()).toEqual(["Family", "Parent", "School", "Student", "Vendor"]);
    expect(stub.apiCalls().find((x) => x.query.get("query")!.includes("from Customer "))!.query.get("query")).toContain("Active in (true, false)");
  });

  it("records the run and audits it with the counts", async () => {
    await refreshRoster(worker);
    expect(await lastRun()).toMatchObject({ outcome: "ok", startedBy: "worker", detail: "9 customers, 5 customer types" });
    expect((await audits("roster.refresh"))[0]).toMatchObject({ door: "system", actorLabel: "worker", after: { customers: 9, types: 5 } });
  });

  it("keeps no contact details before a shape is chosen", async () => {
    await refreshRoster(worker);
    expect(Object.values(await customers()).filter((c) => c.email || c.phone)).toEqual([]);
  });

  it("keeps email and phone only for customers the shape names", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    const c = await customers();
    expect(c["11"]).toMatchObject({ email: "ana@example.com", phone: "555-0101" });
    expect(c["30"]).toMatchObject({ displayName: "Lincoln High", email: null, phone: null });
  });

  it("drops contact details when a shape change stops naming a type", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    await saveShape({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null }, staffOp);
    await refreshRoster(worker);
    expect((await customers())["11"]).toMatchObject({ email: null, phone: null });
    expect(await getShape()).toEqual({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null });
  });

  it("removes a customer QuickBooks no longer returns", async () => {
    await refreshRoster(worker);
    stub.customers = stub.customers.filter((c) => c.Id !== "50");
    await refreshRoster(worker);
    expect((await customers())["50"]).toBeUndefined();
  });

  it("a failure on a later page keeps the old cache", { timeout: 30_000 }, async () => {
    await refreshRoster(worker); // queries 1 (types) and 2 (customers)
    stub.customers = Array.from({ length: 1500 }, (_, i) => ({ Id: String(1000 + i), DisplayName: `New ${i}`, Active: true, SyncToken: "0" }));
    stub.failQueryFrom = 5; // query 3 is types, 4 is the first page of customers, 5 is the second page
    const r = await refreshRoster(worker);
    expect(r).toMatchObject({ ok: false, reason: "failed" });
    expect(Object.keys(await customers()).sort()).toEqual(["10", "11", "12", "20", "21", "30", "40", "50", "60"]);
    expect(await lastRun()).toMatchObject({ outcome: "failed", detail: "QuickBooks refused the request. (http_500)" });
    expect((await audits("roster.refresh.failed"))[0]).toMatchObject({ after: { code: "http_500" } });
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain("a message the portal must never store");
  });

  it("won't run twice at once", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
      expect(await refreshRoster(worker)).toEqual({ ok: false, reason: "running" });
    });
    expect(await db.select().from(qboCustomer)).toHaveLength(0);
  });

  it("limits a hand-started refresh to one every 5 minutes, but not the worker", async () => {
    const byHand = { startedBy: staffOp.actor.id, actor: staffOp.actor, ip: staffOp.ip, manual: true };
    expect(await refreshRoster(byHand)).toMatchObject({ ok: true });
    expect(await refreshRoster(byHand)).toEqual({ ok: false, reason: "too_soon" });
    expect(await refreshRoster(worker)).toMatchObject({ ok: true });
    await db.update(jobRun).set({ startedAt: new Date(Date.now() - 6 * 60_000) });
    expect(await refreshRoster(byHand)).toMatchObject({ ok: true });
    expect((await audits("roster.refresh")).at(-1)).toMatchObject({ door: "staff", actorLabel: "admin@example.org", ip: "203.0.113.9" });
  });

  it("says so when QuickBooks isn't connected", async () => {
    await resetDb();
    expect(await refreshRoster(worker)).toEqual({ ok: false, reason: "not_connected" });
  });

  it("saving the shape is audited with the type names, before and after", async () => {
    await refreshRoster(worker);
    await saveShape(FZN_SHAPE, staffOp);
    await saveShape({ kind: "flat", memberTypeIds: ["3"] }, staffOp);
    const rows = await audits("settings.membership.save");
    expect(rows[0]).toMatchObject({ before: null, after: { shape: FZN_SHAPE, words: "Layered: families are Family, students are Student, parents are Parent." }, permission: "Settings.QuickBooks.ReadWrite" });
    expect(rows[1]).toMatchObject({ before: { shape: FZN_SHAPE }, after: { words: "Flat: members are Student." } });
    expect((await db.select().from(setting).where(eq(setting.key, SHAPE_KEY)))[0]!.value).toEqual({ kind: "flat", memberTypeIds: ["3"] });
  });
});
```

The file's first lines are the vitest import and **the stub block**:

```ts
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
// ...the stub block from Task 3 goes here, before any other import...
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm vitest run tests/unit/roster-shape.test.ts tests/integration/roster-refresh.test.ts`
Expected: FAIL. `@/lib/roster/shape` and `@/lib/roster/refresh` don't exist.

- [ ] **Step 4: Write `src/lib/roster/shape.ts`**

```ts
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { setting, qboCustomerType } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import type { QboOp } from "@/lib/quickbooks/connection";

export const SHAPE_KEY = "membership.shape";

/** How the club's membership is laid out in QuickBooks, by customer type ID (spec §1). */
export type MembershipShape =
  | { kind: "flat"; memberTypeIds: string[] }
  | { kind: "layered"; familyTypeId: string; studentTypeId: string | null; parentTypeId: string | null };
export type TypeRow = { qboId: string; name: string; active: boolean };
export type ShapeForm = { kind?: string; family?: string; student?: string; parent?: string; members?: string[] };

const id = z.string().min(1).max(64);
const stored = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("flat"), memberTypeIds: z.array(id).min(1) }),
  z.object({ kind: z.literal("layered"), familyTypeId: id, studentTypeId: id.nullable(), parentTypeId: id.nullable() }),
]);

export async function getShape(tx?: Tx): Promise<MembershipShape | null> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, SHAPE_KEY));
  const parsed = stored.safeParse(row?.value);
  return parsed.success ? parsed.data : null;
}

/** The customer type IDs a shape names, in role order. */
export function shapeTypeIds(s: MembershipShape | null): string[] {
  if (!s) return [];
  return s.kind === "flat" ? s.memberTypeIds : [s.familyTypeId, s.studentTypeId, s.parentTypeId].filter((t): t is string => t !== null);
}

/** Named types that aren't in QuickBooks' list any more: the shape is broken until an Admin chooses again. */
export function missingTypes(s: MembershipShape, types: TypeRow[]): string[] {
  const known = new Set(types.map((t) => t.qboId));
  return shapeTypeIds(s).filter((t) => !known.has(t));
}

export function parseShapeForm(f: ShapeForm, types: TypeRow[]): { ok: true; shape: MembershipShape } | { ok: false; errors: string[] } {
  const known = new Set(types.map((t) => t.qboId));
  const pick = (v: string | undefined) => (v ?? "").trim() || null;
  const fail = (message: string) => ({ ok: false as const, errors: [message] });
  if (f.kind === "flat") {
    const members = [...new Set((f.members ?? []).map((m) => m.trim()).filter(Boolean))];
    if (!members.length) return fail("Choose at least one customer type for members.");
    if (members.some((m) => !known.has(m))) return fail("Choose customer types from the list.");
    return { ok: true, shape: { kind: "flat", memberTypeIds: members } };
  }
  if (f.kind === "layered") {
    const family = pick(f.family), student = pick(f.student), parent = pick(f.parent);
    if (!family) return fail("Choose which customer type is a family.");
    const named = [family, student, parent].filter((t): t is string => t !== null);
    if (named.some((t) => !known.has(t))) return fail("Choose customer types from the list.");
    if (new Set(named).size !== named.length) return fail("A customer type can have only one role.");
    return { ok: true, shape: { kind: "layered", familyTypeId: family, studentTypeId: student, parentTypeId: parent } };
  }
  return fail("Choose flat or layered.");
}

/** The shape in words, for the settings view and the audit log. */
export function describeShape(s: MembershipShape, types: TypeRow[]): string {
  const name = (t: string) => types.find((x) => x.qboId === t)?.name ?? "a type QuickBooks no longer has";
  if (s.kind === "flat") {
    const names = s.memberTypeIds.map(name);
    return `Flat: members are ${names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0]}.`;
  }
  const parts = [`families are ${name(s.familyTypeId)}`];
  if (s.studentTypeId) parts.push(`students are ${name(s.studentTypeId)}`);
  if (s.parentTypeId) parts.push(`parents are ${name(s.parentTypeId)}`);
  const blank = !s.studentTypeId && !s.parentTypeId ? " Students and parents aren't identified in QuickBooks."
    : !s.studentTypeId ? " Students aren't identified in QuickBooks." : !s.parentTypeId ? " Parents aren't identified in QuickBooks." : "";
  return `Layered: ${parts.join(", ")}.${blank}`;
}

/** Saves the shape. The caller starts a refresh afterward, so contact details follow the new shape (spec §1 Rules). */
export async function saveShape(shape: MembershipShape, o: QboOp): Promise<void> {
  await db.transaction(async (tx) => {
    const before = await getShape(tx);
    const types = await tx.select().from(qboCustomerType);
    await tx.insert(setting).values({ key: SHAPE_KEY, value: shape }).onConflictDoUpdate({ target: setting.key, set: { value: shape, updatedAt: new Date() } });
    await writeAudit({ actor: o.actor, action: "settings.membership.save", permission: o.permission, targetType: "setting", targetId: SHAPE_KEY, ip: o.ip,
      before: before ? { shape: before, words: describeShape(before, types) } : null, after: { shape, words: describeShape(shape, types) } }, tx);
  });
}
```

- [ ] **Step 5: Write `src/lib/roster/refresh.ts`**

```ts
import { sql, eq, desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { jobRun, qboCustomer, qboCustomerType } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getConnection } from "@/lib/quickbooks/connection";
import { qboQueryAll } from "@/lib/quickbooks/client";
import { QboError } from "@/lib/quickbooks/endpoints";
import { getShape, shapeTypeIds } from "./shape";

export const ROSTER_JOB = "roster.refresh";
/** Postgres advisory lock held for the length of a refresh, so two never run at once (spec §2 Refreshing). */
export const ROSTER_LOCK = 7461001;
const MANUAL_GAP_MS = 5 * 60_000;
const CHUNK = 500;

export type RefreshResult =
  | { ok: true; customers: number; types: number }
  | { ok: false; reason: "running" | "not_connected" | "too_soon" | "failed"; error?: string };

type Raw = Record<string, unknown>;
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const ref = (v: unknown): string | null => text((v as { value?: unknown } | null | undefined)?.value, 64);
const isActive = (v: unknown) => v === true || v === "true";

function customerRow(c: Raw, named: Set<string>, now: Date) {
  const qboId = text(c.Id, 64);
  if (!qboId) return null;
  const typeQboId = ref(c.CustomerTypeRef);
  const keep = typeQboId !== null && named.has(typeQboId); // contact details only for customers the shape names (spec §2)
  const updated = text((c.MetaData as { LastUpdatedTime?: unknown } | undefined)?.LastUpdatedTime, 40);
  return {
    qboId, displayName: text(c.DisplayName, 500) ?? `Customer ${qboId}`, active: isActive(c.Active), parentQboId: ref(c.ParentRef), typeQboId,
    email: keep ? text((c.PrimaryEmailAddr as { Address?: unknown } | undefined)?.Address, 320)?.toLowerCase() ?? null : null,
    phone: keep ? text((c.PrimaryPhone as { FreeFormNumber?: unknown } | undefined)?.FreeFormNumber, 50) : null,
    syncToken: text(c.SyncToken, 20) ?? "0", qboUpdatedAt: updated && !Number.isNaN(Date.parse(updated)) ? new Date(updated) : null, refreshedAt: now,
  };
}

/**
 * Replaces the cache from QuickBooks: every customer type and every customer, active and inactive. QuickBooks is read
 * first; the tables change only if all of it arrived, in the same transaction, so a failure leaves the old cache whole.
 */
export async function refreshRoster(o: { startedBy: string; actor: Actor; ip: string | null; manual?: boolean }): Promise<RefreshResult> {
  const c = await getConnection();
  if (!c?.realmId || !c.refreshTokenCiphertext) return { ok: false, reason: "not_connected" };
  if (o.manual) {
    const [last] = await db.select().from(jobRun).where(eq(jobRun.job, ROSTER_JOB)).orderBy(desc(jobRun.startedAt)).limit(1);
    if (last && Date.now() - last.startedAt.getTime() < MANUAL_GAP_MS) return { ok: false, reason: "too_soon" };
  }
  return db.transaction(async (tx): Promise<RefreshResult> => {
    const [lock] = (await tx.execute(sql`select pg_try_advisory_xact_lock(${ROSTER_LOCK}) as locked`)) as unknown as { locked: boolean }[];
    if (!lock?.locked) return { ok: false, reason: "running" };
    const [run] = await tx.insert(jobRun).values({ job: ROSTER_JOB, startedBy: o.startedBy }).returning();
    let types: Raw[], customers: Raw[];
    try {
      types = await qboQueryAll("CustomerType");
      customers = await qboQueryAll("Customer", "Active in (true, false)");
    } catch (e) {
      if (!(e instanceof QboError)) throw e;
      const detail = `${e.message} (${e.code})`;
      await tx.update(jobRun).set({ finishedAt: new Date(), outcome: "failed", detail }).where(eq(jobRun.id, run!.id));
      await writeAudit({ actor: o.actor, action: "roster.refresh.failed", targetType: "job_run", targetId: String(run!.id), after: { code: e.code }, ip: o.ip }, tx);
      return { ok: false, reason: "failed", error: detail };
    }
    const now = new Date();
    const named = new Set(shapeTypeIds(await getShape(tx)));
    const typeRows = types.map((t) => ({ qboId: text(t.Id, 64), name: text(t.Name, 200) ?? "(no name)", active: isActive(t.Active), refreshedAt: now }))
      .filter((t): t is typeof t & { qboId: string } => t.qboId !== null);
    const customerRows = customers.map((x) => customerRow(x, named, now)).filter((r) => r !== null);
    await tx.delete(qboCustomerType);
    await tx.delete(qboCustomer);
    for (let i = 0; i < typeRows.length; i += CHUNK) await tx.insert(qboCustomerType).values(typeRows.slice(i, i + CHUNK)).onConflictDoNothing();
    for (let i = 0; i < customerRows.length; i += CHUNK) await tx.insert(qboCustomer).values(customerRows.slice(i, i + CHUNK)).onConflictDoNothing();
    await tx.update(jobRun).set({ finishedAt: new Date(), outcome: "ok", detail: `${customerRows.length} customers, ${typeRows.length} customer types` }).where(eq(jobRun.id, run!.id));
    await writeAudit({ actor: o.actor, action: "roster.refresh", targetType: "job_run", targetId: String(run!.id), after: { customers: customerRows.length, types: typeRows.length }, ip: o.ip }, tx);
    return { ok: true, customers: customerRows.length, types: typeRows.length };
  });
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm vitest run tests/unit/roster-shape.test.ts tests/integration/roster-refresh.test.ts tests/unit/quickbooks-read-only.test.ts`
Expected: PASS.

- [ ] **Step 7: Full checks and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all clean.

```bash
git add src/lib/roster tests/helpers/qbo-stub.ts tests/unit/roster-shape.test.ts tests/integration/roster-refresh.test.ts
git commit -m "feat(roster): the membership shape, and a cache of QuickBooks customers that refreshes whole or not at all

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 5: Families, members and Needs attention

**Files:**
- Create: `src/lib/roster/model.ts`, `src/lib/roster/attention.ts`, `src/lib/roster/queries.ts`
- Create: `tests/unit/roster-model.test.ts`, `tests/unit/roster-attention.test.ts`, `tests/integration/roster-queries.test.ts`

**Interfaces:**
- Consumes: `MembershipShape`, `TypeRow`, `getShape`, `missingTypes`, `describeShape` (Task 4); `ROSTER_JOB` (Task 4);
  `connectionView` (Task 3); tables `qboCustomer`, `qboCustomerType`, `jobRun`, `guardian`, `parent`.
- Produces:
  - `model.ts`: `type Cust = { qboId: string; displayName: string; active: boolean; parentQboId: string | null; typeQboId: string | null; email: string | null; phone: string | null }`,
    `type Family = { customer: Cust; students: Cust[]; parents: Cust[] }`,
    `type Roster = { kind: "flat"; members: Cust[]; outside: number } | { kind: "layered"; families: Family[]; strays: Cust[]; outside: number }`,
    `buildRoster(shape: MembershipShape, customers: Cust[]): Roster`.
  - `attention.ts`: `type SignIn = { guardianId: string; familyQboId: string; name: string; email: string; status: "invited" | "active" | "disabled" }`,
    `type AttentionRule = "family_no_parent" | "family_no_student" | "not_under_family" | "family_is_sub" | "no_email" | "same_email" | "signin_unknown" | "inactive_with_signin"`,
    `type AttentionItem = { rule: AttentionRule; qboId: string | null; name: string; detail: string }`,
    `needsAttention(roster: Roster, shape: MembershipShape, signIns: SignIn[]): AttentionItem[]`.
  - `queries.ts`:
    `type RosterPage = { connected: boolean; shape: MembershipShape | null; shapeWords: string | null; brokenTypes: string[]; roster: Roster | null; attention: AttentionItem[]; signIns: SignIn[]; types: TypeRow[]; lastRun: { at: string; ok: boolean; detail: string | null } | null; lastOkAt: string | null }`,
    `loadRosterPage(): Promise<RosterPage>`,
    `type ShapePreview = { families: number; students: number; parents: number; members: number; outside: number; samples: { families: string[]; students: string[]; parents: string[]; members: string[] } }`,
    `previewShape(shape: MembershipShape): Promise<ShapePreview>`,
    `rosterEntry(qboId: string): Promise<{ kind: "family"; family: Family; signIns: SignIn[] } | { kind: "member"; member: Cust; signIns: SignIn[] } | null>`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/roster-model.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildRoster, type Cust } from "@/lib/roster/model";

const c = (qboId: string, displayName: string, typeQboId: string | null, parentQboId: string | null = null, extra: Partial<Cust> = {}): Cust =>
  ({ qboId, displayName, active: true, parentQboId, typeQboId, email: null, phone: null, ...extra });
const company: Cust[] = [
  c("20", "Chen Family", "1"), c("10", "Rivera Family", "1"),
  c("11", "Ana Rivera", "2", "10"), c("12", "Leo Rivera", "3", "10"), c("13", "Zoe Rivera", "3", "10", { active: false }),
  c("14", "Deep Student", "3", "12"), // under a student, not directly under a family
  c("21", "Mei Chen", "2", "20"),
  c("30", "Lincoln High", "4"), c("50", "Stray Student", "3"), c("60", "No Type", null),
  c("70", "Typed Parent Under School", "2", "30"),
];
const layered = { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" } as const;

describe("building the roster from cached customers", () => {
  it("layered: families in name order with the students and parents directly under them", () => {
    const r = buildRoster(layered, company);
    if (r.kind !== "layered") throw new Error("expected layered");
    expect(r.families.map((f) => f.customer.displayName)).toEqual(["Chen Family", "Rivera Family"]);
    const rivera = r.families[1]!;
    expect(rivera.parents.map((p) => p.displayName)).toEqual(["Ana Rivera"]);
    expect(rivera.students.map((s) => s.displayName)).toEqual(["Leo Rivera", "Zoe Rivera"]);
    expect(r.strays.map((s) => s.displayName).sort()).toEqual(["Deep Student", "Stray Student", "Typed Parent Under School"]);
    expect(r.outside).toBe(2); // Lincoln High and No Type
  });
  it("layered with the student type blank: no students, and Student customers are outside", () => {
    const r = buildRoster({ kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: "2" }, company);
    if (r.kind !== "layered") throw new Error("expected layered");
    expect(r.families.every((f) => f.students.length === 0)).toBe(true);
    expect(r.strays.map((s) => s.displayName)).toEqual(["Typed Parent Under School"]);
    expect(r.outside).toBe(6);
  });
  it("layered with both blank: families only", () => {
    const r = buildRoster({ kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: null }, company);
    if (r.kind !== "layered") throw new Error("expected layered");
    expect(r.families).toHaveLength(2);
    expect(r.families.every((f) => f.students.length + f.parents.length === 0)).toBe(true);
    expect(r.strays).toEqual([]);
  });
  it("a family-typed customer that is itself a sub-customer is still a family", () => {
    const r = buildRoster(layered, [...company, c("80", "Nested Family", "1", "10")]);
    if (r.kind !== "layered") throw new Error("expected layered");
    expect(r.families.map((f) => f.customer.qboId)).toContain("80");
  });
  it("flat: every customer of the member types, in name order, whatever they sit under", () => {
    const r = buildRoster({ kind: "flat", memberTypeIds: ["3", "2"] }, company);
    if (r.kind !== "flat") throw new Error("expected flat");
    expect(r.members.map((m) => m.displayName)).toEqual(["Ana Rivera", "Deep Student", "Leo Rivera", "Mei Chen", "Stray Student", "Typed Parent Under School", "Zoe Rivera"]);
    expect(r.outside).toBe(4);
  });
});
```

`tests/unit/roster-attention.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildRoster, type Cust } from "@/lib/roster/model";
import { needsAttention, type SignIn } from "@/lib/roster/attention";

const c = (qboId: string, displayName: string, typeQboId: string | null, parentQboId: string | null = null, extra: Partial<Cust> = {}): Cust =>
  ({ qboId, displayName, active: true, parentQboId, typeQboId, email: null, phone: null, ...extra });
const layered = { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" } as const;
const signIn = (familyQboId: string, status: SignIn["status"] = "active", email = "p@example.com"): SignIn => ({ guardianId: `g-${familyQboId}-${email}`, familyQboId, name: "P", email, status });
const rules = (customers: Cust[], shape: Parameters<typeof buildRoster>[0] = layered, signIns: SignIn[] = []) =>
  needsAttention(buildRoster(shape, customers), shape, signIns).map((a) => `${a.rule}:${a.qboId ?? a.name}`).sort();

const tidy: Cust[] = [c("10", "Rivera Family", "1"), c("11", "Ana Rivera", "2", "10", { email: "ana@example.com" }), c("12", "Leo Rivera", "3", "10")];

describe("Needs attention", () => {
  it("finds nothing wrong with a tidy family", () => {
    expect(rules(tidy, layered, [signIn("10")])).toEqual([]);
  });
  it("a family with no parent, only when a parent type is set", () => {
    const company = [c("10", "Rivera Family", "1"), c("12", "Leo Rivera", "3", "10")];
    expect(rules(company)).toEqual(["family_no_parent:10"]);
    expect(rules(company, { ...layered, parentTypeId: null })).toEqual([]);
  });
  it("a family with no student, only when a student type is set", () => {
    const company = [c("10", "Rivera Family", "1"), c("11", "Ana Rivera", "2", "10", { email: "ana@example.com" })];
    expect(rules(company)).toEqual(["family_no_student:10"]);
    expect(rules(company, { ...layered, studentTypeId: null })).toEqual([]);
  });
  it("an inactive parent or student doesn't count as one", () => {
    expect(rules([c("10", "Rivera Family", "1"), c("11", "Ana Rivera", "2", "10", { email: "a@example.com", active: false }), c("12", "Leo Rivera", "3", "10")]))
      .toEqual(["family_no_parent:10"]);
  });
  it("a student or parent that isn't directly under a family", () => {
    expect(rules([...tidy, c("50", "Stray Student", "3"), c("51", "Stray Parent", "2", "12", { email: "s@example.com" })]))
      .toEqual(["not_under_family:50", "not_under_family:51"]);
  });
  it("a family that is itself a sub-customer", () => {
    expect(rules([...tidy, c("80", "Nested Family", "1", "10"), c("81", "N Parent", "2", "80", { email: "n@example.com" }), c("82", "N Student", "3", "80")]))
      .toEqual(["family_is_sub:80"]);
  });
  it("a parent with no email, and a flat member with no email", () => {
    expect(rules([c("10", "Rivera Family", "1"), c("11", "Ana Rivera", "2", "10"), c("12", "Leo Rivera", "3", "10")])).toEqual(["no_email:11"]);
    expect(rules([c("12", "Leo Rivera", "3"), c("13", "Zoe Rivera", "3", null, { email: "z@example.com" })], { kind: "flat", memberTypeIds: ["3"] })).toEqual(["no_email:12"]);
  });
  it("two parents in the same family with the same email, but not the same person in two families", () => {
    const twice = [...tidy, c("15", "Ana Again", "2", "10", { email: "ana@example.com" })];
    expect(rules(twice)).toEqual(["same_email:11", "same_email:15"]);
    const twoFamilies = [...tidy, c("20", "Chen Family", "1"), c("21", "Ana Rivera", "2", "20", { email: "ana@example.com" }), c("22", "Bo Chen", "3", "20")];
    expect(rules(twoFamilies)).toEqual([]);
  });
  it("two flat members with the same email", () => {
    expect(rules([c("12", "Leo", "3", null, { email: "x@example.com" }), c("13", "Zoe", "3", null, { email: "x@example.com" })], { kind: "flat", memberTypeIds: ["3"] }))
      .toEqual(["same_email:12", "same_email:13"]);
  });
  it("leaves inactive customers out of the clean-up rules", () => {
    expect(rules([c("40", "Old Family", "1", null, { active: false }), c("41", "Old Stray", "3", null, { active: false })])).toEqual([]);
  });
  it("a portal sign-in whose QuickBooks ID isn't a family or a member", () => {
    expect(rules(tidy, layered, [signIn("POC-FAMILY-1"), signIn("11")])).toEqual(["signin_unknown:P (p@example.com)", "signin_unknown:P (p@example.com)"]);
    expect(rules([c("12", "Leo", "3", null, { email: "l@example.com" })], { kind: "flat", memberTypeIds: ["3"] }, [signIn("12"), signIn("99")])).toEqual(["signin_unknown:P (p@example.com)"]);
  });
  it("an inactive family that still has a sign-in that isn't disabled", () => {
    const company = [c("40", "Old Family", "1", null, { active: false })];
    expect(rules(company, layered, [signIn("40", "active")])).toEqual(["inactive_with_signin:40"]);
    expect(rules(company, layered, [signIn("40", "invited")])).toEqual(["inactive_with_signin:40"]);
    expect(rules(company, layered, [signIn("40", "disabled")])).toEqual([]);
  });
  it("says each problem in plain words", () => {
    const [item] = needsAttention(buildRoster(layered, [c("10", "Rivera Family", "1"), c("12", "Leo Rivera", "3", "10")]), layered, []);
    expect(item).toEqual({ rule: "family_no_parent", qboId: "10", name: "Rivera Family", detail: "No parent is listed under this family in QuickBooks." });
  });
});
```

`tests/integration/roster-queries.test.ts` (first lines: the vitest import and **the stub block** from Task 3, then):

```ts
import { db } from "@/lib/db/client";
import { qboCustomerType } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { refreshRoster } from "@/lib/roster/refresh";
import { saveShape } from "@/lib/roster/shape";
import { loadRosterPage, previewShape, rosterEntry } from "@/lib/roster/queries";
import { resetDb, seedParent, seedGuardian } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, FZN_SHAPE, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
const staffOp = { actor: { door: "staff" as const, id: "5a1e7a2e-0000-4000-8000-000000000001", label: "admin@example.org" }, ip: null };

describe("what the roster pages load", () => {
  beforeEach(async () => {
    await resetDb(); stub.reset();
    Object.assign(stub, fznCompany());
    await seedConnected(stub);
  });

  it("before a shape is chosen: connected, no roster", async () => {
    await refreshRoster(worker);
    expect(await loadRosterPage()).toMatchObject({ connected: true, shape: null, shapeWords: null, roster: null, attention: [], brokenTypes: [] });
  });

  it("with the FZN shape: families, the clean-up list, the sign-ins and the last refresh", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10", status: "invited" });
    await seedGuardian({ parentId: ana.id, familyQboId: "POC-FAMILY-1" });
    const page = await loadRosterPage();
    expect(page.shapeWords).toBe("Layered: families are Family, students are Student, parents are Parent.");
    if (page.roster?.kind !== "layered") throw new Error("expected layered");
    expect(page.roster.families.map((f) => f.customer.displayName)).toEqual(["Chen Family", "Old Family", "Rivera Family"]);
    expect(page.roster.outside).toBe(2);
    expect(page.attention.map((a) => `${a.rule}:${a.qboId ?? a.name}`).sort()).toEqual([
      "family_no_student:20", "no_email:21", "not_under_family:50", "signin_unknown:Ana Rivera (ana@example.com)",
    ]);
    expect(page.signIns.map((s) => [s.familyQboId, s.status]).sort()).toEqual([["10", "invited"], ["POC-FAMILY-1", "active"]]);
    expect(page.lastRun).toMatchObject({ ok: true, detail: "9 customers, 5 customer types" });
    expect(page.lastOkAt).not.toBeNull();
  });

  it("a shape naming a missing type is broken: no roster, and it says which type", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    await db.delete(qboCustomerType).where(eq(qboCustomerType.qboId, "2"));
    const page = await loadRosterPage();
    expect(page.brokenTypes).toEqual(["2"]);
    expect(page.roster).toBeNull();
    expect(page.attention).toEqual([]);
  });

  it("previews a shape with counts and the first names in each role", async () => {
    await refreshRoster(worker);
    expect(await previewShape(FZN_SHAPE)).toEqual({ families: 3, students: 1, parents: 2, members: 0, outside: 2,
      samples: { families: ["Chen Family", "Old Family", "Rivera Family"], students: ["Leo Rivera"], parents: ["Mei Chen", "Ana Rivera"], members: [] } });
    expect(await previewShape({ kind: "flat", memberTypeIds: ["3"] })).toMatchObject({ members: 2, outside: 7, samples: { members: ["Leo Rivera", "Stray Student"] } });
  });

  it("finds one family with its sign-ins, and nothing for a customer outside the shape", async () => {
    await saveShape(FZN_SHAPE, staffOp);
    await refreshRoster(worker);
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10" });
    const entry = await rosterEntry("10");
    if (entry?.kind !== "family") throw new Error("expected a family");
    expect(entry.family.parents.map((p) => [p.displayName, p.email, p.phone])).toEqual([["Ana Rivera", "ana@example.com", "555-0101"]]);
    expect(entry.signIns.map((s) => s.email)).toEqual(["ana@example.com"]);
    expect(await rosterEntry("30")).toBeNull(); // Lincoln High: a School
    expect(await rosterEntry("11")).toBeNull(); // a parent is not a page of its own
    expect(await rosterEntry("nope")).toBeNull();
  });

  it("flat: finds a member", async () => {
    await saveShape({ kind: "flat", memberTypeIds: ["2"] }, staffOp);
    await refreshRoster(worker);
    expect(await rosterEntry("11")).toMatchObject({ kind: "member", member: { displayName: "Ana Rivera", email: "ana@example.com" } });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run tests/unit/roster-model.test.ts tests/unit/roster-attention.test.ts tests/integration/roster-queries.test.ts`
Expected: FAIL. The three modules don't exist.

- [ ] **Step 3: Write `src/lib/roster/model.ts`**

```ts
import type { MembershipShape } from "./shape";

export type Cust = { qboId: string; displayName: string; active: boolean; parentQboId: string | null; typeQboId: string | null; email: string | null; phone: string | null };
export type Family = { customer: Cust; students: Cust[]; parents: Cust[] };
export type Roster =
  | { kind: "flat"; members: Cust[]; outside: number }
  | { kind: "layered"; families: Family[]; strays: Cust[]; outside: number };

const byName = (a: Cust, b: Cust) => a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" }) || a.qboId.localeCompare(b.qboId);

/**
 * Turns cached customers into the club's roster (spec §1). Pure. A student or parent belongs to a family only when it
 * sits directly under it; one that doesn't is a stray. Customers the shape doesn't name are only counted.
 */
export function buildRoster(shape: MembershipShape, customers: Cust[]): Roster {
  if (shape.kind === "flat") {
    const types = new Set(shape.memberTypeIds);
    const members = customers.filter((c) => c.typeQboId !== null && types.has(c.typeQboId)).sort(byName);
    return { kind: "flat", members, outside: customers.length - members.length };
  }
  const isFamily = (c: Cust) => c.typeQboId === shape.familyTypeId;
  const isStudent = (c: Cust) => shape.studentTypeId !== null && c.typeQboId === shape.studentTypeId;
  const isParent = (c: Cust) => shape.parentTypeId !== null && c.typeQboId === shape.parentTypeId;
  const families = new Map<string, Family>(customers.filter(isFamily).sort(byName).map((c) => [c.qboId, { customer: c, students: [], parents: [] }]));
  const strays: Cust[] = [];
  let outside = 0;
  for (const c of [...customers].sort(byName)) {
    if (isFamily(c)) continue;
    if (!isStudent(c) && !isParent(c)) { outside++; continue; }
    const family = c.parentQboId ? families.get(c.parentQboId) : undefined;
    if (!family) strays.push(c);
    else (isStudent(c) ? family.students : family.parents).push(c);
  }
  return { kind: "layered", families: [...families.values()], strays, outside };
}
```

- [ ] **Step 4: Write `src/lib/roster/attention.ts`**

```ts
import type { MembershipShape } from "./shape";
import type { Cust, Roster } from "./model";

export type SignIn = { guardianId: string; familyQboId: string; name: string; email: string; status: "invited" | "active" | "disabled" };
export type AttentionRule = "family_no_parent" | "family_no_student" | "not_under_family" | "family_is_sub" | "no_email" | "same_email" | "signin_unknown" | "inactive_with_signin";
export type AttentionItem = { rule: AttentionRule; qboId: string | null; name: string; detail: string };

const item = (rule: AttentionRule, c: Cust, detail: string): AttentionItem => ({ rule, qboId: c.qboId, name: c.displayName, detail });

function sameEmail(people: Cust[], detail: string): AttentionItem[] {
  const seen = new Map<string, Cust[]>();
  for (const p of people) if (p.active && p.email) seen.set(p.email, [...(seen.get(p.email) ?? []), p]);
  return [...seen.values()].filter((group) => group.length > 1).flat().map((p) => item("same_email", p, detail));
}

/**
 * The club's clean-up list (spec §5 Needs attention). Pure; it changes nothing. Inactive customers are left out of the
 * QuickBooks clean-up rules; the two sign-in rules look at every customer.
 */
export function needsAttention(roster: Roster, shape: MembershipShape, signIns: SignIn[]): AttentionItem[] {
  const out: AttentionItem[] = [];
  const known = new Map<string, Cust>();
  if (roster.kind === "flat") {
    for (const m of roster.members) {
      known.set(m.qboId, m);
      if (m.active && !m.email) out.push(item("no_email", m, "This member has no email address in QuickBooks."));
    }
    out.push(...sameEmail(roster.members, "Another member has the same email address in QuickBooks."));
  } else if (shape.kind === "layered") {
    for (const f of roster.families) {
      known.set(f.customer.qboId, f.customer);
      if (!f.customer.active) continue;
      if (shape.parentTypeId && !f.parents.some((p) => p.active)) out.push(item("family_no_parent", f.customer, "No parent is listed under this family in QuickBooks."));
      if (shape.studentTypeId && !f.students.some((s) => s.active)) out.push(item("family_no_student", f.customer, "No student is listed under this family in QuickBooks."));
      if (f.customer.parentQboId) out.push(item("family_is_sub", f.customer, "This family is a sub-customer of another customer in QuickBooks. A family should be a top-level customer."));
      for (const p of f.parents) if (p.active && !p.email) out.push(item("no_email", p, "This parent has no email address in QuickBooks, so they can't be given a sign-in."));
      out.push(...sameEmail(f.parents, "Another parent in this family has the same email address in QuickBooks."));
    }
    for (const s of roster.strays) if (s.active) out.push(item("not_under_family", s, "This student or parent isn't directly under a family in QuickBooks."));
  }
  for (const s of signIns) {
    const customer = known.get(s.familyQboId);
    if (!customer) {
      out.push({ rule: "signin_unknown", qboId: null, name: `${s.name} (${s.email})`,
        detail: `This portal sign-in is attached to QuickBooks ID ${s.familyQboId}, which isn't a ${roster.kind === "flat" ? "member" : "family"} in QuickBooks.` });
    } else if (!customer.active && s.status !== "disabled" && !out.some((o) => o.rule === "inactive_with_signin" && o.qboId === customer.qboId)) {
      out.push(item("inactive_with_signin", customer, "This is inactive in QuickBooks, but someone can still sign in to the portal for it."));
    }
  }
  return out;
}
```

- [ ] **Step 5: Write `src/lib/roster/queries.ts`**

```ts
import { eq, desc, and } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { qboCustomer, qboCustomerType, jobRun, guardian, parent } from "@/lib/db/schema";
import { connectionView } from "@/lib/quickbooks/connection";
import { getShape, missingTypes, describeShape, type MembershipShape, type TypeRow } from "./shape";
import { buildRoster, type Cust, type Family, type Roster } from "./model";
import { needsAttention, type AttentionItem, type SignIn } from "./attention";
import { ROSTER_JOB } from "./refresh";

export type RosterPage = {
  connected: boolean; shape: MembershipShape | null; shapeWords: string | null; brokenTypes: string[]; roster: Roster | null;
  attention: AttentionItem[]; signIns: SignIn[]; types: TypeRow[];
  lastRun: { at: string; ok: boolean; detail: string | null } | null; lastOkAt: string | null;
};
export type ShapePreview = {
  families: number; students: number; parents: number; members: number; outside: number;
  samples: { families: string[]; students: string[]; parents: string[]; members: string[] };
};

const customers = async (): Promise<Cust[]> => (await db.select().from(qboCustomer)).map((c) =>
  ({ qboId: c.qboId, displayName: c.displayName, active: c.active, parentQboId: c.parentQboId, typeQboId: c.typeQboId, email: c.email, phone: c.phone }));
const types = async (): Promise<TypeRow[]> => (await db.select().from(qboCustomerType)).map((t) => ({ qboId: t.qboId, name: t.name, active: t.active }))
  .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
const signIns = async (): Promise<SignIn[]> => db.select({ guardianId: guardian.id, familyQboId: guardian.familyQboId, name: parent.name, email: parent.email, status: guardian.status })
  .from(guardian).innerJoin(parent, eq(guardian.parentId, parent.id));

/** Everything the roster pages and the settings view show. A broken shape gives no roster rather than a wrong one (spec §1 Rules). */
export async function loadRosterPage(): Promise<RosterPage> {
  const [conn, shape, typeRows, people, [last], [lastOk]] = await Promise.all([
    connectionView(), getShape(), types(), signIns(),
    db.select().from(jobRun).where(eq(jobRun.job, ROSTER_JOB)).orderBy(desc(jobRun.id)).limit(1),
    db.select().from(jobRun).where(and(eq(jobRun.job, ROSTER_JOB), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1),
  ]);
  const brokenTypes = shape && typeRows.length ? missingTypes(shape, typeRows) : [];
  const roster = shape && !brokenTypes.length ? buildRoster(shape, await customers()) : null;
  return {
    connected: conn.connected, shape, shapeWords: shape ? describeShape(shape, typeRows) : null, brokenTypes, roster,
    attention: roster && shape ? needsAttention(roster, shape, people) : [], signIns: people, types: typeRows,
    lastRun: last ? { at: (last.finishedAt ?? last.startedAt).toISOString(), ok: last.outcome === "ok", detail: last.detail } : null,
    lastOkAt: lastOk?.finishedAt?.toISOString() ?? null,
  };
}

/** What a shape would give, before it is saved: counts and the first three names in each role (spec §3 step 3). */
export async function previewShape(shape: MembershipShape): Promise<ShapePreview> {
  const r = buildRoster(shape, await customers());
  const first = (list: Cust[]) => list.slice(0, 3).map((c) => c.displayName);
  if (r.kind === "flat") return { families: 0, students: 0, parents: 0, members: r.members.length, outside: r.outside, samples: { families: [], students: [], parents: [], members: first(r.members) } };
  const students = r.families.flatMap((f) => f.students), parents = r.families.flatMap((f) => f.parents);
  return { families: r.families.length, students: students.length, parents: parents.length, members: 0, outside: r.outside,
    samples: { families: first(r.families.map((f) => f.customer)), students: first(students), parents: first(parents), members: [] } };
}

/** One family (layered) or one member (flat) with the portal sign-ins attached to its QuickBooks ID; null for anything else. */
export async function rosterEntry(qboId: string): Promise<{ kind: "family"; family: Family; signIns: SignIn[] } | { kind: "member"; member: Cust; signIns: SignIn[] } | null> {
  const page = await loadRosterPage();
  if (!page.roster) return null;
  const mine = page.signIns.filter((s) => s.familyQboId === qboId);
  if (page.roster.kind === "flat") {
    const member = page.roster.members.find((m) => m.qboId === qboId);
    return member ? { kind: "member", member, signIns: mine } : null;
  }
  const family = page.roster.families.find((f) => f.customer.qboId === qboId);
  return family ? { kind: "family", family, signIns: mine } : null;
}
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `pnpm vitest run tests/unit/roster-model.test.ts tests/unit/roster-attention.test.ts tests/integration/roster-queries.test.ts`
Expected: PASS.

- [ ] **Step 7: Full checks and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all clean.

```bash
git add src/lib/roster tests/unit/roster-model.test.ts tests/unit/roster-attention.test.ts tests/integration/roster-queries.test.ts
git commit -m "feat(roster): families, members and the Needs attention list from the cache

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 6: Scheduled jobs, the worker and the staff warning

**Files:**
- Create: `src/lib/jobs/runner.ts`, `src/lib/jobs/worker-token.ts`, `src/lib/quickbooks/health.ts`
- Create: `src/app/api/internal/worker/route.ts`, `scripts/worker.mjs`
- Create: `tests/integration/jobs-runner.test.ts`, `tests/integration/quickbooks-health.test.ts`, `tests/unit/worker-script.test.ts`

**Interfaces:**
- Consumes: `accessToken`, `WORKER_ACTOR` (Task 3); `connectionView` (Task 3); `refreshRoster`, `ROSTER_JOB` (Task 4);
  `loadRosterPage` (Task 5); `jobRun`, `setting`; `env.BETTER_AUTH_SECRET`.
- Produces:
  - `runner.ts`: `TOKEN_JOB = "quickbooks.token_refresh"`, `WAKE_KEY = "worker.last_wake"`,
    `runDueJobs(now?: Date): Promise<{ ran: { job: string; ok: boolean }[] }>`, `lastWake(): Promise<string | null>`.
  - `worker-token.ts`: `workerToken(): string`, `isWorkerRequest(authorization: string | null): boolean`.
  - `health.ts`: `type QboProblem = { kind: "token_failed" | "expiring" | "roster_failed" | "roster_old" | "shape_broken"; text: string }`,
    `quickbooksProblems(now?: Date): Promise<QboProblem[]>`.
  - `POST /api/internal/worker` (bearer: `workerToken()`), answering `{ ok: true, ran: [...] }`; anything else is `404`.
  - `scripts/worker.mjs`: `node worker.mjs` loops every 60 seconds; `node worker.mjs --once` wakes once and exits 0 or 1.

- [ ] **Step 1: Write the failing tests**

`tests/integration/jobs-runner.test.ts` (first lines: the vitest import and **the stub block** from Task 3, then):

```ts
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { jobRun, qboConnection, qboCustomer } from "@/lib/db/schema";
import { runDueJobs, lastWake, TOKEN_JOB } from "@/lib/jobs/runner";
import { workerToken } from "@/lib/jobs/worker-token";
import { ROSTER_JOB } from "@/lib/roster/refresh";
import { POST } from "@/app/api/internal/worker/route";
import { resetDb } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const runs = async (job: string) => (await db.select().from(jobRun).where(eq(jobRun.job, job))).sort((a, b) => a.id - b.id);
const hours = (n: number) => new Date(Date.now() + n * 3_600_000);

describe("scheduled jobs", () => {
  beforeEach(async () => { await resetDb(); stub.reset(); Object.assign(stub, fznCompany()); });

  it("records the wake and does nothing while QuickBooks isn't connected", async () => {
    expect(await lastWake()).toBeNull();
    expect(await runDueJobs()).toEqual({ ran: [] });
    expect(Date.parse((await lastWake())!)).toBeGreaterThan(Date.now() - 5000);
    expect(await db.select().from(jobRun)).toHaveLength(0);
  });

  it("runs both jobs the first time, and neither again within 24 hours", async () => {
    await seedConnected(stub);
    expect(await runDueJobs()).toEqual({ ran: [{ job: TOKEN_JOB, ok: true }, { job: ROSTER_JOB, ok: true }] });
    expect(stub.tokenCalls()).toHaveLength(1); // the daily refresh spends the refresh token even though the access token was still good
    expect(await db.select().from(qboCustomer)).toHaveLength(9);
    expect((await runs(TOKEN_JOB))[0]).toMatchObject({ outcome: "ok", startedBy: "worker" });
    expect(await runDueJobs(hours(23))).toEqual({ ran: [] });
    expect(await runDueJobs(hours(25))).toEqual({ ran: [{ job: TOKEN_JOB, ok: true }, { job: ROSTER_JOB, ok: true }] });
  });

  it("retries a failed job, but no more often than every 15 minutes", async () => {
    await seedConnected(stub);
    stub.failToken = "server_error";
    expect(await runDueJobs()).toMatchObject({ ran: [{ job: TOKEN_JOB, ok: false }, { job: ROSTER_JOB, ok: true }] });
    expect((await runs(TOKEN_JOB))[0]).toMatchObject({ outcome: "failed", detail: "Intuit refused the request. (server_error)" });
    stub.failToken = null;
    expect(await runDueJobs(new Date(Date.now() + 14 * 60_000))).toEqual({ ran: [] });
    expect(await runDueJobs(new Date(Date.now() + 16 * 60_000))).toEqual({ ran: [{ job: TOKEN_JOB, ok: true }] });
    expect(await runs(TOKEN_JOB)).toHaveLength(2);
    expect((await db.select().from(qboConnection))[0]!.lastError).toBeNull();
  });

  it("a hand-started roster refresh counts as that day's run", async () => {
    await seedConnected(stub);
    await runDueJobs();
    await db.update(jobRun).set({ startedAt: hours(-30), finishedAt: hours(-30) });
    const { refreshRoster } = await import("@/lib/roster/refresh");
    await refreshRoster({ startedBy: "5a1e7a2e-0000-4000-8000-000000000001", actor: { door: "staff", id: "5a1e7a2e-0000-4000-8000-000000000001", label: "a@example.org" }, ip: null, manual: true });
    expect(await runDueJobs()).toEqual({ ran: [{ job: TOKEN_JOB, ok: true }] });
  });

  it("the worker endpoint runs the jobs for the right token and is not found for anything else", async () => {
    await seedConnected(stub);
    const call = (authorization?: string) => POST(new Request("http://app:3000/api/internal/worker", { method: "POST", headers: authorization ? { authorization } : {} }));
    for (const bad of [undefined, "Bearer nope", `Bearer ${workerToken()}x`, workerToken()]) {
      const res = await call(bad);
      expect(res.status).toBe(404);
    }
    expect(await db.select().from(jobRun)).toHaveLength(0);
    const res = await call(`Bearer ${workerToken()}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, ran: [{ job: TOKEN_JOB, ok: true }, { job: ROSTER_JOB, ok: true }] });
  });
});
```

`tests/integration/quickbooks-health.test.ts` (first lines: the vitest import and **the stub block**, then):

```ts
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { qboConnection, qboCustomerType } from "@/lib/db/schema";
import { quickbooksProblems } from "@/lib/quickbooks/health";
import { refreshRoster } from "@/lib/roster/refresh";
import { saveShape } from "@/lib/roster/shape";
import { resetDb } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, FZN_SHAPE, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
const kinds = async (now?: Date) => (await quickbooksProblems(now)).map((p) => p.kind);

describe("the QuickBooks warning", () => {
  beforeEach(async () => { await resetDb(); stub.reset(); Object.assign(stub, fznCompany()); });

  it("says nothing on a site that never connected, or one that disconnected", async () => {
    expect(await kinds()).toEqual([]);
  });
  it("says nothing while everything is fine", async () => {
    await seedConnected(stub);
    await refreshRoster(worker);
    expect(await kinds()).toEqual([]);
  });
  it("a failed token refresh", async () => {
    await seedConnected(stub);
    await refreshRoster(worker);
    await db.update(qboConnection).set({ lastError: "Intuit refused the request. (server_error)", lastErrorAt: new Date() });
    const [p] = await quickbooksProblems();
    expect(p).toEqual({ kind: "token_failed", text: "The QuickBooks connection couldn't be refreshed: Intuit refused the request. (server_error)" });
  });
  it("a connection that expires within 30 days, but not one with 31 days left", async () => {
    await seedConnected(stub, { refreshExpiresInMs: 29 * 86_400_000 });
    await refreshRoster(worker);
    expect(await kinds()).toEqual(["expiring"]);
    await db.update(qboConnection).set({ refreshExpiresAt: new Date(Date.now() + 31 * 86_400_000) });
    expect(await kinds()).toEqual([]);
  });
  it("a failed roster refresh", async () => {
    await seedConnected(stub);
    stub.failQueryFrom = 1;
    await refreshRoster(worker);
    expect(await quickbooksProblems()).toEqual([{ kind: "roster_failed", text: "The last roster refresh failed: QuickBooks refused the request. (http_500)" }]);
  });
  it("a roster more than 48 hours old", async () => {
    await seedConnected(stub);
    await refreshRoster(worker);
    expect(await kinds(new Date(Date.now() + 47 * 3_600_000))).toEqual([]);
    expect(await kinds(new Date(Date.now() + 49 * 3_600_000))).toEqual(["roster_old"]);
  });
  it("a connection with no refresh yet warns only once it is 48 hours old", async () => {
    await seedConnected(stub);
    expect(await kinds()).toEqual([]);
    expect(await kinds(new Date(Date.now() + 49 * 3_600_000))).toEqual(["roster_old"]);
  });
  it("a shape that names a type QuickBooks no longer has", async () => {
    await seedConnected(stub);
    await saveShape(FZN_SHAPE, { actor: worker.actor, ip: null });
    await refreshRoster(worker);
    await db.delete(qboCustomerType).where(eq(qboCustomerType.qboId, "2"));
    expect(await kinds()).toEqual(["shape_broken"]);
  });
});
```

`tests/unit/worker-script.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import path from "node:path";

const SCRIPT = path.resolve("scripts/worker.mjs");
const SECRET = "worker-test-secret-worker-test-secret-123456";

async function withApp(status: number, body: unknown, fn: (url: string, seen: { method: string; url: string; authorization: string }[]) => Promise<void>) {
  const seen: { method: string; url: string; authorization: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method!, url: req.url!, authorization: req.headers.authorization ?? "" });
    res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen); } finally { await new Promise<void>((r) => server.close(() => r())); }
}
const once = (url: string, env: Record<string, string> = {}) => new Promise<{ code: number | null; out: string }>((resolve) => {
  const child = spawn(process.execPath, [SCRIPT, "--once"], { env: { ...process.env, BETTER_AUTH_SECRET: SECRET, WORKER_APP_URL: url, ...env } });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  child.on("close", (code) => resolve({ code, out }));
});

describe("scripts/worker.mjs", { timeout: 30_000 }, () => {
  it("posts to the app's worker endpoint with the token derived from BETTER_AUTH_SECRET", async () => {
    await withApp(200, { ok: true, ran: [{ job: "roster.refresh", ok: true }] }, async (url, seen) => {
      const r = await once(`${url}/`);
      expect(r.code).toBe(0);
      expect(seen).toEqual([{ method: "POST", url: "/api/internal/worker", authorization: `Bearer ${createHmac("sha256", SECRET).update("booster-rocket-worker:v1").digest("hex")}` }]);
      expect(r.out).toContain("ran roster.refresh: ok");
      expect(r.out).not.toContain(SECRET);
    });
  });
  it("exits 1 and says so when the app refuses or can't be reached", async () => {
    await withApp(404, {}, async (url) => {
      const r = await once(url);
      expect(r.code).toBe(1);
      expect(r.out).toContain("couldn't reach the app: HTTP 404");
    });
    expect((await once("http://127.0.0.1:9")).code).toBe(1);
  });
  it("refuses to start without BETTER_AUTH_SECRET", () => {
    const r = spawnSync(process.execPath, [SCRIPT, "--once"], { encoding: "utf8", env: { ...process.env, BETTER_AUTH_SECRET: "" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("BETTER_AUTH_SECRET is required.");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run tests/integration/jobs-runner.test.ts tests/integration/quickbooks-health.test.ts tests/unit/worker-script.test.ts`
Expected: FAIL. None of the modules or the script exist.

- [ ] **Step 3: Write `src/lib/jobs/worker-token.ts`**

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/env";

/** The shared secret between the app and its worker, derived from BETTER_AUTH_SECRET, which both containers already hold. `scripts/worker.mjs` derives the same value. */
export function workerToken(): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET).update("booster-rocket-worker:v1").digest("hex");
}

export function isWorkerRequest(authorization: string | null): boolean {
  const given = Buffer.from((authorization ?? "").startsWith("Bearer ") ? (authorization ?? "").slice(7) : ""), want = Buffer.from(workerToken());
  return given.length === want.length && timingSafeEqual(given, want);
}
```

- [ ] **Step 4: Write `src/lib/jobs/runner.ts`**

```ts
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { jobRun, setting } from "@/lib/db/schema";
import { accessToken, WORKER_ACTOR } from "@/lib/quickbooks/client";
import { connectionView } from "@/lib/quickbooks/connection";
import { QboError } from "@/lib/quickbooks/endpoints";
import { refreshRoster, ROSTER_JOB } from "@/lib/roster/refresh";

export const TOKEN_JOB = "quickbooks.token_refresh";
export const WAKE_KEY = "worker.last_wake";
const DUE_MS = 24 * 3_600_000;
const RETRY_MS = 15 * 60_000;

/** Due when the last successful run is more than 24 hours old, and the last attempt of any kind is at least 15 minutes old (spec §4). */
async function due(job: string, now: Date): Promise<boolean> {
  const [lastOk] = await db.select().from(jobRun).where(and(eq(jobRun.job, job), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1);
  if (lastOk?.finishedAt && now.getTime() - lastOk.finishedAt.getTime() <= DUE_MS) return false;
  const [last] = await db.select().from(jobRun).where(eq(jobRun.job, job)).orderBy(desc(jobRun.id)).limit(1);
  return !last || now.getTime() - last.startedAt.getTime() >= RETRY_MS;
}

/** One wake of the worker: records it, then runs whichever jobs are due. `now` is only for deciding what is due. */
export async function runDueJobs(now: Date = new Date()): Promise<{ ran: { job: string; ok: boolean }[] }> {
  const wake = { at: new Date().toISOString() };
  await db.insert(setting).values({ key: WAKE_KEY, value: wake }).onConflictDoUpdate({ target: setting.key, set: { value: wake, updatedAt: new Date() } });
  const ran: { job: string; ok: boolean }[] = [];
  if (!(await connectionView()).connected) return { ran };
  if (await due(TOKEN_JOB, now)) {
    const [run] = await db.insert(jobRun).values({ job: TOKEN_JOB, startedBy: "worker", startedAt: now }).returning();
    try {
      await accessToken({ force: true }); // spends the refresh token so a quiet summer can't let it lapse; failures are audited there
      await db.update(jobRun).set({ finishedAt: now, outcome: "ok" }).where(eq(jobRun.id, run!.id));
      ran.push({ job: TOKEN_JOB, ok: true });
    } catch (e) {
      if (!(e instanceof QboError)) throw e;
      await db.update(jobRun).set({ finishedAt: now, outcome: "failed", detail: `${e.message} (${e.code})` }).where(eq(jobRun.id, run!.id));
      ran.push({ job: TOKEN_JOB, ok: false });
    }
  }
  if (await due(ROSTER_JOB, now)) {
    const r = await refreshRoster({ startedBy: "worker", actor: WORKER_ACTOR, ip: null });
    if (r.ok || r.reason === "failed") ran.push({ job: ROSTER_JOB, ok: r.ok });
  }
  return { ran };
}

/** When the worker last checked in, for the settings view. */
export async function lastWake(): Promise<string | null> {
  const [row] = await db.select().from(setting).where(eq(setting.key, WAKE_KEY));
  const at = (row?.value as { at?: unknown } | undefined)?.at;
  return typeof at === "string" ? at : null;
}
```

The token job's `startedAt` and `finishedAt` use `now` so the retry rule can be tested by passing a later `now`; the
roster job's rows are written by `refreshRoster` with the real time. In production `now` is always the real time.

- [ ] **Step 5: Write `src/lib/quickbooks/health.ts`**

```ts
import { connectionView } from "./connection";
import { loadRosterPage } from "@/lib/roster/queries";

export type QboProblem = { kind: "token_failed" | "expiring" | "roster_failed" | "roster_old" | "shape_broken"; text: string };
const EXPIRING_MS = 30 * 86_400_000;
const OLD_MS = 48 * 3_600_000;

/** What Admins are warned about on the staff home (spec §5 The staff warning). Nothing on a site that isn't connected. */
export async function quickbooksProblems(now: Date = new Date()): Promise<QboProblem[]> {
  const conn = await connectionView();
  if (!conn.connected) return [];
  const page = await loadRosterPage();
  const out: QboProblem[] = [];
  if (conn.lastError) out.push({ kind: "token_failed", text: `The QuickBooks connection couldn't be refreshed: ${conn.lastError}` });
  if (conn.refreshExpiresAt && Date.parse(conn.refreshExpiresAt) - now.getTime() < EXPIRING_MS) {
    out.push({ kind: "expiring", text: "The QuickBooks connection expires within 30 days. Connect QuickBooks again to renew it." });
  }
  const since = page.lastOkAt ?? conn.connectedAt;
  if (page.lastRun && !page.lastRun.ok) out.push({ kind: "roster_failed", text: `The last roster refresh failed: ${page.lastRun.detail ?? "no reason was recorded"}` });
  else if (since && now.getTime() - Date.parse(since) > OLD_MS) {
    out.push({ kind: "roster_old", text: "The roster hasn't been refreshed from QuickBooks in more than 2 days. Check that the worker is running." });
  }
  if (page.brokenTypes.length) out.push({ kind: "shape_broken", text: "The membership shape names a customer type QuickBooks no longer has. Choose the shape again." });
  return out;
}
```

- [ ] **Step 6: Write the worker endpoint**

Read `node_modules/next/dist/docs/` on route handlers first. `src/app/api/internal/worker/route.ts`:

```ts
import { isWorkerRequest } from "@/lib/jobs/worker-token";
import { runDueJobs } from "@/lib/jobs/runner";

export const dynamic = "force-dynamic";

/**
 * The worker container calls this every minute (scripts/worker.mjs). It runs whichever scheduled jobs are due.
 * Anything without the worker's token gets the same "Not found" as a path that doesn't exist.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isWorkerRequest(req.headers.get("authorization"))) return new Response("Not found", { status: 404 });
  const { ran } = await runDueJobs();
  return Response.json({ ok: true, ran }, { headers: { "cache-control": "no-store" } });
}
```

- [ ] **Step 7: Write `scripts/worker.mjs`**

```js
#!/usr/bin/env node
// Boosters Rocket's worker. Ships in the image as tools/scripts/worker.mjs and runs as its own container.
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
```

A stop while the timer is pending clears it, so the promise never resolves and the process exits because nothing is left
to run. That is the intended way out.

- [ ] **Step 8: Run the tests to see them pass**

Run: `pnpm vitest run tests/integration/jobs-runner.test.ts tests/integration/quickbooks-health.test.ts tests/unit/worker-script.test.ts tests/unit/quickbooks-read-only.test.ts`
Expected: PASS.

- [ ] **Step 9: Full checks and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all clean.

```bash
git add src/lib/jobs src/lib/quickbooks/health.ts src/app/api/internal scripts/worker.mjs tests/integration/jobs-runner.test.ts tests/integration/quickbooks-health.test.ts tests/unit/worker-script.test.ts
git commit -m "feat(jobs): a worker that keeps the QuickBooks connection and the roster fresh

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 7: QuickBooks settings: the view, the three steps and the return from Intuit

**Files:**
- Create: `src/app/staff/(app)/settings/quickbooks/page.tsx`, `.../quickbooks/actions.ts`, `.../quickbooks/forms.tsx`,
  `.../quickbooks/setup/page.tsx`, `.../quickbooks/roster-counts.ts`
- Create: `src/app/api/quickbooks/callback/route.ts`, `src/app/staff/(app)/quickbooks-warning.tsx`
- Modify: `src/app/staff/(app)/layout.tsx`, `src/app/staff/(app)/page.tsx`, `docs/ui-backlog.md`
- Create: `tests/integration/settings-quickbooks.test.ts`

**Interfaces:**
- Consumes: everything Tasks 3 to 6 produce; `staffAction`, `requireStaffPage` from `@/lib/guards`; `can`, `effectivePermissions`
  from `@/lib/permissions/effective`; `getStaffIdentity` from `@/lib/auth/identity`; `clientIpFrom` from `@/lib/request`;
  `CopyField` from `@/app/components/sign-in-settings/copy-field`; `LocalTime`; `safely`, `ACTION_FAILED`.
- Produces:
  - actions (all `staffAction("Settings.QuickBooks.ReadWrite", …)`):
    `saveQboAppAction(form): Promise<{ ok: true } | { ok: false; errors: string[] }>`,
    `beginConnectAction(): Promise<void>` (always redirects),
    `disconnectAction(): Promise<{ ok: true } | { ok: false; error: string }>`,
    `previewShapeAction(form): Promise<{ ok: true; preview: ShapePreview } | { ok: false; errors: string[] }>`,
    `saveShapeAction(form): Promise<{ ok: true; refreshed: boolean } | { ok: false; errors: string[] }>`.
  - `rosterCounts(roster: Roster | null): string` in `roster-counts.ts` (Task 8 uses it too).
  - `GET /api/quickbooks/callback`.
  - pages `/staff/settings/quickbooks` and `/staff/settings/quickbooks/setup?step=app|connect|shape`.
  - `QuickBooksWarning` (server component) for the staff home.

The pattern (spec §3): the view shows what is set and has no inputs; **Set up** or **Change** opens the steps. Read
`node_modules/next/dist/docs/` on pages, `searchParams`, server actions and `redirect` before writing these.

- [ ] **Step 1: Write the failing tests**

`tests/integration/settings-quickbooks.test.ts` (first lines: the vitest import and **the stub block** from Task 3, then):

```ts
const who = vi.hoisted(() => ({ staff: null as null | { door: "staff"; staffUserId: string; name: string; email: string } }));
vi.mock("@/lib/auth/identity", () => ({
  getStaffIdentity: async () => who.staff, hasStaffSession: async () => Boolean(who.staff),
  getParentIdentity: async () => null, getParentState: async () => ({ status: "none" }), hasParentSession: async () => false,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.40" }), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw Object.assign(new Error("NEXT_NOT_FOUND"), { notFound: true }); },
}));

import { renderToStaticMarkup } from "react-dom/server";
import { db } from "@/lib/db/client";
import { auditLog, qboConnection, qboCustomer, role, roleRule, roleAssignment } from "@/lib/db/schema";
import { saveQboAppAction, beginConnectAction, disconnectAction, previewShapeAction, saveShapeAction } from "@/app/staff/(app)/settings/quickbooks/actions";
import QuickBooksSettingsPage from "@/app/staff/(app)/settings/quickbooks/page";
import QuickBooksSetupPage from "@/app/staff/(app)/settings/quickbooks/setup/page";
import { GET as callback } from "@/app/api/quickbooks/callback/route";
import { AccessDenied } from "@/lib/guards";
import { getShape } from "@/lib/roster/shape";
import { refreshRoster } from "@/lib/roster/refresh";
import { resetDb, seedStaff } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const form = (o: Record<string, string | string[]>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) for (const x of [v].flat()) f.append(k, x); return f; };
const keys = { clientId: "ABclientid1234567890", clientSecret: "s3cret-value-1234567890", environment: "sandbox" };
const redirectOf = async (p: Promise<unknown>) => ((await p.catch((e: { url?: string }) => e)) as { url?: string }).url;
const audits = async (action: string) => (await db.select().from(auditLog)).filter((r) => r.action === action);
const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
const setupHtml = async (step?: string, error?: string) => renderToStaticMarkup(await QuickBooksSetupPage({ searchParams: Promise.resolve({ ...(step ? { step } : {}), ...(error ? { error } : {}) }) }));

describe("QuickBooks settings", () => {
  let admin: Awaited<ReturnType<typeof seedStaff>>;
  beforeEach(async () => {
    await resetDb(); stub.reset(); Object.assign(stub, fznCompany());
    admin = await seedStaff({ email: "admin@club.org", name: "Admin Person", admin: true });
    who.staff = { door: "staff", staffUserId: admin.id, name: admin.name, email: admin.email };
  });
  const asEverythingRole = async () => {
    const s = await seedStaff({ email: "treasurer@club.org" });
    const [r] = await db.insert(role).values({ key: "everything", name: "Everything" }).returning();
    await db.insert(roleRule).values({ roleId: r!.id, kind: "include", pattern: "*" });
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
    who.staff = { door: "staff", staffUserId: s.id, name: s.name, email: s.email };
  };
  const callbackUrl = (q: Record<string, string>) => new Request(`http://localhost:3100/api/quickbooks/callback?${new URLSearchParams(q)}`);
  const startConnect = async () => new URL((await redirectOf(beginConnectAction()))!).searchParams.get("state")!;

  it("refuses staff whose custom role includes everything, on every action, and audits it", async () => {
    await asEverythingRole();
    for (const call of [() => saveQboAppAction(form(keys)), () => beginConnectAction(), () => disconnectAction(), () => previewShapeAction(form({ kind: "flat", members: "3" })), () => saveShapeAction(form({ kind: "flat", members: "3" }))]) {
      await expect(call()).rejects.toBeInstanceOf(AccessDenied);
    }
    expect((await audits("access.refused")).map((a) => a.permission)).toEqual(Array(5).fill("Settings.QuickBooks.ReadWrite"));
    expect(await redirectOf(QuickBooksSettingsPage())).toBe("/refused");
    expect(await redirectOf(QuickBooksSetupPage({ searchParams: Promise.resolve({}) }))).toBe("/refused");
  });

  it("step 1 saves the keys; a bad form comes back with its errors", async () => {
    expect(await saveQboAppAction(form({ ...keys, clientId: "bad id" }))).toMatchObject({ ok: false });
    expect(await saveQboAppAction(form(keys))).toEqual({ ok: true });
    expect((await audits("settings.quickbooks.save"))[0]).toMatchObject({ actorId: admin.id, permission: "Settings.QuickBooks.ReadWrite", ip: "203.0.113.40" });
  });

  it("step 2 sends the Admin to Intuit, or back to step 1 when there are no keys", async () => {
    expect(await redirectOf(beginConnectAction())).toBe("/staff/settings/quickbooks/setup?step=app&error=keys");
    await saveQboAppAction(form(keys));
    expect(await redirectOf(beginConnectAction())).toContain(`${stub.base}/authorize?client_id=ABclientid1234567890`);
  });

  it("the return from Intuit connects, reads the roster for the first time and goes to step 3", async () => {
    await saveQboAppAction(form(keys));
    const state = await startConnect();
    stub.codes.add("code-1");
    const res = await callback(callbackUrl({ code: "code-1", state, realmId: "9130000000000001" }));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(new URL(res.headers.get("location")!).pathname + new URL(res.headers.get("location")!).search).toBe("/staff/settings/quickbooks/setup?step=shape");
    expect((await db.select().from(qboConnection))[0]).toMatchObject({ realmId: "9130000000000001", companyName: "Stub Boosters" });
    expect(await db.select().from(qboCustomer)).toHaveLength(9);
    expect((await audits("quickbooks.connect"))[0]).toMatchObject({ actorId: admin.id });
  });

  it.each([
    [{ code: "code-1", state: "wrong", realmId: "9130000000000001" }, "state"],
    [{ error: "access_denied", state: "REAL" }, "denied"],
  ])("a refused return %j goes back to step 2 with the reason %s", async (q, reason) => {
    await saveQboAppAction(form(keys));
    const state = await startConnect();
    const res = await callback(callbackUrl(Object.fromEntries(Object.entries(q).map(([k, v]) => [k, v === "REAL" ? state : v]))));
    expect(new URL(res.headers.get("location")!).search).toBe(`?step=connect&error=${reason}`);
    expect((await db.select().from(qboConnection))[0]!.realmId).toBeNull();
  });

  it("the return from Intuit is refused for someone signed out or without the permission, and nothing is stored", async () => {
    await saveQboAppAction(form(keys));
    const state = await startConnect();
    stub.codes.add("code-1");
    who.staff = null;
    expect(new URL((await callback(callbackUrl({ code: "code-1", state, realmId: "9130000000000001" }))).headers.get("location")!).pathname).toBe("/staff/sign-in");
    await asEverythingRole();
    expect(new URL((await callback(callbackUrl({ code: "code-1", state, realmId: "9130000000000001" }))).headers.get("location")!).pathname).toBe("/refused");
    expect((await db.select().from(qboConnection))[0]!.realmId).toBeNull();
    expect(stub.tokenCalls()).toHaveLength(0);
  });

  it("step 3 previews a shape, then saves it and refreshes so contact details follow", async () => {
    await seedConnected(stub);
    await refreshRoster(worker);
    const chosen = { kind: "layered", family: "1", student: "3", parent: "2" };
    expect(await previewShapeAction(form(chosen))).toMatchObject({ ok: true, preview: { families: 3, students: 1, parents: 2, outside: 2 } });
    expect(await getShape()).toBeNull();
    expect(await previewShapeAction(form({ kind: "layered", family: "1", student: "1" }))).toEqual({ ok: false, errors: ["A customer type can have only one role."] });
    expect(await saveShapeAction(form(chosen))).toEqual({ ok: true, refreshed: true });
    expect(await getShape()).toEqual({ kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" });
    expect((await db.select().from(qboCustomer)).find((c) => c.qboId === "11")!.email).toBe("ana@example.com");
    expect((await audits("settings.membership.save"))[0]).toMatchObject({ actorId: admin.id, permission: "Settings.QuickBooks.ReadWrite" });
    expect((await audits("roster.refresh")).at(-1)).toMatchObject({ actorId: admin.id });
  });

  it("saving the shape still succeeds when the refresh after it fails", async () => {
    await seedConnected(stub);
    await refreshRoster(worker);
    stub.failQueryFrom = 1;
    expect(await saveShapeAction(form({ kind: "flat", members: ["3", "2"] }))).toEqual({ ok: true, refreshed: false });
    expect(await getShape()).toEqual({ kind: "flat", memberTypeIds: ["3", "2"] });
  });

  it("a step can't be reached before the one before it is done", async () => {
    expect(await redirectOf(QuickBooksSetupPage({ searchParams: Promise.resolve({ step: "connect" }) }))).toBe("/staff/settings/quickbooks/setup?step=app");
    expect(await redirectOf(QuickBooksSetupPage({ searchParams: Promise.resolve({ step: "shape" }) }))).toBe("/staff/settings/quickbooks/setup?step=app");
    await saveQboAppAction(form(keys));
    expect(await redirectOf(QuickBooksSetupPage({ searchParams: Promise.resolve({ step: "shape" }) }))).toBe("/staff/settings/quickbooks/setup?step=connect");
    expect(await setupHtml("connect")).toContain(">Sign in to Intuit</button>");
    expect(await setupHtml()).toContain(">Sign in to Intuit</button>"); // no step asked for: the first one not done yet
    expect(await setupHtml("app")).not.toContain(">Sign in to Intuit</button>");
  });

  it("step 1 shows the redirect address to copy and never the saved secret", async () => {
    await saveQboAppAction(form(keys));
    const html = await setupHtml("app");
    expect(html).toContain("http://localhost:3000/api/quickbooks/callback"); // APP_URL in the Vitest environment
    expect(html).toContain("ABclientid1234567890");
    expect(html).not.toContain("s3cret");
  });

  it("step 2 says why a return was refused", async () => {
    await saveQboAppAction(form(keys));
    expect(await setupHtml("connect", "other_company")).toContain("That is a different QuickBooks company from the one already connected.");
    expect(await setupHtml("connect", "made-up")).not.toContain("made-up");
  });

  it("step 3 lists the customer types found, and says so when there are none", async () => {
    await seedConnected(stub);
    expect(await setupHtml("shape")).toContain("The portal hasn&#x27;t read any customer types from QuickBooks yet.");
    await refreshRoster(worker);
    const html = await setupHtml("shape");
    for (const name of ["Family", "Parent", "Student", "School", "Vendor"]) expect(html).toContain(`>${name}</option>`);
  });

  it("the view shows what is set and holds no token, secret or company ID", async () => {
    expect(renderToStaticMarkup(await QuickBooksSettingsPage())).toContain("QuickBooks isn&#x27;t set up yet.");
    await seedConnected(stub);
    await refreshRoster(worker);
    await saveShapeAction(form({ kind: "layered", family: "1", student: "3", parent: "2" }));
    const html = renderToStaticMarkup(await QuickBooksSettingsPage());
    expect(html).toContain("Stub Boosters");
    expect(html).toContain("Sandbox");
    expect(html).toContain("Layered: families are Family, students are Student, parents are Parent.");
    expect(html).toContain("3 families, 1 student, 2 parents; 2 customers outside the portal");
    for (const hidden of ["at-seed", "rt-seed", "stub-secret", "9130000000000001"]) expect(html).not.toContain(hidden);
    expect(html).not.toMatch(/<input(?![^>]*type="hidden")/);
  });

  it("disconnects from the view", async () => {
    await seedConnected(stub);
    expect(await disconnectAction()).toEqual({ ok: true });
    expect(await disconnectAction()).toEqual({ ok: false, error: "QuickBooks isn't connected." });
    expect((await audits("quickbooks.disconnect"))[0]).toMatchObject({ actorId: admin.id, permission: "Settings.QuickBooks.ReadWrite" });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run tests/integration/settings-quickbooks.test.ts`
Expected: FAIL. The pages, actions and route don't exist.

- [ ] **Step 3: Write `roster-counts.ts` and the actions**

`src/app/staff/(app)/settings/quickbooks/roster-counts.ts`:

```ts
import type { Roster } from "@/lib/roster/model";

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "3 families, 1 student, 2 parents; 2 customers outside the portal", for the settings view and the roster pages. */
export function rosterCounts(roster: Roster | null): string {
  if (!roster) return "";
  const outside = `${n(roster.outside, "customer", "customers")} outside the portal`;
  if (roster.kind === "flat") return `${n(roster.members.length, "member", "members")}; ${outside}`;
  const students = roster.families.reduce((sum, f) => sum + f.students.length, 0), parents = roster.families.reduce((sum, f) => sum + f.parents.length, 0);
  return `${n(roster.families.length, "family", "families")}, ${n(students, "student", "students")}, ${n(parents, "parent", "parents")}; ${outside}`;
}
```

`src/app/staff/(app)/settings/quickbooks/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db/client";
import { qboCustomerType } from "@/lib/db/schema";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { getConnection, parseQboAppForm, saveQboApp, beginConnect, disconnect } from "@/lib/quickbooks/connection";
import { parseShapeForm, saveShape, type TypeRow } from "@/lib/roster/shape";
import { previewShape, type ShapePreview } from "@/lib/roster/queries";
import { refreshRoster } from "@/lib/roster/refresh";

const P = "Settings.QuickBooks.ReadWrite" as const;
const SETUP = "/staff/settings/quickbooks/setup";
const actor = (ctx: StaffCtx) => ({ door: "staff" as const, id: ctx.staffUserId, label: ctx.email });
const text = (f: FormData, k: string) => String(f.get(k) ?? "");
const shapeOf = async (f: FormData) => {
  const types: TypeRow[] = (await db.select().from(qboCustomerType)).map((t) => ({ qboId: t.qboId, name: t.name, active: t.active }));
  return parseShapeForm({ kind: text(f, "kind"), family: text(f, "family"), student: text(f, "student"), parent: text(f, "parent"), members: f.getAll("members").map(String) }, types);
};

export const saveQboAppAction = staffAction(P, async (ctx, form: FormData): Promise<{ ok: true } | { ok: false; errors: string[] }> => {
  const parsed = parseQboAppForm({ clientId: text(form, "clientId"), clientSecret: text(form, "clientSecret"), environment: text(form, "environment") }, (await getConnection()) !== null);
  if (!parsed.ok) return parsed;
  const r = await saveQboApp(parsed.draft, { actor: actor(ctx), ip: ctx.ip, permission: P });
  revalidatePath("/staff", "layout");
  return r;
});

/** A plain form action: it always ends in a redirect, to Intuit or back to step 1. */
export const beginConnectAction = staffAction(P, async (ctx): Promise<void> => {
  const r = await beginConnect(ctx.staffUserId);
  redirect(r.ok ? r.url : `${SETUP}?step=app&error=keys`);
});

export const disconnectAction = staffAction(P, async (ctx): Promise<{ ok: true } | { ok: false; error: string }> => {
  const r = await disconnect({ actor: actor(ctx), ip: ctx.ip, permission: P });
  revalidatePath("/staff", "layout");
  return r.ok ? { ok: true } : { ok: false, error: "QuickBooks isn't connected." };
});

export const previewShapeAction = staffAction(P, async (_ctx, form: FormData): Promise<{ ok: true; preview: ShapePreview } | { ok: false; errors: string[] }> => {
  const parsed = await shapeOf(form);
  return parsed.ok ? { ok: true, preview: await previewShape(parsed.shape) } : parsed;
});

export const saveShapeAction = staffAction(P, async (ctx, form: FormData): Promise<{ ok: true; refreshed: boolean } | { ok: false; errors: string[] }> => {
  const parsed = await shapeOf(form);
  if (!parsed.ok) return parsed;
  await saveShape(parsed.shape, { actor: actor(ctx), ip: ctx.ip, permission: P });
  // Contact details are kept only for customers the shape names, so the cache is read again under the new shape (spec §1).
  const r = await refreshRoster({ startedBy: ctx.staffUserId, actor: actor(ctx), ip: ctx.ip });
  revalidatePath("/staff", "layout");
  return { ok: true, refreshed: r.ok };
});
```

- [ ] **Step 4: Write the return from Intuit**

`src/app/api/quickbooks/callback/route.ts`:

```ts
import { NextResponse } from "next/server";
import { env } from "@/env";
import { getStaffIdentity } from "@/lib/auth/identity";
import { effectivePermissions, can } from "@/lib/permissions/effective";
import { clientIpFrom } from "@/lib/request";
import { completeConnect } from "@/lib/quickbooks/connection";
import { refreshRoster } from "@/lib/roster/refresh";

export const dynamic = "force-dynamic";

/** Intuit sends the Admin back here after they approve (or refuse) access (spec §3). Nothing is stored unless the state matches. */
export async function GET(req: Request): Promise<Response> {
  const to = (p: string) => NextResponse.redirect(new URL(p, env.APP_URL));
  const id = await getStaffIdentity();
  if (!id) return to("/staff/sign-in");
  if (!can(await effectivePermissions(id.staffUserId), "Settings.QuickBooks.ReadWrite")) return to("/refused");
  const q = new URL(req.url).searchParams;
  const actor = { door: "staff" as const, id: id.staffUserId, label: id.email }, ip = clientIpFrom(req.headers);
  const r = await completeConnect({ code: q.get("code"), state: q.get("state"), realmId: q.get("realmId"), error: q.get("error") }, { staffUserId: id.staffUserId, actor, ip });
  if (!r.ok) return to(`/staff/settings/quickbooks/setup?step=connect&error=${r.reason}`);
  // The first read, so step 3 can list the customer types. If it fails, step 3 says so and offers to read again.
  await refreshRoster({ startedBy: id.staffUserId, actor, ip });
  return to("/staff/settings/quickbooks/setup?step=shape");
}
```

- [ ] **Step 5: Write the client forms**

`src/app/staff/(app)/settings/quickbooks/forms.tsx`:

```tsx
"use client";
import { useActionState, useState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import type { QboConnectionView } from "@/lib/quickbooks/connection";
import type { MembershipShape, TypeRow } from "@/lib/roster/shape";
import type { ShapePreview } from "@/lib/roster/queries";

type Saved = { ok: true } | { ok: false; errors: string[] };
const failed = { ok: false as const, errors: [ACTION_FAILED] };
const Errors = ({ errors }: { errors: string[] }) => <ul role="alert" className="errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul>;

/** Step 1: the Intuit app's keys. A saved secret is never sent here; a blank field keeps it. */
export function AppKeysForm({ view, save }: { view: QboConnectionView; save: (f: FormData) => Promise<Saved> }) {
  const [state, run, pending] = useActionState(async (_: Saved | null, f: FormData) => safely(() => save(f), failed), null);
  return (
    <form action={run} className="stack">
      <label className="field"><span>Client ID</span>
        <input name="clientId" required autoComplete="off" spellCheck={false} defaultValue={view.clientId ?? ""} /></label>
      <label className="field"><span>Client secret{view.configured ? " (leave blank to keep the saved one)" : ""}</span>
        <input name="clientSecret" type="password" autoComplete="new-password" required={!view.configured} /></label>
      <fieldset className="field"><legend>Which QuickBooks</legend>
        <label><input type="radio" name="environment" value="sandbox" defaultChecked={view.environment !== "production"} /> Sandbox (Intuit&apos;s test companies, with the app&apos;s Development keys)</label>
        <label><input type="radio" name="environment" value="production" defaultChecked={view.environment === "production"} /> Production (the club&apos;s real books, with the app&apos;s Production keys)</label>
      </fieldset>
      {state && !state.ok && <Errors errors={state.errors} />}
      {state?.ok && <p role="status">Saved. <a href="/staff/settings/quickbooks/setup?step=connect">Next: sign in to Intuit</a></p>}
      <button className="btn" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
    </form>
  );
}

type PreviewResult = { ok: true; preview: ShapePreview } | { ok: false; errors: string[] };
type ShapeSaved = { ok: true; refreshed: boolean } | { ok: false; errors: string[] };
const names = (list: string[], total: number) => (list.length ? ` (${list.join(", ")}${total > list.length ? ", and more" : ""})` : "");

/** Step 3: flat or layered, chosen from the customer types found, with a preview before saving. */
export function ShapeForm({ types, shape, preview, save }: {
  types: TypeRow[]; shape: MembershipShape | null; preview: (f: FormData) => Promise<PreviewResult>; save: (f: FormData) => Promise<ShapeSaved>;
}) {
  const [kind, setKind] = useState<"flat" | "layered">(shape?.kind ?? "layered");
  const [seen, runPreview, previewing] = useActionState(async (_: PreviewResult | null, f: FormData) => safely(() => preview(f), failed), null);
  const [saved, runSave, saving] = useActionState(async (_: ShapeSaved | null, f: FormData) => safely(() => save(f), failed), null);
  const layered = shape?.kind === "layered" ? shape : null, flat = shape?.kind === "flat" ? shape : null;
  const pick = (name: string, label: string, value: string | null, optional: boolean) => (
    <label className="field"><span>{label}</span>
      <select name={name} defaultValue={value ?? ""} required={!optional}>
        <option value="">{optional ? "Not identified in QuickBooks" : "Choose a type"}</option>
        {types.map((t) => <option key={t.qboId} value={t.qboId}>{t.name}</option>)}
      </select></label>
  );
  const p = seen?.ok ? seen.preview : null;
  return (
    <form className="stack">
      <fieldset className="field"><legend>How is the club&apos;s membership laid out in QuickBooks?</legend>
        <label><input type="radio" name="kind" value="layered" checked={kind === "layered"} onChange={() => setKind("layered")} /> Layered: a family customer, with its students and parents as sub-customers under it</label>
        <label><input type="radio" name="kind" value="flat" checked={kind === "flat"} onChange={() => setKind("flat")} /> Flat: each member is a customer of their own</label>
      </fieldset>
      {kind === "layered" ? (
        <>
          {pick("family", "A family is a customer of this type", layered?.familyTypeId ?? null, false)}
          {pick("student", "A student is a sub-customer of this type", layered?.studentTypeId ?? null, true)}
          {pick("parent", "A parent is a sub-customer of this type", layered?.parentTypeId ?? null, true)}
        </>
      ) : (
        <fieldset className="field"><legend>A member is a customer of any of these types</legend>
          {types.map((t) => <label key={t.qboId}><input type="checkbox" name="members" value={t.qboId} defaultChecked={flat?.memberTypeIds.includes(t.qboId) ?? false} /> {t.name}</label>)}
        </fieldset>
      )}
      {seen && !seen.ok && <Errors errors={seen.errors} />}
      {p && (
        <div role="status" className="stack">
          <p><b>With this choice the portal would show:</b></p>
          {kind === "layered" ? (
            <ul>
              <li>{p.families} families{names(p.samples.families, p.families)}</li>
              <li>{p.students} students{names(p.samples.students, p.students)}</li>
              <li>{p.parents} parents{names(p.samples.parents, p.parents)}</li>
              <li>{p.outside} customers outside the portal</li>
            </ul>
          ) : (
            <ul><li>{p.members} members{names(p.samples.members, p.members)}</li><li>{p.outside} customers outside the portal</li></ul>
          )}
          <p className="hint">If that isn&apos;t what you expect, change the choice and preview again before saving.</p>
        </div>
      )}
      {saved && !saved.ok && <Errors errors={saved.errors} />}
      {saved?.ok && <p role="status">Saved. {saved.refreshed ? "The roster was read again with this shape." : "The roster couldn't be read again just now; it will be on the next refresh."} <a href="/staff/settings/quickbooks">Back to QuickBooks settings</a></p>}
      <div className="row-actions">
        <button className="btn btn-line" formAction={runPreview} disabled={previewing || saving}>{previewing ? "Counting…" : "Preview"}</button>
        <button className="btn" formAction={runSave} disabled={previewing || saving}>{saving ? "Saving…" : "Save this shape"}</button>
      </div>
    </form>
  );
}

type Disconnected = { ok: true } | { ok: false; error: string };
/** On the view, tucked inside a closed section so it isn't pressed by accident. */
export function DisconnectButton({ disconnect }: { disconnect: () => Promise<Disconnected> }) {
  const [state, run, pending] = useActionState(async () => safely(() => disconnect(), { ok: false as const, error: ACTION_FAILED }), null);
  return (
    <form action={run} className="stack">
      {state && !state.ok && <p role="alert" className="errors">{state.error}</p>}
      {state?.ok && <p role="status">Disconnected.</p>}
      <button className="btn btn-line" disabled={pending}>{pending ? "Disconnecting…" : "Disconnect QuickBooks"}</button>
    </form>
  );
}
```

- [ ] **Step 6: Write the steps page**

`src/app/staff/(app)/settings/quickbooks/setup/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { connectionView, qboRedirectUri } from "@/lib/quickbooks/connection";
import { loadRosterPage } from "@/lib/roster/queries";
import { CopyField } from "@/app/components/sign-in-settings/copy-field";
import { AppKeysForm, ShapeForm } from "../forms";
import { saveQboAppAction, beginConnectAction, previewShapeAction, saveShapeAction } from "../actions";

export const metadata = { title: "Set up QuickBooks" };
export const dynamic = "force-dynamic";

type Step = "app" | "connect" | "shape";
const STEPS: { step: Step; label: string }[] = [{ step: "app", label: "1. Intuit app" }, { step: "connect", label: "2. Sign in to Intuit" }, { step: "shape", label: "3. Membership shape" }];
const SETUP = "/staff/settings/quickbooks/setup";
const REFUSED: Record<string, string> = {
  keys: "Save the Intuit app's keys first.",
  not_configured: "Save the Intuit app's keys first.",
  state: "That return from Intuit didn't match a sign-in started here, or it was more than 10 minutes old. Start again.",
  denied: "Intuit didn't give the portal access. Start again and choose Connect when Intuit asks.",
  other_company: "That is a different QuickBooks company from the one already connected. Disconnect first if you mean to switch companies.",
  intuit: "Intuit refused the request. Check the Client ID, the Client secret and the choice of sandbox or production in step 1, and that the redirect address is on the Intuit app.",
};

export default async function QuickBooksSetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireStaffPage("Settings.QuickBooks.ReadWrite");
  const sp = await searchParams;
  const one = (k: string) => { const v = sp[k]; return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined; };
  const [conn, page] = await Promise.all([connectionView(), loadRosterPage()]);
  // A step opens only when the one before it is done (spec §3). With no step asked for: the first one not done yet.
  const reachable: Step = !conn.configured ? "app" : !conn.connected ? "connect" : "shape";
  const order: Step[] = ["app", "connect", "shape"];
  const asked = order.find((s) => s === one("step"));
  if (asked && order.indexOf(asked) > order.indexOf(reachable)) redirect(`${SETUP}?step=${reachable}`);
  const step: Step = asked ?? reachable;
  const error = REFUSED[one("error") ?? ""];
  return (
    <main className="wrap single">
      <h1 className="page-title">Set up QuickBooks</h1>
      <ol className="setup-progress">{STEPS.map((s) => <li key={s.step} aria-current={s.step === step ? "step" : undefined}>{s.label}</li>)}</ol>
      {error && <p role="alert" className="errors">{error}</p>}

      {step === "app" && (
        <section className="box" aria-labelledby="qbo-app-h"><h2 id="qbo-app-h">Step 1: Your Intuit app</h2>
          <p>The portal reaches QuickBooks through an app the club registers with Intuit. This step tells the portal which app that is. Nothing is sent to Intuit yet.</p>
          <ol className="steps-list">
            <li>Sign in at <a href="https://developer.intuit.com" target="_blank" rel="noreferrer">developer.intuit.com</a> and open the club&apos;s app (or create one for QuickBooks Online, with the Accounting scope).</li>
            <li>On the app&apos;s <b>Keys and credentials</b> page, add this redirect address exactly, under the keys you are going to use (Development for sandbox, Production for the real books):
              <CopyField label="Redirect address" value={qboRedirectUri()} /></li>
            <li>Copy the <b>Client ID</b> and <b>Client secret</b> from that same page into the form below, and choose sandbox or production to match.</li>
          </ol>
          <AppKeysForm view={conn} save={saveQboAppAction} />
          <p className="box-foot"><a href="/staff/settings/quickbooks">Back to QuickBooks settings</a></p>
        </section>
      )}

      {step === "connect" && (
        <section className="box" aria-labelledby="qbo-connect-h"><h2 id="qbo-connect-h">Step 2: Sign in to Intuit</h2>
          <p>This sends you to Intuit to choose the club&apos;s QuickBooks company and approve access, then brings you back here. Sign in as someone who is an admin of that company. The portal only reads from QuickBooks; it changes nothing there.</p>
          {conn.connected && <p className="hint">QuickBooks is connected to <b>{conn.companyName ?? "a company"}</b>. Signing in again renews the connection to the same company.</p>}
          <form action={beginConnectAction}><button className="btn">Sign in to Intuit</button></form>
          <p className="box-foot"><a href={`${SETUP}?step=app`}>Back to step 1</a>{conn.connected && <> · <a href={`${SETUP}?step=shape`}>Skip to step 3</a></>}</p>
        </section>
      )}

      {step === "shape" && (
        <section className="box" aria-labelledby="qbo-shape-h"><h2 id="qbo-shape-h">Step 3: The shape of your membership</h2>
          <p>Tell the portal which QuickBooks customer types are the club&apos;s members. Customers of any other type, such as schools or vendors, stay out of the portal. You can change this later.</p>
          {page.types.length === 0
            ? <p role="status">The portal hasn&apos;t read any customer types from QuickBooks yet. Open <a href="/staff/roster">Roster</a> and select <b>Refresh now</b>, then come back. If QuickBooks has no customer types, create them there first (Sales, Customers, Customer types).</p>
            : <ShapeForm types={page.types} shape={page.shape} preview={previewShapeAction} save={saveShapeAction} />}
          <p className="box-foot"><a href={`${SETUP}?step=connect`}>Back to step 2</a> · <a href="/staff/settings/quickbooks">Back to QuickBooks settings</a></p>
        </section>
      )}
    </main>
  );
}
```

- [ ] **Step 7: Write the view**

`src/app/staff/(app)/settings/quickbooks/page.tsx`:

```tsx
import { requireStaffPage } from "@/lib/guards";
import { connectionView } from "@/lib/quickbooks/connection";
import { quickbooksProblems } from "@/lib/quickbooks/health";
import { loadRosterPage } from "@/lib/roster/queries";
import { lastWake } from "@/lib/jobs/runner";
import { LocalTime } from "@/app/components/local-time";
import { DisconnectButton } from "./forms";
import { disconnectAction } from "./actions";
import { rosterCounts } from "./roster-counts";

export const metadata = { title: "QuickBooks settings" };
export const dynamic = "force-dynamic";

/** What is set, shown plainly, with no inputs (spec §3 The settings view). Changing anything opens the steps. */
export default async function QuickBooksSettingsPage() {
  await requireStaffPage("Settings.QuickBooks.ReadWrite");
  const [conn, page, wake, problems] = await Promise.all([connectionView(), loadRosterPage(), lastWake(), quickbooksProblems()]);
  const when = (iso: string | null) => (iso ? <LocalTime iso={iso} /> : "Not yet");
  return (
    <main className="wrap single">
      <h1 className="page-title">QuickBooks</h1>
      <p className="lede">The club&apos;s families and members come from QuickBooks. The portal reads them; it changes nothing in QuickBooks. Only Admins can change this, because it reaches the club&apos;s books.</p>
      {problems.length > 0 && <section className="box" role="status" aria-labelledby="qbo-problems-h"><h2 id="qbo-problems-h">Needs attention</h2><ul>{problems.map((p) => <li key={p.kind}>{p.text}</li>)}</ul></section>}

      <section className="box" aria-labelledby="qbo-conn-h"><h2 id="qbo-conn-h">Connection</h2>
        {!conn.configured ? <p>QuickBooks isn&apos;t set up yet.</p> : (
          <dl className="details">
            <dt>Status</dt><dd>{conn.connected ? <>Connected to <b>{conn.companyName ?? "a QuickBooks company"}</b></> : "Not connected. The Intuit app's keys are saved."}</dd>
            <dt>Which QuickBooks</dt><dd>{conn.environment === "production" ? "Production (the club's real books)" : "Sandbox (an Intuit test company)"}</dd>
            <dt>Client ID</dt><dd><code>{conn.clientId}</code></dd>
            {conn.connected && <><dt>Connected</dt><dd>{when(conn.connectedAt)}</dd>
              <dt>Last renewed</dt><dd>{when(conn.lastTokenRefreshAt)}</dd>
              <dt>Expires</dt><dd>{when(conn.refreshExpiresAt)} unless it is renewed first. The worker renews it every day.</dd></>}
          </dl>
        )}
      </section>

      <section className="box" aria-labelledby="qbo-shape-h"><h2 id="qbo-shape-h">Membership shape</h2>
        <p>{page.shapeWords ?? "Not chosen yet."}</p>
        {page.brokenTypes.length > 0 && <p role="status">This shape names a customer type QuickBooks no longer has. Choose the shape again.</p>}
      </section>

      <section className="box" aria-labelledby="qbo-roster-h"><h2 id="qbo-roster-h">Roster</h2>
        <dl className="details">
          <dt>Last read from QuickBooks</dt><dd>{page.lastOkAt ? <LocalTime iso={page.lastOkAt} /> : "Not yet"}{page.lastRun && !page.lastRun.ok ? <> (the latest try failed: {page.lastRun.detail})</> : null}</dd>
          <dt>What it found</dt><dd>{rosterCounts(page.roster) || "Nothing to show until a shape is chosen."}</dd>
          <dt>Worker</dt><dd>{wake ? <>Last checked in <LocalTime iso={wake} /></> : "Hasn't checked in yet."}</dd>
        </dl>
      </section>

      <section className="box" aria-labelledby="qbo-change-h"><h2 id="qbo-change-h">{conn.configured ? "Change" : "Set up"}</h2>
        <p>{conn.configured ? "Open the steps to change the Intuit app's keys, renew the connection or choose the shape again." : "Three steps: the Intuit app's keys, signing in to Intuit, and the shape of your membership."}</p>
        <p><a className="btn" href="/staff/settings/quickbooks/setup">{conn.configured ? "Change" : "Set up"}</a></p>
        {conn.connected && <details><summary>Disconnect</summary>
          <p>This asks Intuit to cancel the portal&apos;s access and deletes its copy of the connection. The Intuit app&apos;s keys and the last roster stay, and the roster is marked as no longer current.</p>
          <DisconnectButton disconnect={disconnectAction} /></details>}
      </section>
    </main>
  );
}
```

- [ ] **Step 8: Add the menu entry and the staff home warning**

`src/app/staff/(app)/layout.tsx`: in `nav`, after the Mail entry:

```ts
    ...(can(e, "Settings.QuickBooks.ReadWrite") ? [{ href: "/staff/settings/quickbooks", label: "QuickBooks" }] : []),
```

`src/app/staff/(app)/quickbooks-warning.tsx`:

```tsx
import { quickbooksProblems } from "@/lib/quickbooks/health";

/** Shown to Admins on the staff home while QuickBooks needs attention (spec §5 The staff warning). */
export async function QuickBooksWarning() {
  const problems = await quickbooksProblems();
  if (!problems.length) return null;
  return (
    <section className="box" role="status" aria-labelledby="qbo-warn-h"><h2 id="qbo-warn-h">QuickBooks needs attention</h2>
      <ul>{problems.map((p) => <li key={p.kind}>{p.text}</li>)}</ul>
      <p className="box-foot"><a className="btn btn-line" href="/staff/settings/quickbooks">Open QuickBooks settings</a></p>
    </section>
  );
}
```

`src/app/staff/(app)/page.tsx`: import it and add, after the `SecretExpiryWarning` line:

```tsx
      {can(ctx.effective, "Settings.QuickBooks.ReadWrite") && <QuickBooksWarning />}
```

Add to `docs/ui-backlog.md`, under **Settings as a whole**:

```markdown
- **QuickBooks is the first settings page in the new pattern** (2026-11-11). A plain view of what is set, with the steps
  on their own page. It has no styling of its own yet: the view is a list of labels and values, and the steps reuse the
  setup page's progress list. When Sign-in and Mail move to the same pattern, give all three one look.
```

- [ ] **Step 9: Run the tests to see them pass**

Run: `pnpm vitest run tests/integration/settings-quickbooks.test.ts tests/integration/invariants.test.ts`
Expected: PASS. (The invariants test now also covers `settings/quickbooks/actions.ts`.)

- [ ] **Step 10: Full checks and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`, then the build command from Global Constraints.
Expected: all clean; the build lists `/staff/settings/quickbooks`, `/staff/settings/quickbooks/setup`,
`/api/quickbooks/callback` and `/api/internal/worker`.

```bash
git add "src/app/staff/(app)" src/app/api/quickbooks docs/ui-backlog.md tests/integration/settings-quickbooks.test.ts
git commit -m "feat(settings): connect QuickBooks and choose the membership shape, as a view with three steps

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 8: The roster pages

**Files:**
- Create: `src/app/staff/(app)/roster/page.tsx`, `.../roster/[id]/page.tsx`, `.../roster/actions.ts`, `.../roster/refresh-button.tsx`
- Modify: `src/app/staff/(app)/layout.tsx`
- Create: `tests/integration/roster-pages.test.ts`

**Interfaces:**
- Consumes: `loadRosterPage`, `rosterEntry` (Task 5); `refreshRoster` (Task 4); `rosterCounts` (Task 7,
  `@/app/staff/(app)/settings/quickbooks/roster-counts`); `staffAction`, `requireStaffPage`; `writeAudit`; `LocalTime`.
- Produces:
  - `refreshRosterAction(): Promise<{ ok: true; message: string } | { ok: false; error: string }>` (`staffAction("Roster.Read", …)`).
  - pages `/staff/roster` (optional `?q=`) and `/staff/roster/<QuickBooks ID>`.
  - audit action `roster.family.read` with `targetType: "qbo_customer"`, `targetId: <QuickBooks ID>`.

The list shows names and counts only. Email and phone are on the family's (or member's) own page, and opening that page
is what gets audited. Read `node_modules/next/dist/docs/` on dynamic route segments and `notFound` first.

- [ ] **Step 1: Write the failing tests**

`tests/integration/roster-pages.test.ts` (first lines: the vitest import and **the stub block** from Task 3, then):

```ts
const who = vi.hoisted(() => ({ staff: null as null | { door: "staff"; staffUserId: string; name: string; email: string } }));
vi.mock("@/lib/auth/identity", () => ({
  getStaffIdentity: async () => who.staff, hasStaffSession: async () => Boolean(who.staff),
  getParentIdentity: async () => null, getParentState: async () => ({ status: "none" }), hasParentSession: async () => false,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "cf-connecting-ip": "203.0.113.40" }), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => { throw Object.assign(new Error("NEXT_REDIRECT"), { url }); },
  notFound: () => { throw Object.assign(new Error("NEXT_NOT_FOUND"), { notFound: true }); },
}));

import { renderToStaticMarkup } from "react-dom/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, qboCustomerType, role, roleRule, roleAssignment, jobRun } from "@/lib/db/schema";
import RosterPage from "@/app/staff/(app)/roster/page";
import RosterEntryPage from "@/app/staff/(app)/roster/[id]/page";
import { refreshRosterAction } from "@/app/staff/(app)/roster/actions";
import { AccessDenied } from "@/lib/guards";
import { disconnect } from "@/lib/quickbooks/connection";
import { refreshRoster } from "@/lib/roster/refresh";
import { saveShape } from "@/lib/roster/shape";
import { resetDb, seedStaff, seedParent, seedGuardian } from "../helpers/db";
import { startQboStub, seedConnected, fznCompany, FZN_SHAPE, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const worker = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
const audits = async (action: string) => (await db.select().from(auditLog)).filter((r) => r.action === action);
const list = async (q?: string) => renderToStaticMarkup(await RosterPage({ searchParams: Promise.resolve(q ? { q } : {}) }));
const entry = async (id: string) => renderToStaticMarkup(await RosterEntryPage({ params: Promise.resolve({ id }) }));
const thrown = async (p: Promise<unknown>) => (await p.catch((e: { url?: string; notFound?: boolean }) => e)) as { url?: string; notFound?: boolean };

describe("the roster pages", () => {
  let reader: Awaited<ReturnType<typeof seedStaff>>;
  beforeEach(async () => {
    await resetDb(); stub.reset(); Object.assign(stub, fznCompany());
    reader = await seedStaff({ email: "registrar@club.org", name: "Reg Istrar" });
    const [r] = await db.insert(role).values({ key: "roster", name: "Roster" }).returning();
    await db.insert(roleRule).values({ roleId: r!.id, kind: "include", pattern: "Roster.*" });
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: reader.id });
    who.staff = { door: "staff", staffUserId: reader.id, name: reader.name, email: reader.email };
  });
  const ready = async () => {
    await seedConnected(stub);
    await saveShape(FZN_SHAPE, { actor: worker.actor, ip: null });
    await refreshRoster(worker);
  };

  it("refuses staff without Roster.Read", async () => {
    const other = await seedStaff({ email: "volunteer@club.org" });
    who.staff = { door: "staff", staffUserId: other.id, name: other.name, email: other.email };
    expect((await thrown(RosterPage({ searchParams: Promise.resolve({}) }))).url).toBe("/refused");
    expect((await thrown(RosterEntryPage({ params: Promise.resolve({ id: "10" }) }))).url).toBe("/refused");
    await expect(refreshRosterAction()).rejects.toBeInstanceOf(AccessDenied);
    expect(await audits("roster.family.read")).toEqual([]);
  });

  it("says what is missing before there is a roster", async () => {
    expect(await list()).toContain("QuickBooks isn&#x27;t connected yet.");
    await seedConnected(stub);
    await refreshRoster(worker);
    expect(await list()).toContain("The membership shape hasn&#x27;t been chosen yet.");
    await saveShape(FZN_SHAPE, { actor: worker.actor, ip: null });
    await db.delete(qboCustomerType).where(eq(qboCustomerType.qboId, "2"));
    const html = await list();
    expect(html).toContain("The membership shape names a customer type QuickBooks no longer has");
    expect(html).not.toContain("Rivera Family");
  });

  it("lists families with their counts, marks inactive ones, and leaves out customers outside the shape", async () => {
    await ready();
    const html = await list();
    expect(html.indexOf("Chen Family")).toBeLessThan(html.indexOf("Rivera Family"));
    expect(html).toContain('href="/staff/roster/10"');
    expect(html).toMatch(/Rivera Family<\/a><span class="when">1 student, 1 parent<\/span>/);
    expect(html).toMatch(/Old Family<\/a><span class="when">0 students, 0 parents · Inactive in QuickBooks<\/span>/);
    expect(html).not.toContain("Lincoln High");
    expect(html).not.toContain("ana@example.com"); // contact details are on the family's own page
    expect(html).toContain("3 families, 1 student, 2 parents; 2 customers outside the portal");
  });

  it("finds families by name, treating what was typed as plain text", async () => {
    await ready();
    const html = await list("RIVER");
    expect(html).toContain("Rivera Family");
    expect(html).not.toContain('href="/staff/roster/20"');
    expect(await list("%")).toContain("No family matches");
  });

  it("shows Needs attention with plain words, linking only to things that have a page", async () => {
    await ready();
    const html = await list();
    expect(html).toContain("No student is listed under this family in QuickBooks.");
    expect(html).toContain("This student or parent isn&#x27;t directly under a family in QuickBooks.");
    expect(html).not.toContain('href="/staff/roster/50"'); // a stray student has no page
  });

  it("renders hostile names as text", async () => {
    stub.customers.push(
      { Id: "90", DisplayName: "<img src=x onerror=alert(1)>", Active: true, SyncToken: "0", CustomerTypeRef: { value: "1" } },
      { Id: "91", DisplayName: 'Smith & "Sons"', Active: true, SyncToken: "0", CustomerTypeRef: { value: "2" }, ParentRef: { value: "90" } },
    );
    await ready();
    const html = await list();
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("Smith &amp; &quot;Sons&quot;"); // in Needs attention: a parent with no email
    const page = await entry("90");
    expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("Smith &amp; &quot;Sons&quot;");
  });

  it("a family's page shows its students, its parents and the portal sign-ins, and the visit is audited", async () => {
    await ready();
    const ana = await seedParent({ name: "Ana R.", email: "ana.portal@example.com" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10", status: "invited" });
    const html = await entry("10");
    expect(html).toContain("Rivera Family");
    expect(html).toContain("Leo Rivera");
    expect(html).toContain("ana@example.com");
    expect(html).toContain("555-0101");
    expect(html).toContain("ana.portal@example.com");
    expect(html).toContain("Invited");
    expect((await audits("roster.family.read"))).toHaveLength(1);
    expect((await audits("roster.family.read"))[0]).toMatchObject({ actorId: reader.id, actorLabel: "registrar@club.org", permission: "Roster.Read",
      targetType: "qbo_customer", targetId: "10", ip: "203.0.113.40" });
  });

  it("is not found, and writes no audit row, for anything that isn't a family", async () => {
    await ready();
    for (const id of ["30", "11", "nope", "10%27"]) expect((await thrown(RosterEntryPage({ params: Promise.resolve({ id }) }))).notFound).toBe(true);
    expect(await audits("roster.family.read")).toEqual([]);
  });

  it("flat: lists members and opens one", async () => {
    await seedConnected(stub);
    await saveShape({ kind: "flat", memberTypeIds: ["2"] }, { actor: worker.actor, ip: null });
    await refreshRoster(worker);
    const html = await list();
    expect(html).toContain("Ana Rivera");
    expect(html).toContain("Find a member");
    expect(html).not.toContain("Rivera Family");
    expect(await entry("11")).toContain("ana@example.com");
  });

  it("says the roster is no longer current after a disconnect", async () => {
    await ready();
    await disconnect({ actor: worker.actor, ip: null });
    const html = await list();
    expect(html).toContain("QuickBooks is disconnected, so this roster is no longer current.");
    expect(html).toContain("Rivera Family");
  });

  it("Refresh now reads QuickBooks again, at most once every 5 minutes", async () => {
    await ready();
    await db.update(jobRun).set({ startedAt: new Date(Date.now() - 6 * 60_000) });
    expect(await refreshRosterAction()).toEqual({ ok: true, message: "Read 9 customers from QuickBooks." });
    expect(await refreshRosterAction()).toEqual({ ok: false, error: "The roster was refreshed less than 5 minutes ago. Try again shortly." });
    expect((await audits("roster.refresh")).at(-1)).toMatchObject({ actorId: reader.id, ip: "203.0.113.40" });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run tests/integration/roster-pages.test.ts`
Expected: FAIL. The pages and the action don't exist.

- [ ] **Step 3: Write the action and the button**

`src/app/staff/(app)/roster/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { refreshRoster } from "@/lib/roster/refresh";

const P = "Roster.Read" as const;

export const refreshRosterAction = staffAction(P, async (ctx): Promise<{ ok: true; message: string } | { ok: false; error: string }> => {
  const r = await refreshRoster({ startedBy: ctx.staffUserId, actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, manual: true });
  revalidatePath("/staff", "layout");
  if (r.ok) return { ok: true, message: `Read ${r.customers} customers from QuickBooks.` };
  return { ok: false, error:
    r.reason === "running" ? "A refresh is already under way. Try again in a minute."
    : r.reason === "too_soon" ? "The roster was refreshed less than 5 minutes ago. Try again shortly."
    : r.reason === "not_connected" ? "QuickBooks isn't connected. An Admin can connect it under QuickBooks."
    : `The refresh didn't work: ${r.error ?? "no reason was recorded"}` };
});
```

`src/app/staff/(app)/roster/refresh-button.tsx`:

```tsx
"use client";
import { useActionState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";

type Result = { ok: true; message: string } | { ok: false; error: string };

export function RefreshButton({ refresh }: { refresh: () => Promise<Result> }) {
  const [state, run, pending] = useActionState(async () => safely(() => refresh(), { ok: false as const, error: ACTION_FAILED }), null);
  return (
    <form action={run} className="stack">
      {state && !state.ok && <p role="alert" className="errors">{state.error}</p>}
      {state?.ok && <p role="status">{state.message}</p>}
      <button className="btn btn-line" disabled={pending}>{pending ? "Reading QuickBooks…" : "Refresh now"}</button>
    </form>
  );
}
```

- [ ] **Step 4: Write the list page**

`src/app/staff/(app)/roster/page.tsx`:

```tsx
import { requireStaffPage } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { loadRosterPage } from "@/lib/roster/queries";
import { LocalTime } from "@/app/components/local-time";
import { rosterCounts } from "../settings/quickbooks/roster-counts";
import { RefreshButton } from "./refresh-button";
import { refreshRosterAction } from "./actions";

export const metadata = { title: "Roster" };
export const dynamic = "force-dynamic";

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export default async function RosterPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireStaffPage("Roster.Read");
  const sp = await searchParams;
  const typed = (typeof sp.q === "string" ? sp.q : Array.isArray(sp.q) ? sp.q[0] ?? "" : "").trim().slice(0, 100);
  const q = typed.toLowerCase();
  const page = await loadRosterPage();
  const admin = can(ctx.effective, "Settings.QuickBooks.ReadWrite");
  const settings = admin ? <> <a href="/staff/settings/quickbooks">Open QuickBooks settings</a></> : " An Admin can do that under QuickBooks.";
  const matches = (name: string) => !q || name.toLowerCase().includes(q); // a plain substring: nothing typed is a pattern
  const roster = page.roster;
  const rows = !roster ? [] : roster.kind === "flat"
    ? roster.members.filter((m) => matches(m.displayName)).map((m) => ({ id: m.qboId, name: m.displayName, note: m.active ? "" : "Inactive in QuickBooks" }))
    : roster.families.filter((f) => matches(f.customer.displayName)).map((f) => ({ id: f.customer.qboId, name: f.customer.displayName,
        note: `${n(f.students.length, "student", "students")}, ${n(f.parents.length, "parent", "parents")}${f.customer.active ? "" : " · Inactive in QuickBooks"}` }));
  const hasPage = new Set(!roster ? [] : roster.kind === "flat" ? roster.members.map((m) => m.qboId) : roster.families.map((f) => f.customer.qboId));
  const noun = roster?.kind === "flat" ? "member" : "family";
  return (
    <main className="wrap single">
      <h1 className="page-title">Roster</h1>
      <p className="lede">The club&apos;s {roster?.kind === "flat" ? "members" : "families"} as QuickBooks lists them. This is a copy for looking at; changes are made in QuickBooks.</p>

      {!roster && (
        <section className="box" role="status" aria-labelledby="roster-none-h"><h2 id="roster-none-h">Nothing to show yet</h2>
          <p>{page.brokenTypes.length ? <>The membership shape names a customer type QuickBooks no longer has, so the roster can&apos;t be shown until the shape is chosen again.{settings}</>
            : page.shape ? <>The roster hasn&apos;t been read from QuickBooks yet.</>
            : page.connected ? <>The membership shape hasn&apos;t been chosen yet.{settings}</>
            : <>QuickBooks isn&apos;t connected yet.{settings}</>}</p>
        </section>
      )}

      {roster && (
        <section className="box" aria-labelledby="roster-list-h"><h2 id="roster-list-h">{roster.kind === "flat" ? "Members" : "Families"}</h2>
          {!page.connected && <p role="status">QuickBooks is disconnected, so this roster is no longer current.</p>}
          <p>{rosterCounts(roster)}</p>
          <form method="get" role="search" className="stack">
            <label className="field"><span>Find a {noun}</span><input name="q" type="search" defaultValue={typed} autoComplete="off" /></label>
            <button className="btn btn-line">Find</button>
          </form>
          {rows.length === 0
            ? <p role="status">No {noun} matches{typed ? <> &quot;{typed}&quot;</> : ""}.</p>
            : <ul className="lines">{rows.map((r) => (
                <li key={r.id}><div><a className="what" href={`/staff/roster/${encodeURIComponent(r.id)}`}>{r.name}</a>{r.note && <span className="when">{r.note}</span>}</div></li>))}</ul>}
        </section>
      )}

      {roster && page.attention.length > 0 && (
        <section className="box" aria-labelledby="roster-attn-h"><h2 id="roster-attn-h">Needs attention ({page.attention.length})</h2>
          <p>Things to tidy up in QuickBooks, or in the portal&apos;s sign-ins. The portal changes none of them.</p>
          <ul className="lines">{page.attention.map((a, i) => (
            <li key={`${a.rule}-${a.qboId ?? a.name}-${i}`}><div>
              {a.qboId && hasPage.has(a.qboId) ? <a className="what" href={`/staff/roster/${encodeURIComponent(a.qboId)}`}>{a.name}</a> : <span className="what">{a.name}</span>}
              <span className="when">{a.detail}</span></div></li>))}</ul>
        </section>
      )}

      <section className="box" aria-labelledby="roster-fresh-h"><h2 id="roster-fresh-h">How fresh this is</h2>
        <p>{page.lastOkAt ? <>Last read from QuickBooks <LocalTime iso={page.lastOkAt} />.</> : "Not read from QuickBooks yet."}
          {page.lastRun && !page.lastRun.ok ? <> The latest try failed: {page.lastRun.detail}</> : null} The worker reads it again every day.</p>
        {page.connected && <RefreshButton refresh={refreshRosterAction} />}
      </section>
    </main>
  );
}
```

- [ ] **Step 5: Write the family (or member) page**

`src/app/staff/(app)/roster/[id]/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { requireStaffPage } from "@/lib/guards";
import { writeAudit } from "@/lib/audit/log";
import { rosterEntry } from "@/lib/roster/queries";
import type { Cust } from "@/lib/roster/model";
import type { SignIn } from "@/lib/roster/attention";

export const metadata = { title: "Roster" };
export const dynamic = "force-dynamic";

const STATUS: Record<SignIn["status"], string> = { invited: "Invited", active: "Active", disabled: "Disabled" };
const inactive = (c: Cust) => (c.active ? "" : " · Inactive in QuickBooks");

function People({ id, title, people, contact, empty }: { id: string; title: string; people: Cust[]; contact: boolean; empty: string }) {
  return (
    <section className="box" aria-labelledby={id}><h2 id={id}>{title}</h2>
      {people.length === 0 ? <p>{empty}</p> : <ul className="lines">{people.map((p) => (
        <li key={p.qboId}><div><span className="what">{p.displayName}</span>
          <span className="when">{contact ? `${p.email ?? "No email address"} · ${p.phone ?? "No phone number"}` : ""}{inactive(p).replace(/^ · /, contact ? " · " : "")}</span></div></li>))}</ul>}
    </section>
  );
}

function SignIns({ signIns }: { signIns: SignIn[] }) {
  return (
    <section className="box" aria-labelledby="entry-signins-h"><h2 id="entry-signins-h">Portal sign-ins</h2>
      <p>The people who can sign in to the portal for this QuickBooks customer. This comes from the portal, not from QuickBooks.</p>
      {signIns.length === 0 ? <p>Nobody can sign in for it yet.</p> : <ul className="lines">{signIns.map((s) => (
        <li key={s.guardianId}><div><span className="what">{s.name}</span><span className="when">{s.email} · {STATUS[s.status]}</span></div></li>))}</ul>}
    </section>
  );
}

export default async function RosterEntryPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireStaffPage("Roster.Read");
  const { id } = await params;
  let qboId: string;
  try { qboId = decodeURIComponent(id); } catch { notFound(); }
  const entry = await rosterEntry(qboId);
  if (!entry) notFound();
  // A staff read of family data (spec §5): recorded before anything is shown.
  await writeAudit({ actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, action: "roster.family.read", permission: "Roster.Read",
    targetType: "qbo_customer", targetId: qboId, ip: ctx.ip });
  const customer = entry.kind === "family" ? entry.family.customer : entry.member;
  return (
    <main className="wrap single">
      <h1 className="page-title">{customer.displayName}</h1>
      <p className="lede">{entry.kind === "family" ? "A family" : "A member"} as QuickBooks lists it{customer.active ? "" : ". It is inactive in QuickBooks"}. <a href="/staff/roster">Back to the roster</a></p>
      {entry.kind === "family" ? (
        <>
          <People id="entry-students-h" title="Students" people={entry.family.students} contact={false} empty="QuickBooks lists no students under this family." />
          <People id="entry-parents-h" title="Parents in QuickBooks" people={entry.family.parents} contact empty="QuickBooks lists no parents under this family." />
        </>
      ) : (
        <People id="entry-member-h" title="In QuickBooks" people={[entry.member]} contact empty="" />
      )}
      <SignIns signIns={entry.signIns} />
    </main>
  );
}
```

- [ ] **Step 6: Add the menu entry**

`src/app/staff/(app)/layout.tsx`: in `nav`, after the Home entry:

```ts
    ...(can(e, "Roster.Read") ? [{ href: "/staff/roster", label: "Roster" }] : []),
```

- [ ] **Step 7: Run the tests to see them pass**

Run: `pnpm vitest run tests/integration/roster-pages.test.ts tests/integration/invariants.test.ts`
Expected: PASS.

- [ ] **Step 8: Full checks and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`, then the build command from Global Constraints.
Expected: all clean; the build lists `/staff/roster` and `/staff/roster/[id]`.

```bash
git add "src/app/staff/(app)" tests/integration/roster-pages.test.ts
git commit -m "feat(roster): staff see families, students and parents from QuickBooks, with a clean-up list

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

### Task 9: The worker container, the end-to-end run and the documents

**Files:**
- Modify: `Dockerfile`, `docker-compose.poc.yml`, `scripts/poc/deploy.sh`, `tests/unit/deploy-script.test.ts`
- Create: `tests/unit/worker-container.test.ts`
- Modify: `scripts/seed-e2e.ts`
- Create: `tests/e2e/staff-session.ts`, `tests/e2e/quickbooks.spec.ts`
- Modify: `docs/runbooks/poc-linuxdev.md`, `docs/superpowers/plans/2026-11-07-v1-roadmap.md`,
  `docs/superpowers/specs/2026-11-06-booster-rocket-v1-design.md`,
  `docs/superpowers/specs/2026-11-10-quickbooks-connection-and-roster-design.md`

**Interfaces:**
- Consumes: `scripts/worker.mjs` (Task 6); the pages from Tasks 7 and 8; the tables from Task 2.
- Produces: a `worker` service in the compose file; `deploy.sh` starts it; an e2e staff session helper
  `staffSessionCookie(): { name: string; value: string; domain: string; path: string; httpOnly: boolean; sameSite: "Lax" }`.

- [ ] **Step 1: Write the failing container tests**

`tests/unit/worker-container.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const compose = readFileSync("docker-compose.poc.yml", "utf8");
const dockerfile = readFileSync("Dockerfile", "utf8");
const worker = compose.slice(compose.indexOf("\n  worker:"), compose.indexOf("\n  migrate:"));

describe("the worker container", () => {
  it("ships the worker script in the image, beside the other tools", () => {
    expect(dockerfile).toMatch(/COPY scripts\/migrate\.mjs [^\n]*scripts\/worker\.mjs[^\n]* \.\/scripts\//);
  });
  it("runs the same image as the app, in worker mode, and comes back after a restart", () => {
    expect(worker).toContain("image: booster-rocket-app:current");
    expect(worker).toContain('command: ["node", "tools/scripts/worker.mjs"]');
    expect(worker).toContain("container_name: booster-rocket-worker");
    expect(worker).toContain("restart: unless-stopped");
    expect(worker).toContain("env_file: .env.poc");
    expect(worker).not.toContain("build:");
  });
  it("has no port, no tunnel network and no HTTP health check of its own", () => {
    expect(worker).toContain("networks: [internal]");
    expect(worker).not.toContain("edge");
    expect(worker).not.toContain("ports:");
    expect(worker).toMatch(/healthcheck:\s*\n\s+disable: true/);
  });
  it("waits for the app", () => {
    expect(worker).toMatch(/depends_on:\s*\n\s+app: \{ condition: service_healthy \}/);
  });
});
```

In `tests/unit/deploy-script.test.ts`:
- in the `docker` stub's `case`, add this line above `*) exit 0;;`:
  `*"up -d --no-deps --force-recreate worker"*) exit \${WORKER_FAIL:-0};;`
- in the existing test "pulls, builds, migrates, recreates the app and waits for health, in that order", add one more
  expectation at the end, in that test's own style: the call `up -d --no-deps --force-recreate worker` appears in
  `calls()` after `up -d --no-deps --force-recreate app`.
- add:

```ts
  it("starts the worker after the app is healthy, and a worker that won't start doesn't fail the deploy", () => {
    const ok = run();
    expect(ok.status).toBe(0);
    expect(calls().indexOf("--force-recreate worker")).toBeGreaterThan(calls().indexOf("--force-recreate app"));
    rmSync(log, { force: true });
    const r = run([], { WORKER_FAIL: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("The worker didn't start. The site is up; check: docker logs booster-rocket-worker");
    expect(r.stdout).toContain("Deployed abc1234.");
  });

  it("recreates the worker on a rollback too", () => {
    const r = run(["--rollback"]);
    expect(r.status).toBe(0);
    expect(calls()).toContain("--force-recreate worker");
  });

  it("doesn't start the worker when the app never becomes healthy", () => {
    const r = run([], { HEALTH: "unhealthy" });
    expect(r.status).toBe(4);
    expect(calls()).not.toContain("--force-recreate worker");
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run tests/unit/worker-container.test.ts tests/unit/deploy-script.test.ts`
Expected: FAIL. There is no `worker` service, and `deploy.sh` never recreates one.

- [ ] **Step 3: Add the worker to the image, the compose file and the deploy script**

`Dockerfile`, in the `tools` stage, change the script `COPY` line to:

```dockerfile
COPY scripts/migrate.mjs scripts/seed-poc-guardian.mjs scripts/setup-code.mjs scripts/worker.mjs ./scripts/
```

`docker-compose.poc.yml`, between the `app` and `migrate` services:

```yaml
  worker:
    # The same image as app, started in worker mode. It has no job logic of its own: every minute it asks the app to
    # run whichever scheduled jobs are due (scripts/worker.mjs). No port, and not on the tunnel's network.
    image: booster-rocket-app:current
    container_name: booster-rocket-worker
    restart: unless-stopped
    env_file: .env.poc
    environment:
      TZ: America/Chicago
    depends_on:
      app: { condition: service_healthy }
    networks: [internal]
    command: ["node", "tools/scripts/worker.mjs"]
    healthcheck:
      disable: true
```

`scripts/poc/deploy.sh`: add after the `recreate_app()` function:

```bash
recreate_worker() {
  # The worker only keeps QuickBooks fresh; the site runs without it, so a worker that won't start never fails a deploy.
  if ! "${COMPOSE[@]}" up -d --no-deps --force-recreate worker; then
    say "The worker didn't start. The site is up; check: docker logs booster-rocket-worker"
  fi
}
```

and call `recreate_worker` on the line after each of the two `recreate_app` calls (the rollback branch and the deploy).
Add to the header comment's first usage line: `, recreate app and worker, wait healthy`.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm vitest run tests/unit/worker-container.test.ts tests/unit/deploy-script.test.ts tests/unit/poc-scripts.test.ts`
Expected: PASS.

- [ ] **Step 5: Seed a connected site and a staff session for the end-to-end run**

The end-to-end run never reaches Intuit: the app has no switch to point it anywhere else, so the run starts from a site
that is already connected, with a cache in place, and it never selects **Sign in to Intuit**, **Save this shape**,
**Refresh now** or **Disconnect** (each of those would call Intuit with made-up tokens). The return from Intuit, saving
the shape and refreshing are covered by the integration tests through the real route handler and actions.

Before writing this step, read `src/lib/db/schema.ts` for the columns of `staff_auth_user`, `staff_auth_session`,
`staff_user`, `role` and `role_assignment`, and `src/lib/auth/staff-auth.ts` for the cookie prefix (`br_staff`).

Append to `main()` in `scripts/seed-e2e.ts`, before `await sql.end()`:

```ts
  // An Admin with a live staff session, so the e2e run can open staff pages (tests/e2e/staff-session.ts makes the cookie).
  const [staff] = await sql`INSERT INTO staff_user (email, name, status) VALUES ('e2e-admin@example.org', 'E2E Admin', 'active')
          ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id`;
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
```

If a column named above doesn't exist or another is required (for example `created_at` without a default on the Better
Auth tables), match the schema; don't change the schema for the seed.

`tests/e2e/staff-session.ts`:

```ts
import { createHmac } from "node:crypto";

/**
 * The cookie for the staff session scripts/seed-e2e.ts inserts. Better Auth signs its session cookie as
 * `<token>.<base64 HMAC-SHA256 of the token, keyed by BETTER_AUTH_SECRET>`, URL-encoded. This is test tooling only: it
 * works because the e2e run knows the test secret and seeded the session row itself.
 */
export function staffSessionCookie() {
  const token = "e2e-staff-session-token";
  const signature = createHmac("sha256", process.env.BETTER_AUTH_SECRET!).update(token).digest("base64");
  return { name: "br_staff.session_token", value: encodeURIComponent(`${token}.${signature}`), domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" as const };
}
```

Check the cookie against the installed library before relying on it: find how Better Auth 1.7.18 signs and names the
session cookie (`node_modules/better-auth/dist/cookies/` and `better-call`'s signed-cookie helper) and make the name,
the signature encoding and the URL-encoding match what you read. The first assertion of the spec below (`Hi, E2E`) is the
proof: if `/staff` redirects to `/staff/sign-in`, the cookie is wrong, not the app.

- [ ] **Step 6: Write the end-to-end spec**

`tests/e2e/quickbooks.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { staffSessionCookie } from "./staff-session";

test.beforeEach(async ({ context }) => { await context.addCookies([staffSessionCookie()]); });

test("an Admin sees what is set for QuickBooks, and no inputs on the view", async ({ page }) => {
  await page.goto("/staff");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hi, E2E");
  await page.goto("/staff/settings/quickbooks");
  await expect(page.getByText("Connected to E2E Sandbox Company")).toBeVisible();
  await expect(page.getByText("Sandbox (an Intuit test company)")).toBeVisible();
  await expect(page.getByText("Layered: families are Family, students are Student, parents are Parent.")).toBeVisible();
  await expect(page.getByText("2 families, 1 student, 1 parent; 1 customer outside the portal")).toBeVisible();
  await expect(page.locator("main input:not([type=hidden])")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("9130000000000001");
});

test("the three steps open in order and the shape can be previewed before saving", async ({ page }) => {
  await page.goto("/staff/settings/quickbooks");
  await page.getByRole("link", { name: "Change", exact: true }).click();
  await expect(page).toHaveURL(/\/staff\/settings\/quickbooks\/setup/);
  await page.goto("/staff/settings/quickbooks/setup?step=app");
  await expect(page.getByLabel("Redirect address")).toHaveValue("http://localhost:3100/api/quickbooks/callback");
  await expect(page.getByLabel("Client ID")).toHaveValue("e2e-client-id-1234567890");
  await expect(page.getByLabel(/Client secret/)).toHaveValue("");
  await page.goto("/staff/settings/quickbooks/setup?step=connect");
  await expect(page.getByRole("button", { name: "Sign in to Intuit" })).toBeVisible(); // not selected: it would leave for Intuit
  await page.goto("/staff/settings/quickbooks/setup?step=shape");
  await page.getByLabel("Flat: each member is a customer of their own").check();
  await page.getByLabel("Student", { exact: true }).check();
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByText("1 members (Leo Rivera)")).toBeVisible();
  await expect(page.getByText("4 customers outside the portal")).toBeVisible();
  // Not saved: saving reads QuickBooks again, and this run never reaches Intuit.
  await page.goto("/staff/settings/quickbooks");
  await expect(page.getByText("Layered: families are Family, students are Student, parents are Parent.")).toBeVisible();
});

test("staff open a family from the roster, hostile names stay text, and the visit is in the audit log", async ({ page }) => {
  await page.goto("/staff/roster");
  await expect(page.getByRole("link", { name: "Rivera Family" })).toBeVisible();
  await expect(page.getByText("<img src=x onerror=alert(1)> Family")).toBeVisible();
  await expect(page.locator("img[src='x']")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("Lincoln High");
  await page.getByLabel("Find a family").fill("river");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByRole("link", { name: "Rivera Family" })).toBeVisible();
  await expect(page.locator("a[href='/staff/roster/20']")).toHaveCount(0);
  await page.getByRole("link", { name: "Rivera Family" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Rivera Family");
  await expect(page.getByText("ana@example.com · 555-0101")).toBeVisible();
  await expect(page.getByText("Leo Rivera")).toBeVisible();
  await page.goto("/staff/audit");
  await expect(page.getByText("roster.family.read").first()).toBeVisible();
});

test("the roster and QuickBooks settings are refused without a staff session", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/staff/roster");
  await expect(page).toHaveURL(/\/staff\/sign-in/);
  await page.goto("/staff/settings/quickbooks");
  await expect(page).toHaveURL(/\/staff\/sign-in/);
  await context.close();
});
```

- [ ] **Step 7: Run the end-to-end suite**

Run, one command at a time, in the environment from Global Constraints: the build, `pnpm db:migrate`,
`pnpm tsx scripts/seed-e2e.ts`, `pnpm e2e`.
Expected: every spec passes in both projects (phone and desktop), including the three existing specs. Read the output:
the four new tests must appear twice each. If the staff menu on the phone project hides links behind the **Menu**
button, the spec above doesn't use the menu (it navigates by address), so that is not a reason to change it.

- [ ] **Step 8: Write the documents**

`docs/runbooks/poc-linuxdev.md`:

- In section 1, after the sentence about parent sign-in, add: "It also proves that the portal can connect to a
  QuickBooks company (Intuit's sandbox, for this proof of concept), keep that connection alive with a worker, and show
  staff the club's families as QuickBooks lists them."
- Add a section **"QuickBooks (an Intuit sandbox company)"** after the outgoing-mail section, renumbering the sections
  after it and every "section N" reference in the file. It contains, as numbered steps for the volunteer webmaster:
  1. In the Intuit developer app, under **Keys and credentials** > **Development**, add the redirect address
     `https://portaltest.rhinoautomator.com/api/quickbooks/callback` exactly.
  2. In the sandbox company, make sure the customer types exist (**Sales** > **Customers** > **Customer types**): the
     band's are `Family`, `Parent`, `Student`, `School` and `Vendor`, with students and parents as sub-customers of a family.
  3. Sign in at `/staff/sign-in` and choose **QuickBooks** in the staff menu (Admins only), then **Set up**.
  4. Step 1: enter the Development **Client ID** and **Client secret**, choose **Sandbox**, **Save**.
  5. Step 2: **Sign in to Intuit**, choose the sandbox company, **Connect**. You come back to step 3.
  6. Step 3: choose **Layered**, `Family` for the family, `Student` for the student, `Parent` for the parent,
     **Preview**, check the counts and names, then **Save this shape**.
  7. Choose **Roster** in the staff menu: the families are listed, and **Needs attention** shows what to tidy up.
  8. The worker: `docker ps --filter name=booster-rocket-worker` shows it running, and
     `docker logs booster-rocket-worker` shows `worker started` and a line each time it runs a job. The QuickBooks page
     shows when it last checked in.
  State plainly that these steps have not been walked through yet, and that moving to the band's real books later
  means the app's **Production** keys, **Production** in step 1, and Intuit's app assessment first.
- In the deploy section, say that `deploy.sh` now also starts the worker, and that a worker that won't start doesn't
  fail the deploy (it prints "The worker didn't start. The site is up; check: docker logs booster-rocket-worker").
- Add checklist steps after the last one, each `- [ ]`:
  - "Connect the sandbox company (the QuickBooks section) -> the QuickBooks page says Connected to the company's name."
  - "Choose the layered shape -> **Roster** lists the sandbox's families with their students and parents; a School or
    Vendor customer is not listed."
  - "Open a family -> its parents' email and phone show, and the audit log has `roster.family.read` for it."
  - "The next day -> the QuickBooks page shows the worker checked in within the last few minutes and **Last renewed**
    is less than a day old; `docker logs booster-rocket-worker` shows `ran quickbooks.token_refresh: ok` and
    `ran roster.refresh: ok`."
  - "**Disconnect**, then set up again -> the roster says it is no longer current while disconnected, and is current
    again after reconnecting. The audit log has `quickbooks.disconnect` and a second `quickbooks.connect`."
- Add troubleshooting rows, each checked against the code for its exact words:
  - step 2 comes back with "That return from Intuit didn't match a sign-in started here…": more than 10 minutes passed,
    or the button was pressed in two tabs; start step 2 again.
  - step 2 comes back with "Intuit refused the request…": the Client ID, secret or sandbox/production choice is wrong,
    or the redirect address isn't on the Intuit app under the same keys.
  - step 2 comes back with "That is a different QuickBooks company…": **Disconnect** first.
  - the staff home says "QuickBooks needs attention" with "…hasn't been refreshed from QuickBooks in more than 2 days":
    the worker isn't running; `docker ps`, then `docker compose -f docker-compose.poc.yml --env-file .env.poc up -d worker`.
  - "…couldn't be refreshed: Intuit no longer accepts this connection…": the connection lapsed or was revoked at
    Intuit; go through step 2 again.
  - `docker logs booster-rocket-worker` says "couldn't reach the app: HTTP 404": the worker and the app have different
    `BETTER_AUTH_SECRET` values; both read `.env.poc`, so recreate both.
- In the removal section, the `down` command already removes the worker; say so in one clause.

`docs/superpowers/plans/2026-11-07-v1-roadmap.md`: replace the table rows for Plans 0, 2 and 3 with:

```markdown
| **0. Verification spikes** | Answers to the spec's §15 questions that are still open (Documenso, the buy-out invoice, the Pay link). The External ID spike is dropped: the email-code design replaced it on 2026-11-10 | Nothing | To write |
| **2a. QuickBooks connection and roster** | OAuth connect, sealed tokens kept fresh by a worker, the membership shape by customer type, a customer cache, read-only roster pages and Needs attention | Plan 1 | **Written:** `2026-11-11-quickbooks-connection-and-roster.md` |
| **2b. Money for parents** | Family balances, open invoices with Pay links, the "as of" time and the offline state, money reconciliation | Plan 2a; Plan 0 InvoiceLink answer | To write |
| **3. Parents from QuickBooks** | Sign-ins for Parent customers (rules for email, welcome and removal), adding a missing parent from the portal (written to QuickBooks first), blocking, staff email change, parent contact edits, the write queue | Plans 1 and 2a | To write |
```

and add a row, after Plan 1, for what already shipped: `| **1b. Parent sign-in with email codes** | The portal's own
email-code sign-in, people as records, outgoing mail | Plan 1 | **Done 2026-11-10:** `2026-11-10-parent-email-code-sign-in.md` |`.

`docs/superpowers/specs/2026-11-06-booster-rocket-v1-design.md`: under each of the headings `## 3. Architecture`,
`### Owned by QuickBooks` (in §4), `## 7. Permissions`, `### 8.1 Connection`, `### 8.4 Scheduled jobs` and
`## 14. Operations`, add this note as the first line of the section (§4 and others may already carry a 2026-11-10 note;
add this one after it):

```markdown
> **Revised 2026-11-10:** the QuickBooks connection, the worker, the membership shape and the customer cache are
> designed in `2026-11-10-quickbooks-connection-and-roster-design.md`. Where the two disagree, that spec wins.
```

`docs/superpowers/specs/2026-11-10-quickbooks-connection-and-roster-design.md`:
- change the status line to `**Status:** approved by the owner on 2026-11-11; implemented by plan 2026-11-11-quickbooks-connection-and-roster.md.`
- in §3 "Rules for the connection", change the last bullet to: "All QuickBooks calls happen on the server. The browser
  never receives a token or the client secret, and no settings or roster page shows the company's ID. The ID is
  recorded in the audit log when a company is connected or disconnected (§6)."
- in §4, change "The worker has no HTTP port." to: "The worker has no HTTP port and no job logic: every minute it asks
  the app, over the deployment's private network, to run whichever jobs are due."
- in §5 "Flat shape", change the Members bullet to: "**Members:** each member's name and whether they are active. A
  member's own page shows their email and phone and the portal sign-ins attached to that customer ID."
- in §7 "End-to-end", change the sentence to: "an Admin opens the settings view on a site that is already connected,
  walks the three steps without leaving for Intuit, previews a shape, and opens a family's page. The return from Intuit,
  saving the shape and refreshing are covered by integration tests through the real route handler and actions, because
  the app has no switch that points it at a stub."

- [ ] **Step 9: Check the documents against the code**

Run:
`grep -rn "Entra External ID\|External ID trial" docs/superpowers/plans/2026-11-07-v1-roadmap.md`
Expected: no matches.

Run: `grep -n "section [0-9]" docs/runbooks/poc-linuxdev.md | head -60` and read each match: every "section N" must
point at the right section after the renumbering.

For each quoted message in the new troubleshooting rows, grep `src/` and `scripts/` for it; every one must be found
word for word.

- [ ] **Step 10: Full checks and commit**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all clean.

```bash
git add Dockerfile docker-compose.poc.yml scripts/poc/deploy.sh scripts/seed-e2e.ts tests/unit/worker-container.test.ts tests/unit/deploy-script.test.ts tests/e2e docs
git commit -m "feat(ops): run the worker beside the app; e2e for QuickBooks settings and the roster; runbook

Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>"
```

---

## After the last task: the proof of concept (the owner's)

The plan ends with tested software on a branch. The proof of concept in spec §7 is run by the owner after the merge, on
linuxdev, following the runbook's new QuickBooks section and checklist steps, with the Intuit development keys and the
sandbox company from Task 1. Its results are recorded in the runbook's results table, as before.

## Rulings made while planning

- **The worker has no job logic.** Spec §4 has the worker "run scheduled jobs". Here the jobs live in the app
  (`src/lib/jobs/runner.ts`) behind `POST /api/internal/worker`, and the worker container is a 50-line script with no
  dependencies that calls it every minute. The image is a Next.js standalone build, so running the app's TypeScript in a
  second process would need a second bundle; this way every job is ordinary app code under Vitest. Task 9 amends §4's wording.
- **The worker's token is derived from `BETTER_AUTH_SECRET`** (HMAC-SHA256 over `booster-rocket-worker:v1`), so no new
  setting has to be generated, stored or kept in step between two containers. The endpoint answers 404 without it.
- **The company's ID is in the audit log and nowhere else a person sees.** Spec §3 said the browser never receives it;
  spec §6 says `quickbooks.connect` records it. The audit page is a browser page, so §3 is amended (Task 9) to say no
  settings or roster page shows it.
- **The Members list (flat shape) shows names; email and phone are on the member's own page.** Spec §5 put them on the
  list. Keeping contact details behind the page whose opening is audited is the same rule families get.
- **The end-to-end run never reaches Intuit.** Spec §7 had it go through the three steps against a stub. The app has no
  switch that points it at a stub (Global Constraints), so the e2e run starts from a seeded, connected site and stops
  short of every button that calls Intuit. The return from Intuit runs through the real route handler in an integration
  test instead. Task 9 amends §7.
- **The Client ID and the environment can't be changed while connected** (an Admin disconnects first). The tokens belong
  to the app and environment they were issued for; the secret alone can be replaced at any time.
- **A connect state is cleared only when it matches.** A stray or replayed return is refused without cancelling a
  connect an Admin has in progress.
- **"A type QuickBooks no longer has" means the type is absent from the last refresh.** A type QuickBooks marks inactive
  still counts as existing.
- **The daily token job always spends the refresh token,** even when the access token is still good. That is what keeps
  a quiet summer from letting the connection lapse (v1 §8.4).
- **Step 3 with no customer types read yet** sends the Admin to **Refresh now** on the Roster page rather than offering a
  second refresh button of its own.
- **`Refresh now` is for anyone with `Roster.Read`** (spec §4), so a custom role can start a read of QuickBooks, at most
  once every five minutes. It can't change the shape or the connection.
