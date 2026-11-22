# Certificate Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Microsoft sign-in (staff and parents) uses an app-generated certificate instead of a client secret,
so it works in tenants that block secrets and no secret is ever pasted.

**Architecture:** A new `provider_certificate` table holds app-generated RSA keys (sealed with the existing
secret box) and their self-signed certificates, moving pending → active → retired. A signer builds Microsoft's
`private_key_jwt` assertion (PS256, `x5t#S256`). The checks, Better Auth's `microsoft` provider
(`clientAssertion`) and the generic OAuth parent provider (`tokenEndpointAuth: private_key_jwt`) all use it.
The setup and Settings pages offer the public certificate to download. The PowerShell scripts upload it to the
app instead of creating a secret. Google keeps its secret.

**Tech Stack:** Next.js 16.4.5, React 19, TypeScript strict, Drizzle + Postgres 16, Better Auth 1.7.18,
`jose` 6, `@peculiar/x509` 3 (new, MIT), Node 26 `node:crypto`, Vitest, Playwright, PowerShell 7.

**Spec:** `docs/superpowers/specs/2026-11-09-certificate-credentials-design.md`

## Global Constraints

- Microsoft sign-ins (`staff-microsoft`, `parent-oidc`) use **certificates only**. Google (`staff-google`) keeps
  its client secret, unchanged.
- Key: RSA 2048, generated on the server. Certificate: self-signed X.509, valid 2 years (730 days), subject
  `CN=Booster Rocket staff (<APP_URL host>)` or `CN=Boosters Rocket parents (<APP_URL host>)`.
- The private key is stored sealed with `secretBox()`, AAD `certificate:<id>`. It is never sent to the browser,
  logged, or audited. A retired certificate's key is set to null.
- Assertion header: `alg` `PS256`, `typ` `JWT`, `x5t#S256` = base64url SHA-256 of the certificate DER. Claims:
  `aud` = token endpoint, `iss` = `sub` = client ID, `jti` random UUID, `nbf` = `iat` = now, `exp` = now + 300 s.
- At most one `pending` and one `active` certificate per provider key.
- Audit actions: `certificate.create`, `certificate.activate`, `certificate.retire`, plus the existing
  `setup.provider.save` / `setup.provider.remove`. Audit rows carry thumbprints and dates only.
- Certificate file names: `booster-rocket-staff.cer` and `booster-rocket-parents.cer`, served as
  `application/pkix-cert` (DER).
- Script token: `__BOOSTER_ROCKET_CERTIFICATE__` appears exactly once per script, in
  `$CertificateBase64 = '__BOOSTER_ROCKET_CERTIFICATE__'`. The download route replaces it with base64 DER.
- US English. Times stored UTC; expiry shown with `CalendarDate`, instants with `LocalTime`.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. The admin clicks **Check and save** before uploading the certificate. They should see "Microsoft doesn't
   have this certificate on the app yet…", and the certificate should stay pending (Task 3 test "keeps the
   certificate pending when Microsoft rejects it").
2. Downloading the certificate twice, or downloading it and then the script. It should be the same
   certificate both times, not a new one each time (Task 2 test "returns the same pending certificate";
   Task 4 test "embeds the same certificate the .cer download serves").
3. Replacing a certificate in Settings must keep the old one signing in until the new one checks out (Task 3
   test "a pending replacement doesn't change what sign-in uses").
4. The encryption key changes and the active certificate's key can't be decrypted. That sign-in shows as not
   set up and nothing crashes (Task 3 test "skips a Microsoft provider whose key can't be decrypted").
5. An app that already has an unrelated certificate. The script must keep it (Task 4 script text test "sends
   existing keyCredentials back").

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/auth/certificate-crypto.ts` | Generate a key and self-signed certificate; compute thumbprints; convert PEM to DER. No database. |
| `src/lib/auth/client-assertion.ts` | Sign Microsoft's `private_key_jwt` assertion; Better Auth getter. No database. |
| `src/lib/auth/certificates.ts` | `provider_certificate` lifecycle: get-or-create pending, activate, retire, read with key. |
| `src/lib/auth/providers.ts` | Provider types, load, summaries, parse, save, remove (now certificate-aware). |
| `src/lib/auth/provider-checks.ts` | Token check with an assertion (Microsoft) or nothing (Google). |
| `src/lib/auth/staff-auth.ts`, `parent-auth.ts` | Wire assertions into Better Auth. |
| `src/lib/setup/download-access.ts` | Who may download a certificate or script, and as which audit actor. |
| `src/app/setup/certificates/[name]/route.ts` | Certificate download. |
| `src/app/setup/scripts/[name]/route.ts` | Script download, now embedding the certificate. |
| `src/app/components/sign-in-settings/*`, `src/app/setup/*`, Settings page | UI. |

---

### Task 1: Certificate generation and assertion signing

**Files:**
- Create: `src/lib/auth/certificate-crypto.ts`, `src/lib/auth/client-assertion.ts`
- Modify: `package.json`, `pnpm-lock.yaml` (add `@peculiar/x509`)
- Test: `tests/unit/certificate-crypto.test.ts`, `tests/unit/client-assertion.test.ts`

**Interfaces:**
- Produces (`certificate-crypto.ts`):
  - `type GeneratedCertificate = { certificatePem: string; privateKeyPem: string; thumbprintS256: string; thumbprintSha1: string; notAfter: Date }`
  - `generateCertificate(commonName: string, now?: Date): Promise<GeneratedCertificate>`
  - `certificateDer(certificatePem: string): Buffer`
  - `thumbprintsOf(der: Buffer): { thumbprintS256: string; thumbprintSha1: string }`
  - `CERTIFICATE_DAYS = 730`
- Produces (`client-assertion.ts`):
  - `type AssertionKey = { privateKeyPem: string; thumbprintS256: string }`
  - `type AssertionGetter = (ctx: { clientId: string; tokenEndpoint: string; grantType: string }) => Promise<string>`
  - `signEntraAssertion(o: AssertionKey & { clientId: string; tokenEndpoint: string; now?: number }): Promise<string>`
  - `createEntraAssertionGetter(o: AssertionKey & { clientId: string }): AssertionGetter`
  - `CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"`

- [ ] **Step 1: Add the dependency**

Run: `pnpm add @peculiar/x509@3.1.0`
Expected: `package.json` lists `"@peculiar/x509": "3.1.0"` (pin it exactly, as `jose` is pinned).

- [ ] **Step 2: Write the failing tests**

`tests/unit/certificate-crypto.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { X509Certificate, createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { generateCertificate, certificateDer, thumbprintsOf, CERTIFICATE_DAYS } from "@/lib/auth/certificate-crypto";

describe("generateCertificate", () => {
  it("makes a 2-year self-signed RSA 2048 certificate with matching thumbprints", async () => {
    const now = new Date("2026-11-09T12:00:00Z");
    const g = await generateCertificate("Booster Rocket staff (portaltest.example.org)", now);
    const x = new X509Certificate(g.certificatePem);
    expect(x.subject).toBe("CN=Booster Rocket staff (portaltest.example.org)");
    expect(x.issuer).toBe(x.subject);
    expect(x.publicKey.asymmetricKeyType).toBe("rsa");
    expect(x.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(g.notAfter.toISOString()).toBe(new Date(now.getTime() + CERTIFICATE_DAYS * 86_400_000).toISOString());
    const der = certificateDer(g.certificatePem);
    expect(g.thumbprintS256).toBe(createHash("sha256").update(der).digest("base64url"));
    expect(g.thumbprintSha1).toBe(createHash("sha1").update(der).digest("hex").toUpperCase());
    expect(thumbprintsOf(der)).toEqual({ thumbprintS256: g.thumbprintS256, thumbprintSha1: g.thumbprintSha1 });
    // The private key belongs to the certificate.
    const pub = createPublicKey(createPrivateKey(g.privateKeyPem)).export({ type: "spki", format: "der" });
    expect(Buffer.compare(pub, x.publicKey.export({ type: "spki", format: "der" }))).toBe(0);
    expect(g.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });

  it("makes a different key every time", async () => {
    const [a, b] = await Promise.all([generateCertificate("A"), generateCertificate("A")]);
    expect(a.thumbprintS256).not.toBe(b.thumbprintS256);
  });
});
```

`tests/unit/client-assertion.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { X509Certificate } from "node:crypto";
import { jwtVerify, decodeProtectedHeader } from "jose";
import { generateCertificate } from "@/lib/auth/certificate-crypto";
import { signEntraAssertion, createEntraAssertionGetter } from "@/lib/auth/client-assertion";

const TOKEN = "https://login.microsoftonline.com/0f8fad5b-d9cb-469f-a165-70867728950e/oauth2/v2.0/token";
const CLIENT = "11111111-2222-3333-4444-555555555555";

describe("Entra client assertion", () => {
  it("has the header and claims Microsoft requires, and verifies with the certificate", async () => {
    const g = await generateCertificate("test");
    const now = 1_800_000_000_000;
    const jwt = await signEntraAssertion({ privateKeyPem: g.privateKeyPem, thumbprintS256: g.thumbprintS256, clientId: CLIENT, tokenEndpoint: TOKEN, now });
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: "PS256", typ: "JWT", "x5t#S256": g.thumbprintS256 });
    const { payload } = await jwtVerify(jwt, new X509Certificate(g.certificatePem).publicKey, {
      algorithms: ["PS256"], audience: TOKEN, issuer: CLIENT, subject: CLIENT, currentDate: new Date(now + 1000),
    });
    expect(payload.nbf).toBe(now / 1000);
    expect(payload.iat).toBe(now / 1000);
    expect(payload.exp).toBe(now / 1000 + 300);
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("gives every assertion its own jti", async () => {
    const g = await generateCertificate("test");
    const get = createEntraAssertionGetter({ privateKeyPem: g.privateKeyPem, thumbprintS256: g.thumbprintS256, clientId: CLIENT });
    const [a, b] = await Promise.all([get({ clientId: CLIENT, tokenEndpoint: TOKEN, grantType: "authorization_code" }), get({ clientId: CLIENT, tokenEndpoint: TOKEN, grantType: "authorization_code" })]);
    const jti = (t: string) => JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString()).jti;
    expect(jti(a)).not.toBe(jti(b));
  });

  it("uses the token endpoint Better Auth passes as the audience", async () => {
    const g = await generateCertificate("test");
    const get = createEntraAssertionGetter({ privateKeyPem: g.privateKeyPem, thumbprintS256: g.thumbprintS256, clientId: CLIENT });
    const other = "https://fznparents.ciamlogin.com/0f8fad5b-d9cb-469f-a165-70867728950e/oauth2/v2.0/token";
    const jwt = await get({ clientId: CLIENT, tokenEndpoint: other, grantType: "refresh_token" });
    expect(JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()).aud).toBe(other);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm vitest run tests/unit/certificate-crypto.test.ts tests/unit/client-assertion.test.ts`
Expected: FAIL, because the modules are not found.

- [ ] **Step 4: Implement `src/lib/auth/certificate-crypto.ts`**

```ts
import { createHash, randomBytes, webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export const CERTIFICATE_DAYS = 730;
export type GeneratedCertificate = { certificatePem: string; privateKeyPem: string; thumbprintS256: string; thumbprintSha1: string; notAfter: Date };

const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", publicExponent: new Uint8Array([1, 0, 1]), modulusLength: 2048 } as const;

const pem = (label: string, der: ArrayBuffer | Buffer) =>
  `-----BEGIN ${label}-----\n${Buffer.from(der as ArrayBuffer).toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;

export function certificateDer(certificatePem: string): Buffer {
  return Buffer.from(certificatePem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, ""), "base64");
}

/** x5t#S256 (base64url SHA-256) for the assertion header; SHA-1 hex as the Entra admin center shows it. */
export function thumbprintsOf(der: Buffer): { thumbprintS256: string; thumbprintSha1: string } {
  return {
    thumbprintS256: createHash("sha256").update(der).digest("base64url"),
    thumbprintSha1: createHash("sha1").update(der).digest("hex").toUpperCase(),
  };
}

/** A new RSA 2048 key and a self-signed certificate for it, valid CERTIFICATE_DAYS from `now`. */
export async function generateCertificate(commonName: string, now = new Date()): Promise<GeneratedCertificate> {
  const keys = await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"]);
  const notAfter = new Date(now.getTime() + CERTIFICATE_DAYS * 86_400_000);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: `01${randomBytes(15).toString("hex")}`, // leading 01 keeps the serial positive
    name: `CN=${commonName.replace(/[,+="\\<>;]/g, " ")}`,
    notBefore: now,
    notAfter,
    signingAlgorithm: ALG,
    keys: keys as unknown as CryptoKeyPair,
    extensions: [new x509.BasicConstraintsExtension(false, undefined, true), new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true)],
  });
  const der = Buffer.from(cert.rawData);
  return {
    certificatePem: pem("CERTIFICATE", der),
    privateKeyPem: pem("PRIVATE KEY", await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)),
    notAfter,
    ...thumbprintsOf(der),
  };
}
```

If `@peculiar/x509` 3.x names any of these exports differently, check its `README` and type definitions under
`node_modules/@peculiar/x509` and match them. Keep every behavior the test checks.

- [ ] **Step 5: Implement `src/lib/auth/client-assertion.ts`**

```ts
import { createPrivateKey, randomUUID } from "node:crypto";
import { SignJWT } from "jose";

