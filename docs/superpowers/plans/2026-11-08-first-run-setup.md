# First-Run Setup Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the env-file sign-in settings with an in-app setup page that walks the admin through creating the
Microsoft app registrations, checks the values, stores them encrypted, and finishes with a real staff sign-in.

**Architecture:** Sign-in settings move from `src/env.ts` into a new `auth_provider` table. Secrets are sealed with
AES-256-GCM using a key from the env file. Both Better Auth instances become `getStaffAuth()` / `getParentAuth()`;
each is built from the stored rows and rebuilt when a save bumps an in-memory version. A Next.js `proxy.ts` sends
every page to `/setup` while setup is open. `/setup` is unlocked with a one-time code that a server script issues.
It walks three steps (staff sign-in, parent sign-in, first Admin) and closes when the named Admin signs in. Two
optional PowerShell scripts create the app registrations through `Connect-MgGraph` (interactive browser sign-in,
never device code).

**Tech Stack:** Next.js 16.4.5 (App Router, `proxy.ts`, server actions), React 19, TypeScript strict,
Drizzle ORM + postgres.js on Postgres 16, Better Auth 1.7.18, zod 4, Node 26 `node:crypto`, Vitest 5, Playwright,
PowerShell 7 with `Microsoft.Graph.Authentication`, bash plus shellcheck.

**Spec:** `docs/superpowers/specs/2026-11-08-first-run-setup-design.md`

## Global Constraints

- US English in all copy, comments and docs (color, behavior, license).
- Every create/update/delete, sign-in, sign-out and refused sign-in writes an audit row. A missing audit entry is a
  defect.
- Times are stored in UTC (`timestamptz`) and shown in the viewer's local zone through `LocalTime`
  (`src/app/components/local-time.tsx`). Never hardcode a time zone in display code.
- No device code anywhere. The PowerShell scripts use `Connect-MgGraph` interactive browser sign-in.
- Sign-in values come only from the database. After Task 5 the env file holds exactly `DATABASE_URL`, `APP_URL`,
  `BETTER_AUTH_SECRET`, `SETTINGS_ENCRYPTION_KEY` and the optional `SETTINGS_ENCRYPTION_KEY_PREVIOUS`.
- A stored secret is never sent to the browser, never written to the audit log, and never logged.
- Encryption is AES-256-GCM with a random 12-byte nonce. The additional authenticated data is the row key. The key
  ID is the first 8 hex characters of SHA-256 of the key.
- Setup code: 12 characters from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, shown as `XXXX-XXXX-XXXX`. Entry ignores case,
  spaces and dashes. 5 wrong tries per 15 minutes per client address; void after 20 wrong tries in total. The setup
  cookie `br_setup` is valid for 2 hours.
- Secrets created by the scripts expire in 24 months. The expiry warning starts 30 days before.
- Redirect URIs: staff Microsoft `<APP_URL>/api/auth/staff/callback/microsoft`, staff Google
  `<APP_URL>/api/auth/staff/callback/google`, parent `<APP_URL>/api/auth/parent/callback/parent-oidc`.
- Parent discovery URL: `https://<tenant-subdomain>.ciamlogin.com/<tenant-id>/v2.0/.well-known/openid-configuration`.
- Never run `docker image prune -a` on linuxdev. Recreate cloudflared only with `--no-deps`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Rulings made while planning (deviations from the spec text)

- **The setup cookie is `SameSite=Lax`, not Strict.** Step 3 comes back from Microsoft through a cross-site redirect
  chain, and browsers withhold Strict cookies on that chain, so `/setup/finish` would never see the cookie. Lax still
  withholds the cookie from cross-site POSTs, which covers every setup action.
- **The permission is `Settings.SignIn.ReadWrite`, and it is admin-only** (`ADMIN_ONLY` in the registry). This
  follows the registry's `Area.Object.Level` naming. Whoever controls sign-in providers controls every account, so a
  custom role can't grant it.
- **Claiming the Admin and finishing setup are two steps, not one transaction.** The claim happens during the sign-in
  callback (`resolveStaff` → `claimBootstrapAdmin`). The finish happens in `/setup/finish`, which checks the claimed
  identity and is safe to repeat: if the finish fails, visiting `/setup/finish` again completes it.
- **Moving between setup steps isn't audited.** The step is the page's position, not club data. Saving the Admin
  email is audited (`setup.admin_email.save`).
- **Setup server actions use a new guard, `setupAction`, registered in the same guard registry**, so the existing
  "every server action is guarded" invariant test covers them. The unlock action is the one deliberate exception and
  is registered as `setup-unlock`.

## Review Focus

1. A secret pasted with surrounding spaces, a trailing newline or quotes → it is cleaned and still works (Task 2
   test "cleans pasted secrets").
2. A tenant domain (`club.onmicrosoft.com`) pasted where the tenant ID goes → a message that names the right value,
   not a generic failure (Task 2 test "explains a domain pasted as tenant ID").
3. The Admin email typed with different case or spaces from the Microsoft account → it still matches (Task 5 test
   "matches the Admin email whatever its case").
4. The app restarts between unlocking and saving → the admin is still unlocked, because the cookie depends only on
   the stored code hash and `BETTER_AUTH_SECRET` (Task 5 test "a setup session survives a restart").
5. A stored secret that can't be decrypted (the key was changed or lost) → that sign-in shows as not set up, the
   rest keep working, nothing crashes (Task 2 test "skips a provider whose secret can't be decrypted").

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/crypto/secret-box.ts` | Seal and open secrets with AES-256-GCM. Knows nothing about providers. |
| `src/lib/auth/providers.ts` | The `auth_provider` rows: parse form input, load (decrypted, cached by version), summaries for UI, save, remove, audit. |
| `src/lib/auth/provider-checks.ts` | Prove values work against Microsoft before saving. Pure apart from `fetch`. |
| `src/lib/auth/staff-auth.ts`, `parent-auth.ts` | Build a Better Auth instance from loaded providers; `get…Auth()` caches by version. |
| `src/lib/setup/state.ts` | Setup status, step and Admin email in `setting`; finish; cached status for the proxy. |
| `src/lib/setup/code.ts` | Setup code generation, hashing, verification, slow-down. |
| `src/lib/setup/session.ts` | The `br_setup` cookie (HMAC-signed, bound to the code hash). |
| `src/lib/setup/guard.ts` | `setupAction` / `setupUnlockAction` wrappers registered with the guard registry. |
| `src/proxy.ts` | Redirect every page to `/setup` while setup is open. |
| `src/app/setup/*` | The setup page, its actions, step components, finish route, script download route. |
| `src/app/components/sign-in-settings/*` | `ProviderForm`, `CopyField`, provider labels: shared by setup and Settings. |
| `src/app/staff/(app)/settings/sign-in/*` | Settings → Sign-in page and actions. |
| `scripts/setup-code.mjs` | Issue a setup code, or reopen setup (plain JS; shipped in the image as `tools/scripts`). |
| `scripts/setup/*.ps1` | The optional PowerShell scripts. |
| `scripts/poc/setup-code.sh`, `reopen-setup.sh` | Server wrappers that run `setup-code.mjs` in the app image. |

---

### Task 1: Encryption key and secret box

**Files:**
- Create: `src/lib/crypto/secret-box.ts`
- Modify: `src/env.ts`, `vitest.config.ts`, `.env.example`, `.github/workflows/ci.yml`, `Dockerfile`,
  `scripts/smoke-image.sh`
- Test: `tests/unit/secret-box.test.ts`, `tests/unit/env.test.ts`

**Interfaces:**
- Produces: `createSecretBox(keys: { current: string; previous?: string }): SecretBox`;
  `secretBox(): SecretBox` (process-wide, from env); `type SealedSecret = { ciphertext: string; keyId: string }`;
  `type SecretBox = { currentKeyId: string; seal(plaintext: string, aad: string): SealedSecret; open(s: SealedSecret, aad: string): string }`;
  `class SecretBoxError extends Error`; `keyIdOf(key: Buffer): string`.
- Produces: `env.SETTINGS_ENCRYPTION_KEY: string`, `env.SETTINGS_ENCRYPTION_KEY_PREVIOUS: string | undefined`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/secret-box.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createSecretBox, SecretBoxError, keyIdOf } from "@/lib/crypto/secret-box";

const KEY_A = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const KEY_B = Buffer.from("previous-key-previous-key-prev!!").toString("base64");

describe("secret box", () => {
  it("round-trips a secret", () => {
    const box = createSecretBox({ current: KEY_A });
    const sealed = box.seal("s3cr3t~value", "staff-microsoft");
    expect(sealed.ciphertext).not.toContain("s3cr3t");
    expect(box.open(sealed, "staff-microsoft")).toBe("s3cr3t~value");
  });

  it("uses a fresh nonce every time", () => {
    const box = createSecretBox({ current: KEY_A });
    expect(box.seal("same", "k").ciphertext).not.toBe(box.seal("same", "k").ciphertext);
  });

  it("names the key by the first 8 hex of its SHA-256", () => {
    const box = createSecretBox({ current: KEY_A });
    expect(box.currentKeyId).toMatch(/^[0-9a-f]{8}$/);
    expect(box.seal("x", "k").keyId).toBe(keyIdOf(Buffer.from(KEY_A, "base64")));
  });

  it("refuses a tampered ciphertext", () => {
    const box = createSecretBox({ current: KEY_A });
    const sealed = box.seal("value", "k");
    const raw = Buffer.from(sealed.ciphertext, "base64");
    raw[14] = raw[14]! ^ 0xff;
    expect(() => box.open({ ...sealed, ciphertext: raw.toString("base64") }, "k")).toThrow(SecretBoxError);
  });

  it("refuses a ciphertext moved to another row", () => {
    const box = createSecretBox({ current: KEY_A });
    const sealed = box.seal("value", "staff-microsoft");
    expect(() => box.open(sealed, "parent-oidc")).toThrow(SecretBoxError);
  });

  it("refuses the wrong key", () => {
    const sealed = createSecretBox({ current: KEY_A }).seal("value", "k");
    expect(() => createSecretBox({ current: KEY_B }).open(sealed, "k")).toThrow(SecretBoxError);
  });

  it("still opens values sealed with the previous key", () => {
    const sealed = createSecretBox({ current: KEY_B }).seal("value", "k");
    const rotated = createSecretBox({ current: KEY_A, previous: KEY_B });
    expect(rotated.open(sealed, "k")).toBe("value");
    expect(rotated.seal("value", "k").keyId).toBe(rotated.currentKeyId);
  });

  it("refuses an unknown key id and a truncated value", () => {
    const box = createSecretBox({ current: KEY_A });
    const sealed = box.seal("value", "k");
    expect(() => box.open({ ...sealed, keyId: "deadbeef" }, "k")).toThrow(SecretBoxError);
    expect(() => box.open({ ...sealed, ciphertext: "AAAA" }, "k")).toThrow(SecretBoxError);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => createSecretBox({ current: Buffer.from("short").toString("base64") })).toThrow(SecretBoxError);
  });
});
```

Add to `tests/unit/env.test.ts` (keep the existing tests; add `SETTINGS_ENCRYPTION_KEY` to `base` so they still
parse):

```ts
// in `base`, add:  SETTINGS_ENCRYPTION_KEY: Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"),

describe("SETTINGS_ENCRYPTION_KEY", () => {
  it("is required", () => {
    const { SETTINGS_ENCRYPTION_KEY: _, ...rest } = base;
    expect(() => parseEnv(rest)).toThrow(/SETTINGS_ENCRYPTION_KEY/);
  });
  it("must decode to 32 bytes", () => {
    expect(() => parseEnv({ ...base, SETTINGS_ENCRYPTION_KEY: Buffer.from("too short").toString("base64") }))
      .toThrow(/32 random bytes/);
  });
  it("treats an empty previous key as absent", () => {
    expect(parseEnv({ ...base, SETTINGS_ENCRYPTION_KEY_PREVIOUS: "" }).SETTINGS_ENCRYPTION_KEY_PREVIOUS).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/unit/secret-box.test.ts tests/unit/env.test.ts`
Expected: FAIL. `@/lib/crypto/secret-box` is not found, and the env schema has no `SETTINGS_ENCRYPTION_KEY`.

- [ ] **Step 3: Implement**

`src/lib/crypto/secret-box.ts`:

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "@/env";

export type SealedSecret = { ciphertext: string; keyId: string };
export type SecretBox = {
  currentKeyId: string;
  seal(plaintext: string, aad: string): SealedSecret;
  open(sealed: SealedSecret, aad: string): string;
};
export class SecretBoxError extends Error {}

const NONCE = 12;
const TAG = 16;

export function keyIdOf(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

function decodeKey(b64: string): Buffer {
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new SecretBoxError("An encryption key must be 32 bytes, base64.");
  return key;
}

/** AES-256-GCM. The ciphertext is base64(nonce ‖ body ‖ tag); `aad` binds it to one row. */
export function createSecretBox(keys: { current: string; previous?: string }): SecretBox {
  const current = decodeKey(keys.current);
  const byId = new Map<string, Buffer>([[keyIdOf(current), current]]);
  if (keys.previous) {
    const previous = decodeKey(keys.previous);
    byId.set(keyIdOf(previous), previous);
  }
  return {
    currentKeyId: keyIdOf(current),
    seal(plaintext, aad) {
      const nonce = randomBytes(NONCE);
      const cipher = createCipheriv("aes-256-gcm", current, nonce);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return { ciphertext: Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64"), keyId: keyIdOf(current) };
    },
    open({ ciphertext, keyId }, aad) {
      const key = byId.get(keyId);
      if (!key) throw new SecretBoxError(`No encryption key with id ${keyId}.`);
      const raw = Buffer.from(ciphertext, "base64");
      if (raw.length < NONCE + TAG) throw new SecretBoxError("The stored secret is too short to be valid.");
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, NONCE));
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(raw.subarray(raw.length - TAG));
      try {
        return Buffer.concat([decipher.update(raw.subarray(NONCE, raw.length - TAG)), decipher.final()]).toString("utf8");
      } catch {
        throw new SecretBoxError("The stored secret could not be decrypted.");
      }
    },
  };
}

let box: SecretBox | null = null;
/** The process-wide box, built from SETTINGS_ENCRYPTION_KEY (and _PREVIOUS while a key is being replaced). */
export function secretBox(): SecretBox {
  box ??= createSecretBox({ current: env.SETTINGS_ENCRYPTION_KEY, previous: env.SETTINGS_ENCRYPTION_KEY_PREVIOUS });
  return box;
}
```

In `src/env.ts`, add above `schema`:

```ts
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const encryptionKey = z.string().trim().refine((v) => BASE64.test(v) && Buffer.from(v, "base64").length === 32, {
  message: "SETTINGS_ENCRYPTION_KEY must be 32 random bytes, base64 (make one with: openssl rand -base64 32)",
});
```

and in `schema`:

```ts
  SETTINGS_ENCRYPTION_KEY: encryptionKey,
  SETTINGS_ENCRYPTION_KEY_PREVIOUS: z.preprocess((v) => (v === "" ? undefined : v), encryptionKey.optional()),
```

`vitest.config.ts` `test.env`: add `SETTINGS_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="`.

`.env.example`: after `BETTER_AUTH_SECRET`, add

```
# 32 random bytes, base64 (openssl rand -base64 32). Encrypts the sign-in secrets stored in the database.
# Back it up with the database: without it the stored secrets can't be read and must be entered again.
SETTINGS_ENCRYPTION_KEY=
```

`.github/workflows/ci.yml`: add `SETTINGS_ENCRYPTION_KEY: Y2ktZmFrZS1rZXktY2ktZmFrZS1rZXktY2ktZmFrZSE=` to the env
of both the "Build with fake secrets" and "E2E" steps.

