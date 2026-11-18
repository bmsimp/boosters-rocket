import { sql, eq, desc } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { jobRun, qboCustomer, qboCustomerType } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getConnection } from "@/lib/quickbooks/connection";
import { qboQueryAll, qboCustomerTypes } from "@/lib/quickbooks/client";
import { QboError } from "@/lib/quickbooks/endpoints";
import { getShape, shapeTypeIds, ROSTER_LOCK } from "./shape";
import { clearRosterOfOtherCompanyLocked, getRosterSource, ROSTER_JOB, setRosterSource } from "./source";
import { studentMoves, studentsUnderFamilies, type StudentMove } from "./moves";
import { logReconcileFailure, reconcileAccess, ReconcileFailed } from "@/lib/parents/reconcile";
import { AppRecordsFailed } from "@/lib/families/in-step";
import { appRecordsAudit, noAppRecordChanges } from "@/lib/families/changes";
import { formsForMovedStudent, requestsHeldElsewhere } from "@/lib/forms/moved";
import { placesHeldElsewhere, volunteerForMovedStudent } from "@/lib/volunteer/moved-student";

export { ROSTER_LOCK, ROSTER_JOB };

const MANUAL_GAP_MS = 5 * 60_000;
const CHUNK = 500;

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
/** What follows a student QuickBooks moved couldn't be done. Thrown inside the save, so nothing of it is kept. */
class FollowUpFailed extends Error {}

/** The actor of what a refresh does for a student QuickBooks moved, as for one moved in the portal (afterStudentMoved()). */
const MOVE_ACTOR: Actor = { door: "system", id: null, label: "roster" };

/**
 * What follows a student QuickBooks moved to another family, in the refresh's savepoint once the cache holds the new
 * family, as afterStudentMoved() (./writes.ts) does for a move made in the portal: the student's signature requests
 * (formsForMovedStudent: a complete one moves with its evidence, any other starts again under the new family and its
 * document is queued for the worker to withdraw), then their volunteer places (volunteerForMovedStudent: places on
 * shifts still to come given up, credit left with the family it was earned for), then the same audit row. A buy-out
 * is left to the daily check after the money run (checkBuyoutInvoices(), src/lib/buyouts/daily-check.ts), which puts
 * the void of an unpaid per-student invoice on the queue from the cache this refresh stores. The answer emails the
 * guardians whose places were given up: call it after the transaction commits.
 */
async function followMovedStudent(sp: Tx, move: StudentMove, cause: string): Promise<() => Promise<unknown>> {
  const forms = await formsForMovedStudent(sp, { ...move, actor: MOVE_ACTOR, ip: null });
  const volunteer = await volunteerForMovedStudent(sp, move, { actor: MOVE_ACTOR, ip: null });
  await writeAudit({ actor: MOVE_ACTOR, action: "roster.student.move.followed", targetType: "qbo_customer", targetId: move.studentQboId,
    after: { fromFamilyQboId: move.fromFamilyQboId, toFamilyQboId: move.toFamilyQboId, cause,
      formsMoved: forms.moved, formsReset: forms.reset, formsToWithdraw: forms.toWithdraw.length, placesGivenUp: volunteer.cancelled, buyouts: "daily_check" } }, sp);
  return volunteer.tell;
}

/** One customer of a QuickBooks answer as the cache holds it (spec §2): contact details only for a customer the shape names. Null without an Id. */
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
    syncToken: text(c.SyncToken, 20) ?? "0", qboUpdatedAt: updated && !Number.isNaN(Date.parse(updated)) ? new Date(updated) : null, refreshedAt: now,
  };
}

