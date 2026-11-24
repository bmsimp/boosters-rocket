import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { qboCheckRecord } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getConnection } from "@/lib/quickbooks/connection";
import { QboError } from "@/lib/quickbooks/endpoints";
import {
  environmentOf, isQboId, NO_TOKEN, qboCreateCustomer, qboCreateInvoice, qboMoveCustomer, qboRenameCustomer, qboSetCustomerActive, qboUpdateCustomerContact, qboUpdateCustomerEmail, qboVoidInvoice,
  type CustomerContactChange,
} from "@/lib/quickbooks/client";

/**
 * The check's only way to change anything in QuickBooks (roadmap step 7; tests/unit/quickbooks-writes.test.ts). Each
 * function here calls one of the client's existing writes, once, and only after allowed() has said yes, read fresh at
 * the moment of sending:
 *   - the connection's environment is the Intuit sandbox: never the club's real books, whatever the caller asked;
 *   - the connected company is the one the run started with (and the client refuses any other as well);
 *   - every id the write names is a record this check made, listed in qbo_check_record for that company, and for an
 *     update, for this run (making an earlier, cut-off run's records inactive is the one exception).
 * A create is listed before it is sent, with no id yet, so a create whose answer is lost is still the check's own.
 * Nothing here touches the roster cache, the reconcile or the write queue: the check's records never become families.
 */
export type CheckRun = { id: string; realmId: string; actor: Actor; ip: string | null; signal?: AbortSignal };
export type CheckKind = "family" | "student" | "parent" | "invoice";
type Target = { kind: CheckKind; qboId: string; runId?: string };

const refused = (message: string, code: string) => new QboError(message, code);

/** Whether this write may be sent now. Throws a QboError (`not_sandbox`, `other_company`, `not_connected`, `not_mine`) when not. */
async function allowed(run: CheckRun, targets: Target[]): Promise<void> {
  const c = await getConnection();
  if (!c?.realmId || !c.refreshTokenCiphertext) throw refused("QuickBooks isn't connected.", "not_connected");
  if (environmentOf(c, c.tokenMode) !== "sandbox") throw refused("The check changes nothing in a company that isn't an Intuit sandbox.", "not_sandbox");
  if (c.realmId !== run.realmId) throw refused("A different QuickBooks company is connected.", "other_company");
  for (const t of targets) {
    if (!isQboId(t.qboId)) throw refused("That isn't a record the check made.", "not_mine");
    const [row] = await db.select({ runId: qboCheckRecord.runId, closedAt: qboCheckRecord.closedAt }).from(qboCheckRecord)
      .where(and(eq(qboCheckRecord.realmId, run.realmId), eq(qboCheckRecord.kind, t.kind), eq(qboCheckRecord.qboId, t.qboId)));
    if (!row || row.runId !== (t.runId ?? run.id)) throw refused("That isn't a record the check made.", "not_mine");
  }
}

const options = (run: CheckRun) => ({ realmId: run.realmId, signal: run.signal });
const idOf = (record: Record<string, unknown>): string | null => (typeof record.Id === "string" && isQboId(record.Id) ? record.Id : null);

/** Lists a record before its create is sent, so the check owns it even if the answer never comes. Returns the row's id. */
async function listBeforeCreate(run: CheckRun, kind: CheckKind, name: string): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(qboCheckRecord).values({ runId: run.id, realmId: run.realmId, kind, name }).returning({ id: qboCheckRecord.id });
    await writeAudit({ actor: run.actor, action: "quickbooks.check.record.asked", targetType: "qbo_check_record", targetId: row!.id, after: { runId: run.id, kind, name }, ip: run.ip }, tx);
    return row!.id;
  });
}

/** Fills in the id QuickBooks gave a listed create. Also used when a lost create is found again by its name. */
export async function recordMade(run: Pick<CheckRun, "actor" | "ip">, rowId: string, qboId: string): Promise<void> {
  if (!isQboId(qboId)) return;
  await db.transaction(async (tx) => {
    await tx.update(qboCheckRecord).set({ qboId }).where(and(eq(qboCheckRecord.id, rowId), isNull(qboCheckRecord.qboId)));
    await writeAudit({ actor: run.actor, action: "quickbooks.check.record.made", targetType: "qbo_check_record", targetId: rowId, after: { qboId }, ip: run.ip }, tx);
  });
}

