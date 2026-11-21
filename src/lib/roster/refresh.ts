import { sql, eq, desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { jobRun, qboCustomer, qboCustomerType } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getConnection } from "@/lib/quickbooks/connection";
import { qboQueryAll, qboCustomerTypes } from "@/lib/quickbooks/client";
import { QboError } from "@/lib/quickbooks/endpoints";
import { billingAddressOf } from "@/lib/parents/contact-fields";
import { noteAddressesKept } from "@/lib/parents/contact-take-in";
import { getShape, shapeTypeIds, ROSTER_LOCK, NO_ADDRESS_COLUMNS } from "./shape";
import { clearRosterOfOtherCompanyLocked, getRosterSource, getSwitchRecord, storedSwitchOf, ROSTER_JOB, setRosterSource } from "./source";

export { ROSTER_LOCK, ROSTER_JOB };

const MANUAL_GAP_MS = 5 * 60_000;
const CHUNK = 500;

/**
 * Why a read of another company's roster over the roster's company was refused: connected to it with no switch an
 * Admin asked for (a database connected before stage 2 refused another company, or a connection stored by hand, or a
 * switch recorded for another pair of companies). The words a failed run keeps, and the Health page and the roster show.
 */
export const NOT_SWITCHED_WORDS = "The roster was read from another QuickBooks company than the one connected now, and nobody chose to switch to it, so it wasn't read. "
  + "Disconnect QuickBooks, then connect the company the roster was read from, or choose Connect a different company first. (roster_company)";

export type RefreshResult =
  | { ok: true; customers: number; types: number }
  | { ok: false; reason: "running" | "not_connected" | "too_soon" | "failed"; error?: string };

type Raw = Record<string, unknown>;
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const ref = (v: unknown): string | null => text((v as { value?: unknown } | null | undefined)?.value, 64);
const isActive = (v: unknown) => v === true || v === "true";
/** QuickBooks sends an array of objects; anything else in it (a null, a string) is skipped rather than read. */
const isRow = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
type TypeRowIn = { qboId: string; name: string; active: boolean; refreshedAt: Date };
type CustomerRowIn = NonNullable<ReturnType<typeof customerRow>>;
/** The answer held no customers while the cache, read from the same company, holds some. Thrown inside the save, so nothing of it is kept. */
class NoCustomersInAnswer extends Error {}
/**
 * The billing address of a customer QuickBooks sent, as the cache's columns hold it: as the parent's form shows an
 * address (billingAddressOf()), each part that is empty kept as null.
 */
function addressColumns(c: Raw) {
  const a = billingAddressOf(c);
  return { addressLine1: a.line1 || null, addressLine2: a.line2 || null, addressCity: a.city || null, addressRegion: a.region || null,
    addressPostalCode: a.postalCode || null, addressCountry: a.country || null };
}

/**
 * One customer of a QuickBooks answer as the cache holds it (spec §2): contact details (email, phone and, since stage
 * 3's slice 11a, the billing address) only for a customer the shape names. Null without an Id.
 */
export function customerRow(c: Raw, named: Set<string>, now: Date) {
  const qboId = text(c.Id, 64);
  if (!qboId) return null;
  const typeQboId = ref(c.CustomerTypeRef);
  const keep = typeQboId !== null && named.has(typeQboId); // contact details only for customers the shape names (spec §2)
  const updated = text((c.MetaData as { LastUpdatedTime?: unknown } | undefined)?.LastUpdatedTime, 40);
  return {
    qboId, displayName: text(c.DisplayName, 500) ?? `Customer ${qboId}`, active: isActive(c.Active), parentQboId: ref(c.ParentRef), typeQboId,
    email: keep ? text((c.PrimaryEmailAddr as { Address?: unknown } | undefined)?.Address, 320)?.toLowerCase() ?? null : null,
    phone: keep ? text((c.PrimaryPhone as { FreeFormNumber?: unknown } | undefined)?.FreeFormNumber, 50) : null,
    ...(keep ? addressColumns(c) : NO_ADDRESS_COLUMNS),
    syncToken: text(c.SyncToken, 20) ?? "0", qboUpdatedAt: updated && !Number.isNaN(Date.parse(updated)) ? new Date(updated) : null, refreshedAt: now,
  };
}