/**
 * Replaces the cache from QuickBooks: every customer type and every customer, active and inactive. QuickBooks is read
 * first; the tables change only if all of it arrived, in the same transaction, so a failure leaves the old cache whole.
 *
 * An empty roster ends every parent's access (the reconcile below), so it is believed from one answer only: a
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
  // The guardians to tell once the run is committed, of the students QuickBooks moved (followMovedStudent).
  let tells: (() => Promise<unknown>)[] = [];
  const result = await db.transaction(async (tx): Promise<RefreshResult> => {
    const [lock] = (await tx.execute(sql`select pg_try_advisory_xact_lock(${ROSTER_LOCK}) as locked`)) as unknown as { locked: boolean }[];
    if (!lock?.locked) return { ok: false, reason: "running" };
    const [run] = await tx.insert(jobRun).values({ job: ROSTER_JOB, startedBy: o.startedBy }).returning();
    const fail = async (detail: string, code: string): Promise<RefreshResult> => {
      await tx.update(jobRun).set({ finishedAt: new Date(), outcome: "failed", detail }).where(eq(jobRun.id, run!.id));
      await writeAudit({ actor: o.actor, action: "roster.refresh.failed", targetType: "job_run", targetId: String(run!.id), after: { code }, ip: o.ip }, tx);
      return { ok: false, reason: "failed", error: detail };
    };
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
    const cause = `roster.refresh#${run!.id}`;
    // What the read changed in the app's own records (src/lib/families/in-step.ts), for the run's audit row.
    let appRecords = noAppRecordChanges();
    try {
      // A savepoint: a failure here undoes the cache changes and the parent-access changes together, so the roster and
      // who can sign in never disagree (parents spec §2), and the failed run can still be recorded.
      await tx.transaction(async (sp) => {
        // Whether the cache about to be replaced is this company's: a first read of a company, and another company's
        // cache cleared below, have no move to follow.
        const ours = (await getRosterSource(sp)) === realmId;
        // The cache came from another company and connecting didn't clear it (it failed, or the process stopped): clear
        // it now, with that company's parent access, in the same savepoint as the swap. Its shape goes with it, so the
        // rows are stored with no contact details, as with no shape, and the reconcile below does nothing.
        const cleared = await clearRosterOfOtherCompanyLocked(sp, realmId, { actor: o.actor, ip: o.ip, keepRunId: run!.id });
        // Another company's cache was just cleared, and a new company may truly have no customers yet. Otherwise the
        // customers in the cache are this company's, and an answer without one of them is not believed.
        if (!cleared && customerRows.length === 0 && (await sp.select({ qboId: qboCustomer.qboId }).from(qboCustomer).limit(1)).length > 0) throw new NoCustomersInAnswer();
        // Where each customer sat in that cache, read before it is replaced, under the roster lock this run holds.
        const before = ours ? await sp.select({ qboId: qboCustomer.qboId, typeQboId: qboCustomer.typeQboId, parentQboId: qboCustomer.parentQboId, active: qboCustomer.active }).from(qboCustomer) : [];
        const rows = cleared ? customerRows.map((r) => ({ ...r, email: null, phone: null })) : customerRows;
        await sp.delete(qboCustomerType);
        await sp.delete(qboCustomer);
        for (let i = 0; i < typeRows.length; i += CHUNK) await sp.insert(qboCustomerType).values(typeRows.slice(i, i + CHUNK)).onConflictDoNothing();
        for (let i = 0; i < rows.length; i += CHUNK) await sp.insert(qboCustomer).values(rows.slice(i, i + CHUNK)).onConflictDoNothing();
        await setRosterSource(sp, realmId);
        // A student QuickBooks moved to another family since the last read is followed up as a move made in the portal
        // is. One the portal moved is in the old cache under the new family already, so it is no move here, and a move
        // is found once: the next read sees the student where this one stored them. A move that reached the new family
        // over more than one read (moved while inactive, or through a stray) is found by where the student's forms and
        // places still to come are held; a followed move leaves none held elsewhere.
        const shape = await getShape(sp);
        const under = ours ? studentsUnderFamilies(shape, rows) : new Map<string, string>();
        const held = under.size === 0 ? [] : [...(await requestsHeldElsewhere(sp, under)), ...(await placesHeldElsewhere(sp, under))];
        const moves = before.length === 0 ? [] : studentMoves(shape, before, rows, held);
        const owed: (() => Promise<unknown>)[] = [];
        try { for (const m of moves) owed.push(await followMovedStudent(sp, m, cause)); } catch { throw new FollowUpFailed(); }
        try { ({ appRecords } = await reconcileAccess(sp, { cause })); } catch (e) {
          if (e instanceof AppRecordsFailed) { logReconcileFailure(e.cause, "app records"); throw e; }
          logReconcileFailure(e); throw new ReconcileFailed();
        }
        tells = owed;
      });
    } catch (e) {
      tells = [];
      return e instanceof ReconcileFailed
        ? fail("The parent sign-ins couldn't be brought up to date, so the roster was left as it was. (reconcile_failed)", "reconcile_failed")
        : e instanceof AppRecordsFailed
          ? fail("The portal's own family and student records couldn't be brought up to date, so the roster was left as it was. (app_records_failed)", "app_records_failed")
        : e instanceof NoCustomersInAnswer
          ? fail("QuickBooks sent a roster with no customers in it, so the roster was left as it was. (no_customers)", "no_customers")
          : e instanceof FollowUpFailed
            ? fail("The forms and volunteer places of a student who moved to another family couldn't be brought up to date, so the roster was left as it was. (follow_up_failed)", "follow_up_failed")
            : fail("The roster couldn't be saved. (save_failed)", "save_failed");
    }
    await tx.update(jobRun).set({ finishedAt: new Date(), outcome: "ok", detail: `${customerRows.length} customers, ${typeRows.length} customer types` }).where(eq(jobRun.id, run!.id));
    await writeAudit({ actor: o.actor, action: "roster.refresh", targetType: "job_run", targetId: String(run!.id),
      after: { customers: customerRows.length, types: typeRows.length, ...appRecordsAudit(appRecords) }, ip: o.ip }, tx);
    return { ok: true, customers: customerRows.length, types: typeRows.length };
  });
  // Mail only after the commit, one guardian at a time. A notice that fails is the notices' own to record; it never
  // undoes the refresh.
  if (result.ok) for (const tell of tells) await tell().catch(() => undefined);
  return result;
}