export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
export type AssertionKey = { privateKeyPem: string; thumbprintS256: string };
/** Structurally Better Auth's ClientAssertionGetter (which this app can't import directly under pnpm's strict layout). */
export type AssertionGetter = (ctx: { clientId: string; tokenEndpoint: string; grantType: string }) => Promise<string>;

const LIFETIME_SECONDS = 300;

/** Microsoft's certificate credential assertion (private_key_jwt): PS256, x5t#S256 header, 5-minute life. */
export async function signEntraAssertion(o: AssertionKey & { clientId: string; tokenEndpoint: string; now?: number }): Promise<string> {
  const now = Math.floor((o.now ?? Date.now()) / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "PS256", typ: "JWT", "x5t#S256": o.thumbprintS256 })
    .setIssuer(o.clientId)
    .setSubject(o.clientId)
    .setAudience(o.tokenEndpoint)
    .setJti(randomUUID())
    .setNotBefore(now)
    .setIssuedAt(now)
    .setExpirationTime(now + LIFETIME_SECONDS)
    .sign(createPrivateKey(o.privateKeyPem));
}

export function createEntraAssertionGetter(o: AssertionKey & { clientId: string }): AssertionGetter {
  return ({ tokenEndpoint }) => signEntraAssertion({ ...o, tokenEndpoint });
}
```

- [ ] **Step 6: Run the tests and watch them pass**

Run: `pnpm vitest run tests/unit/certificate-crypto.test.ts tests/unit/client-assertion.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/auth/certificate-crypto.ts src/lib/auth/client-assertion.ts tests/unit/certificate-crypto.test.ts tests/unit/client-assertion.test.ts
git commit -m "feat(auth): generate sign-in certificates and sign Microsoft client assertions"
```

---

### Task 2: Certificate storage and lifecycle

**Files:**
- Modify: `src/lib/db/schema.ts`, `tests/helpers/db.ts`
- Create: `src/lib/auth/certificates.ts`, a migration from `pnpm db:generate`
- Test: `tests/integration/certificates.test.ts`

**Interfaces:**
- Consumes: `generateCertificate`, `certificateDer` (Task 1); `secretBox`, `SecretBox`, `SecretBoxError`;
  `writeAudit`, `Actor`; `env.APP_URL`.
- Produces (`certificates.ts`):
  - `type CertificateProviderKey = "staff-microsoft" | "parent-oidc"`, `isCertificateProvider(key: ProviderKey): key is CertificateProviderKey`
  - `type CertificateRow = typeof providerCertificate.$inferSelect`
  - `type CertificateView = { id: string; thumbprintSha1: string; thumbprintS256: string; notAfter: Date; createdAt: Date }`
  - `toCertificateView(r: CertificateRow): CertificateView`
  - `certificateRows(key, tx?): Promise<{ pending: CertificateRow | null; active: CertificateRow | null }>`
  - `getOrCreatePendingCertificate(key, opts: { actor: Actor; ip: string | null; createdBy: string | null; permission?: string }): Promise<CertificateRow>`
  - `openCertificateKey(row: CertificateRow, box?: SecretBox): string | null`
  - `activatePendingCertificate(tx: Tx, key, opts: { actor; ip; permission? }): Promise<CertificateRow | null>`: activates a pending certificate if there is one, retires the old active one, and returns the newly active row, or null when nothing was pending.
  - `retireCertificates(tx: Tx, key, opts: { actor; ip; permission? }): Promise<void>`
  - `certificateFileName(key): "booster-rocket-staff.cer" | "booster-rocket-parents.cer"`, `certificateKeyForFile(name: string): CertificateProviderKey | null`
- Produces (test helper): `seedCertificate(key, status: "pending" | "active"): Promise<CertificateRow>` in `tests/helpers/db.ts`.

- [ ] **Step 1: Add the table and loosen the secret columns**

In `src/lib/db/schema.ts`:
- Make `authProvider.secretCiphertext` and `authProvider.secretKeyId` nullable by removing `.notNull()` and adding
  the comment `// null for Microsoft providers, which use a certificate`.
- Add `uniqueIndex` and `sql` to the drizzle imports if they're missing (`sql` comes from `drizzle-orm`).
- After `authProvider`, add:

