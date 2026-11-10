import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";

export const SETUP_STEPS = ["staff", "mail", "admin"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export const isSetupStep = (s: unknown): s is SetupStep => (SETUP_STEPS as readonly unknown[]).includes(s);
export type SetupState = { status: "open" | "finished"; step: SetupStep; adminEmail: string | null; finishedAt: string | null };
export const SETUP_STATE_KEY = "setup.state";
export const SETUP_CODE_KEY = "setup.code";
const DEFAULT_STATE: SetupState = { status: "open", step: "staff", adminEmail: null, finishedAt: null };

export async function getSetupState(tx?: Tx): Promise<SetupState> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, SETUP_STATE_KEY));
  const merged = { ...DEFAULT_STATE, ...((row?.value as Partial<SetupState> | undefined) ?? {}) };
  // A step this version doesn't have (for example the removed "parent" step) reads as the first step.
  return { ...merged, step: isSetupStep(merged.step) ? merged.step : "staff" };
}

export async function updateSetupState(patch: Partial<SetupState>, tx?: Tx): Promise<SetupState> {
  const next: SetupState = { ...(await getSetupState(tx)), ...patch };
  await (tx ?? db).insert(setting).values({ key: SETUP_STATE_KEY, value: next })
    .onConflictDoUpdate({ target: setting.key, set: { value: next, updatedAt: new Date() } });
  cacheState.cache = null;
  return next;
}

const emailSchema = z.string().email();
export function normalizeEmail(raw: string): string | null {
  const e = raw.trim().toLowerCase();
  return emailSchema.safeParse(e).success ? e : null;
}

export async function saveAdminEmail(raw: string, ip: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = normalizeEmail(raw);
  if (!email) return { ok: false, error: "Enter a valid email address." };
  await db.transaction(async (tx) => {
    const before = await getSetupState(tx);
    await updateSetupState({ adminEmail: email, step: "admin" }, tx);
    await writeAudit({ actor: { door: "system", id: null, label: "setup" }, action: "setup.admin_email.save", targetType: "setting",
      targetId: SETUP_STATE_KEY, before: { adminEmail: before.adminEmail }, after: { adminEmail: email }, ip }, tx);
  });
  return { ok: true };
}

/** Marks setup finished (once), voids the setup code, and audits. Safe to call twice. */
export async function finishSetup(o: { staffUserId: string; email: string; ip: string | null }): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('booster.setup'))`);
    if ((await getSetupState(tx)).status === "finished") return;
    await updateSetupState({ status: "finished", finishedAt: new Date().toISOString() }, tx);
    await tx.delete(setting).where(eq(setting.key, SETUP_CODE_KEY));
    await writeAudit({ actor: { door: "staff", id: o.staffUserId, label: o.email }, action: "setup.finish", targetType: "setting",
      targetId: SETUP_STATE_KEY, after: { adminEmail: o.email }, ip: o.ip }, tx);
  });
  cacheState.cache = null;
}

// Held on globalThis (like providers.ts): the proxy bundle loads its own copy of this module, and a finish or reopen
// in another copy must clear the status it cached.
const CACHE_KEY = Symbol.for("booster-rocket.setup-status");
type CacheState = { cache: { at: number; status: SetupState["status"] } | null };
const cacheState: CacheState = ((globalThis as Record<symbol, unknown>)[CACHE_KEY] ??= { cache: null }) as CacheState;
const cacheMs = () => {
  const v = Number(process.env.SETUP_STATUS_CACHE_MS ?? "5000");
  return Number.isFinite(v) && v >= 0 ? v : 5000;
};
/** For the proxy: the setup status, cached for 5 seconds (SETUP_STATUS_CACHE_MS) so a reopen on the server lands quickly. */
export async function setupStatusCached(now = Date.now()): Promise<SetupState["status"]> {
  const c = cacheState.cache;
  if (c && now - c.at < cacheMs()) return c.status;
  const { status } = await getSetupState();
  cacheState.cache = { at: now, status };
  return status;
}
export function clearSetupStatusCache(): void { cacheState.cache = null; }
