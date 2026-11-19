// Staff only: a staff member's changes to the roster in QuickBooks (v1 spec §6.1, §6.3). It loads every family in the
// club, so it is never imported by parent code (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts). It is
// the only module that may call the client's roster writes (tests/unit/quickbooks-writes.test.ts): the staff roster
// actions and the write queue's job reach QuickBooks through it.
import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { env } from "@/env";
import { db, type Tx } from "@/lib/db/client";
import { accountingLink, family, jobRun, qboCustomer, qboCustomerType, student, writeQueue, type RosterRole, type RosterWrite } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getConnection } from "@/lib/quickbooks/connection";
import { CUSTOMER_WRITES, NO_TOKEN, qboCreateCustomer, qboCustomerById, qboMoveCustomer, qboRenameCustomer, qboSetCustomerActive } from "@/lib/quickbooks/client";
import { QboError } from "@/lib/quickbooks/endpoints";
import { currencyOf, formatMoney, toCents } from "@/lib/money/cents";
import { normalizeEmail } from "@/lib/email";
import { lockRosterAs, rosterTagOf, ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { connectedToAnotherCompany, customerOfFamily, customerOfStudent, familyLinkState, familyLinkedTo, linksOf, linksOfCustomers, studentLinkedTo } from "@/lib/families/links";
import { asAppFamilyId, asAppStudentId, QUICKBOOKS, type AppFamilyId, type AppStudentId } from "@/lib/families/ids";
import { recordNameWords } from "@/lib/families/words";
import { isUuid } from "@/lib/seasons/ids";
import { askForRosterRefresh, ROSTER_ASK_KEY } from "@/lib/parents/refresh-ask";
import { formsForMovedStudent } from "@/lib/forms/moved";
import { volunteerForMovedStudent } from "@/lib/volunteer/moved-student";
import { buyoutsForMovedStudent } from "@/lib/buyouts/moved";
import { getShape, missingTypes, shapeHolds, shapeTypeIds, type MembershipShape } from "./shape";
import { buildRoster, type Cust, type Roster } from "./model";
import { getRosterSource, ROSTER_JOB } from "./source";
import { customerRow } from "./refresh";
import { checkName, freeName, nameKey } from "./names";
import { deactivateOf, offers, renameOf, typeForNew, type RosterOperation } from "./operations";
import { afterFailedTry, beforeResend, classify, type CachedCustomer } from "./write-rules";

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
  /**
   * `familyId`: for a new family or member, the portal's own family record its customer is made for (stage 3's slice
   * 9d: the record is saved first, addFamily()), which the write is filed under and linked to as QuickBooks answers. A
   * family's or member's create without one is refused: none is made QuickBooks first any more.
   */
  | { op: "create"; role: RosterRole; name: string; familyQboId: string | null; email: string | null; typeQboId: string | null; familyId?: AppFamilyId }
  /** `parentOnly`: a Parent customer's rename, the one rename sent QuickBooks first (a linked record's: renameLinked()). */
  | { op: "rename"; qboId: string; syncToken: string; name: string; parentOnly?: true }
  | { op: "move"; qboId: string; syncToken: string; toFamilyQboId: string }
  | { op: "deactivate"; qboId: string; syncToken: string };

/**
 * A record as QuickBooks has it now, read again after it changed while staff were editing (spec §6.3): only what the
 * form shows. Its new version reaches the page when the page is made again, which the action asks for.
 */
export type CurrentRecord = { name: string; active: boolean; familyName: string | null };

/**
 * `unlinked`: done in the portal, but not (or not yet) in QuickBooks: the family stands there unlinked, and the words say why.
 * `status`, for a change saved in the portal first (stage 3's slice 9e), how it stands when it isn't in both places:
 * `waiting`, saved and waiting to reach QuickBooks, or the portal can't tell yet whether QuickBooks took it (information);
 * `attention`, saved and QuickBooks refused it, the portal held it back, or it was given up meanwhile (needs attention).
 * Absent, the portal and QuickBooks both hold it (done).
 */
export type WriteResult =
  | { ok: true; message: string; queued?: true; unlinked?: true; status?: "waiting" | "attention" }
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
  notOurs: "That family isn't one of the portal's own active families, so nobody can be moved to it. Choose a family from the list on this page.",
  inactiveFollowed: "That is inactive in QuickBooks already, so nothing was sent. The portal's own record is inactive now too.",
  namedFollowed: "QuickBooks has that name already, so nothing was sent. The portal's own record has it now too.",
  movedFollowed: "QuickBooks has the student in that family already, so nothing was sent. The portal's own record of them is there now too, with what follows a move: their forms, their places on shifts still to come and their buy-outs.",
  inactiveHere: "That is inactive in the portal, so nothing was sent to QuickBooks.",
  notOursToAdd: "That family isn't one of the portal's own active families, so nobody can be added to it.",
  elsewhere: "QuickBooks has this student under another family than the portal does, so nothing was sent. On this page, move them to the family QuickBooks has them in first, which sends nothing and brings the portal's own record there; then move them on if they belong somewhere else.",
  elsewhereNotOurs: "QuickBooks has this student under a family that isn't one of the portal's own active families, so the portal's own record can't follow them there and nothing was sent. Move them to one of the portal's families on this page instead: that move is sent to QuickBooks, and their record goes with it.",
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
const ALREADY_INACTIVE = "That is inactive in QuickBooks already, so there was nothing to change.";
const ALREADY_NAMED = "That is its name already, so there was nothing to change.";
const ALREADY_THERE = "The student is in that family already, so there was nothing to change.";

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
 * is null where the records have none: a parent's own customer (a parent has no family or student record), or a
 * customer with no record of that kind. A new family's or member's create is filed under the portal's record saved
 * first (addFamily(), createInQuickBooksAndLink(): stage 3's slice 9d); only a create queued before that slice is filed
 * under none. What is sent is the write.
 * `already`: the cache shows QuickBooks has it so already (the record inactive there, with that name, or the student
 * under that family while the portal's own record is in another), so nothing is sent and the app's own record is made
 * to match what staff asked (recordFollows()).
 */
type Prepared = { ok: true; write: RosterWrite; realmId: string; familyId: AppFamilyId | null; studentId: AppStudentId | null; tag: string; name: string | null;
  already?: Already } | { ok: false; result: WriteResult };
type Already = "inactive" | "named" | "moved";

/**
 * Whether a record a write is filed under is inactive in the portal (the owner's decision for slice 9c: a write that
 * would send something for a family or student whose app record is inactive is not offered, and is refused).
 */
async function inactiveRecord(tx: Tx, r: { familyId: AppFamilyId | null; studentId: AppStudentId | null }): Promise<boolean> {
  const [f] = r.familyId === null ? [] : await tx.select({ active: family.active }).from(family).where(eq(family.id, r.familyId));
  const [s] = r.studentId === null ? [] : await tx.select({ active: student.active }).from(student).where(eq(student.id, r.studentId));
  return f?.active === false || s?.active === false;
}
/** Whether a family record is active in the portal: null when there is none. */
async function familyActiveOf(tx: Tx, familyId: AppFamilyId | null): Promise<boolean | null> {
  const [f] = familyId === null ? [] : await tx.select({ active: family.active }).from(family).where(eq(family.id, familyId));
  return f ? f.active : null;
}

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
 * the change needs, nothing is waiting for the same record (nor for the family a new record or a move goes into), the
 * name is free, and no record the write is filed under is inactive in the portal (but for a change that sends nothing:
 * a name or an inactive flag QuickBooks has already). Returns the write as it will be sent.
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
    const done = async (write: RosterWrite, familyQboId: string | null, name: string | null = null, already?: Already): Promise<Prepared> => {
      const records = await recordsOf(tx, write, familyQboId);
      if (already !== "inactive" && already !== "named" && (await inactiveRecord(tx, records))) return no(WRITE_COPY.inactiveHere);
      return { ok: true, write, realmId: source, ...records, tag: rosterTag, name, ...(already ? { already } : {}) };
    };
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
        // Only into one of the app's own active families: the new student's record goes into it (changeOwnRecord()).
        if ((await familyActiveOf(tx, await familyLinkedTo(ask.familyQboId!, tx))) !== true) return no(WRITE_COPY.notOursToAdd);
        familyQboId = ask.familyQboId;
      }
      // A new family or member is the portal's own record first (stage 3's slice 9d, addFamily()): its customer is made
      // for that record, which the write is filed under and linked to as QuickBooks answers (changeOwnRecord()).
      let ownFamily: AppFamilyId | null = null;
      if (ask.role === "family" || ask.role === "member") {
        if (ask.familyId === undefined) return no(WRITE_COPY.notOffered);
        const [own] = await tx.select({ active: family.active }).from(family).where(eq(family.id, ask.familyId));
        if (!own) return no(WRITE_COPY.gone);
        if (!own.active) return no(WRITE_COPY.inactiveHere);
        if ((await customerOfFamily(ask.familyId, tx)) !== null) return no(LINKED_ALREADY);
        // Queued only: this create runs while its sender holds the family's "being made" lock (whileMaking()).
        if (await familyCreateQueued(tx, ask.familyId)) return no(WRITE_COPY.waiting);
        ownFamily = ask.familyId;
      }
      let email: string | null = null;
      if (ask.role === "parent") {
        email = normalizeEmail(ask.email ?? "");
        if (email === null || email.length > 100) return no("Enter the parent's own email address: it goes on their record in QuickBooks.");
      }
      const name = checkName(ask.name);
      if (!name.ok) return no(name.error);
      const offer = freeName(name.name, await namesTaken(tx, cache, null));
      if (offer) return { ok: false, result: taken(name.name, offer) };
      const ready = await done({ op: "create", role: ask.role, name: name.name, typeQboId, familyQboId, email }, familyQboId);
      return ready.ok && ownFamily !== null ? { ...ready, familyId: ownFamily } : ready;
    }

    const record = byId.get(ask.qboId);
    const where = record ? roleIn(roster, record.qboId) : null;
    if (!record || !where) return no(WRITE_COPY.gone);
    if (await waitingFor(record.qboId)) return no(WRITE_COPY.waiting);

    if (ask.op === "rename") {
      if (!allowed(renameOf(where.role)) || (ask.parentOnly && where.role !== "parent")) return no(WRITE_COPY.notOffered);
      const name = checkName(ask.name);
      if (!name.ok) return no(name.error);
      if (name.name === record.displayName) {
        // QuickBooks has that name already: nothing is sent, and the app's own record takes it (a parent has none).
        if (where.role === "parent") return no(ALREADY_NAMED);
        return done({ op: "rename", role: where.role, qboId: record.qboId, syncToken: ask.syncToken, name: name.name, was: record.displayName }, where.familyQboId, null, "named");
      }
      const offer = freeName(name.name, await namesTaken(tx, cache, record.qboId));
      if (offer) return { ok: false, result: taken(name.name, offer) };
      return done({ op: "rename", role: where.role, qboId: record.qboId, syncToken: ask.syncToken, name: name.name, was: record.displayName }, where.familyQboId);
    }
    if (ask.op === "move") {
      if (where.role !== "student" || !allowed("move_student")) return no(WRITE_COPY.notOffered);
      const to = roleIn(roster, ask.toFamilyQboId);
      if (!to || to.role !== "family") return no(WRITE_COPY.gone);
      // The family the portal's own record of the student is in, by its customer: since stage 3's slice 9c it can differ
      // from the one QuickBooks has them under (a move QuickBooks took that was given up on the queue, or one made in
      // QuickBooks alone). Null when the student has no record, or its family no link.
      const studentRecord = await studentLinkedTo(record.qboId, tx);
      const [held] = studentRecord === null ? [] : await tx.select({ familyId: student.familyId }).from(student).where(eq(student.id, studentRecord));
      const recordFrom = held?.familyId ? await customerOfFamily(held.familyId, tx) : null;
      const apart = recordFrom !== null && recordFrom !== where.familyQboId;
      // Whether the record can follow QuickBooks: the family QuickBooks has them under is one of the app's own active
      // families, active in QuickBooks. When it isn't (a family customer made in QuickBooks alone has no record since
      // slice 9c, or it or its record is inactive), the record has nowhere to follow to, so a move to one of the app's
      // own families is sent instead, as any move is, and the record goes with it from the family the portal holds it in.
      const canFollow = apart && byId.get(where.familyQboId!)?.active === true
        && (await familyActiveOf(tx, await familyLinkedTo(where.familyQboId!, tx))) === true;
      if (ask.toFamilyQboId === where.familyQboId && !apart) return no(ALREADY_THERE);
      if (ask.toFamilyQboId === where.familyQboId && !canFollow) return no(WRITE_COPY.elsewhereNotOurs);
      if (ask.toFamilyQboId !== where.familyQboId && canFollow) return no(WRITE_COPY.elsewhere);
      if (!byId.get(ask.toFamilyQboId)!.active) return no("That family is inactive in QuickBooks, so nobody can be moved to it.");
      // Only into one of the app's own active families: since stage 3's slice 9c a family customer added in QuickBooks
      // has no record, and a move into it would leave the student's record, and their forms and places, in the old one.
      const toRecord = await familyLinkedTo(ask.toFamilyQboId, tx);
      const [toFamily] = toRecord === null ? [] : await tx.select({ active: family.active }).from(family).where(eq(family.id, toRecord));
      if (!toFamily?.active) return no(WRITE_COPY.notOurs);
      if (await waitingFor(ask.toFamilyQboId)) return no(WRITE_COPY.waiting);
      // QuickBooks has them in that family already, and the portal's own record is in another: nothing is sent, and the
      // record follows, from the family the portal holds them in, with a move's follow-ups (recordFollows()).
      if (canFollow) return done({ op: "move", role: "student", qboId: record.qboId, syncToken: ask.syncToken, fromFamilyQboId: recordFrom!, toFamilyQboId: ask.toFamilyQboId }, recordFrom, null, "moved");
      // Under a family that isn't the app's: the move is sent, filed under the family the record is in. Its follow-ups go
      // from that family when the record moves on with it; a move back to the record's own family moves no record, so
      // they go from the family QuickBooks had them under (where the record holds nothing, so nothing of the record's own
      // family is given up).
      if (apart) return done({ op: "move", role: "student", qboId: record.qboId, syncToken: ask.syncToken,
        fromFamilyQboId: ask.toFamilyQboId === recordFrom ? where.familyQboId! : recordFrom!, toFamilyQboId: ask.toFamilyQboId }, recordFrom);
      return done({ op: "move", role: "student", qboId: record.qboId, syncToken: ask.syncToken, fromFamilyQboId: where.familyQboId!, toFamilyQboId: ask.toFamilyQboId }, where.familyQboId);
    }
    if (!allowed(deactivateOf(where.role))) return no(WRITE_COPY.notOffered);
    if (!record.active) {
      // Inactive in QuickBooks already: nothing is sent, and the app's own record follows what staff asked (a family goes
      // with everyone under it, on its own page; a parent has no record).
      if (where.role === "family" || where.role === "parent") return no(ALREADY_INACTIVE);
      return done({ op: "deactivate", role: where.role, qboId: record.qboId, syncToken: ask.syncToken }, where.familyQboId, record.displayName, "inactive");
    }
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
 * What a staff roster write changed in the app's own records, for its audit row (`appRecord`): the record, of its kind,
 * and whether it was made or what was set on it. Since stage 3's slice 9c the records stand alone: nothing makes or
 * changes them from the roster cache, so a write QuickBooks took changes its own record here, from what was sent.
 */
export type OwnRecordChange =
  | { kind: "family"; familyId: string; made: true; linkId: string }
  | { kind: "student"; studentId: string; familyId: string; made: true; linkId: string }
  /** The portal's own record, saved before its customer was made (stage 3's slice 9d), linked to the new customer. */
  | { kind: "family"; familyId: string; linked: true; linkId: string }
  | { kind: "student"; studentId: string; linked: true; linkId: string }
  | { kind: "family"; familyId: string; set: { name?: string; active?: boolean } }
  | { kind: "student"; studentId: string; set: { name?: string; active?: boolean; familyId?: string } };

/**
 * The app's own record a write QuickBooks took is about, changed to match, in the caller's transaction (under the
 * roster lock, with the cache already holding QuickBooks' answer): `customerId` is the customer the write was about,
 * the new one QuickBooks made for a create. Each record is found through its own link of its kind
 * (src/lib/families/links.ts):
 * - a new family (layered) or member (flat): a `family` record, active, named as sent, and its family link to the new
 *   customer, `created` by `linkedBy` (the staff member who asked);
 * - a new student: a `student` record, active, named as sent, in the app family the new customer's family is linked
 *   to, and its student link, the same way (none when that family has no record: the Families pages offer such a
 *   family no write forms);
 * - a rename: the family's, member's or student's record's name;
 * - a move: the student record's family, the one the family moved to is linked to (the follow-ups run before this);
 * - a make-inactive: a member's or family's record, or a student's (a customer the family action covers, too, when it
 *   has a student record), inactive. A family's own record goes inactive with its own last step, after everyone under it.
 * A Parent customer changes nothing here: memberships are made and ended on a family's Portal sign-ins box (slice 7b).
 * A customer that already has a record of the kind (a change found made twice) makes nothing new. Null when nothing
 * changed. It writes no audit row: its caller's row says what it returns.
 *
 * `studentId`, when given, is the student record a student's rename, move or make-inactive is filed under (Prepared,
 * a queue item's `student_id`), and the only one it changes (null: none). For a create (stage 3's slice 9d) the record
 * saved first is linked instead of one made: `familyId`, the family record a new family's or member's create is filed
 * under (addFamily(), createInQuickBooksAndLink()), and `studentId`, the student record a student's create is filed
 * under (createInQuickBooksAndLink()). Each is linked only while it has no link of its kind and the customer none
 * either; it is never renamed or made active by it. A create filed under no record (queued before slice 9d, or a
 * student added to a linked family) makes its record as before. The family action files a customer under
 * the family only when its record is that family's (prepareFamily()): since slice 9c a student QuickBooks moved into
 * a family keeps their record in the family the app holds them in, which making this one inactive must not touch.
 */
export async function changeOwnRecord(tx: Tx, w: RosterWrite, customerId: string,
  o: { realmId: string; linkedBy: string | null; studentId?: AppStudentId | null; familyId?: AppFamilyId | null; syncedToken?: string | null }): Promise<OwnRecordChange | null> {
  if (w.role === "parent") return null;
  const now = new Date();
  // A new link starts aligned with the version QuickBooks answered the create with (or the cache row it was found as).
  const aligned = o.syncedToken && /^\d{1,20}$/.test(o.syncedToken) ? { syncedToken: o.syncedToken, syncedAt: now } : {};
  if (w.op === "create") {
    if (w.role === "family" || w.role === "member") {
      if ((await familyLinkedTo(customerId, tx)) !== null) return null;
      if (o.familyId) {
        if ((await customerOfFamily(o.familyId, tx)) !== null) return null;
        const [link] = await tx.insert(accountingLink).values({ system: QUICKBOOKS, realmId: o.realmId, customerId, familyId: o.familyId, origin: "created", linkedBy: o.linkedBy, ...aligned })
          .returning({ id: accountingLink.id });
        return { kind: "family", familyId: String(o.familyId), linked: true, linkId: link!.id };
      }
      const [made] = await tx.insert(family).values({ name: w.name, active: true }).returning({ id: family.id });
      const [link] = await tx.insert(accountingLink).values({ system: QUICKBOOKS, realmId: o.realmId, customerId, familyId: made!.id, origin: "created", linkedBy: o.linkedBy, ...aligned })
        .returning({ id: accountingLink.id });
      return { kind: "family", familyId: String(made!.id), made: true, linkId: link!.id };
    }
    if (w.role !== "student" || w.familyQboId === null) return null;
    if ((await studentLinkedTo(customerId, tx)) !== null) return null;
    if (o.studentId) {
      if ((await customerOfStudent(o.studentId, tx)) !== null) return null;
      const [link] = await tx.insert(accountingLink).values({ system: QUICKBOOKS, realmId: o.realmId, customerId, studentId: o.studentId, origin: "created", linkedBy: o.linkedBy, ...aligned })
        .returning({ id: accountingLink.id });
      return { kind: "student", studentId: String(o.studentId), linked: true, linkId: link!.id };
    }
    const familyId = await familyLinkedTo(w.familyQboId, tx);
    if (familyId === null) return null;
    const [made] = await tx.insert(student).values({ familyId, name: w.name, active: true }).returning({ id: student.id });
    const [link] = await tx.insert(accountingLink).values({ system: QUICKBOOKS, realmId: o.realmId, customerId, studentId: made!.id, origin: "created", linkedBy: o.linkedBy, ...aligned })
      .returning({ id: accountingLink.id });
    return { kind: "student", studentId: String(made!.id), familyId: String(familyId), made: true, linkId: link!.id };
  }
  if (w.role === "family" || w.role === "member") {
    const familyId = await familyLinkedTo(w.qboId, tx);
    if (familyId === null) return null;
    const [f] = await tx.select({ name: family.name, active: family.active }).from(family).where(eq(family.id, familyId)).for("update");
    if (!f) return null;
    const set = w.op === "rename" ? (f.name === w.name ? null : { name: w.name }) : f.active ? { active: false } : null;
    if (set === null) return null;
    await tx.update(family).set({ ...set, updatedAt: now }).where(eq(family.id, familyId));
    return { kind: "family", familyId: String(familyId), set };
  }
  const studentId = o.studentId !== undefined ? o.studentId : await studentLinkedTo(w.qboId, tx);
  if (studentId === null) return null;
  const [s] = await tx.select({ name: student.name, active: student.active, familyId: student.familyId }).from(student).where(eq(student.id, studentId)).for("update");
  if (!s) return null;
  if (w.op === "rename") {
    if (s.name === w.name) return null;
    await tx.update(student).set({ name: w.name, updatedAt: now }).where(eq(student.id, studentId));
    return { kind: "student", studentId: String(studentId), set: { name: w.name } };
  }
  if (w.op === "move") {
    const to = await familyLinkedTo(w.toFamilyQboId, tx);
    if (to === null || (s.familyId !== null && String(s.familyId) === String(to))) return null;
    await tx.update(student).set({ familyId: to, updatedAt: now }).where(eq(student.id, studentId));
    return { kind: "student", studentId: String(studentId), set: { familyId: String(to) } };
  }
  if (!s.active) return null;
  await tx.update(student).set({ active: false, updatedAt: now }).where(eq(student.id, studentId));
  return { kind: "student", studentId: String(studentId), set: { active: false } };
}

/** The records a write sent at once is filed under, should it go on the queue (Prepared). */
type Filed = { familyId: AppFamilyId | null; studentId: AppStudentId | null };

/**
 * A write QuickBooks took, or may have taken, that the portal couldn't take in after it (its transaction failed,
 * QuickBooks' answer wasn't the record asked about, or a step of the family action whose answer was lost), held so its
 * app record still follows: since slice 9c no roster read brings the records into step. A queued one is marked as
 * possibly made (`sent`); one sent while staff waited goes on the queue marked so, filed under its records. Either way
 * the queue looks for it in the cache after the next roster refresh, never simply sending it again, and, finding it
 * made, marks it done and changes its record (foundDone(), ./queue.ts). `resultQboId` is the customer QuickBooks
 * answered a create with: a create held with one is never sent again, found or not (tryItem()). A new item is audited
 * (roster.write.queued) in the caller's transaction.
 */
async function holdForTheQueue(tx: Tx, w: RosterWrite, code: string, o: { realmId: string; actor: Actor; ip: string | null; permission?: string; queueId?: string;
  linkedBy: string | null; filed?: Filed; resultQboId?: string | null }): Promise<void> {
  const resultQboId = o.resultQboId ?? null;
  if (o.queueId) {
    // `request: w`: what this try sent (a rename resent with the version just read, stage 3's slice 9e, holds that one),
    // so the found-done path looks for it as sent, and the queue never sends it with any other version.
    const [still] = await tx.update(writeQueue).set({ sent: true, request: w, lastCode: code, tries: sql`${writeQueue.tries} + 1`, lastTriedAt: new Date(), nextTryAt: new Date(Date.now() + 60_000),
      ...(resultQboId ? { resultQboId } : {}), updatedAt: new Date() })
      .where(and(eq(writeQueue.id, o.queueId), eq(writeQueue.state, "waiting"))).returning({ id: writeQueue.id });
    if (!still) await keepMadeOnGivenUp(tx, o.queueId, resultQboId);
    return;
  }
  const [item] = await tx.insert(writeQueue).values({
    realmId: o.realmId, request: w, targetQboId: w.op === "create" ? null : w.qboId, familyId: o.filed?.familyId ?? null, studentId: o.filed?.studentId ?? null,
    sent: true, tries: 1, lastCode: code.slice(0, 40), nextTryAt: new Date(Date.now() + 60_000), askedBy: o.linkedBy, askedByLabel: o.actor.label, resultQboId,
  }).returning({ id: writeQueue.id });
  await writeAudit({ actor: o.actor, action: "roster.write.queued", permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: item!.id,
    after: { op: w.op, role: w.role, code: code.slice(0, 40), sent: true } }, tx);
}

/**
 * A queue item staff gave up while a try of it was on its way to QuickBooks (the lead's decision in stage 3's slice 9d):
 * it stays given up, whatever QuickBooks answered, and a create keeps the customer QuickBooks made for it
 * (`result_qbo_id`), which the Reconciliation page names (madeAfterGivingUp()). Nothing is linked to that customer.
 */
async function keepMadeOnGivenUp(tx: Tx, queueId: string, resultQboId: string | null): Promise<void> {
  if (!resultQboId) return;
  await tx.update(writeQueue).set({ resultQboId, updatedAt: new Date() })
    .where(and(eq(writeQueue.id, queueId), eq(writeQueue.state, "given_up"), isNull(writeQueue.resultQboId)));
}

/** Whether a queue item a try is for is no longer waiting (given up meanwhile), read FOR UPDATE so a give-up waits for this try's answer. */
async function queuedNoLonger(tx: Tx, queueId: string): Promise<boolean> {
  const [q] = await tx.select({ state: writeQueue.state }).from(writeQueue).where(eq(writeQueue.id, queueId)).for("update");
  return q !== undefined && q.state !== "waiting";
}

/**
 * What follows a write QuickBooks said yes to (spec 6.1: QuickBooks first, then the cache and the app's record from its
 * answer). In one transaction that holds the roster lock: when the cache is still the company the write was sent to,
 * the customer is stored from the answer (only if newer), a moved student's follow-ups run, the app's own record the
 * write was about is made or changed (changeOwnRecord()), and a family made inactive asks the worker for a roster
 * refresh (QuickBooks may have changed the customers under it). Who may sign in is the app's own guardian rows: a
 * write to QuickBooks opens or closes none of them. The write is audited with before and after and the record it
 * changed (`appRecord`), whether or not the portal could take it in. `inside` runs last, in the same transaction.
 * When that transaction fails (code cache_failed), or QuickBooks' answer isn't the record asked about (answer_other),
 * the change is still audited, a refresh asked for, and the write held for the queue to finish (holdForTheQueue());
 * `cached` is then false. `linkedBy` is the staff member who asked, for a link made to a new customer; `filed`, the
 * records a write sent at once is filed under should it go on the queue.
 */
export async function applyWritten(w: RosterWrite, answer: Record<string, unknown>, o: { realmId: string; actor: Actor; ip: string | null; permission?: string;
  queueId?: string; linkedBy: string | null; filed?: Filed; inside?: (tx: Tx) => Promise<void>; auditExtra?: Record<string, unknown> }): Promise<{ cached: boolean }> {
  const answerToken = typeof answer.SyncToken === "string" ? answer.SyncToken : null;
  let tell: (() => Promise<unknown>) | null = null;
  const targetId = w.op === "create" ? (typeof answer.Id === "string" ? answer.Id.slice(0, 64) : "unknown") : w.qboId;
  // The customer a create was answered with, kept on a held item so that it is never sent again (holdForTheQueue()).
  const resultQboId = w.op === "create" && typeof answer.Id === "string" ? targetId : null;
  let held = false;
  try {
    await db.transaction(async (tx) => {
      const ours = await lockRosterAs(tx, rosterTagOf(o.realmId));
      const [cached] = w.op === "create" ? [] : await tx.select().from(qboCustomer).where(eq(qboCustomer.qboId, w.qboId));
      const cause = `${AUDIT_ACTION[w.op]}#${w.op === "create" ? nameKey(w.name).slice(0, 40) : w.qboId}`;
      const fits = answerIsFor(w, answer);
      let refreshAsked = false, aligned = false;
      let appRecord: OwnRecordChange | null = null;
      // A queued try whose item staff gave up while it was on its way stays given up: the cache takes QuickBooks' answer,
      // but no record is made, linked or changed for it, and a create keeps the customer it made (keepMadeOnGivenUp()).
      const givenUp = ours && o.queueId !== undefined && (await queuedNoLonger(tx, o.queueId));
      if (ours && fits && givenUp) {
        await upsertFromAnswer(tx, answer, await getShape(tx));
        await keepMadeOnGivenUp(tx, o.queueId!, resultQboId);
      } else if (ours && fits) {
        await upsertFromAnswer(tx, answer, await getShape(tx));
        if (w.op === "move") ({ tell } = await afterStudentMoved(tx, { studentQboId: w.qboId, fromFamilyQboId: w.fromFamilyQboId, toFamilyQboId: w.toFamilyQboId, cause }, o));
        appRecord = await changeOwnRecord(tx, w, targetId, { realmId: o.realmId, linkedBy: o.linkedBy, studentId: o.filed?.studentId, familyId: o.filed?.familyId, syncedToken: answerToken });
        // A student saved first, now linked, leaves no refused create of theirs behind (stage 3's slice 9e).
        if (appRecord?.kind === "student" && "linked" in appRecord) {
          await replaceRefusedCreates(tx, asAppStudentId(appRecord.studentId), { op: "create", customerQboId: targetId, ...(o.queueId ? { queueId: o.queueId } : {}) }, o);
        }
        aligned = await alignAfterWrite(tx, w, o.realmId, answerToken);
        if (w.op === "deactivate" && w.role === "family") { await askForRosterRefresh(tx); refreshAsked = true; }
      } else if (ours) {
        // The answer wasn't the record asked about: the roster is read again rather than guessed at, and the queue finds
        // the change in it and finishes it, its record with it.
        await askForRosterRefresh(tx); refreshAsked = true;
        await holdForTheQueue(tx, w, "answer_other", { ...o, resultQboId });
        held = true;
      }
      await writeAudit({ actor: o.actor, action: AUDIT_ACTION[w.op], permission: o.permission, ip: o.ip, targetType: "qbo_customer", targetId,
        before: auditBefore(w, cached), after: { ...auditAfter(w, answer), ...(o.queueId ? { queueId: o.queueId } : {}), ...(refreshAsked ? { refreshAsked } : {}),
          ...(!ours ? { code: "company_changed" } : !fits ? { code: "answer_other" } : {}), ...(givenUp ? { queue: "given_up" } : {}), ...(appRecord ? { appRecord } : {}),
          ...(aligned ? { linkVersion: answerToken } : {}), ...(o.auditExtra ?? {}) } }, tx);
      if (o.inside && !held && !givenUp) await o.inside(tx);
    });
  } catch {
    // QuickBooks made the change but the portal couldn't take it in (a deadlock, a follow-up that failed): nothing of
    // that transaction is kept, so the change is audited here with its code, the worker is asked for a roster refresh,
    // and the write is held for the queue, marked as possibly made, so it is looked for after that refresh (never simply
    // sent again) and its app record changed once it is found there.
    tell = null;
    await db.transaction(async (tx) => {
      await askForRosterRefresh(tx);
      await writeAudit({ actor: o.actor, action: AUDIT_ACTION[w.op], permission: o.permission, ip: o.ip, targetType: "qbo_customer", targetId,
        before: w.op === "create" ? null : { syncToken: w.syncToken },
        after: { ...auditAfter(w, answer), ...(o.queueId ? { queueId: o.queueId } : {}), refreshAsked: true, code: "cache_failed" } }, tx);
      await holdForTheQueue(tx, w, "cache_failed", { ...o, resultQboId });
    });
    return { cached: false };
  }
  // The guardians whose places a moved student gave up are told once the move is committed. A mail failure is the
  // notices' own to record; it never undoes the move.
  if (tell) await (tell as () => Promise<unknown>)().catch(() => undefined);
  return { cached: !held };
}

/** The kind of link a write's record has: a family's (or a member's) or a student's; none for a parent or another customer. */
const linkKindOf = (role: RosterWrite["role"]): "family" | "student" | null => (role === "family" || role === "member" ? "family" : role === "student" ? "student" : null);

/**
 * Sets the version the portal last aligned with on a customer's link of one kind (`synced_token`, stage 3's slice 9e),
 * in the caller's transaction, which holds the roster lock exclusively (as every link write does). `onlyIf`: only
 * while the link holds that version. Whether it changed anything.
 */
async function alignLink(tx: Tx, kind: "family" | "student", customerId: string, realmId: string, token: string | null, onlyIf?: string): Promise<boolean> {
  if (token === null || !/^\d{1,20}$/.test(token)) return false;
  const rows = await tx.update(accountingLink).set({ syncedToken: token, syncedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId), eq(accountingLink.customerId, customerId),
      kind === "family" ? isNotNull(accountingLink.familyId) : isNotNull(accountingLink.studentId),
      onlyIf === undefined ? undefined : eq(accountingLink.syncedToken, onlyIf))).returning({ id: accountingLink.id });
  return rows.length > 0;
}

