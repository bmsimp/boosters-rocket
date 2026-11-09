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