```ts
/** App-generated certificates for Microsoft sign-in (staff Entra, parent External ID). The private key is sealed. */
export const providerCertificate = pgTable("provider_certificate", {
  id: uuid("id").primaryKey().defaultRandom(),
  providerKey: text("provider_key", { enum: ["staff-microsoft", "parent-oidc"] }).notNull(),
  status: text("status", { enum: ["pending", "active", "retired"] }).notNull(),
  certificatePem: text("certificate_pem").notNull(),
  thumbprintS256: text("thumbprint_s256").notNull(),
  thumbprintSha1: text("thumbprint_sha1").notNull(),
  notAfter: timestamp("not_after", { withTimezone: true }).notNull(),
  privateKeyCiphertext: text("private_key_ciphertext"),
  privateKeyKeyId: text("private_key_key_id"),
  createdAt: created(),
  createdBy: uuid("created_by"),
  activatedAt: timestamp("activated_at", { withTimezone: true }),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("provider_certificate_one_pending").on(t.providerKey).where(sql`status = 'pending'`),
  uniqueIndex("provider_certificate_one_active").on(t.providerKey).where(sql`status = 'active'`),
]);
```

Run: `pnpm db:generate`
Expected: a new `drizzle/0003_*.sql` that creates `provider_certificate` with both partial unique indexes and drops
`NOT NULL` on the two `auth_provider` columns. Keep the generated name.

In `tests/helpers/db.ts`, add `"provider_certificate"` to `TABLES`. Change `seedProvider` so that for
`staff-microsoft` and `parent-oidc` it inserts the provider row with null secret columns and calls
`seedCertificate(key, "active")`. Google is unchanged. Add:

```ts
import { providerCertificate } from "@/lib/db/schema";
import { generateCertificate } from "@/lib/auth/certificate-crypto";
import type { CertificateProviderKey } from "@/lib/auth/certificates";

export async function seedCertificate(key: CertificateProviderKey, status: "pending" | "active") {
  const g = await generateCertificate(`seed ${key}`);
  const id = crypto.randomUUID();
  const sealed = secretBox().seal(g.privateKeyPem, `certificate:${id}`);
  const [row] = await db.insert(providerCertificate).values({
    id, providerKey: key, status, certificatePem: g.certificatePem, thumbprintS256: g.thumbprintS256, thumbprintSha1: g.thumbprintSha1,
    notAfter: g.notAfter, privateKeyCiphertext: sealed.ciphertext, privateKeyKeyId: sealed.keyId, activatedAt: status === "active" ? new Date() : null,
  }).returning();
  invalidateProviders();
  return row!;
}
```

- [ ] **Step 2: Write the failing tests**

`tests/integration/certificates.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { X509Certificate } from "node:crypto";
import { db } from "@/lib/db/client";
import { providerCertificate, auditLog } from "@/lib/db/schema";
import {
  getOrCreatePendingCertificate, certificateRows, activatePendingCertificate, retireCertificates, openCertificateKey,
  certificateFileName, certificateKeyForFile,
} from "@/lib/auth/certificates";
import { resetDb } from "../helpers/db";

const actor = { door: "system" as const, id: null, label: "setup" };
const opts = { actor, ip: null, createdBy: null };

describe("provider certificates", () => {
  beforeEach(resetDb);

  it("creates a pending certificate named for the site, sealed, and audited without key material", async () => {
    const row = await getOrCreatePendingCertificate("staff-microsoft", opts);
    expect(row.status).toBe("pending");
    expect(new X509Certificate(row.certificatePem).subject).toBe("CN=Booster Rocket staff (localhost)");
    expect(row.privateKeyCiphertext).not.toContain("PRIVATE KEY");
    expect(openCertificateKey(row)).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    const audit = await db.select().from(auditLog);
    expect(audit.map((a) => a.action)).toEqual(["certificate.create"]);
    expect(audit[0]!.after).toMatchObject({ providerKey: "staff-microsoft", thumbprintSha1: row.thumbprintSha1 });
    expect(JSON.stringify(audit)).not.toContain("PRIVATE KEY");
  });

  it("returns the same pending certificate on a second call", async () => {
    const a = await getOrCreatePendingCertificate("parent-oidc", opts);
    const b = await getOrCreatePendingCertificate("parent-oidc", opts);
    expect(b.id).toBe(a.id);
    expect(await db.select().from(providerCertificate)).toHaveLength(1);
  });

  it("makes only one pending certificate under concurrent calls", async () => {
    const rows = await Promise.all(Array.from({ length: 5 }, () => getOrCreatePendingCertificate("staff-microsoft", opts)));
    expect(new Set(rows.map((r) => r.id)).size).toBe(1);
  });

  it("activates pending, retires the old active, and nulls the retired key", async () => {
    const first = await getOrCreatePendingCertificate("staff-microsoft", opts);
    await db.transaction((tx) => activatePendingCertificate(tx, "staff-microsoft", { actor, ip: null }));
    const second = await getOrCreatePendingCertificate("staff-microsoft", opts);
    const active = await db.transaction((tx) => activatePendingCertificate(tx, "staff-microsoft", { actor, ip: null }));
    expect(active!.id).toBe(second.id);
    const { pending, active: now } = await certificateRows("staff-microsoft");
    expect(pending).toBeNull();
    expect(now!.id).toBe(second.id);
    const [old] = (await db.select().from(providerCertificate)).filter((r) => r.id === first.id);
    expect(old).toMatchObject({ status: "retired", privateKeyCiphertext: null, privateKeyKeyId: null });
    expect(old!.retiredAt).not.toBeNull();
    const actions = (await db.select().from(auditLog)).map((a) => a.action);
    expect(actions).toEqual(["certificate.create", "certificate.activate", "certificate.create", "certificate.retire", "certificate.activate"]);
  });

  it("activate does nothing without a pending certificate", async () => {
    expect(await db.transaction((tx) => activatePendingCertificate(tx, "staff-microsoft", { actor, ip: null }))).toBeNull();
  });

  it("retireCertificates retires pending and active and nulls their keys", async () => {
    await getOrCreatePendingCertificate("parent-oidc", opts);
    await db.transaction((tx) => activatePendingCertificate(tx, "parent-oidc", { actor, ip: null }));
    await getOrCreatePendingCertificate("parent-oidc", opts);
    await db.transaction((tx) => retireCertificates(tx, "parent-oidc", { actor, ip: null }));
    const rows = await db.select().from(providerCertificate);
    expect(rows.every((r) => r.status === "retired" && r.privateKeyCiphertext === null)).toBe(true);
  });

  it("maps file names both ways and refuses anything else", () => {
    expect(certificateFileName("staff-microsoft")).toBe("booster-rocket-staff.cer");
    expect(certificateFileName("parent-oidc")).toBe("booster-rocket-parents.cer");
    expect(certificateKeyForFile("booster-rocket-parents.cer")).toBe("parent-oidc");
    expect(certificateKeyForFile("../x.cer")).toBeNull();
  });
});
```

