import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { normalizeEmail } from "@/lib/email";
import { parseStaffName } from "@/lib/staff/names";
import { PLUGINS_ON_KEY } from "@/plugins/types";

/** The club's name and color first (only on a new installation: src/lib/setup/club-step.ts), then sign-in, mail, the first Admin. */
export const SETUP_STEPS = ["club", "staff", "mail", "admin"] as const;
/** Where to send someone who tries to reach the First Admin step before mail has been tested. */
export const MAIL_FIRST_URL = "/setup?step=mail&error=mail_first";
export type SetupStep = (typeof SETUP_STEPS)[number];
export const isSetupStep = (s: unknown): s is SetupStep => (SETUP_STEPS as readonly unknown[]).includes(s);
/** `adminName` is the first Admin's name, asked with their email, so their staff record never carries the email as its name. */
export type SetupState = { status: "open" | "finished"; step: SetupStep; adminEmail: string | null; adminName: string | null; finishedAt: string | null };
export const SETUP_STATE_KEY = "setup.state";
export const SETUP_CODE_KEY = "setup.code";
const DEFAULT_STATE: SetupState = { status: "open", step: "club", adminEmail: null, adminName: null, finishedAt: null };

export async function getSetupState(tx?: Tx): Promise<SetupState> {
  const [row] = await (tx ?? db).select().from(setting).where(eq(setting.key, SETUP_STATE_KEY));
  const merged = { ...DEFAULT_STATE, ...((row?.value as Partial<SetupState> | undefined) ?? {}) };
  // A step this version doesn't have (for example the removed "parent" step) reads as the first step. The setup page
  // moves on from the club step by itself where it isn't asked (an existing installation).
  return { ...merged, adminName: typeof merged.adminName === "string" ? merged.adminName : null, step: isSetupStep(merged.step) ? merged.step : "club" };
}

export async function updateSetupState(patch: Partial<SetupState>, tx?: Tx): Promise<SetupState> {
  const next: SetupState = { ...(await getSetupState(tx)), ...patch };
  await (tx ?? db).insert(setting).values({ key: SETUP_STATE_KEY, value: next })
    .onConflictDoUpdate({ target: setting.key, set: { value: next, updatedAt: new Date() } });
  cacheState.cache = null;
  return next;
}

export { normalizeEmail };

/** The first Admin's name and email, saved together. The name follows the staff name rule (src/lib/staff/names.ts). */
export async function saveFirstAdmin(rawName: string, rawEmail: string, ip: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = parseStaffName(rawName);
  if (!name.ok) return { ok: false, error: name.errors[0]! === "Enter a name." ? "Enter the Admin's name." : name.errors[0]! };
  const email = normalizeEmail(rawEmail);
  if (!email) return { ok: false, error: "Enter a valid email address." };
  await db.transaction(async (tx) => {
    const before = await getSetupState(tx);
    await updateSetupState({ adminEmail: email, adminName: name.name, step: "admin" }, tx);
    await writeAudit({ actor: { door: "system", id: null, label: "setup" }, action: "setup.admin_email.save", targetType: "setting",
      targetId: SETUP_STATE_KEY, before: { adminName: before.adminName, adminEmail: before.adminEmail }, after: { adminName: name.name, adminEmail: email }, ip }, tx);
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
    // Setup has no step for the books yet (stage 5's slice P8 adds "Your books"), so a club that finishes it is a
    // QuickBooks club, as every club has been: QuickBooks is on, unless something is stored already.
    const on = await tx.insert(setting).values({ key: PLUGINS_ON_KEY, value: ["quickbooks"] }).onConflictDoNothing().returning({ key: setting.key });
    await writeAudit({ actor: { door: "staff", id: o.staffUserId, label: o.email }, action: "setup.finish", targetType: "setting",
      targetId: SETUP_STATE_KEY, after: { adminEmail: o.email, ...(on.length ? { pluginsOn: ["quickbooks"] } : {}) }, ip: o.ip }, tx);
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
