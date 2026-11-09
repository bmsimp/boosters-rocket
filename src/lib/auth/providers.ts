import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { authProvider } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { secretBox, SecretBoxError, type SecretBox } from "@/lib/crypto/secret-box";
import { PROVIDER_KEYS, PROVIDER_FIELDS, isProviderKey, type ProviderKey, type SaveOutcome } from "./provider-fields";
import type { AssertionKey } from "./client-assertion";
import {
  certificateRows, activatePendingCertificate, retireCertificates, openCertificateKey, isCertificateProvider, toCertificateView,
  type CertificateView, type CertificateProviderKey, type CertificateRow,
} from "./certificates";

export { PROVIDER_KEYS, PROVIDER_FIELDS, isProviderKey, type ProviderKey, type SaveOutcome };
const STAFF_KEYS: readonly ProviderKey[] = ["staff-microsoft", "staff-google"];

export type MicrosoftConfig = { tenantId: string; clientId: string };
export type GoogleConfig = { clientId: string };
export type ParentConfig = { tenantSubdomain: string; tenantId: string; clientId: string };
export type ConfigFor = { "staff-microsoft": MicrosoftConfig; "staff-google": GoogleConfig; "parent-oidc": ParentConfig };

export type LoadedCertificateProvider<K extends CertificateProviderKey> = { key: K; config: ConfigFor[K]; assertion: AssertionKey; expiresAt: Date };
export type LoadedSecretProvider<K extends ProviderKey> = { key: K; config: ConfigFor[K]; secret: string; expiresAt: Date | null };
export type LoadedProviders = {
  version: number;
  staffMicrosoft: LoadedCertificateProvider<"staff-microsoft"> | null;
  staffGoogle: LoadedSecretProvider<"staff-google"> | null;
  parent: LoadedCertificateProvider<"parent-oidc"> | null;
};
/** What reaches the browser: certificate views only, never key material or the sealed secret. */
export type ProviderSummary = {
  key: ProviderKey; config: Record<string, string>; credentialUpdatedAt: Date; expiresAt: Date | null; readable: boolean;
  certificate: CertificateView | null; pendingCertificate: CertificateView | null;
  /** Whether this server can decrypt the pending certificate's key (false when nothing is pending). */
  pendingReadable: boolean;
};

export type ProviderDraft =
  | { key: "staff-google"; config: GoogleConfig; secret: string | null; secretExpiresAt: Date | null }
  | { key: "staff-microsoft"; config: MicrosoftConfig }
  | { key: "parent-oidc"; config: ParentConfig };
export type CheckedDraft =
  | { key: "staff-google"; config: GoogleConfig; secret: string }
  | { key: "staff-microsoft"; config: MicrosoftConfig; assertion: AssertionKey }
  | { key: "parent-oidc"; config: ParentConfig; assertion: AssertionKey };
export type CheckResult = { ok: true } | { ok: false; message: string };
export type CheckFn = (draft: CheckedDraft) => Promise<CheckResult>;

export function parentDiscoveryUrl(c: ParentConfig): string {
  return `https://${c.tenantSubdomain}.ciamlogin.com/${c.tenantId}/v2.0/.well-known/openid-configuration`;
}

// ---- loading (cached; a save in this process bumps the version) ----

// Held on globalThis: Next.js may load this module separately per server bundle and on dev HMR,
// and a save in one copy must invalidate what sign-in reads in another.
const STATE_KEY = Symbol.for("booster-rocket.providers");
type ProvidersState = { version: number; cache: { version: number; value: Promise<LoadedProviders> } | null };
const state: ProvidersState = ((globalThis as Record<symbol, unknown>)[STATE_KEY] ??= { version: 1, cache: null }) as ProvidersState;
export const providersVersion = () => state.version;
export function invalidateProviders(): void { state.version += 1; state.cache = null; }

export function loadProviders(box?: SecretBox): Promise<LoadedProviders> {
  if (state.cache && state.cache.version === state.version) return state.cache.value;
  const v = state.version;
  const value = readProviders(v, box ?? secretBox()).catch((e) => { if (state.cache?.version === v) state.cache = null; throw e; });
  state.cache = { version: v, value };
  return value;
}

