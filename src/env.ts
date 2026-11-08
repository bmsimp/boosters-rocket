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