`Dockerfile` build stage `ENV`: add `SETTINGS_ENCRYPTION_KEY=YnVpbGQtcGxhY2Vob2xkZXItbm90LWEtc2VjcmV0ISE=` (append
` \` to the `BETTER_AUTH_SECRET` line).

`scripts/smoke-image.sh`, the app `docker run`: add `-e SETTINGS_ENCRYPTION_KEY=c21va2Uta2V5LXNtb2tlLWtleS1zbW9rZS1rZXktMTI=`.

Add the same kind of key to your local untracked `.env` (`openssl rand -base64 32`); `pnpm dev` won't start without it.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm vitest run tests/unit/secret-box.test.ts tests/unit/env.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/crypto/secret-box.ts src/env.ts vitest.config.ts .env.example .github/workflows/ci.yml Dockerfile scripts/smoke-image.sh tests/unit/secret-box.test.ts tests/unit/env.test.ts
git commit -m "feat(crypto): seal stored secrets with AES-256-GCM under SETTINGS_ENCRYPTION_KEY"
```

---

### Task 2: Stored sign-in providers

**Files:**
- Modify: `src/lib/db/schema.ts`, `tests/helpers/db.ts`
- Create: `src/lib/auth/provider-fields.ts` (database-free: safe to import from client components),
  `src/lib/auth/providers.ts`, a migration from `pnpm db:generate` (`drizzle/0002_*.sql` and its meta)
- Test: `tests/unit/provider-parse.test.ts`, `tests/integration/providers.test.ts`

**Interfaces:**
- Consumes: `secretBox()`, `SecretBox`, `SecretBoxError` (Task 1); `writeAudit`, `Actor`
  (`src/lib/audit/log.ts`).
- Produces (from `src/lib/auth/providers.ts`):
  - `PROVIDER_KEYS`, `type ProviderKey = "staff-microsoft" | "staff-google" | "parent-oidc"`, `isProviderKey(s)`
  - `type MicrosoftConfig = { tenantId: string; clientId: string }`, `type GoogleConfig = { clientId: string }`,
    `type ParentConfig = { tenantSubdomain: string; tenantId: string; clientId: string }`, `type ConfigFor`
  - `type LoadedProvider<K>`, `type LoadedProviders = { version: number; staffMicrosoft; staffGoogle; parent }`
  - `loadProviders(box?): Promise<LoadedProviders>`, `providersVersion(): number`, `invalidateProviders(): void`
  - `parentDiscoveryUrl(c: ParentConfig): string`
  - `type ProviderSummary = { key; config: Record<string,string>; secretUpdatedAt: Date; secretExpiresAt: Date | null; readable: boolean }`,
    `providerSummaries(box?): Promise<ProviderSummary[]>`
  - `type ProviderDraft`, `PROVIDER_FIELDS`, `parseProviderForm(key, fields: Record<string,string>): { ok: true; draft: ProviderDraft } | { ok: false; errors: string[] }`
  - `cleanSecret(raw: string): string`
  - `type CheckResult = { ok: true } | { ok: false; message: string }`, `type CheckFn = (d: CheckedDraft) => Promise<CheckResult>`,
    `type CheckedDraft = ProviderDraft & { secret: string }`
  - `type SaveOutcome = { ok: true } | { ok: false; errors: string[] }`
  - `saveProvider(draft, opts: { actor: Actor; ip: string | null; permission?: string; updatedBy: string | null; check: CheckFn; box?: SecretBox }): Promise<SaveOutcome>`
  - `removeProvider(key, opts: { actor: Actor; ip: string | null; permission?: string }): Promise<SaveOutcome>`
- Produces (test helper): `seedProvider(key, config, secret?, expiresAt?)` in `tests/helpers/db.ts`.

- [ ] **Step 1: Add the table**

In `src/lib/db/schema.ts`, after `setting`:

```ts
/** Sign-in provider settings entered on the setup page. The secret is sealed (src/lib/crypto/secret-box.ts). */
export const authProvider = pgTable("auth_provider", {
  key: text("key", { enum: ["staff-microsoft", "staff-google", "parent-oidc"] }).primaryKey(),
  config: jsonb("config").notNull(),               // non-secret values only
  secretCiphertext: text("secret_ciphertext").notNull(),
  secretKeyId: text("secret_key_id").notNull(),
  secretExpiresAt: timestamp("secret_expires_at", { withTimezone: true }),
  secretUpdatedAt: timestamp("secret_updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: updated(),
  updatedBy: uuid("updated_by"),                    // staff_user.id; null when saved from the setup page
});
```

Run: `pnpm db:generate`
Expected: a new `drizzle/0002_<random_name>.sql` containing `CREATE TABLE "auth_provider"`, plus updated
`drizzle/meta`. Keep whatever name drizzle-kit picks.

In `tests/helpers/db.ts`: add `"auth_provider"` to `TABLES`, import `invalidateProviders` from
`@/lib/auth/providers` and call it at the end of `resetDb()`, and add:

```ts
import { authProvider } from "@/lib/db/schema";
import { secretBox } from "@/lib/crypto/secret-box";
import { invalidateProviders, type ProviderKey } from "@/lib/auth/providers";

export async function seedProvider(key: ProviderKey, config: Record<string, string>, secret = "seeded-secret", expiresAt: Date | null = null) {
  const sealed = secretBox().seal(secret, key);
  await db.insert(authProvider).values({ key, config, secretCiphertext: sealed.ciphertext, secretKeyId: sealed.keyId, secretExpiresAt: expiresAt });
  invalidateProviders();
}
```

- [ ] **Step 2: Write the failing tests**

`tests/unit/provider-parse.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseProviderForm, cleanSecret, parentDiscoveryUrl } from "@/lib/auth/providers";

const T = "0f8fad5b-d9cb-469f-a165-70867728950e";
const C = "11111111-2222-3333-4444-555555555555";

describe("parseProviderForm", () => {
  it("accepts a Microsoft staff provider and lower-cases the IDs", () => {
    const r = parseProviderForm("staff-microsoft", { tenantId: ` ${T.toUpperCase()} `, clientId: C, secret: "abc", secretExpiresAt: "2028-11-08" });
    expect(r).toEqual({ ok: true, draft: { key: "staff-microsoft", config: { tenantId: T, clientId: C }, secret: "abc", secretExpiresAt: new Date("2028-11-08T00:00:00Z") } });
  });

  it.each(["common", "organizations", "consumers"])("refuses the multi-tenant alias %s", (v) => {
    const r = parseProviderForm("staff-microsoft", { tenantId: v, clientId: C, secret: "abc" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/any Microsoft account/);
  });

  it("explains a domain pasted as tenant ID", () => {
    const r = parseProviderForm("staff-microsoft", { tenantId: "club.onmicrosoft.com", clientId: C, secret: "abc" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]).toMatch(/Directory \(tenant\) ID.*domain name/);
  });

  it("cleans pasted secrets", () => {
    expect(cleanSecret('  "abc~def"\n')).toBe("abc~def");
    expect(cleanSecret("'abc'")).toBe("abc");
    expect(cleanSecret(" abc ")).toBe("abc");
    const r = parseProviderForm("staff-google", { clientId: "123-x.apps.googleusercontent.com", secret: " s \n" });
    expect(r.ok && r.draft.secret).toBe("s");
  });

  it("treats a blank secret as keep-the-saved-one", () => {
    const r = parseProviderForm("staff-microsoft", { tenantId: T, clientId: C, secret: "   " });
    expect(r.ok && r.draft.secret).toBeNull();
  });

  it("refuses a Google client ID that isn't one", () => {
    const r = parseProviderForm("staff-google", { clientId: "12345", secret: "s" });
    expect(r.ok).toBe(false);
  });

  it("accepts a parent provider and trims a pasted domain down to the subdomain", () => {
    const r = parseProviderForm("parent-oidc", { tenantSubdomain: "FznParents.onmicrosoft.com", tenantId: T, clientId: C, secret: "s" });
    expect(r.ok && r.draft.config).toEqual({ tenantSubdomain: "fznparents", tenantId: T, clientId: C });
  });

  it("refuses a bad expiry date", () => {
    const r = parseProviderForm("staff-microsoft", { tenantId: T, clientId: C, secret: "s", secretExpiresAt: "next year" });
    expect(r.ok).toBe(false);
  });

  it("builds the documented discovery URL", () => {
    expect(parentDiscoveryUrl({ tenantSubdomain: "fznparents", tenantId: T, clientId: C }))
      .toBe(`https://fznparents.ciamlogin.com/${T}/v2.0/.well-known/openid-configuration`);
  });
});
```

`tests/integration/providers.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { authProvider, auditLog } from "@/lib/db/schema";
import { createSecretBox } from "@/lib/crypto/secret-box";
import { loadProviders, providerSummaries, saveProvider, removeProvider, parseProviderForm, providersVersion, type CheckFn } from "@/lib/auth/providers";
import { resetDb, seedProvider } from "../helpers/db";

const T = "0f8fad5b-d9cb-469f-a165-70867728950e";
const C = "11111111-2222-3333-4444-555555555555";
const actor = { door: "system" as const, id: null, label: "setup" };
const pass: CheckFn = async () => ({ ok: true });
const draft = (secret: string | null = "the-secret") => {
  const r = parseProviderForm("staff-microsoft", { tenantId: T, clientId: C, secret: secret ?? "" });
  if (!r.ok) throw new Error(r.errors.join());
  return r.draft;
};

describe("stored providers", () => {
  beforeEach(resetDb);

  it("saves encrypted, loads decrypted, and audits without the secret", async () => {
    expect(await saveProvider(draft(), { actor, ip: null, updatedBy: null, check: pass })).toEqual({ ok: true });
    const [row] = await db.select().from(authProvider);
    expect(row!.secretCiphertext).not.toContain("the-secret");
    expect((await loadProviders()).staffMicrosoft).toMatchObject({ config: { tenantId: T, clientId: C }, secret: "the-secret" });
    const audit = await db.select().from(auditLog);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "setup.provider.save", targetId: "staff-microsoft" });
    expect(JSON.stringify(audit[0])).not.toContain("the-secret");
    expect(audit[0]!.after).toMatchObject({ secretChanged: true });
  });

  it("bumps the version so sign-in rebuilds", async () => {
    const before = providersVersion();
    await saveProvider(draft(), { actor, ip: null, updatedBy: null, check: pass });
    expect(providersVersion()).toBeGreaterThan(before);
  });

  it("saves nothing when the check fails", async () => {
    const r = await saveProvider(draft(), { actor, ip: null, updatedBy: null, check: async () => ({ ok: false, message: "nope" }) });
    expect(r).toEqual({ ok: false, errors: ["nope"] });
    expect(await db.select().from(authProvider)).toHaveLength(0);
    expect(await db.select().from(auditLog)).toHaveLength(0);
  });

  it("keeps the saved secret when the form leaves it blank, and checks with it", async () => {
    await saveProvider(draft("first"), { actor, ip: null, updatedBy: null, check: pass });
    let checkedWith = "";
    await saveProvider(draft(null), { actor, ip: null, updatedBy: null, check: async (d) => { checkedWith = d.secret; return { ok: true }; } });
    expect(checkedWith).toBe("first");
    expect((await loadProviders()).staffMicrosoft?.secret).toBe("first");
    expect((await db.select().from(auditLog))[1]!.after).toMatchObject({ secretChanged: false });
  });

  it("asks for the secret when there is none saved yet", async () => {
    expect(await saveProvider(draft(null), { actor, ip: null, updatedBy: null, check: pass })).toEqual({ ok: false, errors: ["Enter the client secret."] });
  });

  it("skips a provider whose secret can't be decrypted", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
    await seedProvider("staff-google", { clientId: "x.apps.googleusercontent.com" });
    await db.update(authProvider).set({ secretKeyId: "deadbeef" }).where(eq(authProvider.key, "staff-microsoft"));
    const other = createSecretBox({ current: Buffer.from("previous-key-previous-key-prev!!").toString("base64") });
    const loaded = await loadProviders();
    expect(loaded.staffMicrosoft).toBeNull();
    expect(loaded.staffGoogle).not.toBeNull();
    expect((await providerSummaries(other)).every((s) => !s.readable)).toBe(true);
  });

  it("summaries never contain the secret", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C }, "never-show-me");
    expect(JSON.stringify(await providerSummaries())).not.toContain("never-show-me");
  });

  it("refuses to remove the last staff provider, allows it when another exists, and audits", async () => {
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
    expect(await removeProvider("staff-microsoft", { actor, ip: null })).toEqual({ ok: false, errors: ["This would leave no way for staff to sign in."] });
    await seedProvider("staff-google", { clientId: "x.apps.googleusercontent.com" });
    expect(await removeProvider("staff-microsoft", { actor, ip: null })).toEqual({ ok: true });
    expect((await loadProviders()).staffMicrosoft).toBeNull();
    expect((await db.select().from(auditLog)).map((a) => a.action)).toEqual(["setup.provider.remove"]);
  });

  it("removes the parent provider freely", async () => {
    await seedProvider("parent-oidc", { tenantSubdomain: "p", tenantId: T, clientId: C });
    expect(await removeProvider("parent-oidc", { actor, ip: null })).toEqual({ ok: true });
  });
});
```

(Add `import { eq } from "drizzle-orm";` at the top.)

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm vitest run tests/unit/provider-parse.test.ts tests/integration/providers.test.ts`
Expected: FAIL, because `@/lib/auth/providers` is not found.

- [ ] **Step 4: Implement `src/lib/auth/provider-fields.ts` and `src/lib/auth/providers.ts`**

`src/lib/auth/provider-fields.ts` holds what client components need, with no database import:

```ts
export const PROVIDER_KEYS = ["staff-microsoft", "staff-google", "parent-oidc"] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];
export const isProviderKey = (s: string): s is ProviderKey => (PROVIDER_KEYS as readonly string[]).includes(s);
export type SaveOutcome = { ok: true } | { ok: false; errors: string[] };

/** The non-secret fields each provider's form has, in display order. */
export const PROVIDER_FIELDS: Record<ProviderKey, readonly ("tenantId" | "clientId" | "tenantSubdomain")[]> = {
  "staff-microsoft": ["tenantId", "clientId"],
  "staff-google": ["clientId"],
  "parent-oidc": ["tenantSubdomain", "tenantId", "clientId"],
};
```

`src/lib/auth/providers.ts`:

```ts
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { authProvider } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { secretBox, SecretBoxError, type SecretBox } from "@/lib/crypto/secret-box";
import { PROVIDER_KEYS, PROVIDER_FIELDS, isProviderKey, type ProviderKey, type SaveOutcome } from "./provider-fields";

export { PROVIDER_KEYS, PROVIDER_FIELDS, isProviderKey, type ProviderKey, type SaveOutcome };
const STAFF_KEYS: readonly ProviderKey[] = ["staff-microsoft", "staff-google"];

export type MicrosoftConfig = { tenantId: string; clientId: string };
export type GoogleConfig = { clientId: string };
export type ParentConfig = { tenantSubdomain: string; tenantId: string; clientId: string };
export type ConfigFor = { "staff-microsoft": MicrosoftConfig; "staff-google": GoogleConfig; "parent-oidc": ParentConfig };

export type LoadedProvider<K extends ProviderKey> = { key: K; config: ConfigFor[K]; secret: string; secretExpiresAt: Date | null };
export type LoadedProviders = {
  version: number;
  staffMicrosoft: LoadedProvider<"staff-microsoft"> | null;
  staffGoogle: LoadedProvider<"staff-google"> | null;
  parent: LoadedProvider<"parent-oidc"> | null;
};
export type ProviderSummary = { key: ProviderKey; config: Record<string, string>; secretUpdatedAt: Date; secretExpiresAt: Date | null; readable: boolean };

export type ProviderDraft = { [K in ProviderKey]: { key: K; config: ConfigFor[K]; secret: string | null; secretExpiresAt: Date | null } }[ProviderKey];
export type CheckedDraft = ProviderDraft & { secret: string };
export type CheckResult = { ok: true } | { ok: false; message: string };
export type CheckFn = (draft: CheckedDraft) => Promise<CheckResult>;

export function parentDiscoveryUrl(c: ParentConfig): string {
  return `https://${c.tenantSubdomain}.ciamlogin.com/${c.tenantId}/v2.0/.well-known/openid-configuration`;
}

// ---- loading (cached; a save in this process bumps the version) ----

let version = 1;
let cache: { version: number; value: Promise<LoadedProviders> } | null = null;
export const providersVersion = () => version;
export function invalidateProviders(): void { version += 1; cache = null; }

export function loadProviders(box: SecretBox = secretBox()): Promise<LoadedProviders> {
  if (cache && cache.version === version) return cache.value;
  const v = version;
  const value = readProviders(v, box).catch((e) => { if (cache?.version === v) cache = null; throw e; });
  cache = { version: v, value };
  return value;
}

function openRow(r: typeof authProvider.$inferSelect, box: SecretBox): string | null {
  try {
    return box.open({ ciphertext: r.secretCiphertext, keyId: r.secretKeyId }, r.key);
  } catch (e) {
    if (e instanceof SecretBoxError) return null;
    throw e;
  }
}

async function readProviders(v: number, box: SecretBox): Promise<LoadedProviders> {
  const out: LoadedProviders = { version: v, staffMicrosoft: null, staffGoogle: null, parent: null };
  for (const r of await db.select().from(authProvider)) {
    const secret = openRow(r, box);
    if (secret === null) {
      console.error(`[sign-in] The stored secret for ${r.key} can't be decrypted with SETTINGS_ENCRYPTION_KEY; treating it as not set up.`);
      continue;
    }
    const common = { secret, secretExpiresAt: r.secretExpiresAt };
    if (r.key === "staff-microsoft") out.staffMicrosoft = { key: r.key, config: r.config as MicrosoftConfig, ...common };
    else if (r.key === "staff-google") out.staffGoogle = { key: r.key, config: r.config as GoogleConfig, ...common };
    else out.parent = { key: r.key, config: r.config as ParentConfig, ...common };
  }
  return out;
}

/** What the setup and Settings pages may show: never the secret. */
export async function providerSummaries(box: SecretBox = secretBox()): Promise<ProviderSummary[]> {
  return (await db.select().from(authProvider)).map((r) => ({
    key: r.key, config: r.config as Record<string, string>,
    secretUpdatedAt: r.secretUpdatedAt, secretExpiresAt: r.secretExpiresAt, readable: openRow(r, box) !== null,
  }));
}

// ---- parsing form input ----

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MULTI_TENANT = ["common", "organizations", "consumers"];

const tenantId = z.string().trim().transform((v, ctx) => {
  if (MULTI_TENANT.includes(v.toLowerCase())) {
    ctx.addIssue({ code: "custom", message: `Tenant ID must be your own directory's ID. "${v}" lets any Microsoft account in, so it isn't allowed.` });
    return z.NEVER;
  }
  if (!GUID.test(v)) {
    ctx.addIssue({ code: "custom", message: "Tenant ID must be the Directory (tenant) ID, a value like 0f8fad5b-d9cb-469f-a165-70867728950e. A domain name such as club.onmicrosoft.com won't work." });
    return z.NEVER;
  }
  return v.toLowerCase();
});
const clientGuid = z.string().trim()
  .regex(GUID, "Client ID must be the Application (client) ID, a value like 0f8fad5b-d9cb-469f-a165-70867728950e.")
  .transform((v) => v.toLowerCase());
const googleClientId = z.string().trim()
  .refine((v) => /^[\w.-]+\.apps\.googleusercontent\.com$/.test(v), "Google client ID ends in .apps.googleusercontent.com. Copy it from the OAuth client's page.");
const tenantSubdomain = z.string().trim().toLowerCase()
  .transform((v) => v.replace(/^https?:\/\//, "").split("/")[0]!.replace(/\.(onmicrosoft|ciamlogin)\.com$/, ""))
  .refine((v) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v), "Tenant subdomain is the first part of the tenant's .onmicrosoft.com domain, for example fznparents.");

export function cleanSecret(raw: string): string {
  let s = raw.trim();
  const quoted = s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")));
  if (quoted) s = s.slice(1, -1).trim();
  return s;
}
const secret = z.string().transform(cleanSecret).refine((v) => v.length <= 1024, "That secret is too long to be a client secret.")
  .transform((v) => (v === "" ? null : v));
const expiry = z.string().trim().transform((v, ctx) => {
  if (v === "") return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(d.getTime())) { ctx.addIssue({ code: "custom", message: "Secret expiry must be a date like 2028-11-08." }); return z.NEVER; }
  return d;
});

const SCHEMAS = {
  "staff-microsoft": z.object({ tenantId, clientId: clientGuid }),
  "staff-google": z.object({ clientId: googleClientId }),
  "parent-oidc": z.object({ tenantSubdomain, tenantId, clientId: clientGuid }),
} as const;

export function parseProviderForm(key: ProviderKey, fields: Record<string, string>):
  { ok: true; draft: ProviderDraft } | { ok: false; errors: string[] } {
  const config = SCHEMAS[key].safeParse(fields);
  const s = secret.safeParse(fields.secret ?? "");
  const e = expiry.safeParse(fields.secretExpiresAt ?? "");
  const errors = [config, s, e].flatMap((r) => (r.success ? [] : r.error.issues.map((i) => i.message)));
  if (errors.length || !config.success || !s.success || !e.success) return { ok: false, errors };
  return { ok: true, draft: { key, config: config.data, secret: s.data, secretExpiresAt: e.data } as ProviderDraft };
}

// ---- saving and removing ----

export async function saveProvider(draft: ProviderDraft, opts: {
  actor: Actor; ip: string | null; permission?: string; updatedBy: string | null; check: CheckFn; box?: SecretBox;
}): Promise<SaveOutcome> {
  const box = opts.box ?? secretBox();
  const [existing] = await db.select().from(authProvider).where(eq(authProvider.key, draft.key));
  let plain = draft.secret;
  if (plain === null) {
    if (!existing) return { ok: false, errors: ["Enter the client secret."] };
    plain = openRow(existing, box);
    if (plain === null) return { ok: false, errors: ["The saved secret can't be read any more. Enter the client secret again."] };
  }
  const checked = await opts.check({ ...draft, secret: plain } as CheckedDraft);
  if (!checked.ok) return { ok: false, errors: [checked.message] };

  const secretChanged = draft.secret !== null;
  const sealed = secretChanged ? box.seal(plain, draft.key) : { ciphertext: existing!.secretCiphertext, keyId: existing!.secretKeyId };
  const now = new Date();
  const expiresAt = draft.secretExpiresAt ?? (secretChanged ? null : existing!.secretExpiresAt);
  const values = {
    key: draft.key, config: draft.config, secretCiphertext: sealed.ciphertext, secretKeyId: sealed.keyId,
    secretExpiresAt: expiresAt, secretUpdatedAt: secretChanged ? now : existing!.secretUpdatedAt, updatedAt: now, updatedBy: opts.updatedBy,
  };
  await db.transaction(async (tx) => {
    await tx.insert(authProvider).values(values).onConflictDoUpdate({ target: authProvider.key, set: values });
    await writeAudit({
      actor: opts.actor, action: "setup.provider.save", permission: opts.permission, targetType: "auth_provider", targetId: draft.key,
      before: existing ? { ...(existing.config as object), secretExpiresAt: existing.secretExpiresAt?.toISOString() ?? null } : null,
      after: { ...draft.config, secretExpiresAt: expiresAt?.toISOString() ?? null, secretChanged }, ip: opts.ip,
    }, tx);
  });
  invalidateProviders();
  return { ok: true };
}