The vitest env sets `APP_URL=http://localhost:3000`, so the host is `localhost`.

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm vitest run tests/integration/certificates.test.ts`
Expected: FAIL, because the module is not found.

- [ ] **Step 4: Implement `src/lib/auth/certificates.ts`**

```ts
import { and, eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { providerCertificate } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { secretBox, SecretBoxError, type SecretBox } from "@/lib/crypto/secret-box";
import { env } from "@/env";
import { generateCertificate } from "./certificate-crypto";
import type { ProviderKey } from "./provider-fields";

export type CertificateProviderKey = "staff-microsoft" | "parent-oidc";
export const isCertificateProvider = (key: ProviderKey): key is CertificateProviderKey => key === "staff-microsoft" || key === "parent-oidc";
export type CertificateRow = typeof providerCertificate.$inferSelect;
export type CertificateView = { id: string; thumbprintSha1: string; thumbprintS256: string; notAfter: Date; createdAt: Date };
export const toCertificateView = (r: CertificateRow): CertificateView =>
  ({ id: r.id, thumbprintSha1: r.thumbprintSha1, thumbprintS256: r.thumbprintS256, notAfter: r.notAfter, createdAt: r.createdAt });

const FILES: Record<CertificateProviderKey, "booster-rocket-staff.cer" | "booster-rocket-parents.cer"> = {
  "staff-microsoft": "booster-rocket-staff.cer", "parent-oidc": "booster-rocket-parents.cer",
};
export const certificateFileName = (key: CertificateProviderKey) => FILES[key];
export function certificateKeyForFile(name: string): CertificateProviderKey | null {
  return (Object.keys(FILES) as CertificateProviderKey[]).find((k) => FILES[k] === name) ?? null;
}

const LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('booster.provider_certificate'))`;
const aad = (id: string) => `certificate:${id}`;
const audience = (key: CertificateProviderKey) => (key === "staff-microsoft" ? "staff" : "parents");

export async function certificateRows(key: CertificateProviderKey, tx?: Tx) {
  const rows = await (tx ?? db).select().from(providerCertificate).where(eq(providerCertificate.providerKey, key));
  return { pending: rows.find((r) => r.status === "pending") ?? null, active: rows.find((r) => r.status === "active") ?? null };
}

/** The pending certificate for this sign-in, made (once) if there isn't one. Safe to call repeatedly and concurrently. */
export async function getOrCreatePendingCertificate(key: CertificateProviderKey, opts: {
  actor: Actor; ip: string | null; createdBy: string | null; permission?: string;
}): Promise<CertificateRow> {
  const existing = (await certificateRows(key)).pending;
  if (existing) return existing;
  // Key generation is slow, so it happens before taking the lock; a concurrent winner's row is returned instead.
  const g = await generateCertificate(`Boosters Rocket ${audience(key)} (${new URL(env.APP_URL).hostname})`);
  return db.transaction(async (tx) => {
    await tx.execute(LOCK);
    const raced = (await certificateRows(key, tx)).pending;
    if (raced) return raced;
    const id = crypto.randomUUID();
    const sealed = secretBox().seal(g.privateKeyPem, aad(id));
    const [row] = await tx.insert(providerCertificate).values({
      id, providerKey: key, status: "pending", certificatePem: g.certificatePem, thumbprintS256: g.thumbprintS256,
      thumbprintSha1: g.thumbprintSha1, notAfter: g.notAfter, privateKeyCiphertext: sealed.ciphertext, privateKeyKeyId: sealed.keyId,
      createdBy: opts.createdBy,
    }).returning();
    await writeAudit({ actor: opts.actor, action: "certificate.create", permission: opts.permission, targetType: "provider_certificate", targetId: id,
      after: { providerKey: key, thumbprintSha1: g.thumbprintSha1, notAfter: g.notAfter.toISOString() }, ip: opts.ip }, tx);
    return row!;
  });
}

/** The decrypted private key (PKCS#8 PEM), or null if it was retired or can't be decrypted with this server's key. */
export function openCertificateKey(row: CertificateRow, box: SecretBox = secretBox()): string | null {
  if (!row.privateKeyCiphertext || !row.privateKeyKeyId) return null;
  try {
    return box.open({ ciphertext: row.privateKeyCiphertext, keyId: row.privateKeyKeyId }, aad(row.id));
  } catch (e) {
    if (e instanceof SecretBoxError) return null;
    throw e;
  }
}

async function retire(tx: Tx, row: CertificateRow, opts: { actor: Actor; ip: string | null; permission?: string }) {
  await tx.update(providerCertificate).set({ status: "retired", retiredAt: new Date(), privateKeyCiphertext: null, privateKeyKeyId: null })
    .where(eq(providerCertificate.id, row.id));
  await writeAudit({ actor: opts.actor, action: "certificate.retire", permission: opts.permission, targetType: "provider_certificate", targetId: row.id,
    before: { status: row.status }, after: { providerKey: row.providerKey, thumbprintSha1: row.thumbprintSha1 }, ip: opts.ip }, tx);
}

/** Inside the provider save: the pending certificate becomes active and the previous active one is retired. */
export async function activatePendingCertificate(tx: Tx, key: CertificateProviderKey, opts: {
  actor: Actor; ip: string | null; permission?: string;
}): Promise<CertificateRow | null> {
  await tx.execute(LOCK);
  const { pending, active } = await certificateRows(key, tx);
  if (!pending) return null;
  if (active) await retire(tx, active, opts);
  const [row] = await tx.update(providerCertificate).set({ status: "active", activatedAt: new Date() })
    .where(and(eq(providerCertificate.id, pending.id), eq(providerCertificate.status, "pending"))).returning();
  await writeAudit({ actor: opts.actor, action: "certificate.activate", permission: opts.permission, targetType: "provider_certificate", targetId: pending.id,
    after: { providerKey: key, thumbprintSha1: pending.thumbprintSha1, notAfter: pending.notAfter.toISOString() }, ip: opts.ip }, tx);
  return row ?? null;
}

/** When a Microsoft sign-in is removed: its pending and active certificates are retired and their keys deleted. */
export async function retireCertificates(tx: Tx, key: CertificateProviderKey, opts: { actor: Actor; ip: string | null; permission?: string }) {
  await tx.execute(LOCK);
  const { pending, active } = await certificateRows(key, tx);
  for (const row of [pending, active]) if (row) await retire(tx, row, opts);
}
```

`activatePendingCertificate` retires the old active row before activating the new one, so the partial unique
index on `active` never sees two rows.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm vitest run tests/integration/certificates.test.ts tests/integration/schema.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS. The rest of the suite may now fail where tests seed Microsoft providers with secrets. Task 3 fixes
those, so run only these two files here.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/schema.ts drizzle src/lib/auth/certificates.ts tests/helpers/db.ts tests/integration/certificates.test.ts
git commit -m "feat(auth): store sign-in certificates with a pending, active and retired lifecycle"
```

---

### Task 3: Providers, checks and sign-in use certificates

**Files:**
- Modify: `src/lib/auth/providers.ts`, `src/lib/auth/provider-fields.ts`, `src/lib/auth/provider-checks.ts`,
  `src/lib/auth/staff-auth.ts`, `src/lib/auth/parent-auth.ts`, `src/lib/auth/parent-object-id.ts` (only if it reads
  `secret`), `src/app/setup/actions.ts`, `src/app/staff/(app)/settings/sign-in/actions.ts`
- Test: update `tests/integration/providers.test.ts`, `tests/unit/provider-checks.test.ts`,
  `tests/unit/provider-parse.test.ts`, `tests/integration/auth-rebuild.test.ts`, and any other test that seeds or
  saves a Microsoft provider with a secret

**Interfaces:**
- Consumes: Task 1 (`createEntraAssertionGetter`, `signEntraAssertion`, `CLIENT_ASSERTION_TYPE`, `AssertionKey`)
  and Task 2 (`certificateRows`, `activatePendingCertificate`, `retireCertificates`, `openCertificateKey`,
  `isCertificateProvider`, `toCertificateView`, `CertificateView`).
- Produces (`providers.ts`, replacing today's secret-only shapes):
  - `type LoadedProviders = { version; staffMicrosoft: LoadedCertificateProvider<"staff-microsoft"> | null; staffGoogle: LoadedSecretProvider<"staff-google"> | null; parent: LoadedCertificateProvider<"parent-oidc"> | null }`
  - `type LoadedCertificateProvider<K> = { key: K; config: ConfigFor[K]; assertion: AssertionKey; expiresAt: Date }`
  - `type LoadedSecretProvider<K> = { key: K; config: ConfigFor[K]; secret: string; expiresAt: Date | null }`
  - `type ProviderSummary = { key; config: Record<string,string>; credentialUpdatedAt: Date; expiresAt: Date | null; readable: boolean; certificate: CertificateView | null; pendingCertificate: CertificateView | null }`.
    Replaces `secretUpdatedAt`/`secretExpiresAt`. For Microsoft, `readable` means the active certificate's key decrypts.
  - `type ProviderDraft`: Google `{ key; config; secret: string | null; secretExpiresAt: Date | null }`; Microsoft `{ key; config }`.
  - `type CheckedDraft`: Google `{ key; config; secret: string }`; Microsoft `{ key; config; assertion: AssertionKey }`.
  - `saveProvider`, `removeProvider`, `parseProviderForm`, `loadProviders`, `providerSummaries`: same names and
    signatures as today.
- Produces (`provider-fields.ts`): `CERTIFICATE_PROVIDERS: readonly ProviderKey[] = ["staff-microsoft", "parent-oidc"]`
  and `usesCertificate(key: ProviderKey): boolean`, for client components.

- [ ] **Step 1: Write the failing tests**

Replace the Microsoft cases in `tests/unit/provider-checks.test.ts`. Keep the parent discovery, issuer-pinning,
redirect and endpoint-pinning cases, but pass an `AssertionKey` instead of a secret. Then add:

```ts
import { generateCertificate } from "@/lib/auth/certificate-crypto";
let key: { privateKeyPem: string; thumbprintS256: string };
beforeAll(async () => { const g = await generateCertificate("t"); key = { privateKeyPem: g.privateKeyPem, thumbprintS256: g.thumbprintS256 }; });