/**
 * After an update QuickBooks took (or one the queue found made), the record's link takes the version QuickBooks now
 * holds (`token`: the answer's, or the cache row it was found as), only when what was sent carried the link's own
 * version (`syncToken` equal to the link's), or was a rename resent with a version read live after its name read as
 * the portal held it (`checked`). A move or make-inactive sent with a page's version that differs from the link's
 * leaves it, and so does the family action's last step when the version it just read differs (one that happens to
 * equal the link's is a send that carried the link's own version, by the same rule); a parent's change has no link. A
 * create's link takes it in changeOwnRecord(). The queue aligns a change it finds made only when it was sent.
 */
export async function alignAfterWrite(tx: Tx, w: RosterWrite, realmId: string, token: string | null): Promise<boolean> {
  if (w.op === "create") return false;
  const kind = linkKindOf(w.role);
  if (kind === null) return false;
  return alignLink(tx, kind, w.qboId, realmId, token, w.op === "rename" && w.checked ? undefined : w.syncToken);
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
 * cache took it, that is audited (`roster.customer.read_again`) in the same transaction, as the staff change that led
 * to it. The app's own records are left as they are: what QuickBooks holds is shown, never taken into them (stage 4's
 * differences will offer that).
 */
async function readAgain(qboId: string, realmId: string, o: { actor: Actor; ip: string | null; permission?: string }): Promise<CurrentRecord | null> {
  let answer: Record<string, unknown> | null;
  try { answer = await qboCustomerById(qboId, { failFast: true, realmId, timeoutMs: 5_000 }); } catch (e) { if (e instanceof QboError) return null; throw e; }
  if (!answer || answer.Id !== qboId) return null;
  return storeReadAgain(answer, realmId, o);
}

/** readAgain()'s second half: a customer QuickBooks just answered with, stored in the cache when newer (audited), and as the page shows it. */
async function storeReadAgain(answer: Record<string, unknown>, realmId: string, o: { actor: Actor; ip: string | null; permission?: string }): Promise<CurrentRecord | null> {
  const qboId = String(answer.Id);
  return db.transaction(async (tx) => {
    if (!(await lockRosterAs(tx, rosterTagOf(realmId)))) return null;
    const shape = await getShape(tx);
    const { stored, took } = await upsertFromAnswer(tx, answer, shape);
    if (took) {
      await writeAudit({ actor: o.actor, action: "roster.customer.read_again", permission: o.permission, ip: o.ip, targetType: "qbo_customer", targetId: qboId,
        after: { cached: took, syncToken: stored?.syncToken ?? null } }, tx);
    }
    // Shown as QuickBooks has it now, from this read: the cache keeps a row of the same version it already holds (an
    // answer is stored only when newer), so its values can lag behind what QuickBooks just showed.
    const row = stored ? customerRow(answer, new Set(shapeTypeIds(shape)), new Date()) ?? stored : null;
    if (!row) return null;
    const [family] = row.parentQboId ? await tx.select({ name: qboCustomer.displayName }).from(qboCustomer).where(eq(qboCustomer.qboId, row.parentQboId)) : [];
    return { name: row.displayName, active: row.active, familyName: family?.name ?? null };
  });
}

/** The app's own record a write is about, as it is now, for the `before` of a follow's audit row: null when there is none. */
async function recordNow(tx: Tx, w: Extract<RosterWrite, { op: "rename" | "deactivate" | "move" }>, studentId: AppStudentId | null) {
  if (w.role === "family" || w.role === "member") {
    const familyId = await familyLinkedTo(w.qboId, tx);
    const [f] = familyId === null ? [] : await tx.select({ name: family.name, active: family.active }).from(family).where(eq(family.id, familyId));
    return f ? { kind: "family" as const, familyId: String(familyId), name: f.name, active: f.active } : null;
  }
  if (w.role === "parent" || studentId === null) return null; // a student, or a customer the family action covers that has a student record
  const [s] = await tx.select({ name: student.name, active: student.active, familyId: student.familyId }).from(student).where(eq(student.id, studentId));
  return s ? { kind: "student" as const, studentId: String(studentId), name: s.name, active: s.active, familyId: s.familyId === null ? null : String(s.familyId) } : null;
}

/**
 * What staff asked for is in QuickBooks already (code `already_inactive`: the customer is inactive there;
 * `already_named`: it has that name; or `already_moved`: QuickBooks has the student under the family asked for, and the
 * portal's own record is in another), so nothing is sent, and the app's own record is made to match what was asked,
 * as the queue's found-done path makes it for a change it finds made (foundDone(), ./queue.ts), so the two paths agree:
 * changeOwnRecord() under the roster lock, a move's follow-ups first (afterStudentMoved(), from the family the portal
 * held the student in), audited (roster.record.follows) with the record before and what changed, in the same
 * transaction, the record filed under `filed`. Null when the record was as asked already, there is none (a parent's),
 * the cache no longer shows a move as asked, or the roster is another company's now. The guardians whose places a
 * moved student gave up are told after the commit.
 */