export async function removeProvider(key: ProviderKey, opts: { actor: Actor; ip: string | null; permission?: string }): Promise<SaveOutcome> {
  const r = await db.transaction(async (tx): Promise<SaveOutcome> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('booster.auth_provider'))`);
    const rows = await tx.select().from(authProvider);
    const existing = rows.find((x) => x.key === key);
    if (!existing) return { ok: true };
    if (STAFF_KEYS.includes(key) && !rows.some((x) => x.key !== key && STAFF_KEYS.includes(x.key))) {
      return { ok: false, errors: ["This would leave no way for staff to sign in."] };
    }
    await tx.delete(authProvider).where(eq(authProvider.key, key));
    await writeAudit({ actor: opts.actor, action: "setup.provider.remove", permission: opts.permission, targetType: "auth_provider",
      targetId: key, before: existing.config, ip: opts.ip }, tx);
    return { ok: true };
  });
  if (r.ok) invalidateProviders();
  return r;
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm vitest run tests/unit/provider-parse.test.ts tests/integration/providers.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/schema.ts drizzle src/lib/auth/providers.ts tests/helpers/db.ts tests/unit/provider-parse.test.ts tests/integration/providers.test.ts
git commit -m "feat(auth): store sign-in providers encrypted in the database"
```

---

### Task 3: Check values before saving

**Files:**
- Create: `src/lib/auth/provider-checks.ts`
- Test: `tests/unit/provider-checks.test.ts`

**Interfaces:**
- Consumes: `MicrosoftConfig`, `ParentConfig`, `CheckedDraft`, `CheckResult`, `parentDiscoveryUrl` (Task 2).
- Produces: `checkMicrosoft(c, secret, f?)`, `checkParent(c, secret, f?)`, `checkGoogle()`,
  `checkFor(draft: CheckedDraft, f?): Promise<CheckResult>`; `f` defaults to the global `fetch`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/provider-checks.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { checkMicrosoft, checkParent, checkFor } from "@/lib/auth/provider-checks";

const T = "0f8fad5b-d9cb-469f-a165-70867728950e";
const C = "11111111-2222-3333-4444-555555555555";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const aad = (code: number) => json(400, { error: "invalid_client", error_codes: [code] });

describe("checkMicrosoft", () => {
  it("passes when the token request succeeds, and sends the right request", async () => {
    const f = vi.fn(async () => json(200, { access_token: "t" }));
    expect(await checkMicrosoft({ tenantId: T, clientId: C }, "s3cret", f)).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://login.microsoftonline.com/${T}/oauth2/v2.0/token`);
    const body = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(body)).toMatchObject({ grant_type: "client_credentials", client_id: C, client_secret: "s3cret", scope: "https://graph.microsoft.com/.default" });
  });

  it.each([
    [7000215, /rejected the client secret.*15 minutes/],
    [7000222, /expired/],
    [700016, /doesn't know that Application \(client\) ID/],
    [90002, /can't find that tenant/],
  ])("explains AADSTS%s", async (code, msg) => {
    const r = await checkMicrosoft({ tenantId: T, clientId: C }, "s", async () => aad(code));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(msg);
  });

  it("names an unknown code", async () => {
    const r = await checkMicrosoft({ tenantId: T, clientId: C }, "s", async () => aad(1234));
    expect(!r.ok && r.message).toMatch(/AADSTS1234/);
  });

  it("doesn't blame the values when Microsoft can't be reached", async () => {
    const r = await checkMicrosoft({ tenantId: T, clientId: C }, "s", async () => { throw new TypeError("fetch failed"); });
    expect(!r.ok && r.message).toMatch(/Couldn't reach Microsoft/);
  });
});

describe("checkParent", () => {
  const c = { tenantSubdomain: "fznparents", tenantId: T, clientId: C };
  const discovery = `https://fznparents.ciamlogin.com/${T}/v2.0/.well-known/openid-configuration`;
  const doc = { issuer: `https://${T}.ciamlogin.com/${T}/v2.0`, token_endpoint: `https://fznparents.ciamlogin.com/${T}/oauth2/v2.0/token` };

  it("loads discovery, checks the issuer, then requests a token", async () => {
    const f = vi.fn(async (url: string) => (url === discovery ? json(200, doc) : json(200, { access_token: "t" })));
    expect(await checkParent(c, "s", f)).toEqual({ ok: true });
    expect(f.mock.calls.map((x) => x[0])).toEqual([discovery, doc.token_endpoint]);
  });

  it("refuses a discovery document from another tenant", async () => {
    const r = await checkParent(c, "s", async () => json(200, { ...doc, issuer: "https://other.ciamlogin.com/x/v2.0" }));
    expect(!r.ok && r.message).toMatch(/different tenant/);
  });

  it("explains a subdomain/tenant pair that doesn't exist", async () => {
    const r = await checkParent(c, "s", async () => json(400, { error: "invalid_tenant" }));
    expect(!r.ok && r.message).toMatch(/no External ID tenant/);
  });

  it("passes the token error through", async () => {
    const f = async (url: string) => (url === discovery ? json(200, doc) : aad(7000215));
    const r = await checkParent(c, "s", f);
    expect(!r.ok && r.message).toMatch(/rejected the client secret/);
  });
});

describe("checkFor", () => {
  it("does no network check for Google", async () => {
    const f = vi.fn();
    expect(await checkFor({ key: "staff-google", config: { clientId: "x.apps.googleusercontent.com" }, secret: "s", secretExpiresAt: null }, f)).toEqual({ ok: true });
    expect(f).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/unit/provider-checks.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement `src/lib/auth/provider-checks.ts`**

```ts
import { parentDiscoveryUrl, type MicrosoftConfig, type ParentConfig, type CheckedDraft, type CheckResult } from "./providers";

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: FetchFn = (url, init) => fetch(url, init);
const TIMEOUT_MS = 10_000;
const UNREACHABLE = "Couldn't reach Microsoft to check these values. Check the server's internet connection and try again. Nothing was saved.";

const AADSTS: Record<number, string> = {
  7000215: "Microsoft rejected the client secret. Copy the secret's Value (not its Secret ID). If you just created it, wait a few minutes and try again — new secrets can take up to 15 minutes to start working.",
  7000222: "That client secret has expired. Create a new one and paste it here.",
  700016: "Microsoft doesn't know that Application (client) ID in this tenant. Check the client ID, and that the tenant ID is the tenant the app was registered in.",
  90002: "Microsoft can't find that tenant. Check the Directory (tenant) ID.",
  900023: "That tenant ID isn't valid. Copy the Directory (tenant) ID from the tenant's Overview page.",
};

async function clientCredentials(tokenUrl: string, clientId: string, secret: string, f: FetchFn): Promise<CheckResult> {
  let res: Response;
  try {
    res = await f(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret, scope: "https://graph.microsoft.com/.default" }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
  if (res.ok) return { ok: true };
  let body: { error_codes?: unknown } = {};
  try { body = await res.json(); } catch { /* not JSON */ }
  const codes = Array.isArray(body.error_codes) ? body.error_codes.filter((c): c is number => typeof c === "number") : [];
  for (const c of codes) if (AADSTS[c]) return { ok: false, message: AADSTS[c] };
  if (res.status >= 500) return { ok: false, message: UNREACHABLE };
  const which = codes[0] ? `AADSTS${codes[0]}` : `HTTP ${res.status}`;
  return { ok: false, message: `Microsoft refused these values (${which}). Check each value against the app registration.` };
}

export function checkMicrosoft(c: MicrosoftConfig, secret: string, f: FetchFn = defaultFetch): Promise<CheckResult> {
  return clientCredentials(`https://login.microsoftonline.com/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`, c.clientId, secret, f);
}

export async function checkParent(c: ParentConfig, secret: string, f: FetchFn = defaultFetch): Promise<CheckResult> {
  let doc: { issuer?: unknown; token_endpoint?: unknown };
  try {
    const res = await f(parentDiscoveryUrl(c), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 400 || res.status === 404) {
      return { ok: false, message: "Microsoft has no External ID tenant with that subdomain and tenant ID. Check both on the tenant's Overview page." };
    }
    if (!res.ok) return { ok: false, message: UNREACHABLE };
    doc = await res.json();
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
  if (typeof doc.issuer !== "string" || !doc.issuer.toLowerCase().includes(c.tenantId)) {
    return { ok: false, message: "That address belongs to a different tenant. Check that the tenant ID and subdomain come from the same tenant." };
  }
  if (typeof doc.token_endpoint !== "string") {
    return { ok: false, message: "Microsoft's sign-in details for that tenant look incomplete. Try again in a few minutes." };
  }
  return clientCredentials(doc.token_endpoint, c.clientId, secret, f);
}

/** Google has no credential check that works without a user, so its format is checked when parsing; Step 3 proves it. */
export async function checkGoogle(): Promise<CheckResult> {
  return { ok: true };
}

export function checkFor(draft: CheckedDraft, f: FetchFn = defaultFetch): Promise<CheckResult> {
  switch (draft.key) {
    case "staff-microsoft": return checkMicrosoft(draft.config, draft.secret, f);
    case "parent-oidc": return checkParent(draft.config, draft.secret, f);
    case "staff-google": return checkGoogle();
  }
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `pnpm vitest run tests/unit/provider-checks.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/provider-checks.ts tests/unit/provider-checks.test.ts
git commit -m "feat(auth): check sign-in values with Microsoft before saving them"
```

---

### Task 4: Build sign-in from the stored providers

**Files:**
- Modify: `src/lib/auth/staff-auth.ts`, `src/lib/auth/parent-auth.ts`, `src/lib/auth/parent-object-id.ts`,
  `src/lib/auth/identity.ts`, `src/app/api/auth/staff/[...all]/route.ts`, `src/app/api/auth/parent/[...all]/route.ts`,
  `src/app/sign-in/page.tsx`, `src/app/staff/sign-in/page.tsx`, `src/env.ts`, `.env.example`,
  `.github/workflows/ci.yml`, `scripts/check-client-bundle.mjs`
- Test: `tests/integration/auth-rebuild.test.ts` (new); update `tests/integration/signin-audit.test.ts`,
  `tests/integration/parent-auth-hooks.test.ts`, `tests/unit/env.test.ts`

**Interfaces:**
- Consumes: `loadProviders`, `providersVersion`, `parentDiscoveryUrl`, `LoadedProviders` (Task 2).
- Produces: `getStaffAuth(): Promise<StaffAuth>`, `type StaffAuth`; `getParentAuth(): Promise<ParentAuth>`,
  `type ParentAuth`; `PARENT_PROVIDER_ID` stays exported from `parent-auth.ts`. The `staffAuth` and `parentAuth`
  constants and the env exports `staffEntraEnabled`, `staffGoogleEnabled`, `parentDoorEnabled` are removed.

- [ ] **Step 1: Write the failing test**

`tests/integration/auth-rebuild.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { getStaffAuth } from "@/lib/auth/staff-auth";
import { getParentAuth } from "@/lib/auth/parent-auth";
import { resetDb, seedProvider } from "../helpers/db";

const T = "0f8fad5b-d9cb-469f-a165-70867728950e";
const C = "11111111-2222-3333-4444-555555555555";

describe("sign-in built from stored providers", () => {
  beforeEach(resetDb);

  it("has no providers before setup", async () => {
    expect(Object.keys((await getStaffAuth()).options.socialProviders ?? {})).toEqual([]);
    expect((await getParentAuth()).options.plugins ?? []).toHaveLength(0);
  });

  it("is reused until a save, then rebuilt with the new provider", async () => {
    const first = await getStaffAuth();
    expect(await getStaffAuth()).toBe(first);
    await seedProvider("staff-microsoft", { tenantId: T, clientId: C }, "ms-secret");
    const second = await getStaffAuth();
    expect(second).not.toBe(first);
    expect(second.options.socialProviders).toMatchObject({ microsoft: { clientId: C, tenantId: T, clientSecret: "ms-secret" } });
  });

  it("turns the parent door on when the parent provider is stored", async () => {
    await seedProvider("parent-oidc", { tenantSubdomain: "fznparents", tenantId: T, clientId: C });
    expect((await getParentAuth()).options.plugins ?? []).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/integration/auth-rebuild.test.ts`
Expected: FAIL. `getStaffAuth` is not exported.

- [ ] **Step 3: Implement**

`src/lib/auth/staff-auth.ts`: keep every option exactly as it is today; only the provider source and the export
change:

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "@/lib/db/client";
import { recordSignin, recordSignout } from "./signin-audit";
import { staffAuthUser, staffAuthSession, staffAuthAccount, staffAuthVerification } from "@/lib/db/schema";
import { env } from "@/env";
import { loadProviders, type LoadedProviders } from "./providers";

function buildStaffAuth(p: LoadedProviders) {
  return betterAuth({
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
    // Behind Cloudflare: the tunnel sets cf-connecting-ip and the app port is never published, so only that header is trusted.
    advanced: { cookiePrefix: "br_staff", ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    databaseHooks: { session: {
      create: { after: (session, ctx) => recordSignin("staff", session, ctx) },
      delete: { after: (session, ctx) => recordSignout("staff", session, ctx) },
    } },
    session: { expiresIn: 60 * 60 * 12, updateAge: 60 * 60 },
    socialProviders: {
      ...(p.staffMicrosoft ? { microsoft: {
        clientId: p.staffMicrosoft.config.clientId, clientSecret: p.staffMicrosoft.secret,
        tenantId: p.staffMicrosoft.config.tenantId, // single-tenant: only the club's own directory
      } } : {}),
      ...(p.staffGoogle ? { google: { clientId: p.staffGoogle.config.clientId, clientSecret: p.staffGoogle.secret } } : {}),
    },
  });
}

export type StaffAuth = ReturnType<typeof buildStaffAuth>;
let built: { version: number; auth: StaffAuth } | null = null;

/** The staff Better Auth instance for the current stored providers; rebuilt after a provider is saved. */
export async function getStaffAuth(): Promise<StaffAuth> {
  const p = await loadProviders();
  if (!built || built.version !== p.version) built = { version: p.version, auth: buildStaffAuth(p) };
  return built.auth;
}
```

`src/lib/auth/parent-auth.ts`: the same shape. `buildParentAuth(p: LoadedProviders)` holds today's options
unchanged. `plugins` becomes:

```ts
    plugins: p.parent ? [genericOAuth({
      config: [{
        providerId: PARENT_PROVIDER_ID,
        discoveryUrl: parentDiscoveryUrl(p.parent.config),
        clientId: p.parent.config.clientId,
        clientSecret: p.parent.secret,
        scopes: ["openid", "email", "profile"],
        pkce: true,
        // The oid claim must come from a signature-verified ID token, so refuse to run without one.
        requireIdTokenVerification: true,
      }],
    })] : [],
```

Export `type ParentAuth = ReturnType<typeof buildParentAuth>` and `getParentAuth()` with its own `built` cache.
Remove the `parentDoorEnabled` import.

`src/lib/auth/parent-object-id.ts`: replace the `env` import with
`import { loadProviders, providersVersion, parentDiscoveryUrl } from "./providers";`. In `discoverVerifier()`,
replace the first three lines with:

```ts
  const parent = (await loadProviders()).parent;
  if (!parent) throw new DiscoveryError("parent door not configured");
  const url = parentDiscoveryUrl(parent.config);
  const audience = parent.config.clientId;
```

and replace the verifier cache with one keyed by version:

```ts
// Cached per provider version (the remote JWKS caches and refreshes keys itself); a failed discovery is retried next time.
let defaultVerifier: { version: number; value: Promise<ParentIdTokenVerifier> } | null = null;
function getDefaultVerifier(): Promise<ParentIdTokenVerifier> {
  const v = providersVersion();
  if (!defaultVerifier || defaultVerifier.version !== v) {
    const value = discoverVerifier().catch((e) => { if (defaultVerifier?.version === v) defaultVerifier = null; throw e; });
    defaultVerifier = { version: v, value };
  }
  return defaultVerifier.value;
}
```

`src/lib/auth/identity.ts`: import `getStaffAuth` and `getParentAuth`, and replace each `staffAuth.api` with
`(await getStaffAuth()).api` and each `parentAuth.api` with `(await getParentAuth()).api`.

Both route handlers become (staff shown; parent uses `getParentAuth`):

```ts
import { toNextJsHandler } from "better-auth/next-js";
import { getStaffAuth } from "@/lib/auth/staff-auth";

export async function GET(req: Request) { return toNextJsHandler(await getStaffAuth()).GET(req); }
export async function POST(req: Request) { return toNextJsHandler(await getStaffAuth()).POST(req); }
```

`src/app/staff/sign-in/page.tsx`: drop the env import, add `import { loadProviders } from "@/lib/auth/providers";`,
then `const p = await loadProviders(); const ms = Boolean(p.staffMicrosoft), google = Boolean(p.staffGoogle);` and
use `ms` / `google` where `staffEntraEnabled` / `staffGoogleEnabled` were. Do the same in `src/app/sign-in/page.tsx`
with `Boolean(p.parent)` in place of `parentDoorEnabled`.

`src/env.ts`: delete `STAFF_ENTRA_TENANT_ID` (and the `tenantId` refinement and `GUID` constant above it),
`STAFF_ENTRA_CLIENT_ID`, `STAFF_ENTRA_CLIENT_SECRET`, `STAFF_GOOGLE_CLIENT_ID`, `STAFF_GOOGLE_CLIENT_SECRET`,
`PARENT_OIDC_DISCOVERY_URL`, `PARENT_OIDC_CLIENT_ID`, `PARENT_OIDC_CLIENT_SECRET`, and the three `…Enabled` exports.
Keep `BOOTSTRAP_ADMIN_EMAIL` until Task 5.

`.env.example`: delete the staff and parent door blocks. In their place:

```
# Sign-in (Microsoft, Google, parent External ID) is set up in the app at /setup, not here.
```

`.github/workflows/ci.yml`: delete the `STAFF_GOOGLE_*` and `PARENT_OIDC_*` lines from both steps.

`scripts/check-client-bundle.mjs`: `const SECRET_KEYS = ["BETTER_AUTH_SECRET", "SETTINGS_ENCRYPTION_KEY", "DATABASE_URL"];`

Update the existing tests:
- `tests/unit/env.test.ts`: delete the `STAFF_ENTRA_TENANT_ID` describe block. Tenant validation now lives in
  `provider-parse.test.ts`.
- `tests/integration/signin-audit.test.ts`: replace the two auth imports and the `Door` type with:

  ```ts
  import { getStaffAuth } from "@/lib/auth/staff-auth";
  import { getParentAuth } from "@/lib/auth/parent-auth";
  let staffAuth: Awaited<ReturnType<typeof getStaffAuth>>;
  let parentAuth: Awaited<ReturnType<typeof getParentAuth>>;
  beforeAll(async () => { staffAuth = await getStaffAuth(); parentAuth = await getParentAuth(); });
  type Door = typeof staffAuth | typeof parentAuth;
  ```

  Add `beforeAll` to the vitest import. If a `beforeEach(resetDb)` in that file runs after `beforeAll`, that is fine:
  the hooks under test don't depend on providers.
- `tests/integration/parent-auth-hooks.test.ts`: delete the `vi.hoisted` block. Set
  `const TENANT = "11111111-2222-3333-4444-555555555555";` and change the constants to
  `DISCOVERY = \`https://parenttest.ciamlogin.com/${TENANT}/v2.0/.well-known/openid-configuration\``,
  `ISSUER = \`https://${TENANT}.ciamlogin.com/${TENANT}/v2.0\``,
  `JWKS_URI = \`https://parenttest.ciamlogin.com/${TENANT}/discovery/v2.0/keys\``.
  Replace every use of the `parentAuth` constant with `await getParentAuth()`. In the file's `beforeEach`, after
  `resetDb()`, add
  `await seedProvider("parent-oidc", { tenantSubdomain: "parenttest", tenantId: TENANT, clientId: "parent-client-id" });`.
  The fetch stub already answers `DISCOVERY` and `JWKS_URI` by constant, so it keeps working. The token audience
  stays `"parent-client-id"`.

- [ ] **Step 4: Run everything and watch it pass**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS, with every existing test still green.

Run: `grep -rn "STAFF_ENTRA\|STAFF_GOOGLE\|PARENT_OIDC\|staffEntraEnabled\|parentDoorEnabled" src scripts tests .github .env.example`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add -A src tests scripts/check-client-bundle.mjs .env.example .github/workflows/ci.yml
git commit -m "feat(auth): build both sign-ins from stored providers and rebuild them after a save"
```

---

### Task 5: Setup state, setup code, setup session and the first Admin

**Files:**
- Create: `src/lib/setup/state.ts`, `src/lib/setup/code.ts`, `src/lib/setup/session.ts`, `src/lib/setup/guard.ts`,
  `scripts/setup-code.mjs`
- Modify: `src/lib/guards.ts` (export `registerGuard`; widen `GuardInfo.door`), `src/lib/auth/bootstrap.ts`,
  `src/env.ts` (remove `BOOTSTRAP_ADMIN_EMAIL`), `.env.example`, `tests/integration/bootstrap.test.ts`,
  `tests/integration/invariants.test.ts`
- Test: `tests/unit/setup-code.test.ts`, `tests/unit/setup-session.test.ts`, `tests/integration/setup-state.test.ts`,
  `tests/integration/setup-code-script.test.ts`

**Interfaces:**
- Produces (`state.ts`): `type SetupStep = "staff" | "parent" | "admin"`;
  `type SetupState = { status: "open" | "finished"; step: SetupStep; adminEmail: string | null; finishedAt: string | null }`;
  `SETUP_STATE_KEY = "setup.state"`, `SETUP_CODE_KEY = "setup.code"`; `getSetupState(tx?)`,
  `updateSetupState(patch, tx?)`, `normalizeEmail(raw): string | null`,
  `saveAdminEmail(raw, ip): Promise<{ ok: true } | { ok: false; error: string }>`,
  `finishSetup({ staffUserId, email, ip })`, `setupStatusCached(now?)`, `clearSetupStatusCache()`.
- Produces (`code.ts`): `CODE_ALPHABET`, `CODE_LENGTH`, `PER_IP_LIMIT`, `PER_IP_WINDOW_MS`, `MAX_FAILED_TOTAL`,
  `generateCode()`, `formatCode(c)`, `normalizeCode(s)`, `hashCode(normalized, salt)`, `type StoredCode`,
  `readStoredCode()`, `issueSetupCode(): Promise<string>` (formatted), `resetSetupCodeLimiter()`,
  `type VerifyResult`, `verifySetupCode(input, ip, now?)`.
- Produces (`session.ts`): `SETUP_COOKIE = "br_setup"`, `SETUP_SESSION_MS`,
  `signSetupSession(codeHash, unlockedAt, secret?)`, `verifySetupSession(value, codeHash, now?, secret?)`,
  `hasSetupSession()`, `startSetupSession(codeHash)`.
- Produces (`guard.ts`): `setupAction(fn)`, `setupUnlockAction(fn)`; guard doors `"setup"` and `"setup-unlock"`.
- Produces (script): `node scripts/setup-code.mjs [--if-open | --reopen]` prints `Setup code: XXXX-XXXX-XXXX`.

- [ ] **Step 1: Write the failing tests**

`tests/unit/setup-code.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { generateCode, formatCode, normalizeCode, hashCode, CODE_ALPHABET, CODE_LENGTH } from "@/lib/setup/code";

describe("setup code", () => {
  it("is 12 characters from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const c = generateCode();
      expect(c).toHaveLength(CODE_LENGTH);
      for (const ch of c) expect(CODE_ALPHABET).toContain(ch);
    }
    expect(CODE_ALPHABET).not.toMatch(/[01OIL]/);
  });
  it("is shown in groups of four", () => {
    expect(formatCode("K7QM2XPA9RTE")).toBe("K7QM-2XPA-9RTE");
  });
  it("ignores case, spaces and dashes when entered", () => {
    expect(normalizeCode(" k7qm-2xpa 9rte\n")).toBe("K7QM2XPA9RTE");
  });
  it("hashes with the salt", () => {
    expect(hashCode("K7QM2XPA9RTE", "a")).not.toBe(hashCode("K7QM2XPA9RTE", "b"));
    expect(hashCode("K7QM2XPA9RTE", "a")).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

`tests/unit/setup-session.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { signSetupSession, verifySetupSession, SETUP_SESSION_MS } from "@/lib/setup/session";

const SECRET = "test-secret-test-secret-test-secret-32";
const HASH = "ab".repeat(32);

describe("setup session cookie", () => {
  const now = 1_800_000_000_000;
  it("verifies its own value", () => {
    expect(verifySetupSession(signSetupSession(HASH, now, SECRET), HASH, now + 1000, SECRET)).toBe(true);
  });
  it("a setup session survives a restart (depends only on the code hash and the secret)", () => {
    const value = signSetupSession(HASH, now, SECRET);
    expect(verifySetupSession(value, HASH, now + 60_000, SECRET)).toBe(true);
  });
  it("expires after two hours", () => {
    expect(verifySetupSession(signSetupSession(HASH, now, SECRET), HASH, now + SETUP_SESSION_MS + 1, SECRET)).toBe(false);
  });
  it("dies when a new code is issued", () => {
    expect(verifySetupSession(signSetupSession(HASH, now, SECRET), "cd".repeat(32), now, SECRET)).toBe(false);
  });
  it("refuses tampering and junk", () => {
    const [at, mac] = signSetupSession(HASH, now, SECRET).split(".");
    expect(verifySetupSession(`${Number(at) + 1}.${mac}`, HASH, now, SECRET)).toBe(false);
    expect(verifySetupSession("junk", HASH, now, SECRET)).toBe(false);
    expect(verifySetupSession(undefined, HASH, now, SECRET)).toBe(false);
  });
});
```

`tests/integration/setup-state.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, setting } from "@/lib/db/schema";
import { getSetupState, updateSetupState, saveAdminEmail, finishSetup, setupStatusCached, clearSetupStatusCache, SETUP_CODE_KEY } from "@/lib/setup/state";
import { issueSetupCode, verifySetupCode, resetSetupCodeLimiter, readStoredCode, MAX_FAILED_TOTAL } from "@/lib/setup/code";
import { resetDb, seedStaff } from "../helpers/db";

const actions = async () => (await db.select().from(auditLog)).map((a) => a.action);

describe("setup state", () => {
  beforeEach(async () => { await resetDb(); resetSetupCodeLimiter(); clearSetupStatusCache(); });

  it("starts open at the staff step", async () => {
    expect(await getSetupState()).toEqual({ status: "open", step: "staff", adminEmail: null, finishedAt: null });
  });

  it("saves the Admin email lower-cased and audits it", async () => {
    expect(await saveAdminEmail("  First.Admin@Club.ORG ", null)).toEqual({ ok: true });
    expect((await getSetupState()).adminEmail).toBe("first.admin@club.org");
    expect(await actions()).toEqual(["setup.admin_email.save"]);
    expect(await saveAdminEmail("not an email", null)).toEqual({ ok: false, error: "Enter a valid email address." });
  });

  it("finishes once, deletes the code and audits", async () => {
    await issueSetupCode();
    const s = await seedStaff({ email: "a@club.org", admin: true });
    await finishSetup({ staffUserId: s.id, email: "a@club.org", ip: null });
    await finishSetup({ staffUserId: s.id, email: "a@club.org", ip: null });
    expect((await getSetupState()).status).toBe("finished");
    expect(await db.select().from(setting).where(eq(setting.key, SETUP_CODE_KEY))).toHaveLength(0);
    expect((await actions()).filter((a) => a === "setup.finish")).toHaveLength(1);
  });

  it("caches the status briefly for the proxy", async () => {
    expect(await setupStatusCached(1000)).toBe("open");
    await db.insert(setting).values({ key: "setup.state", value: { status: "finished", step: "admin", adminEmail: null, finishedAt: null } })
      .onConflictDoUpdate({ target: setting.key, set: { value: { status: "finished" } } });
    expect(await setupStatusCached(2000)).toBe("open");
    expect(await setupStatusCached(1000 + 6000)).toBe("finished");
  });

  it("updateSetupState clears the cache in this process", async () => {
    expect(await setupStatusCached()).toBe("open");
    await updateSetupState({ status: "finished" });
    expect(await setupStatusCached()).toBe("finished");
  });
});

describe("setup code verification", () => {
  beforeEach(async () => { await resetDb(); resetSetupCodeLimiter(); });

  it("unlocks with the right code in any case or spacing, and audits", async () => {
    const code = await issueSetupCode();
    const r = await verifySetupCode(code.toLowerCase().replaceAll("-", " "), "203.0.113.5");
    expect(r.ok).toBe(true);
    expect(await actions()).toEqual(["setup.code.issue", "setup.unlock"]);
  });

  it("refuses a wrong code and counts it", async () => {
    await issueSetupCode();
    expect(await verifySetupCode("AAAA-AAAA-AAAA", "203.0.113.5")).toEqual({ ok: false, reason: "wrong" });
    expect((await readStoredCode())!.failedTotal).toBe(1);
    expect(await actions()).toContain("setup.unlock.refused");
  });

  it("slows down after 5 wrong tries from one address, but not from another", async () => {
    const code = await issueSetupCode();
    for (let i = 0; i < 5; i++) await verifySetupCode("AAAA-AAAA-AAAA", "203.0.113.5", 1000 + i);
    expect(await verifySetupCode(code, "203.0.113.5", 2000)).toEqual({ ok: false, reason: "slowed" });
    expect((await verifySetupCode(code, "198.51.100.7", 2000)).ok).toBe(true);
    expect((await verifySetupCode(code, "203.0.113.5", 2000 + 15 * 60_000)).ok).toBe(true);
  });

  it("voids the code after 20 wrong tries in total, even across restarts", async () => {
    const code = await issueSetupCode();
    for (let i = 0; i < MAX_FAILED_TOTAL; i++) { resetSetupCodeLimiter(); await verifySetupCode("AAAA-AAAA-AAAA", `203.0.113.${i + 1}`); }
    resetSetupCodeLimiter();
    expect(await verifySetupCode(code, "198.51.100.7")).toEqual({ ok: false, reason: "void" });
  });

  it("says when no code has been issued", async () => {
    expect(await verifySetupCode("AAAA-AAAA-AAAA", null)).toEqual({ ok: false, reason: "no_code" });
  });
});
```

`tests/integration/setup-code-script.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
import { verifySetupCode, resetSetupCodeLimiter } from "@/lib/setup/code";
import { getSetupState, updateSetupState } from "@/lib/setup/state";
import { resetDb } from "../helpers/db";

const DB = "postgres://booster:booster@localhost:5433/booster_test";
const run = (...args: string[]) => spawnSync("node", ["scripts/setup-code.mjs", ...args], {
  encoding: "utf8", env: { ...process.env, DATABASE_URL: DB, APP_URL: "https://portal.example.org" },
});
const codeFrom = (out: string) => /Setup code: ([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/.exec(out)?.[1];

describe("scripts/setup-code.mjs", () => {
  beforeEach(async () => { await resetDb(); resetSetupCodeLimiter(); });

  it("issues a code the app accepts (both sides hash the same way)", async () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("https://portal.example.org/setup");
    expect((await verifySetupCode(codeFrom(r.stdout)!, null)).ok).toBe(true);
  });

  it("replaces the previous code", async () => {
    const first = codeFrom(run().stdout)!;
    const second = codeFrom(run().stdout)!;
    expect((await verifySetupCode(first, null)).ok).toBe(false);
    expect((await verifySetupCode(second, null)).ok).toBe(true);
  });

  it("refuses once setup is finished, and --if-open stays quiet", async () => {
    await updateSetupState({ status: "finished" });
    const r = run();
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("reopen-setup.sh");
    const quiet = run("--if-open");
    expect(quiet.status).toBe(0);
    expect(quiet.stdout).toBe("");
  });

  it("--reopen opens setup at the staff step, audits, and issues a code", async () => {
    await updateSetupState({ status: "finished", step: "admin", adminEmail: "a@club.org" });
    const r = run("--reopen");
    expect(r.status).toBe(0);
    expect(await getSetupState()).toMatchObject({ status: "open", step: "staff", adminEmail: "a@club.org" });
    expect((await db.select().from(auditLog)).map((a) => a.action)).toEqual(["setup.reopen", "setup.code.issue"]);
    expect(codeFrom(r.stdout)).toBeDefined();
  });
});
```

Update `tests/integration/bootstrap.test.ts`: delete the `vi.mock("@/env", …)` block. Change the `beforeEach` to

```ts
beforeEach(async () => {
  await resetDb();
  await updateSetupState({ status: "open", step: "admin", adminEmail: "first.admin@club.org" });
});
```

(import `updateSetupState` from `@/lib/setup/state`) and add:

```ts
  it("matches the Admin email whatever its case", async () => {
    expect(await claimBootstrapAdmin("  FIRST.Admin@Club.org ")).not.toBeNull();
  });

  it("does nothing once setup is finished", async () => {
    await updateSetupState({ status: "finished" });
    expect(await claimBootstrapAdmin("first.admin@club.org")).toBeNull();
  });

  it("does nothing before the Admin step", async () => {
    await updateSetupState({ step: "parent" });
    expect(await claimBootstrapAdmin("first.admin@club.org")).toBeNull();
  });
```

Update `tests/integration/invariants.test.ts`: split out `setupModules = modules.filter((f) => f.startsWith("src/app/setup/"))`
and exclude them from `otherModules`, then add:

```ts
  it.each(setupModules.length ? setupModules : ["(none yet)"])("%s exports only setup-guarded functions", async (file) => {
    if (file === "(none yet)") return;
    for (const [name, value] of await exportedFunctions(file)) {
      const door = guardOf(value)?.door;
      if (name === "unlockSetupAction") expect(door, `${file} → ${name}`).toBe("setup-unlock");
      else expect(door, `${file} → ${name} is not wrapped in setupAction`).toBe("setup");
    }
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/unit/setup-code.test.ts tests/unit/setup-session.test.ts tests/integration/setup-state.test.ts tests/integration/setup-code-script.test.ts tests/integration/bootstrap.test.ts`
Expected: FAIL, because the modules are not found.

- [ ] **Step 3: Implement `src/lib/setup/state.ts`**

```ts
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";

export type SetupStep = "staff" | "parent" | "admin";
export type SetupState = { status: "open" | "finished"; step: SetupStep; adminEmail: string | null; finishedAt: string | null };
export const SETUP_STATE_KEY = "setup.state";
export const SETUP_CODE_KEY = "setup.code";
const DEFAULT_STATE: SetupState = { status: "open", step: "staff", adminEmail: null, finishedAt: null };

export async function getSetupState(tx?: Tx): Promise<SetupState> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, SETUP_STATE_KEY));
  return { ...DEFAULT_STATE, ...((row?.value as Partial<SetupState> | undefined) ?? {}) };
}

export async function updateSetupState(patch: Partial<SetupState>, tx?: Tx): Promise<SetupState> {
  const next: SetupState = { ...(await getSetupState(tx)), ...patch };
  await (tx ?? db).insert(setting).values({ key: SETUP_STATE_KEY, value: next })
    .onConflictDoUpdate({ target: setting.key, set: { value: next, updatedAt: new Date() } });
  statusCache = null;
  return next;
}

const emailSchema = z.string().email();
export function normalizeEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  return emailSchema.safeParse(e).success ? e : null;
}

export async function saveAdminEmail(raw: string, ip: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = normalizeEmail(raw);
  if (!email) return { ok: false, error: "Enter a valid email address." };
  await db.transaction(async (tx) => {
    const before = await getSetupState(tx);
    await updateSetupState({ adminEmail: email, step: "admin" }, tx);
    await writeAudit({ actor: { door: "system", id: null, label: "setup" }, action: "setup.admin_email.save", targetType: "setting",
      targetId: SETUP_STATE_KEY, before: { adminEmail: before.adminEmail }, after: { adminEmail: email }, ip }, tx);
  });
  return { ok: true };
}

/** Marks setup finished (once), voids the setup code, and audits. Safe to call twice. */
export async function finishSetup(o: { staffUserId: string; email: string; ip: string | null }): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('booster.setup'))`);
    if ((await getSetupState(tx)).status === "finished") return;
    await updateSetupState({ status: "finished", finishedAt: new Date().toISOString() }, tx);
    await tx.delete(setting).where(eq(setting.key, SETUP_CODE_KEY));
    await writeAudit({ actor: { door: "staff", id: o.staffUserId, label: o.email }, action: "setup.finish", targetType: "setting",
      targetId: SETUP_STATE_KEY, after: { adminEmail: o.email }, ip: o.ip }, tx);
  });
  statusCache = null;
}

let statusCache: { at: number; status: SetupState["status"] } | null = null;
const cacheMs = () => {
  const v = Number(process.env.SETUP_STATUS_CACHE_MS ?? "5000");
  return Number.isFinite(v) && v >= 0 ? v : 5000;
};
/** For the proxy: the setup status, cached for 5 seconds (SETUP_STATUS_CACHE_MS) so a reopen on the server lands quickly. */
export async function setupStatusCached(now = Date.now()): Promise<SetupState["status"]> {
  if (statusCache && now - statusCache.at < cacheMs()) return statusCache.status;
  const { status } = await getSetupState();
  statusCache = { at: now, status };
  return status;
}
export function clearSetupStatusCache(): void { statusCache = null; }
```

- [ ] **Step 4: Implement `src/lib/setup/code.ts`**

```ts
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { SETUP_CODE_KEY } from "./state";

// scripts/setup-code.mjs repeats ALPHABET, LENGTH and hashCode; tests/integration/setup-code-script.test.ts proves they agree.
export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 12;
export const PER_IP_LIMIT = 5;
export const PER_IP_WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILED_TOTAL = 20;

export type StoredCode = { hash: string; salt: string; issuedAt: string; failedTotal: number };
export type VerifyResult = { ok: true; codeHash: string } | { ok: false; reason: "no_code" | "void" | "slowed" | "wrong" };

export function generateCode(): string {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}
export const formatCode = (c: string) => c.match(/.{1,4}/g)!.join("-");
export const normalizeCode = (input: string) => input.toUpperCase().replace(/[\s-]/g, "");
export const hashCode = (normalized: string, salt: string) => createHash("sha256").update(`${salt}:${normalized}`).digest("hex");

export async function readStoredCode(): Promise<StoredCode | null> {
  const [row] = await db.select().from(setting).where(eq(setting.key, SETUP_CODE_KEY));
  return (row?.value as StoredCode | undefined) ?? null;
}

const SETUP_ACTOR = { door: "system" as const, id: null, label: "setup" };

/** The app-side twin of scripts/setup-code.mjs, used by tests. Returns the formatted code. */
export async function issueSetupCode(): Promise<string> {
  const code = generateCode();
  const salt = randomBytes(16).toString("hex");
  const value: StoredCode = { hash: hashCode(code, salt), salt, issuedAt: new Date().toISOString(), failedTotal: 0 };
  await db.insert(setting).values({ key: SETUP_CODE_KEY, value }).onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } });
  await writeAudit({ actor: SETUP_ACTOR, action: "setup.code.issue", targetType: "setting", targetId: SETUP_CODE_KEY });
  return formatCode(code);
}

// Wrong tries per client address, in memory. The total lives in the database, so a restart can't reset it.
const failures = new Map<string, number[]>();
export function resetSetupCodeLimiter(): void { failures.clear(); }

export async function verifySetupCode(input: string, ip: string | null, now = Date.now()): Promise<VerifyResult> {
  const who = ip ?? "unknown";
  const recent = (failures.get(who) ?? []).filter((t) => now - t < PER_IP_WINDOW_MS);
  failures.set(who, recent);
  const refuse = async (reason: Exclude<VerifyResult, { ok: true }>["reason"]): Promise<VerifyResult> => {
    await writeAudit({ actor: SETUP_ACTOR, action: "setup.unlock.refused", targetType: "setting", targetId: SETUP_CODE_KEY, after: { reason }, ip });
    return { ok: false, reason };
  };
  if (recent.length >= PER_IP_LIMIT) return refuse("slowed");
  const stored = await readStoredCode();
  if (!stored) return refuse("no_code");
  if (stored.failedTotal >= MAX_FAILED_TOTAL) return refuse("void");
  const want = Buffer.from(stored.hash, "hex");
  const got = Buffer.from(hashCode(normalizeCode(input), stored.salt), "hex");
  if (want.length === got.length && timingSafeEqual(want, got)) {
    await writeAudit({ actor: SETUP_ACTOR, action: "setup.unlock", targetType: "setting", targetId: SETUP_CODE_KEY, ip });
    return { ok: true, codeHash: stored.hash };
  }
  recent.push(now);
  await db.execute(sql`UPDATE setting SET value = jsonb_set(value, '{failedTotal}', to_jsonb(COALESCE((value->>'failedTotal')::int, 0) + 1)), updated_at = now() WHERE key = ${SETUP_CODE_KEY}`);
  return refuse(stored.failedTotal + 1 >= MAX_FAILED_TOTAL ? "void" : "wrong");
}
```

- [ ] **Step 5: Implement `src/lib/setup/session.ts`**

```ts
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { env } from "@/env";
import { readStoredCode } from "./code";
import { getSetupState } from "./state";

export const SETUP_COOKIE = "br_setup";
export const SETUP_SESSION_MS = 2 * 60 * 60 * 1000;

const mac = (codeHash: string, unlockedAt: number, secret: string) =>
  createHmac("sha256", secret).update(`setup:${codeHash}:${unlockedAt}`).digest("hex");

export function signSetupSession(codeHash: string, unlockedAt: number, secret: string = env.BETTER_AUTH_SECRET): string {
  return `${unlockedAt}.${mac(codeHash, unlockedAt, secret)}`;
}

/** True when `value` was signed for this code hash less than two hours ago. Issuing a new code changes the hash. */
export function verifySetupSession(value: string | undefined, codeHash: string, now = Date.now(), secret: string = env.BETTER_AUTH_SECRET): boolean {
  if (!value) return false;
  const [at, got] = value.split(".");
  const unlockedAt = Number(at);
  if (!Number.isSafeInteger(unlockedAt) || !got || !/^[0-9a-f]{64}$/.test(got)) return false;
  if (now - unlockedAt > SETUP_SESSION_MS || unlockedAt > now + 60_000) return false;
  return timingSafeEqual(Buffer.from(mac(codeHash, unlockedAt, secret), "hex"), Buffer.from(got, "hex"));
}

export async function hasSetupSession(): Promise<boolean> {
  if ((await getSetupState()).status !== "open") return false;
  const stored = await readStoredCode();
  if (!stored) return false;
  return verifySetupSession((await cookies()).get(SETUP_COOKIE)?.value, stored.hash);
}

// SameSite=Lax, not Strict: Step 3 returns from Microsoft through a cross-site redirect chain, which drops Strict cookies.
export async function startSetupSession(codeHash: string): Promise<void> {
  (await cookies()).set(SETUP_COOKIE, signSetupSession(codeHash, Date.now()), {
    httpOnly: true, secure: env.APP_URL.startsWith("https://"), sameSite: "lax", path: "/", maxAge: SETUP_SESSION_MS / 1000,
  });
}
```

- [ ] **Step 6: Implement the guard**

In `src/lib/guards.ts`: change `type GuardInfo = { door: "staff" | "parent"; permission?: Permission };` to
`export type GuardInfo = { door: "staff" | "parent" | "setup" | "setup-unlock"; permission?: Permission };` and add
`export function registerGuard(fn: object, info: GuardInfo): void { registry.set(fn, info); }`.

`src/lib/setup/guard.ts`:

```ts
import "server-only";
import { AccessDenied, registerGuard } from "@/lib/guards";
import { hasSetupSession } from "./session";

/** A setup-page action: refused unless this browser unlocked setup with the current code. */
export function setupAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const wrapped = async (...args: A): Promise<R> => {
    if (!(await hasSetupSession())) throw new AccessDenied();
    return fn(...args);
  };
  registerGuard(wrapped, { door: "setup" });
  return wrapped;
}

/** The unlock action itself: its guard is the code check (slowed down and audited) it performs. */
export function setupUnlockAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const wrapped = async (...args: A): Promise<R> => fn(...args);
  registerGuard(wrapped, { door: "setup-unlock" });
  return wrapped;
}
```

- [ ] **Step 7: The first Admin comes from setup**

`src/lib/auth/bootstrap.ts`: remove the `env` import, import `getSetupState` from `@/lib/setup/state`, and replace
the body of `claimBootstrapAdmin`:

```ts
/** Creates the first Admin while setup is open at the Admin step, if `email` is the Admin email setup recorded and no Admin exists. */
export async function claimBootstrapAdmin(email: string): Promise<string | null> {
  const got = email.trim().toLowerCase();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('booster.bootstrap_admin'))`);
    const setup = await getSetupState(tx);
    if (setup.status !== "open" || setup.step !== "admin" || !setup.adminEmail || setup.adminEmail !== got) return null;
    if ((await adminCount(tx)) > 0) return null;
    // …the rest (Admin role lookup, staff upsert, role assignment, admin.bootstrap audit) is unchanged.
  });
}
```

Keep the unchanged lines from today's file exactly. Only the two guard lines above replace the env comparison.

`src/env.ts`: delete `BOOTSTRAP_ADMIN_EMAIL`. `.env.example`: delete the `BOOTSTRAP_ADMIN_EMAIL` line and its
comment.

- [ ] **Step 8: Write `scripts/setup-code.mjs`**

```js
#!/usr/bin/env node
// Issues the one-time code that unlocks Boosters Rocket's setup page. Ships in the image as tools/scripts/setup-code.mjs.
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
      console.error("Setup is already finished. To reopen it (for example, nobody can sign in), run scripts/poc/reopen-setup.sh.");
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
```

- [ ] **Step 9: Run the tests and watch them pass**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS. If `pnpm lint` flags Node globals in `scripts/*.mjs`, check how `scripts/migrate.mjs` is handled and
follow the same pattern.

- [ ] **Step 10: Commit**

```bash
git add -A src scripts/setup-code.mjs tests .env.example
git commit -m "feat(setup): setup state, one-time setup code, setup cookie, and the first Admin from setup"
```

---

### Task 6: The PowerShell scripts

**Files:**
- Create: `scripts/setup/New-BoosterRocketStaffApp.ps1`, `scripts/setup/New-BoosterRocketParentApp.ps1`
- Modify: `.github/workflows/ci.yml`
- Test: PSScriptAnalyzer in CI; `tests/unit/setup-scripts.test.ts`

**Interfaces:**
- Produces: two scripts with `param([Parameter(Mandatory)][string]$TenantId, [string]$AppUrl = '__BOOSTER_ROCKET_APP_URL__')`.
  The download route (Task 7) replaces the token `__BOOSTER_ROCKET_APP_URL__` with `APP_URL`. Output lines the setup
  page refers to by name: `Tenant ID`, `Tenant subdomain` (parent only), `Client ID`, `Client secret`,
  `Secret expires`.

- [ ] **Step 1: Write the failing test**

`tests/unit/setup-scripts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const staff = readFileSync("scripts/setup/New-BoosterRocketStaffApp.ps1", "utf8");
const parent = readFileSync("scripts/setup/New-BoosterRocketParentApp.ps1", "utf8");

describe("setup PowerShell scripts", () => {
  it.each([["staff", staff], ["parent", parent]])("%s script never uses device code and takes the app URL token", (_, s) => {
    expect(s).not.toMatch(/UseDeviceCode|devicecode|device_code/i);
    expect(s).toContain("'__BOOSTER_ROCKET_APP_URL__'");
    expect(s).toContain("Connect-MgGraph");
    expect(s).toContain("Disconnect-MgGraph");
    expect(s).not.toMatch(/Out-File|Set-Content|Export-/);
  });
  it("uses the redirect URIs the app serves", () => {
    expect(staff).toContain("/api/auth/staff/callback/microsoft");
    expect(parent).toContain("/api/auth/parent/callback/parent-oidc");
  });
  it("turns sign-up off and uses email one-time passcode", () => {
    expect(parent).toContain("isSignUpAllowed = $false");
    expect(parent).toContain("EmailOtpSignup-OAUTH");
  });
});
```

Run: `pnpm vitest run tests/unit/setup-scripts.test.ts`
Expected: FAIL (ENOENT).

- [ ] **Step 2: Write `scripts/setup/New-BoosterRocketStaffApp.ps1`**

```powershell
#Requires -Version 7.0
<#
.SYNOPSIS
  Creates (or updates) the Boosters Rocket staff sign-in app in your club's Microsoft Entra tenant.
.DESCRIPTION
  Signs you in with the normal Microsoft browser sign-in (never device code), then:
    1. finds the app "Booster Rocket (staff)" or creates it (single tenant),
    2. sets its redirect URI,
    3. requests the sign-in scopes openid, profile, email, offline_access and User.Read,
    4. creates its service principal and grants admin consent for those scopes,
    5. adds a new 24-month client secret,
  and prints the values to paste into the Boosters Rocket setup page. Nothing is written to disk.
  Safe to run again: it reuses the app and adds a new secret, leaving older secrets alone.
.EXAMPLE
  ./New-BoosterRocketStaffApp.ps1 -TenantId 0f8fad5b-d9cb-469f-a165-70867728950e
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$TenantId,
  [string]$AppUrl = '__BOOSTER_ROCKET_APP_URL__'
)
$ErrorActionPreference = 'Stop'

if ($AppUrl -like '*__BOOSTER_ROCKET_APP_URL__*') { throw 'Pass -AppUrl with your site address, for example -AppUrl https://portal.example.org' }
$AppUrl = $AppUrl.TrimEnd('/')
if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication)) {
  Write-Host 'This script needs the Microsoft Graph PowerShell module. Install it with:'
  Write-Host '  Install-Module Microsoft.Graph.Authentication -Scope CurrentUser'
  exit 2
}

$DisplayName = 'Booster Rocket (staff)'
$RedirectUri = "$AppUrl/api/auth/staff/callback/microsoft"
$GraphAppId = '00000003-0000-0000-c000-000000000000'
# Microsoft Graph delegated permission IDs: openid, profile, email, offline_access, User.Read
$Scopes = [ordered]@{
  'openid' = '37f7f235-527c-4136-accd-4a02d197296e'; 'profile' = '14dad69e-099b-42c9-810b-d002981feec1'
  'email' = '64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0'; 'offline_access' = '7427e0e9-2fba-42fe-b0c0-848c9e6a8182'
  'User.Read' = 'e1fe6dd8-ba31-4d61-89e7-88639da4683d'
}

Connect-MgGraph -TenantId $TenantId -Scopes 'Application.ReadWrite.All', 'DelegatedPermissionGrant.ReadWrite.All' -NoWelcome
try {
  $tenant = (Get-MgContext).TenantId
  $access = @{ resourceAppId = $GraphAppId; resourceAccess = @($Scopes.Values | ForEach-Object { @{ id = $_; type = 'Scope' } }) }
  $body = @{ signInAudience = 'AzureADMyOrg'; web = @{ redirectUris = @($RedirectUri) }; requiredResourceAccess = @($access) }

  $found = (Invoke-MgGraphRequest GET "v1.0/applications?`$filter=displayName eq '$DisplayName'").value
  if ($found.Count -gt 1) { throw "More than one app is named '$DisplayName'. Delete the extras in the Entra admin center, then run this again." }
  if ($found.Count -eq 1) {
    $app = $found[0]
    Invoke-MgGraphRequest PATCH "v1.0/applications/$($app.id)" -Body ($body | ConvertTo-Json -Depth 6) -ContentType 'application/json' | Out-Null
    Write-Host "Reusing the existing app '$DisplayName' and making sure its settings are right."
  } else {
    $body.displayName = $DisplayName
    $app = Invoke-MgGraphRequest POST 'v1.0/applications' -Body ($body | ConvertTo-Json -Depth 6) -ContentType 'application/json'
    Write-Host "Created the app '$DisplayName'."
  }

  $sp = (Invoke-MgGraphRequest GET "v1.0/servicePrincipals?`$filter=appId eq '$($app.appId)'").value | Select-Object -First 1
  if (-not $sp) { $sp = Invoke-MgGraphRequest POST 'v1.0/servicePrincipals' -Body (@{ appId = $app.appId } | ConvertTo-Json) -ContentType 'application/json' }
  $graphSp = (Invoke-MgGraphRequest GET "v1.0/servicePrincipals?`$filter=appId eq '$GraphAppId'").value | Select-Object -First 1
  $scopeText = ($Scopes.Keys -join ' ')
  $grant = (Invoke-MgGraphRequest GET "v1.0/oauth2PermissionGrants?`$filter=clientId eq '$($sp.id)' and consentType eq 'AllPrincipals' and resourceId eq '$($graphSp.id)'").value | Select-Object -First 1
  if ($grant) {
    Invoke-MgGraphRequest PATCH "v1.0/oauth2PermissionGrants/$($grant.id)" -Body (@{ scope = $scopeText } | ConvertTo-Json) -ContentType 'application/json' | Out-Null
  } else {
    Invoke-MgGraphRequest POST 'v1.0/oauth2PermissionGrants' -Body (@{ clientId = $sp.id; consentType = 'AllPrincipals'; resourceId = $graphSp.id; scope = $scopeText } | ConvertTo-Json) -ContentType 'application/json' | Out-Null
  }
  Write-Host 'Granted admin consent for the sign-in scopes, so staff will not see a consent prompt.'

  $end = (Get-Date).ToUniversalTime().AddMonths(24).ToString('o')
  $pw = Invoke-MgGraphRequest POST "v1.0/applications/$($app.id)/addPassword" -Body (@{ passwordCredential = @{ displayName = "Booster Rocket $(Get-Date -Format 'yyyy-MM-dd')"; endDateTime = $end } } | ConvertTo-Json -Depth 4) -ContentType 'application/json'
  if ($found.Count -eq 1) { Write-Host 'Added a new client secret. Older secrets on this app were left alone; delete them in the Entra admin center once the new one works.' }

  Write-Host ''
  Write-Host 'Paste these into the Boosters Rocket setup page now. The secret is shown only this once.'
  Write-Host "  Tenant ID:      $tenant"
  Write-Host "  Client ID:      $($app.appId)"
  Write-Host "  Client secret:  $($pw.secretText)"
  Write-Host "  Secret expires: $(([datetime]$pw.endDateTime).ToString('yyyy-MM-dd'))"
  Write-Host 'A brand-new secret can take a few minutes to start working. If the setup page says the secret was rejected, wait and try again.'
} finally {
  Disconnect-MgGraph | Out-Null
}
```

- [ ] **Step 3: Write `scripts/setup/New-BoosterRocketParentApp.ps1`**

```powershell
#Requires -Version 7.0
<#
.SYNOPSIS
  Sets up Boosters Rocket parent sign-in in your Microsoft Entra External ID tenant.
.DESCRIPTION
  Signs you in with the normal Microsoft browser sign-in (never device code) to the External ID tenant, then:
    1. finds the app "Booster Rocket (parents)" or creates it, with its redirect URI and sign-in scopes,
    2. creates its service principal and grants admin consent for openid, profile, email and offline_access,
    3. finds the user flow "Boosters Rocket parents" or creates it, with email one-time passcode sign-in and sign-up turned off,
    4. adds the app to that user flow,
    5. adds a new 24-month client secret,
  and prints the values to paste into the Boosters Rocket setup page. Nothing is written to disk.
  The External ID tenant itself must already exist (create it in the Azure portal first).
.EXAMPLE
  ./New-BoosterRocketParentApp.ps1 -TenantId fznparents.onmicrosoft.com
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$TenantId,
  [string]$AppUrl = '__BOOSTER_ROCKET_APP_URL__'
)
$ErrorActionPreference = 'Stop'