function openRow(r: typeof authProvider.$inferSelect, box: SecretBox): string | null {
  if (r.secretCiphertext === null || r.secretKeyId === null) return null;
  try {
    return box.open({ ciphertext: r.secretCiphertext, keyId: r.secretKeyId }, r.key);
  } catch (e) {
    if (e instanceof SecretBoxError) return null;
    throw e;
  }
}

/** The assertion key for a certificate: x5t comes from the stored SHA-1 thumbprint (hex, as Entra shows it). */
const assertionKey = (row: CertificateRow, privateKeyPem: string): AssertionKey =>
  ({ privateKeyPem, thumbprintS256: row.thumbprintS256, thumbprintSha1Base64Url: Buffer.from(row.thumbprintSha1, "hex").toString("base64url") });

/** The active certificate's signing key for a Microsoft sign-in, or null if there is none or it can't be decrypted. */
async function activeAssertion(key: CertificateProviderKey, box: SecretBox): Promise<{ assertion: AssertionKey; expiresAt: Date } | null> {
  const { active } = await certificateRows(key);
  const privateKeyPem = active ? openCertificateKey(active, box) : null;
  if (!active || privateKeyPem === null) return null;
  return { assertion: assertionKey(active, privateKeyPem), expiresAt: active.notAfter };
}

async function readProviders(v: number, box: SecretBox): Promise<LoadedProviders> {
  const out: LoadedProviders = { version: v, staffMicrosoft: null, staffGoogle: null, parent: null };
  for (const r of await db.select().from(authProvider)) {
    if (r.key === "staff-google") {
      const secret = openRow(r, box);
      if (secret === null) {
        console.error(`[sign-in] The stored secret for ${r.key} can't be decrypted with SETTINGS_ENCRYPTION_KEY; treating it as not set up.`);
        continue;
      }
      out.staffGoogle = { key: r.key, config: r.config as GoogleConfig, secret, expiresAt: r.secretExpiresAt };
      continue;
    }
    const credential = await activeAssertion(r.key, box);
    if (credential === null) {
      console.error(`[sign-in] The certificate for ${r.key} is missing or can't be decrypted; treating it as not set up.`);
      continue;
    }
    if (r.key === "staff-microsoft") out.staffMicrosoft = { key: r.key, config: r.config as MicrosoftConfig, ...credential };
    else out.parent = { key: r.key, config: r.config as ParentConfig, ...credential };
  }
  return out;
}

/** What the setup and Settings pages may show: never the secret or a certificate's key. */
export async function providerSummaries(box: SecretBox = secretBox()): Promise<ProviderSummary[]> {
  const out: ProviderSummary[] = [];
  for (const r of await db.select().from(authProvider)) {
    const base = { key: r.key, config: r.config as Record<string, string> };
    if (!isCertificateProvider(r.key)) {
      out.push({ ...base, credentialUpdatedAt: r.secretUpdatedAt, expiresAt: r.secretExpiresAt, readable: openRow(r, box) !== null,
        certificate: null, pendingCertificate: null, pendingReadable: false });
      continue;
    }
    const { pending, active } = await certificateRows(r.key);
    out.push({
      ...base, credentialUpdatedAt: active?.activatedAt ?? r.updatedAt, expiresAt: active?.notAfter ?? null,
      readable: active !== null && openCertificateKey(active, box) !== null,
      certificate: active ? toCertificateView(active) : null, pendingCertificate: pending ? toCertificateView(pending) : null,
      pendingReadable: pending !== null && openCertificateKey(pending, box) !== null,
    });
  }
  return out;
}

/**
 * Certificates downloaded before their sign-in was first saved have no provider row, so providerSummaries has nothing for them.
 * This is a display-only stand-in so the page can show the pending certificate's thumbprint. It is never "readable" or configured.
 */