async function recordFollows(w: Extract<RosterWrite, { op: "rename" | "deactivate" | "move" }>, filed: Filed, realmId: string,
  code: "already_inactive" | "already_named" | "already_moved", o: WriteOp & { staffUserId: string }): Promise<OwnRecordChange | null> {
  let tell: (() => Promise<unknown>) | null = null;
  const appRecord = await db.transaction(async (tx) => {
    if (!(await lockRosterAs(tx, rosterTagOf(realmId)))) return null;
    const before = await recordNow(tx, w, filed.studentId);
    if (before === null) return null;
    if (w.op === "move") {
      // Still as the page's checks found it, under the lock: QuickBooks has the student in the family asked for, and the
      // record is in another of the app's families.
      const [c] = await tx.select({ parentQboId: qboCustomer.parentQboId }).from(qboCustomer).where(eq(qboCustomer.qboId, w.qboId));
      const to = await familyLinkedTo(w.toFamilyQboId, tx);
      if (c?.parentQboId !== w.toFamilyQboId || to === null || before.kind !== "student" || before.familyId === String(to)) return null;
      ({ tell } = await afterStudentMoved(tx, { studentQboId: w.qboId, fromFamilyQboId: w.fromFamilyQboId, toFamilyQboId: w.toFamilyQboId, cause: `roster.record.follows#${w.qboId}` }, o));
    }
    const change = await changeOwnRecord(tx, w, w.qboId, { realmId, linkedBy: o.staffUserId, studentId: filed.studentId });
    if (!change) return null;
    await writeAudit({ actor: o.actor, action: "roster.record.follows", permission: o.permission, ip: o.ip, targetType: "qbo_customer", targetId: w.qboId,
      before, after: { op: w.op, role: w.role, code, appRecord: change } }, tx);
    return change;
  });
  if (tell) await (tell as () => Promise<unknown>)().catch(() => undefined);
  return appRecord;
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
  const filed: Filed = { familyId: p.familyId, studentId: p.studentId };
  if (p.already && p.write.op !== "create") {
    // The cache shows QuickBooks has it so already: nothing is sent; the app's own record takes what was asked.
    const how = { inactive: ["already_inactive", WRITE_COPY.inactiveFollowed, ALREADY_INACTIVE], named: ["already_named", WRITE_COPY.namedFollowed, ALREADY_NAMED],
      moved: ["already_moved", WRITE_COPY.movedFollowed, ALREADY_THERE] } as const;
    const [code, followedWords, nothingWords] = how[p.already];
    const followed = await recordFollows(p.write, filed, p.realmId, code, o);
    return followed ? { ok: true, message: followedWords } : refuse(nothingWords);
  }
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
      const current = await readAgain(p.write.qboId, p.realmId, o);
      // Inactive there at the version the cache holds: the cache is behind QuickBooks, so the roster is read again, and
      // the app's own record is made inactive, as staff asked and as the queue makes it in the same case (its own audit
      // row says so). Only when there was nothing to change in the app either is it refused.
      if (!owed.active) {
        await db.transaction((tx) => askForRosterRefresh(tx));
        if (await recordFollows(p.write, filed, p.realmId, "already_inactive", o)) return { ok: true, message: WRITE_COPY.inactiveFollowed };
      }
      await audited(owed.active ? "moved_on" : "already_inactive", p.write, target);
      const said = owed.active ? WRITE_COPY.changed : ALREADY_INACTIVE;
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
  const { cached } = await applyWritten(p.write, answer, { realmId: p.realmId, actor: o.actor, ip: o.ip, permission: o.permission, linkedBy: o.staffUserId, filed });
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
   last, each through the same write, sendWrite() and applyWritten(), as one student or parent is. It is never queued
   to be sent later: when it stops part way it says what is now true, and pressing it again carries on with whoever is
   still active. A step whose answer was lost is held on the queue as possibly made, only so that it is looked for
   after the next roster read and its app record follows; it is never sent again from there unless that read shows it
   wasn't made. */

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

/** One step of the family action, with the records a queue item for it would be filed under (holdForTheQueue()). */
type FamilyStep = { write: Extract<RosterWrite, { op: "deactivate" }>; name: string; filed: Filed };
type PreparedFamily = { ok: true; realmId: string; familyName: string; steps: FamilyStep[] } | { ok: false; result: WriteResult };

/**
 * Everything checked before anything is sent, under the roster lock, as prepare() checks one write: the page was shown
 * this company's roster, QuickBooks is connected to it, the shape offers making a family inactive, the id is a family
 * on the roster whose own record (if it has one) is active in the portal, nothing is waiting for it or anyone under it,
 * and the list the page showed still holds everyone active under it, each at the version shown (a list someone has
 * since been added to is refused: staff confirm whom it covers). Someone shown who is inactive now is passed over: that
 * is how pressing it again carries on. A family QuickBooks has inactive already is refused only when its record is
 * inactive too (or it has none): otherwise the action makes the record match, sending nothing for the family.
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
    const ownRecord = await familyLinkedTo(familyQboId, tx);
    const ownActive = await familyActiveOf(tx, ownRecord);
    if (ownActive === false && family.active) return no(WRITE_COPY.inactiveHere);
    if (!family.active && ownActive !== true) return no("That family is inactive in QuickBooks already, so there was nothing to change.");
    const under = activeUnder(cache, familyQboId);
    for (const c of [family, ...under]) if (shown.get(c.qboId) !== c.syncToken) return no(WRITE_COPY.coverChanged);
    const ids = [familyQboId, ...under.map((u) => u.qboId)];
    const waiting = await tx.select({ id: writeQueue.id }).from(writeQueue).where(and(inArray(writeQueue.targetQboId, ids), inArray(writeQueue.state, ["waiting", "stuck"]))).limit(1);
    if (waiting.length) return no(WRITE_COPY.waiting);
    const roleOf = (qboId: string): FamilyStep["write"]["role"] => {
      const r = roleIn(roster, qboId);
      return r && r.familyQboId === familyQboId && (r.role === "student" || r.role === "parent") ? r.role : "other";
    };
    const writes: FamilyStep["write"][] = [
      ...under.map((u) => ({ op: "deactivate" as const, role: roleOf(u.qboId), qboId: u.qboId, syncToken: u.syncToken })),
      { op: "deactivate", role: "family", qboId: familyQboId, syncToken: family.syncToken },
    ];
    // A customer under the family is filed under its student record only when that record is this family's: since
    // slice 9c a student QuickBooks moved in keeps their record in the family the app holds them in, and making this
    // family inactive leaves it alone (changeOwnRecord() changes only the record a step is filed under).
    const steps: FamilyStep[] = [];
    for (const [i, write] of writes.entries()) {
      const filed = await recordsOf(tx, write, familyQboId);
      if (write.role === "student" || write.role === "other") {
        const studentId = await studentLinkedTo(write.qboId, tx);
        const [s] = studentId === null ? [] : await tx.select({ familyId: student.familyId }).from(student).where(eq(student.id, studentId));
        const theirs = s === undefined || s.familyId === null ? null : String(s.familyId);
        filed.studentId = studentId !== null && ownRecord !== null && theirs === String(ownRecord) ? studentId : null;
      }
      steps.push({ write, name: i < under.length ? under[i]!.name : family.displayName, filed });
    }
    return { ok: true, realmId: source, familyName: family.displayName, steps };
  });
}

/** Names in a sentence: "A", "A and B", "A, B and C". */
const listed = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * Why one step of the family action stopped, in words for staff, and what follows it: a record changed in QuickBooks is
 * read again (spec §6.3); a family QuickBooks still won't take while someone the cache doesn't show is under it (800)
 * asks the worker for a roster refresh; and a write whose answer was lost asks for one too and is held on the queue as
 * possibly made (holdForTheQueue()), filed under the step's records, so the queue finds it after that refresh and makes
 * the app's own record inactive with it (since slice 9c no refresh does), never sending it twice. `maybe`: the step may
 * have been made. `changed`: the cache, the queue or the refresh ask changed, so the pages are made again.
 */
async function stepStopped(e: QboError, step: FamilyStep, realmId: string, o: WriteOp & { staffUserId: string }): Promise<{ words: string; maybe: boolean; changed: boolean }> {
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
        await db.transaction(async (tx) => {
          await askForRosterRefresh(tx);
          await holdForTheQueue(tx, step.write, e.code, { realmId, actor: o.actor, ip: o.ip, permission: o.permission, linkedBy: o.staffUserId, filed: step.filed });
        });
        return { words: `The portal can't tell whether QuickBooks made ${name} inactive: its answer didn't arrive. The roster is read again within a few minutes to see, and the portal finishes it then without sending it twice.`, maybe: true, changed: true };
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
 *   2. each of them read live from QuickBooks: when any of them owes anything, nothing is sent and no record follows,
 *      and staff are told who (with the amount only for Finance.Balance.Read) and that it must be paid or written off
 *      first. The same read stops it before anything is sent when a version there is newer than the one the page
 *      showed, and passes over anyone it shows already inactive, whose app record is made inactive then
 *      (recordFollows()); when that is the family itself, nothing is sent for anyone, and once everyone it covers is
 *      inactive there, making the records match is the whole of the action (a family made inactive in QuickBooks);
 *   3. each made inactive, deepest first and the family last, each through sendWrite() and applyWritten(): QuickBooks
 *      first, then the cache and the app's own record from its answer under the roster lock, with its audit row.
 *      The family's own last step is the one exception to carrying the version the page showed: the family is read
 *      once more after its members' writes, and sent with the version just read, since QuickBooks may raise it when a
 *      customer under it changes. Its version was the page's when the action began (step 2), the write sets only the
 *      inactive flag, and the window is the seconds of the action itself, so nothing anyone changed is overwritten.
 * The first step that doesn't go through stops it: staff are told who was made inactive, who wasn't and why, and that
 * the family is still active. Nothing of it is queued, but for a step whose answer was lost: that one is held on the
 * queue as possibly made (stepStopped()), so its app record follows once the queue finds it. One audit row
 * (roster.family.deactivate) says how it went.
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
  // Nothing at all is done while anyone owes: no write, and no record made to follow.
  if (owing.length) {
    await summary("refused", "open_balance", [], ids, { alreadyInactive });
    return { result: { ok: false, errors: [...owing, `Nobody was made inactive. ${WRITE_COPY.balanceFix}`] }, changed: already.size > 0 };
  }
  // Whoever QuickBooks shows inactive already has their app record made inactive, as staff asked and as the queue
  // makes it (recordFollows()): when the family itself is, and when the rest goes ahead.
  const follow = async () => {
    let n = 0;
    for (const step of p.steps) if (already.has(step.write.qboId) && (await recordFollows(step.write, step.filed, p.realmId, "already_inactive", o))) n++;
    return n;
  };
  if (already.has(familyQboId)) {
    // QuickBooks has the family inactive already: nothing is sent for anyone. When everyone else is inactive there too,
    // making the portal's own records match is the whole of what staff asked.
    const followed = await follow();
    const stillActive = p.steps.filter((s) => !already.has(s.write.qboId)).map((s) => s.name);
    if (followed && !stillActive.length) {
      await summary("done", "already_inactive", [], [], { alreadyInactive });
      return { result: { ok: true, message: `${p.familyName} is inactive in QuickBooks already, so nothing was sent. The portal's own family is inactive now too. The roster is being read again to show it.` }, changed: true };
    }
    await summary("refused", "already_inactive", [], ids, { alreadyInactive });
    return { result: refuse(`${p.familyName} is inactive in QuickBooks already, so nothing was sent.${followed ? " The portal's own records of whoever QuickBooks shows inactive are inactive now too." : ""}${stillActive.length ? ` QuickBooks still shows ${listed(stillActive)} active under it: check them in QuickBooks.` : ""} The roster is being read again to show it.`), changed: true };
  }
  await follow();

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
        : why.maybe ? `${p.familyName} is still active. Once the change waiting for ${step.name} has gone through (the Reconciliation page lists it until then), press “Make ${p.familyName} inactive” again to carry on with whoever is still active.`
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
    const { cached } = await applyWritten(step.write, answer, { realmId: p.realmId, actor: o.actor, ip: o.ip, permission: o.permission, linkedBy: o.staffUserId, filed: step.filed });
    if (!cached) allShown = false;
    made.push(step);
  }
  await summary("done", null, made.map((s) => s.write.qboId), [], { alreadyInactive });
  const under = made.filter((s) => s.write.role !== "family").map((s) => s.name);
  const message = under.length ? `Made inactive in QuickBooks: ${listed(under)}, then ${p.familyName}.` : `Made ${p.familyName} inactive in QuickBooks.`;
  return { result: { ok: true, message: allShown ? message : `${message} The roster here shows it after its next read of QuickBooks, usually within a few minutes.` }, changed: true };
}

/* ---- Families by hand (stage 3's slice 9d of the app-owned families spec, section 4: "Staff add families, students and
   guardians in the app. These start unlinked.") ----
   A family or member staff add is the portal's own record first, saved in its own transaction with its audit row. It is
   sent to QuickBooks only by someone who may link families to accounting (Accounting.Link.ReadWrite; the owner's
   decision of 2026-11-18), while QuickBooks is connected to the roster's company and the membership shape holds: today's
   create, through prepare() and sendWrite(), filed under the new record and linked to it as QuickBooks answers. A family
   with no link is a full family in the portal: every change to it is saved here only (changeInPortal()), and "Create in
   QuickBooks and link" (createInQuickBooksAndLink()) makes its customer, and its students', later. */

const LINKED_ALREADY = "This family is linked to QuickBooks already, so nothing was made.";
/** A family whose own create is waiting or stuck: nothing else is changed on it until it goes through or is given up. */
export const FAMILY_WAITING = "Making this family in QuickBooks is still waiting on the queue, so nothing else can be changed on it for now. Once it has gone through, or been given up on the Reconciliation page, try again.";
/** A family a create of which is being sent to QuickBooks at this moment (whileMaking()): nothing else is changed on it until the answer is in. */
export const FAMILY_SENDING = "This family is being made in QuickBooks at this moment, so nothing else can be changed on it. Try again in a minute.";
const STUDENT_WAITING = "Making this student in QuickBooks is still waiting on the queue, so nothing else can be changed for them for now. Once it has gone through, or been given up on the Reconciliation page, try again.";
const LINKED_HERE = "That is linked to QuickBooks, so it is changed there first: use the QuickBooks changes on this page.";
const GIVEN_UP_MAYBE_MADE = "Making this in QuickBooks was given up on the Reconciliation page after a try QuickBooks may have taken. Once the roster has been read again (within a few minutes), the Reconciliation page says whether QuickBooks made it; if it didn't, press “Create in QuickBooks and link” again.";
/** A family's create given up after QuickBooks made its customer (madeAfterGivingUp()): no second customer is made for it. */
const madeAfterGivingUpWords = (name: string, noun: string) =>
  `QuickBooks made the customer “${name}” for this ${noun} before making it was given up on the Reconciliation page, and no ${noun} in the portal is linked to it, so a second one wasn't made. If it is this ${noun}, bring it in with “Create a family from this” under Customers with no family on the Reconciliation page (that makes a ${noun} linked to it: add its guardians and students there, then make this one inactive here). If it isn't, make it inactive in QuickBooks, then press “Create in QuickBooks and link” again.`;
const COLLATOR = new Intl.Collator("en", { sensitivity: "base" });
const isFamilyCreate = sql`${writeQueue.request}->>'op' = 'create' and ${writeQueue.request}->>'role' in ('family', 'member')`;
const isStudentCreate = sql`${writeQueue.request}->>'op' = 'create' and ${writeQueue.request}->>'role' = 'student'`;

/** First key of the lock held while a family's create is being sent; the second is a hash of the family record's id. */
export const MAKING_LOCK = 7461011;
const makingLock = (familyId: AppFamilyId) => sql`${sql.raw(String(MAKING_LOCK))}, hashtext(${String(familyId)}::text)`;

/**
 * Runs `send` holding the family's "being made" lock, in a transaction of its own that holds nothing else, for as long
 * as a create of the family's (its own, or its students' under "Create in QuickBooks and link") may be on its way to
 * QuickBooks: from before addFamily() saves the record until the answer is taken in or the item is on the queue. Until
 * then the family has no link and no queue item, so without it a rename, a make-inactive or a second "Create in
 * QuickBooks and link" could slip in while QuickBooks is making the first customer, and make a second. Null, sending
 * nothing, when someone else holds it (or a check holds it shared for a moment: familyCreateWaiting()).
 */
async function whileMaking<T>(familyId: AppFamilyId, send: () => Promise<T>): Promise<T | null> {
  return db.transaction(async (hold) => {
    const [lock] = (await hold.execute(sql`select pg_try_advisory_xact_lock(${makingLock(familyId)}) as locked`)) as unknown as { locked: boolean }[];
    if (!lock?.locked) return null;
    return send();
  });
}

/** Whether a family's own create (a new family's or member's, filed under its record) is waiting or stuck on the queue. */
async function familyCreateQueued(tx: Tx, familyId: AppFamilyId): Promise<boolean> {
  return (await tx.select({ id: writeQueue.id }).from(writeQueue)
    .where(and(eq(writeQueue.familyId, familyId), inArray(writeQueue.state, ["waiting", "stuck"]), isFamilyCreate)).limit(1)).length > 0;
}

/**
 * Whether a family's own create is waiting or stuck on the queue (`queued`: a new family's or member's, filed under its
 * record, `write_queue.family_id`), or a create of the family's is being sent at this moment (`sending`: whileMaking()
 * holds its lock); null when neither. A queued create has no target (it names no customer yet), so "one change waiting
 * on a record" (waitingFor(), by `target_qbo_id`) can't see it. Either way nothing else is changed on that family
 * meanwhile (changeInPortal(), and adding or reinstating a guardian, ../parents/guardians.ts). When it answers null, the
 * caller's transaction holds the lock shared to its end, so no send starts before its change is committed.
 */
export async function familyCreateWaiting(tx: Tx, familyId: AppFamilyId): Promise<"queued" | "sending" | null> {
  if (await familyCreateQueued(tx, familyId)) return "queued";
  const [lock] = (await tx.execute(sql`select pg_try_advisory_xact_lock_shared(${makingLock(familyId)}) as locked`)) as unknown as { locked: boolean }[];
  return lock?.locked ? null : "sending";
}
/** Whether a student's own create (filed under the student record, `write_queue.student_id`) is waiting or stuck on the queue. */
async function studentCreateWaiting(tx: Tx, studentId: AppStudentId): Promise<boolean> {
  return (await tx.select({ id: writeQueue.id }).from(writeQueue)
    .where(and(eq(writeQueue.studentId, studentId), inArray(writeQueue.state, ["waiting", "stuck"]), isStudentCreate)).limit(1)).length > 0;
}
/**
 * Whether a create filed under this record was given up after a try QuickBooks may have taken (`sent`), with no roster
 * read started since that try: QuickBooks may have made it, and making it again waits until a read shows whether it did
 * (its name is then taken there, and met by namesTaken()).
 */