if ($AppUrl -like '*__BOOSTER_ROCKET_APP_URL__*') { throw 'Pass -AppUrl with your site address, for example -AppUrl https://portal.example.org' }
$AppUrl = $AppUrl.TrimEnd('/')
if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication)) {
  Write-Host 'This script needs the Microsoft Graph PowerShell module. Install it with:'
  Write-Host '  Install-Module Microsoft.Graph.Authentication -Scope CurrentUser'
  exit 2
}

$DisplayName = 'Booster Rocket (parents)'
$FlowName = 'Boosters Rocket parents'
$RedirectUri = "$AppUrl/api/auth/parent/callback/parent-oidc"
$GraphAppId = '00000003-0000-0000-c000-000000000000'
$Scopes = [ordered]@{
  'openid' = '37f7f235-527c-4136-accd-4a02d197296e'; 'profile' = '14dad69e-099b-42c9-810b-d002981feec1'
  'email' = '64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0'; 'offline_access' = '7427e0e9-2fba-42fe-b0c0-848c9e6a8182'
}
function Send-Graph([string]$Method, [string]$Uri, $Body) {
  if ($null -eq $Body) { return Invoke-MgGraphRequest $Method $Uri }
  return Invoke-MgGraphRequest $Method $Uri -Body ($Body | ConvertTo-Json -Depth 10) -ContentType 'application/json'
}