it("sends a client assertion and never a client secret", async () => {
  const f = vi.fn(async () => json(200, { access_token: "t" }));
  expect(await checkMicrosoft({ tenantId: T, clientId: C }, key, f)).toEqual({ ok: true });
  const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
  const body = Object.fromEntries(new URLSearchParams(String(init.body)));
  expect(body).toMatchObject({ grant_type: "client_credentials", client_id: C, scope: "https://graph.microsoft.com/.default",
    client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" });
  expect(body.client_secret).toBeUndefined();
  expect(JSON.parse(Buffer.from(body.client_assertion!.split(".")[1]!, "base64url").toString()).aud).toBe(url);
});

it.each([
  [700027, /doesn't have this certificate on the app yet/],
  [700024, /server's clock looks wrong/],
  [700016, /doesn't know that Application \(client\) ID/],
])("explains AADSTS%s", async (code, msg) => {
  const r = await checkMicrosoft({ tenantId: T, clientId: C }, key, async () => aad(code));
  expect(!r.ok && r.message).toMatch(msg);
});

it("signs the parent assertion for the discovered token endpoint", async () => {
  const f = vi.fn(async (url: string) => (url === discovery ? json(200, doc) : json(200, { access_token: "t" })));
  await checkParent(c, key, f);
  const init = f.mock.calls[1]![1] as RequestInit;
  const assertion = new URLSearchParams(String(init.body)).get("client_assertion")!;
  expect(JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString()).aud).toBe(doc.token_endpoint);
});
```

(Use the names the file already defines: `T`, `C`, `json`, `aad`, `c`, `discovery`, `doc`. Remove the
`7000215`/`7000222` cases.)

In `tests/unit/provider-parse.test.ts`:
- Microsoft and parent drafts no longer carry `secret` or `secretExpiresAt`. Update the expected drafts to
  `{ key, config }`.
- Delete the secret-related Microsoft cases ("cleans pasted secrets" stays, but for Google only, and "treats a
  blank secret…" becomes Google-only).
- Add: `parseProviderForm("staff-microsoft", { tenantId: T, clientId: C, secret: "ignored" })` gives a draft
  with no `secret` key.

In `tests/integration/providers.test.ts`, rewrite the Microsoft cases around certificates and keep the Google
ones on secrets. It must contain at least:

```ts
it("saves Microsoft with the pending certificate, activates it, and audits", async () => {
  const pending = await getOrCreatePendingCertificate("staff-microsoft", { actor, ip: null, createdBy: null });
  let used = "";
  const check: CheckFn = async (d) => { if ("assertion" in d) used = d.assertion.thumbprintS256; return { ok: true }; };
  expect(await saveProvider(msDraft(), { actor, ip: null, updatedBy: null, check })).toEqual({ ok: true });
  expect(used).toBe(pending.thumbprintS256);
  expect((await certificateRows("staff-microsoft")).active!.id).toBe(pending.id);
  const loaded = (await loadProviders()).staffMicrosoft!;
  expect(loaded.assertion.thumbprintS256).toBe(pending.thumbprintS256);
  expect(loaded.expiresAt.toISOString()).toBe(pending.notAfter.toISOString());
  const [row] = await db.select().from(authProvider);
  expect(row!.secretCiphertext).toBeNull();
  expect((await db.select().from(auditLog)).map((a) => a.action)).toEqual(["certificate.create", "certificate.activate", "setup.provider.save"]);
});

it("keeps the certificate pending when Microsoft rejects it", async () => {
  await getOrCreatePendingCertificate("staff-microsoft", { actor, ip: null, createdBy: null });
  const r = await saveProvider(msDraft(), { actor, ip: null, updatedBy: null, check: async () => ({ ok: false, message: "nope" }) });
  expect(r).toEqual({ ok: false, errors: ["nope"] });
  expect((await certificateRows("staff-microsoft")).pending).not.toBeNull();
  expect(await db.select().from(authProvider)).toHaveLength(0);
});

it("asks for the certificate before a first Microsoft save", async () => {
  const r = await saveProvider(msDraft(), { actor, ip: null, updatedBy: null, check: async () => ({ ok: true }) });
  expect(r).toEqual({ ok: false, errors: ["Download the certificate and add it to the app registration first."] });
});

it("a pending replacement doesn't change what sign-in uses", async () => {
  await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
  const before = (await loadProviders()).staffMicrosoft!.assertion.thumbprintS256;
  await getOrCreatePendingCertificate("staff-microsoft", { actor, ip: null, createdBy: null });
  invalidateProviders();
  expect((await loadProviders()).staffMicrosoft!.assertion.thumbprintS256).toBe(before);
});

it("re-saving only the IDs checks with the active certificate", async () => {
  await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
  const active = (await certificateRows("staff-microsoft")).active!;
  let used = "";
  await saveProvider(msDraft(), { actor, ip: null, updatedBy: null, check: async (d) => { if ("assertion" in d) used = d.assertion.thumbprintS256; return { ok: true }; } });
  expect(used).toBe(active.thumbprintS256);
});

it("skips a Microsoft provider whose key can't be decrypted", async () => {
  await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
  await db.update(providerCertificate).set({ privateKeyKeyId: "deadbeef" });
  invalidateProviders();
  expect((await loadProviders()).staffMicrosoft).toBeNull();
  expect((await providerSummaries()).find((s) => s.key === "staff-microsoft")!.readable).toBe(false);
});

it("removing a Microsoft provider retires its certificates", async () => {
  await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
  await seedProvider("staff-google", { clientId: "x.apps.googleusercontent.com" });
  expect(await removeProvider("staff-microsoft", { actor, ip: null })).toEqual({ ok: true });
  expect((await db.select().from(providerCertificate)).every((r) => r.status === "retired" && r.privateKeyCiphertext === null)).toBe(true);
});

it("summaries show certificate thumbprints and never key material", async () => {
  await seedProvider("staff-microsoft", { tenantId: T, clientId: C });
  const pending = await getOrCreatePendingCertificate("staff-microsoft", { actor, ip: null, createdBy: null });
  const s = (await providerSummaries()).find((x) => x.key === "staff-microsoft")!;
  expect(s.certificate).not.toBeNull();
  expect(s.pendingCertificate!.thumbprintSha1).toBe(pending.thumbprintSha1);
  expect(s.expiresAt!.toISOString()).toBe(s.certificate!.notAfter.toISOString());
  expect(JSON.stringify(s)).not.toContain("PRIVATE KEY");
});
```

`msDraft()` is a local helper: `parseProviderForm("staff-microsoft", { tenantId: T, clientId: C })` unwrapped.

In `tests/integration/auth-rebuild.test.ts`, change the Microsoft assertion to
`expect(second.options.socialProviders).toMatchObject({ microsoft: { clientId: C, tenantId: T } })`. Then add:

```ts
expect(typeof (second.options.socialProviders as { microsoft: { clientAssertion?: unknown } }).microsoft.clientAssertion).toBe("function");
expect((second.options.socialProviders as { microsoft: { clientSecret?: unknown } }).microsoft.clientSecret).toBeUndefined();
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/unit/provider-checks.test.ts tests/unit/provider-parse.test.ts tests/integration/providers.test.ts tests/integration/auth-rebuild.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the providers module**

In `src/lib/auth/provider-fields.ts` add:

```ts
export const CERTIFICATE_PROVIDERS: readonly ProviderKey[] = ["staff-microsoft", "parent-oidc"];
export const usesCertificate = (key: ProviderKey) => CERTIFICATE_PROVIDERS.includes(key);
```

Then make these changes in `src/lib/auth/providers.ts`. The parsing helpers (`tenantId`, `clientGuid`,
`googleClientId`, `tenantSubdomain`, `cleanSecret`, `secret`, `expiry`, `SCHEMAS`), the discovery URL and the
globalThis cache stay as they are.

1. **Types.**

```ts
import type { AssertionKey } from "./client-assertion";
import { certificateRows, activatePendingCertificate, retireCertificates, openCertificateKey, isCertificateProvider, toCertificateView,
  type CertificateView, type CertificateProviderKey } from "./certificates";

export type LoadedCertificateProvider<K extends CertificateProviderKey> = { key: K; config: ConfigFor[K]; assertion: AssertionKey; expiresAt: Date };
export type LoadedSecretProvider<K extends ProviderKey> = { key: K; config: ConfigFor[K]; secret: string; expiresAt: Date | null };
export type LoadedProviders = {
  version: number;
  staffMicrosoft: LoadedCertificateProvider<"staff-microsoft"> | null;
  staffGoogle: LoadedSecretProvider<"staff-google"> | null;
  parent: LoadedCertificateProvider<"parent-oidc"> | null;
};
export type ProviderSummary = {
  key: ProviderKey; config: Record<string, string>; credentialUpdatedAt: Date; expiresAt: Date | null; readable: boolean;
  certificate: CertificateView | null; pendingCertificate: CertificateView | null;
};
export type ProviderDraft =
  | { key: "staff-google"; config: GoogleConfig; secret: string | null; secretExpiresAt: Date | null }
  | { key: "staff-microsoft"; config: MicrosoftConfig }
  | { key: "parent-oidc"; config: ParentConfig };
export type CheckedDraft =
  | { key: "staff-google"; config: GoogleConfig; secret: string }
  | { key: "staff-microsoft"; config: MicrosoftConfig; assertion: AssertionKey }
  | { key: "parent-oidc"; config: ParentConfig; assertion: AssertionKey };
```

2. **`readProviders`.** Google keeps today's logic (`openRow`, now null-safe when the columns are null). For each
   Microsoft row, read `certificateRows(key).active`. If it's missing or `openCertificateKey` returns null,
   log `[sign-in] The certificate for <key> is missing or can't be decrypted; treating it as not set up.` and
   skip the row. Otherwise build
   `{ key, config, assertion: { privateKeyPem, thumbprintS256: active.thumbprintS256 }, expiresAt: active.notAfter }`.

3. **`providerSummaries`.** For Google, `credentialUpdatedAt` = `secretUpdatedAt` and `expiresAt` =
   `secretExpiresAt`, with `readable` as today and both certificate fields null. For Microsoft,
   `certificate` = active view, `pendingCertificate` = pending view, `expiresAt` = `active?.notAfter ?? null`,
   `credentialUpdatedAt` = `active?.activatedAt ?? row.updatedAt`, and `readable` =
   `active !== null && openCertificateKey(active) !== null`.

4. **`parseProviderForm`.** For Google it is unchanged and returns `secret`/`secretExpiresAt`. For Microsoft keys
   it parses only the config schema and returns `{ key, config }`. Any `secret`/`secretExpiresAt` fields sent
   are ignored.

5. **`saveProvider`.** Google keeps today's path exactly. For Microsoft:

```ts
  if (isCertificateProvider(draft.key)) {
    const { pending, active } = await certificateRows(draft.key);
    const candidate = pending ?? active;
    if (!candidate) return { ok: false, errors: ["Download the certificate and add it to the app registration first."] };
    const privateKeyPem = openCertificateKey(candidate, box);
    if (!privateKeyPem) return { ok: false, errors: ["This server can't read the certificate's key any more. Create a new certificate and upload it."] };
    const checked = await opts.check({ ...draft, assertion: { privateKeyPem, thumbprintS256: candidate.thumbprintS256 } } as CheckedDraft);
    if (!checked.ok) return { ok: false, errors: [checked.message] };
    const r = await db.transaction(async (tx): Promise<SaveOutcome> => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('booster.auth_provider'))`);
      const existing = await existingRow(tx);
      const activated = candidate.status === "pending"
        ? await activatePendingCertificate(tx, draft.key as CertificateProviderKey, { actor: opts.actor, ip: opts.ip, permission: opts.permission })
        : null;
      const now = new Date();
      const values = { key: draft.key, config: draft.config, secretCiphertext: null, secretKeyId: null, secretExpiresAt: null,
        secretUpdatedAt: now, updatedAt: now, updatedBy: opts.updatedBy };
      await tx.insert(authProvider).values(values).onConflictDoUpdate({ target: authProvider.key, set: values });
      await writeAudit({ actor: opts.actor, action: "setup.provider.save", permission: opts.permission, targetType: "auth_provider", targetId: draft.key,
        before: existing ? existing.config : null,
        after: { ...draft.config, certificateThumbprintSha1: candidate.thumbprintSha1, certificateNotAfter: candidate.notAfter.toISOString(), certificateChanged: activated !== null },
        ip: opts.ip }, tx);
      return { ok: true };
    });
    if (r.ok) invalidateProviders();
    return r;
  }