async function givenUpMaybeMade(tx: Tx, filed: { familyId: AppFamilyId } | { studentId: AppStudentId }): Promise<boolean> {
  const [given] = await tx.select({ lastTriedAt: writeQueue.lastTriedAt }).from(writeQueue)
    .where(and("familyId" in filed ? and(eq(writeQueue.familyId, filed.familyId), isFamilyCreate) : and(eq(writeQueue.studentId, filed.studentId), isStudentCreate),
      eq(writeQueue.state, "given_up"), eq(writeQueue.sent, true))).orderBy(desc(writeQueue.lastTriedAt)).limit(1);
  if (!given) return false;
  const [read] = await tx.select({ at: jobRun.startedAt }).from(jobRun).where(and(eq(jobRun.job, ROSTER_JOB), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1);
  return !read || read.at <= given.lastTriedAt;
}

/** A create given up on the Reconciliation page that QuickBooks made all the same, with no record linked to its customer. */
export type MadeAfterGivingUp = { queueId: string; role: "family" | "member" | "student"; name: string; customerQboId: string; familyId: AppFamilyId | null; studentId: AppStudentId | null };

/**
 * The creates of a family, member or student given up after a try QuickBooks may have taken (`sent`) whose customer the
 * roster cache holds, active, with no record of its kind linked to it: the customer QuickBooks answered with or a read
 * found it made as (`result_qbo_id`), else the one beforeResend() would find it as. Given up, such an item is never
 * linked (the lead's decision in stage 3's slice 9d): the Reconciliation page says so, and "Create in QuickBooks and
 * link" makes no second customer while it stands (prepareLink()). `filed`: only those filed under that record. None
 * while the cache names no company or QuickBooks is connected to another (every link lookup answers nothing then).
 * One per customer, the latest try first.
 */
export async function madeAfterGivingUp(tx: Tx, filed?: { familyId: AppFamilyId } | { studentId: AppStudentId }): Promise<MadeAfterGivingUp[]> {
  const source = await getRosterSource(tx);
  if (source === null || (await connectedToAnotherCompany(tx))) return [];
  const which = filed === undefined ? sql`${writeQueue.request}->>'op' = 'create' and ${writeQueue.request}->>'role' in ('family', 'member', 'student')`
    : "familyId" in filed ? and(eq(writeQueue.familyId, filed.familyId), isFamilyCreate) : and(eq(writeQueue.studentId, filed.studentId), isStudentCreate);
  const rows = await tx.select().from(writeQueue).where(and(eq(writeQueue.state, "given_up"), eq(writeQueue.sent, true), eq(writeQueue.realmId, source), which))
    .orderBy(desc(writeQueue.lastTriedAt), asc(writeQueue.id));
  if (!rows.length) return [];
  const cache = await cacheRows(tx);
  const found: MadeAfterGivingUp[] = rows.flatMap((r) => {
    const w = r.request as CreateWrite;
    if (w.role !== "family" && w.role !== "member" && w.role !== "student") return [];
    const seen = beforeResend(w, cache);
    const c = (r.resultQboId !== null ? cache.find((x) => x.qboId === r.resultQboId) : undefined)
      ?? (seen.is === "done" ? cache.find((x) => x.qboId === seen.qboId) : undefined);
    return c?.active ? [{ queueId: r.id, role: w.role, name: c.displayName, customerQboId: c.qboId, familyId: r.familyId, studentId: r.studentId }] : [];
  });
  const isStudent = (m: MadeAfterGivingUp) => m.role === "student";
  const links = await linksOfCustomers({ families: found.filter((m) => !isStudent(m)).map((m) => m.customerQboId), students: found.filter(isStudent).map((m) => m.customerQboId) }, tx);
  const named = new Set<string>();
  return found.filter((m) => {
    if ((isStudent(m) ? links.studentOfCustomer : links.familyOfCustomer).has(m.customerQboId) || named.has(m.customerQboId)) return false;
    named.add(m.customerQboId);
    return true;
  });
}

/**
 * "Link the student to it", on the Reconciliation page: a student's create staff gave up that QuickBooks made all the
 * same (madeAfterGivingUp()) is linked to that customer when staff say it is that student. A student customer sits
 * under its family, so Customers with no family can't bring it in, and without this the only way left would make a
 * second customer for the student. Nothing is sent to QuickBooks. Under the roster lock with the page's tag, it links
 * only while the item is that given-up create, still filed under the student, the customer still active, of no student
 * record, and directly under the customer the student's own family is linked to (the roster's tree), the student
 * record active with no link. The link is `confirmed` by the staff member, and audited in the same transaction
 * (`roster.student.linked_after_giving_up`); the item stays given up.
 */
export async function linkStudentMadeAfterGivingUp(rawQueueId: string, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  const no = (error: string): WriteResult => refuse(error);
  if (!isUuid(rawQueueId)) return no(WRITE_COPY.gone);
  return db.transaction(async (tx): Promise<WriteResult> => {
    if (!(await lockRosterAs(tx, rosterTag))) return no(ROSTER_MOVED);
    const [shape, source] = await Promise.all([getShape(tx), getRosterSource(tx)]);
    if (!shape || source === null || (await connectedToAnotherCompany(tx))) return no(WRITE_COPY.noRoster);
    const [item] = await tx.select().from(writeQueue).where(eq(writeQueue.id, rawQueueId.toLowerCase())).for("update");
    const studentId = item?.studentId ?? null;
    if (!item || studentId === null || item.state !== "given_up") return no(LINK_MADE_GONE);
    const made = (await madeAfterGivingUp(tx, { studentId })).find((m) => m.queueId === item.id && m.role === "student");
    if (!made) return no(LINK_MADE_GONE);
    const [s] = await tx.select().from(student).where(eq(student.id, studentId)).for("update");
    if (!s?.active) return no("That student is inactive in the portal, so nothing was linked.");
    if ((await customerOfStudent(studentId, tx)) !== null) return no("That student is linked to QuickBooks already, so nothing was linked.");
    const familyCustomer = s.familyId === null ? null : await customerOfFamily(s.familyId, tx);
    const where = roleIn(buildRoster(shape, await cacheRows(tx)), made.customerQboId);
    if (familyCustomer === null || where?.role !== "student" || where.familyQboId !== familyCustomer) {
      return no(`QuickBooks doesn't have “${made.name}” as a student under the customer this student's family is linked to, so nothing was linked. Check it in QuickBooks.`);
    }
    // The link starts aligned with the version the cache holds for the customer staff confirmed (stage 3's slice 9e).
    const [row] = await tx.select({ syncToken: qboCustomer.syncToken }).from(qboCustomer).where(eq(qboCustomer.qboId, made.customerQboId));
    const [link] = await tx.insert(accountingLink).values({ system: QUICKBOOKS, realmId: source, customerId: made.customerQboId, studentId, origin: "confirmed", linkedBy: o.staffUserId,
      ...(row ? { syncedToken: row.syncToken, syncedAt: new Date() } : {}) }).returning({ id: accountingLink.id });
    await replaceRefusedCreates(tx, studentId, { op: "link_after_giving_up", customerQboId: made.customerQboId, queueId: item.id }, o);
    await writeAudit({ actor: o.actor, action: "roster.student.linked_after_giving_up", permission: o.permission, ip: o.ip, targetType: "student", targetId: String(studentId),
      after: { studentId: String(studentId), familyId: String(s.familyId), customerQboId: made.customerQboId, queueId: item.id, linkId: link!.id } }, tx);
    return { ok: true, message: `${recordNameWords(s.name, "student")} is linked to “${made.name}” in QuickBooks. Nothing was sent to QuickBooks.` };
  });
}
const LINK_MADE_GONE = "That is no longer a customer QuickBooks made for a student after making it was given up, with nothing linked to it. Reload the page.";

/** The names of the portal's own active families (members, in flat books), but `except`: a family's name must be none of them. */
async function portalFamilyNames(tx: Tx, except: AppFamilyId | null): Promise<string[]> {
  const rows = await tx.select({ id: family.id, name: family.name }).from(family).where(eq(family.active, true));
  return rows.flatMap((r) => (r.name === null || (except !== null && String(r.id) === String(except)) ? [] : [r.name]));
}
const takenHere = (name: string, offer: string | null, noun: string): WriteResult => ({ ok: false, ...(offer ? { offer } : {}),
  errors: [`Another ${noun} in the portal is called “${name}”, and every ${noun}'s name must be different.${offer ? ` You could use “${offer}” instead.` : ""}`] });
const nameIn = (name: string, names: string[]) => names.some((n) => nameKey(n) === nameKey(name));

/** Why QuickBooks didn't take a family's create, in a sentence that says nothing about the portal's own record. */
function quickBooksWhy(error: string | undefined): string {
  if (error === WRITE_COPY.notConnected) return "QuickBooks isn't connected. An Admin can connect it under QuickBooks.";
  if (error === WRITE_COPY.needsAdmin) return "QuickBooks needs to be connected again. An Admin can do that under QuickBooks.";
  if (error === WRITE_COPY.otherCompany) return "QuickBooks is connected to a different company from the one this roster was read from. An Admin can sort that out under QuickBooks.";
  return "QuickBooks wouldn't take it. Check QuickBooks.";
}

/** A new family (layered books) or member (flat books), as the page sent it: `typeQboId`, the member type chosen, when the club has several. */
export type AddFamilyAsk = { role: "family" | "member"; name: string; typeQboId: string | null };
/** Why an added family wasn't sent to QuickBooks: the staff member may not link families, or QuickBooks isn't connected. */
type NotSent = "no_permission" | "not_connected";

/**
 * Adds a family (layered books) or a member (flat books), the portal's own record first (stage 3's slice 9d, the lead's
 * decision): under the roster lock, with the page's tag, on a page that has a roster (a membership shape that holds, of
 * the roster's company), the name by checkName(), refused when another active family of the portal holds it (nameKey(),
 * "Name (2)" offered by freeName()), and, when it will be sent, when QuickBooks' names hold it (namesTaken(): the cache
 * and the waiting creates and renames), before anything is saved, so a name the portal can see is taken never leaves a
 * family behind. The record is saved active, in its own transaction with its audit row (`roster.family.added`).
 *
 * Then, only when `mayLink` (the staff member holds Accounting.Link.ReadWrite) and QuickBooks is connected, today's
 * create is sent (askRosterWrite(), with prepare()'s checks, which hold it to the roster's company and the shape, and
 * the queue's rules), filed under the new record: taken, the record is linked to the new customer (`created` by the
 * staff member); unreachable, it waits on the queue filed under the record, and the found-done path links it; refused,
 * the family stays unlinked, and the answer says so at once, with a free name offered for a taken one (to rename it on
 * its page, then press "Create in QuickBooks and link"). A staff member without the linking permission sends nothing
 * (the owner's decision of 2026-11-18): the family stays unlinked until someone who holds it presses "Create in
 * QuickBooks and link". An answer after the save is `ok`, with `unlinked` where QuickBooks doesn't have it: the family
 * is saved, so its form never offers to send the add again.
 */
export async function addFamily(ask: AddFamilyAsk, rosterTag: string, o: WriteOp & { staffUserId: string; mayLink: boolean }): Promise<WriteResult> {
  // The new record's id is chosen here, so its "being made" lock (whileMaking()) is held from before the record exists
  // until its create is answered or queued: nobody can change the family while QuickBooks may be making its customer.
  const id = asAppFamilyId(randomUUID());
  return (await whileMaking(id, () => saveAndSend(id, ask, rosterTag, o))) ?? refuse(FAMILY_SENDING);
}

/** addFamily()'s save and send, holding the new record's "being made" lock; `id` is the record's id, chosen beforehand. */
async function saveAndSend(id: AppFamilyId, ask: AddFamilyAsk, rosterTag: string, o: WriteOp & { staffUserId: string; mayLink: boolean }): Promise<WriteResult> {
  const noun = ask.role === "member" ? "member" : "family";
  type Saved = { ok: true; familyId: AppFamilyId; name: string; notSent: NotSent | null; typeQboId: string | null } | { ok: false; result: WriteResult };
  const saved = await db.transaction(async (tx): Promise<Saved> => {
    const no = (error: string): Saved => ({ ok: false, result: refuse(error) });
    if (!(await lockRosterAs(tx, rosterTag))) return no(ROSTER_MOVED);
    const [shape, source, conn, holds, other] = await Promise.all([getShape(tx), getRosterSource(tx), getConnection(tx), shapeHolds(tx), connectedToAnotherCompany(tx)]);
    if (!shape || !holds || source === null || other) return no(WRITE_COPY.noRoster);
    if ((shape.kind === "flat") !== (ask.role === "member") || !offers(shape, ask.role === "member" ? "create_member" : "create_family")) return no(WRITE_COPY.notOffered);
    const name = checkName(ask.name);
    if (!name.ok) return no(name.error);
    const notSent: NotSent | null = !o.mayLink ? "no_permission" : !conn?.realmId || !conn.refreshTokenCiphertext ? "not_connected" : null;
    const typeQboId = notSent === null ? typeForNew(shape, ask.role, ask.role === "member" ? ask.typeQboId : null) : null;
    if (notSent === null && typeQboId === null) return no(ask.role === "member" ? "Choose which kind of member this is." : WRITE_COPY.notOffered);
    const ours = await portalFamilyNames(tx, null);
    const all = notSent === null ? [...ours, ...(await namesTaken(tx, await cacheRows(tx), null))] : ours;
    const offer = freeName(name.name, all);
    if (offer) return { ok: false, result: nameIn(name.name, ours) ? takenHere(name.name, offer, noun) : taken(name.name, offer) };
    const [made] = await tx.insert(family).values({ id, name: name.name, active: true }).returning({ id: family.id });
    await writeAudit({ actor: o.actor, action: "roster.family.added", permission: o.permission, ip: o.ip, targetType: "family", targetId: String(made!.id),
      after: { familyId: String(made!.id), name: name.name, role: ask.role, quickbooks: notSent ?? "sending" } }, tx);
    return { ok: true, familyId: made!.id, name: name.name, notSent, typeQboId };
  });
  if (!saved.ok) return saved.result;
  const { name } = saved;
  const press = "press “Create in QuickBooks and link” on its page";
  if (saved.notSent === "no_permission") {
    return { ok: true, unlinked: true, message: `${name} is saved in the portal, and nothing was sent to QuickBooks: making its customer there and linking the two takes the permission to link families to accounting. It is in the portal only until someone who holds that permission can ${press}.` };
  }
  if (saved.notSent === "not_connected") {
    return { ok: true, unlinked: true, message: `${name} is saved in the portal. QuickBooks isn't connected, so it isn't in QuickBooks yet: once it is, ${press}.` };
  }
  const r = await askRosterWrite({ op: "create", role: ask.role, name, familyQboId: null, email: null, typeQboId: saved.typeQboId, familyId: saved.familyId }, rosterTag, o);
  if (r.ok && r.queued) {
    return { ok: true, queued: true, message: `${name} is saved in the portal. QuickBooks couldn't take it just now, so making it there is waiting to reach QuickBooks: the portal tries again in a minute, then less often, and links the ${noun} to it once QuickBooks has it. You'll find it on the Reconciliation page until then.` };
  }
  if (r.ok) {
    return { ok: true, message: r.message === WRITE_COPY.doneNotShown ? `${name} is saved in the portal and made in QuickBooks. The portal links the two once it has read QuickBooks again, usually within a few minutes.`
      : `${name} is saved in the portal, made in QuickBooks and linked to its new customer.` };
  }
  if (r.offer) {
    return { ok: true, unlinked: true, message: `${name} is saved in the portal, but QuickBooks wouldn't make it: “${name}” is already a name in QuickBooks, and every name there must be different. Rename the ${noun} on its page, for instance to “${r.offer}”, then press “Create in QuickBooks and link” there.` };
  }
  return { ok: true, unlinked: true, message: `${name} is saved in the portal, but it isn't in QuickBooks: ${quickBooksWhy(r.errors[0])} Once that is sorted, ${press}.` };
}

/* ---- "Create in QuickBooks and link": a family with no link, and its students with none, made in QuickBooks and
   linked one by one. Like making a family inactive it is never queued to be sent later: the staff member is waiting.
   The first step that doesn't go through stops it; a step whose answer was lost is held on the queue as possibly made,
   filed under its records, so the found-done path links it after the next roster read; pressing again carries on with
   whatever is still unlinked. It sends nothing for a guardian (slice 9g). */

type CreateWrite = Extract<RosterWrite, { op: "create" }>;
type LinkPlan = {
  ok: true; realmId: string; familyId: AppFamilyId; familyName: string; familyWrite: CreateWrite | null; familyCustomer: string | null;
  students: { id: AppStudentId; name: string | null }[]; studentTypeId: string | null;
  /** The names a new customer must not be (namesTaken(), read under the lock): each student's is held against them before it is sent. */
  taken: string[];
} | { ok: false; result: WriteResult };

/**
 * Everything checked before anything is sent, under the roster lock with the page's tag: QuickBooks connected to the
 * roster's company, the shape holding, the family record active, nothing of its own waiting on the queue, no create of
 * its own given up that QuickBooks made a customer for (madeAfterGivingUp(): a second would be made), and a create
 * given up after a try QuickBooks may have taken only once a roster read has run since. With no family link: a name
 * QuickBooks can take (checkName()) and doesn't hold already (namesTaken(), "Name (2)" offered for the family's page),
 * and the type (the shape's family type, or the member type chosen, by typeForNew()). With one: its customer an active
 * family on the roster. Then, only where the shape has a student type, the family's active students with no link and
 * no create of their own waiting, by name as rosterFamilies() orders them, then by id.
 */
async function prepareLink(rawFamilyId: string, chosenType: string | null, rosterTag: string): Promise<LinkPlan> {
  const no = (error: string): LinkPlan => ({ ok: false, result: refuse(error) });
  if (!isUuid(rawFamilyId)) return no(WRITE_COPY.gone);
  return db.transaction(async (tx): Promise<LinkPlan> => {
    if (!(await lockRosterAs(tx, rosterTag))) return no(ROSTER_MOVED);
    const [shape, source, conn, holds] = await Promise.all([getShape(tx), getRosterSource(tx), getConnection(tx), shapeHolds(tx)]);
    if (!conn?.realmId || !conn.refreshTokenCiphertext) return no(WRITE_COPY.notConnected);
    if (source === null || source !== conn.realmId) return no(WRITE_COPY.otherCompany);
    if (!shape || !holds) return no(WRITE_COPY.noRoster);
    const [f] = await tx.select().from(family).where(eq(family.id, asAppFamilyId(rawFamilyId.toLowerCase())));
    if (!f) return no(WRITE_COPY.gone);
    if (!f.active) return no(WRITE_COPY.inactiveHere);
    // Queued only: this runs while createInQuickBooksAndLink() holds the family's "being made" lock (whileMaking()).
    if (await familyCreateQueued(tx, f.id)) return no(FAMILY_WAITING);
    const role = shape.kind === "flat" ? "member" as const : "family" as const;
    const familyCustomer = await customerOfFamily(f.id, tx);
    const cache = await cacheRows(tx);
    const taken = await namesTaken(tx, cache, null);
    let familyWrite: CreateWrite | null = null;
    if (familyCustomer === null) {
      // A given-up create QuickBooks made a customer for: no second one is made, and the words say where the first is.
      const [made] = await madeAfterGivingUp(tx, { familyId: f.id });
      if (made) return no(madeAfterGivingUpWords(made.name, role));
      if (await givenUpMaybeMade(tx, { familyId: f.id })) return no(GIVEN_UP_MAYBE_MADE);
      if (f.name === null) return no(`This ${role} has no name in the portal, so it can't be made in QuickBooks. Give it a name on this page first.`);
      const name = checkName(f.name);
      if (!name.ok) return no(`Its name can't be used in QuickBooks: ${name.error} Rename it on this page first.`);
      const typeQboId = typeForNew(shape, role, role === "member" ? chosenType : null);
      if (typeQboId === null) return no(role === "member" ? "Choose which kind of member this is." : WRITE_COPY.notOffered);
      const offer = freeName(name.name, taken);
      if (offer) return no(`“${name.name}” is already a name in QuickBooks, and every name there must be different. Rename the ${role} on this page, for instance to “${offer}”, then press “Create in QuickBooks and link” again.`);
      familyWrite = { op: "create", role, name: name.name, typeQboId, familyQboId: null, email: null };
    } else {
      const c = cache.find((x) => x.qboId === familyCustomer);
      const where = roleIn(buildRoster(shape, cache), familyCustomer);
      if (!c?.active || !where || where.role !== role) {
        return no(`The customer this ${role} is linked to isn't an active ${role} on the roster, so nobody can be made under it. Check it in QuickBooks.`);
      }
      // Nobody is added under a family customer with a change of its own waiting, as prepare() refuses an add.
      const waiting = await tx.select({ id: writeQueue.id }).from(writeQueue)
        .where(and(eq(writeQueue.targetQboId, familyCustomer), inArray(writeQueue.state, ["waiting", "stuck"]))).limit(1);
      if (waiting.length) return no(WRITE_COPY.waiting);
    }
    let students: { id: AppStudentId; name: string | null }[] = [];
    if (shape.kind === "layered" && shape.studentTypeId !== null) {
      const rows = await tx.select({ id: student.id, name: student.name }).from(student).where(and(eq(student.familyId, f.id), eq(student.active, true)));
      const links = await linksOf({ families: [], students: rows.map((r) => r.id) }, tx);
      for (const r of rows) {
        // A student whose given-up create QuickBooks made, or may have made, is not made again (the Reconciliation page lists those it made).
        if (links.customerOfStudent.has(r.id) || (await studentCreateWaiting(tx, r.id)) || (await givenUpMaybeMade(tx, { studentId: r.id }))
          || (await madeAfterGivingUp(tx, { studentId: r.id })).length > 0) continue;
        students.push(r);
      }
      students = students.sort((a, b) => COLLATOR.compare(a.name ?? "", b.name ?? "") || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    }
    if (familyWrite === null && students.length === 0) return no("Everything in this family that can be made in QuickBooks is linked already, waiting to be, or was made there after making it was given up (the Reconciliation page lists those), so nothing was made.");
    return { ok: true, realmId: source, familyId: f.id, familyName: recordNameWords(f.name, "family"), familyWrite, familyCustomer, students,
      studentTypeId: shape.kind === "layered" ? shape.studentTypeId : null, taken };
  });
}

type StepSent = { ok: true; cached: boolean; customerQboId: string | null } | { ok: false; code: string; words: string; maybe: boolean };

/**
 * One create of "Create in QuickBooks and link", sent at once (never queued to be sent later): QuickBooks first, then the
 * cache and the link to the record it is filed under (applyWritten(), changeOwnRecord()), with its own
 * `roster.customer.create` row. A lost answer is held on the queue as possibly made, filed under its records, and the
 * roster read again (holdForTheQueue()), so the found-done path links it; anything else that didn't go through is said.
 */
async function sendCreateStep(write: CreateWrite, filed: Filed, said: string, realmId: string, o: WriteOp & { staffUserId: string }): Promise<StepSent> {
  let answer: Record<string, unknown>;
  try {
    answer = await sendWrite(write, realmId, { mayWait: false });
  } catch (e) {
    if (!(e instanceof QboError)) throw e;
    const failure = classify(e.code);
    const stop = (words: string, maybe = false): StepSent => ({ ok: false, code: e.code, words, maybe });
    switch (failure.kind) {
      case "duplicate": {
        const names = await db.transaction(async (tx) => namesTaken(tx, await cacheRows(tx), null));
        const offer = freeName(write.name, [...names, write.name]);
        return stop(`“${write.name}” is already a name in QuickBooks, and every name there must be different, so ${said} wasn't made there. Rename them on this page${offer ? `, for instance to “${offer}”` : ""}, then press “Create in QuickBooks and link” again.`);
      }
      case "retry":
        if (failure.sent) {
          await db.transaction(async (tx) => {
            await askForRosterRefresh(tx);
            await holdForTheQueue(tx, write, e.code, { realmId, actor: o.actor, ip: o.ip, permission: o.permission, linkedBy: o.staffUserId, filed });
          });
          return stop(`The portal can't tell whether QuickBooks made ${said}: its answer didn't arrive. The roster is read again within a few minutes to see, and the portal links ${said} then, without making it twice.`, true);
        }
        return stop(`QuickBooks couldn't take that just now, so ${said} wasn't made there. Try again in a few minutes.`);
      case "not_connected": return stop(`${said} wasn't made in QuickBooks. ${WRITE_COPY.notConnected}`);
      case "needs_admin": return stop(`${said} wasn't made in QuickBooks. ${WRITE_COPY.needsAdmin}`);
      case "other_company": return stop(`${said} wasn't made in QuickBooks. ${WRITE_COPY.otherCompany}`);
      default: return stop(e.code === "bad_id" ? `${said} couldn't be sent to QuickBooks, so it wasn't made there.` : `QuickBooks wouldn't make ${said}, so it isn't there. Check QuickBooks.`);
    }
  }
  const { cached } = await applyWritten(write, answer, { realmId, actor: o.actor, ip: o.ip, permission: o.permission, linkedBy: o.staffUserId, filed });
  return { ok: true, cached, customerQboId: typeof answer.Id === "string" ? answer.Id.slice(0, 64) : null };
}

/** What "Create in QuickBooks and link" answers: the result to show, and whether anything may have changed (the pages are then made again). */
export type LinkAnswer = { result: WriteResult; changed: boolean };

/**
 * "Create in QuickBooks and link", on the page of an active family with no link, or whose active students include one
 * with none (stage 3's slice 9d): `familyId` and, in flat books with several member types, the member type chosen, both
 * from the page and checked again under the roster lock (prepareLink()). In this order, each through sendWrite() and
 * applyWritten() with its own `roster.customer.create` row: the family's customer (today's create body), linked to the
 * record as QuickBooks answers; then, only where the shape has a student type, each active student with no link, one
 * by one in name order, with today's student create body (under the family's customer, billed with it), each filed
 * under the family and that student and linked to the existing record (changeOwnRecord() makes none). The first step
 * that doesn't go through stops it (sendCreateStep()); the answer says what was made, what wasn't and why; pressing
 * again carries on with what is still unlinked. One audit row (`roster.family.created_in_quickbooks`), targeting the
 * app's family, says how it went. Nothing is sent for a guardian.
 */
export async function createInQuickBooksAndLink(familyId: string, typeQboId: string | null, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<LinkAnswer> {
  if (!isUuid(familyId)) return { result: refuse(WRITE_COPY.gone), changed: false };
  // Its "being made" lock is held for the whole run (whileMaking()): a second press, or any change to the family, is
  // refused meanwhile rather than slipping in while QuickBooks may be making a customer.
  return (await whileMaking(asAppFamilyId(familyId.toLowerCase()), () => createAndLinkHolding(familyId, typeQboId, rosterTag, o)))
    ?? { result: refuse(FAMILY_SENDING), changed: false };
}

/** createInQuickBooksAndLink()'s run, holding the family's "being made" lock. */
async function createAndLinkHolding(familyId: string, typeQboId: string | null, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<LinkAnswer> {
  const p = await prepareLink(familyId, typeQboId, rosterTag);
  if (!p.ok) return { result: p.result, changed: false };
  type Step = { kind: "family" | "student"; id: string };
  const made: (Step & { customerQboId: string | null; name: string })[] = [];
  const studentWords = (s: { name: string | null }) => recordNameWords(s.name, "student");
  const summary = (outcome: "done" | "stopped", stopped: (Step & { code: string; maybe: boolean }) | null, notMade: string[]) =>
    writeAudit({ actor: o.actor, action: "roster.family.created_in_quickbooks", permission: o.permission, ip: o.ip, targetType: "family", targetId: String(p.familyId),
      after: { outcome, made: made.map((m) => ({ kind: m.kind, id: m.id, customerQboId: m.customerQboId })), notMade,
        ...(stopped ? { stoppedAt: { kind: stopped.kind, id: stopped.id }, code: stopped.code.slice(0, 40), ...(stopped.maybe ? { maybe: true } : {}) } : {}) } });
  /** Stopped at `at`, with the students from `from` on not made (the one stopped at among them, unless it may have been made). */
  const stop = async (at: Step, from: number, code: string, words: string, maybe: boolean): Promise<LinkAnswer> => {
    // The one stopped at may have been made (`maybe`): it is in neither list, the audit row's nor the words'.
    const later = p.students.slice(from).filter((s) => !(maybe && at.kind === "student" && String(s.id) === at.id));
    const notMade = [...(at.kind === "family" && !maybe ? [String(p.familyId)] : []), ...later.map((s) => String(s.id))];
    await summary("stopped", { ...at, code, maybe }, notMade);
    const notYet = later.map(studentWords);
    return { changed: made.length > 0 || maybe, result: { ok: false, errors: [
      made.length ? `Made in QuickBooks and linked: ${listed(made.map((m) => m.name))}.` : "Nothing was made in QuickBooks.",
      words,
      ...(notYet.length ? [`Not made in QuickBooks yet: ${listed(notYet)}.`] : []),
      maybe ? "Once the roster has been read again, press “Create in QuickBooks and link” again to carry on with whatever is still unlinked."
        : "Press “Create in QuickBooks and link” again to carry on with whatever is still unlinked.",
    ] } };
  };

  let familyCustomer = p.familyCustomer;
  const sentNames: string[] = [];
  if (p.familyWrite) {
    const at: Step = { kind: "family", id: String(p.familyId) };
    const sent = await sendCreateStep(p.familyWrite, { familyId: p.familyId, studentId: null }, p.familyName, p.realmId, o);
    if (!sent.ok) return stop(at, 0, sent.code, sent.words, sent.maybe);
    if (!sent.cached || sent.customerQboId === null) {
      // QuickBooks made it, but the portal couldn't take it in at once: it is held for the queue, which links it after
      // the next roster read. Its students wait for that.
      return stop(at, 0, "not_linked_yet", `QuickBooks made ${p.familyName}, but the portal links the two only after its next read of QuickBooks, usually within a few minutes.`, true);
    }
    made.push({ ...at, customerQboId: sent.customerQboId, name: p.familyName });
    sentNames.push(p.familyWrite.name);
    familyCustomer = sent.customerQboId;
  }
  for (const [i, s] of p.students.entries()) {
    const at: Step = { kind: "student", id: String(s.id) };
    const said = studentWords(s);
    const name = checkName(s.name ?? "");
    if (!name.ok) return stop(at, i, "bad_name", `${said} can't be made in QuickBooks under that name: ${name.error} Rename the student on this page first.`, false);
    // A name QuickBooks' names hold already (the cache, a waiting create or rename, or one this run just sent) is met
    // here, as prepare() meets it for any add, rather than sent to be refused, or to take a waiting rename's name.
    const offer = freeName(name.name, [...p.taken, ...sentNames]);
    if (offer) return stop(at, i, "name_taken", `“${name.name}” is already a name in QuickBooks, and every name there must be different, so ${said} wasn't made there. Rename them on this page, for instance to “${offer}”, then press “Create in QuickBooks and link” again.`, false);
    const write: CreateWrite = { op: "create", role: "student", name: name.name, typeQboId: p.studentTypeId!, familyQboId: familyCustomer!, email: null };
    // A refused create of the same student (stage 3's slice 9e) is taken over by this one once QuickBooks has made it and
    // the student is linked (applyWritten(), or the found-done path after a lost answer): one that fails leaves it kept.
    const sent = await sendCreateStep(write, { familyId: p.familyId, studentId: s.id }, said, p.realmId, o);
    if (!sent.ok) return stop(at, i, sent.code, sent.words, sent.maybe);
    if (!sent.cached) return stop(at, i, "not_linked_yet", `QuickBooks made ${said}, but the portal links the two only after its next read of QuickBooks, usually within a few minutes.`, true);
    made.push({ ...at, customerQboId: sent.customerQboId, name: said });
    sentNames.push(write.name);
  }
  await summary("done", null, []);
  return { changed: true, result: { ok: true, message: `Made in QuickBooks and linked: ${listed(made.map((m) => m.name))}.` } };
}

/* ---- An unlinked family's own changes, saved in the portal only (stage 3's slice 9d; spec section 5: "A change to an
   unlinked family stays in the app"; "An unlinked family has no balance to check") ---- */

/**
 * What staff change on a family with no link, or on a student with no link of their own (one a stopped "Create in
 * QuickBooks and link" left in a linked family), as the page sent it: the app's ids, each a uuid. Moving such a student,
 * or anyone into such a family, is not one of them (slice 9f).
 */
export type PortalChange =
  | { op: "add_student"; familyId: string; name: string }
  | { op: "rename_family"; familyId: string; name: string }
  | { op: "deactivate_family"; familyId: string }
  | { op: "rename_student"; studentId: string; name: string }
  | { op: "deactivate_student"; studentId: string };

const INACTIVE_HERE = "That is inactive in the portal, so nothing was changed.";

/**
 * A change to an unlinked family, or to a student with no link, saved in the portal only: nothing is sent to QuickBooks
 * and no balance is read (an unlinked record has none to check). Under the roster lock with the page's tag, on a page
 * that has a roster; every id from the page is looked up under the lock. Refused, changing nothing: a record that is
 * linked (that path stays QuickBooks first, then the record), an inactive one, one whose own create is waiting or stuck
 * on the queue (familyCreateWaiting()), a name checkName() refuses or another active family holds. Each is audited in
 * the same transaction: `roster.student.added`, `roster.record.renamed`, `roster.record.made_inactive` (a family goes
 * with its active students, none of which may be linked).
 */
export async function changeInPortal(ask: PortalChange, rosterTag: string, o: WriteOp): Promise<WriteResult> {
  return db.transaction(async (tx): Promise<WriteResult> => {
    if (!(await lockRosterAs(tx, rosterTag))) return refuse(ROSTER_MOVED);
    const [shape, source, holds, other] = await Promise.all([getShape(tx), getRosterSource(tx), shapeHolds(tx), connectedToAnotherCompany(tx)]);
    if (!shape || !holds || source === null || other) return refuse(WRITE_COPY.noRoster);
    const noun = shape.kind === "flat" ? "member" : "family";
    const audit = (action: string, targetType: "family" | "student", targetId: string, before: Record<string, unknown> | null, after: Record<string, unknown>) =>
      writeAudit({ actor: o.actor, action, permission: o.permission, ip: o.ip, targetType, targetId, before, after: { ...after, quickbooks: "not_sent" } }, tx);

    if (ask.op === "add_student" || ask.op === "rename_family" || ask.op === "deactivate_family") {
      if (!isUuid(ask.familyId)) return refuse(WRITE_COPY.gone);
      const [f] = await tx.select().from(family).where(eq(family.id, asAppFamilyId(ask.familyId.toLowerCase()))).for("update");
      if (!f) return refuse(WRITE_COPY.gone);
      if (!f.active) return refuse(INACTIVE_HERE);
      if ((await familyLinkState(f.id, tx)).state !== "none") return refuse(LINKED_HERE);
      const making = await familyCreateWaiting(tx, f.id);
      if (making) return refuse(making === "sending" ? FAMILY_SENDING : FAMILY_WAITING);
      const familyName = recordNameWords(f.name, "family");
      if (ask.op === "add_student") {
        if (!offers(shape, "add_student")) return refuse(WRITE_COPY.notOffered);
        const name = checkName(ask.name);
        if (!name.ok) return refuse(name.error);
        const [made] = await tx.insert(student).values({ familyId: f.id, name: name.name, active: true }).returning({ id: student.id });
        await audit("roster.student.added", "student", String(made!.id), null, { studentId: String(made!.id), familyId: String(f.id), name: name.name });
        return { ok: true, message: `${name.name} is added to ${familyName} in the portal.` };
      }
      if (ask.op === "rename_family") {
        const name = checkName(ask.name);
        if (!name.ok) return refuse(name.error);
        if (f.name === name.name) return refuse(ALREADY_NAMED);
        const others = await portalFamilyNames(tx, f.id);
        if (nameIn(name.name, others)) return takenHere(name.name, freeName(name.name, others), noun);
        await tx.update(family).set({ name: name.name, updatedAt: new Date() }).where(eq(family.id, f.id));
        await audit("roster.record.renamed", "family", String(f.id), { name: f.name }, { kind: "family", familyId: String(f.id), name: name.name });
        return { ok: true, message: `Renamed ${name.name} in the portal.` };
      }
      // Made inactive with its active students: none of them may be linked (each of those is made inactive in QuickBooks first).
      const under = await tx.select({ id: student.id }).from(student).where(and(eq(student.familyId, f.id), eq(student.active, true))).for("update");
      const links = await linksOf({ families: [], students: under.map((s) => s.id) }, tx);
      if (under.some((s) => links.customerOfStudent.has(s.id))) {
        return refuse(`A student of ${familyName} is linked to QuickBooks: make them inactive there first, from this page, then make the ${noun} inactive.`);
      }
      for (const s of under) if (await studentCreateWaiting(tx, s.id)) return refuse(STUDENT_WAITING);
      const now = new Date();
      if (under.length) await tx.update(student).set({ active: false, updatedAt: now }).where(inArray(student.id, under.map((s) => s.id)));
      await tx.update(family).set({ active: false, updatedAt: now }).where(eq(family.id, f.id));
      await audit("roster.record.made_inactive", "family", String(f.id), { active: true }, { kind: "family", familyId: String(f.id), students: under.map((s) => String(s.id)) });
      return { ok: true, message: under.length ? `Made ${familyName} inactive in the portal, with ${under.length === 1 ? "its student" : `its ${under.length} students`}.` : `Made ${familyName} inactive in the portal.` };
    }

    if (!isUuid(ask.studentId)) return refuse(WRITE_COPY.gone);
    const [s] = await tx.select().from(student).where(eq(student.id, asAppStudentId(ask.studentId.toLowerCase()))).for("update");
    if (!s || s.familyId === null) return refuse(WRITE_COPY.gone);
    if (!s.active) return refuse(INACTIVE_HERE);
    const [f] = await tx.select({ active: family.active }).from(family).where(eq(family.id, s.familyId));
    if (!f?.active) return refuse(INACTIVE_HERE);
    if ((await customerOfStudent(s.id, tx)) !== null) return refuse(LINKED_HERE);
    const making = await familyCreateWaiting(tx, s.familyId);
    if (making) return refuse(making === "sending" ? FAMILY_SENDING : FAMILY_WAITING);
    if (await studentCreateWaiting(tx, s.id)) return refuse(STUDENT_WAITING);
    if (ask.op === "rename_student") {
      const name = checkName(ask.name);
      if (!name.ok) return refuse(name.error);
      if (s.name === name.name) return refuse(ALREADY_NAMED);
      await tx.update(student).set({ name: name.name, updatedAt: new Date() }).where(eq(student.id, s.id));
      await audit("roster.record.renamed", "student", String(s.id), { name: s.name }, { kind: "student", studentId: String(s.id), familyId: String(s.familyId), name: name.name });
      return { ok: true, message: `Renamed ${name.name} in the portal.` };
    }
    await tx.update(student).set({ active: false, updatedAt: new Date() }).where(eq(student.id, s.id));
    await audit("roster.record.made_inactive", "student", String(s.id), { active: true }, { kind: "student", studentId: String(s.id), familyId: String(s.familyId) });
    return { ok: true, message: `Made ${recordNameWords(s.name, "student")} inactive in the portal.` };
  });
}

/** The family records whose own create is waiting or stuck on the queue (familyCreateWaiting(), for many at once): for the Families list's words. */
export async function familiesBeingMade(): Promise<Set<string>> {
  const rows = await db.select({ familyId: writeQueue.familyId }).from(writeQueue).where(and(inArray(writeQueue.state, ["waiting", "stuck"]), isFamilyCreate));
  return new Set(rows.flatMap((r) => (r.familyId === null ? [] : [String(r.familyId)])));
}

/** Those of these students whose own create is waiting or stuck on the queue (studentCreateWaiting(), for many at once): for a family's page. */
export async function studentsBeingMade(studentIds: AppStudentId[]): Promise<Set<string>> {
  if (!studentIds.length) return new Set();
  const rows = await db.select({ studentId: writeQueue.studentId }).from(writeQueue)
    .where(and(inArray(writeQueue.studentId, studentIds), inArray(writeQueue.state, ["waiting", "stuck"]), isStudentCreate));
  return new Set(rows.flatMap((r) => (r.studentId === null ? [] : [String(r.studentId)])));
}

/* ---- A change to a linked record saved in the portal first (stage 3's slice 9e; app-owned families spec section 5: "A
   change to a linked person is saved in the app first, then sent to QuickBooks"; open question 10) ----
   A rename of a linked family, member or student, and a student added to a linked family, are saved in the portal
   first, in one transaction with their audit row, and then sent with today's request bodies and queue rules. A rename
   is sent with its link's own version (`accounting_link.synced_token`), never a page's or the cache's; a stale answer,
   or a link with none, is settled by the field (the lead's decision 3): the record is read live and its name compared
   with the portal's name before the change. As the portal held it: sent once more with the version just read. Not: kept
   as refused, nothing overwritten. What QuickBooks refuses is kept as a `refused` item, listed on Reconciliation with
   "Send the portal's value" and "Give up"; the portal's value is never undone. Moving a student and making anyone
   inactive keep slice 9c's order, QuickBooks first (slices 9f and 9g). */

type RenameWrite = Extract<RosterWrite, { op: "rename" }>;
type QueueRow = typeof writeQueue.$inferSelect;

/** First key of the lock held while a change to one record is being sent; the second is a hash of the record's id. */
export const SENDING_LOCK = 7461012;
/** A record a change of which is being sent to QuickBooks at this moment (whileSending()). */
export const BEING_SENT = "A change to this is being sent to QuickBooks at this moment, so nothing else can be changed on it. Try again in a minute.";
/** "Try again now" on a change saved first that is being sent at this moment (at once, by "Send the portal's value", or by the worker): nothing is done. */
export const BEING_SENT_NOW = "This change is being sent to QuickBooks at this moment, so it isn't tried again now. Reload the page in a minute to see how it went.";
const NOT_LINKED = "That isn't linked to QuickBooks, so a change to it is saved in the portal only: reload the page and use “Change in the portal”.";
const NOT_AS_SHOWN = "That didn't go through. Reload the page and try again.";
const NO_LONGER_REFUSED = "That is no longer kept: it was sent, given up, or replaced by a later change. Reload the page.";
const RECORD_MOVED_ON = "The portal's own record changed since this was kept (renamed, moved, made inactive or unlinked), so nothing was sent. Reload the page.";
const STUDENT_RENAMED = "The student was renamed in the portal since this page was shown, so nothing was sent. Reload the page to see the name that would be sent.";
const INACTIVE_THERE = "QuickBooks has that customer inactive, so nothing was sent: the portal never makes a customer active again.";
/**
 * Why a rename QuickBooks refused as a taken name (6240) isn't sent again: a later rename to a free name takes its place,
 * and is sent, since it is compared with the name the portal and QuickBooks last agreed on (renameLinked()).
 */
export const TAKEN_NAME_KEPT = "QuickBooks refused that name as taken, so it isn't sent again as it is: rename the record on its family's page to a free name. That rename is sent to QuickBooks and takes the place of this change.";
/** The code of a rename whose link held no version, and whose live read found the name changed in QuickBooks. */
export const NO_LINK_VERSION = "no_link_version";
/**
 * The code of a rename whose cache showed another name than the one it is compared with (the name the portal and
 * QuickBooks last agreed on), and whose live read found it so.
 */
export const NAME_DIFFERS = "name_differs";
/** The code of a rename the portal held back because QuickBooks' live read showed the customer inactive. */
export const INACTIVE_THERE_CODE = "inactive_there";
/** How long a change saved first is the at-once try's before the worker may take it: longer than one try takes. */
const SAVED_LEASE_MS = 60_000;
const short = (code: string) => code.slice(0, 40);

/**
 * Runs `send` holding the record's "being sent" lock, in a transaction of its own that holds nothing else, from before
 * its change is saved until its answer is taken in, or it is queued or kept: two renames of one record at once never
 * send twice with one version. Null, sending nothing, when someone else holds it.
 */
async function whileSending<T>(recordId: string, send: () => Promise<T>): Promise<T | null> {
  return db.transaction(async (hold) => {
    const [lock] = (await hold.execute(sql`select pg_try_advisory_xact_lock(${sql.raw(String(SENDING_LOCK))}, hashtext(${recordId}::text)) as locked`)) as unknown as { locked: boolean }[];
    if (!lock?.locked) return null;
    return send();
  });
}

/**
 * Whether a queue item is a change saved in the portal first (stage 3's slice 9e), whose refusals are kept as
 * `refused`: a rename of a family, member or student (a parent's keeps its page's version and today's rules), or a
 * student's create filed under the student record.
 */
export const isSavedFirst = (item: Pick<QueueRow, "request" | "studentId">) => {
  const w = item.request;
  return (w.op === "rename" && w.role !== "parent") || (w.op === "create" && w.role === "student" && item.studentId !== null);
};

/**
 * The lock a change saved first is sent under, by whoever sends it (the staff member at once, "Send the portal's
 * value", or the queue's worker): a rename, its record's "being sent" lock (the student's, else the family's); a
 * student's create, the family's "being made" lock. None for an item filed under no record.
 */
function lockOfItem(item: Pick<QueueRow, "request" | "familyId" | "studentId">): { making: AppFamilyId } | { sending: string } | null {
  if (item.request.op === "create") return item.familyId === null ? null : { making: item.familyId };
  const id = item.studentId ?? item.familyId;
  return id === null ? null : { sending: String(id) };
}

/** Runs `send` holding the lock a change saved first is sent under (lockOfItem()): null, sending nothing, while someone else holds it. */
export async function whileItemHeld<T>(item: Pick<QueueRow, "request" | "familyId" | "studentId">, send: () => Promise<T>): Promise<T | null> {
  const lock = lockOfItem(item);
  if (lock === null) return send();
  return "making" in lock ? whileMaking(lock.making, send) : whileSending(lock.sending, send);
}

/**
 * Whether nobody is sending a change saved first at this moment ("Try again now"): its lock (lockOfItem()) tried
 * shared, and held so to the end of the caller's transaction, so no send starts before the caller's change is committed.
 */
export async function itemLockFree(tx: Tx, item: Pick<QueueRow, "request" | "familyId" | "studentId">): Promise<boolean> {
  const lock = lockOfItem(item);
  if (lock === null) return true;
  const keys = "making" in lock ? makingLock(lock.making) : sql`${sql.raw(String(SENDING_LOCK))}, hashtext(${lock.sending}::text)`;
  const [r] = (await tx.execute(sql`select pg_try_advisory_xact_lock_shared(${keys}) as locked`)) as unknown as { locked: boolean }[];
  return r?.locked === true;
}

/** One customer read live from QuickBooks: its name, whether it is active, and its version. */
type Live = { ok: true; answer: Record<string, unknown>; syncToken: string; name: string | null; active: boolean } | { ok: false; code: string };
async function readLive(qboId: string, realmId: string, mayWait: boolean): Promise<Live> {
  let c: Record<string, unknown> | null;
  try { c = await qboCustomerById(qboId, mayWait ? { realmId, timeoutMs: BALANCE_READ_TIMEOUT_MS } : { failFast: true, realmId, timeoutMs: BALANCE_READ_TIMEOUT_MS }); } catch (e) {
    if (!(e instanceof QboError)) throw e;
    return { ok: false, code: e.code === "busy" ? `${NO_TOKEN}busy` : e.code };
  }
  if (!c || c.Id !== qboId) return { ok: false, code: "not_the_customer" };
  const syncToken = typeof c.SyncToken === "string" && /^\d{1,20}$/.test(c.SyncToken) ? c.SyncToken : null;
  if (syncToken === null) return { ok: false, code: "bad_answer" };
  return { ok: true, answer: c, syncToken, name: typeof c.DisplayName === "string" ? c.DisplayName : null, active: c.Active !== false };
}

/**
 * One send of a rename of a linked record, by the lead's decision 3: with the version it carries (the link's own,
 * queued with it), unless it carries none, or the caller already knows the name differs in QuickBooks (`readFirst`: the
 * cache shows another name than `was`, or the queue's look found the record moved on). On QuickBooks' stale answer
 * (5010), and in those cases, the record is read live (stored in the cache when newer, as readAgain() stores it) and
 * its name compared with `was`, the name the portal and QuickBooks last agreed on: as it reads so, it is sent once more
 * with the version just read (`checked`); otherwise nothing more is sent (`changed`, kept by the caller). QuickBooks
 * holding the new name already sends nothing (`in_place`), and so does QuickBooks having the customer inactive
 * (`changed`, `inactive_there`: the portal never sends a change to a customer QuickBooks has inactive over that, and
 * never makes one active). A second stale answer is `stale_again`. Never more than one resend. `failed.sent`: QuickBooks
 * may have acted on it (a lost answer); `failed.write` is what was last sent.
 */
export type RenameTry =
  | { is: "answer"; write: RenameWrite; answer: Record<string, unknown>; resent: "stale" | "no_version" | "differs" | null }
  | { is: "in_place" }
  | { is: "failed"; code: string; sent: boolean; write: RenameWrite }
  | { is: "changed"; code: string; holds: string | null }
  | { is: "stale_again" };
export async function tryRename(w: RenameWrite, realmId: string, o: { mayWait: boolean; readFirst: "moved_on" | "differs" | null; actor: Actor; ip: string | null; permission?: string }): Promise<RenameTry> {
  let why: "stale" | "no_version" | "differs" | "moved_on";
  if (o.readFirst) why = o.readFirst;
  else if (w.syncToken === "") why = "no_version";
  else {
    try {
      return { is: "answer", write: w, answer: await sendWrite(w, realmId, { mayWait: o.mayWait }), resent: null };
    } catch (e) {
      if (!(e instanceof QboError)) throw e;
      const failure = classify(e.code);
      if (failure.kind !== "stale") return { is: "failed", code: e.code, sent: failure.kind === "retry" && failure.sent, write: w };
      why = "stale";
    }
  }
  // The field is the arbiter: QuickBooks' name now, against the one the portal and QuickBooks last agreed on (never the
  // portal's new value, never the cache).
  const live = await readLive(w.qboId, realmId, o.mayWait);
  if (!live.ok) return { is: "failed", code: live.code, sent: false, write: w };
  await storeReadAgain(live.answer, realmId, o);
  if (live.name === w.name) return { is: "in_place" };
  if (!live.active) return { is: "changed", holds: live.name, code: INACTIVE_THERE_CODE };
  if (live.name !== w.was) {
    return { is: "changed", holds: live.name, code: why === "stale" ? "fault_5010" : why === "no_version" ? NO_LINK_VERSION : why === "differs" ? NAME_DIFFERS : "moved_on" };
  }
  const again: RenameWrite = { ...w, syncToken: live.syncToken, checked: true };
  try {
    return { is: "answer", write: again, answer: await sendWrite(again, realmId, { mayWait: o.mayWait }), resent: why === "moved_on" ? "stale" : why };
  } catch (e) {
    if (!(e instanceof QboError)) throw e;
    const failure = classify(e.code);
    if (failure.kind === "stale") return { is: "stale_again" };
    return { is: "failed", code: e.code, sent: failure.kind === "retry" && failure.sent, write: again };
  }
}

/**
 * Who stopped a change the portal kept (a `refused` item), by its code: QuickBooks refused it (`quickbooks`); the portal
 * held it back, as QuickBooks has another name than the one it is compared with or has the customer inactive (`held`);
 * or the portal couldn't send it, as QuickBooks wasn't connected, was another company's or needed an Admin, or the id
 * isn't one QuickBooks uses (`not_sent`).
 */
export function whoStopped(code: string | null): "quickbooks" | "held" | "not_sent" {
  if (code === "fault_5010" || code === "moved_on" || code === NO_LINK_VERSION || code === NAME_DIFFERS || code === INACTIVE_THERE_CODE || code === "not_the_customer") return "held";
  if (code === null || code === "bad_id") return "not_sent";
  const kind = classify(code).kind;
  return kind === "needs_admin" || kind === "not_connected" || kind === "other_company" || kind === "retry" ? "not_sent" : "quickbooks";
}

/**
 * Why a change the portal kept (a `refused` item) didn't go through, in words, for every code such an item can hold,
 * saying who stopped it (whoStopped()): never the code itself. `holds`: what QuickBooks has for the record now (the
 * roster cache's name), for a rename, said as text.
 */
export function keptRefusalWords(code: string | null, holds: string | null): string {
  const now = holds ? ` QuickBooks has “${holds}” now.` : "";
  if (code === "fault_5010" || code === "moved_on" || code === NO_LINK_VERSION) {
    return `The portal held it back: someone changed the name in QuickBooks since the portal last sent it, so the portal's name wasn't sent over it.${now}`;
  }
  // The cache showed another name than the one this rename was to replace (the name the portal and QuickBooks last
  // agreed on, or the portal's own once an earlier change was given up): an edit made in QuickBooks, or an earlier change
  // of the portal's that never reached it and was given up. Which, the portal can't tell, so it says neither.
  if (code === NAME_DIFFERS) {
    return `The portal held it back: QuickBooks has another name than the one this rename was to replace (someone may have renamed it there, or an earlier change from the portal never reached it and was given up), so the portal's name wasn't sent over it.${now}`;
  }
  if (code === INACTIVE_THERE_CODE) return `The portal held it back: QuickBooks has this customer inactive, and the portal never sends a change to it or makes it active again.${now}`;
  if (code === "not_the_customer") return "The portal held it back: QuickBooks answered about another record when the portal read it.";
  if (code === "fault_6240") return "QuickBooks refused it: that name is already used in QuickBooks (by another customer, a vendor or an employee), and every name there must be different.";
  const kind = code === null ? "retry" : classify(code).kind;
  if (kind === "needs_admin") return "It couldn't be sent to QuickBooks: QuickBooks needs to be connected again, which an Admin can do under QuickBooks.";
  if (kind === "not_connected") return "It couldn't be sent to QuickBooks: QuickBooks wasn't connected.";
  if (kind === "other_company") return "It couldn't be sent to QuickBooks: QuickBooks was connected to a different company from the one the roster was read from.";
  if (code === "bad_id") return "It couldn't be sent to QuickBooks: the customer's id isn't one QuickBooks uses.";
  if (kind === "retry") return "It couldn't be sent to QuickBooks: QuickBooks couldn't be reached at the time.";
  return "QuickBooks refused it: QuickBooks wouldn't take it.";
}

/**
 * The refused items a later change to the same record takes the place of, closed as given up, each audited
 * (`roster.write.replaced`) with what replaced it, in the caller's transaction: the one that saves the new change. Each
 * with what it asked, so a rename can take the name it was compared with (renameLinked()).
 */
async function replaceRefused(tx: Tx, which: SQL | undefined, replacedBy: Record<string, unknown>, o: { actor: Actor; ip: string | null; permission?: string }): Promise<{ id: string; request: RosterWrite }[]> {
  const rows = await tx.update(writeQueue).set({ state: "given_up", note: "Replaced by a later change to the same record.", nextTryAt: null, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(writeQueue.state, "refused"), which)).returning({ id: writeQueue.id, lastCode: writeQueue.lastCode, request: writeQueue.request, createdAt: writeQueue.createdAt });
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const r of rows) {
    await writeAudit({ actor: o.actor, action: "roster.write.replaced", permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: r.id,
      before: { state: "refused", code: r.lastCode }, after: { state: "given_up", replacedBy } }, tx);
  }
  return rows.map((r) => ({ id: r.id, request: r.request as RosterWrite }));
}
/**
 * A student just linked to a customer (a create QuickBooks took, at once or found made, or one staff confirmed): every
 * refused create of that student is taken over by it (the lead's decision 4), closed as given up, audited, in the
 * caller's transaction. Only once the link is made, so a create that then fails leaves the refusal kept.
 */
export async function replaceRefusedCreates(tx: Tx, studentId: AppStudentId, replacedBy: Record<string, unknown>, o: { actor: Actor; ip: string | null; permission?: string }): Promise<string[]> {
  return (await replaceRefused(tx, and(eq(writeQueue.studentId, studentId), isStudentCreate), replacedBy, o)).map((r) => r.id);
}
const renamesOf = (customer: string) => and(eq(writeQueue.targetQboId, customer), sql`${writeQueue.request}->>'op' = 'rename'`);

/** A change waiting or stuck for a customer (prepare()'s waitingFor()): a refused one blocks nothing. */
async function waitingForCustomer(tx: Tx, qboId: string): Promise<boolean> {
  return (await tx.select({ id: writeQueue.id }).from(writeQueue).where(and(eq(writeQueue.targetQboId, qboId), inArray(writeQueue.state, ["waiting", "stuck"]))).limit(1)).length > 0;
}

/** The checks every change saved first makes before anything is saved, under the roster lock with the page's tag: a roster of the company QuickBooks is connected to, and a shape that holds. */
async function readyToSend(tx: Tx, rosterTag: string): Promise<{ ok: true; shape: MembershipShape; source: string; cache: (Cust & { syncToken: string })[]; roster: Roster } | { ok: false; error: string }> {
  if (!(await lockRosterAs(tx, rosterTag))) return { ok: false, error: ROSTER_MOVED };
  const [shape, source, conn, types] = await Promise.all([getShape(tx), getRosterSource(tx), getConnection(tx), tx.select().from(qboCustomerType)]);
  if (!conn?.realmId || !conn.refreshTokenCiphertext) return { ok: false, error: WRITE_COPY.notConnected };
  if (source === null || source !== conn.realmId) return { ok: false, error: WRITE_COPY.otherCompany };
  if (!shape || missingTypes(shape, types.map((t) => ({ qboId: t.qboId, name: t.name, active: t.active }))).length) return { ok: false, error: WRITE_COPY.noRoster };
  const cache = await cacheRows(tx);
  return { ok: true, shape, source, cache, roster: buildRoster(shape, cache) };
}

/**
 * A change saved first put on the queue in the transaction that saves the portal's value (the lead's decision 1 for
 * the fixes of slice 9e, as a buy-out's confirm queues its invoice): waiting, never sent, filed under its records,
 * holding what is asked with its before-value. The at-once try that follows is a try of this item, so a process that
 * stops in between leaves an item the worker tries once its lease (SAVED_LEASE_MS) has run out, and Reconciliation
 * shows it meanwhile. Its insert is audited by the caller's row of the save, which names it (`queueId`).
 */
async function queueSaved(tx: Tx, write: RenameWrite | CreateWrite, realmId: string, filed: Filed, o: WriteOp & { staffUserId: string }): Promise<QueueRow> {
  const [item] = await tx.insert(writeQueue).values({
    realmId, request: write, targetQboId: write.op === "create" ? null : write.qboId, familyId: filed.familyId, studentId: filed.studentId,
    state: "waiting", sent: false, tries: 0, lastCode: null, nextTryAt: new Date(Date.now() + SAVED_LEASE_MS), askedBy: o.staffUserId, askedByLabel: o.actor.label,
  }).returning();
  return item!;
}

/** Who tries a change saved first: the staff member who made it, at once; the queue's worker; or "Send the portal's value". */
type TryBy = "at_once" | "worker" | "press";
/** An item as it was before "Send the portal's value" put it back on the queue for its send: what a refusal keeps. */
type Before = { request: RosterWrite; sent: boolean; lastCode: string | null; tries: number; lastTriedAt: Date };

/**
 * What one try of a change saved first came to, its item settled to match: `done`, QuickBooks took it (`cached` false:
 * the portal finishes it on its side after its next read); `found`, QuickBooks holds it already, nothing sent;
 * `waiting`, for a later try (`sent`: QuickBooks may have made it, and it is looked for after a roster read first);
 * `stuck`, the worker's, as any item's; `refused`, kept, with who stopped it in its code (whoStopped()); `not_reached`,
 * "Send the portal's value" reached nothing, so the item is kept refused as it was; `given_up`, staff gave it up while
 * it was on its way, and it stays so.
 */
export type SavedTry =
  | { is: "done"; cached: boolean }
  | { is: "found" }
  | { is: "waiting"; sent: boolean }
  | { is: "stuck"; code: string }
  | { is: "refused"; code: string; holds: string | null }
  | { is: "not_reached"; code: string }
  | { is: "given_up" };

/** The state an item of a change saved first is settled to, with its audit row, in one transaction, only while it is still waiting. Whether it was. */
async function settleSaved(item: QueueRow, to: { state: "done"; resultQboId: string | null } | { state: "waiting" | "stuck"; code: string; sent: boolean; request: RosterWrite; nextTryAt: Date | null }
  | { state: "refused"; code: string | null; before: Before }, triedAt: Date, o: { by: TryBy; actor: Actor; ip: string | null; permission?: string }): Promise<boolean> {
  return db.transaction(async (tx) => {
    const audit = (action: string, after: Record<string, unknown>) => writeAudit({ actor: o.actor, action, permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: item.id,
      before: { state: item.state, tries: item.tries, code: item.lastCode }, after }, tx);
    if (to.state === "done") {
      const [still] = await tx.update(writeQueue).set({ state: "done", resultQboId: to.resultQboId, tries: item.tries + 1, lastTriedAt: triedAt, nextTryAt: null, finishedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(writeQueue.id, item.id), eq(writeQueue.state, "waiting"))).returning({ id: writeQueue.id });
      if (still) await audit("roster.write.done", { state: "done", how: "found", tries: item.tries + 1, ...(to.resultQboId ? { resultQboId: to.resultQboId } : {}) });
      return still !== undefined;
    }
    if (to.state === "refused") {
      // `code` null: nothing reached QuickBooks ("Send the portal's value" not reached), so the item is kept as it was.
      const b = to.before;
      const [still] = await tx.update(writeQueue).set({ state: "refused", sent: b.sent, request: b.request, nextTryAt: null, lastCode: to.code === null ? b.lastCode : short(to.code),
        tries: to.code === null ? b.tries : item.tries + 1, lastTriedAt: to.code === null ? b.lastTriedAt : triedAt, updatedAt: new Date() })
        .where(and(eq(writeQueue.id, item.id), eq(writeQueue.state, "waiting"))).returning({ id: writeQueue.id });
      if (still) await audit("roster.write.kept_refused", { op: b.request.op, role: b.request.role, code: short(to.code ?? b.lastCode ?? ""), state: "refused", ...(to.code === null ? { reached: false } : {}) });
      return still !== undefined;
    }
    const [still] = await tx.update(writeQueue).set({ state: to.state, lastCode: short(to.code), sent: to.sent, request: to.request, tries: item.tries + 1, lastTriedAt: triedAt,
      nextTryAt: to.nextTryAt, updatedAt: new Date() }).where(and(eq(writeQueue.id, item.id), eq(writeQueue.state, "waiting"))).returning({ id: writeQueue.id });
    if (still) {
      await audit(to.state === "stuck" ? "roster.write.stuck" : o.by === "worker" ? "roster.write.retry" : "roster.write.queued",
        { op: to.request.op, role: to.request.role, state: to.state, tries: item.tries + 1, code: short(to.code), sent: to.sent });
    }
    return still !== undefined;
  });
}

/** A try of a change saved first QuickBooks took, finished in applyWritten()'s transaction: done, audited, only while it is still waiting (given up meanwhile, it stays so). */
async function doneIn(tx: Tx, item: QueueRow, resultQboId: string | null, triedAt: Date, o: { actor: Actor; ip: string | null; permission?: string }): Promise<void> {
  const [still] = await tx.update(writeQueue).set({ state: "done", resultQboId, tries: item.tries + 1, lastTriedAt: triedAt, nextTryAt: null, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(writeQueue.id, item.id), eq(writeQueue.state, "waiting"))).returning({ id: writeQueue.id });
  if (!still) return;
  await writeAudit({ actor: o.actor, action: "roster.write.done", permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: item.id,
    before: { state: "waiting", tries: item.tries, code: item.lastCode }, after: { state: "done", how: "sent", tries: item.tries + 1, ...(resultQboId ? { resultQboId } : {}) } }, tx);
}

/**
 * One try of a change saved first (a rename of a linked record, or a student's create filed under the student), whoever
 * makes it: the staff member at once, the queue's worker, or "Send the portal's value". The caller holds the item's lock
 * (whileItemHeld()), so nobody else sends it meanwhile, and the item is waiting. It is marked as maybe sent, at the time
 * of this send, before it goes (staff who give it up while it is on its way leave it so, and a send cut off midway is
 * looked for after the next roster read). A rename goes by tryRename()'s rule: compared with `was` first when the cache
 * already shows another name (`readFirst` "differs"), or when the queue's look found the record moved on. Its answer
 * settles that same item: done (applyWritten(), its link aligned by the rule), found, waiting for a later try, kept
 * refused, or, for the worker, stuck as any item. A connection only a person can mend (not connected, needing an Admin,
 * another company) keeps it refused at once and on a press, so a later rename takes its place and is sent once it is
 * mended (renameLinked()); the worker's is stuck. A press that reaches nothing leaves the item refused as it was.
 */
export async function trySavedItem(item: QueueRow, write: RenameWrite | CreateWrite, o: { by: TryBy; readFirst?: "moved_on" | null; linkedBy: string | null; actor: Actor; ip: string | null;
  permission?: string; now?: Date; before?: Before }): Promise<SavedTry> {
  const before: Before = o.before ?? { request: item.request as RosterWrite, sent: item.sent, lastCode: item.lastCode, tries: item.tries, lastTriedAt: item.lastTriedAt };
  const now = o.now ?? new Date();
  const mayWait = o.by === "worker";
  const filed: Filed = { familyId: item.familyId, studentId: item.studentId };
  const triedAt = new Date();
  const [marked] = await db.update(writeQueue).set({ sent: true, request: write, lastTriedAt: triedAt, updatedAt: new Date() })
    .where(and(eq(writeQueue.id, item.id), eq(writeQueue.state, "waiting"))).returning({ id: writeQueue.id });
  const gone: SavedTry = { is: "given_up" };
  if (!marked) return gone;

  const refused = async (code: string, holds: string | null): Promise<SavedTry> =>
    (await settleSaved(item, { state: "refused", code, before }, triedAt, o)) ? { is: "refused", code, holds } : gone;
  /** For a later try: `sentNow`, this try may have reached QuickBooks; `request`, what a later look finds it as. */
  const later = async (code: string, sentNow: boolean, request: RosterWrite): Promise<SavedTry> => {
    if (o.by === "press" && !sentNow) return (await settleSaved(item, { state: "refused", code: null, before }, triedAt, o)) ? { is: "not_reached", code } : gone;
    const next = o.by === "press" ? { state: "waiting" as const, nextTryAt: new Date(Date.now() + SAVED_LEASE_MS) } : afterFailedTry(item.tries + 1, item.createdAt, now);
    const sent = sentNow || (o.by !== "press" && before.sent);
    const ok = await settleSaved(item, { state: next.state, code, sent, request, nextTryAt: next.state === "waiting" ? next.nextTryAt : null }, triedAt, o);
    return !ok ? gone : next.state === "stuck" ? { is: "stuck", code } : { is: "waiting", sent };
  };
  const failed = async (code: string, sentNow: boolean, sent: RosterWrite): Promise<SavedTry> => {
    const failure = classify(code);
    if (failure.kind === "retry") return later(code, sentNow, sentNow ? sent : before.request);
    if (o.by === "worker" && (failure.kind === "needs_admin" || failure.kind === "not_connected" || failure.kind === "other_company")) {
      const ok = await settleSaved(item, { state: "stuck", code, sent: before.sent, request: before.request, nextTryAt: null }, triedAt, o);
      return ok ? { is: "stuck", code } : gone;
    }
    return refused(code, null);
  };
  const taken = async (w: RenameWrite | CreateWrite, answer: Record<string, unknown>, resent: "stale" | "no_version" | "differs" | null): Promise<SavedTry> => {
    const resultQboId = typeof answer.Id === "string" ? answer.Id.slice(0, 64) : null;
    const extra = { ...(o.by === "press" ? { sentAgain: true } : {}), ...(resent ? { resent, fieldAsHeld: true } : {}) };
    const { cached } = await applyWritten(w, answer, { realmId: item.realmId, actor: o.actor, ip: o.ip, permission: o.permission, queueId: item.id, linkedBy: o.linkedBy, filed,
      ...(Object.keys(extra).length ? { auditExtra: extra } : {}), inside: (tx) => doneIn(tx, item, resultQboId, triedAt, o) });
    const [after] = await db.select({ state: writeQueue.state }).from(writeQueue).where(eq(writeQueue.id, item.id));
    return after?.state === "given_up" ? gone : { is: "done", cached };
  };

  if (write.op === "rename") {
    // The cache already shows another name than the one this rename is compared with: read live before anything is sent.
    const [c] = o.readFirst ? [] : await db.select({ name: qboCustomer.displayName }).from(qboCustomer).where(eq(qboCustomer.qboId, write.qboId));
    const readFirst = o.readFirst ?? (c !== undefined && c.name !== write.was ? "differs" : null);
    const t = await tryRename(write, item.realmId, { mayWait, readFirst, actor: o.actor, ip: o.ip, permission: o.permission });
    switch (t.is) {
      case "answer": return taken(t.write, t.answer, t.resent);
      case "in_place": return (await settleSaved(item, { state: "done", resultQboId: write.qboId }, triedAt, o)) ? { is: "found" } : gone;
      // Changed in QuickBooks at that very moment, twice: nothing was made. A press is kept refused, as QuickBooks answered.
      case "stale_again": return o.by === "press" ? refused("fault_5010", null) : later("fault_5010", false, before.request);
      case "changed": return refused(t.code, t.holds);
      case "failed": return failed(t.code, t.sent, t.write);
    }
  }
  let answer: Record<string, unknown>;
  try {
    answer = await sendWrite(write, item.realmId, { mayWait });
  } catch (e) {
    if (!(e instanceof QboError)) throw e;
    const failure = classify(e.code);
    return failed(e.code, failure.kind === "retry" && failure.sent, write);
  }
  return taken(write, answer, null);
}

/** What staff rename on a linked record's page: the record's kind and the app's id, a uuid, and the new name. */
export type LinkedRename = { kind: "family" | "student"; recordId: string; name: string };

/**
 * A rename of a linked family (layered books), member (flat) or student, saved in the portal first (the lead's
 * decision 1 for slice 9e). Under the roster lock with the page's tag, before anything is saved: QuickBooks connected
 * to the roster's company, the shape holding and offering the rename, the record active and linked, its customer on
 * the roster in the role the rename needs, nothing waiting or stuck for that customer, the name by checkName(), not the
 * record's own name already, for a family or member not another active family's, and not a name QuickBooks' names hold
 * ("Name (2)" offered). Then, in that transaction, a refused rename of the record is replaced (closed as given up), the
 * record's name is saved with `roster.record.renamed` (`quickbooks: "sending"`, or `"has_it"` when the cache holds the
 * name already, when nothing is sent), the link's own version is read, and the rename is put on the queue (queueSaved()).
 * `was`, what QuickBooks' name is compared with, is the name the portal and QuickBooks last agreed on: the record's own
 * before this change, or, when it takes the place of a refused rename, that one's (so a rename after a taken name, a
 * connection only an Admin could mend or one QuickBooks couldn't be reached by is sent, while one after an edit made in
 * QuickBooks is still held). Then that item is tried at once (trySavedItem()) while the record's "being sent" lock is
 * held, and the staff member reads exactly one of: saved and renamed in QuickBooks; saved and waiting to reach
 * QuickBooks, or the portal can't tell yet; saved and not in QuickBooks, saying who stopped it. The portal's name is
 * never undone.
 */
export async function renameLinked(ask: LinkedRename, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  if (!isUuid(ask.recordId)) return refuse(WRITE_COPY.gone);
  const recordId = ask.recordId.toLowerCase();
  return (await whileSending(recordId, () => renameHolding(ask.kind, recordId, ask.name, rosterTag, o))) ?? refuse(BEING_SENT);
}

async function renameHolding(kind: "family" | "student", recordId: string, rawName: string, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  type Saved = { ok: true; write: RenameWrite; item: QueueRow | null } | { ok: false; result: WriteResult };
  const saved = await db.transaction(async (tx): Promise<Saved> => {
    const no = (error: string): Saved => ({ ok: false, result: refuse(error) });
    const ready = await readyToSend(tx, rosterTag);
    if (!ready.ok) return no(ready.error);
    const { shape, source, cache, roster } = ready;
    let record: { name: string | null; active: boolean }, customer: string | null, filed: Filed;
    if (kind === "family") {
      const [f] = await tx.select().from(family).where(eq(family.id, asAppFamilyId(recordId))).for("update");
      if (!f) return no(WRITE_COPY.gone);
      record = f; customer = await customerOfFamily(f.id, tx); filed = { familyId: f.id, studentId: null };
    } else {
      const [s] = await tx.select().from(student).where(eq(student.id, asAppStudentId(recordId))).for("update");
      if (!s || s.familyId === null) return no(WRITE_COPY.gone);
      const [f] = await tx.select({ active: family.active }).from(family).where(eq(family.id, s.familyId));
      record = { name: s.name, active: s.active && f?.active === true }; customer = await customerOfStudent(s.id, tx); filed = { familyId: s.familyId, studentId: s.id };
    }
    if (!record.active) return no(INACTIVE_HERE);
    if (customer === null) return no(NOT_LINKED);
    const c = cache.find((x) => x.qboId === customer);
    const where = c ? roleIn(roster, customer) : null;
    if (!c || !where || (kind === "family" ? where.role !== "family" && where.role !== "member" : where.role !== "student")) return no(WRITE_COPY.gone);
    if (!offers(shape, renameOf(where.role))) return no(WRITE_COPY.notOffered);
    if (await waitingForCustomer(tx, customer)) return no(WRITE_COPY.waiting);
    const name = checkName(rawName);
    if (!name.ok) return no(name.error);
    if (record.name === name.name) return no(ALREADY_NAMED);
    if (kind === "family") {
      const others = await portalFamilyNames(tx, asAppFamilyId(recordId));
      if (nameIn(name.name, others)) return { ok: false, result: takenHere(name.name, freeName(name.name, others), where.role === "member" ? "member" : "family") };
    }
    const sends = c.displayName !== name.name;
    if (sends) {
      const offer = freeName(name.name, await namesTaken(tx, cache, customer));
      if (offer) return { ok: false, result: taken(name.name, offer) };
    }
    // A later rename takes the place of a refused one for the name (the lead's decision 4), in this same transaction,
    // and takes from it the name the portal and QuickBooks last agreed on, which QuickBooks' name is compared with.
    const replaced = await replaceRefused(tx, renamesOf(customer), { op: "rename", name: name.name, recordId }, o);
    const agreed = replaced.map((r) => r.request).find((w): w is RenameWrite => w.op === "rename")?.was;
    const was = agreed ?? record.name ?? "";
    const now = new Date();
    if (kind === "family") await tx.update(family).set({ name: name.name, updatedAt: now }).where(eq(family.id, asAppFamilyId(recordId)));
    else await tx.update(student).set({ name: name.name, updatedAt: now }).where(eq(student.id, asAppStudentId(recordId)));
    const [link] = await tx.select({ syncedToken: accountingLink.syncedToken }).from(accountingLink)
      .where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, source), eq(accountingLink.customerId, customer),
        kind === "family" ? isNotNull(accountingLink.familyId) : isNotNull(accountingLink.studentId)));
    const write: RenameWrite = { op: "rename", role: where.role, qboId: customer, syncToken: link?.syncedToken ?? "", name: name.name, was };
    // Nothing is saved without its queue item: the rename goes on the queue in this same transaction, and the try below is a try of it.
    const item = sends ? await queueSaved(tx, write, source, filed, o) : null;
    await writeAudit({ actor: o.actor, action: "roster.record.renamed", permission: o.permission, ip: o.ip, targetType: kind, targetId: recordId,
      before: { name: record.name }, after: { kind, ...(kind === "family" ? { familyId: recordId } : { studentId: recordId, familyId: String(filed.familyId) }), name: name.name,
        quickbooks: sends ? "sending" : "has_it", customerQboId: customer, ...(item ? { queueId: item.id, comparedWith: was } : {}), ...(replaced.length ? { replaced: replaced.map((r) => r.id) } : {}) } }, tx);
    return { ok: true, write, item };
  });
  if (!saved.ok) return saved.result;
  const { write, item } = saved;
  const said = write.name;
  const hasIt = `Renamed ${said} in the portal. QuickBooks has that name already, so nothing was sent.`;
  if (!item) return { ok: true, message: hasIt };
  const t = await trySavedItem(item, write, { by: "at_once", linkedBy: o.staffUserId, actor: o.actor, ip: o.ip, permission: o.permission });
  switch (t.is) {
    case "done": return { ok: true, message: t.cached ? `Renamed ${said} in the portal and in QuickBooks.` : `Renamed ${said} in the portal and in QuickBooks. The roster here shows it after its next read of QuickBooks, usually within a few minutes.` };
    case "found": return { ok: true, message: hasIt };
    case "waiting": return { ok: true, status: "waiting", message: t.sent
      ? `Renamed ${said} in the portal. The portal can't tell yet whether QuickBooks took the rename: its answer didn't arrive. The roster is read again within a few minutes to see, and the portal finishes it then without sending it twice; you'll find it on the Reconciliation page until then.`
      : `Renamed ${said} in the portal. QuickBooks couldn't take it just now, so the rename is waiting to reach QuickBooks: the portal tries again in a minute, then less often, and you'll find it on the Reconciliation page.` };
    case "refused": {
      let tail = ", where you can send the portal's name to QuickBooks or give it up.";
      if (t.code === "fault_6240") {
        const names = await db.transaction(async (tx) => namesTaken(tx, await cacheRows(tx), write.qboId));
        const offer = freeName(write.name, [...names, write.name]);
        tail = `: rename the record again here to a free name${offer ? `, such as “${offer}”` : ""}, which is sent to QuickBooks and takes the place of this change, or give it up there.`;
      } else if (t.code === INACTIVE_THERE_CODE) tail = ", where you can give it up.";
      return { ok: true, status: "attention", message: `Renamed ${said} in the portal, but not in QuickBooks. ${keptRefusalWords(t.code, t.holds)} The portal keeps its name, and the change is kept on the Reconciliation page${tail}` };
    }
    case "given_up": return { ok: true, status: "attention", message: `Renamed ${said} in the portal. The rename was given up on the Reconciliation page while it was on its way to QuickBooks, so nothing more is done for it: QuickBooks has the name only if that send got through, which the roster shows after its next read.` };
    case "stuck": case "not_reached": return { ok: true, status: "attention", message: `Renamed ${said} in the portal, but not in QuickBooks: see the Reconciliation page.` };
  }
}