Connect-MgGraph -TenantId $TenantId -Scopes 'Application.ReadWrite.All', 'DelegatedPermissionGrant.ReadWrite.All', 'EventListener.ReadWrite.All' -NoWelcome
try {
  $tenant = (Get-MgContext).TenantId
  $initial = (Send-Graph GET 'v1.0/domains' $null).value | Where-Object { $_.isInitial } | Select-Object -First 1
  $subdomain = $initial.id -replace '\.onmicrosoft\.com$', ''

  $access = @{ resourceAppId = $GraphAppId; resourceAccess = @($Scopes.Values | ForEach-Object { @{ id = $_; type = 'Scope' } }) }
  $body = @{ signInAudience = 'AzureADMyOrg'; web = @{ redirectUris = @($RedirectUri) }; requiredResourceAccess = @($access) }
  $found = (Send-Graph GET "v1.0/applications?`$filter=displayName eq '$DisplayName'" $null).value
  if ($found.Count -gt 1) { throw "More than one app is named '$DisplayName'. Delete the extras, then run this again." }
  if ($found.Count -eq 1) {
    $app = $found[0]; Send-Graph PATCH "v1.0/applications/$($app.id)" $body | Out-Null
    Write-Host "Reusing the existing app '$DisplayName' and making sure its settings are right."
  } else {
    $body.displayName = $DisplayName; $app = Send-Graph POST 'v1.0/applications' $body
    Write-Host "Created the app '$DisplayName'."
  }

  $sp = (Send-Graph GET "v1.0/servicePrincipals?`$filter=appId eq '$($app.appId)'" $null).value | Select-Object -First 1
  if (-not $sp) { $sp = Send-Graph POST 'v1.0/servicePrincipals' @{ appId = $app.appId } }
  $graphSp = (Send-Graph GET "v1.0/servicePrincipals?`$filter=appId eq '$GraphAppId'" $null).value | Select-Object -First 1
  $scopeText = ($Scopes.Keys -join ' ')
  $grant = (Send-Graph GET "v1.0/oauth2PermissionGrants?`$filter=clientId eq '$($sp.id)' and consentType eq 'AllPrincipals' and resourceId eq '$($graphSp.id)'" $null).value | Select-Object -First 1
  if ($grant) { Send-Graph PATCH "v1.0/oauth2PermissionGrants/$($grant.id)" @{ scope = $scopeText } | Out-Null }
  else { Send-Graph POST 'v1.0/oauth2PermissionGrants' @{ clientId = $sp.id; consentType = 'AllPrincipals'; resourceId = $graphSp.id; scope = $scopeText } | Out-Null }
  Write-Host 'Granted admin consent for the sign-in scopes.'

  $signUpOff = @{ '@odata.type' = '#microsoft.graph.onInteractiveAuthFlowStartExternalUsersSelfServiceSignUp'; isSignUpAllowed = $false }
  $flow = (Send-Graph GET 'v1.0/identity/authenticationEventsFlows' $null).value | Where-Object { $_.displayName -eq $FlowName } | Select-Object -First 1
  if ($flow) {
    Send-Graph PATCH "v1.0/identity/authenticationEventsFlows/$($flow.id)" @{ '@odata.type' = '#microsoft.graph.externalUsersSelfServiceSignUpEventsFlow'; onInteractiveAuthFlowStart = $signUpOff } | Out-Null
    Write-Host "Reusing the user flow '$FlowName' and making sure sign-up is off."
  } else {
    $flow = Send-Graph POST 'v1.0/identity/authenticationEventsFlows' @{
      '@odata.type' = '#microsoft.graph.externalUsersSelfServiceSignUpEventsFlow'
      displayName = $FlowName
      onInteractiveAuthFlowStart = $signUpOff
      onAuthenticationMethodLoadStart = @{ '@odata.type' = '#microsoft.graph.onAuthenticationMethodLoadStartExternalUsersSelfServiceSignUp'; identityProviders = @(@{ id = 'EmailOtpSignup-OAUTH' }) }
      onAttributeCollection = @{
        '@odata.type' = '#microsoft.graph.onAttributeCollectionExternalUsersSelfServiceSignUp'
        attributes = @(@{ id = 'email'; displayName = 'Email Address'; description = 'Email address of the user'; userFlowAttributeType = 'builtIn'; dataType = 'string' })
        attributeCollectionPage = @{ views = @(@{ inputs = @(@{ attribute = 'email'; label = 'Email Address'; inputType = 'text'; hidden = $true; editable = $false; writeToDirectory = $true; required = $true }) }) }
      }
    }
    Write-Host "Created the user flow '$FlowName' with email one-time passcode sign-in and sign-up turned off."
  }
  $linked = (Send-Graph GET "v1.0/identity/authenticationEventsFlows/$($flow.id)/conditions/applications/includeApplications" $null).value
  if (-not ($linked | Where-Object { $_.appId -eq $app.appId })) {
    Send-Graph POST "v1.0/identity/authenticationEventsFlows/$($flow.id)/conditions/applications/includeApplications" @{ '@odata.type' = '#microsoft.graph.authenticationConditionApplication'; appId = $app.appId } | Out-Null
    Write-Host "Added the app to '$FlowName'."
  }

  $end = (Get-Date).ToUniversalTime().AddMonths(24).ToString('o')
  $pw = Send-Graph POST "v1.0/applications/$($app.id)/addPassword" @{ passwordCredential = @{ displayName = "Booster Rocket $(Get-Date -Format 'yyyy-MM-dd')"; endDateTime = $end } }
  if ($found.Count -eq 1) { Write-Host 'Added a new client secret. Older secrets were left alone; delete them once the new one works.' }

  Write-Host ''
  Write-Host 'Paste these into the Boosters Rocket setup page now. The secret is shown only this once.'
  Write-Host "  Tenant subdomain: $subdomain"
  Write-Host "  Tenant ID:        $tenant"
  Write-Host "  Client ID:        $($app.appId)"
  Write-Host "  Client secret:    $($pw.secretText)"
  Write-Host "  Secret expires:   $(([datetime]$pw.endDateTime).ToString('yyyy-MM-dd'))"
} finally {
  Disconnect-MgGraph | Out-Null
}
```

If Graph rejects the user-flow POST because of the attribute collection, the Microsoft Learn example 1 at
https://learn.microsoft.com/graph/api/identitycontainer-post-authenticationeventsflows (v1.0) is the reference. This
script is first run for real in the proof of concept, and anything that run finds is fixed there.

- [ ] **Step 4: Lint in CI**

In `.github/workflows/ci.yml` `test` job, after the shellcheck step:

```yaml
      - name: PowerShell lint
        shell: pwsh
        run: |
          Install-Module PSScriptAnalyzer -Force -Scope CurrentUser
          $issues = Invoke-ScriptAnalyzer -Path scripts/setup -Recurse -Severity Error
          $issues | Format-Table -AutoSize
          if ($issues) { exit 1 }
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm vitest run tests/unit/setup-scripts.test.ts`
Expected: PASS. If `pwsh` is installed locally, also run
`pwsh -c "Invoke-ScriptAnalyzer -Path scripts/setup -Severity Error"`. Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add scripts/setup tests/unit/setup-scripts.test.ts .github/workflows/ci.yml
git commit -m "feat(setup): optional PowerShell scripts that create the app registrations"
```

