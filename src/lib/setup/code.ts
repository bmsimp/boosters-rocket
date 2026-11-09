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

// Tries per client address, in memory. A slot is reserved synchronously (before any await) so a parallel burst can't slip past
// the limit. The total lives in the database and is reserved atomically, so neither a restart nor a burst can reset it.
const failures = new Map<string, number[]>();
export function resetSetupCodeLimiter(): void { failures.clear(); }

function prune(who: string, now: number): number[] {
  const list = (failures.get(who) ?? []).filter((t) => now - t < PER_IP_WINDOW_MS);
  if (list.length === 0) failures.delete(who);
  else failures.set(who, list);
  return list;
}
function releaseSlot(who: string, now: number): void {
  const list = failures.get(who);
  if (!list) return;
  const at = list.lastIndexOf(now);
  if (at >= 0) list.splice(at, 1);
  if (list.length === 0) failures.delete(who);
}

export async function verifySetupCode(input: unknown, ip: string | null, now = Date.now()): Promise<VerifyResult> {
  const who = ip ?? "unknown";
  const refuse = async (reason: Exclude<VerifyResult, { ok: true }>["reason"]): Promise<VerifyResult> => {
    await writeAudit({ actor: SETUP_ACTOR, action: "setup.unlock.refused", targetType: "setting", targetId: SETUP_CODE_KEY, after: { reason }, ip });
    return { ok: false, reason };
  };
  const recent = prune(who, now);
  if (recent.length >= PER_IP_LIMIT) return refuse("slowed");
  recent.push(now);
  failures.set(who, recent);

  // Reserve one try in the total, atomically, before comparing anything.
  const reserved = Array.from(await db.execute<{ value: StoredCode }>(sql`UPDATE setting
    SET value = jsonb_set(value, '{failedTotal}', to_jsonb(COALESCE((value->>'failedTotal')::int, 0) + 1)), updated_at = now()
    WHERE key = ${SETUP_CODE_KEY} AND COALESCE((value->>'failedTotal')::int, 0) < ${MAX_FAILED_TOTAL}
    RETURNING value`) as ArrayLike<{ value: StoredCode }>);
  const stored = reserved[0]?.value;
  if (!stored) {
    releaseSlot(who, now);
    return refuse((await readStoredCode()) ? "void" : "no_code");
  }
  const want = Buffer.from(stored.hash, "hex");
  const got = Buffer.from(hashCode(normalizeCode(typeof input === "string" ? input : ""), stored.salt), "hex");
  if (typeof input === "string" && want.length === got.length && timingSafeEqual(want, got)) {
    releaseSlot(who, now); // a success must not count as a failure
    await db.execute(sql`UPDATE setting
      SET value = jsonb_set(value, '{failedTotal}', to_jsonb((value->>'failedTotal')::int - 1)), updated_at = now()
      WHERE key = ${SETUP_CODE_KEY} AND value->>'hash' = ${stored.hash} AND COALESCE((value->>'failedTotal')::int, 0) >= 1`);
    await writeAudit({ actor: SETUP_ACTOR, action: "setup.unlock", targetType: "setting", targetId: SETUP_CODE_KEY, ip });
    return { ok: true, codeHash: stored.hash };
  }
  return refuse(stored.failedTotal >= MAX_FAILED_TOTAL ? "void" : "wrong");
}