/**
 * A student added to a linked family (layered books with a student type), the `student` record saved first (the lead's
 * decision 6). Under the roster lock with the page's tag, the checks prepare() makes for a student's create today
 * (connected to the roster's company, the shape offering it with a student type, the family's customer an active
 * family on the roster with nothing waiting for it, the family record the page named active and linked to that
 * customer, the name by checkName() and free of namesTaken(), "Name (2)" offered), refused before anything is saved;
 * then the record, active, in that family, with `roster.student.added` (`quickbooks: "sending"`), and today's student
 * create on the queue, filed under the family and the new student (queueSaved()), in one transaction. Then that item is
 * tried at once (trySavedItem()). All of it holds the family's "being made" lock (whileMaking()), so "Create in
 * QuickBooks and link" and the portal-only changes can't make a second customer for the student meanwhile. Taken: the
 * saved record is linked with the answer's version (changeOwnRecord()); unreachable: it waits on the queue, and the
 * found-done path links it; refused: the student stays, active and unlinked, and the item is kept refused.
 */
export async function addStudentToLinked(rawFamilyId: string, rawName: string, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  if (!isUuid(rawFamilyId)) return refuse(WRITE_COPY.gone);
  const familyId = asAppFamilyId(rawFamilyId.toLowerCase());
  return (await whileMaking(familyId, () => addStudentHolding(familyId, rawName, rosterTag, o))) ?? refuse(FAMILY_SENDING);
}

