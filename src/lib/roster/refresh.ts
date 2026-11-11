import { sql, eq, desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { jobRun, qboCustomer, qboCustomerType } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getConnection } from "@/lib/quickbooks/connection";
import { qboQueryAll } from "@/lib/quickbooks/client";
import { QboError } from "@/lib/quickbooks/endpoints";
import { getShape, shapeTypeIds } from "./shape";

export const ROSTER_JOB = "roster.refresh";
/** Postgres advisory lock held for the length of a refresh, so two never run at once (spec §2 Refreshing). */
export const ROSTER_LOCK = 7461001;
const MANUAL_GAP_MS = 5 * 60_000;
const CHUNK = 500;

export type RefreshResult =
  | { ok: true; customers: number; types: number }
  | { ok: false; reason: "running" | "not_connected" | "too_soon" | "failed"; error?: string };

type Raw = Record<string, unknown>;
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const ref = (v: unknown): string | null => text((v as { value?: unknown } | null | undefined)?.value, 64);
const isActive = (v: unknown) => v === true || v === "true";

function customerRow(c: Raw, named: Set<string>, now: Date) {
  const qboId = text(c.Id, 64);
  if (!qboId) return null;
  const typeQboId = ref(c.CustomerTypeRef);
  const keep = typeQboId !== null && named.has(typeQboId); // contact details only for customers the shape names (spec §2)
  const updated = text((c.MetaData as { LastUpdatedTime?: unknown } | undefined)?.LastUpdatedTime, 40);
  return {
    qboId, displayName: text(c.DisplayName, 500) ?? `Customer ${qboId}`, active: isActive(c.Active), parentQboId: ref(c.ParentRef), typeQboId,
    email: keep ? text((c.PrimaryEmailAddr as { Address?: unknown } | undefined)?.Address, 320)?.toLowerCase() ?? null : null,
    phone: keep ? text((c.PrimaryPhone as { FreeFormNumber?: unknown } | undefined)?.FreeFormNumber, 50) : null,
    syncToken: text(c.SyncToken, 20) ?? "0", qboUpdatedAt: updated && !Number.isNaN(Date.parse(updated)) ? new Date(updated) : null, refreshedAt: now,
  };
}

/**
 * Replaces the cache from QuickBooks: every customer type and every customer, active and inactive. QuickBooks is read
 * first; the tables change only if all of it arrived, in the same transaction, so a failure leaves the old cache whole.
 */
export async function refreshRoster(o: { startedBy: string; actor: Actor; ip: string | null; manual?: boolean }): Promise<RefreshResult> {
  const c = await getConnection();
  if (!c?.realmId || !c.refreshTokenCiphertext) return { ok: false, reason: "not_connected" };
  if (o.manual) {
    const [last] = await db.select().from(jobRun).where(eq(jobRun.job, ROSTER_JOB)).orderBy(desc(jobRun.startedAt)).limit(1);
    if (last && Date.now() - last.startedAt.getTime() < MANUAL_GAP_MS) return { ok: false, reason: "too_soon" };
  }
  return db.transaction(async (tx): Promise<RefreshResult> => {
    const [lock] = (await tx.execute(sql`select pg_try_advisory_xact_lock(${ROSTER_LOCK}) as locked`)) as unknown as { locked: boolean }[];
    if (!lock?.locked) return { ok: false, reason: "running" };
    const [run] = await tx.insert(jobRun).values({ job: ROSTER_JOB, startedBy: o.startedBy }).returning();
    let types: Raw[], customers: Raw[];
    try {
      types = await qboQueryAll("CustomerType");
      customers = await qboQueryAll("Customer", "Active in (true, false)");
    } catch (e) {
      if (!(e instanceof QboError)) throw e;
      const detail = `${e.message} (${e.code})`;
      await tx.update(jobRun).set({ finishedAt: new Date(), outcome: "failed", detail }).where(eq(jobRun.id, run!.id));
      await writeAudit({ actor: o.actor, action: "roster.refresh.failed", targetType: "job_run", targetId: String(run!.id), after: { code: e.code }, ip: o.ip }, tx);
      return { ok: false, reason: "failed", error: detail };
    }
    const now = new Date();
    const named = new Set(shapeTypeIds(await getShape(tx)));
    const typeRows = types.map((t) => ({ qboId: text(t.Id, 64), name: text(t.Name, 200) ?? "(no name)", active: isActive(t.Active), refreshedAt: now }))
      .filter((t): t is typeof t & { qboId: string } => t.qboId !== null);
    const customerRows = customers.map((x) => customerRow(x, named, now)).filter((r) => r !== null);
    await tx.delete(qboCustomerType);
    await tx.delete(qboCustomer);
    for (let i = 0; i < typeRows.length; i += CHUNK) await tx.insert(qboCustomerType).values(typeRows.slice(i, i + CHUNK)).onConflictDoNothing();
    for (let i = 0; i < customerRows.length; i += CHUNK) await tx.insert(qboCustomer).values(customerRows.slice(i, i + CHUNK)).onConflictDoNothing();
    await tx.update(jobRun).set({ finishedAt: new Date(), outcome: "ok", detail: `${customerRows.length} customers, ${typeRows.length} customer types` }).where(eq(jobRun.id, run!.id));
    await writeAudit({ actor: o.actor, action: "roster.refresh", targetType: "job_run", targetId: String(run!.id), after: { customers: customerRows.length, types: typeRows.length }, ip: o.ip }, tx);
    return { ok: true, customers: customerRows.length, types: typeRows.length };
  });
}