export async function pendingOnlySummaries(have: ProviderKey[], box: SecretBox = secretBox()): Promise<ProviderSummary[]> {
  const out: ProviderSummary[] = [];
  for (const key of PROVIDER_KEYS) {
    if (!isCertificateProvider(key)) continue;
    if (have.includes(key)) continue;
    const { pending } = await certificateRows(key);
    if (pending) out.push({ key, config: {}, credentialUpdatedAt: pending.createdAt, expiresAt: null, readable: false, certificate: null,
      pendingCertificate: toCertificateView(pending), pendingReadable: openCertificateKey(pending, box) !== null });
  }
  return out;
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
  // Microsoft sign-ins use the app's certificate, so any secret or expiry sent with them is ignored.
  if (isCertificateProvider(key)) {
    if (!config.success) return { ok: false, errors: config.error.issues.map((i) => i.message) };
    return { ok: true, draft: { key, config: config.data } as ProviderDraft };
  }
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
  const existingRow = (tx: Tx | typeof db) => tx.select().from(authProvider).where(eq(authProvider.key, draft.key)).then((r) => r[0]);
  if (draft.key !== "staff-google") return saveCertificateProvider(draft, opts, box, existingRow);
  // The check talks to Microsoft, so it runs outside the transaction (and its lock). The row it used is re-read, under the
  // same lock removeProvider takes, when the save happens, so a concurrent save or removal can't be overwritten from stale data.
  let plain = draft.secret;
  if (plain === null) {
    const current = await existingRow(db);
    if (!current) return { ok: false, errors: ["Enter the client secret."] };
    plain = openRow(current, box);
    if (plain === null) return { ok: false, errors: ["The saved secret can't be read any more. Enter the client secret again."] };
  }
  const checked = await opts.check({ key: draft.key, config: draft.config, secret: plain });
  if (!checked.ok) return { ok: false, errors: [checked.message] };

  const secretChanged = draft.secret !== null;
  const r = await db.transaction(async (tx): Promise<SaveOutcome> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('booster.auth_provider'))`);
    const existing = await existingRow(tx);
    if (!secretChanged && !existing) return { ok: false, errors: ["Enter the client secret."] };
    const sealed = secretChanged ? box.seal(plain, draft.key) : { ciphertext: existing!.secretCiphertext, keyId: existing!.secretKeyId };
    const now = new Date();
    const expiresAt = draft.secretExpiresAt ?? (secretChanged ? null : existing!.secretExpiresAt);
    const values = {
      key: draft.key, config: draft.config, secretCiphertext: sealed.ciphertext, secretKeyId: sealed.keyId,
      secretExpiresAt: expiresAt, secretUpdatedAt: secretChanged ? now : existing!.secretUpdatedAt, updatedAt: now, updatedBy: opts.updatedBy,
    };
    await tx.insert(authProvider).values(values).onConflictDoUpdate({ target: authProvider.key, set: values });
    await writeAudit({
      actor: opts.actor, action: "setup.provider.save", permission: opts.permission, targetType: "auth_provider", targetId: draft.key,
      before: existing ? { ...(existing.config as object), secretExpiresAt: existing.secretExpiresAt?.toISOString() ?? null } : null,
      after: { ...draft.config, secretExpiresAt: expiresAt?.toISOString() ?? null, secretChanged }, ip: opts.ip,
    }, tx);
    return { ok: true };
  });
  if (r.ok) invalidateProviders();
  return r;
}
type SaveOpts = { actor: Actor; ip: string | null; permission?: string; updatedBy: string | null; check: CheckFn };

/**
 * Microsoft sign-ins: the check runs with the pending certificate if there is one (a first save, or a replacement being
 * rolled out), otherwise with the active one, and the save activates a pending certificate it was checked with.
 */
async function saveCertificateProvider(
  draft: Extract<ProviderDraft, { key: CertificateProviderKey }>, opts: SaveOpts, box: SecretBox,
  existingRow: (tx: Tx | typeof db) => Promise<typeof authProvider.$inferSelect | undefined>,
): Promise<SaveOutcome> {
  const { pending, active } = await certificateRows(draft.key);
  const candidate = pending ?? active;
  if (!candidate) return { ok: false, errors: ["Download the certificate and add it to the app registration first."] };
  const privateKeyPem = openCertificateKey(candidate, box);
  if (!privateKeyPem) return { ok: false, errors: ["This server can't read the certificate's key any more. Select Replace certificate, then add the new certificate to the app registration."] };
  // A refusal is audited with the certificate it was about (its thumbprint only, never key material).
  const refused = (reason: "check_failed" | "certificate_changed", tx?: Tx) => writeAudit({
    actor: opts.actor, action: "setup.provider.save.refused", permission: opts.permission, targetType: "auth_provider", targetId: draft.key,
    after: { reason, certificateThumbprintSha1: candidate.thumbprintSha1 }, ip: opts.ip }, tx);
  const checked = await opts.check({ ...draft, assertion: assertionKey(candidate, privateKeyPem) } as CheckedDraft);
  if (!checked.ok) {
    await refused("check_failed");
    return { ok: false, errors: [checked.message] };
  }
  const r = await db.transaction(async (tx): Promise<SaveOutcome> => {
    // Provider lock first, then (inside activatePendingCertificate) the certificate lock: the order removeProvider uses too.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('booster.auth_provider'))`);
    const existing = await existingRow(tx);
    // The check ran without the lock: refuse if a concurrent save or removal changed the certificate it was checked with.
    const current = await certificateRows(draft.key, tx);
    if ((candidate.status === "pending" ? current.pending : current.active)?.id !== candidate.id) {
      await refused("certificate_changed", tx);
      return { ok: false, errors: ["The certificate changed while this was being checked. Try again."] };
    }
    const replaced = candidate.status === "pending" && current.active !== null;
    const activated = candidate.status === "pending"
      ? await activatePendingCertificate(tx, draft.key, { actor: opts.actor, ip: opts.ip, permission: opts.permission })
      : null;
    const now = new Date();
    const values = { key: draft.key, config: draft.config, secretCiphertext: null, secretKeyId: null, secretExpiresAt: null,
      secretUpdatedAt: now, updatedAt: now, updatedBy: opts.updatedBy };
    await tx.insert(authProvider).values(values).onConflictDoUpdate({ target: authProvider.key, set: values });
    await writeAudit({ actor: opts.actor, action: "setup.provider.save", permission: opts.permission, targetType: "auth_provider", targetId: draft.key,
      before: existing ? existing.config : null,
      after: { ...draft.config, certificateThumbprintSha1: candidate.thumbprintSha1, certificateNotAfter: candidate.notAfter.toISOString(), certificateChanged: activated !== null },
      ip: opts.ip }, tx);
    return replaced ? { ok: true, replaced: true } : { ok: true };
  });
  if (r.ok) invalidateProviders();
  return r;
}