---

### Task 7: The setup page

**Files:**
- Create: `src/proxy.ts`, `src/app/setup/page.tsx`, `src/app/setup/actions.ts`, `src/app/setup/unlock-form.tsx`,
  `src/app/setup/steps.tsx`, `src/app/setup/instructions.tsx`, `src/app/setup/setup-buttons.tsx`,
  `src/app/setup/finish/route.ts`, `src/app/setup/scripts/[name]/route.ts`,
  `src/app/components/sign-in-settings/provider-form.tsx`, `src/app/components/sign-in-settings/copy-field.tsx`,
  `src/app/components/sign-in-settings/labels.ts`, `tests/e2e/setup.spec.ts`
- Modify: `src/app/booster.css`, `scripts/seed-e2e.ts`, `playwright.config.ts`, `.github/workflows/ci.yml`,
  `Dockerfile`
- Test: `tests/integration/setup-scripts-route.test.ts`, `tests/e2e/setup.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 2, 3 and 5; `getStaffIdentity`, `hasStaffSession` (`identity.ts`);
  `effectivePermissions`, `can` (`permissions/effective.ts`); `clientIpFrom`, `requestIp` (`request.ts`);
  `staffAuthClient`, `parentAuthClient` (`auth/client.ts`); `LocalTime`.
- Produces: `ProviderForm({ providerKey, summary, action })`, where `summary: SummaryView | null` and
  `type SummaryView = { config: Record<string,string>; secretUpdatedAt: string; secretExpiresAt: string | null; readable: boolean }`;
  `toSummaryView(s: ProviderSummary): SummaryView`; `CopyField({ label, value })`;
  `PROVIDER_LABELS: Record<ProviderKey, string>`. Task 8 reuses all of these.

- [ ] **Step 1: Shared components**

`src/app/components/sign-in-settings/labels.ts`:

```ts
import type { ProviderKey, ProviderSummary } from "@/lib/auth/providers";

export const PROVIDER_LABELS: Record<ProviderKey, string> = {
  "staff-microsoft": "Staff sign-in with Microsoft",
  "staff-google": "Staff sign-in with Google",
  "parent-oidc": "Parent sign-in",
};
export const FIELD_LABELS: Record<"tenantId" | "clientId" | "tenantSubdomain", string> = {
  tenantId: "Directory (tenant) ID",
  clientId: "Application (client) ID",
  tenantSubdomain: "Tenant subdomain",
};
export type SummaryView = { config: Record<string, string>; secretUpdatedAt: string; secretExpiresAt: string | null; readable: boolean };
export const toSummaryView = (s: ProviderSummary): SummaryView => ({
  config: s.config, secretUpdatedAt: s.secretUpdatedAt.toISOString(), secretExpiresAt: s.secretExpiresAt?.toISOString() ?? null, readable: s.readable,
});
```

For Google, `FIELD_LABELS.clientId` reads "Application (client) ID". `ProviderForm` overrides it to "Client ID" when
`providerKey === "staff-google"`.

`src/app/components/sign-in-settings/copy-field.tsx`:

```tsx
"use client";
import { useState } from "react";

/** A value the admin copies into Microsoft or Google: shown read-only with a Copy button. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { setCopied(false); }
  };
  return (
    <div className="field copy-field">
      <span>{label}</span>
      <div className="copy-row">
        <input readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn btn-line" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <span aria-live="polite" className="visually-hidden">{copied ? `${label} copied` : ""}</span>
    </div>
  );
}
```

`src/app/components/sign-in-settings/provider-form.tsx`:

```tsx
"use client";
import { useActionState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import { LocalTime } from "@/app/components/local-time";
import { PROVIDER_FIELDS, type ProviderKey, type SaveOutcome } from "@/lib/auth/provider-fields";
import { FIELD_LABELS, type SummaryView } from "./labels";

export function ProviderForm({ providerKey, summary, action }: {
  providerKey: ProviderKey; summary: SummaryView | null; action: (form: FormData) => Promise<SaveOutcome>;
}) {
  const [state, run, pending] = useActionState(
    async (_: SaveOutcome | null, f: FormData) => safely(() => action(f), { ok: false as const, errors: [ACTION_FAILED] }), null);
  const google = providerKey === "staff-google";
  return (
    <form action={run} className="stack">
      {PROVIDER_FIELDS[providerKey].map((name) => (
        <label key={name} className="field">
          <span>{google && name === "clientId" ? "Client ID" : FIELD_LABELS[name]}</span>
          <input name={name} defaultValue={summary?.config[name] ?? ""} required autoComplete="off" spellCheck={false} />
        </label>
      ))}
      <label className="field">
        <span>Client secret{summary?.readable ? " (leave blank to keep the saved one)" : ""}</span>
        <input name="secret" type="password" autoComplete="new-password" required={!summary?.readable} />
      </label>
      {summary && (
        <p className="hint">
          {summary.readable
            ? <>Secret saved <LocalTime iso={summary.secretUpdatedAt} />{summary.secretExpiresAt && <>, expires <LocalTime iso={summary.secretExpiresAt} /></>}.</>
            : "The saved secret can't be read with this server's encryption key. Enter it again."}
        </p>
      )}
      <label className="field">
        <span>Secret expiry date (optional)</span>
        <input name="secretExpiresAt" type="date" />
      </label>
      {state && !state.ok && <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      {state?.ok && <p role="status">Checked and saved.</p>}
      <button className="btn" disabled={pending}>{pending ? (google ? "Saving…" : "Checking with Microsoft…") : google ? "Save" : "Check and save"}</button>
    </form>
  );
}
```

Client components import only from `@/lib/auth/provider-fields` (database-free), never from `providers.ts`, except
for `import type`. `pnpm build` (Step 8) fails loudly if a client component reaches the database.

Add to `src/app/booster.css`, after the `.field` rules:

```css
.copy-row { display: flex; gap: var(--s2); }
.copy-row input { flex: 1; min-width: 0; }
.copy-row .btn { flex: none; }
.steps-list { display: grid; gap: var(--s3); padding-left: 1.4em; max-width: 68ch; }
.steps-list li { padding-left: var(--s1); }
.hint { color: var(--ink-2); font-size: 0.9375rem; }
.setup-progress { display: flex; gap: var(--s3); flex-wrap: wrap; margin-top: var(--s3); list-style: none; padding: 0; }
.setup-progress [aria-current="step"] { font-weight: 700; text-decoration: underline; }
```

- [ ] **Step 2: Write the e2e test that fails**

`tests/e2e/setup.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!);
const finishedState = { status: "finished", step: "admin", adminEmail: null, finishedAt: "2026-11-08T00:00:00Z" };

test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  await sql`UPDATE setting SET value = ${sql.json(finishedState)} WHERE key = 'setup.state'`;
  await sql.end();
});

function reopen(): string {
  const out = execFileSync("node", ["scripts/setup-code.mjs", "--reopen"], { encoding: "utf8", env: process.env });
  return /Setup code: (\S+)/.exec(out)![1]!;
}

test("while setup is open, every page goes to /setup, and a wrong code is refused", async ({ page }) => {
  reopen();
  for (const path of ["/", "/sign-in", "/staff", "/staff/roles"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/setup$/);
  }
  await page.getByLabel("Setup code").fill("AAAA-AAAA-AAAA");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("alert")).toContainText("isn't right");
});

test("the right code unlocks the staff step with the redirect URI to copy", async ({ page }) => {
  const code = reopen();
  await page.goto("/setup");
  await page.getByLabel("Setup code").fill(code.toLowerCase());
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("heading", { name: "Step 1: Staff sign-in" })).toBeVisible();
  await expect(page.getByLabel("Redirect URI").first()).toHaveValue("http://localhost:3100/api/auth/staff/callback/microsoft");
  expect(await page.content()).not.toContain("ci-fake");
});

test("the health check and sign-in API stay reachable while setup is open", async ({ request }) => {
  reopen();
  expect((await request.get("/api/health")).status()).toBe(200);
  expect((await request.get("/api/auth/staff/ok")).status()).toBeLessThan(500);
});

test("after setup is finished, /setup is not found", async ({ page }) => {
  await sql`UPDATE setting SET value = ${sql.json(finishedState)} WHERE key = 'setup.state'`;
  const res = await page.goto("/setup");
  expect(res?.status()).toBe(404);
  await page.goto("/sign-in");
  await expect(page).toHaveURL(/\/sign-in$/);
});
```

Make the e2e run deterministic. In `playwright.config.ts`, add `workers: 1` and
`webServer.env: { ...process.env, SETUP_STATUS_CACHE_MS: "0" }`. The other spec files expect setup to be finished, so
`scripts/seed-e2e.ts` must also add:

```ts
  await sql`INSERT INTO setting (key, value) VALUES ('setup.state', ${sql.json({ status: "finished", step: "admin", adminEmail: null, finishedAt: "2026-11-08T00:00:00Z" })})
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`;
```

Run: `pnpm build && pnpm db:migrate && pnpm tsx scripts/seed-e2e.ts && pnpm e2e tests/e2e/setup.spec.ts`. Locally,
set the same env the CI E2E step sets (`DATABASE_URL` pointing at `booster_test`, `APP_URL=http://localhost:3100`,
`BETTER_AUTH_SECRET`, `SETTINGS_ENCRYPTION_KEY`).
Expected: FAIL. `/` doesn't redirect to `/setup`.

- [ ] **Step 3: The proxy**

`src/proxy.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { setupStatusCached } from "@/lib/setup/state";

/** While setup is open, every page goes to /setup. API routes (health, sign-in callbacks) are not matched. */
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === "/setup" || pathname.startsWith("/setup/")) return NextResponse.next();
  if ((await setupStatusCached()) === "open") return NextResponse.redirect(new URL("/setup", req.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api/|_next/|favicon\\.ico|.*\\.(?:png|svg|ico|webp|jpg|css|js|woff2?|txt)$).*)"],
};
```

Next.js 16 runs `proxy.ts` on the Node.js runtime, so importing the database client is allowed. If `pnpm build`
reports otherwise, stop and report it instead of working around it.

Note that `NextResponse.redirect(new URL("/setup", req.url))` uses the request URL. Behind the tunnel the Host header
is the public hostname (spec), so the redirect is correct.

- [ ] **Step 4: Setup actions**

`src/app/setup/actions.ts`:

```ts
"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { setupAction, setupUnlockAction } from "@/lib/setup/guard";
import { verifySetupCode } from "@/lib/setup/code";
import { startSetupSession } from "@/lib/setup/session";
import { getSetupState, updateSetupState, saveAdminEmail, type SetupStep } from "@/lib/setup/state";
import { isProviderKey, parseProviderForm, saveProvider, providerSummaries, type SaveOutcome } from "@/lib/auth/providers";
import { checkFor } from "@/lib/auth/provider-checks";
import { requestIp } from "@/lib/request";

const UNLOCK_MESSAGES = {
  wrong: "That code isn't right. Check it against what the server printed.",
  slowed: "Too many wrong codes from here. Wait 15 minutes and try again.",
  void: "This code stopped working after too many wrong tries. On the server, run scripts/poc/setup-code.sh for a new one.",
  no_code: "No setup code has been issued yet. On the server, run scripts/poc/setup-code.sh.",
} as const;

export const unlockSetupAction = setupUnlockAction(async (_prev: { error: string } | null, form: FormData): Promise<{ error: string } | null> => {
  if ((await getSetupState()).status !== "open") return { error: "Setup is already finished." };
  const r = await verifySetupCode(String(form.get("code") ?? ""), await requestIp());
  if (!r.ok) return { error: UNLOCK_MESSAGES[r.reason] };
  await startSetupSession(r.codeHash);
  redirect("/setup");
});

const FIELD_NAMES = ["tenantId", "clientId", "tenantSubdomain", "secret", "secretExpiresAt"] as const;

export const saveSetupProviderAction = setupAction(async (key: string, form: FormData): Promise<SaveOutcome> => {
  if (!isProviderKey(key)) return { ok: false, errors: ["Unknown sign-in."] };
  const parsed = parseProviderForm(key, Object.fromEntries(FIELD_NAMES.map((n) => [n, String(form.get(n) ?? "")])));
  if (!parsed.ok) return parsed;
  const r = await saveProvider(parsed.draft, { actor: { door: "system", id: null, label: "setup" }, ip: await requestIp(), updatedBy: null, check: (d) => checkFor(d) });
  revalidatePath("/setup");
  return r;
});

export const goToStepAction = setupAction(async (step: SetupStep): Promise<void> => {
  if (step !== "staff") {
    const staffReady = (await providerSummaries()).some((s) => s.readable && s.key !== "parent-oidc");
    if (!staffReady) redirect("/setup?step=staff&error=staff_first");
  }
  await updateSetupState({ step });
  redirect(`/setup?step=${step}`);
});

export const saveAdminEmailAction = setupAction(async (_prev: { error: string } | null, form: FormData): Promise<{ error: string } | null> => {
  const r = await saveAdminEmail(String(form.get("email") ?? ""), await requestIp());
  if (!r.ok) return { error: r.error };
  revalidatePath("/setup");
  return null;
});
```

Unlock is not wrapped in `safely`, because `safely` would swallow the redirect.

- [ ] **Step 5: The page and its parts**

`src/app/setup/unlock-form.tsx`:

```tsx
"use client";
import { useActionState } from "react";
import { unlockSetupAction } from "./actions";

export function UnlockForm() {
  const [state, run, pending] = useActionState(unlockSetupAction, null);
  return (
    <form action={run} className="stack">
      <label className="field"><span>Setup code</span>
        <input name="code" required autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} placeholder="XXXX-XXXX-XXXX" />
      </label>
      {state?.error && <p role="alert" className="errors">{state.error}</p>}
      <button className="btn" disabled={pending}>Unlock</button>
    </form>
  );
}
```

`src/app/setup/setup-buttons.tsx`:

```tsx
"use client";
import { useState } from "react";
import { staffAuthClient, parentAuthClient } from "@/lib/auth/client";
import { PARENT_PROVIDER_ID } from "@/lib/auth/parent-provider-id";

const FAILED = "We couldn't start sign-in just then. Please try again in a moment.";

export function SetupStaffSignIn({ provider, label }: { provider: "microsoft" | "google"; label: string }) {
  const [failed, setFailed] = useState(false);
  const go = async () => {
    setFailed(false);
    try {
      const r = await staffAuthClient.signIn.social({ provider, callbackURL: "/setup/finish", errorCallbackURL: "/setup?step=admin&error=signin_failed" });
      if (r?.error) setFailed(true);
    } catch { setFailed(true); }
  };
  return <><button type="button" className="btn" onClick={go}>{label}</button>{failed && <p role="alert" className="errors inline-alert">{FAILED}</p>}</>;
}

export function SetupParentTest() {
  const [failed, setFailed] = useState(false);
  const go = async () => {
    setFailed(false);
    try {
      const r = await parentAuthClient.signIn.social({ provider: PARENT_PROVIDER_ID, callbackURL: "/setup?step=parent&tested=ok", errorCallbackURL: "/setup?step=parent&tested=failed" });
      if (r?.error) setFailed(true);
    } catch { setFailed(true); }
  };
  return <><button type="button" className="btn btn-line" onClick={go}>Test parent sign-in</button>{failed && <p role="alert" className="errors inline-alert">{FAILED}</p>}</>;
}

export function SetupStaffSignOut() {
  return <button type="button" className="btn btn-line" onClick={async () => { await staffAuthClient.signOut(); location.assign("/setup?step=admin"); }}>Sign out and try again</button>;
}
```

`PARENT_PROVIDER_ID` currently lives in `parent-object-id.ts`, which imports the database. Move the constant to a new
`src/lib/auth/parent-provider-id.ts` (`export const PARENT_PROVIDER_ID = "parent-oidc";`) and re-export it from
`parent-object-id.ts` and `parent-auth.ts`. Then `src/app/sign-in/page.tsx` and this client file can import it
without the database.

`src/app/setup/instructions.tsx` holds server components with the walk-throughs. Use exactly this copy. Values the
admin types into Microsoft or Google go in `CopyField`; the portal clicks are in bold.

```tsx
import { CopyField } from "@/app/components/sign-in-settings/copy-field";

