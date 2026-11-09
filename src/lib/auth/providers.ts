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