export async function removeProvider(key: ProviderKey, opts: { actor: Actor; ip: string | null; permission?: string; box?: SecretBox }): Promise<SaveOutcome> {
  const box = opts.box ?? secretBox();
  const r = await db.transaction(async (tx): Promise<SaveOutcome> => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('booster.auth_provider'))`);
    const rows = await tx.select().from(authProvider);
    const existing = rows.find((x) => x.key === key);
    if (!existing) return { ok: true };
    // Only a row this server can decrypt counts as another way to sign in; an unreadable one is "not set up" (see readProviders).
    // For Microsoft that means its active certificate's key decrypts.
    const readable = async (x: typeof authProvider.$inferSelect) => {
      if (!isCertificateProvider(x.key)) return openRow(x, box) !== null;
      const { active } = await certificateRows(x.key, tx);
      return active !== null && openCertificateKey(active, box) !== null;
    };
    let another = false;
    for (const x of rows) if (x.key !== key && STAFF_KEYS.includes(x.key) && (await readable(x))) another = true;
    if (STAFF_KEYS.includes(key) && !another) {
      await writeAudit({ actor: opts.actor, action: "setup.provider.remove.refused", permission: opts.permission, targetType: "auth_provider",
        targetId: key, after: { reason: "last_staff_sign_in" }, ip: opts.ip }, tx);
      return { ok: false, errors: ["This would leave no way for staff to sign in."] };
    }
    if (isCertificateProvider(key)) await retireCertificates(tx, key, { actor: opts.actor, ip: opts.ip, permission: opts.permission });
    await tx.delete(authProvider).where(eq(authProvider.key, key));
    await writeAudit({ actor: opts.actor, action: "setup.provider.remove", permission: opts.permission, targetType: "auth_provider",
      targetId: key, before: existing.config, ip: opts.ip }, tx);
    return { ok: true };
  });
  if (r.ok) invalidateProviders();
  return r;
}
