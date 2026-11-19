// Staff only: a staff member's changes to the roster in QuickBooks (v1 spec §6.1, §6.3). It loads every family in the
// club, so it is never imported by parent code (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts). It is
// the only module that may call the client's roster writes (tests/unit/quickbooks-writes.test.ts): the staff roster
// actions and the write queue's job reach QuickBooks through it.
import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { qboCustomer, qboCustomerType, writeQueue, type RosterRole, type RosterWrite } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getConnection } from "@/lib/quickbooks/connection";
import { CUSTOMER_WRITES, NO_TOKEN, qboCreateCustomer, qboCustomerById, qboMoveCustomer, qboRenameCustomer, qboSetCustomerActive } from "@/lib/quickbooks/client";
import { QboError } from "@/lib/quickbooks/endpoints";
import { currencyOf, formatMoney, toCents } from "@/lib/money/cents";
import { normalizeEmail } from "@/lib/email";
import { lockRosterAs, rosterTagOf, ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { reconcileAccess } from "@/lib/parents/reconcile";
import { appRecordsAudit, changedAppRecords, noAppRecordChanges } from "@/lib/families/changes";
import { familyLinkedTo, studentLinkedTo } from "@/lib/families/links";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { askForRosterRefresh, ROSTER_ASK_KEY } from "@/lib/parents/refresh-ask";
import { formsForMovedStudent } from "@/lib/forms/moved";
import { volunteerForMovedStudent } from "@/lib/volunteer/moved-student";
import { buyoutsForMovedStudent } from "@/lib/buyouts/moved";
import { getShape, missingTypes, shapeTypeIds, type MembershipShape } from "./shape";
import { buildRoster, type Cust, type Roster } from "./model";
import { getRosterSource } from "./source";
import { customerRow } from "./refresh";
import { checkName, freeName, nameKey } from "./names";
import { deactivateOf, offers, renameOf, typeForNew, type RosterOperation } from "./operations";
import { classify, type CachedCustomer } from "./write-rules";

/**
 * The setting that asks the worker for a roster refresh at its next wake: `{ at }`. One ask for the whole portal,
 * shared with a parent's email change (src/lib/parents/refresh-ask.ts, which the worker's roster step reads); the
 * write queue (./queue.ts) also runs a refresh for it and clears it once one has started after it.
 */
export const REFRESH_ASK_KEY = ROSTER_ASK_KEY;
const SEND_TIMEOUT_MS = 10_000;

/** `showAmounts`: the staff member holds Finance.Balance.Read, so a balance that stops a change is said with its amount. */
export type WriteOp = { actor: Actor; ip: string | null; permission: string; showAmounts?: boolean };
/** How long reading what one customer owes may take, before anything is made inactive. */
const BALANCE_READ_TIMEOUT_MS = 5_000;

/** What staff asked for, as their page sent it: untrusted ids, each looked up in the roster cache under the roster lock. */
export type WriteAsk =
  | { op: "create"; role: RosterRole; name: string; familyQboId: string | null; email: string | null; typeQboId: string | null }
  | { op: "rename"; qboId: string; syncToken: string; name: string }
  | { op: "move"; qboId: string; syncToken: string; toFamilyQboId: string }
  | { op: "deactivate"; qboId: string; syncToken: string };

/**
 * A record as QuickBooks has it now, read again after it changed while staff were editing (spec §6.3): only what the
 * form shows. Its new version reaches the page when the page is made again, which the action asks for.
 */
export type CurrentRecord = { name: string; active: boolean; familyName: string | null };

export type WriteResult =
  | { ok: true; message: string; queued?: true }
  | { ok: false; errors: string[]; offer?: string; current?: CurrentRecord };

export const WRITE_COPY = {
  changed: "This changed in QuickBooks while you were editing, so nothing was changed. Here it is as QuickBooks has it now: make your change again if it is still needed.",
  changedUnseen: "This changed in QuickBooks while you were editing, so nothing was changed. Reload the page to see it as QuickBooks has it now.",
  refused: "QuickBooks wouldn't take that change, so nothing was changed. Check it in QuickBooks, or try something different.",
  notSent: "That couldn't be sent to QuickBooks, so nothing was changed.",
  notConnected: "QuickBooks isn't connected, so nothing was changed. An Admin can connect it under QuickBooks.",
  needsAdmin: "QuickBooks needs to be connected again, so nothing was changed. An Admin can do that under QuickBooks.",
  otherCompany: "QuickBooks is connected to a different company from the one this roster was read from, so nothing was changed. An Admin can sort that out under QuickBooks.",
  noRoster: "The roster can't be shown right now, so nothing was changed. Check QuickBooks under Roster.",
  gone: "That isn't on the roster any more, so nothing was changed. Reload the page.",
  notOffered: "That can't be changed from the portal for this club, so nothing was changed.",
  waiting: "Another change to this is still waiting to reach QuickBooks. Once it has gone through, or been given up on the Reconciliation page, try again.",
  doneNotShown: "Done in QuickBooks. The roster here will show it after its next read of QuickBooks, usually within a few minutes.",
  queued: "QuickBooks couldn't take this just now, so it is waiting to reach QuickBooks. The portal tries again in a minute, then less often, and you'll find it on the Reconciliation page.",
  balanceFix: "A balance has to be paid, or written off, in QuickBooks first. Then try again.",
  balanceUnread: "QuickBooks couldn't be asked what is owed just now, so nothing was changed. Try again in a few minutes.",
  balanceUnknown: "QuickBooks didn't say what is owed, so nothing was changed. Check the balance in QuickBooks, then try again.",
  balanceRefused: "QuickBooks wouldn't say what is owed, so nothing was changed. Check the customer in QuickBooks; waiting won't change this answer.",
  coverChanged: "Who is under this family changed in QuickBooks since the page was shown, so nothing was changed. Reload the page, look at the list again, and confirm it.",
} as const;

/** A family is made inactive only with everyone under it: the refusal names the button as the family's page does. */
export const familyHereWords = (name: string) =>
  `A family is made inactive together with everyone under it. On its page, under “Change the family ${name}”, use “Make ${name} inactive”.`;
/** QuickBooks' 6220, which may be an amount owed or a credit: either has to be settled there first. */
const accountWords = (name: string) =>
  `QuickBooks says there is a balance on ${name}'s account, so they weren't made inactive. It has to be settled in QuickBooks first: paid or written off, or a credit used or refunded. Then try again.`;

/**
 * What QuickBooks refused, in words for one customer: a balance on the account (6220, as the sandbox answered on
 * 2026-11-17), and customers under it still active (800, as the sandbox answered a family on the same day). Null for
 * any other code.
 */
export function refusalWords(code: string, name: string): string | null {
  if (code === `fault_${CUSTOMER_WRITES.faults.openBalance}`) return accountWords(name);
  if (code === `fault_${CUSTOMER_WRITES.faults.activeUnder}`) return `QuickBooks won't make ${name} inactive while customers under it are still active, so it wasn't changed. Reload the page to see who is under it, and try again.`;
  return null;
}
/** What one customer owes, in words: with its amount only for staff who may see money. */
const owesWords = (name: string, owed: { cents: number; currency: string }, showAmounts: boolean) =>
  showAmounts ? `${name} owes ${formatMoney(owed.cents, owed.currency)} in QuickBooks.` : `${name} has an open balance in QuickBooks.`;

/** What one customer owes now, and what the same read shows of it: whether it is active, and its version. */
export type Owed = { ok: true; cents: number; currency: string; active: boolean; syncToken: string | null } | { ok: false; code: string };
/**
 * What one customer owes now, read live from QuickBooks before it is made inactive (its own Balance, without the
 * customers under it, who are read one by one). For a staff member pressing a button it never waits in line for the
 * connection row (failFast), and a row held elsewhere is "busy" as a write's would be (token_busy); the write queue's
 * worker may wait (`mayWait`). An answer about another record is `not_the_customer`, and one with no balance in it
 * `no_balance`: refusals, never put on the queue, since asking again won't change them.
 */
export async function owedBy(qboId: string, realmId: string, o: { mayWait?: boolean } = {}): Promise<Owed> {
  let c: Record<string, unknown> | null;
  try { c = await qboCustomerById(qboId, o.mayWait ? { realmId, timeoutMs: BALANCE_READ_TIMEOUT_MS } : { failFast: true, realmId, timeoutMs: BALANCE_READ_TIMEOUT_MS }); } catch (e) {
    if (!(e instanceof QboError)) throw e;
    return { ok: false, code: e.code === "busy" ? `${NO_TOKEN}busy` : e.code };
  }
  if (!c || c.Id !== qboId) return { ok: false, code: "not_the_customer" };
  const cents = toCents(c.Balance);
  if (cents === null) return { ok: false, code: "no_balance" };
  return { ok: true, cents, currency: currencyOf(isRow(c.CurrencyRef) ? c.CurrencyRef.value : undefined), active: c.Active !== false,
    syncToken: typeof c.SyncToken === "string" && /^\d{1,20}$/.test(c.SyncToken) ? c.SyncToken : null };
}
/** Whether the read shows a version newer than the one the page was shown: someone changed it in QuickBooks since. */
const movedOn = (owed: { syncToken: string | null }, shown: string) => owed.syncToken !== null && tokenNumber(owed.syncToken) > tokenNumber(shown);
/**
 * The words for a balance that couldn't be read, by its code: the connection's own words where only a person can mend
 * it, "try again" only where waiting can help, and a refusal that waiting won't change said as one.
 */
function unreadWords(code: string): string {
  if (code === "no_balance") return WRITE_COPY.balanceUnknown;
  const kind = classify(code).kind;
  if (kind === "not_connected") return WRITE_COPY.notConnected;
  if (kind === "needs_admin") return WRITE_COPY.needsAdmin;
  if (kind === "other_company") return WRITE_COPY.otherCompany;
  if (code === "bad_id") return WRITE_COPY.notSent;
  return kind === "retry" ? WRITE_COPY.balanceUnread : WRITE_COPY.balanceRefused;
}

const taken = (name: string, offer: string): WriteResult => ({ ok: false, offer,
  errors: [`“${name}” is already a name in QuickBooks, and every name there must be different. You could use “${offer}” instead.`] });
const refuse = (error: string): WriteResult => ({ ok: false, errors: [error] });

/** The roster cache as the checks read it: every customer, inactive ones too, with its version. */
async function cacheRows(tx: Tx): Promise<(Cust & { syncToken: string })[]> {
  return (await tx.select().from(qboCustomer)).map((c) => ({ qboId: c.qboId, displayName: c.displayName, active: c.active, parentQboId: c.parentQboId,
    typeQboId: c.typeQboId, email: c.email, phone: c.phone, syncToken: c.syncToken }));
}

/** Who a cached customer is in the roster: a family, a student or parent directly under one, or a member. Null for anyone else. */
function roleIn(roster: Roster, qboId: string): { role: RosterRole; familyQboId: string | null } | null {
  if (roster.kind === "flat") return roster.members.some((m) => m.qboId === qboId) ? { role: "member", familyQboId: null } : null;
  for (const f of roster.families) {
    if (f.customer.qboId === qboId) return { role: "family", familyQboId: qboId };
    if (f.students.some((s) => s.qboId === qboId)) return { role: "student", familyQboId: f.customer.qboId };
    if (f.parents.some((p) => p.qboId === qboId)) return { role: "parent", familyQboId: f.customer.qboId };
  }
  return null;
}

/** The names a new or changed name must not be: every customer in the cache (inactive too) and every waiting create or rename. */
async function namesTaken(tx: Tx, cache: Cust[], except: string | null): Promise<string[]> {
  const open = await tx.select({ request: writeQueue.request }).from(writeQueue).where(inArray(writeQueue.state, ["waiting", "stuck"]));
  return [...cache.filter((c) => c.qboId !== except).map((c) => c.displayName),
    ...open.map((o) => o.request).filter((w) => w.op === "create" || w.op === "rename").map((w) => (w as { name: string }).name)];
}

/**
 * A write ready to send, with the app's records a queue item for it is filed under: `familyId`, the family it is under
 * or about (a member's own, in flat books), and `studentId`, the student a rename, move or make-inactive is for. Each
 * is null where the records have none: a new family or member (made after QuickBooks answers), a parent's own customer
 * (a parent has no family or student record), or a customer with no record of that kind. What is sent is the write.
 */
type Prepared = { ok: true; write: RosterWrite; realmId: string; familyId: AppFamilyId | null; studentId: AppStudentId | null; tag: string; name: string | null } | { ok: false; result: WriteResult };

/**
 * The app's records a write is filed under, through links of the kind each names (src/lib/families/links.ts), in the
 * caller's transaction: the family's by its customer (`familyQboId`, or the member's own for a member's change), and a
 * student's change's student by the student's customer.
 */
async function recordsOf(tx: Tx, write: RosterWrite, familyQboId: string | null): Promise<{ familyId: AppFamilyId | null; studentId: AppStudentId | null }> {
  const familyCustomer = familyQboId ?? (write.op !== "create" && write.role === "member" ? write.qboId : null);
  const familyId = familyCustomer === null ? null : await familyLinkedTo(familyCustomer, tx);
  const studentId = write.op !== "create" && write.role === "student" ? await studentLinkedTo(write.qboId, tx) : null;
  return { familyId, studentId };
}

/**
 * Everything checked before anything is sent, under the roster lock (lockRosterAs): the page was shown this company's
 * roster, QuickBooks is connected to that company, the shape offers the change, every id is on the roster in the role
 * the change needs, nothing is waiting for the same record (nor for the family a new record or a move goes into), and the
 * name is free. Returns the write as it will be sent.
 */
async function prepare(ask: WriteAsk, rosterTag: string): Promise<Prepared> {
  const no = (error: string): Prepared => ({ ok: false, result: refuse(error) });
  return db.transaction(async (tx): Promise<Prepared> => {
    if (!(await lockRosterAs(tx, rosterTag))) return no(ROSTER_MOVED);
    const [shape, source, conn, types] = await Promise.all([getShape(tx), getRosterSource(tx), getConnection(tx), tx.select().from(qboCustomerType)]);
    if (!conn?.realmId || !conn.refreshTokenCiphertext) return no(WRITE_COPY.notConnected);
    if (source === null || source !== conn.realmId) return no(WRITE_COPY.otherCompany);
    if (!shape || missingTypes(shape, types.map((t) => ({ qboId: t.qboId, name: t.name, active: t.active }))).length) return no(WRITE_COPY.noRoster);
    const cache = await cacheRows(tx);
    const roster = buildRoster(shape, cache);
    const byId = new Map(cache.map((c) => [c.qboId, c]));
    const allowed = (op: RosterOperation) => offers(shape, op);
    // The app's records are found here, under the roster lock, from the same roster the write was checked against.
    const done = async (write: RosterWrite, familyQboId: string | null, name: string | null = null): Promise<Prepared> =>
      ({ ok: true, write, realmId: source, ...(await recordsOf(tx, write, familyQboId)), tag: rosterTag, name });
    // A change still waiting or stuck for this record: a family's too, before anyone is added to it or moved into it
    // (a waiting "make inactive" would land after them).
    const waitingFor = async (qboId: string) => (await tx.select({ id: writeQueue.id }).from(writeQueue)
      .where(and(eq(writeQueue.targetQboId, qboId), inArray(writeQueue.state, ["waiting", "stuck"]))).limit(1)).length > 0;

    if (ask.op === "create") {
      const op: RosterOperation = ask.role === "family" ? "create_family" : ask.role === "member" ? "create_member" : ask.role === "student" ? "add_student" : "add_parent";
      if (!allowed(op)) return no(WRITE_COPY.notOffered);
      const typeQboId = typeForNew(shape, ask.role, ask.role === "member" ? ask.typeQboId : null);
      if (typeQboId === null) return no(ask.role === "member" ? "Choose which kind of member this is." : WRITE_COPY.notOffered);
      let familyQboId: string | null = null;
      if (ask.role === "student" || ask.role === "parent") {
        const family = ask.familyQboId === null ? null : roleIn(roster, ask.familyQboId);
        if (!family || family.role !== "family") return no(WRITE_COPY.gone);
        if (!byId.get(ask.familyQboId!)!.active) return no("This family is inactive in QuickBooks, so nobody can be added to it.");
        if (await waitingFor(ask.familyQboId!)) return no(WRITE_COPY.waiting);
        familyQboId = ask.familyQboId;
      }
      let email: string | null = null;
      if (ask.role === "parent") {
        email = normalizeEmail(ask.email ?? "");
        if (email === null || email.length > 100) return no("Enter the parent's own email address: they sign in to the portal with it.");
      }
      const name = checkName(ask.name);
      if (!name.ok) return no(name.error);
      const offer = freeName(name.name, await namesTaken(tx, cache, null));
      if (offer) return { ok: false, result: taken(name.name, offer) };
      return done({ op: "create", role: ask.role, name: name.name, typeQboId, familyQboId, email }, familyQboId);
    }

    const record = byId.get(ask.qboId);
    const where = record ? roleIn(roster, record.qboId) : null;
    if (!record || !where) return no(WRITE_COPY.gone);
    if (await waitingFor(record.qboId)) return no(WRITE_COPY.waiting);

    if (ask.op === "rename") {
      if (!allowed(renameOf(where.role))) return no(WRITE_COPY.notOffered);
      const name = checkName(ask.name);
      if (!name.ok) return no(name.error);
      if (name.name === record.displayName) return no("That is its name already, so there was nothing to change.");
      const offer = freeName(name.name, await namesTaken(tx, cache, record.qboId));
      if (offer) return { ok: false, result: taken(name.name, offer) };
      return done({ op: "rename", role: where.role, qboId: record.qboId, syncToken: ask.syncToken, name: name.name, was: record.displayName }, where.familyQboId);
    }
    if (ask.op === "move") {
      if (where.role !== "student" || !allowed("move_student")) return no(WRITE_COPY.notOffered);
      const to = roleIn(roster, ask.toFamilyQboId);
      if (!to || to.role !== "family") return no(WRITE_COPY.gone);
      if (ask.toFamilyQboId === where.familyQboId) return no("The student is in that family already, so there was nothing to change.");
      if (!byId.get(ask.toFamilyQboId)!.active) return no("That family is inactive in QuickBooks, so nobody can be moved to it.");
      if (await waitingFor(ask.toFamilyQboId)) return no(WRITE_COPY.waiting);
      return done({ op: "move", role: "student", qboId: record.qboId, syncToken: ask.syncToken, fromFamilyQboId: where.familyQboId!, toFamilyQboId: ask.toFamilyQboId }, where.familyQboId);
    }
    if (!allowed(deactivateOf(where.role))) return no(WRITE_COPY.notOffered);
    if (!record.active) return no("That is inactive in QuickBooks already, so there was nothing to change.");
    // A layered club's family goes with everyone under it, deepest first (askFamilyInactive): QuickBooks refuses a family
    // while a customer under it is active.
    if (where.role === "family") return no(familyHereWords(record.displayName));
    return done({ op: "deactivate", role: where.role, qboId: record.qboId, syncToken: ask.syncToken }, where.familyQboId, record.displayName);
  });
}

/** Sends a prepared write to QuickBooks: the one place that calls the client's roster writes. */
export async function sendWrite(w: RosterWrite, realmId: string, o: { mayWait: boolean }): Promise<Record<string, unknown>> {
  const opts = { realmId, mayWait: o.mayWait, timeoutMs: SEND_TIMEOUT_MS, signal: AbortSignal.timeout(SEND_TIMEOUT_MS * 1.5) };
  switch (w.op) {
    case "create": return qboCreateCustomer({ name: w.name, typeQboId: w.typeQboId, parentQboId: w.familyQboId, billWithParent: w.role === "student", email: w.email }, opts);
    case "rename": return qboRenameCustomer(w.qboId, w.syncToken, w.name, opts);
    case "move": return qboMoveCustomer(w.qboId, w.syncToken, w.toFamilyQboId, opts);
    case "deactivate": return qboSetCustomerActive(w.qboId, w.syncToken, false, opts);
  }
}

const AUDIT_ACTION = { create: "roster.customer.create", rename: "roster.customer.rename", move: "roster.student.move", deactivate: "roster.customer.deactivate" } as const;
const tokenNumber = (t: string | null | undefined) => (t && /^\d{1,20}$/.test(t) ? BigInt(t) : BigInt(-1));
const isRow = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Puts a customer QuickBooks sent into the cache, only when it is newer than what the cache holds (a higher SyncToken)
 * or not there at all: a refresh that ran meanwhile may already have stored a later version. Contact details are kept
 * only for a customer the shape names, as the refresh keeps them. Returns the row as the cache now has it, and whether
 * the cache took the answer (`took`).
 */
async function upsertFromAnswer(tx: Tx, answer: Record<string, unknown>, shape: MembershipShape | null) {
  const row = customerRow(answer, new Set(shapeTypeIds(shape)), new Date());
  if (!row) return { stored: null, took: false };
  const [cached] = await tx.select().from(qboCustomer).where(eq(qboCustomer.qboId, row.qboId)).for("update");
  if (cached && tokenNumber(cached.syncToken) >= tokenNumber(row.syncToken)) return { stored: cached, took: false };
  if (cached) await tx.update(qboCustomer).set(row).where(eq(qboCustomer.qboId, row.qboId));
  else await tx.insert(qboCustomer).values(row);
  return { stored: row, took: true };
}

/** Whether QuickBooks' answer is the customer the write was about: the same id for an update, the new name for a create. */
function answerIsFor(w: RosterWrite, answer: Record<string, unknown>): boolean {
  if (w.op === "create") return typeof answer.Id === "string" && nameKey(String(answer.DisplayName ?? "")) === nameKey(w.name);
  return answer.Id === w.qboId;
}

/** The record before a write, and what the write asked for, for the audit row. */
function auditBefore(w: RosterWrite, cached: CachedCustomer | undefined) {
  if (w.op === "create") return null;
  return { name: cached?.displayName ?? null, active: cached?.active ?? null, familyQboId: cached?.parentQboId ?? null, syncToken: w.syncToken };
}
function auditAfter(w: RosterWrite, answer: Record<string, unknown>) {
  const parent = isRow(answer.ParentRef) && typeof answer.ParentRef.value === "string" ? answer.ParentRef.value : null;
  return { role: w.role, name: typeof answer.DisplayName === "string" ? answer.DisplayName.slice(0, 200) : null, active: answer.Active !== false,
    familyQboId: parent, syncToken: typeof answer.SyncToken === "string" ? answer.SyncToken : null, ...(w.op === "create" && w.email ? { email: w.email } : {}) };
}

/**
 * The part of a student's move that other parts of the portal follow, in the transaction that brings the cache up to
 * date, after the student is stored under the new family. In this order: the student's signature requests
 * (formsForMovedStudent, src/lib/forms/moved.ts: a complete one moves with its evidence, any other is reset under the
 * new family and its document queued for the worker to withdraw), then the student's volunteer places
 * (volunteerForMovedStudent, src/lib/volunteer/moved-student.ts: places on shifts still to come are given up, credit
 * stays with the family it was earned for), then its per-student buy-outs (buyoutsForMovedStudent, src/lib/buyouts/moved.ts:
 * an unpaid invoice queued to void, anything else flagged), then the audit row of the move's follow-up with their counts. The answer's
 * `tell` emails the guardians whose places were given up: call it after the transaction commits.
 */
export async function afterStudentMoved(tx: Tx, move: { studentQboId: string; fromFamilyQboId: string; toFamilyQboId: string; cause: string },
  o: { actor: Actor; ip: string | null }): Promise<{ tell: () => Promise<unknown> }> {
  const who = { studentQboId: move.studentQboId, fromFamilyQboId: move.fromFamilyQboId, toFamilyQboId: move.toFamilyQboId };
  const forms = await formsForMovedStudent(tx, { ...who, actor: o.actor, ip: o.ip });
  const volunteer = await volunteerForMovedStudent(tx, who, { actor: o.actor, ip: o.ip });
  const buyouts = await buyoutsForMovedStudent(tx, who, { actor: o.actor, ip: o.ip });
  await writeAudit({ actor: { door: "system", id: null, label: "roster" }, action: "roster.student.move.followed", targetType: "qbo_customer", targetId: move.studentQboId,
    after: { fromFamilyQboId: move.fromFamilyQboId, toFamilyQboId: move.toFamilyQboId, cause: move.cause,
      formsMoved: forms.moved, formsReset: forms.reset, formsToWithdraw: forms.toWithdraw.length, placesGivenUp: volunteer.cancelled,
      buyoutsToVoid: buyouts.voiding, buyoutsFlagged: buyouts.flagged } }, tx);
  return { tell: volunteer.tell };
}

/**
 * What follows a write QuickBooks said yes to (spec 6.1: QuickBooks first, then the cache from its answer). In one
 * transaction that holds the roster lock: when the cache is still the company the write was sent to, the customer is
 * stored from the answer (only if newer), a moved student's follow-ups run, a family made inactive asks the worker for
 * a roster refresh (QuickBooks may have changed the customers under it), and the reconcile brings sign-ins in line (a
 * new parent can sign in at once; an inactive family, student or parent ends what the rules say). The write is audited
 * with before and after, whether or not the cache could take it. `inside` runs last, in the same transaction. When
 * that transaction fails, the change is still audited (code cache_failed) and a refresh asked for; `cached` says so.
 */
export async function applyWritten(w: RosterWrite, answer: Record<string, unknown>, o: { realmId: string; actor: Actor; ip: string | null; permission?: string;
  queueId?: string; inside?: (tx: Tx) => Promise<void> }): Promise<{ cached: boolean }> {
  let tell: (() => Promise<unknown>) | null = null;
  try {
    await db.transaction(async (tx) => {
      const ours = await lockRosterAs(tx, rosterTagOf(o.realmId));
      const [cached] = w.op === "create" ? [] : await tx.select().from(qboCustomer).where(eq(qboCustomer.qboId, w.qboId));
      const cause = `${AUDIT_ACTION[w.op]}#${w.op === "create" ? nameKey(w.name).slice(0, 40) : w.qboId}`;
      const fits = answerIsFor(w, answer);
      let refreshAsked = false;
      let appRecords = noAppRecordChanges();
      if (ours && fits) {
        await upsertFromAnswer(tx, answer, await getShape(tx));
        if (w.op === "move") ({ tell } = await afterStudentMoved(tx, { studentQboId: w.qboId, fromFamilyQboId: w.fromFamilyQboId, toFamilyQboId: w.toFamilyQboId, cause }, o));
        if (w.op === "deactivate" && w.role === "family") { await askForRosterRefresh(tx); refreshAsked = true; }
        ({ appRecords } = await reconcileAccess(tx, { cause }));
      } else if (ours) {
        await askForRosterRefresh(tx); refreshAsked = true; // the answer wasn't the record asked about: read the roster again rather than guess
      }
      await writeAudit({ actor: o.actor, action: AUDIT_ACTION[w.op], permission: o.permission, ip: o.ip, targetType: "qbo_customer",
        targetId: w.op === "create" ? (typeof answer.Id === "string" ? answer.Id.slice(0, 64) : "unknown") : w.qboId,
        before: auditBefore(w, cached), after: { ...auditAfter(w, answer), ...(o.queueId ? { queueId: o.queueId } : {}), ...(refreshAsked ? { refreshAsked } : {}),
          ...(!ours ? { code: "company_changed" } : !fits ? { code: "answer_other" } : {}), ...appRecordsAudit(appRecords) } }, tx);
      if (o.inside) await o.inside(tx);
    });
  } catch {
    // QuickBooks made the change but the cache couldn't take it (a deadlock, a follow-up that failed): nothing of that
    // transaction is kept, so the change is audited here with its code, the worker is asked for a roster refresh, and
    // a queued item is marked as possibly made, so it is looked for after that refresh and never simply sent again.
    tell = null;
    await db.transaction(async (tx) => {
      await askForRosterRefresh(tx);
      await writeAudit({ actor: o.actor, action: AUDIT_ACTION[w.op], permission: o.permission, ip: o.ip, targetType: "qbo_customer",
        targetId: w.op === "create" ? (typeof answer.Id === "string" ? answer.Id.slice(0, 64) : "unknown") : w.qboId,
        before: w.op === "create" ? null : { syncToken: w.syncToken },
        after: { ...auditAfter(w, answer), ...(o.queueId ? { queueId: o.queueId } : {}), refreshAsked: true, code: "cache_failed" } }, tx);
      if (o.queueId) {
        await tx.update(writeQueue).set({ sent: true, lastCode: "cache_failed", tries: sql`${writeQueue.tries} + 1`, lastTriedAt: new Date(), nextTryAt: new Date(Date.now() + 60_000), updatedAt: new Date() })
          .where(and(eq(writeQueue.id, o.queueId), eq(writeQueue.state, "waiting")));
      }
    });
    return { cached: false };
  }
  // The guardians whose places a moved student gave up are told once the move is committed. A mail failure is the
  // notices' own to record; it never undoes the move.
  if (tell) await (tell as () => Promise<unknown>)().catch(() => undefined);
  return { cached: true };
}

/** Puts a write that may go through later on the queue, audited, in one transaction. */
async function enqueue(p: { write: RosterWrite; realmId: string; familyId: AppFamilyId | null; studentId: AppStudentId | null }, code: string, sent: boolean, o: WriteOp & { staffUserId: string | null }): Promise<void> {
  await db.transaction(async (tx) => {
    const [item] = await tx.insert(writeQueue).values({
      realmId: p.realmId, request: p.write, targetQboId: p.write.op === "create" ? null : p.write.qboId, familyId: p.familyId, studentId: p.studentId,
      sent, lastCode: code.slice(0, 40), nextTryAt: new Date(Date.now() + 60_000), askedBy: o.staffUserId, askedByLabel: o.actor.label,
    }).returning({ id: writeQueue.id });
    await writeAudit({ actor: o.actor, action: "roster.write.queued", permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: item!.id,
      after: { op: p.write.op, role: p.write.role, code: code.slice(0, 40), sent } }, tx);
  });
}

/**
 * The record read again after it changed in QuickBooks, stored in the cache when newer, as the page shows it. When the
 * cache took it, or the app's own records changed with it, that is audited (`roster.customer.read_again`) in the same
 * transaction, as the staff change that led to it.
 */
async function readAgain(qboId: string, realmId: string, o: { actor: Actor; ip: string | null; permission?: string }): Promise<CurrentRecord | null> {
  let answer: Record<string, unknown> | null;
  try { answer = await qboCustomerById(qboId, { failFast: true, realmId, timeoutMs: 5_000 }); } catch (e) { if (e instanceof QboError) return null; throw e; }
  if (!answer || answer.Id !== qboId) return null;
  return db.transaction(async (tx) => {
    if (!(await lockRosterAs(tx, rosterTagOf(realmId)))) return null;
    const shape = await getShape(tx);
    const { stored, took } = await upsertFromAnswer(tx, answer, shape);
    const { appRecords } = await reconcileAccess(tx, { cause: `roster.read_again#${qboId}` });
    if (took || changedAppRecords(appRecords)) {
      await writeAudit({ actor: o.actor, action: "roster.customer.read_again", permission: o.permission, ip: o.ip, targetType: "qbo_customer", targetId: qboId,
        after: { cached: took, syncToken: stored?.syncToken ?? null, ...appRecordsAudit(appRecords) } }, tx);
    }
    // Shown as QuickBooks has it now, from this read: the cache keeps a row of the same version it already holds (an
    // answer is stored only when newer), so its values can lag behind what QuickBooks just showed.
    const row = stored ? customerRow(answer, new Set(shapeTypeIds(shape)), new Date()) ?? stored : null;
    if (!row) return null;
    const [family] = row.parentQboId ? await tx.select({ name: qboCustomer.displayName }).from(qboCustomer).where(eq(qboCustomer.qboId, row.parentQboId)) : [];
    return { name: row.displayName, active: row.active, familyName: family?.name ?? null };
  });
}

/**
 * A staff member's change to the roster, sent to QuickBooks first; the cache follows QuickBooks' answer (spec §6.1).
 * `ask` came from a browser: every id in it is looked up in the cache under the roster lock, in the role the change
 * needs, and the page's roster tag must be the company's the cache holds now. A taken name is answered with a free one
 * to offer; nothing is renamed without staff saying so. A record changed in QuickBooks meanwhile is not overwritten
 * and not queued: it is read again and shown (spec §6.3). What may go through later is queued; nothing else is.
 */
export async function askRosterWrite(ask: WriteAsk, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  const audited = async (code: string, write: RosterWrite | null, target: string | null) => writeAudit({ actor: o.actor, action: "roster.write.refused", permission: o.permission, ip: o.ip,
    targetType: "qbo_customer", ...(target ? { targetId: target } : {}), after: { op: ask.op, ...(write ? { role: write.role } : {}), code: code.slice(0, 40) } });
  const p = await prepare(ask, rosterTag);
  if (!p.ok) return p.result;
  const target = p.write.op === "create" ? p.write.familyQboId : p.write.qboId;
  if (p.write.op === "deactivate") {
    // Nobody with a balance is made inactive (the owner's decision of 2026-11-17): what they owe is read first, and
    // nothing is sent while they owe anything. A credit is left to QuickBooks. A read that may go through later puts
    // the change on the queue, as a send that couldn't go would, marked as never sent.
    const owed = await owedBy(p.write.qboId, p.realmId);
    const name = p.name ?? "This customer";
    if (!owed.ok) {
      const failure = classify(owed.code);
      if (failure.kind === "retry") {
        await enqueue(p, owed.code, false, { ...o, staffUserId: o.staffUserId });
        return { ok: true, queued: true, message: WRITE_COPY.queued };
      }
      await audited(owed.code, p.write, target);
      return refuse(unreadWords(owed.code));
    }
    // What the read shows of the record: already inactive there, or changed since the page, is said and not sent; the
    // record read again is stored and shown (spec §6.3), and the pages are made again.
    if (!owed.active || movedOn(owed, p.write.syncToken)) {
      await audited(owed.active ? "moved_on" : "already_inactive", p.write, target);
      const current = await readAgain(p.write.qboId, p.realmId, o);
      // Inactive there at the version the cache holds: the cache is behind QuickBooks, so the roster is read again.
      if (!owed.active) await db.transaction((tx) => askForRosterRefresh(tx));
      const said = owed.active ? WRITE_COPY.changed : "That is inactive in QuickBooks already, so there was nothing to change.";
      return current ? { ok: false, errors: [said], current } : refuse(owed.active ? WRITE_COPY.changedUnseen : said);
    }
    if (owed.cents > 0) {
      await audited("open_balance", p.write, target);
      return refuse(`${owesWords(name, owed, o.showAmounts === true)} They weren't made inactive. ${WRITE_COPY.balanceFix}`);
    }
  }
  let answer: Record<string, unknown>;
  try {
    answer = await sendWrite(p.write, p.realmId, { mayWait: false });
  } catch (e) {
    if (!(e instanceof QboError)) throw e;
    const failure = classify(e.code);
    switch (failure.kind) {
      case "retry":
        await enqueue(p, e.code, failure.sent, { ...o, staffUserId: o.staffUserId });
        return { ok: true, queued: true, message: WRITE_COPY.queued };
      case "stale": {
        await audited(e.code, p.write, target);
        const current = p.write.op === "create" ? null : await readAgain(p.write.qboId, p.realmId, o);
        return current ? { ok: false, errors: [WRITE_COPY.changed], current } : refuse(WRITE_COPY.changedUnseen);
      }
      case "duplicate": {
        // A vendor or an employee has it, or a customer the cache doesn't know yet: offer the next free name.
        await audited(e.code, p.write, target);
        const name = (p.write as { name?: string }).name ?? "";
        const names = await db.transaction(async (tx) => namesTaken(tx, await cacheRows(tx), p.write.op === "rename" ? p.write.qboId : null));
        const offer = freeName(name, [...names, name]);
        return offer ? taken(name, offer) : refuse(WRITE_COPY.refused);
      }
      default: {
        await audited(e.code, p.write, target);
        const said = p.write.op === "deactivate" ? refusalWords(e.code, p.name ?? "This customer") : null;
        if (said) return refuse(said);
        return refuse(failure.kind === "not_connected" ? WRITE_COPY.notConnected : failure.kind === "needs_admin" ? WRITE_COPY.needsAdmin
          : failure.kind === "other_company" ? WRITE_COPY.otherCompany : e.code === "bad_id" ? WRITE_COPY.notSent : WRITE_COPY.refused);
      }
    }
  }
  const { cached } = await applyWritten(p.write, answer, { realmId: p.realmId, actor: o.actor, ip: o.ip, permission: o.permission });
  return { ok: true, message: cached ? DONE_WORDS[p.write.op] : WRITE_COPY.doneNotShown };
}

const DONE_WORDS: Record<RosterWrite["op"], string> = {
  create: "Done. QuickBooks has it, and the roster shows it now.",
  rename: "Renamed in QuickBooks.",
  move: "Moved in QuickBooks.",
  deactivate: "Made inactive in QuickBooks.",
};

/** The editing details of one family or member on its page: each record's version, for the forms that change it. */
export async function versionsOf(qboIds: string[]): Promise<Map<string, string>> {
  if (!qboIds.length) return new Map();
  const rows = await db.select({ qboId: qboCustomer.qboId, syncToken: qboCustomer.syncToken }).from(qboCustomer).where(inArray(qboCustomer.qboId, qboIds));
  return new Map(rows.map((r) => [r.qboId, r.syncToken]));
}

/* ---- Making a family inactive: one action for staff, several writes for the portal (the owner's decision of 2026-11-17) ----
   QuickBooks refuses to make a family inactive while a customer under it is still active (code 800, seen in the
   sandbox), so the portal makes every active customer under the family inactive first, deepest first, and the family
   last, each through the same write, sendWrite() and applyWritten(), as one student or parent is. It is never queued:
   when it stops part way it says what is now true, and pressing it again carries on with whoever is still active. */

/** A customer the family action covers, with the version the page was shown. `depth` 1 is directly under the family. */
export type Covered = { qboId: string; name: string; syncToken: string; depth: number };

const byDepthThenName = (a: Covered, b: Covered) => b.depth - a.depth || a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.qboId.localeCompare(b.qboId, "en", { numeric: true });

/** Every active customer the cache holds under the family, at any depth (an inactive one's own sub-customers too), deepest first, then by name. */
function activeUnder(cache: (Cust & { syncToken: string })[], familyQboId: string): Covered[] {
  const children = new Map<string, (Cust & { syncToken: string })[]>();
  for (const c of cache) if (c.parentQboId) children.set(c.parentQboId, [...(children.get(c.parentQboId) ?? []), c]);
  const out: Covered[] = [], seen = new Set<string>([familyQboId]);
  let level = children.get(familyQboId) ?? [], depth = 1;
  while (level.length) {
    const next: (Cust & { syncToken: string })[] = [];
    for (const c of level) {
      if (seen.has(c.qboId)) continue; // a loop in the cache is walked once
      seen.add(c.qboId);
      if (c.active) out.push({ qboId: c.qboId, name: c.displayName, syncToken: c.syncToken, depth });
      next.push(...(children.get(c.qboId) ?? []));
    }
    level = next; depth++;
  }
  return out.sort(byDepthThenName);
}

/**
 * Who making this family inactive covers, as the roster cache holds it now: the family, and every active customer under
 * it at any depth, in the order they would be made inactive (deepest first). For the family's page, which shows the
 * names and binds the ids and versions into its form. Null when the cache holds no such customer.
 */
export async function familyCover(familyQboId: string): Promise<{ family: Covered; under: Covered[] } | null> {
  const cache = await db.transaction((tx) => cacheRows(tx));
  const f = cache.find((c) => c.qboId === familyQboId);
  if (!f) return null;
  return { family: { qboId: f.qboId, name: f.displayName, syncToken: f.syncToken, depth: 0 }, under: activeUnder(cache, familyQboId) };
}

type FamilyStep = { write: Extract<RosterWrite, { op: "deactivate" }>; name: string };
type PreparedFamily = { ok: true; realmId: string; familyName: string; steps: FamilyStep[] } | { ok: false; result: WriteResult };

/**
 * Everything checked before anything is sent, under the roster lock, as prepare() checks one write: the page was shown
 * this company's roster, QuickBooks is connected to it, the shape offers making a family inactive, the id is an active
 * family on the roster, nothing is waiting for it or anyone under it, and the list the page showed still holds everyone
 * active under it, each at the version shown (a list someone has since been added to is refused: staff confirm whom it
 * covers). Someone shown who is inactive now is passed over: that is how pressing it again carries on.
 */
async function prepareFamily(familyQboId: string, shown: ReadonlyMap<string, string>, rosterTag: string): Promise<PreparedFamily> {
  const no = (error: string): PreparedFamily => ({ ok: false, result: refuse(error) });
  return db.transaction(async (tx): Promise<PreparedFamily> => {
    if (!(await lockRosterAs(tx, rosterTag))) return no(ROSTER_MOVED);
    const [shape, source, conn, types] = await Promise.all([getShape(tx), getRosterSource(tx), getConnection(tx), tx.select().from(qboCustomerType)]);
    if (!conn?.realmId || !conn.refreshTokenCiphertext) return no(WRITE_COPY.notConnected);
    if (source === null || source !== conn.realmId) return no(WRITE_COPY.otherCompany);
    if (!shape || missingTypes(shape, types.map((t) => ({ qboId: t.qboId, name: t.name, active: t.active }))).length) return no(WRITE_COPY.noRoster);
    if (shape.kind !== "layered" || !offers(shape, "deactivate_family")) return no(WRITE_COPY.notOffered);
    const cache = await cacheRows(tx);
    const roster = buildRoster(shape, cache);
    const where = roleIn(roster, familyQboId);
    const family = cache.find((c) => c.qboId === familyQboId);
    if (!family || !where || where.role !== "family") return no(WRITE_COPY.gone);
    if (!family.active) return no("That family is inactive in QuickBooks already, so there was nothing to change.");
    const under = activeUnder(cache, familyQboId);
    for (const c of [family, ...under]) if (shown.get(c.qboId) !== c.syncToken) return no(WRITE_COPY.coverChanged);
    const ids = [familyQboId, ...under.map((u) => u.qboId)];
    const waiting = await tx.select({ id: writeQueue.id }).from(writeQueue).where(and(inArray(writeQueue.targetQboId, ids), inArray(writeQueue.state, ["waiting", "stuck"]))).limit(1);
    if (waiting.length) return no(WRITE_COPY.waiting);
    const roleOf = (qboId: string): FamilyStep["write"]["role"] => {
      const r = roleIn(roster, qboId);
      return r && r.familyQboId === familyQboId && (r.role === "student" || r.role === "parent") ? r.role : "other";
    };
    const steps: FamilyStep[] = [
      ...under.map((u) => ({ write: { op: "deactivate" as const, role: roleOf(u.qboId), qboId: u.qboId, syncToken: u.syncToken }, name: u.name })),
      { write: { op: "deactivate", role: "family", qboId: familyQboId, syncToken: family.syncToken }, name: family.displayName },
    ];
    return { ok: true, realmId: source, familyName: family.displayName, steps };
  });
}

/** Names in a sentence: "A", "A and B", "A, B and C". */
const listed = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * Why one step of the family action stopped, in words for staff, and what follows it: a record changed in QuickBooks is
 * read again (spec §6.3); a write whose answer was lost, and a family QuickBooks still won't take while someone the
 * cache doesn't show is under it (800), ask the worker for a roster refresh. `maybe`: the step may have been made.
 * `changed`: the cache or the refresh ask changed, so the pages are made again.
 */
async function stepStopped(e: QboError, step: FamilyStep, realmId: string, o: WriteOp): Promise<{ words: string; maybe: boolean; changed: boolean }> {
  const name = step.name, isFamily = step.write.role === "family";
  if (isFamily && e.code === `fault_${CUSTOMER_WRITES.faults.activeUnder}`) {
    await db.transaction((tx) => askForRosterRefresh(tx));
    return { words: `QuickBooks won't make ${name} inactive while customers under it are still active, and it has someone under ${name} the roster here doesn't show yet, so ${name} wasn't changed. The roster is being read again: try again in a few minutes.`, maybe: false, changed: true };
  }
  const said = refusalWords(e.code, name);
  if (said) return { words: said, maybe: false, changed: false };
  const failure = classify(e.code);
  switch (failure.kind) {
    case "stale":
      await readAgain(step.write.qboId, realmId, o);
      // The family's last step carries the version read just before it, so a refusal now is a change made while this ran.
      return { words: isFamily ? `${name} changed in QuickBooks while this was running, so it wasn't made inactive. Press “Make ${name} inactive” again.`
        : `${name} changed in QuickBooks since the page was shown, so it wasn't changed. Reload the page to see it as QuickBooks has it now.`, maybe: false, changed: true };
    case "retry":
      if (failure.sent) {
        await db.transaction((tx) => askForRosterRefresh(tx));
        return { words: `The portal can't tell whether QuickBooks made ${name} inactive: its answer didn't arrive. The roster is read again within a few minutes to see.`, maybe: true, changed: true };
      }
      return { words: `QuickBooks couldn't take that just now, so ${name} wasn't changed. Try again in a few minutes.`, maybe: false, changed: false };
    case "not_connected": return { words: `${name} wasn't changed. ${WRITE_COPY.notConnected}`, maybe: false, changed: false };
    case "needs_admin": return { words: `${name} wasn't changed. ${WRITE_COPY.needsAdmin}`, maybe: false, changed: false };
    case "other_company": return { words: `${name} wasn't changed. ${WRITE_COPY.otherCompany}`, maybe: false, changed: false };
    default:
      return { words: e.code === "bad_id" ? `${name} couldn't be sent to QuickBooks, so it wasn't changed.` : `QuickBooks wouldn't make ${name} inactive, so it wasn't changed. Check it in QuickBooks.`, maybe: false, changed: false };
  }
}

/** What the family action answers: the result to show, and whether anything may have changed (the pages are then made again). */
export type FamilyInactiveAnswer = { result: WriteResult; changed: boolean };

/**
 * Makes a family inactive in QuickBooks, with every active customer under it, as staff confirmed on the family's page
 * (`shown`: each id the page listed, the family's too, with the version it showed). In this order:
 *   1. prepareFamily(): every check one write gets, for the family and everyone under it, under the roster lock;
 *   2. each of them read live from QuickBooks: when any of them owes anything, nothing is sent at all, and staff are
 *      told who (with the amount only for Finance.Balance.Read) and that it must be paid or written off first. The same
 *      read stops it before anything is sent when a version there is newer than the one the page showed, and passes
 *      over anyone it shows already inactive;
 *   3. each made inactive, deepest first and the family last, each through sendWrite() and applyWritten(): QuickBooks
 *      first, then the cache from its answer under the roster lock, with the reconcile, its follow-ups and its audit row.
 *      The family's own last step is the one exception to carrying the version the page showed: the family is read
 *      once more after its members' writes, and sent with the version just read, since QuickBooks may raise it when a
 *      customer under it changes. Its version was the page's when the action began (step 2), the write sets only the
 *      inactive flag, and the window is the seconds of the action itself, so nothing anyone changed is overwritten.
 * The first step that doesn't go through stops it: staff are told who was made inactive, who wasn't and why, and that
 * the family is still active. Nothing of it is queued. One audit row (roster.family.deactivate) says how it went.
 */
export async function askFamilyInactive(familyQboId: string, shown: ReadonlyArray<readonly [string, string]>, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<FamilyInactiveAnswer> {
  const summary = (outcome: "done" | "stopped" | "refused", code: string | null, made: string[], notMade: string[], more: { maybe?: string[]; alreadyInactive?: string[] } = {}) =>
    writeAudit({ actor: o.actor, action: "roster.family.deactivate", permission: o.permission, ip: o.ip, targetType: "qbo_customer", targetId: familyQboId,
      after: { outcome, ...(code ? { code: code.slice(0, 40) } : {}), made, notMade, ...(more.maybe?.length ? { maybe: more.maybe } : {}), ...(more.alreadyInactive?.length ? { alreadyInactive: more.alreadyInactive } : {}) } });
  const p = await prepareFamily(familyQboId, new Map(shown), rosterTag);
  if (!p.ok) return { result: p.result, changed: false };
  const ids = p.steps.map((s) => s.write.qboId);

  // 2. Each read before anything is sent: what it owes, whether it is active there, and its version.
  const owing: string[] = [], already = new Set<string>();
  for (const step of p.steps) {
    const owed = await owedBy(step.write.qboId, p.realmId);
    if (!owed.ok) {
      await summary("refused", owed.code, [], ids);
      return { result: refuse(unreadWords(owed.code)), changed: false };
    }
    if (movedOn(owed, step.write.syncToken)) {
      await readAgain(step.write.qboId, p.realmId, o);
      await summary("refused", "moved_on", [], ids);
      return { result: refuse(`${step.name} changed in QuickBooks since the page was shown, so nothing was changed. Look at the list again, and confirm it.`), changed: true };
    }
    if (!owed.active) { already.add(step.write.qboId); continue; }
    if (owed.cents > 0) owing.push(owesWords(step.name, owed, o.showAmounts === true));
  }
  const alreadyInactive = [...already];
  if (already.size) await db.transaction((tx) => askForRosterRefresh(tx)); // the cache is behind QuickBooks: read it again
  if (already.has(familyQboId)) {
    await summary("refused", "already_inactive", [], ids, { alreadyInactive });
    return { result: refuse(`${p.familyName} is inactive in QuickBooks already, so there was nothing to change. The roster is being read again to show it.`), changed: true };
  }
  if (owing.length) {
    await summary("refused", "open_balance", [], ids, { alreadyInactive });
    return { result: { ok: false, errors: [...owing, `Nobody was made inactive. ${WRITE_COPY.balanceFix}`] }, changed: already.size > 0 };
  }

  // 3. Deepest first, the family last; anyone QuickBooks shows inactive already is passed over.
  const steps = p.steps.filter((s) => !already.has(s.write.qboId));
  const made: FamilyStep[] = [];
  let allShown = true;
  const stop = async (i: number, code: string, why: { words: string; maybe: boolean; changed: boolean }) => {
    const step = steps[i]!;
    const after = steps.slice(i + 1).filter((s) => s.write.role !== "family").map((s) => s.name);
    await summary("stopped", code, made.map((s) => s.write.qboId), steps.slice(why.maybe ? i + 1 : i).map((s) => s.write.qboId),
      { maybe: why.maybe ? [step.write.qboId] : [], alreadyInactive });
    const errors = [
      made.length ? `Made inactive in QuickBooks: ${listed(made.map((s) => s.name))}.` : "Nobody was made inactive.",
      why.words,
      ...(after.length ? [`Not made inactive yet: ${listed(after)}.`] : []),
      step.write.role === "family" && why.maybe ? `Whether ${p.familyName} is still active shows once the roster is read again.`
        : `${p.familyName} is still active. Press “Make ${p.familyName} inactive” again to carry on with whoever is still active.`,
    ];
    return { result: { ok: false as const, errors }, changed: made.length > 0 || why.changed || already.size > 0 };
  };
  for (const [i, planned] of steps.entries()) {
    let step = planned;
    if (step.write.role === "family" && made.length) {
      // Read once more: QuickBooks may have raised the family's version when the customers under it changed.
      const fresh = await owedBy(familyQboId, p.realmId);
      if (!fresh.ok) {
        return stop(i, fresh.code, { words: `${p.familyName} couldn't be read from QuickBooks again before it was made inactive, so it wasn't changed.${classify(fresh.code).kind === "retry" ? " Try again in a few minutes." : ""}`, maybe: false, changed: false });
      }
      if (fresh.cents > 0) return stop(i, "open_balance", { words: `${owesWords(p.familyName, fresh, o.showAmounts === true)} It wasn't made inactive. ${WRITE_COPY.balanceFix}`, maybe: false, changed: false });
      step = { ...step, write: { ...step.write, syncToken: fresh.syncToken ?? step.write.syncToken } };
    }
    let answer: Record<string, unknown>;
    try {
      answer = await sendWrite(step.write, p.realmId, { mayWait: false });
    } catch (e) {
      if (!(e instanceof QboError)) throw e;
      return stop(i, e.code, await stepStopped(e, step, p.realmId, o));
    }
    const { cached } = await applyWritten(step.write, answer, { realmId: p.realmId, actor: o.actor, ip: o.ip, permission: o.permission });
    if (!cached) allShown = false;
    made.push(step);
  }
  await summary("done", null, made.map((s) => s.write.qboId), [], { alreadyInactive });
  const under = made.filter((s) => s.write.role !== "family").map((s) => s.name);
  const message = under.length ? `Made inactive in QuickBooks: ${listed(under)}, then ${p.familyName}.` : `Made ${p.familyName} inactive in QuickBooks.`;
  return { result: { ok: true, message: allShown ? message : `${message} The roster here shows it after its next read of QuickBooks, usually within a few minutes.` }, changed: true };
}
