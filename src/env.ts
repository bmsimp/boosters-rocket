import { z } from "zod";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const encryptionKey = z.string().trim().refine((v) => BASE64.test(v) && Buffer.from(v, "base64").length === 32, {
  message: "SETTINGS_ENCRYPTION_KEY must be 32 random bytes, base64 (make one with: openssl rand -base64 32)",
});

/** What CLIENT_IP_HEADER is when it is not set: the portal's first home was behind Cloudflare. */
export const DEFAULT_CLIENT_IP_HEADER = "cf-connecting-ip";
const HEADER_NAME = /^[a-z0-9][a-z0-9-]*$/;
/**
 * The request header the portal believes for a visitor's address (src/lib/request.ts), or "none". It is the header the
 * proxy in front of the portal sets itself, replacing whatever a visitor sent; .env.example lists the common ones.
 * The portal's own hand-over header (CLIENT_IP_STAMP) is refused: a visitor could send it.
 */
const clientIpHeader = z.preprocess((v) => (typeof v === "string" && v.trim() !== "" ? v.trim().toLowerCase() : DEFAULT_CLIENT_IP_HEADER),
  z.string().refine((v) => HEADER_NAME.test(v) && v.length <= 64 && v !== "x-booster-client-ip", {
    message: "CLIENT_IP_HEADER must be one header name, like cf-connecting-ip or x-forwarded-for, or the word none",
  }));

/**
 * The portal's own address, set by whoever installs it: sign-in, the links in emails, the QuickBooks return address
 * and the installed app are all built on it. An origin only: http or https, a host, a port if it has one. A path, a
 * query or a sign-in in it would be dropped without a word by some of those and kept by others.
 */
const appUrl = z.string().trim().url().refine((v) => {
  try {
    const u = new URL(v);
    return (u.protocol === "https:" || u.protocol === "http:") && u.username === "" && u.password === "" && (u.pathname === "/" || u.pathname === "") && u.search === "" && u.hash === "";
  } catch { return false; }
}, { message: "APP_URL must be the portal's address and nothing more, like https://portal.yourclub.org (http or https, no path, no trailing text)" });

/** Where Boosters Rocket Connect, the relay, lives when QBO_RELAY_URL is not set. */
export const DEFAULT_QBO_RELAY_URL = "https://connect.boostersrocket.app";
/**
 * The relay's address (docs/superpowers/specs/2026-11-24-connect-through-boosters-rocket-design.md §3): set only by
 * the installer, never on a page, since whoever it names is sent every refresh token the portal holds and every request
 * its key signs. An origin only, https (http only for localhost, to test against a relay of one's own); kept as the
 * bare origin, with no trailing slash.
 */
const relayUrl = z.preprocess((v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : DEFAULT_QBO_RELAY_URL), z.string().refine((v) => {
  try {
    const u = new URL(v);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
    return (u.protocol === "https:" || (u.protocol === "http:" && local)) && u.username === "" && u.password === ""
      && (u.pathname === "/" || u.pathname === "") && u.search === "" && u.hash === "" && !v.endsWith("?") && !v.endsWith("#");
  } catch { return false; }
}, { message: "QBO_RELAY_URL must be the relay's address and nothing more, like https://connect.boostersrocket.app (https; http only for localhost)" })
  .transform((v) => new URL(v).origin));

export const schema = z.object({
  DATABASE_URL: z.string().url(),
  APP_URL: appUrl,
  BETTER_AUTH_SECRET: z.string().min(32),
  SETTINGS_ENCRYPTION_KEY: encryptionKey,
  SETTINGS_ENCRYPTION_KEY_PREVIOUS: z.preprocess((v) => (v === "" ? undefined : v), encryptionKey.optional()),
  CLIENT_IP_HEADER: clientIpHeader,
  QBO_RELAY_URL: relayUrl,
});

export type Env = z.infer<typeof schema>;
export function parseEnv(source: Record<string, string | undefined>): Env {
  return schema.parse(source);
}
export const env: Env = parseEnv(process.env);