const ENTRA_APPS = "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade";
const ext = { target: "_blank", rel: "noreferrer" } as const;

export function MicrosoftStaffSteps({ appUrl }: { appUrl: string }) {
  return (
    <ol className="steps-list">
      <li>Open <a href={ENTRA_APPS} {...ext}>App registrations in the Microsoft Entra admin center</a>, signed in as an admin of the club&apos;s Microsoft tenant. Select <b>New registration</b>.</li>
      <li><CopyField label="Name" value="Booster Rocket (staff)" /></li>
      <li>Under <b>Supported account types</b>, choose <b>Accounts in this organizational directory only (Single tenant)</b>.</li>
      <li>Under <b>Redirect URI</b>, choose <b>Web</b> and enter:<CopyField label="Redirect URI" value={`${appUrl}/api/auth/staff/callback/microsoft`} /> Then select <b>Register</b>.</li>
      <li>On the app&apos;s <b>Overview</b>, copy the <b>Application (client) ID</b> and <b>Directory (tenant) ID</b> into the form below.</li>
      <li>Open <b>API permissions</b> &gt; <b>Add a permission</b> &gt; <b>Microsoft Graph</b> &gt; <b>Delegated permissions</b>, tick <b>openid</b>, <b>profile</b>, <b>email</b> and <b>offline_access</b>, and select <b>Add permissions</b>. Then select <b>Grant admin consent</b> and <b>Yes</b>.</li>
      <li>Open <b>Certificates &amp; secrets</b> &gt; <b>New client secret</b>, choose <b>24 months</b>, and select <b>Add</b>. Copy the secret&apos;s <b>Value</b> (not its Secret ID) straight away; Microsoft shows it only once. Note its expiry date too.</li>
    </ol>
  );
}

export function GoogleStaffSteps({ appUrl }: { appUrl: string }) {
  return (
    <ol className="steps-list">
      <li>Open <a href="https://console.cloud.google.com/apis/credentials" {...ext}>Credentials in the Google Cloud console</a> for the club&apos;s Google account, and create or pick a project.</li>
      <li>If asked, set up the <b>OAuth consent screen</b> first: app name <b>Boosters Rocket</b>, and the club&apos;s support email.</li>
      <li>Select <b>Create credentials</b> &gt; <b>OAuth client ID</b> &gt; <b>Web application</b>. Under <b>Authorized redirect URIs</b>, add:<CopyField label="Redirect URI" value={`${appUrl}/api/auth/staff/callback/google`} /> Then select <b>Create</b>.</li>
      <li>Copy the <b>Client ID</b> and <b>Client secret</b> into the form below.</li>
    </ol>
  );
}

export function ParentSteps({ appUrl }: { appUrl: string }) {
  return (
    <ol className="steps-list">
      <li>You need an Entra External ID tenant for parents. If you don&apos;t have one, <a href="https://learn.microsoft.com/entra/external-id/customers/how-to-create-external-tenant-portal" {...ext}>create it in the Azure portal</a> first. Then, in the Entra admin center, use <b>Settings</b> (the gear) &gt; <b>Directories + subscriptions</b> to switch to it.</li>
      <li>On the tenant&apos;s <b>Overview</b>, copy the <b>Tenant ID</b>, and the first part of its <b>Primary domain</b> (for <code>fznparents.onmicrosoft.com</code> that is <code>fznparents</code>) as the tenant subdomain.</li>
      <li>Open <a href={ENTRA_APPS} {...ext}>App registrations</a> &gt; <b>New registration</b>.<CopyField label="Name" value="Booster Rocket (parents)" /> Choose <b>Accounts in this organizational directory only</b>, and under <b>Redirect URI</b> choose <b>Web</b>:<CopyField label="Redirect URI" value={`${appUrl}/api/auth/parent/callback/parent-oidc`} /> Select <b>Register</b> and copy the <b>Application (client) ID</b>.</li>
      <li><b>API permissions</b> &gt; <b>Add a permission</b> &gt; <b>Microsoft Graph</b> &gt; <b>Delegated permissions</b>: tick <b>openid</b>, <b>profile</b>, <b>email</b> and <b>offline_access</b>, add them, then <b>Grant admin consent</b>.</li>
      <li><b>Certificates &amp; secrets</b> &gt; <b>New client secret</b>, <b>24 months</b>. Copy its <b>Value</b> straight away.</li>
      <li><b>External Identities</b> &gt; <b>User flows</b> &gt; <b>New user flow</b>.<CopyField label="User flow name" value="Boosters Rocket parents" /> Under <b>Identity providers</b> choose <b>Email one-time passcode</b>, then <b>Create</b>. Open the flow, choose <b>Applications</b> &gt; <b>Add application</b>, and pick <b>Booster Rocket (parents)</b>.</li>
      <li>Turn sign-up off, so strangers can&apos;t make accounts. The admin center has no switch for this, so use the PowerShell script above, or <a href="https://learn.microsoft.com/entra/external-id/customers/how-to-disable-sign-up-user-flow" {...ext}>Microsoft&apos;s instructions</a> with Graph Explorer, signed in to the External ID tenant.</li>
    </ol>
  );
}

export function ScriptOption({ script, example }: { script: string; example: string }) {
  return (
    <details className="box">
      <summary>Use the PowerShell script instead</summary>
      <p>The script signs you in with the normal Microsoft sign-in page in your browser, does the steps for you, and prints the values to paste below. It needs PowerShell 7 and the Microsoft Graph module (<code>Install-Module Microsoft.Graph.Authentication</code>).</p>
      <p><a className="btn btn-line" href={`/setup/scripts/${script}`} download>Download {script}</a></p>
      <CopyField label="Then run" value={example} />
    </details>
  );
}
```

`src/app/setup/steps.tsx` (server components):

```tsx
import { PROVIDER_LABELS, toSummaryView } from "@/app/components/sign-in-settings/labels";
import { ProviderForm } from "@/app/components/sign-in-settings/provider-form";
import type { ProviderKey, ProviderSummary } from "@/lib/auth/providers";
import { saveSetupProviderAction, goToStepAction, saveAdminEmailAction } from "./actions";
import { MicrosoftStaffSteps, GoogleStaffSteps, ParentSteps, ScriptOption } from "./instructions";
import { SetupStaffSignIn, SetupParentTest, SetupStaffSignOut } from "./setup-buttons";
import { AdminEmailForm } from "./admin-email-form";

type ByKey = Partial<Record<ProviderKey, ProviderSummary>>;
const view = (s?: ProviderSummary) => (s ? toSummaryView(s) : null);

export function StaffStep({ appUrl, byKey, error }: { appUrl: string; byKey: ByKey; error?: string }) {
  const ready = Boolean(byKey["staff-microsoft"]?.readable || byKey["staff-google"]?.readable);
  return (
    <>
      <h2 className="page-title">Step 1: Staff sign-in</h2>
      <p className="lede">Board members and directors sign in with Microsoft, Google, or both. Set up at least one.</p>
      {error === "staff_first" && <p role="alert" className="errors">Save at least one staff sign-in first.</p>}
      <section className="box" aria-labelledby="ms-h"><h2 id="ms-h">{PROVIDER_LABELS["staff-microsoft"]}</h2>
        <MicrosoftStaffSteps appUrl={appUrl} />
        <ScriptOption script="New-BoosterRocketStaffApp.ps1" example="./New-BoosterRocketStaffApp.ps1 -TenantId <your tenant ID or domain>" />
        <ProviderForm providerKey="staff-microsoft" summary={view(byKey["staff-microsoft"])} action={saveSetupProviderAction.bind(null, "staff-microsoft")} />
      </section>
      <section className="box" aria-labelledby="g-h"><h2 id="g-h">{PROVIDER_LABELS["staff-google"]}</h2>
        <GoogleStaffSteps appUrl={appUrl} />
        <ProviderForm providerKey="staff-google" summary={view(byKey["staff-google"])} action={saveSetupProviderAction.bind(null, "staff-google")} />
      </section>
      <form action={goToStepAction.bind(null, "parent")}><button className="btn" disabled={!ready}>Next: parent sign-in</button></form>
    </>
  );
}

export function ParentStep({ appUrl, byKey, tested }: { appUrl: string; byKey: ByKey; tested?: string }) {
  const saved = Boolean(byKey["parent-oidc"]?.readable);
  return (
    <>
      <h2 className="page-title">Step 2: Parent sign-in</h2>
      <p className="lede">Parents sign in with a code sent to their email, through Microsoft Entra External ID. You can skip this and do it later under Settings.</p>
      <section className="box" aria-labelledby="p-h"><h2 id="p-h">{PROVIDER_LABELS["parent-oidc"]}</h2>
        <ParentSteps appUrl={appUrl} />
        <ScriptOption script="New-BoosterRocketParentApp.ps1" example="./New-BoosterRocketParentApp.ps1 -TenantId <subdomain>.onmicrosoft.com" />
        <ProviderForm providerKey="parent-oidc" summary={view(byKey["parent-oidc"])} action={saveSetupProviderAction.bind(null, "parent-oidc")} />
        {saved && <div className="box-foot"><SetupParentTest />
          {tested === "ok" && <p role="status">Microsoft sent you back, so parent sign-in works. (There are no families yet, so the portal itself would still refuse that sign-in.)</p>}
          {tested === "failed" && <p role="alert" className="errors">The parent sign-in didn&apos;t complete. Check the redirect URI and that the app is added to the user flow.</p>}
        </div>}
      </section>
      <div className="stack">
        <form action={goToStepAction.bind(null, "admin")}><button className="btn">{saved ? "Next: first Admin" : "Do this later"}</button></form>
        <form action={goToStepAction.bind(null, "staff")}><button className="btn btn-line">Back to staff sign-in</button></form>
      </div>
    </>
  );
}

const ADMIN_ERRORS: Record<string, string> = {
  signin_failed: "The sign-in didn't complete. Check the staff sign-in values in Step 1, then try again.",
  no_session: "The sign-in didn't complete. Try again.",
  not_matched: "That sign-in worked, but it wasn't the Admin email entered above. Sign out, then sign in with that account.",
  other_email: "You signed in with a different account from the Admin email entered above. Sign out, then sign in with that account.",
  not_admin: "That account is a staff member but not an Admin. Sign in as an Admin.",
};

export function AdminStep({ adminEmail, byKey, error }: { adminEmail: string | null; byKey: ByKey; error?: string }) {
  return (
    <>
      <h2 className="page-title">Step 3: First Admin</h2>
      <p className="lede">Enter the email of the person who will be Admin, then sign in as them. When that works, setup closes and you&apos;re taken to the staff home.</p>
      <section className="box" aria-labelledby="a-h"><h2 id="a-h">Admin</h2>
        <AdminEmailForm initial={adminEmail ?? ""} action={saveAdminEmailAction} />
        {adminEmail && <div className="stack">
          {byKey["staff-microsoft"]?.readable && <SetupStaffSignIn provider="microsoft" label="Sign in with Microsoft" />}
          {byKey["staff-google"]?.readable && <SetupStaffSignIn provider="google" label="Sign in with Google" />}
        </div>}
        {error && ADMIN_ERRORS[error] && <><p role="alert" className="errors">{ADMIN_ERRORS[error]}</p><SetupStaffSignOut /></>}
      </section>
      <form action={goToStepAction.bind(null, "parent")}><button className="btn btn-line">Back to parent sign-in</button></form>
    </>
  );
}
```

`src/app/setup/admin-email-form.tsx`:

```tsx
"use client";
import { useActionState } from "react";

export function AdminEmailForm({ initial, action }: { initial: string; action: (prev: { error: string } | null, f: FormData) => Promise<{ error: string } | null> }) {
  const [state, run, pending] = useActionState(action, null);
  return (
    <form action={run} className="stack">
      <label className="field"><span>Admin email</span><input name="email" type="email" required defaultValue={initial} autoComplete="email" /></label>
      {state?.error && <p role="alert" className="errors">{state.error}</p>}
      <button className="btn btn-line" disabled={pending}>Save email</button>
    </form>
  );
}
```

`src/app/setup/page.tsx`:

```tsx
import { notFound } from "next/navigation";
import { env } from "@/env";
import { getSetupState, type SetupStep } from "@/lib/setup/state";
import { hasSetupSession } from "@/lib/setup/session";
import { providerSummaries, type ProviderKey, type ProviderSummary } from "@/lib/auth/providers";
import { UnlockForm } from "./unlock-form";
import { StaffStep, ParentStep, AdminStep } from "./steps";

export const metadata = { title: "Set up Boosters Rocket" };
export const dynamic = "force-dynamic";

const STEPS: { step: SetupStep; label: string }[] = [
  { step: "staff", label: "1. Staff sign-in" }, { step: "parent", label: "2. Parent sign-in" }, { step: "admin", label: "3. First Admin" },
];

export default async function SetupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const state = await getSetupState();
  if (state.status !== "open") notFound();
  if (!(await hasSetupSession())) {
    return (
      <main className="wrap signin">
        <h1 className="page-title">Set up Boosters Rocket</h1>
        <p className="lede">Enter the setup code from your server. <code>deploy.sh</code> prints it after a deploy, or run <code>scripts/poc/setup-code.sh</code> for a new one.</p>
        <UnlockForm />
      </main>
    );
  }
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const asked = one("step");
  const step: SetupStep = asked === "staff" || asked === "parent" || asked === "admin" ? asked : state.step;
  const byKey = Object.fromEntries((await providerSummaries()).map((s) => [s.key, s])) as Partial<Record<ProviderKey, ProviderSummary>>;
  const appUrl = env.APP_URL.replace(/\/+$/, "");
  return (
    <main className="wrap single">
      <h1 className="page-title">Set up Boosters Rocket</h1>
      <ol className="setup-progress">{STEPS.map((s) => <li key={s.step} aria-current={s.step === step ? "step" : undefined}>{s.label}</li>)}</ol>
      {step === "staff" && <StaffStep appUrl={appUrl} byKey={byKey} error={one("error")} />}
      {step === "parent" && <ParentStep appUrl={appUrl} byKey={byKey} tested={one("tested")} />}
      {step === "admin" && <AdminStep adminEmail={state.adminEmail} byKey={byKey} error={one("error")} />}
    </main>
  );
}
```

- [ ] **Step 6: The finish route and the script download**

`src/app/setup/finish/route.ts`:

```ts
import { NextResponse } from "next/server";
import { env } from "@/env";
import { getSetupState, finishSetup } from "@/lib/setup/state";
import { hasSetupSession, SETUP_COOKIE } from "@/lib/setup/session";
import { getStaffIdentity, hasStaffSession } from "@/lib/auth/identity";
import { effectivePermissions } from "@/lib/permissions/effective";
import { clientIpFrom } from "@/lib/request";

export const dynamic = "force-dynamic";

/** Step 3 returns here from the staff sign-in. Safe to visit again: it finishes setup once the right Admin is signed in. */
export async function GET(req: Request) {
  const to = (p: string) => NextResponse.redirect(new URL(p, env.APP_URL));
  const state = await getSetupState();
  if (state.status !== "open") return to("/staff");
  if (!(await hasSetupSession())) return to("/setup");
  if (!state.adminEmail) return to("/setup?step=admin");
  const id = await getStaffIdentity();
  if (!id) return to(`/setup?step=admin&error=${(await hasStaffSession()) ? "not_matched" : "no_session"}`);
  if (id.email !== state.adminEmail) return to("/setup?step=admin&error=other_email");
  if (!(await effectivePermissions(id.staffUserId)).isAdmin) return to("/setup?step=admin&error=not_admin");
  await finishSetup({ staffUserId: id.staffUserId, email: id.email, ip: clientIpFrom(req.headers) });
  const res = to("/staff");
  res.cookies.delete(SETUP_COOKIE);
  return res;
}
```

`src/app/setup/scripts/[name]/route.ts`:

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "@/env";
import { hasSetupSession } from "@/lib/setup/session";
import { getStaffIdentity } from "@/lib/auth/identity";
import { effectivePermissions, can } from "@/lib/permissions/effective";

export const dynamic = "force-dynamic";
const SCRIPTS = new Set(["New-BoosterRocketStaffApp.ps1", "New-BoosterRocketParentApp.ps1"]);

async function allowed(): Promise<boolean> {
  if (await hasSetupSession()) return true;
  const id = await getStaffIdentity();
  return id ? can(await effectivePermissions(id.staffUserId), "Settings.SignIn.ReadWrite") : false;
}

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  if (!SCRIPTS.has(name) || !(await allowed())) return new Response("Not found", { status: 404 });
  const text = (await readFile(path.join(process.cwd(), "scripts", "setup", name), "utf8"))
    .replaceAll("__BOOSTER_ROCKET_APP_URL__", env.APP_URL.replace(/\/+$/, ""));
  return new Response(text, { headers: {
    "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store",
  } });
}
```

`Settings.SignIn.ReadWrite` is added to the registry in Task 8. To keep this task compiling, add it now in
`src/lib/permissions/registry.ts`: append `"Settings.SignIn.ReadWrite",` to `PERMISSIONS` and add it to `ADMIN_ONLY`.
If a unit test under `tests/unit/permissions/` lists the permissions or the admin-only set exactly, update it.

`Dockerfile` run stage: after `COPY --from=tools /tools ./tools`, add `COPY scripts/setup ./scripts/setup`. Tools
stage: change the scripts line to
`COPY scripts/migrate.mjs scripts/seed-poc-guardian.mjs scripts/setup-code.mjs ./scripts/`.

`tests/integration/setup-scripts-route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const state = { setup: false };
vi.mock("@/lib/setup/session", () => ({ hasSetupSession: async () => state.setup, SETUP_COOKIE: "br_setup" }));
vi.mock("@/lib/auth/identity", () => ({ getStaffIdentity: async () => null, hasStaffSession: async () => false }));

import { GET } from "@/app/setup/scripts/[name]/route";
const call = (name: string) => GET(new Request("http://x"), { params: Promise.resolve({ name }) });

describe("setup script download", () => {
  beforeEach(() => { state.setup = false; });
  it("is not found without a setup session or the permission", async () => {
    expect((await call("New-BoosterRocketStaffApp.ps1")).status).toBe(404);
  });
  it("serves the script with the site address filled in", async () => {
    state.setup = true;
    const res = await call("New-BoosterRocketStaffApp.ps1");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("[string]$AppUrl = 'http://localhost:3000'");
    expect(text).not.toContain("__BOOSTER_ROCKET_APP_URL__");
  });
  it("serves nothing else", async () => {
    state.setup = true;
    expect((await call("..%2Fpackage.json")).status).toBe(404);
  });
});
```

The first test's expectation also depends on `__BOOSTER_ROCKET_APP_URL__` sitting in the `param` default exactly as
Task 6 wrote it.

- [ ] **Step 7: CI env for e2e**

In `.github/workflows/ci.yml`, the E2E step's env: add `SETUP_STATUS_CACHE_MS: "0"`.