async function addStudentHolding(familyId: AppFamilyId, rawName: string, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  type Saved = { ok: true; write: CreateWrite; item: QueueRow; familyName: string } | { ok: false; result: WriteResult };
  const saved = await db.transaction(async (tx): Promise<Saved> => {
    const no = (error: string): Saved => ({ ok: false, result: refuse(error) });
    const ready = await readyToSend(tx, rosterTag);
    if (!ready.ok) return no(ready.error);
    const { shape, source, cache, roster } = ready;
    if (!offers(shape, "add_student")) return no(WRITE_COPY.notOffered);
    const typeQboId = typeForNew(shape, "student", null);
    if (typeQboId === null) return no(WRITE_COPY.notOffered);
    const [f] = await tx.select().from(family).where(eq(family.id, familyId)).for("update");
    if (!f) return no(WRITE_COPY.gone);
    if (!f.active) return no(WRITE_COPY.notOursToAdd);
    const customer = await customerOfFamily(f.id, tx);
    if (customer === null) return no(NOT_LINKED);
    const where = roleIn(roster, customer);
    if (!where || where.role !== "family") return no(WRITE_COPY.gone);
    if (!cache.find((c) => c.qboId === customer)?.active) return no("This family is inactive in QuickBooks, so nobody can be added to it.");
    if (await waitingForCustomer(tx, customer)) return no(WRITE_COPY.waiting);
    if (await familyCreateQueued(tx, f.id)) return no(FAMILY_WAITING);
    const name = checkName(rawName);
    if (!name.ok) return no(name.error);
    const offer = freeName(name.name, await namesTaken(tx, cache, null));
    if (offer) return { ok: false, result: taken(name.name, offer) };
    const [made] = await tx.insert(student).values({ familyId: f.id, name: name.name, active: true }).returning({ id: student.id });
    const write: CreateWrite = { op: "create", role: "student", name: name.name, typeQboId, familyQboId: customer, email: null };
    // Nothing is saved without its queue item: the create goes on the queue in this same transaction, and the try below is a try of it.
    const item = await queueSaved(tx, write, source, { familyId: f.id, studentId: made!.id }, o);
    await writeAudit({ actor: o.actor, action: "roster.student.added", permission: o.permission, ip: o.ip, targetType: "student", targetId: String(made!.id),
      before: null, after: { studentId: String(made!.id), familyId: String(f.id), name: name.name, quickbooks: "sending", queueId: item.id } }, tx);
    return { ok: true, write, item, familyName: recordNameWords(f.name, "family") };
  });
  if (!saved.ok) return saved.result;
  const { write, item, familyName } = saved;
  const said = `${write.name} is added to ${familyName} in the portal`;
  const t = await trySavedItem(item, write, { by: "at_once", linkedBy: o.staffUserId, actor: o.actor, ip: o.ip, permission: o.permission });
  switch (t.is) {
    case "done": return t.cached ? { ok: true, message: `${said}, made in QuickBooks and linked.` }
      : { ok: true, status: "waiting", message: `${said} and made in QuickBooks. The portal links the two once it has read QuickBooks again, usually within a few minutes.` };
    case "waiting": return { ok: true, status: "waiting", message: t.sent
      ? `${said}. The portal can't tell yet whether QuickBooks made them: its answer didn't arrive. The roster is read again within a few minutes to see, and the portal links them then without making them twice; you'll find it on the Reconciliation page until then.`
      : `${said}. QuickBooks couldn't take it just now, so making them there is waiting to reach QuickBooks: the portal tries again in a minute, then less often, and links them once QuickBooks has them. You'll find it on the Reconciliation page until then.` };
    case "refused": return { ok: true, status: "attention",
      message: `${said}, but they aren't in QuickBooks. ${keptRefusalWords(t.code, null)} They stay in the portal, unlinked, and the change is kept on the Reconciliation page, where you can send the student to QuickBooks again or give it up.` };
    case "given_up": return { ok: true, status: "attention", message: `${said}. Making them in QuickBooks was given up on the Reconciliation page while it was on its way, so nothing in the portal is linked for it: after the next roster read, the Reconciliation page says whether QuickBooks made them anyway.` };
    case "found": case "stuck": case "not_reached": return { ok: true, status: "attention", message: `${said}, but they aren't in QuickBooks yet: see the Reconciliation page.` };
  }
}

