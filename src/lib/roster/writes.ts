// Staff only: a staff member's changes to the roster in QuickBooks (v1 spec §6.1, §6.3). It loads every family in the
// club, so it is never imported by parent code (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts). It is
// the only module that may call the client's roster writes (tests/unit/quickbooks-writes.test.ts): the staff roster
// actions and the write queue's job reach QuickBooks through it.
import "server-only";
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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
import { beforeResend, classify, type CachedCustomer } from "./write-rules";

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
  | { op: "rename"; qboId: string; syncToken: string; name: string }
  | { op: "move"; qboId: string; syncToken: string; toFamilyQboId: string }
  | { op: "deactivate"; qboId: string; syncToken: string };

/**
 * A record as QuickBooks has it now, read again after it changed while staff were editing (spec §6.3): only what the
 * form shows. Its new version reaches the page when the page is made again, which the action asks for.
 */
export type CurrentRecord = { name: string; active: boolean; familyName: string | null };

/** `unlinked`: done in the portal, but not (or not yet) in QuickBooks: the family stands there unlinked, and the words say why. */
export type WriteResult =
  | { ok: true; message: string; queued?: true; unlinked?: true }
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
      if (!allowed(renameOf(where.role))) return no(WRITE_COPY.notOffered);
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
  o: { realmId: string; linkedBy: string | null; studentId?: AppStudentId | null; familyId?: AppFamilyId | null }): Promise<OwnRecordChange | null> {
  if (w.role === "parent") return null;
  const now = new Date();
  if (w.op === "create") {
    if (w.role === "family" || w.role === "member") {
      if ((await familyLinkedTo(customerId, tx)) !== null) return null;
      if (o.familyId) {
        if ((await customerOfFamily(o.familyId, tx)) !== null) return null;
        const [link] = await tx.insert(accountingLink).values({ system: QUICKBOOKS, realmId: o.realmId, customerId, familyId: o.familyId, origin: "created", linkedBy: o.linkedBy })
          .returning({ id: accountingLink.id });
        return { kind: "family", familyId: String(o.familyId), linked: true, linkId: link!.id };
      }
      const [made] = await tx.insert(family).values({ name: w.name, active: true }).returning({ id: family.id });
      const [link] = await tx.insert(accountingLink).values({ system: QUICKBOOKS, realmId: o.realmId, customerId, familyId: made!.id, origin: "created", linkedBy: o.linkedBy })
        .returning({ id: accountingLink.id });
      return { kind: "family", familyId: String(made!.id), made: true, linkId: link!.id };
    }
    if (w.role !== "student" || w.familyQboId === null) return null;
    if ((await studentLinkedTo(customerId, tx)) !== null) return null;
    if (o.studentId) {
      if ((await customerOfStudent(o.studentId, tx)) !== null) return null;
      const [link] = await tx.insert(accountingLink).values({ system: QUICKBOOKS, realmId: o.realmId, customerId, studentId: o.studentId, origin: "created", linkedBy: o.linkedBy })
        .returning({ id: accountingLink.id });
      return { kind: "student", studentId: String(o.studentId), linked: true, linkId: link!.id };
    }
    const familyId = await familyLinkedTo(w.familyQboId, tx);
    if (familyId === null) return null;
    const [made] = await tx.insert(student).values({ familyId, name: w.name, active: true }).returning({ id: student.id });
    const [link] = await tx.insert(accountingLink).values({ system: QUICKBOOKS, realmId: o.realmId, customerId, studentId: made!.id, origin: "created", linkedBy: o.linkedBy })
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
    const [still] = await tx.update(writeQueue).set({ sent: true, lastCode: code, tries: sql`${writeQueue.tries} + 1`, lastTriedAt: new Date(), nextTryAt: new Date(Date.now() + 60_000),
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
  queueId?: string; linkedBy: string | null; filed?: Filed; inside?: (tx: Tx) => Promise<void> }): Promise<{ cached: boolean }> {
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
      let refreshAsked = false;
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
        appRecord = await changeOwnRecord(tx, w, targetId, { realmId: o.realmId, linkedBy: o.linkedBy, studentId: o.filed?.studentId, familyId: o.filed?.familyId });
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
          ...(!ours ? { code: "company_changed" } : !fits ? { code: "answer_other" } : {}), ...(givenUp ? { queue: "given_up" } : {}), ...(appRecord ? { appRecord } : {}) } }, tx);
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
    const [link] = await tx.insert(accountingLink).values({ system: QUICKBOOKS, realmId: source, customerId: made.customerQboId, studentId, origin: "confirmed", linkedBy: o.staffUserId })
      .returning({ id: accountingLink.id });
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
   whatever is still unlinked. It sends nothing for a guardian (slice 9f). */

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
 * or anyone into such a family, is not one of them (slice 9e).
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
