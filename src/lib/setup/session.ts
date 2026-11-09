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