/** A 4xx, a token that couldn't be had, or a refusal before sending: QuickBooks made nothing. */
const madeNothing = (code: string) => /^fault_\d+$|^http_4\d\d$/.test(code) || code.startsWith(NO_TOKEN) || ["bad_id", "bad_amount", "bad_email", "other_company", "needs_admin"].includes(code);

/** A listed create that QuickBooks refused: nothing was made, so the row is closed at once. */
async function closeUnmade(run: CheckRun, rowId: string, code: string): Promise<void> {
  await db.update(qboCheckRecord).set({ closedAt: new Date(), lastCode: code.slice(0, 60) }).where(and(eq(qboCheckRecord.id, rowId), isNull(qboCheckRecord.qboId)));
}

/**
 * A listed create whose answer was lost, found to have made nothing: its name is a record the check already lists
 * (`name_of_listed`), or a later run found no customer with it (`not_made`). Closed with no id, as a refused create is.
 */
export async function closeLostCreate(run: CheckRun, rowId: string, code: "name_of_listed" | "not_made"): Promise<void> {
  await closeUnmade(run, rowId, code);
}

/** Sends a create of a listed record, and records what QuickBooks answered: its id, or that nothing was made. */
async function create(run: CheckRun, rowId: string, send: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  let made: Record<string, unknown>;
  try {
    made = await send();
  } catch (e) {
    if (e instanceof QboError && madeNothing(e.code)) await closeUnmade(run, rowId, e.code);
    throw e;
  }
  const qboId = idOf(made);
  if (qboId) await recordMade(run, rowId, qboId);
  return made;
}

/** Marks a record of the check closed: inactive, or voided. Also for one QuickBooks made inactive itself (a family's sub-customer). */
export async function recordClosed(run: CheckRun, kind: CheckKind, qboId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const rows = await tx.update(qboCheckRecord).set({ closedAt: new Date(), lastCode: null })
      .where(and(eq(qboCheckRecord.realmId, run.realmId), eq(qboCheckRecord.kind, kind), eq(qboCheckRecord.qboId, qboId), isNull(qboCheckRecord.closedAt))).returning({ id: qboCheckRecord.id });
    if (rows[0]) await writeAudit({ actor: run.actor, action: "quickbooks.check.record.closed", targetType: "qbo_check_record", targetId: rows[0].id, after: { kind, qboId }, ip: run.ip }, tx);
  });
}

/** Records why closing a record failed, so the page can say it is still open. */
export async function noteCloseFailed(run: CheckRun, kind: CheckKind, qboId: string, code: string): Promise<void> {
  await db.update(qboCheckRecord).set({ lastCode: code.slice(0, 60) })
    .where(and(eq(qboCheckRecord.realmId, run.realmId), eq(qboCheckRecord.kind, kind), eq(qboCheckRecord.qboId, qboId)));
}

/** Makes a family, student or parent named by the check. A student or parent goes under a family this run made. */
export async function checkCreateCustomer(run: CheckRun, c: { kind: "family" | "student" | "parent"; name: string; typeQboId: string; familyQboId: string | null; email: string | null }): Promise<Record<string, unknown>> {
  await allowed(run, c.familyQboId === null ? [] : [{ kind: "family", qboId: c.familyQboId }]);
  const rowId = await listBeforeCreate(run, c.kind, c.name);
  return create(run, rowId, () => qboCreateCustomer({ name: c.name, typeQboId: c.typeQboId, parentQboId: c.familyQboId, billWithParent: c.kind === "student", email: c.email }, { ...options(run), mayWait: true }));
}

/** A parent's contact update, sent to a record this run made. */
export async function checkUpdateContact(run: CheckRun, target: { kind: CheckKind; qboId: string }, syncToken: string, change: CustomerContactChange): Promise<Record<string, unknown>> {
  await allowed(run, [target]);
  return qboUpdateCustomerContact(target.qboId, syncToken, change, options(run));
}

