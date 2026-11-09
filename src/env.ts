import { z } from "zod";

const optional = z.string().trim().optional().transform((v) => (v ? v : undefined));

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const encryptionKey = z.string().trim().refine((v) => BASE64.test(v) && Buffer.from(v, "base64").length === 32, {
  message: "SETTINGS_ENCRYPTION_KEY must be 32 random bytes, base64 (make one with: openssl rand -base64 32)",
});

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A multi-tenant alias (common/organizations/consumers) makes Better Auth skip the issuer check, so only a real directory GUID is accepted.
const tenantId = optional.refine((v) => v === undefined || GUID.test(v), {
  message: "STAFF_ENTRA_TENANT_ID must be the club directory (tenant) GUID; common, organizations and consumers are not allowed",
});

export const schema = z.object({
  DATABASE_URL: z.string().url(),
  APP_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  SETTINGS_ENCRYPTION_KEY: encryptionKey,
  SETTINGS_ENCRYPTION_KEY_PREVIOUS: z.preprocess((v) => (v === "" ? undefined : v), encryptionKey.optional()),
  BOOTSTRAP_ADMIN_EMAIL: optional,
  STAFF_ENTRA_TENANT_ID: tenantId,
  STAFF_ENTRA_CLIENT_ID: optional,
  STAFF_ENTRA_CLIENT_SECRET: optional,
  STAFF_GOOGLE_CLIENT_ID: optional,
  STAFF_GOOGLE_CLIENT_SECRET: optional,
  PARENT_OIDC_DISCOVERY_URL: optional,
  PARENT_OIDC_CLIENT_ID: optional,
  PARENT_OIDC_CLIENT_SECRET: optional,
});

export type Env = z.infer<typeof schema>;
export function parseEnv(source: Record<string, string | undefined>): Env {
  return schema.parse(source);
}
export const env: Env = parseEnv(process.env);

export const staffEntraEnabled = Boolean(env.STAFF_ENTRA_TENANT_ID && env.STAFF_ENTRA_CLIENT_ID && env.STAFF_ENTRA_CLIENT_SECRET);
export const staffGoogleEnabled = Boolean(env.STAFF_GOOGLE_CLIENT_ID && env.STAFF_GOOGLE_CLIENT_SECRET);
export const parentDoorEnabled = Boolean(env.PARENT_OIDC_DISCOVERY_URL && env.PARENT_OIDC_CLIENT_ID && env.PARENT_OIDC_CLIENT_SECRET);