/**
 * Replaces the cache from QuickBooks: every customer type and every customer, active and inactive. QuickBooks is read
 * first; the tables change only if all of it arrived, in the same transaction, so a failure leaves the old cache whole.
 *
 * It stores the customer list and nothing else (stage 3's slice 9c of the app-owned families spec): the app's own
 * families, students and guardian rows stand alone, so a customer renamed, moved, made inactive, added or removed in
 * QuickBooks changes no record, and a student QuickBooks moved keeps their forms, places and buy-outs where the app has
 * them (stage 4 shows such a change as a difference). What the list still decides: whose invoices a family sees, and
 * what the roster pages show of each record's customer.
 *
 * An empty roster would leave every family with no invoices to show, so it is believed from one answer only: a
 * well-formed one (the client reads strictly, and anything else is a failed read), and never over a cache of the same
 * company that holds customers. QuickBooks makes a customer inactive and never deletes one, so a company that had
 * customers still has them; an answer with none is recorded as a failed run (`no_customers`) and the cache stays.
 */
export async function refreshRoster(o: { startedBy: string; actor: Actor; ip: string | null; manual?: boolean }): Promise<RefreshResult> {
  const c = await getConnection();
  if (!c?.realmId || !c.refreshTokenCiphertext) return { ok: false, reason: "not_connected" };
  const realmId = c.realmId; // the company this run reads; the cache is saved only if it is still the connected one
  if (o.manual) {
    const [last] = await db.select().from(jobRun).where(eq(jobRun.job, ROSTER_JOB)).orderBy(desc(jobRun.startedAt)).limit(1);
    // Any run counts, a failed one too: the limit protects QuickBooks from repeated reads.
    if (last && Date.now() - last.startedAt.getTime() < MANUAL_GAP_MS) return { ok: false, reason: "too_soon" };
  }
  return db.transaction(async (tx): Promise<RefreshResult> => {
    const [lock] = (await tx.execute(sql`select pg_try_advisory_xact_lock(${ROSTER_LOCK}) as locked`)) as unknown as { locked: boolean }[];
    if (!lock?.locked) return { ok: false, reason: "running" };
    const [run] = await tx.insert(jobRun).values({ job: ROSTER_JOB, startedBy: o.startedBy }).returning();
    const fail = async (detail: string, code: string): Promise<RefreshResult> => {
      await tx.update(jobRun).set({ finishedAt: new Date(), outcome: "failed", detail }).where(eq(jobRun.id, run!.id));
      await writeAudit({ actor: o.actor, action: "roster.refresh.failed", targetType: "job_run", targetId: String(run!.id), after: { code }, ip: o.ip }, tx);
      return { ok: false, reason: "failed", error: detail };
    };
    // The cache came from another company than the connected one. It is read over it only for the switch an Admin asked
    // for and the connect stored (from the roster's company to this one), whose clear never ran after the store (step
    // 3b of completeConnect() threw, or the process stopped): the save below runs that clear first. Anything else (a
    // database connected to another company before stage 2 refused one, a connection stored by hand, a switch recorded
    // for another pair) is never read over it, and nothing is asked of QuickBooks.
    const from = await getRosterSource(tx);
    if (from !== null && from !== realmId) {
      const s = await getSwitchRecord(tx);
      if (!storedSwitchOf(s, from, realmId)) return fail(NOT_SWITCHED_WORDS, "roster_company");
    }
    let types: Raw[], customers: Raw[];
    try {
      types = await qboCustomerTypes();
      customers = await qboQueryAll("Customer", "Active in (true, false)");
    } catch (e) {
      // Only a QboError's own fixed sentence and code are kept; anything else gets a fixed sentence.
      return e instanceof QboError ? fail(`${e.message} (${e.code})`, e.code) : fail("The roster couldn't be read. (unexpected)", "unexpected");
    }
    // From here to the save, anything that throws ends in a recorded failed run, not a rolled-back one the worker would
    // retry every minute. A savepoint, so even a database error here leaves the transaction able to record it.
    let prepared: { typeRows: TypeRowIn[]; customerRows: CustomerRowIn[] } | "company_changed";
    try {
      prepared = await tx.transaction(async (sp) => {
        const now = new Date();
        const named = new Set(shapeTypeIds(await getShape(sp)));
        // One row per QuickBooks ID, the first one sent, so the counts recorded below are what the cache holds.
        const firstOfEach = <T extends { qboId: string }>(rows: T[]) => { const seen = new Set<string>(); return rows.filter((r) => !seen.has(r.qboId) && seen.add(r.qboId)); };
        const typeRows = firstOfEach(types.filter(isRow).map((t) => ({ qboId: text(t.Id, 64), name: text(t.Name, 200) ?? "(no name)", active: isActive(t.Active), refreshedAt: now }))
          .filter((t): t is TypeRowIn => t.qboId !== null));
        const customerRows = firstOfEach(customers.filter(isRow).map((x) => customerRow(x, named, now)).filter((r) => r !== null));
        // Each page re-reads the connection, so a disconnect and a connect to another company mid-read would mix companies.
        const still = await getConnection(sp);
        if (!still?.realmId || !still.refreshTokenCiphertext || still.realmId !== realmId) return "company_changed" as const;
        return { typeRows, customerRows };
      });
    } catch {
      return fail("The roster couldn't be read. (unexpected)", "unexpected");
    }
    if (prepared === "company_changed") return fail("The QuickBooks company changed during the read. (company_changed)", "company_changed");
    const { typeRows, customerRows } = prepared;
    try {
      // A savepoint: a failure here undoes the cache changes, and the failed run can still be recorded.
      await tx.transaction(async (sp) => {
        // The cache came from another company, by the switch recorded above, and connecting didn't clear it: clear it
        // now, in the same savepoint as the swap, which spends the recorded switch. Its shape goes with it, so the rows
        // are stored with no contact details, as with no shape. The same company clears nothing.
        const cleared = await clearRosterOfOtherCompanyLocked(sp, realmId, { actor: o.actor, ip: o.ip, keepRunId: run!.id });
        // Another company's cache was just cleared, and a new company may truly have no customers yet. Otherwise the
        // customers in the cache are this company's, and an answer without one of them is not believed.
        if (!cleared && customerRows.length === 0 && (await sp.select({ qboId: qboCustomer.qboId }).from(qboCustomer).limit(1)).length > 0) throw new NoCustomersInAnswer();
        const rows = cleared ? customerRows.map((r) => ({ ...r, email: null, phone: null, ...NO_ADDRESS_COLUMNS })) : customerRows;
        await sp.delete(qboCustomerType);
        await sp.delete(qboCustomer);
        for (let i = 0; i < typeRows.length; i += CHUNK) await sp.insert(qboCustomerType).values(typeRows.slice(i, i + CHUNK)).onConflictDoNothing();
        for (let i = 0; i < rows.length; i += CHUNK) await sp.insert(qboCustomer).values(rows.slice(i, i + CHUNK)).onConflictDoNothing();
        await setRosterSource(sp, realmId);
        // The cache holds the billing addresses this build keeps (none where it was just cleared): the take-in of
        // contact details waits for such a read, not for any successful one (src/lib/parents/contact-take-in.ts).
        if (!cleared) await noteAddressesKept(sp, run!.startedAt);
      });
    } catch (e) {
      return e instanceof NoCustomersInAnswer
        ? fail("QuickBooks sent a roster with no customers in it, so the roster was left as it was. (no_customers)", "no_customers")
        : fail("The roster couldn't be saved. (save_failed)", "save_failed");
    }
    await tx.update(jobRun).set({ finishedAt: new Date(), outcome: "ok", detail: `${customerRows.length} customers, ${typeRows.length} customer types` }).where(eq(jobRun.id, run!.id));
    await writeAudit({ actor: o.actor, action: "roster.refresh", targetType: "job_run", targetId: String(run!.id),
      after: { customers: customerRows.length, types: typeRows.length }, ip: o.ip }, tx);
    return { ok: true, customers: customerRows.length, types: typeRows.length };
  });
}