/**
 * The stamp the Reconciliation page puts on "Send the portal's value": the item and the value the row showed (for a
 * rename, the name the cache has for it, which the press compares QuickBooks' with; for a student's create, the
 * student's current name in the portal, which the press sends), sealed, so a value the press sends back is never
 * trusted as sent: one that isn't what the row showed fails it.
 */
export function portalValueStamp(itemId: string, shown: string): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET).update(`portal-value:${itemId.toLowerCase()}|${shown}`).digest("base64url").slice(0, 22);
}
const stampHolds = (itemId: string, shown: string, stamp: string) => {
  const want = Buffer.from(portalValueStamp(itemId, shown)), got = Buffer.from(stamp);
  return got.length === want.length && timingSafeEqual(got, want);
};

/** A refused item QuickBooks was found to hold already ("Send the portal's value"): done, audited, in the caller's transaction, only while it is still refused. */
async function refusedFoundIn(tx: Tx, item: QueueRow, resultQboId: string | null, o: { actor: Actor; ip: string | null; permission?: string }): Promise<void> {
  const [still] = await tx.update(writeQueue).set({ state: "done", resultQboId, tries: item.tries + 1, lastTriedAt: new Date(), nextTryAt: null, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(writeQueue.id, item.id), eq(writeQueue.state, "refused"))).returning({ id: writeQueue.id });
  if (!still) return;
  await writeAudit({ actor: o.actor, action: "roster.write.done", permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: item.id,
    before: { state: "refused", tries: item.tries, code: item.lastCode }, after: { state: "done", how: "found", tries: item.tries + 1, ...(resultQboId ? { resultQboId } : {}) } }, tx);
}