```

6. **`removeProvider`.**
   - The "another readable staff sign-in" test treats a Microsoft row as readable when its active certificate
     decrypts. Google uses `openRow`.
   - When removing a Microsoft key, call `retireCertificates(tx, key, …)` in the same transaction, before the
     delete.

7. **`openRow`.** Return null when `secretCiphertext` or `secretKeyId` is null.

- [ ] **Step 4: Checks with assertions**

In `src/lib/auth/provider-checks.ts`:
- `clientCredentials(tokenUrl, clientId, credential: { secret: string } | { assertion: AssertionKey }, f)`. With an
  assertion, the body carries `client_assertion_type: CLIENT_ASSERTION_TYPE` and
  `client_assertion: await signEntraAssertion({ ...credential.assertion, clientId, tokenEndpoint: tokenUrl })` and
  has no `client_secret`. Keep the timeout, `redirect: "error"` and the 5xx and unknown-code handling.
- `checkMicrosoft(c, assertion: AssertionKey, f?)` and `checkParent(c, assertion: AssertionKey, f?)`. Keep
  `isTrustedTokenEndpoint` and change its refusal text to "…point somewhere unexpected, so nothing was sent…".
- `AADSTS` map: remove `7000215` and `7000222`. Add:
  - `700027`: "Microsoft doesn't have this certificate on the app yet. Upload it (or run the script), wait a minute, and try again."
  - `700024`: "The server's clock looks wrong, so Microsoft refused the certificate. Check the server's time."
- `checkFor` routes Microsoft drafts with `draft.assertion` and Google to `checkGoogle()`.

- [ ] **Step 5: Sign-in wiring**

`src/lib/auth/staff-auth.ts`, in `socialProviders`:

```ts
      ...(p.staffMicrosoft ? { microsoft: {
        clientId: p.staffMicrosoft.config.clientId,
        tenantId: p.staffMicrosoft.config.tenantId, // single-tenant: only the club's own directory
        // Certificate credential (private_key_jwt); there is no client secret.
        clientAssertion: createEntraAssertionGetter({ ...p.staffMicrosoft.assertion, clientId: p.staffMicrosoft.config.clientId }),
      } } : {}),
```

`src/lib/auth/parent-auth.ts`, in the generic OAuth config, replace `clientSecret` with:

```ts
        tokenEndpointAuth: { method: "private_key_jwt", getClientAssertion: createEntraAssertionGetter({ ...p.parent.assertion, clientId: p.parent.config.clientId }) },
```

Before trusting this, read `node_modules/.pnpm/better-auth@1.7.18*/node_modules/@better-auth/core/dist/social-providers/microsoft-entra-id.mjs`
and `.../better-auth/dist/plugins/generic-oauth/index.mjs`. Confirm that each one:
- uses the assertion for both the code exchange and the refresh;
- passes the real token endpoint in the getter's context;
- doesn't require `clientSecret`.

If one of these needs something different, say so in the report and adapt the wiring, not the assertion format.
If a TypeScript type mismatch appears because `AssertionGetter` isn't Better Auth's exact type, cast at the call
site: `as never` is not acceptable. Use `as Parameters<typeof genericOAuth>[0]["config"][number]["tokenEndpointAuth"]`,
or the equivalent for `microsoft`.

Update `src/app/setup/actions.ts` and `src/app/staff/(app)/settings/sign-in/actions.ts`. Microsoft forms no longer
send `secret` or `secretExpiresAt`. Leave `FIELD_NAMES` as is, since the parser ignores them for Microsoft.

- [ ] **Step 6: Run everything and watch it pass**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS. Fix every other test that seeded or saved a Microsoft provider with a secret, for example
`setup-finish.test.ts`, `signin-audit.test.ts` and `parent-auth-hooks.test.ts`. `seedProvider` now gives
Microsoft keys a certificate, so most tests only need the `secret` argument removed. `providerSummaries`
consumers renamed in this task (`secretExpiresAt` becomes `expiresAt`, `secretUpdatedAt` becomes
`credentialUpdatedAt`) include `src/app/components/sign-in-settings/labels.ts`, `provider-form.tsx` and
`src/app/staff/(app)/secret-expiry-rule.ts`. Rename the fields there now so typecheck passes; Task 5 changes the UI.

- [ ] **Step 7: Commit**

```bash
git add -A src tests
git commit -m "feat(auth): Microsoft sign-in and checks use the active certificate instead of a secret"
```

---

### Task 4: Certificate download, scripts that upload it

**Files:**
- Create: `src/lib/setup/download-access.ts`, `src/app/setup/certificates/[name]/route.ts`
- Modify: `src/app/setup/scripts/[name]/route.ts`, `scripts/setup/New-BoosterRocketStaffApp.ps1`,
  `scripts/setup/New-BoosterRocketParentApp.ps1`
- Test: `tests/integration/setup-certificates-route.test.ts`, update `tests/integration/setup-scripts-route.test.ts`
  and `tests/unit/setup-scripts.test.ts`

**Interfaces:**
- Consumes: `getOrCreatePendingCertificate`, `certificateRows`, `certificateDer`, `certificateFileName`,
  `certificateKeyForFile` (Tasks 1–2).
- Produces:
  - `downloadAccess(): Promise<{ actor: Actor; createdBy: string | null; permission?: string } | null>` in `src/lib/setup/download-access.ts`
  - `certificateForDownload(key, access): Promise<CertificateRow>`: the pending certificate if one exists, else the active one, else a new pending one
  - Routes `GET /setup/certificates/booster-rocket-staff.cer` and `/setup/certificates/booster-rocket-parents.cer`

- [ ] **Step 1: Write the failing tests**

`tests/integration/setup-certificates-route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { X509Certificate } from "node:crypto";
import { resetDb, seedCertificate } from "../helpers/db";

