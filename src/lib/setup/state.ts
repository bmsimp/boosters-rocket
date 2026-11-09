import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";

export type SetupStep = "staff" | "parent" | "admin";
export type SetupState = { status: "open" | "finished"; step: SetupStep; adminEmail: string | null; finishedAt: string | null };
export const SETUP_STATE_KEY = "setup.state";
export const SETUP_CODE_KEY = "setup.code";
const DEFAULT_STATE: SetupState = { status: "open", step: "staff", adminEmail: null, finishedAt: null };

export async function getSetupState(tx?: Tx): Promise<SetupState> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, SETUP_STATE_KEY));
  return { ...DEFAULT_STATE, ...((row?.value as Partial<SetupState> | undefined) ?? {}) };
}

export async function updateSetupState(patch: Partial<SetupState>, tx?: Tx): Promise<SetupState> {
  const next: SetupState = { ...(await getSetupState(tx)), ...patch };
  await (tx ?? db).insert(setting).values({ key: SETUP_STATE_KEY, value: next })
    .onConflictDoUpdate({ target: setting.key, set: { value: next, updatedAt: new Date() } });
  statusCache = null;
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
  statusCache = null;
}

let statusCache: { at: number; status: SetupState["status"] } | null = null;
const cacheMs = () => {
  const v = Number(process.env.SETUP_STATUS_CACHE_MS ?? "5000");
  return Number.isFinite(v) && v >= 0 ? v : 5000;
};
/** For the proxy: the setup status, cached for 5 seconds (SETUP_STATUS_CACHE_MS) so a reopen on the server lands quickly. */
export async function setupStatusCached(now = Date.now()): Promise<SetupState["status"]> {
  if (statusCache && now - statusCache.at < cacheMs()) return statusCache.status;
  const { status } = await getSetupState();
  statusCache = { at: now, status };
  return status;
}
export function clearSetupStatusCache(): void { statusCache = null; }