/** A parent's email update, sent to a record this run made. */
export async function checkUpdateEmail(run: CheckRun, target: { kind: CheckKind; qboId: string }, syncToken: string, field: string): Promise<Record<string, unknown>> {
  await allowed(run, [target]);
  return qboUpdateCustomerEmail(target.qboId, syncToken, field, options(run));
}

/** A staff rename, of a record this run made; the record's name follows QuickBooks' answer. */
export async function checkRename(run: CheckRun, target: { kind: CheckKind; qboId: string }, syncToken: string, name: string): Promise<Record<string, unknown>> {
  await allowed(run, [target]);
  const renamed = await qboRenameCustomer(target.qboId, syncToken, name, { ...options(run), mayWait: true });
  await db.update(qboCheckRecord).set({ name }).where(and(eq(qboCheckRecord.realmId, run.realmId), eq(qboCheckRecord.kind, target.kind), eq(qboCheckRecord.qboId, target.qboId)));
  return renamed;
}

/** A staff move of a student this run made, to another family this run made. */
export async function checkMove(run: CheckRun, studentQboId: string, syncToken: string, toFamilyQboId: string): Promise<Record<string, unknown>> {
  await allowed(run, [{ kind: "student", qboId: studentQboId }, { kind: "family", qboId: toFamilyQboId }]);
  return qboMoveCustomer(studentQboId, syncToken, toFamilyQboId, { ...options(run), mayWait: true });
}

/**
 * Makes a record the check made inactive (or active again), and marks it closed once it is inactive. `ofRun` names an
 * earlier run whose records were left open: the next run makes them inactive first.
 */
export async function checkSetActive(run: CheckRun, target: { kind: CheckKind; qboId: string; ofRun?: string }, syncToken: string, active: boolean): Promise<Record<string, unknown>> {
  await allowed(run, [{ kind: target.kind, qboId: target.qboId, runId: target.ofRun }]);
  const answer = await qboSetCustomerActive(target.qboId, syncToken, active, { ...options(run), mayWait: true });
  if (!active) await recordClosed(run, target.kind, target.qboId);
  else await db.update(qboCheckRecord).set({ closedAt: null }).where(and(eq(qboCheckRecord.realmId, run.realmId), eq(qboCheckRecord.kind, target.kind), eq(qboCheckRecord.qboId, target.qboId)));
  return answer;
}

/**
 * A buy-out invoice on a student this run made: one line, the item chosen, a small amount, the check's marker in its note.
 * `billEmail`, for the Pay link probe only: the check's own address at example.com, which can receive no mail.
 */
export async function checkCreateInvoice(run: CheckRun, i: { studentQboId: string; itemQboId: string; units: number; unitCents: number; marker: string; billEmail?: string }): Promise<Record<string, unknown>> {
  await allowed(run, [{ kind: "student", qboId: i.studentQboId }]);
  // Only an address at example.com, which can receive no mail, ever goes on an invoice the check makes.
  if (i.billEmail !== undefined && !/^[a-z0-9.-]{1,80}@example\.com$/.test(i.billEmail)) throw refused("The check sends no email address but its own, at example.com.", "bad_email");
  const rowId = await listBeforeCreate(run, "invoice", i.marker);
  return create(run, rowId, () => qboCreateInvoice({ customerQboId: i.studentQboId, itemQboId: i.itemQboId, units: i.units, unitCents: i.unitCents, buyoutId: i.marker,
    ...(i.billEmail !== undefined ? { billEmail: i.billEmail } : {}) }, { ...options(run), mayWait: true }));
}

/** Voids an invoice the check made, and marks it closed once QuickBooks has voided it. */
export async function checkVoidInvoice(run: CheckRun, target: { qboId: string; ofRun?: string }, syncToken: string): Promise<Record<string, unknown>> {
  await allowed(run, [{ kind: "invoice", qboId: target.qboId, runId: target.ofRun }]);
  const voided = await qboVoidInvoice(target.qboId, syncToken, { ...options(run), mayWait: true });
  await recordClosed(run, "invoice", target.qboId);
  return voided;
}