const state = { setup: false };
vi.mock("@/lib/setup/session", () => ({ hasSetupSession: async () => state.setup, SETUP_COOKIE: "br_setup" }));
vi.mock("@/lib/auth/identity", () => ({ getStaffIdentity: async () => null, hasStaffSession: async () => false }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { GET } from "@/app/setup/certificates/[name]/route";
const call = (name: string) => GET(new Request("http://x"), { params: Promise.resolve({ name }) });

describe("certificate download", () => {
  beforeEach(async () => { await resetDb(); state.setup = false; });

  it("is not found without a setup session or the permission", async () => {
    expect((await call("booster-rocket-staff.cer")).status).toBe(404);
  });

  it("serves a DER certificate, the same one on every download", async () => {
    state.setup = true;
    const a = await call("booster-rocket-staff.cer");
    expect(a.status).toBe(200);
    expect(a.headers.get("content-type")).toBe("application/pkix-cert");
    expect(a.headers.get("content-disposition")).toBe('attachment; filename="booster-rocket-staff.cer"');
    const der = Buffer.from(await a.arrayBuffer());
    expect(new X509Certificate(der).subject).toMatch(/^CN=Booster Rocket staff/);
    const b = Buffer.from(await (await call("booster-rocket-staff.cer")).arrayBuffer());
    expect(Buffer.compare(der, b)).toBe(0);
  });

  it("serves the active certificate when nothing is pending", async () => {
    state.setup = true;
    const active = await seedCertificate("parent-oidc", "active");
    const der = Buffer.from(await (await call("booster-rocket-parents.cer")).arrayBuffer());
    expect(new X509Certificate(der).fingerprint256.replaceAll(":", "")).toBe(
      Buffer.from(active.thumbprintS256, "base64url").toString("hex").toUpperCase());
  });

  it("refuses any other name", async () => {
    state.setup = true;
    expect((await call("..%2Fpackage.json")).status).toBe(404);
    expect((await call("booster-rocket-google.cer")).status).toBe(404);
  });
});
```

In `tests/integration/setup-scripts-route.test.ts`, keep the existing cases (add `resetDb` in `beforeEach`) and add:

```ts
it("embeds the same certificate the .cer download serves", async () => {
  state.setup = true;
  const text = await (await call("New-BoosterRocketStaffApp.ps1")).text();
  const embedded = /\$CertificateBase64 = '([A-Za-z0-9+/=]+)'/.exec(text)![1]!;
  const { GET: cert } = await import("@/app/setup/certificates/[name]/route");
  const der = Buffer.from(await (await cert(new Request("http://x"), { params: Promise.resolve({ name: "booster-rocket-staff.cer" }) })).arrayBuffer());
  expect(embedded).toBe(der.toString("base64"));
  expect(text).not.toContain("__BOOSTER_ROCKET_CERTIFICATE__");
});
```

In `tests/unit/setup-scripts.test.ts`, replace the secret expectations:

```ts
it.each([["staff", staff], ["parent", parent]])("%s script uploads the certificate and never makes a secret", (_, s) => {
  expect(s).not.toMatch(/addPassword|secretText|passwordCredential/);
  expect(s.split("__BOOSTER_ROCKET_CERTIFICATE__")).toHaveLength(2);
  expect(s).toContain("$CertificateBase64 = '__BOOSTER_ROCKET_CERTIFICATE__'");
  expect(s).toContain("$select=keyCredentials");
  expect(s).toContain("AsymmetricX509Cert");
});
it.each([["staff", staff], ["parent", parent]])("%s script sends existing keyCredentials back", (_, s) => {
  expect(s).toMatch(/\$existing[\s\S]*keyCredentials = @\(/);
  expect(s).toMatch(/didn't return this app's existing certificates/);
});
```

Keep the existing device-code, `-ContextScope`, `finally`, redirect URI, sign-up and token-once tests.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm vitest run tests/integration/setup-certificates-route.test.ts tests/integration/setup-scripts-route.test.ts tests/unit/setup-scripts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement access and the routes**

`src/lib/setup/download-access.ts`:

```ts
import "server-only";
import { hasSetupSession } from "./session";
import { getStaffIdentity } from "@/lib/auth/identity";
import { effectivePermissions, can } from "@/lib/permissions/effective";
import { certificateRows, getOrCreatePendingCertificate, type CertificateProviderKey, type CertificateRow } from "@/lib/auth/certificates";
import { requestIp } from "@/lib/request";
import type { Actor } from "@/lib/audit/log";

export type DownloadAccess = { actor: Actor; createdBy: string | null; permission?: string; ip: string | null };

/** Setup (unlocked) or an Admin with Settings.SignIn.ReadWrite may download certificates and scripts. */
export async function downloadAccess(): Promise<DownloadAccess | null> {
  const ip = await requestIp();
  if (await hasSetupSession()) return { actor: { door: "system", id: null, label: "setup" }, createdBy: null, ip };
  const id = await getStaffIdentity();
  if (!id || !can(await effectivePermissions(id.staffUserId), "Settings.SignIn.ReadWrite")) return null;
  return { actor: { door: "staff", id: id.staffUserId, label: id.email }, createdBy: id.staffUserId, permission: "Settings.SignIn.ReadWrite", ip };
}

/** The certificate to put on the app: pending if a replacement is under way, else active, else a new pending one. */
export async function certificateForDownload(key: CertificateProviderKey, a: DownloadAccess): Promise<CertificateRow> {
  const { pending, active } = await certificateRows(key);
  return pending ?? active ?? getOrCreatePendingCertificate(key, { actor: a.actor, ip: a.ip, createdBy: a.createdBy, permission: a.permission });
}
```

`src/app/setup/certificates/[name]/route.ts`:

```ts
import { certificateKeyForFile } from "@/lib/auth/certificates";
import { certificateDer } from "@/lib/auth/certificate-crypto";
import { downloadAccess, certificateForDownload } from "@/lib/setup/download-access";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const key = certificateKeyForFile(name);
  const access = key ? await downloadAccess() : null;
  if (!key || !access) return new Response("Not found", { status: 404 });
  const der = certificateDer((await certificateForDownload(key, access)).certificatePem);
  return new Response(new Uint8Array(der), { headers: {
    "content-type": "application/pkix-cert", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store",
  } });
}
```

`src/app/setup/scripts/[name]/route.ts`:
- Replace `allowed()` with `downloadAccess()`.
- Map `New-BoosterRocketStaffApp.ps1` to `staff-microsoft` and `New-BoosterRocketParentApp.ps1` to `parent-oidc`.
- After the URL replacement, also replace `__BOOSTER_ROCKET_CERTIFICATE__` with
  `certificateDer((await certificateForDownload(key, access)).certificatePem).toString("base64")`.

- [ ] **Step 4: Update the PowerShell scripts**

In both scripts, add after the `$AppUrl` parameter guard:

```powershell
$CertificateBase64 = '__BOOSTER_ROCKET_CERTIFICATE__'
if ($CertificateBase64 -notmatch '^[A-Za-z0-9+/]{200,}={0,2}$') { throw 'Download this script from the Boosters Rocket setup page; it carries the certificate to add to the app.' }
$Certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new([Convert]::FromBase64String($CertificateBase64))
```

Update `.DESCRIPTION`: the last step now reads "adds Boosters Rocket's certificate (made by your Boosters Rocket
server; only its public half is in this script)". Remove every mention of a client secret.

Replace each script's `addPassword` block (staff lines 72–74, parent lines 98–100) with the following. Use
`Invoke-MgGraphRequest` in the staff script and `Send-Graph` in the parent script, matching the existing style:

```powershell
  $existing = @((Invoke-MgGraphRequest GET "v1.0/applications/$($app.id)?`$select=keyCredentials").keyCredentials)
  $hash = [Convert]::ToBase64String($Certificate.GetCertHash())
  if ($existing | Where-Object { $_.customKeyIdentifier -eq $hash }) {
    Write-Host 'The Boosters Rocket certificate is already on the app.'
  } else {
    if ($existing | Where-Object { -not $_.key }) {
      throw "Microsoft didn't return this app's existing certificates, so the script stopped rather than risk removing them. Upload the .cer from the setup page by hand: Certificates & secrets > Certificates > Upload certificate."
    }
    $keys = @($existing | ForEach-Object { @{ type = $_.type; usage = $_.usage; key = $_.key; displayName = $_.displayName } })
    $keys += @{ type = 'AsymmetricX509Cert'; usage = 'Verify'; key = $CertificateBase64; displayName = "Booster Rocket $(Get-Date -Format 'yyyy-MM-dd')" }
    Invoke-MgGraphRequest PATCH "v1.0/applications/$($app.id)" -Body (@{ keyCredentials = $keys } | ConvertTo-Json -Depth 5) -ContentType 'application/json' | Out-Null
    Write-Host 'Added the Boosters Rocket certificate to the app. Certificates already on it were kept.'
  }
```

Replace the printed values. Staff:

```powershell
  Write-Host ''
  Write-Host 'Enter these on the Boosters Rocket setup page. There is no secret to copy.'
  Write-Host "  Tenant ID:            $tenant"
  Write-Host "  Client ID:            $($app.appId)"
  Write-Host "  Certificate:          $($Certificate.Thumbprint) (expires $($Certificate.NotAfter.ToUniversalTime().ToString('yyyy-MM-dd')))"
  Write-Host 'A new certificate can take a minute to start working. If the setup page says Microsoft does not have it yet, wait and try again.'
```

Parent: the same, plus `Tenant subdomain: $subdomain` first. Delete the `$end` variable.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `pnpm vitest run tests/integration/setup-certificates-route.test.ts tests/integration/setup-scripts-route.test.ts tests/unit/setup-scripts.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS. If `pwsh` is installed, also run
`pwsh -NoProfile -Command "Invoke-ScriptAnalyzer -Path scripts/setup -Severity Error"`. Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add -A src scripts/setup tests
git commit -m "feat(setup): download the sign-in certificate; scripts add it to the app instead of a secret"
```

---

### Task 5: The setup and Settings pages

**Files:**
- Modify: `src/app/components/sign-in-settings/provider-form.tsx`, `src/app/components/sign-in-settings/labels.ts`,
  `src/app/setup/instructions.tsx`, `src/app/setup/steps.tsx`, `src/app/staff/(app)/settings/sign-in/page.tsx`,
  `src/app/staff/(app)/secret-expiry-rule.ts`, `src/app/staff/(app)/secret-expiry.tsx`, `src/app/booster.css`
- Create: `src/app/components/sign-in-settings/certificate-panel.tsx`
- Test: `tests/e2e/setup.spec.ts`, `tests/unit/secret-expiry.test.ts`

**Interfaces:**
- Consumes: `ProviderSummary` with `certificate`, `pendingCertificate`, `expiresAt`, `credentialUpdatedAt`
  (Task 3); `usesCertificate` (Task 3); the certificate route (Task 4).
- Produces:
  - `SummaryView` = `{ config; credentialUpdatedAt: string; expiresAt: string | null; readable: boolean; certificate: CertificateViewJson | null; pendingCertificate: CertificateViewJson | null }`,
    where `CertificateViewJson = { thumbprintSha1: string; notAfter: string }`
  - `CertificatePanel({ fileName, summary, settings })`

- [ ] **Step 1: Write the failing e2e test**

Add to `tests/e2e/setup.spec.ts`, using its existing reopen/unlock helpers:

```ts
test("Microsoft sign-in uses a certificate: no secret field, and the same certificate on every download", async ({ page, request }) => {
  const code = reopen();
  await page.goto("/setup");
  await page.getByLabel("Setup code").fill(code);
  await page.getByRole("button", { name: "Unlock" }).click();
  const ms = page.getByRole("region", { name: "Staff sign-in with Microsoft" });
  await expect(ms.getByLabel(/Client secret/)).toHaveCount(0);
  await expect(ms.getByRole("link", { name: "Download certificate (.cer)" })).toBeVisible();
  const cookies = await page.context().cookies();
  const headers = { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") };
  const a = await (await request.get("/setup/certificates/booster-rocket-staff.cer", { headers })).body();
  const b = await (await request.get("/setup/certificates/booster-rocket-staff.cer", { headers })).body();
  expect(a.length).toBeGreaterThan(500);
  expect(Buffer.compare(a, b)).toBe(0);
  await page.reload();
  await expect(ms.getByText(/Thumbprint/)).toBeVisible();
  const google = page.getByRole("region", { name: "Staff sign-in with Google" });
  await expect(google.getByLabel(/Client secret/)).toBeVisible();
});
```

Change the existing "no secret in the HTML" e2e test to seed a **Google** provider whose secret is the marker,
since Microsoft rows no longer hold secrets. In `afterAll`, also delete `provider_certificate` rows so the e2e
database stays clean.

Update `tests/unit/secret-expiry.test.ts` to the renamed summary fields (`expiresAt`, plus `certificate` and
`pendingCertificate` set to null).

Run: `pnpm build` and `pnpm e2e tests/e2e/setup.spec.ts`, with the e2e env from the previous plan
(`DATABASE_URL=…/booster_test`, `APP_URL=http://localhost:3100`, the fake `BETTER_AUTH_SECRET` and
`SETTINGS_ENCRYPTION_KEY`).
Expected: FAIL. The page still shows a secret field.

- [ ] **Step 2: Labels and the certificate panel**

In `labels.ts`, update `SummaryView` and `toSummaryView` to the Interfaces above. Convert `Date`s to ISO strings,
and map each certificate to `{ thumbprintSha1, notAfter }`.

`src/app/components/sign-in-settings/certificate-panel.tsx`:

```tsx
"use client";
import { useRouter } from "next/navigation";
import { CalendarDate } from "@/app/components/calendar-date";
import type { SummaryView } from "./labels";

/** The certificate Microsoft needs on the app registration: download it, then upload it in Entra (or let the script add it). */
export function CertificatePanel({ fileName, summary, settings }: { fileName: string; summary: SummaryView | null; settings: boolean }) {
  const router = useRouter();
  const active = summary?.certificate ?? null;
  const pending = summary?.pendingCertificate ?? null;
  const shown = pending ?? active;
  const label = active && !pending && settings ? "Replace certificate (download a new .cer)" : "Download certificate (.cer)";
  return (
    <div className="stack cert-panel">
      {active && <p className="hint">In use: thumbprint <code>{active.thumbprintSha1}</code>, expires <CalendarDate iso={active.notAfter} />.</p>}
      {pending && <p className="hint">{active ? "Replacement" : "Certificate"} ready to add to the app: Thumbprint <code>{pending.thumbprintSha1}</code>, expires <CalendarDate iso={pending.notAfter} />. {active ? "The one in use keeps working until the new one checks out." : ""}</p>}
      {!shown && <p className="hint">Boosters Rocket makes the certificate when you download it. Only the public half leaves the server.</p>}
      <p><a className="btn btn-line" href={`/setup/certificates/${fileName}`} download onClick={() => setTimeout(() => router.refresh(), 1500)}>{label}</a></p>
    </div>
  );
}
```

Add to `booster.css`: `.cert-panel code { word-break: break-all; }`.

- [ ] **Step 3: The provider form**

In `provider-form.tsx`, when `usesCertificate(providerKey)`:
- render no secret field and no expiry field;
- render `CertificatePanel` with `fileName` = `"booster-rocket-staff.cer"` or `"booster-rocket-parents.cer"` and
  `settings` from a new optional `settings?: boolean` prop, before the button;
- set the button text to `Check and save` (or `Check and switch` when `settings && summary?.pendingCertificate &&
  summary?.certificate`), pending text `Checking with Microsoft…`, and success text `Checked and saved. Microsoft
  accepted the certificate.`.

Google keeps the secret field. Its hint uses `credentialUpdatedAt` and `expiresAt`, with the current wording.
Import `usesCertificate` from `@/lib/auth/provider-fields`.

- [ ] **Step 4: Instructions, steps, Settings, expiry warning**

`instructions.tsx`:
- **Microsoft staff, last step:** "Open **Certificates & secrets** > **Certificates** > **Upload certificate**,
  choose the `booster-rocket-staff.cer` file you downloaded below, and select **Add**. Boosters Rocket made this
  certificate; its private key never leaves your server."
- **Parent, step 5:** the same, with `booster-rocket-parents.cer`.
- **`ScriptOption`:** add a paragraph before the run command: "On Windows, unblock the downloaded file first:"
  followed by `<CopyField label="Unblock" value={`Unblock-File .\\${script}`} />`. Change the description to say
  the script "adds Boosters Rocket's certificate to the app and prints the values to enter below".
- **Order:** the walk-through mentions downloading the certificate before uploading it. The download button is in
  the form below, so the upload step should say "you downloaded below (Download certificate)".

`steps.tsx`: no logic change. `ProviderForm` handles the panel.

Settings page:
- Pass `settings` to `ProviderForm`.
- Change the lede to "How staff and parents sign in. Microsoft sign-in uses a certificate Boosters Rocket made;
  Google uses a client secret, which is never shown again once saved."
- Change the details summary text to "How to set this up or change the app".

`secret-expiry-rule.ts`: use `s.expiresAt`.

`secret-expiry.tsx`: for a Microsoft key, the copy reads "the certificate expires <date>. Use Replace certificate
under Sign-in." For an unreadable Microsoft key: "the certificate's key can't be read with this server's
encryption key. Make a new certificate under Sign-in." Google keeps its current secret wording.

- [ ] **Step 5: Run everything and watch it pass**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build && node scripts/check-client-bundle.mjs`, then
`pnpm db:migrate && pnpm tsx scripts/seed-e2e.ts && pnpm e2e` with the e2e env. Leave `booster_test` with setup
finished.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A src tests
git commit -m "feat(setup): certificate download and status on the setup and Settings pages"
```

---

### Task 6: Docs

**Files:**
- Modify: `docs/runbooks/poc-linuxdev.md`, `docs/superpowers/specs/2026-11-08-first-run-setup-design.md`

- [ ] **Step 1: Runbook**

In `docs/runbooks/poc-linuxdev.md`:
- **Sections 3 and 4:** the Microsoft steps now say "download the certificate from the setup page and upload it
  under Certificates & secrets > Certificates", or "run the script, which adds it". Delete every client-secret
  step, every "copy the Value", and the 24-month secret for Microsoft. Keep Google's secret step.
- **Before running a downloaded script:** add `Unblock-File .\<script>.ps1`.
- **Troubleshooting:** replace the "Microsoft rejected the client secret" row with two rows:
  - "Microsoft doesn't have this certificate on the app yet" (`AADSTS700027`): upload the `.cer` (or run the
    script), wait a minute, retry.
  - "The server's clock looks wrong" (`AADSTS700024`): fix the time on linuxdev.

  Add a row: "The tenant blocks client secrets (`CredentialTypeNotAllowedAsPerAppPolicy`)". This is why
  Microsoft sign-in uses certificates, and nothing needs changing.
- **Audit checklist:** add `certificate.create` and `certificate.activate`.

- [ ] **Step 2: First-run spec note**

At the top of `docs/superpowers/specs/2026-11-08-first-run-setup-design.md`, under **Status**, add:
`**Superseded in part:** Microsoft sign-in uses app-generated certificates, not client secrets. See docs/superpowers/specs/2026-11-09-certificate-credentials-design.md.`

- [ ] **Step 3: Commit**

```bash
git add docs
git commit -m "docs: Microsoft sign-in uses certificates; add Unblock-File and certificate troubleshooting"
```
