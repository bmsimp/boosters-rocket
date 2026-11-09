import { z } from "zod";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const encryptionKey = z.string().trim().refine((v) => BASE64.test(v) && Buffer.from(v, "base64").length === 32, {
  message: "SETTINGS_ENCRYPTION_KEY must be 32 random bytes, base64 (make one with: openssl rand -base64 32)",
});

export const schema = z.object({
  DATABASE_URL: z.string().url(),
  APP_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  SETTINGS_ENCRYPTION_KEY: encryptionKey,
  SETTINGS_ENCRYPTION_KEY_PREVIOUS: z.preprocess((v) => (v === "" ? undefined : v), encryptionKey.optional()),
});

export type Env = z.infer<typeof schema>;
export function parseEnv(source: Record<string, string | undefined>): Env {
  return schema.parse(source);
}
export const env: Env = parseEnv(process.env);