/**
 * "Send the portal's value", on the Reconciliation page, for a refused item (a holder of Roster.Family.ReadWrite with
 * Roster.Read): `shown` is what the row showed, held to its stamp (portalValueStamp()). Under the roster lock: the item
 * still refused, its record still linked to that customer and active, the portal's value still what the item asks,
 * QuickBooks connected to the roster's company, nothing waiting for the customer; never a rename QuickBooks refused as a
 * taken name (6240): any later rename of the record takes its place, and is sent, so the page offers none. For a
 * student's create, the student active and unlinked in an active family linked to the customer it was asked under,
 * their current name the one the row showed (renamed since, nothing is sent: reload) and free. A rename then reads the
 * record live: inactive there, nothing is sent (it never makes a customer active); the portal's value there already,
 * the item is done; a name other than the row showed, nothing is sent and the row shows the newer one (into the cache);
 * otherwise the portal's value is sent with the live version, whatever it is, on purpose, its `was` the name the row
 * showed. For the send the item goes back on the queue, `waiting` and `sent`, holding what is sent
 * (`roster.write.sent_again`), and is tried as any change saved first is (trySavedItem(), the one path), under the same
 * lock: given up meanwhile, it stays given up and nothing is linked or aligned; an answer the portal can't take in
 * leaves it waiting to be finished. Taken: done, the link aligned with the answer. Refused again: refused, as it was
 * asked, with the new code. Not reached: refused, as it was, said in words. A lost answer: waiting, `sent`, so the
 * found-done path finishes it after a roster read, and a later try sends it again only while QuickBooks still has the
 * name the row showed.
 */
export async function sendPortalValue(rawItemId: string, shown: string, stamp: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  if (!isUuid(rawItemId) || !stampHolds(rawItemId, shown, stamp)) return refuse(NOT_AS_SHOWN);
  const itemId = rawItemId.toLowerCase();
  const [pre] = await db.select({ request: writeQueue.request, familyId: writeQueue.familyId, studentId: writeQueue.studentId }).from(writeQueue).where(eq(writeQueue.id, itemId));
  if (!pre || !isSavedFirst(pre)) return refuse(NO_LONGER_REFUSED);
  // A student's create holds the family's "being made" lock, as adding them does; a rename, its record's "being sent" lock.
  const held = await whileItemHeld(pre, () => sendAgainHolding(itemId, shown, o));
  return held ?? refuse(pre.request.op === "create" ? FAMILY_SENDING : BEING_SENT);
}

async function sendAgainHolding(itemId: string, shown: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  type Plan = { ok: true; item: QueueRow; write: CreateWrite | RenameWrite; realmId: string } | { ok: false; result: WriteResult };
  const plan = await db.transaction(async (tx): Promise<Plan> => {
    const no = (error: string): Plan => ({ ok: false, result: refuse(error) });
    const source = await getRosterSource(tx);
    if (source === null || !(await lockRosterAs(tx, rosterTagOf(source)))) return no(WRITE_COPY.noRoster);
    const conn = await getConnection(tx);
    if (!conn?.realmId || !conn.refreshTokenCiphertext) return no(WRITE_COPY.notConnected);
    if (conn.realmId !== source) return no(WRITE_COPY.otherCompany);
    const [item] = await tx.select().from(writeQueue).where(eq(writeQueue.id, itemId)).for("update");
    if (!item || item.state !== "refused") return no(NO_LONGER_REFUSED);
    if (item.realmId !== source) return no(WRITE_COPY.otherCompany);
    const w = item.request as RosterWrite;
    const cache = await cacheRows(tx);
    if (w.op === "rename") {
      const [rec] = item.studentId !== null ? await tx.select({ name: student.name, active: student.active }).from(student).where(eq(student.id, item.studentId))
        : item.familyId !== null ? await tx.select({ name: family.name, active: family.active }).from(family).where(eq(family.id, item.familyId)) : [];
      const linked = item.studentId !== null ? await customerOfStudent(item.studentId, tx) : item.familyId !== null ? await customerOfFamily(item.familyId, tx) : null;
      if (!rec || !rec.active || linked !== w.qboId) return no(RECORD_MOVED_ON);
      // Offered only while the cache has the customer active: the portal never makes a customer active again.
      if (!cache.find((c) => c.qboId === w.qboId)?.active) return no(INACTIVE_THERE);
      // A name QuickBooks refused as taken (6240) is never sent again as it is: renaming the record on its family's page
      // to a free name takes the place of this change, and is sent (renameLinked()), so the page offers no press for it.
      if (item.lastCode === "fault_6240") return no(TAKEN_NAME_KEPT);
      if (rec.name !== w.name) return no(RECORD_MOVED_ON);
      const name = checkName(rec.name!);
      if (!name.ok) return no(name.error);
      const offer = freeName(name.name, await namesTaken(tx, cache, w.qboId));
      if (offer) return { ok: false, result: taken(name.name, offer) };
      if (await waitingForCustomer(tx, w.qboId)) return no(WRITE_COPY.waiting);
      return { ok: true, item, write: { ...w, name: name.name }, realmId: source };
    }
    if (w.op === "create" && w.role === "student" && item.studentId !== null && item.familyId !== null) {
      const [s] = await tx.select().from(student).where(eq(student.id, item.studentId)).for("update");
      if (!s?.active || s.familyId === null || String(s.familyId) !== String(item.familyId)) return no(RECORD_MOVED_ON);
      if ((await customerOfStudent(s.id, tx)) !== null) return no("That student is linked to QuickBooks already, so nothing was sent. Give this up.");
      // The row shows the student's current name, and the press sends that name only (the lead's decision 6).
      if ((s.name ?? "") !== shown) return no(STUDENT_RENAMED);
      const [f] = await tx.select({ active: family.active }).from(family).where(eq(family.id, s.familyId));
      const familyCustomer = await customerOfFamily(s.familyId, tx);
      if (!f?.active || familyCustomer === null || familyCustomer !== w.familyQboId || !cache.find((c) => c.qboId === familyCustomer)?.active) {
        return no("The student's family isn't linked to that active family in QuickBooks now, so nothing was sent. Reload the page.");
      }
      if (await waitingForCustomer(tx, familyCustomer)) return no(WRITE_COPY.waiting);
      const name = checkName(shown);
      if (!name.ok) return no(`The student's name can't be used in QuickBooks: ${name.error} Rename them on their family's page first.`);
      const offer = freeName(name.name, await namesTaken(tx, cache, null));
      if (offer) return { ok: false, result: taken(name.name, offer) };
      return { ok: true, item, write: { ...w, name: name.name }, realmId: source };
    }
    return no(NO_LONGER_REFUSED);
  });
  if (!plan.ok) return plan.result;
  const { item, realmId } = plan;
  let write = plan.write;
  if (write.op === "rename") {
    const live = await readLive(write.qboId, realmId, false);
    if (!live.ok) return refuse(`QuickBooks couldn't be asked how it holds the name just now, so nothing was sent. ${classify(live.code).kind === "retry" ? "Try again in a few minutes." : unreadWords(live.code)}`);
    await storeReadAgain(live.answer, realmId, o);
    if (!live.active) return refuse(INACTIVE_THERE);
    if (live.name === write.name) {
      const found = write.qboId;
      await db.transaction(async (tx) => { if (await lockRosterAs(tx, rosterTagOf(realmId))) await refusedFoundIn(tx, item, found, o); });
      return { ok: true, message: "QuickBooks has the portal's name already, so nothing was sent. The change is done." };
    }
    // Nothing is ever sent over a value nobody was shown: the row is drawn again with what QuickBooks has now.
    if (live.name !== shown) return { ok: false, errors: [`QuickBooks changed again since this page was shown: it has “${live.name ?? ""}” now. Nothing was sent. Reload the page to see it, then send the portal's name if it is still wanted.`] };
    // Sent with the live version, on purpose, over the name the staff member was shown: that name is what a later try
    // compares QuickBooks' with (`was`), should this answer be lost, so the queue sends it again only while it still reads so.
    write = { ...write, syncToken: live.syncToken, checked: true, was: shown };
  }
  const sent = write;
  // For its send the item goes back on the queue, waiting, holding what is sent, and is tried as any change saved first
  // is (trySavedItem()), which marks it as maybe sent before it goes: staff who give it up while it is on its way leave it
  // given up whatever QuickBooks answers (nothing linked or aligned for it), a send cut off midway is looked for after the
  // next roster read and never sent again with another version, and an answer the portal can't take in leaves this item
  // waiting to be finished, never a second one beside it.
  const moved = await db.transaction(async (tx): Promise<"moved" | "roster" | "gone"> => {
    if (!(await lockRosterAs(tx, rosterTagOf(realmId)))) return "roster";
    const [still] = await tx.update(writeQueue).set({ state: "waiting", sent: true, request: sent, lastTriedAt: new Date(), nextTryAt: new Date(Date.now() + SAVED_LEASE_MS), updatedAt: new Date() })
      .where(and(eq(writeQueue.id, item.id), eq(writeQueue.state, "refused"))).returning({ id: writeQueue.id });
    if (!still) return "gone";
    await writeAudit({ actor: o.actor, action: "roster.write.sent_again", permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: item.id,
      before: { state: "refused", code: item.lastCode }, after: { state: "waiting", sent: true, op: sent.op, role: sent.role, name: sent.name, ...(sent.op === "rename" ? { syncToken: sent.syncToken } : {}) } }, tx);
    return "moved";
  });
  if (moved === "roster") return refuse(WRITE_COPY.noRoster);
  if (moved === "gone") return refuse(NO_LONGER_REFUSED);
  const before: Before = { request: item.request as RosterWrite, sent: item.sent, lastCode: item.lastCode, tries: item.tries, lastTriedAt: item.lastTriedAt };
  const t = await trySavedItem({ ...item, state: "waiting", sent: true, request: sent }, sent, { by: "press", before, linkedBy: o.staffUserId, actor: o.actor, ip: o.ip, permission: o.permission });
  const what = sent.op === "rename" ? "QuickBooks has the portal's name now" : "QuickBooks has the student now";
  switch (t.is) {
    case "done": return t.cached ? { ok: true, message: `Sent: ${what}${sent.op === "rename" ? "" : ", linked to their record here"}.` }
      : { ok: true, ...(sent.op === "create" ? { status: "waiting" as const } : {}), message: `Sent: ${what}. The portal finishes it on its side after its next read of QuickBooks, usually within a few minutes.` };
    case "found": return { ok: true, message: "QuickBooks has the portal's name already, so nothing was sent. The change is done." };
    case "waiting": return { ok: true, status: "waiting", message: "The portal can't tell yet whether QuickBooks took it: its answer didn't arrive. The roster is read again within a few minutes to see, and the portal finishes it then without sending it twice." };
    case "not_reached": return refuse("QuickBooks couldn't take it just now, so nothing was changed there. The change is still kept here: try again in a few minutes.");
    case "refused": return refuse(`It didn't go through this time either. ${keptRefusalWords(t.code, t.holds)} The change is still kept on this page.`);
    case "given_up": return { ok: true, status: "attention", message: `The change was given up on this page while it was on its way to QuickBooks, so it stays given up and nothing in the portal was changed or linked for it, whatever QuickBooks did with it. ${sent.op === "rename"
      ? "QuickBooks has the portal's name only if that send got through, which the roster shows after its next read."
      : "After the next roster read, this page says whether QuickBooks made the student anyway."}` };
    case "stuck": return refuse("It didn't go through: see this page for where it stands.");
  }
}