- [ ] **Step 8: Run everything and watch it pass**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build && node scripts/check-client-bundle.mjs`
Expected: PASS. The bundle check needs the fake secret env from CI.

Run: `pnpm db:migrate && pnpm tsx scripts/seed-e2e.ts && pnpm e2e`
Expected: every e2e test passes, the existing ones included.

Then by hand, with `pnpm dev` against a fresh dev database:
- `/` goes to `/setup`;
- `node scripts/setup-code.mjs` prints a code that unlocks the page;
- the copy buttons copy;
- saving Microsoft values with a made-up secret shows the "Microsoft rejected the client secret" message;
- nothing is saved after that failure.

- [ ] **Step 9: Commit**

```bash
git add -A src tests scripts/seed-e2e.ts playwright.config.ts .github/workflows/ci.yml Dockerfile
git commit -m "feat(setup): the first-run setup page, with walk-throughs, checks and a real Admin sign-in"
```

---

### Task 8: Settings → Sign-in and the expiry warning

**Files:**
- Create: `src/app/staff/(app)/settings/sign-in/page.tsx`, `src/app/staff/(app)/settings/sign-in/actions.ts`,
  `src/app/staff/(app)/settings/sign-in/remove-button.tsx`, `src/app/staff/(app)/secret-expiry.tsx`,
  `src/app/staff/(app)/secret-expiry-rule.ts`
- Modify: `src/app/staff/(app)/layout.tsx`, `src/app/staff/(app)/page.tsx`
- Test: `tests/unit/secret-expiry.test.ts`

**Interfaces:**
- Consumes: `ProviderForm`, `toSummaryView`, `PROVIDER_LABELS` (Task 7); `saveProvider`, `removeProvider`,
  `parseProviderForm`, `providerSummaries` (Task 2); `checkFor` (Task 3); `staffAction`, `requireStaffPage`.
- Produces: `expiringSecrets(summaries: ProviderSummary[], now?: Date): { key: ProviderKey; expiresAt: Date | null; unreadable: boolean }[]`.

- [ ] **Step 1: Write the failing test**

`tests/unit/secret-expiry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { expiringSecrets } from "@/app/staff/(app)/secret-expiry-rule";

const now = new Date("2026-11-08T00:00:00Z");
const s = (key: "staff-microsoft" | "parent-oidc", expires: string | null, readable = true) =>
  ({ key, config: {}, secretUpdatedAt: now, secretExpiresAt: expires ? new Date(expires) : null, readable });

describe("expiringSecrets", () => {
  it("warns from 30 days before expiry, and after", () => {
    expect(expiringSecrets([s("staff-microsoft", "2026-12-09T00:00:00Z")], now)).toHaveLength(0);
    expect(expiringSecrets([s("staff-microsoft", "2026-12-07T00:00:00Z")], now)).toHaveLength(1);
    expect(expiringSecrets([s("staff-microsoft", "2026-11-01T00:00:00Z")], now)).toHaveLength(1);
  });
  it("ignores secrets with no expiry date, and always warns about unreadable ones", () => {
    expect(expiringSecrets([s("parent-oidc", null)], now)).toHaveLength(0);
    expect(expiringSecrets([s("parent-oidc", null, false)], now)).toEqual([{ key: "parent-oidc", expiresAt: null, unreadable: true }]);
  });
});
```

Run: `pnpm vitest run tests/unit/secret-expiry.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 2: Implement the rule**

`src/app/staff/(app)/secret-expiry-rule.ts` (database-free, so the unit test needs no database):

```ts
import type { ProviderKey, ProviderSummary } from "@/lib/auth/providers";

const WARN_MS = 30 * 24 * 60 * 60 * 1000;
export function expiringSecrets(summaries: ProviderSummary[], now = new Date()) {
  return summaries
    .filter((s) => !s.readable || (s.secretExpiresAt !== null && s.secretExpiresAt.getTime() - now.getTime() < WARN_MS))
    .map((s) => ({ key: s.key as ProviderKey, expiresAt: s.secretExpiresAt, unreadable: !s.readable }));
}
```

`src/app/staff/(app)/secret-expiry.tsx`:

```tsx
import { providerSummaries } from "@/lib/auth/providers";
import { PROVIDER_LABELS } from "@/app/components/sign-in-settings/labels";
import { LocalTime } from "@/app/components/local-time";
import { expiringSecrets } from "./secret-expiry-rule";

/** Shown to people who manage sign-in: secrets that expire within 30 days, or that can't be read. */
export async function SecretExpiryWarning() {
  const items = expiringSecrets(await providerSummaries());
  if (items.length === 0) return null;
  return (
    <section className="box" role="status" aria-labelledby="exp-h"><h2 id="exp-h">Sign-in needs attention</h2>
      <ul>{items.map((i) => (
        <li key={i.key}>{PROVIDER_LABELS[i.key]}: {i.unreadable
          ? "the saved secret can't be read with this server's encryption key. Enter it again."
          : <>the client secret expires <LocalTime iso={i.expiresAt!.toISOString()} />. Create a new one and save it.</>}</li>
      ))}</ul>
      <p className="box-foot"><a className="btn btn-line" href="/staff/settings/sign-in">Open sign-in settings</a></p>
    </section>
  );
}
```

In `src/app/staff/(app)/page.tsx`, import `can` and `SecretExpiryWarning`, and render
`{can(ctx.effective, "Settings.SignIn.ReadWrite") && <SecretExpiryWarning />}` as the first child of `<main>`, after
the `h1`.

- [ ] **Step 3: The Settings page**

`src/app/staff/(app)/settings/sign-in/actions.ts`:

```ts
"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { isProviderKey, parseProviderForm, saveProvider, removeProvider, type SaveOutcome } from "@/lib/auth/providers";
import { checkFor } from "@/lib/auth/provider-checks";

const FIELD_NAMES = ["tenantId", "clientId", "tenantSubdomain", "secret", "secretExpiresAt"] as const;
const P = "Settings.SignIn.ReadWrite" as const;

export const saveSignInProviderAction = staffAction(P, async (ctx, key: string, form: FormData): Promise<SaveOutcome> => {
  if (!isProviderKey(key)) return { ok: false, errors: ["Unknown sign-in."] };
  const parsed = parseProviderForm(key, Object.fromEntries(FIELD_NAMES.map((n) => [n, String(form.get(n) ?? "")])));
  if (!parsed.ok) return parsed;
  const r = await saveProvider(parsed.draft, { actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P, updatedBy: ctx.staffUserId, check: (d) => checkFor(d) });
  revalidatePath("/staff", "layout");
  return r;
});

export const removeSignInProviderAction = staffAction(P, async (ctx, key: string): Promise<SaveOutcome> => {
  if (!isProviderKey(key)) return { ok: false, errors: ["Unknown sign-in."] };
  const r = await removeProvider(key, { actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P });
  revalidatePath("/staff", "layout");
  return r;
});
```

`src/app/staff/(app)/settings/sign-in/remove-button.tsx`:

```tsx
"use client";
import { useActionState } from "react";
import { ACTION_FAILED, safely } from "@/app/components/action-error";
import type { SaveOutcome } from "@/lib/auth/provider-fields";

export function RemoveButton({ label, action }: { label: string; action: () => Promise<SaveOutcome> }) {
  const [state, run, pending] = useActionState(async () => safely(action, { ok: false as const, errors: [ACTION_FAILED] }), null);
  return (
    <form action={run} onSubmit={(e) => { if (!confirm(`Remove ${label}? People who sign in this way won't be able to until it's set up again.`)) e.preventDefault(); }}>
      {state && !state.ok && <ul role="alert" className="errors">{state.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      <button className="btn btn-line" disabled={pending}>Remove</button>
    </form>
  );
}
```

`src/app/staff/(app)/settings/sign-in/page.tsx`:

```tsx
import { requireStaffPage } from "@/lib/guards";
import { env } from "@/env";
import { providerSummaries, PROVIDER_KEYS } from "@/lib/auth/providers";
import { ProviderForm } from "@/app/components/sign-in-settings/provider-form";
import { PROVIDER_LABELS, toSummaryView } from "@/app/components/sign-in-settings/labels";
import { MicrosoftStaffSteps, GoogleStaffSteps, ParentSteps, ScriptOption } from "@/app/setup/instructions";
import { saveSignInProviderAction, removeSignInProviderAction } from "./actions";
import { RemoveButton } from "./remove-button";

export const metadata = { title: "Sign-in settings" };

export default async function SignInSettingsPage() {
  await requireStaffPage("Settings.SignIn.ReadWrite");
  const summaries = await providerSummaries();
  const appUrl = env.APP_URL.replace(/\/+$/, "");
  const steps = { "staff-microsoft": <MicrosoftStaffSteps appUrl={appUrl} />, "staff-google": <GoogleStaffSteps appUrl={appUrl} />, "parent-oidc": <ParentSteps appUrl={appUrl} /> };
  const scripts = { "staff-microsoft": "New-BoosterRocketStaffApp.ps1", "parent-oidc": "New-BoosterRocketParentApp.ps1" } as const;
  return (
    <main className="wrap single">
      <h1 className="page-title">Sign-in</h1>
      <p className="lede">How staff and parents sign in. Saved secrets are never shown again; to change one, enter a new one.</p>
      {PROVIDER_KEYS.map((key) => {
        const s = summaries.find((x) => x.key === key);
        return (
          <section key={key} className="box" aria-labelledby={`${key}-h`}><h2 id={`${key}-h`}>{PROVIDER_LABELS[key]}</h2>
            <details><summary>{s ? "How to make a new secret or change the app" : "How to set this up"}</summary>{steps[key]}</details>
            {key in scripts && <ScriptOption script={scripts[key as keyof typeof scripts]} example={`./${scripts[key as keyof typeof scripts]} -TenantId <tenant>`} />}
            <ProviderForm providerKey={key} summary={s ? toSummaryView(s) : null} action={saveSignInProviderAction.bind(null, key)} />
            {s && <RemoveButton label={PROVIDER_LABELS[key]} action={removeSignInProviderAction.bind(null, key)} />}
          </section>
        );
      })}
    </main>
  );
}
```

In `src/app/staff/(app)/layout.tsx` nav, after the Club entry, add
`...(can(e, "Settings.SignIn.ReadWrite") ? [{ href: "/staff/settings/sign-in", label: "Sign-in" }] : []),`.

- [ ] **Step 4: Run everything and watch it pass**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: PASS. The invariants test now covers `settings/sign-in/actions.ts` and finds both exports wrapped in
`staffAction` with a permission.

- [ ] **Step 5: Commit**

```bash
git add -A src tests
git commit -m "feat(settings): manage sign-in from Settings, and warn Admins before a secret expires"
```

---

### Task 9: Server scripts, deploy and runbook

**Files:**
- Create: `scripts/poc/setup-code.sh`, `scripts/poc/reopen-setup.sh`
- Modify: `scripts/poc/setup.sh`, `scripts/poc/deploy.sh`, `.env.poc.example`, `.github/workflows/ci.yml`
  (shellcheck list), `scripts/smoke-image.sh`, `tests/unit/deploy-script.test.ts`, `docs/runbooks/poc-linuxdev.md`
- Test: `tests/unit/deploy-script.test.ts`, `tests/unit/poc-scripts.test.ts`

**Interfaces:**
- Consumes: `tools/scripts/setup-code.mjs` in the image (Task 5 + Task 7 Dockerfile), the `migrate` compose service.

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/deploy-script.test.ts`. In the docker stub's `case`, insert above the
`*"run --rm migrate"*` line: `*"setup-code.mjs"*) echo "\${SETUP_CODE_OUT:-}"; exit \${SETUP_CODE_FAIL:-0};;`.

```ts
  it("prints a setup code after a healthy deploy while setup is open", () => {
    const r = run([], { SETUP_CODE_OUT: "Setup code: K7QM-2XPA-9RTE" });
    expect(r.status).toBe(0);
    const c = calls();
    expect(c.indexOf("setup-code.mjs --if-open")).toBeGreaterThan(c.indexOf("up -d --no-deps --force-recreate app"));
    expect(r.stdout).toContain("Setup code: K7QM-2XPA-9RTE");
  });

  it("still succeeds when the setup-code check fails, and says how to get a code", () => {
    const r = run([], { SETUP_CODE_FAIL: "1" });
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toContain("scripts/poc/setup-code.sh");
  });
```

`tests/unit/poc-scripts.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

let dir: string, bin: string, log: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "br-poc-"));
  bin = path.join(dir, "bin"); mkdirSync(bin);
  log = path.join(dir, "calls.log");
  mkdirSync(path.join(dir, "scripts", "poc"), { recursive: true });
  for (const f of ["setup.sh", "setup-code.sh", "reopen-setup.sh"]) copyFileSync(path.resolve("scripts/poc", f), path.join(dir, "scripts/poc", f));
  copyFileSync(path.resolve(".env.poc.example"), path.join(dir, ".env.poc.example"));
  const p = path.join(bin, "docker");
  writeFileSync(p, `#!/usr/bin/env bash\necho "docker $*" >> "${log.replace(/\\/g, "/")}"\nexit 0\n`);
  chmodSync(p, 0o755);
});
const run = (script: string, ...args: string[]) => spawnSync("bash", [path.join(dir, "scripts/poc", script), ...args], {
  encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, BR_DIR: dir },
});

describe("server setup scripts", () => {
  it("setup.sh generates SETTINGS_ENCRYPTION_KEY", () => {
    expect(run("setup.sh").status).toBe(0);
    const env = readFileSync(path.join(dir, ".env.poc"), "utf8");
    const key = /^SETTINGS_ENCRYPTION_KEY=(.+)$/m.exec(env)?.[1];
    expect(Buffer.from(key!, "base64")).toHaveLength(32);
  });

  it("setup.sh adds the key to an older .env.poc that lacks it, keeping everything else", () => {
    writeFileSync(path.join(dir, ".env.poc"), "APP_URL=https://x\nDB_PASSWORD=keepme\n"); chmodSync(path.join(dir, ".env.poc"), 0o600);
    expect(run("setup.sh").status).toBe(0);
    const env = readFileSync(path.join(dir, ".env.poc"), "utf8");
    expect(env).toContain("DB_PASSWORD=keepme");
    expect(env).toMatch(/^SETTINGS_ENCRYPTION_KEY=.+$/m);
  });

  it("setup-code.sh runs the code script in the app image; reopen-setup.sh passes --reopen", () => {
    writeFileSync(path.join(dir, ".env.poc"), "DB_PASSWORD=x\n"); chmodSync(path.join(dir, ".env.poc"), 0o600);
    expect(run("setup-code.sh").status).toBe(0);
    expect(run("reopen-setup.sh").status).toBe(0);
    const c = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(c).toContain("compose -f docker-compose.poc.yml --env-file .env.poc run --rm migrate node tools/scripts/setup-code.mjs\n");
    expect(c).toContain("run --rm migrate node tools/scripts/setup-code.mjs --reopen");
  });
});
```

Run: `pnpm vitest run tests/unit/deploy-script.test.ts tests/unit/poc-scripts.test.ts`
Expected: FAIL.

- [ ] **Step 2: Implement the scripts**

`scripts/poc/setup-code.sh`:

```bash
#!/usr/bin/env bash
# Prints a one-time setup code for the Boosters Rocket setup page (replaces any earlier code).
#   scripts/poc/setup-code.sh            while setup is open
#   scripts/poc/setup-code.sh --reopen   reopen setup first (use reopen-setup.sh)
set -euo pipefail
BR_DIR="${BR_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$BR_DIR"
exec docker compose -f docker-compose.poc.yml --env-file .env.poc run --rm migrate node tools/scripts/setup-code.mjs "$@"
```

`scripts/poc/reopen-setup.sh`:

```bash
#!/usr/bin/env bash
# Reopens the setup page when nobody can sign in (for example, an expired client secret).
# Stored sign-in values are kept; existing Admins stay Admins. Prints a fresh setup code.
set -euo pipefail
exec "$(cd "$(dirname "$0")" && pwd)/setup-code.sh" --reopen
```

Run `chmod +x` on both, and `git update-index --chmod=+x` for Windows checkouts.

`scripts/poc/setup.sh`:
- add `-e "s|^SETTINGS_ENCRYPTION_KEY=.*|SETTINGS_ENCRYPTION_KEY=$(openssl rand -base64 32)|"` to the `sed`;
- add `SETTINGS_ENCRYPTION_KEY` to the `for key in …` check;
- change the success message to `"Created .env.poc with fresh secrets."`;
- in the `else` branch (file exists), before the "left as is" message:

```bash
  if ! grep -Eq '^SETTINGS_ENCRYPTION_KEY=.+' .env.poc; then
    sed -i.bak '/^SETTINGS_ENCRYPTION_KEY=/d' .env.poc && rm -f .env.poc.bak
    printf 'SETTINGS_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)" >> .env.poc
    echo "Added SETTINGS_ENCRYPTION_KEY to .env.poc."
  fi
```

- replace the closing heredoc's last line with:

```
Then deploy with:  scripts/poc/deploy.sh
It prints a setup code at the end. Open the site, enter the code, and follow the setup page.
Back up .env.poc along with the database: SETTINGS_ENCRYPTION_KEY is needed to read the stored sign-in secrets.
```

`scripts/poc/deploy.sh`: after `recreate_app` in the deploy path (before `say "Deployed …"`):

```bash
if ! "${COMPOSE[@]}" run --rm migrate node tools/scripts/setup-code.mjs --if-open; then
  say "Couldn't check whether setup is finished. If it isn't, run scripts/poc/setup-code.sh for a setup code."
fi
```

`.env.poc.example`: replace everything after `DB_PASSWORD=` with:

```
SETTINGS_ENCRYPTION_KEY=

# Sign-in (staff Microsoft or Google, parent External ID) is set up in the app at /setup after the first deploy.
```

and change the header's second line to
`# setup.sh fills BETTER_AUTH_SECRET, DB_PASSWORD and SETTINGS_ENCRYPTION_KEY with fresh random values.`

`.github/workflows/ci.yml`: add `scripts/poc/setup-code.sh scripts/poc/reopen-setup.sh` to the shellcheck line.

`scripts/smoke-image.sh`: after the uid check, add

```bash
docker run --rm "$IMAGE" test -f tools/scripts/setup-code.mjs || fail "setup-code.mjs missing from the image"
docker run --rm "$IMAGE" test -f scripts/setup/New-BoosterRocketStaffApp.ps1 || fail "setup scripts missing from the image"
```

(use the script's existing failure helper; if it's named differently, use that name).

- [ ] **Step 3: The runbook**

In `docs/runbooks/poc-linuxdev.md`:
- **First-time setup:** `setup.sh` now also generates `SETTINGS_ENCRYPTION_KEY`, and `.env.poc` holds no Microsoft
  values. Add a line: back up `.env.poc` with the database.
- **Section 3 (staff app registration)** becomes "Open the site, enter the setup code `deploy.sh` printed, and follow
  Step 1 of the setup page (or run the PowerShell script it offers)". Keep the existing click path as a short "what
  the setup page asks for" reference, and delete the `.env.poc` instructions.
- **Section 4 (External ID):** keep part A (create the tenant in Azure; no script can). Parts B–E become "Step 2 of
  the setup page, or `New-BoosterRocketParentApp.ps1`, which also turns sign-up off". Keep D (Graph Explorer) as the
  manual fallback.
- **Checklist:** "Staff: sign in at `/staff/sign-in`" becomes "Finish setup at `/setup` (Step 3 signs you in as
  Admin)". Add `setup.code.issue`, `setup.unlock`, `setup.provider.save`, `setup.admin_email.save` and `setup.finish`
  to the audit entries to look for. `BOOTSTRAP_ADMIN_EMAIL` is gone; replace any mention of it.
- **Troubleshooting:** add rows for:
  - "Setup code doesn't work": wrong, slowed or void → run `scripts/poc/setup-code.sh`;
  - "Microsoft rejected the client secret": copy the Value, or wait up to 15 minutes;
  - "Nobody can sign in": `scripts/poc/reopen-setup.sh`;
  - "Sign-in shows not set up after changing `.env.poc`": the encryption key changed → re-enter the secrets
    through reopen;
  - "Step 3 says a different account": sign out of Microsoft, sign in as the Admin email.

Check every changed sentence against the spec. Use US English.

- [ ] **Step 4: Run everything and watch it pass**

Run: `pnpm test && shellcheck scripts/poc/*.sh scripts/check-image-secrets.sh scripts/smoke-image.sh && pnpm lint && pnpm typecheck`
Expected: PASS.

If Docker is available, also run: `docker build -t booster-rocket-app:ci . && bash scripts/smoke-image.sh booster-rocket-app:ci && bash scripts/check-image-secrets.sh`
Expected: `ok` lines and no failure.

- [ ] **Step 5: Commit**

```bash
git add -A scripts .env.poc.example .github/workflows/ci.yml tests docs/runbooks/poc-linuxdev.md
git commit -m "feat(ops): print the setup code on deploy, add reopen-setup, generate the encryption key"
```
