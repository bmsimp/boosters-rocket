// Staff only: a staff member's changes to the roster in QuickBooks (v1 spec §6.1, §6.3). It loads every family in the
// club, so it is never imported by parent code (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts). It is
// the only module that may call the client's roster writes (tests/unit/quickbooks-writes.test.ts), and, since stage 3's
// slice 11b, the customer update of a parent's phone and mailing address saved in the portal first, and, since slice
// S11e, the email update of a person's sign-in email changed in the portal first: the staff roster actions and the
// write queue's job reach QuickBooks through it.
import "server-only";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { env } from "@/env";
import { db, type Tx } from "@/lib/db/client";
import { accountingLink, family, familyMoney, guardian, jobRun, parent, qboCustomer, qboCustomerType, student, writeQueue, type QueuedWrite, type RosterRole, type RosterWrite } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getConnection } from "@/lib/quickbooks/connection";
import { CUSTOMER_UPDATE, CUSTOMER_WRITES, EMAIL_UPDATE, NO_TOKEN, qboCreateCustomer, qboCustomerById, qboMoveCustomer, qboRenameCustomer, qboSetCustomerActive, qboUpdateCustomerContact,
  qboUpdateCustomerEmail } from "@/lib/quickbooks/client";
import { QboError } from "@/lib/quickbooks/endpoints";
import { currencyOf, formatMoney, toCents } from "@/lib/money/cents";
import { lockRosterAs, rosterTagOf, ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { connectedToAnotherCompany, customerOfFamily, customerOfGuardian, customerOfStudent, familyLinkState, familyLinkedTo, linksOf, linksOfCustomers, recordsCompany, studentLinkedTo } from "@/lib/families/links";
import { asAppFamilyId, asAppStudentId, QUICKBOOKS, type AppFamilyId, type AppStudentId } from "@/lib/families/ids";
import { recordNameWords } from "@/lib/families/words";
import { clearLeftUnlinked } from "@/lib/families/left-unlinked";
import { endedLinksHeld, type EndedHeld } from "@/lib/accounting/ended-links";
import { isUuid } from "@/lib/seasons/ids";
import { askForRosterRefresh, ROSTER_ASK_KEY } from "@/lib/parents/refresh-ask";
import { studentsRuleInForce } from "@/lib/parents/sessions";
import { numberedWhereRepeated } from "@/lib/parents/my-family-names";
import { billingAddressOf, detailKey } from "@/lib/parents/contact-fields";
import { contactAgeFrom, contactSendsMayGo, contactSendsSince } from "@/lib/parents/take-in-setting";
import { whoseDetails } from "@/lib/parents/my-family";
import { CONTACT_REPLACED_NOTE, type DetailsOf } from "@/lib/parents/contact-queue";
import { formsForMovedStudent } from "@/lib/forms/moved";
import { volunteerForMovedStudent } from "@/lib/volunteer/moved-student";
import { buyoutsForMovedStudent } from "@/lib/buyouts/moved";
import { getShape, missingTypes, ROSTER_LOCK, shapeHolds, shapeTypeIds, type MembershipShape } from "./shape";
import { buildRoster, type Cust, type Roster } from "./model";
import { getRosterSource, ROSTER_JOB } from "./source";
import { familyCreatesOnTheQueue, noFamilyPool } from "./no-family";
import { customerRow } from "./refresh";
import { checkName, freeName, nameKey } from "./names";
import { deactivateOf, offers, renameOf, typeForNew, type RosterOperation } from "./operations";
import { afterFailedTry, beforeResend, classify, contactStands, emailBefores, emailRuleOf, emailStands, fieldHolds, heldInCache, type CachedCustomer, type ContactDiffer, type HeldContact } from "./write-rules";
import { EMAIL_FIELD_MAX, replaceAddressInField } from "@/lib/parents/email-field";
import { parseEmailField } from "@/lib/parents/emails";
import { sendStampHolds, takeStampHolds } from "@/lib/accounting/stamp";
import { linkStanding } from "@/lib/accounting/status";

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
   * family's or member's create without one is refused: none is made QuickBooks first any more. A Parent customer is
   * made for a guardian since stage 3's slice 9h (queueForGuardian()), never asked for on its own.
   */
  | { op: "create"; role: Exclude<RosterRole, "parent">; name: string; familyQboId: string | null; email: string | null; typeQboId: string | null; familyId?: AppFamilyId }
  /** `parentOnly`: a Parent customer's rename, the one rename sent QuickBooks first (a linked record's: renameLinked()). */
  | { op: "rename"; qboId: string; syncToken: string; name: string; parentOnly?: true }
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
  balanceFix: "A balance has to be settled in QuickBooks first: paid or written off, or a credit used or refunded. Then try again.",
  balanceUnread: "QuickBooks couldn't be asked what is owed just now, so nothing was changed. Try again in a few minutes.",
  balanceUnknown: "QuickBooks didn't say what is owed, so nothing was changed. Check the balance in QuickBooks, then try again.",
  balanceRefused: "QuickBooks wouldn't say what is owed, so nothing was changed. Check the customer in QuickBooks; waiting won't change this answer.",
  coverChanged: "Who is under this family changed in QuickBooks since the page was shown, so nothing was changed. Reload the page, look at the list again, and confirm it.",
  notOurs: "That family isn't one of the portal's own active families, so nobody can be moved to it. Choose a family from the list on this page.",
  inactiveFollowed: "That is inactive in QuickBooks already, so nothing was sent. The portal's own record is inactive now too.",
  inactiveMeanwhile: "QuickBooks had that made inactive meanwhile (it answered the portal's request as changed since), so nothing more was sent. The portal's own record is inactive now too.",
  namedFollowed: "QuickBooks has that name already, so nothing was sent. The portal's own record has it now too.",
  inactiveHere: "That is inactive in the portal, so nothing was sent to QuickBooks.",
  notOursToAdd: "That family isn't one of the portal's own active families, so nobody can be added to it.",
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
/**
 * A customer's balance, in words: an amount owed, or a credit (a balance below zero), with its amount only for staff
 * who may see money. Nothing for none.
 */
const owesWords = (name: string, owed: { cents: number; currency: string }, showAmounts: boolean) =>
  owed.cents < 0 ? (showAmounts ? `${name} has a credit of ${formatMoney(-owed.cents, owed.currency)} in QuickBooks.` : `${name} has a credit in QuickBooks.`)
    : showAmounts ? `${name} owes ${formatMoney(owed.cents, owed.currency)} in QuickBooks.` : `${name} has an open balance in QuickBooks.`;

/** What one customer owes now, and what the same read shows of it: whether it is active, its version, and the answer itself (for the cache). */
export type Owed = { ok: true; cents: number; currency: string; active: boolean; syncToken: string | null; answer: Record<string, unknown> } | { ok: false; code: string };

/**
 * A make-inactive the balance rule stops before anything is sent: its short code, the words for staff (`words`), and,
 * for a balance, the sentence that names who has it alone (`who`: the family action lists these, then says nobody was
 * made inactive), or, for a balance that couldn't be read, the same words; and `alone`, what is true of that customer
 * alone, for a step of the family action that stops after others went through (never "nothing was changed").
 */
export type BalanceStop = { code: string; words: string; who: string; alone: string };
/** The code of a make-inactive stopped, or a waiting one made stuck, because QuickBooks shows a credit on the account. */
export const CREDIT_BALANCE = "credit_balance";
/**
 * The one balance rule for making a customer inactive (stage 3's slice 9g; app-owned families spec section 5, "The
 * balance rule", and open question 11), for every path that can: the single make-inactive (deactivateLinked(), and
 * askRosterWrite() for a Parent customer), each step of the family action and its last step's fresh read
 * (askFamilyInactive()), and the worker's try of a waiting one (./queue.ts). `owed` is the balance read live just before
 * the send (owedBy()). ANY balance stops it, an amount owed (`open_balance`) or a credit (`credit_balance`), and so does
 * a balance that couldn't be read (its own code, said by unreadWords()): nothing is sent. Null when nothing stops it.
 * Whether the read shows the customer inactive already is the caller's to look at first. The words name who, with the
 * amount only with `showAmounts` (Finance.Balance.Read), and say what to do; slice 9h uses it for a guardian's removal.
 */
export function balanceStops(owed: Owed, name: string, showAmounts: boolean): BalanceStop | null {
  if (!owed.ok) { const words = unreadWords(owed.code); return { code: owed.code, words, who: words, alone: unreadWordsOf(owed.code, name) }; }
  if (owed.cents === 0) return null;
  const who = owesWords(name, owed, showAmounts);
  const words = `${who} They weren't made inactive. ${WRITE_COPY.balanceFix}`;
  return { code: owed.cents > 0 ? "open_balance" : CREDIT_BALANCE, words, who, alone: words };
}
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
    syncToken: typeof c.SyncToken === "string" && /^\d{1,20}$/.test(c.SyncToken) ? c.SyncToken : null, answer: c };
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
/**
 * unreadWords() for one customer of the family action, read again after others were made inactive: by the same code, it
 * says that customer wasn't changed, never that nothing was.
 */
function unreadWordsOf(code: string, name: string): string {
  if (code === "no_balance") return `QuickBooks didn't say what ${name} owes, so ${name} wasn't changed. Check the balance in QuickBooks, then try again.`;
  const kind = classify(code).kind;
  if (kind === "not_connected" || kind === "needs_admin" || kind === "other_company") return connectionWordsOf(kind, name);
  if (code === "bad_id") return `${name} couldn't be sent to QuickBooks, so it wasn't changed.`;
  return kind === "retry" ? `QuickBooks couldn't be asked what ${name} owes just now, so ${name} wasn't changed. Try again in a few minutes.`
    : `QuickBooks wouldn't say what ${name} owes, so ${name} wasn't changed. Check the customer in QuickBooks; waiting won't change this answer.`;
}
/** The connection's own words (WRITE_COPY's), for one customer of the family action: that customer wasn't changed. */
function connectionWordsOf(kind: "not_connected" | "needs_admin" | "other_company", name: string): string {
  if (kind === "not_connected") return `QuickBooks isn't connected, so ${name} wasn't changed. An Admin can connect it under QuickBooks.`;
  if (kind === "needs_admin") return `QuickBooks needs to be connected again, so ${name} wasn't changed. An Admin can do that under QuickBooks.`;
  return `QuickBooks is connected to a different company from the one this roster was read from, so ${name} wasn't changed. An Admin can sort that out under QuickBooks.`;
}

/**
 * The queue items that hold back other changes while they wait or are stuck: every one but a parent's change of their
 * phone and address (`contact`, stage 3's slice 11b) and of their sign-in email (`email`, slice S11e), which block
 * nothing in any state (the lead's decisions). Each read of "a change waiting or stuck for this customer, guardian row or
 * family" carries it. Two sends to one customer are kept apart by what is there already: one sender at a time under the
 * item's "being sent" lock (lockOfItem(): a guardian's row, or the family's), and a stale answer settled by the fields (a
 * rename compares the name, a contact change its own fields, an email change the email field).
 */
export const blocksOthers = sql`${writeQueue.request}->>'op' not in ('contact', 'email')`;
/** Whether a queue item is a change of a guardian's own details sent on (a phone and mailing address, or a sign-in email): it blocks nothing (blocksOthers). */
export const isDetailsSend = (w: QueuedWrite) => w.op === "contact" || w.op === "email";

const taken = (name: string, offer: string): WriteResult => ({ ok: false, offer,
  errors: [`“${name}” is already a name in QuickBooks, and every name there must be different. You could use “${offer}” instead.`] });
const refuse = (error: string): WriteResult => ({ ok: false, errors: [error] });
const ALREADY_INACTIVE = "That is inactive in QuickBooks already, so there was nothing to change.";
/** A linked student's or member's make-inactive asked by a customer's id: it goes by the record (deactivateLinked()). */
export const LINKED_DEACTIVATE = "That is one of the portal's own records, linked to QuickBooks, so it is made inactive from its family's page. Reload the page and try again.";
/** A make-inactive QuickBooks answered as changed twice running (5010), each time just after a live read: nothing was changed. */
export const STALE_TWICE = "That changed in QuickBooks twice while it was being made inactive, so nothing was changed. Reload the page to see it as QuickBooks has it now, and try again.";
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
 * `already`: the cache shows QuickBooks has it so already (the record inactive there, or with that name), so nothing is
 * sent and the app's own record is made to match what staff asked (recordFollows()). A move is saved in the portal
 * first since stage 3's slice 9f (moveStudent()), and never comes this way.
 */
type Prepared = { ok: true; write: RosterWrite; realmId: string; familyId: AppFamilyId | null; studentId: AppStudentId | null; tag: string; name: string | null;
  already?: Already } | { ok: false; result: WriteResult };
type Already = "inactive" | "named";

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
 * the change needs, nothing is waiting for the same record (nor for the family a new record goes into), the
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
      if (already === undefined && (await inactiveRecord(tx, records))) return no(WRITE_COPY.inactiveHere);
      return { ok: true, write, realmId: source, ...records, tag: rosterTag, name, ...(already ? { already } : {}) };
    };
    // A change still waiting or stuck for this record: a family's too, before anyone is added to it or moved into it
    // (a waiting "make inactive" would land after them).
    const waitingFor = async (qboId: string) => (await tx.select({ id: writeQueue.id }).from(writeQueue)
      .where(and(eq(writeQueue.targetQboId, qboId), inArray(writeQueue.state, ["waiting", "stuck"]), blocksOthers)).limit(1)).length > 0;

    if (ask.op === "create") {
      const op: RosterOperation = ask.role === "family" ? "create_family" : ask.role === "member" ? "create_member" : "add_student";
      if (!allowed(op)) return no(WRITE_COPY.notOffered);
      const typeQboId = typeForNew(shape, ask.role, ask.role === "member" ? ask.typeQboId : null);
      if (typeQboId === null) return no(ask.role === "member" ? "Choose which kind of member this is." : WRITE_COPY.notOffered);
      let familyQboId: string | null = null;
      if (ask.role === "student") {
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
        const [own] = await tx.select({ active: family.active, name: family.name }).from(family).where(eq(family.id, ask.familyId));
        if (!own) return no(WRITE_COPY.gone);
        if (!own.active) return no(WRITE_COPY.inactiveHere);
        if ((await customerOfFamily(ask.familyId, tx)) !== null) return no(LINKED_ALREADY);
        // The last line (stage 4's slice M3b2): no family record that had a customer still in the books has its customer
        // made again by any path. addFamily(), this branch's one caller, makes a new record with a new id, which no link
        // ever named, so it never meets this; "Create in QuickBooks and link" refuses it in prepareLink() first.
        const ended = await endedHeldRefusal(tx, ask.familyId, recordNameWords(own.name, "family"), shape, cache);
        if (ended !== null) return no(ended);
        // Queued only: this create runs while its sender holds the family's "being made" lock (whileMaking()).
        if (await familyCreateQueued(tx, ask.familyId)) return no(WRITE_COPY.waiting);
        ownFamily = ask.familyId;
      }
      const email: string | null = null;
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
    // A Parent customer an open guardian row is linked to is changed through that guardian (stage 3's slice 9h): renaming
    // the person, or removing them. Only one that exists in QuickBooks alone keeps the forms below.
    if (where.role === "parent" && (await openGuardiansOf(tx, source, [record.qboId])).size > 0) return no(GUARDIAN_HERE);

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
    if (!allowed(deactivateOf(where.role))) return no(WRITE_COPY.notOffered);
    // A linked student or member is made inactive by its record, with its link's own version (deactivateLinked(), stage
    // 3's slice 9g): never by a customer's id and a page's version.
    if ((where.role === "student" && (await studentLinkedTo(record.qboId, tx)) !== null) || (where.role === "member" && (await familyLinkedTo(record.qboId, tx)) !== null)) {
      return no(LINKED_DEACTIVATE);
    }
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

/**
 * Sends a prepared write to QuickBooks: the one place that calls the client's roster writes, and, since stage 3's
 * slice 11b, the customer update of a guardian's phone and mailing address saved in the portal first (`contact`,
 * today's CUSTOMER_UPDATE body, reached only through trySavedItem()), and, since slice S11e, the email update of a
 * person's sign-in email changed in the portal first (`email`, today's EMAIL_UPDATE body, the whole field `o.field`,
 * made by tryEmail() from the field just read: never stored, and nothing is sent without one).
 */
export async function sendWrite(w: RosterWrite, realmId: string, o: { mayWait: boolean; field?: string }): Promise<Record<string, unknown>> {
  const opts = { realmId, mayWait: o.mayWait, timeoutMs: SEND_TIMEOUT_MS, signal: AbortSignal.timeout(SEND_TIMEOUT_MS * 1.5) };
  switch (w.op) {
    case "create": return qboCreateCustomer({ name: w.name, typeQboId: w.typeQboId, parentQboId: w.familyQboId, billWithParent: w.role === "student", email: w.email }, opts);
    case "rename": return qboRenameCustomer(w.qboId, w.syncToken, w.name, opts);
    case "move": return qboMoveCustomer(w.qboId, w.syncToken, w.toFamilyQboId, opts);
    case "deactivate": return qboSetCustomerActive(w.qboId, w.syncToken, false, opts);
    case "contact": return qboUpdateCustomerContact(w.qboId, w.syncToken, w.change, opts);
    case "email": return qboUpdateCustomerEmail(w.qboId, w.syncToken, o.field ?? "", opts);
  }
}

const AUDIT_ACTION = { create: "roster.customer.create", rename: "roster.customer.rename", move: "roster.student.move", deactivate: "roster.customer.deactivate",
  contact: "roster.customer.contact", email: "roster.customer.email" } as const;
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
 * The part of a student's move that other parts of the portal follow, in moveStudent()'s save transaction, after the
 * student record's family is set: the roster cache doesn't change there, and has the student where QuickBooks last had
 * them until QuickBooks takes the move (applyWritten(), the queue) or a roster read shows it, so nothing here may read
 * the cache for the student's new family. In this order: the student's signature requests
 * (formsForMovedStudent, src/lib/forms/moved.ts: a complete one moves with its evidence, any other is reset under the
 * new family and its document queued for the worker to withdraw), then the student's volunteer places
 * (volunteerForMovedStudent, src/lib/volunteer/moved-student.ts: places on shifts still to come are given up, credit
 * stays with the family it was earned for), then its per-student buy-outs (buyoutsForMovedStudent, src/lib/buyouts/moved.ts:
 * an unpaid invoice queued to void, anything else flagged), then the audit row of the move's follow-up with their counts. The answer's
 * `tell` emails the guardians whose places were given up: call it after the transaction commits; `buyouts` says how many
 * buy-outs had a void queued and how many were flagged, for the staff member's answer. The move comes by the
 * app's own records (stage 3's slice 9f), linked to QuickBooks or not, and is followed once, where the portal saves it.
 */
export async function afterStudentMoved(tx: Tx, move: { studentId: AppStudentId; fromFamilyId: AppFamilyId; toFamilyId: AppFamilyId; cause: string },
  o: { actor: Actor; ip: string | null }): Promise<{ tell: () => Promise<unknown>; buyouts: { voiding: number; flagged: number } }> {
  const who = { studentId: move.studentId, fromFamilyId: move.fromFamilyId, toFamilyId: move.toFamilyId };
  const forms = await formsForMovedStudent(tx, { ...who, actor: o.actor, ip: o.ip });
  const volunteer = await volunteerForMovedStudent(tx, who, { actor: o.actor, ip: o.ip });
  const buyouts = await buyoutsForMovedStudent(tx, who, { actor: o.actor, ip: o.ip });
  await writeAudit({ actor: { door: "system", id: null, label: "roster" }, action: "roster.student.move.followed", targetType: "student", targetId: String(move.studentId),
    after: { studentId: String(move.studentId), fromFamilyId: String(move.fromFamilyId), toFamilyId: String(move.toFamilyId), cause: move.cause,
      formsMoved: forms.moved, formsReset: forms.reset, formsToWithdraw: forms.toWithdraw.length, placesGivenUp: volunteer.cancelled,
      buyoutsToVoid: buyouts.voiding, buyoutsFlagged: buyouts.flagged } }, tx);
  return { tell: volunteer.tell, buyouts: { voiding: buyouts.voiding, flagged: buyouts.flagged } };
}

/**
 * Both families' figures marked stale when the cache takes QuickBooks' answer of a move (applyWritten(), and the queue's
 * found-done path after a send), in the caller's transaction: whose invoices a family sees follows QuickBooks' tree
 * (open question 14), so the next load of Home or Payments (loadFamilyMoney(), which reads a marked row live) shows
 * neither family figures from before the move. The Season and Volunteer pages and the due-date reminders read the
 * stored figures as they are (paymentStandings() reads no mark) until such a load or the daily run reads them. The
 * families are the move's own records (`fromFamilyId`, `toFamilyId`); a move queued before slice 9f names them by
 * customer, through their links. Not one of the move's follow-ups, which ran when the portal saved it.
 */
export async function markMoveMoneyStale(tx: Tx, w: Extract<RosterWrite, { op: "move" }>): Promise<void> {
  const of = async (record: AppFamilyId | undefined, customer: string) => record ?? (customer === "" || customer === TOP_OF_TREE ? null : await familyLinkedTo(customer, tx));
  const families = [...new Set([await of(w.fromFamilyId, w.fromFamilyQboId), await of(w.toFamilyId, w.toFamilyQboId)].flatMap((f) => (f === null ? [] : [String(f)])))];
  if (!families.length) return;
  await tx.update(familyMoney).set({ staleAt: new Date(), updatedAt: new Date() }).where(inArray(familyMoney.familyId, families.map(asAppFamilyId)));
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
  /** `leftUnlinkedCleared`: the accounting links screen's Left unlinked mark was set on it, and this cleared it (stage 4's slice M3a). */
  | { kind: "family"; familyId: string; linked: true; linkId: string; leftUnlinkedCleared?: true }
  | { kind: "student"; studentId: string; linked: true; linkId: string }
  | { kind: "family"; familyId: string; set: { name?: string; active?: boolean } }
  | { kind: "student"; studentId: string; set: { name?: string; active?: boolean; familyId?: string } }
  /** A guardian row (a membership) linked to the Parent customer QuickBooks made for it (stage 3's slice 9h). */
  | { kind: "guardian"; guardianId: string; linked: true; linkId: string };

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
 * - a move: nothing. Since stage 3's slice 9f a move is saved in the portal first (moveStudent()), the student record's
 *   family with it, and its follow-ups run there, once: QuickBooks taking it changes no record;
 * - a make-inactive: a member's or family's record, or a student's (a customer the family action covers, too, when it
 *   has a student record), inactive. A family's own record goes inactive with its own last step, after everyone under it.
 * A Parent customer changes no record: memberships are made and ended on a family's Portal sign-ins box (slice 7b). A
 * Parent customer's create made for a guardian row (`guardianId`, stage 3's slice 9h) links that row to the new
 * customer (`origin` `created`, by `linkedBy`), only while the row has no link in the company and no other open guardian
 * row is linked to that customer (guardianCustomerHeld()); its rename and make-inactive change nothing in the portal.
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
  const now = new Date();
  // A new link starts aligned with the version QuickBooks answered the create with (or the cache row it was found as).
  const aligned = o.syncedToken && /^\d{1,20}$/.test(o.syncedToken) ? { syncedToken: o.syncedToken, syncedAt: now } : {};
  // A guardian's or a family's phone and mailing address (stage 3's slice 11b), and a person's sign-in email (slice
  // S11e), are the portal's own, saved before they were sent: QuickBooks taking them changes no record.
  if (w.op === "contact" || w.op === "email") return null;
  if (w.role === "parent") {
    if (w.op !== "create" || !w.guardianId) return null;
    if ((await customerOfGuardian(w.guardianId, tx)) !== null || (await guardianCustomerHeld(tx, o.realmId, customerId, w.guardianId))) return null;
    const [row] = await tx.select({ id: guardian.id }).from(guardian).where(eq(guardian.id, w.guardianId));
    if (!row) return null;
    const [link] = await tx.insert(accountingLink).values({ system: QUICKBOOKS, realmId: o.realmId, customerId, guardianId: w.guardianId, origin: "created", linkedBy: o.linkedBy, ...aligned })
      .returning({ id: accountingLink.id });
    return { kind: "guardian", guardianId: w.guardianId, linked: true, linkId: link!.id };
  }
  if (w.op === "create") {
    if (w.role === "family" || w.role === "member") {
      if ((await familyLinkedTo(customerId, tx)) !== null) return null;
      if (o.familyId) {
        if ((await customerOfFamily(o.familyId, tx)) !== null) return null;
        const [link] = await tx.insert(accountingLink).values({ system: QUICKBOOKS, realmId: o.realmId, customerId, familyId: o.familyId, origin: "created", linkedBy: o.linkedBy, ...aligned })
          .returning({ id: accountingLink.id });
        // A family staff left unlinked on the accounting links screen has a link now: the mark goes with it (stage 4's slice M3a).
        const cleared = await clearLeftUnlinked(tx, o.familyId);
        return { kind: "family", familyId: String(o.familyId), linked: true, linkId: link!.id, ...(cleared ? { leftUnlinkedCleared: true as const } : {}) };
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
  // A move is the portal's own change, saved first with its follow-ups (moveStudent()): QuickBooks taking it moves nothing.
  if (w.op === "move") return null;
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
 * the customer is stored from the answer (only if newer), a move marks both families' figures stale (its follow-ups
 * ran when the portal saved it, and never run again here), the app's own record the write was about is made or
 * changed (changeOwnRecord()), and a family made inactive asks the worker for a roster
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
  const targetId = w.op === "create" ? (typeof answer.Id === "string" ? answer.Id.slice(0, 64) : "unknown") : w.qboId;
  // The customer a create was answered with, kept on a held item so that it is never sent again (holdForTheQueue()).
  const resultQboId = w.op === "create" && typeof answer.Id === "string" ? targetId : null;
  let held = false;
  try {
    await db.transaction(async (tx) => {
      const ours = await lockRosterAs(tx, rosterTagOf(o.realmId));
      const [cached] = w.op === "create" ? [] : await tx.select().from(qboCustomer).where(eq(qboCustomer.qboId, w.qboId));
      const fits = answerIsFor(w, answer);
      let refreshAsked = false, aligned = false;
      let appRecord: OwnRecordChange | null = null;
      // A queued try whose item staff gave up while it was on its way stays given up: the cache takes QuickBooks' answer,
      // but no record is made, linked or changed for it, and a create keeps the customer it made (keepMadeOnGivenUp()).
      const givenUp = ours && o.queueId !== undefined && (await queuedNoLonger(tx, o.queueId));
      if (ours && fits && givenUp) {
        await upsertFromAnswer(tx, answer, await getShape(tx));
        if (w.op === "move") await markMoveMoneyStale(tx, w);
        await keepMadeOnGivenUp(tx, o.queueId!, resultQboId);
      } else if (ours && fits) {
        await upsertFromAnswer(tx, answer, await getShape(tx));
        // Whose invoices a family sees follows QuickBooks' tree (open question 14): both families' figures are read again.
        if (w.op === "move") await markMoveMoneyStale(tx, w);
        appRecord = await changeOwnRecord(tx, w, targetId, { realmId: o.realmId, linkedBy: o.linkedBy, studentId: o.filed?.studentId, familyId: o.filed?.familyId, syncedToken: answerToken });
        // A student saved first, now linked, leaves no refused create of theirs behind (stage 3's slice 9e).
        if (appRecord?.kind === "student" && "linked" in appRecord) {
          await replaceRefusedCreates(tx, asAppStudentId(appRecord.studentId), { op: "create", customerQboId: targetId, ...(o.queueId ? { queueId: o.queueId } : {}) }, o);
        }
        aligned = await alignAfterWrite(tx, w, o.realmId, answerToken, o.filed);
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
    await db.transaction(async (tx) => {
      await askForRosterRefresh(tx);
      await writeAudit({ actor: o.actor, action: AUDIT_ACTION[w.op], permission: o.permission, ip: o.ip, targetType: "qbo_customer", targetId,
        before: w.op === "create" ? null : { syncToken: w.syncToken },
        after: { ...auditAfter(w, answer), ...(o.queueId ? { queueId: o.queueId } : {}), refreshAsked: true, code: "cache_failed" } }, tx);
      await holdForTheQueue(tx, w, "cache_failed", { ...o, resultQboId });
    });
    return { cached: false };
  }
  return { cached: !held };
}

/** The kind of link a write's record has: a family's (or a member's) or a student's; none for a parent or another customer. */
const linkKindOf = (role: RosterWrite["role"]): "family" | "student" | null => (role === "family" || role === "member" ? "family" : role === "student" ? "student" : null);

/**
 * Sets the version the portal last aligned with on a customer's link of one kind (`synced_token`, stage 3's slice 9e),
 * in the caller's transaction, which holds the roster lock exclusively (as every link write does). `onlyIf`: only
 * while the link holds that version. Whether it changed anything.
 */
async function alignLink(tx: Tx, kind: "family" | "student", customerId: string, realmId: string, token: string | null, onlyIf?: string, recordId?: AppFamilyId | AppStudentId): Promise<boolean> {
  if (token === null || !/^\d{1,20}$/.test(token)) return false;
  const rows = await tx.update(accountingLink).set({ syncedToken: token, syncedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId), eq(accountingLink.customerId, customerId),
      kind === "family" ? isNotNull(accountingLink.familyId) : isNotNull(accountingLink.studentId),
      recordId === undefined ? undefined : kind === "family" ? eq(accountingLink.familyId, recordId as AppFamilyId) : eq(accountingLink.studentId, recordId as AppStudentId),
      onlyIf === undefined ? undefined : eq(accountingLink.syncedToken, onlyIf))).returning({ id: accountingLink.id });
  return rows.length > 0;
}

/** alignLink() for a guardian row's own link (several rows may share a customer, so it goes by the row). */
async function alignGuardianLink(tx: Tx, guardianId: string, customerId: string, realmId: string, token: string | null, onlyIf?: string): Promise<boolean> {
  if (token === null || !/^\d{1,20}$/.test(token)) return false;
  const rows = await tx.update(accountingLink).set({ syncedToken: token, syncedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId), eq(accountingLink.customerId, customerId), eq(accountingLink.guardianId, guardianId),
      onlyIf === undefined ? undefined : eq(accountingLink.syncedToken, onlyIf))).returning({ id: accountingLink.id });
  return rows.length > 0;
}

/**
 * After an update QuickBooks took (or one the queue found made), the record's link takes the version QuickBooks now
 * holds (`token`: the answer's, or the cache row it was found as), only when what was sent carried the link's own
 * version (`syncToken` equal to the link's), or was a rename or move resent with a version read live after its name,
 * or its parent, read as the portal held it, or a make-inactive sent with the version a live read just showed (stage
 * 3's slice 9g: a link with none, or a resend after a stale answer) (`checked`). A make-inactive queued before slice 9g
 * with a page's version that differs from the link's, or a Parent customer's, leaves it, and so does the family
 * action's last step when the version it just read differs (one that happens to
 * equal the link's is a send that carried the link's own version, by the same rule); a parent's change has no link. A
 * create's link takes it in changeOwnRecord(). The queue aligns a change it finds made only when it was sent.
 * A make-inactive aligns only the link of the record it is filed under (`filed`), the record changeOwnRecord() makes
 * inactive with it: a step of the family action for a student QuickBooks has under this family whose record is in
 * another family is filed under no student, leaves that record active, and so leaves its link alone too, so the link
 * never claims a version whose Active flag differs from its record's.
 */
export async function alignAfterWrite(tx: Tx, w: RosterWrite, realmId: string, token: string | null, filed?: Filed): Promise<boolean> {
  if (w.op === "create") return false;
  // A guardian's Parent customer (stage 3's slice 9h): its link is aligned by its own row, since several rows may be
  // linked to one customer, by the same rule (the link's own version sent, or one read live, `checked`).
  if (w.op !== "move" && w.role === "parent" && w.guardianId) return alignGuardianLink(tx, w.guardianId, w.qboId, realmId, token, w.checked ? undefined : w.syncToken);
  const kind = linkKindOf(w.role);
  if (kind === null) return false;
  let recordId: AppFamilyId | AppStudentId | undefined;
  if (w.op === "deactivate") {
    const own = kind === "student" ? filed?.studentId : filed?.familyId;
    if (own === null || own === undefined) return false;
    recordId = own;
  }
  return alignLink(tx, kind, w.qboId, realmId, token, w.checked ? undefined : w.syncToken, recordId);
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
async function recordNow(tx: Tx, w: Extract<RosterWrite, { op: "rename" | "deactivate" }>, studentId: AppStudentId | null) {
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
 * What staff asked for is in QuickBooks already (code `already_inactive`: the customer is inactive there; or
 * `already_named`: it has that name), so nothing is sent, and the app's own record is made to match what was asked,
 * as the queue's found-done path makes it for a change it finds made (foundDone(), ./queue.ts), so the two paths agree:
 * changeOwnRecord() under the roster lock, audited (roster.record.follows) with the record before and what changed, in
 * the same transaction, the record filed under `filed`. Null when the record was as asked already, there is none (a
 * parent's), or the roster is another company's now. A move is the portal's own change since stage 3's slice 9f, and
 * a move to the family QuickBooks has the student under is saved like any other (moveStudent(), which sends nothing).
 */
async function recordFollows(w: Extract<RosterWrite, { op: "rename" | "deactivate" }>, filed: Filed, realmId: string,
  code: "already_inactive" | "already_named", o: WriteOp & { staffUserId: string }): Promise<OwnRecordChange | null> {
  return db.transaction(async (tx) => {
    if (!(await lockRosterAs(tx, rosterTagOf(realmId)))) return null;
    const before = await recordNow(tx, w, filed.studentId);
    if (before === null) return null;
    const change = await changeOwnRecord(tx, w, w.qboId, { realmId, linkedBy: o.staffUserId, studentId: filed.studentId });
    if (!change) return null;
    await writeAudit({ actor: o.actor, action: "roster.record.follows", permission: o.permission, ip: o.ip, targetType: "qbo_customer", targetId: w.qboId,
      before, after: { op: w.op, role: w.role, code, appRecord: change } }, tx);
    return change;
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
  const filed: Filed = { familyId: p.familyId, studentId: p.studentId };
  if (p.already && (p.write.op === "rename" || p.write.op === "deactivate")) {
    // The cache shows QuickBooks has it so already: nothing is sent; the app's own record takes what was asked.
    const how = { inactive: ["already_inactive", WRITE_COPY.inactiveFollowed, ALREADY_INACTIVE], named: ["already_named", WRITE_COPY.namedFollowed, ALREADY_NAMED] } as const;
    const [code, followedWords, nothingWords] = how[p.already];
    const followed = await recordFollows(p.write, filed, p.realmId, code, o);
    return followed ? { ok: true, message: followedWords } : refuse(nothingWords);
  }
  if (p.write.op === "deactivate") {
    // A Parent customer's make-inactive (a linked student's or member's is deactivateLinked()'s), under the one balance
    // rule (balanceStops(), stage 3's slice 9g): what they owe is read first, and nothing is sent while there is any
    // balance, owed or a credit, nor while it can't be read, which is refused in words and never queued.
    const owed = await owedBy(p.write.qboId, p.realmId);
    const name = p.name ?? "This customer";
    if (!owed.ok) {
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
    const stop = balanceStops(owed, name, o.showAmounts === true);
    if (stop) {
      await audited(stop.code, p.write, target);
      return refuse(stop.words);
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
  move: "Moved in the portal and in QuickBooks.",
  deactivate: "Made inactive in QuickBooks.",
  contact: "Sent to QuickBooks.",
  email: "Sent to QuickBooks.",
};

/* ---- Making someone inactive, QuickBooks first, under the balance rule (stage 3's slice 9g; app-owned families spec
   section 5, "The balance rule", open questions 11 and 12, Appendix B) ----
   A linked student's or member's make-inactive stays QuickBooks first: the portal's record is made inactive only from
   QuickBooks' answer, or from finding QuickBooks has it inactive already. Before anything is sent the balance is read
   live (owedBy()) and any balance, owed or a credit, or one that can't be read, stops it (balanceStops()). It is sent
   with the link's own version (`accounting_link.synced_token`), never a page's, or, for a link with none, the version
   the read just showed (`checked`); a stale answer is settled by the field, the Active flag, read live again. */

type DeactivateWrite = Extract<RosterWrite, { op: "deactivate" }>;
/** What a make-inactive is sent with: its own version, or, when it carries none, the one a live read just showed (`checked`). Null when the read showed none. */
const sentWith = (w: DeactivateWrite, read: { syncToken: string | null }): DeactivateWrite | null =>
  w.syncToken !== "" ? w : read.syncToken === null ? null : { ...w, syncToken: read.syncToken, checked: true };

/**
 * How one try of a make-inactive came out (sendDeactivate(), tryDeactivate()): `answer`, QuickBooks took `write`
 * (`resent`: the second send, after a stale answer and a live read); `inactive_there`, a live read shows the customer
 * inactive already, so nothing (more) was sent and the change is found made (`sent`: a request went first, which
 * QuickBooks answered as stale); `stopped`, the balance rule stopped it
 * before a send (the first, or the resend after a stale answer); `failed`, the send failed (`sent`: QuickBooks may have
 * acted on it); `stale_again`, QuickBooks answered as changed twice, each time just after a live read.
 */
export type DeactivateTry =
  | { is: "answer"; write: DeactivateWrite; answer: Record<string, unknown>; resent: boolean }
  | { is: "inactive_there"; answer: Record<string, unknown>; sent: boolean }
  | { is: "stopped"; stop: BalanceStop }
  | { is: "failed"; code: string; sent: boolean; write: DeactivateWrite }
  | { is: "stale_again"; write: DeactivateWrite };
type DeactivateHow = { mayWait: boolean; name: string; showAmounts: boolean; actor: Actor; ip: string | null; permission?: string };
/**
 * A live read that showed the balance but no version to send with: nothing is sent. Its code is the one an answer that
 * couldn't be read has (`bad_answer`, so the worker tries it again later), and its words say what was missing, not that
 * the balance was.
 */
const unreadAnswer = (name: string): DeactivateTry => {
  const why = `QuickBooks' answer about ${name} couldn't be read (it didn't say which version it holds)`;
  const words = `${why}, so nothing was changed. Try again in a few minutes.`;
  return { is: "stopped", stop: { code: "bad_answer", words, who: words, alone: `${why}, so ${name} wasn't changed. Try again in a few minutes.` } };
};

/**
 * A make-inactive sent once a live read (`read`, owedBy()) has shown the customer active with no balance, and its stale
 * answer settled by the field (the lead's decision 2 for slice 9g): on QuickBooks' 5010 the customer is read live again
 * (stored in the cache when newer, storeReadAgain()); inactive there, the change is found made and nothing more is sent;
 * still active, the balance rule again on that read, and then it is sent once more with the version just read
 * (`checked`). A second stale answer is `stale_again`. Never more than one resend; inside the client a request is still
 * sent twice only after a 401.
 */
export async function sendDeactivate(w: DeactivateWrite, read: Extract<Owed, { ok: true }>, realmId: string, o: DeactivateHow): Promise<DeactivateTry> {
  const first = sentWith(w, read);
  if (first === null) return unreadAnswer(o.name);
  try {
    return { is: "answer", write: first, answer: await sendWrite(first, realmId, { mayWait: o.mayWait }), resent: false };
  } catch (e) {
    if (!(e instanceof QboError)) throw e;
    const failure = classify(e.code);
    if (failure.kind !== "stale") return { is: "failed", code: e.code, sent: failure.kind === "retry" && failure.sent, write: first };
  }
  // The field is the arbiter: whether QuickBooks has the customer active now, read live (never the cache, never a page).
  const live = await owedBy(w.qboId, realmId, { mayWait: o.mayWait });
  if (!live.ok) return { is: "stopped", stop: balanceStops(live, o.name, o.showAmounts)! };
  await storeReadAgain(live.answer, realmId, o);
  if (!live.active) return { is: "inactive_there", answer: live.answer, sent: true };
  const stop = balanceStops(live, o.name, o.showAmounts);
  if (stop) return { is: "stopped", stop };
  const again = sentWith({ ...w, syncToken: "" }, live);
  if (again === null) return unreadAnswer(o.name);
  try {
    return { is: "answer", write: again, answer: await sendWrite(again, realmId, { mayWait: o.mayWait }), resent: true };
  } catch (e) {
    if (!(e instanceof QboError)) throw e;
    const failure = classify(e.code);
    if (failure.kind === "stale") return { is: "stale_again", write: again };
    return { is: "failed", code: e.code, sent: failure.kind === "retry" && failure.sent, write: again };
  }
}

/**
 * One try of a make-inactive from its first read: the balance read live just before the send (owedBy(); for a staff
 * member pressing a button it never waits for the connection row, the worker may, `mayWait`). Inactive there already:
 * found made, nothing sent. Any balance, or one that can't be read: stopped, nothing sent (balanceStops()). Otherwise
 * sent, and a stale answer settled by the field (sendDeactivate()). The one path the single make-inactive
 * (deactivateLinked()) and the queue's worker (./queue.ts) take.
 */
export async function tryDeactivate(w: DeactivateWrite, realmId: string, o: DeactivateHow): Promise<DeactivateTry> {
  const read = await owedBy(w.qboId, realmId, { mayWait: o.mayWait });
  if (!read.ok) return { is: "stopped", stop: balanceStops(read, o.name, o.showAmounts)! };
  if (!read.active) return { is: "inactive_there", answer: read.answer, sent: false };
  const stop = balanceStops(read, o.name, o.showAmounts);
  if (stop) return { is: "stopped", stop };
  return sendDeactivate(w, read, realmId, o);
}

/** What staff make inactive on a linked record's page: the record's kind and the app's id, a uuid. No version and no QuickBooks id. */
export type LinkedDeactivate = { kind: "family" | "student"; recordId: string };

/**
 * A linked student (layered books) or member (flat) made inactive, QuickBooks first, by the record (stage 3's slice 9g;
 * the lead's decisions 1 and 2): `recordId` is the app's id the page sent. It holds the record's "being sent" lock
 * (whileSending()) from before its checks until its answer is in or it is queued, so it never interleaves with the
 * record's rename or move (held: `STUDENT_BEING_CHANGED` or `FAMILY_BEING_CHANGED`, nothing done). Under the roster lock
 * with the page's tag, every check prepare() makes for a make-inactive, by the record: QuickBooks connected to the
 * roster's company and the shape holding and offering it (readyToSend()), the record active and linked (an unlinked one
 * is changeInPortal()'s), its customer on the roster in the role (a layered family goes with everyone under it, on its
 * own page), nothing waiting or stuck for that customer, its family's create neither waiting nor being sent, the
 * student's own create not waiting and no move of the student waiting, stuck or kept. The cache showing the customer
 * inactive already: nothing is read or sent, and the record follows (recordFollows()). Otherwise one try
 * (tryDeactivate()), with the link's own version: taken, the record made inactive from QuickBooks' answer
 * (applyWritten()); inactive there, the record follows, the link not aligned; stopped by the balance rule, or stale
 * twice, refused in words with nothing queued; a send that may go through later (a lost answer, a 5xx) queued, as
 * QuickBooks may have it or not (classify()), found by the queue after a roster read.
 */
export async function deactivateLinked(ask: LinkedDeactivate, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  if (!isUuid(ask.recordId)) return refuse(WRITE_COPY.gone);
  const recordId = ask.recordId.toLowerCase();
  return (await whileSending(recordId, () => deactivateHolding(ask.kind, recordId, rosterTag, o))) ?? refuse(ask.kind === "student" ? STUDENT_BEING_CHANGED : FAMILY_BEING_CHANGED);
}

/** A move of this student waiting, stuck or kept on the queue: QuickBooks is never asked to make them inactive meanwhile (slice 9f's rule for their families). */
const STUDENT_MOVE_PENDING = "A move of this student hasn't reached QuickBooks yet (it is waiting, stuck or kept on the Reconciliation page), so they weren't made inactive. Finish it there, or give it up, then try again.";
/** A linked record's make-inactive asked of one with no link: that is changed in the portal only. */
const NOT_LINKED_INACTIVE = "That isn't linked to QuickBooks, so it is made inactive in the portal only: reload the page and use “Change in the portal”.";

async function deactivateHolding(kind: "family" | "student", recordId: string, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  type Ready = { ok: true; write: DeactivateWrite; realmId: string; filed: Filed; name: string; already: boolean } | { ok: false; result: WriteResult };
  const p = await db.transaction(async (tx): Promise<Ready> => {
    const no = (error: string): Ready => ({ ok: false, result: refuse(error) });
    const ready = await readyToSend(tx, rosterTag);
    if (!ready.ok) return no(ready.error);
    const { shape, source, cache, roster } = ready;
    let active: boolean, customer: string | null, filed: Filed;
    if (kind === "family") {
      const [f] = await tx.select().from(family).where(eq(family.id, asAppFamilyId(recordId))).for("update");
      if (!f) return no(WRITE_COPY.gone);
      active = f.active; customer = await customerOfFamily(f.id, tx); filed = { familyId: f.id, studentId: null };
    } else {
      const [s] = await tx.select().from(student).where(eq(student.id, asAppStudentId(recordId))).for("update");
      if (!s || s.familyId === null) return no(WRITE_COPY.gone);
      const [f] = await tx.select({ active: family.active }).from(family).where(eq(family.id, s.familyId));
      active = s.active && f?.active === true; customer = await customerOfStudent(s.id, tx); filed = { familyId: s.familyId, studentId: s.id };
    }
    if (!active) return no(INACTIVE_HERE);
    if (customer === null) return no(NOT_LINKED_INACTIVE);
    const c = cache.find((x) => x.qboId === customer);
    const where = c ? roleIn(roster, customer) : null;
    if (!c || !where) return no(WRITE_COPY.gone);
    if (kind === "family" && where.role === "family") return no(familyHereWords(c.displayName));
    if (kind === "family" ? where.role !== "member" : where.role !== "student") return no(WRITE_COPY.gone);
    if (!offers(shape, deactivateOf(where.role))) return no(WRITE_COPY.notOffered);
    if (await waitingForCustomer(tx, customer)) return no(WRITE_COPY.waiting);
    const making = await familyCreateWaiting(tx, filed.familyId!);
    if (making) return no(making === "sending" ? FAMILY_SENDING : FAMILY_WAITING);
    if (filed.studentId !== null) {
      if (await studentCreateWaiting(tx, filed.studentId)) return no(STUDENT_WAITING);
      const moves = await tx.select({ id: writeQueue.id }).from(writeQueue).where(and(movesOf(filed.studentId), inArray(writeQueue.state, ["waiting", "stuck", "refused"]))).limit(1);
      if (moves.length) return no(STUDENT_MOVE_PENDING);
    }
    const [link] = await tx.select({ syncedToken: accountingLink.syncedToken }).from(accountingLink)
      .where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, source), eq(accountingLink.customerId, customer),
        kind === "family" ? isNotNull(accountingLink.familyId) : isNotNull(accountingLink.studentId)));
    return { ok: true, write: { op: "deactivate", role: where.role, qboId: customer, syncToken: link?.syncedToken ?? "" }, realmId: source, filed, name: c.displayName, already: !c.active };
  });
  if (!p.ok) return p.result;
  const audited = (code: string, write: DeactivateWrite) => writeAudit({ actor: o.actor, action: "roster.write.refused", permission: o.permission, ip: o.ip,
    targetType: "qbo_customer", targetId: write.qboId, after: { op: "deactivate", role: write.role, code: short(code) } });
  // `sent`: a request went first, answered as stale, so the words never say nothing was sent.
  const follows = async (sent = false): Promise<WriteResult> => ((await recordFollows(p.write, p.filed, p.realmId, "already_inactive", o))
    ? { ok: true, message: sent ? WRITE_COPY.inactiveMeanwhile : WRITE_COPY.inactiveFollowed } : refuse(ALREADY_INACTIVE));
  // The cache shows QuickBooks has it inactive already: nothing is read or sent; the record takes what was asked.
  if (p.already) return follows();
  const t = await tryDeactivate(p.write, p.realmId, { mayWait: false, name: p.name, showAmounts: o.showAmounts === true, actor: o.actor, ip: o.ip, permission: o.permission });
  switch (t.is) {
    case "answer": {
      const { cached } = await applyWritten(t.write, t.answer, { realmId: p.realmId, actor: o.actor, ip: o.ip, permission: o.permission, linkedBy: o.staffUserId, filed: p.filed,
        ...(t.resent ? { auditExtra: { resent: "stale" } } : {}) });
      return { ok: true, message: cached ? DONE_WORDS.deactivate : WRITE_COPY.doneNotShown };
    }
    case "inactive_there": {
      // The cache is behind QuickBooks: the answer is stored, the roster read again, and the record follows (the link
      // is not aligned: it wasn't the portal's send that made it inactive).
      await storeReadAgain(t.answer, p.realmId, o);
      await db.transaction((tx) => askForRosterRefresh(tx));
      return follows(t.sent);
    }
    case "stopped":
      await audited(t.stop.code, p.write);
      return refuse(t.stop.words);
    case "stale_again":
      await audited("fault_5010", t.write);
      return refuse(STALE_TWICE);
    case "failed": {
      const failure = classify(t.code);
      if (failure.kind === "retry") {
        await enqueue({ write: t.write, realmId: p.realmId, ...p.filed }, t.code, failure.sent, o);
        return { ok: true, queued: true, message: WRITE_COPY.queued };
      }
      await audited(t.code, t.write);
      return refuse(refusalWords(t.code, p.name) ?? (failure.kind === "not_connected" ? WRITE_COPY.notConnected : failure.kind === "needs_admin" ? WRITE_COPY.needsAdmin
        : failure.kind === "other_company" ? WRITE_COPY.otherCompany : t.code === "bad_id" ? WRITE_COPY.notSent : WRITE_COPY.refused));
    }
  }
}

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
 * names and binds the family record's app id and a stamp of whom it covered (coverStamp()) into its form, never an id
 * or a version. Null when the cache holds no such customer.
 */
export async function familyCover(familyQboId: string): Promise<{ family: Covered; under: Covered[] } | null> {
  const cache = await db.transaction((tx) => cacheRows(tx));
  const f = cache.find((c) => c.qboId === familyQboId);
  if (!f) return null;
  return { family: { qboId: f.qboId, name: f.displayName, syncToken: f.syncToken, depth: 0 }, under: activeUnder(cache, familyQboId) };
}

/**
 * The stamp the family's page puts on "Make … inactive" (stage 3's slice 9g): the family record's app id and the
 * QuickBooks ids of whom familyCover() drew (the family's and everyone active under it), sorted, sealed with the
 * portal's secret, so whom staff confirmed is never taken from the browser: the action refuses (`coverChanged`) when the
 * cache's cover no longer reads so (someone added under the family, or made active or inactive there, since the page).
 */
export function coverStamp(familyId: string, qboIds: readonly string[]): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET).update(`family-cover:${familyId.toLowerCase()}|${[...qboIds].sort().join(",")}`).digest("base64url").slice(0, 22);
}
const coverStampHolds = (familyId: string, qboIds: readonly string[], stamp: string) => {
  const want = Buffer.from(coverStamp(familyId, qboIds)), got = Buffer.from(stamp);
  return got.length === want.length && timingSafeEqual(got, want);
};

/**
 * One step of the family action, with the records a queue item for it would be filed under (holdForTheQueue()). Its
 * write carries the version of its own link of its kind (a student of this family's record), or none (`""`: any other
 * customer, a Parent customer, one QuickBooks has here whose student record is in another family, and the family itself,
 * which is read again just before it is sent), and is then sent with the version its live read showed.
 */
type FamilyStep = { write: Extract<RosterWrite, { op: "deactivate" }>; name: string; filed: Filed };
type PreparedFamily = { ok: true; realmId: string; familyQboId: string; familyName: string; steps: FamilyStep[] } | { ok: false; result: WriteResult };

/**
 * Everything checked before anything is sent, under the roster lock, as prepare() checks one write: the page was shown
 * this company's roster, QuickBooks is connected to it, the shape offers making a family inactive, the family record
 * the page named is active in the portal and linked (an unlinked one is changeInPortal()'s), its customer a family on
 * the roster, nothing is waiting for it or anyone under it, and whom it covers is still whom the page drew (`stamp`,
 * coverStamp(): someone added under it, or made active or inactive there since, is refused, and staff look at the list
 * again and confirm it). A family QuickBooks has inactive already is refused only when its record is inactive too:
 * otherwise the action makes the record match, sending nothing for the family. Each step carries its own link's
 * version where it is a student of this family's record, else none (FamilyStep).
 */
async function prepareFamily(familyId: AppFamilyId, stamp: string, rosterTag: string): Promise<PreparedFamily> {
  const no = (error: string): PreparedFamily => ({ ok: false, result: refuse(error) });
  return db.transaction(async (tx): Promise<PreparedFamily> => {
    if (!(await lockRosterAs(tx, rosterTag))) return no(ROSTER_MOVED);
    const [shape, source, conn, types] = await Promise.all([getShape(tx), getRosterSource(tx), getConnection(tx), tx.select().from(qboCustomerType)]);
    if (!conn?.realmId || !conn.refreshTokenCiphertext) return no(WRITE_COPY.notConnected);
    if (source === null || source !== conn.realmId) return no(WRITE_COPY.otherCompany);
    if (!shape || missingTypes(shape, types.map((t) => ({ qboId: t.qboId, name: t.name, active: t.active }))).length) return no(WRITE_COPY.noRoster);
    if (shape.kind !== "layered" || !offers(shape, "deactivate_family")) return no(WRITE_COPY.notOffered);
    const [own] = await tx.select({ active: family.active }).from(family).where(eq(family.id, familyId));
    if (!own) return no(WRITE_COPY.gone);
    const familyQboId = await customerOfFamily(familyId, tx);
    if (familyQboId === null) return no(NOT_LINKED_INACTIVE);
    const cache = await cacheRows(tx);
    const roster = buildRoster(shape, cache);
    const where = roleIn(roster, familyQboId);
    const customer = cache.find((c) => c.qboId === familyQboId);
    if (!customer || !where || where.role !== "family") return no(WRITE_COPY.gone);
    const ownRecord = familyId;
    if (!own.active) return no(customer.active ? WRITE_COPY.inactiveHere : "That family is inactive in QuickBooks already, so there was nothing to change.");
    const under = activeUnder(cache, familyQboId);
    if (!coverStampHolds(String(familyId), [familyQboId, ...under.map((u) => u.qboId)], stamp)) return no(WRITE_COPY.coverChanged);
    const ids = [familyQboId, ...under.map((u) => u.qboId)];
    const waiting = await tx.select({ id: writeQueue.id }).from(writeQueue).where(and(inArray(writeQueue.targetQboId, ids), inArray(writeQueue.state, ["waiting", "stuck"]), blocksOthers)).limit(1);
    if (waiting.length) return no(WRITE_COPY.waiting);
    // A student's move into or out of the family that hasn't reached QuickBooks (slice 9f): QuickBooks is never asked to
    // make a student inactive under a family the portal has moved them out of.
    if (await familyMovePending(tx, ownRecord, familyQboId)) return no(MOVE_PENDING);
    // A guardian's Parent customer change for this family waiting or stuck (stage 3's slice 9h): a create names no target
    // customer, so it is found by the family it is filed under.
    if (await guardianItemsWaiting(tx, ownRecord)) return no(GUARDIAN_PENDING);
    const roleOf = (qboId: string): FamilyStep["write"]["role"] => {
      const r = roleIn(roster, qboId);
      return r && r.familyQboId === familyQboId && (r.role === "student" || r.role === "parent") ? r.role : "other";
    };
    // No page's version: each step is sent with its own link's, or the version its live read shows (FamilyStep).
    const writes: FamilyStep["write"][] = [
      ...under.map((u) => ({ op: "deactivate" as const, role: roleOf(u.qboId), qboId: u.qboId, syncToken: "" })),
      { op: "deactivate", role: "family", qboId: familyQboId, syncToken: "" },
    ];
    // A customer under the family is filed under its student record only when that record is this family's: since
    // slice 9c a student QuickBooks moved in keeps their record in the family the app holds them in, and making this
    // family inactive leaves it alone (changeOwnRecord() changes only the record a step is filed under). Such a step
    // carries its student link's own version (slice 9g); any other, none.
    const steps: FamilyStep[] = [];
    for (const [i, write] of writes.entries()) {
      const filed = await recordsOf(tx, write, familyQboId);
      if (write.role === "student" || write.role === "other") {
        const studentId = await studentLinkedTo(write.qboId, tx);
        const [s] = studentId === null ? [] : await tx.select({ familyId: student.familyId }).from(student).where(eq(student.id, studentId));
        const theirs = s === undefined || s.familyId === null ? null : String(s.familyId);
        filed.studentId = studentId !== null && theirs === String(ownRecord) ? studentId : null;
        if (filed.studentId !== null) {
          const [link] = await tx.select({ syncedToken: accountingLink.syncedToken }).from(accountingLink)
            .where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, source), eq(accountingLink.customerId, write.qboId), isNotNull(accountingLink.studentId)));
          write.syncToken = link?.syncedToken ?? "";
        }
      }
      steps.push({ write, name: i < under.length ? under[i]!.name : customer.displayName, filed });
    }
    return { ok: true, realmId: source, familyQboId, familyName: customer.displayName, steps };
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
async function stepStopped(code: string, step: FamilyStep, realmId: string, o: WriteOp & { staffUserId: string }): Promise<{ words: string; maybe: boolean; changed: boolean }> {
  const e = { code };
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
      // Only a second stale answer comes here (slice 9g): the first is settled by a live read and one resend with the
      // version it showed (sendDeactivate()), so this is a change made while the action ran.
      await readAgain(step.write.qboId, realmId, o);
      return { words: isFamily ? `${name} changed in QuickBooks while this was running, so it wasn't made inactive. Press “Make ${name} inactive” again.`
        : `${name} changed in QuickBooks twice while this was running, so it wasn't changed. Reload the page to see it as QuickBooks has it now.`, maybe: false, changed: true };
    case "retry":
      if (failure.sent) {
        await db.transaction(async (tx) => {
          await askForRosterRefresh(tx);
          await holdForTheQueue(tx, step.write, e.code, { realmId, actor: o.actor, ip: o.ip, permission: o.permission, linkedBy: o.staffUserId, filed: step.filed });
        });
        return { words: `The portal can't tell whether QuickBooks made ${name} inactive: its answer didn't arrive. The roster is read again within a few minutes to see, and the portal finishes it then without sending it twice.`, maybe: true, changed: true };
      }
      return { words: `QuickBooks couldn't take that just now, so ${name} wasn't changed. Try again in a few minutes.`, maybe: false, changed: false };
    case "not_connected": case "needs_admin": case "other_company": return { words: connectionWordsOf(failure.kind, name), maybe: false, changed: false };
    default:
      return { words: e.code === "bad_id" ? `${name} couldn't be sent to QuickBooks, so it wasn't changed.` : `QuickBooks wouldn't make ${name} inactive, so it wasn't changed. Check it in QuickBooks.`, maybe: false, changed: false };
  }
}

/** What the family action answers: the result to show, and whether anything may have changed (the pages are then made again). */
export type FamilyInactiveAnswer = { result: WriteResult; changed: boolean };

/**
 * Makes a linked family inactive in QuickBooks, with every active customer under it, as staff confirmed on the family's
 * page: `rawFamilyId` is the family record's app id the page sent (a uuid), and `stamp` seals whom the page covered
 * (coverStamp()); no id or version from the browser is trusted. In this order:
 *   1. prepareFamily(): every check one write gets, for the family and everyone under it, under the roster lock, the
 *      family's customer found through its own link (an unlinked family is made inactive in the portal only);
 *   2. each of them read live from QuickBooks, by the one balance rule (balanceStops(), stage 3's slice 9g): when any of
 *      them has any balance, owed or a credit, nothing is sent and no record follows, and staff are told who (with the
 *      amount only for Finance.Balance.Read) and that it must be settled first; a balance that can't be read stops it
 *      too. The same read passes over anyone it shows already inactive, whose app record is made inactive then
 *      (recordFollows()); when that is the family itself, nothing is sent for anyone, and once everyone it covers is
 *      inactive there, making the records match is the whole of the action (a family made inactive in QuickBooks);
 *   3. each made inactive, deepest first and the family last, each through sendWrite() and applyWritten(): QuickBooks
 *      first, then the cache and the app's own record from its answer under the roster lock, with its audit row. Each
 *      step carries its own link's version (a student of this family's record), or, for a customer with no family or
 *      student link of its own, the version its read in step 2 showed (`checked`); a stale answer is settled by the
 *      Active flag (sendDeactivate(): inactive there, passed over and its record follows; still active, the balance rule
 *      again, then sent once more with the version just read). The family's own last step is read once more after its
 *      members' writes, by the balance rule, and sent with the version just read, since QuickBooks may raise it when a
 *      customer under it changes: the write sets only the inactive flag, and the window is the seconds of the action
 *      itself, so nothing anyone changed is overwritten.
 * The first step that doesn't go through stops it: staff are told who was made inactive, who wasn't and why, and that
 * the family is still active. Nothing of it is queued, but for a step whose answer was lost: that one is held on the
 * queue as possibly made (stepStopped()), so its app record follows once the queue finds it. One audit row
 * (roster.family.deactivate) says how it went.
 */
export async function askFamilyInactive(rawFamilyId: string, stamp: string, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<FamilyInactiveAnswer> {
  if (!isUuid(rawFamilyId)) return { result: refuse(WRITE_COPY.gone), changed: false };
  const familyId = asAppFamilyId(rawFamilyId.toLowerCase());
  // The family's "being sent" lock, held from before the checks to the last step's answer (slice 9f): a student's move
  // into or out of the family tries it shared under the roster lock (moveHolding()) and is refused while it is held, so
  // no move is saved in the portal while QuickBooks is being asked to make the family's students inactive, and a step
  // never makes inactive a student the portal has just moved to another family. Held by someone else (a rename of the
  // family on its way, or a second press of this, say), nothing is checked or sent.
  return (await whileSending(String(familyId), () => familyInactiveHolding(familyId, stamp, rosterTag, o))) ?? { result: refuse(FAMILY_BEING_CHANGED), changed: false };
}

async function familyInactiveHolding(familyId: AppFamilyId, stamp: string, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<FamilyInactiveAnswer> {
  const p = await prepareFamily(familyId, stamp, rosterTag);
  if (!p.ok) return { result: p.result, changed: false };
  const familyQboId = p.familyQboId;
  const summary = (outcome: "done" | "stopped" | "refused", code: string | null, made: string[], notMade: string[], more: { maybe?: string[]; alreadyInactive?: string[] } = {}) =>
    writeAudit({ actor: o.actor, action: "roster.family.deactivate", permission: o.permission, ip: o.ip, targetType: "qbo_customer", targetId: familyQboId,
      after: { outcome, ...(code ? { code: code.slice(0, 40) } : {}), made, notMade, ...(more.maybe?.length ? { maybe: more.maybe } : {}), ...(more.alreadyInactive?.length ? { alreadyInactive: more.alreadyInactive } : {}) } });
  const ids = p.steps.map((s) => s.write.qboId);
  const how: DeactivateHow = { mayWait: false, name: p.familyName, showAmounts: o.showAmounts === true, actor: o.actor, ip: o.ip, permission: o.permission };

  // 2. Each read before anything is sent: what it owes, whether it is active there, and its version, by the one
  // balance rule (balanceStops()): any balance, owed or a credit, stops it, and so does one that can't be read.
  const owing: BalanceStop[] = [], already = new Set<string>(), reads = new Map<string, Extract<Owed, { ok: true }>>();
  for (const step of p.steps) {
    const owed = await owedBy(step.write.qboId, p.realmId);
    if (!owed.ok) {
      await summary("refused", owed.code, [], ids);
      return { result: refuse(unreadWords(owed.code)), changed: false };
    }
    if (!owed.active) { already.add(step.write.qboId); continue; }
    reads.set(step.write.qboId, owed);
    const stop = balanceStops(owed, step.name, o.showAmounts === true);
    if (stop) owing.push(stop);
  }
  const alreadyInactive = [...already];
  if (already.size) await db.transaction((tx) => askForRosterRefresh(tx)); // the cache is behind QuickBooks: read it again
  // Nothing at all is done while anyone has a balance: no write, and no record made to follow.
  if (owing.length) {
    await summary("refused", owing.some((s) => s.code === "open_balance") ? "open_balance" : CREDIT_BALANCE, [], ids, { alreadyInactive });
    return { result: { ok: false, errors: [...owing.map((s) => s.who), `Nobody was made inactive. ${WRITE_COPY.balanceFix}`] }, changed: already.size > 0 };
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
  // Someone a stale answer's live read shows inactive there meanwhile: passed over, their record made to follow.
  const followedLate: FamilyStep[] = [];
  // Of those, the ones whose own record the portal made inactive with them (a Parent customer has none), and whether
  // the family's own record followed, when it was the family QuickBooks had made inactive meanwhile.
  const recordsFollowed: FamilyStep[] = [];
  let familyFollowed = false;
  let allShown = true;
  // Whoever a stale answer's read showed inactive meanwhile, said in both answers: nothing more was sent for them.
  const lateWords = (): string[] => {
    const late = followedLate.filter((s) => s.write.role !== "family");
    if (!late.length) return [];
    return [`QuickBooks had ${listed(late.map((s) => s.name))} made inactive meanwhile, so nothing more was sent for them.${recordsFollowed.length
      ? ` The portal's own ${recordsFollowed.length > 1 ? "records" : "record"} of ${listed(recordsFollowed.map((s) => s.name))} ${recordsFollowed.length > 1 ? "are" : "is"} inactive now too.` : ""}`];
  };
  const stop = async (i: number, code: string, why: { words: string; maybe: boolean; changed: boolean }) => {
    const step = steps[i]!;
    const after = steps.slice(i + 1).filter((s) => s.write.role !== "family").map((s) => s.name);
    await summary("stopped", code, made.map((s) => s.write.qboId), steps.slice(why.maybe ? i + 1 : i).map((s) => s.write.qboId),
      { maybe: why.maybe ? [step.write.qboId] : [], alreadyInactive });
    const errors = [
      made.length ? `Made inactive in QuickBooks: ${listed(made.map((s) => s.name))}.` : "Nobody was made inactive.",
      ...lateWords(),
      why.words,
      ...(after.length ? [`Not made inactive yet: ${listed(after)}.`] : []),
      step.write.role === "family" && why.maybe ? `Whether ${p.familyName} is still active shows once the roster is read again.`
        : why.maybe ? `${p.familyName} is still active. Once the change waiting for ${step.name} has gone through (the Reconciliation page lists it until then), press “Make ${p.familyName} inactive” again to carry on with whoever is still active.`
        : `${p.familyName} is still active. Press “Make ${p.familyName} inactive” again to carry on with whoever is still active.`,
    ];
    return { result: { ok: false as const, errors }, changed: made.length > 0 || followedLate.length > 0 || why.changed || already.size > 0 };
  };
  for (const [i, step] of steps.entries()) {
    let read = reads.get(step.write.qboId)!;
    if (step.write.role === "family" && made.length + followedLate.length > 0) {
      // Read once more: QuickBooks may have raised the family's version when the customers under it changed. The
      // balance rule again, on this read (a balance may have appeared meanwhile).
      const fresh = await owedBy(familyQboId, p.realmId);
      if (!fresh.ok) {
        return stop(i, fresh.code, { words: `${p.familyName} couldn't be read from QuickBooks again before it was made inactive, so it wasn't changed.${classify(fresh.code).kind === "retry" ? " Try again in a few minutes." : ""}`, maybe: false, changed: false });
      }
      if (!fresh.active) {
        // Made inactive in QuickBooks meanwhile: the read is stored and the roster read again, as for anyone the first
        // reads showed inactive, and the portal's family follows.
        await storeReadAgain(fresh.answer, p.realmId, o);
        await db.transaction((tx) => askForRosterRefresh(tx));
        familyFollowed = (await recordFollows(step.write, step.filed, p.realmId, "already_inactive", o)) !== null;
        followedLate.push(step);
        continue;
      }
      const balance = balanceStops(fresh, p.familyName, o.showAmounts === true);
      if (balance) return stop(i, balance.code, { words: `${balance.who} It wasn't made inactive. ${WRITE_COPY.balanceFix}`, maybe: false, changed: false });
      read = fresh;
    }
    // The family's own step is sent with the version just read (not `checked`: the link is aligned only when that is its own).
    const write = step.write.role === "family" ? { ...step.write, syncToken: read.syncToken ?? "" } : step.write;
    const t = await sendDeactivate(write, read, p.realmId, { ...how, name: step.name });
    switch (t.is) {
      case "answer": {
        const { cached } = await applyWritten(t.write, t.answer, { realmId: p.realmId, actor: o.actor, ip: o.ip, permission: o.permission, linkedBy: o.staffUserId, filed: step.filed,
          ...(t.resent ? { auditExtra: { resent: "stale" } } : {}) });
        if (!cached) allShown = false;
        made.push(step);
        break;
      }
      case "inactive_there": {
        // A stale answer's live read shows it inactive there: nothing more is sent (the read is stored already), the
        // roster is read again, and its record follows.
        await db.transaction((tx) => askForRosterRefresh(tx));
        const change = await recordFollows(step.write, step.filed, p.realmId, "already_inactive", o);
        if (step.write.role === "family") familyFollowed = change !== null;
        else if (change) recordsFollowed.push(step);
        followedLate.push(step);
        break;
      }
      case "stopped":
        // Said of this step alone: whoever was made inactive before it was (the lead's decision 1 for slice 9g's review).
        return stop(i, t.stop.code, { words: t.stop.alone, maybe: false, changed: true });
      case "stale_again":
        return stop(i, "fault_5010", await stepStopped("fault_5010", { ...step, write: t.write }, p.realmId, o));
      case "failed":
        return stop(i, t.code, await stepStopped(t.code, { ...step, write: t.write }, p.realmId, o));
    }
  }
  await summary("done", null, made.map((s) => s.write.qboId), [], { alreadyInactive: [...alreadyInactive, ...followedLate.map((s) => s.write.qboId)] });
  const under = made.filter((s) => s.write.role !== "family").map((s) => s.name);
  const familyMade = made.some((s) => s.write.role === "family");
  const said = !familyMade ? `${under.length ? `Made inactive in QuickBooks: ${listed(under)}. ` : ""}${p.familyName} is inactive in QuickBooks now, so nothing more was sent for it.${familyFollowed ? " The portal's own family is inactive now too." : ""}`
    : under.length ? `Made inactive in QuickBooks: ${listed(under)}, then ${p.familyName}.` : `Made ${p.familyName} inactive in QuickBooks.`;
  const message = [said, ...lateWords()].join(" ");
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
/**
 * A family unlinked from a customer the books still hold (stage 4's slice M3b2: endedLinksHeld(),
 * src/lib/accounting/ended-links.ts): its customer isn't made again, as that would be a second customer for the same
 * household. `offered`: Accounting links can offer the customer for it (it is among the customers no family is linked
 * to, noFamilyPool()), so it is linked there again; otherwise that page can't until it is sorted out in QuickBooks.
 * Never a name to rename it to. QuickBooks text, as text.
 */
export const ENDED_HELD = (name: string, customer: string, offered: boolean) =>
  `${name} was linked to “${customer}” in QuickBooks until it was unlinked, and “${customer}” is still there, so making it again would make a second customer for the same household. Nothing was made.${offered
    ? " To link the two again, someone who may link families to accounting does it on the Accounting links page: with Confirm on its row, or with Pick a different customer once the row offers it (a Suggested row offers it once it is left unlinked)."
    : ` The Accounting links page can't offer “${customer}” for it until it is sorted out in QuickBooks, where it may be inactive, under another customer or of another type; once it is, someone who may link families to accounting links the two there.`}`;
/**
 * A student left out of "Create in QuickBooks and link" (slice M3b2): linked to a customer the books still hold until
 * the family they were in was unlinked (this family, or one they have since been moved out of), so a second customer isn't made for the same child, wherever the books hold the first (the
 * lead's decision 4). `underFamily`: that customer is an active student customer directly under the family's customer,
 * which Accounting links shows among the family's differences as a student in the books only (differencesOf()).
 */
export const STUDENT_HELD = (who: string, customer: string, underFamily: boolean) =>
  `${who} isn't made in QuickBooks: they were linked to “${customer}” there until the family they were in was unlinked, and “${customer}” is still there with no record linked to it, so a second customer isn't made for the same child. Accounting links shows ${who} among the family's differences as a student in the portal only${underFamily ? `, and “${customer}” as a student in the books only` : ""}.`;

/**
 * The refusal of a create of this family's own customer while the customer of its ended link is still in the books
 * (endedLinksHeld()), in the caller's transaction under the roster lock; null when there is none, and the family is made
 * as any family with no link. Whether Accounting links can offer the customer is the pool's own rule, as unlinkFamily()
 * works it out for its answer: no family link names it (the read's own condition), so the links given are none.
 */
async function endedHeldRefusal(tx: Tx, familyId: AppFamilyId, name: string, shape: MembershipShape, cache: Cust[]): Promise<string | null> {
  const held = (await endedLinksHeld({ families: [familyId] }, tx)).families.get(familyId);
  if (!held) return null;
  return ENDED_HELD(name, held.customerName, await poolOffers(tx, shape, cache, held.customerId));
}
/** Whether Accounting links can offer this customer for a family: it is among the customers no family is linked to (noFamilyPool()). */
async function poolOffers(tx: Tx, shape: MembershipShape, cache: Cust[], customerId: string): Promise<boolean> {
  return noFamilyPool(buildRoster(shape, cache), cache, await familyCreatesOnTheQueue(tx), { familyLinked: new Set(), studentLinked: new Set() })
    .some((c) => c.qboId === customerId);
}
/**
 * For a family's page (slice M3b2): whether Accounting links can offer the customer of the family's ended link that
 * endedLinksHeld() answered, by the same rule as the refusal (ENDED_HELD()'s `offered`), from the shape and the cache as
 * they are now. Three queries (the shape, the cache, the family creates on the queue); false with no shape.
 */
export async function heldCustomerOffered(customerId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const shape = await getShape(tx);
    return shape !== null && poolOffers(tx, shape, await cacheRows(tx), customerId);
  });
}
/** A family whose own create is waiting or stuck: nothing else is changed on it until it goes through or is given up. */
export const FAMILY_WAITING = "Making this family in QuickBooks is still waiting on the queue, so nothing else can be changed on it for now. Once it has gone through, or been given up on the Reconciliation page, try again.";
/** A family a create of which is being sent to QuickBooks at this moment (whileMaking()): nothing else is changed on it until the answer is in. */
export const FAMILY_SENDING = "This family is being made in QuickBooks at this moment, so nothing else can be changed on it. Try again in a minute.";
const STUDENT_WAITING = "Making this student in QuickBooks is still waiting on the queue, so nothing else can be changed for them for now. Once it has gone through, or been given up on the Reconciliation page, try again.";
const LINKED_HERE = "That is linked to QuickBooks, so it is changed there first: use the QuickBooks changes on this page.";
const GIVEN_UP_MAYBE_MADE = "Making this in QuickBooks was given up on the Reconciliation page after a try QuickBooks may have taken. Once the roster has been read again (within a few minutes), the Reconciliation page says whether QuickBooks made it; if it didn't, press “Create in QuickBooks and link” again.";
/** A family's create given up after QuickBooks made its customer (madeAfterGivingUp()): no second customer is made for it. */
const madeAfterGivingUpWords = (name: string, noun: string) =>
  `QuickBooks made the customer “${name}” for this ${noun} before making it was given up on the Reconciliation page, and no ${noun} in the portal is linked to it, so a second one wasn't made. If it is this ${noun}, pick it for this ${noun} on the Accounting links page, which links the two (someone who may link families to accounting can; where that page suggests another customer for this ${noun}, they leave it unlinked there first, as only then is a different customer picked for it). If it isn't, make it inactive in QuickBooks, then press “Create in QuickBooks and link” again.`;
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
  if (r.ok && r.message !== WRITE_COPY.doneNotShown) {
    // Taken in at once: linked, unless another family was linked to the new customer while the answer was on its way.
    const customer = await customerMadeFor(name);
    const elsewhere = customer === null ? null : await linkedElsewhereWords(saved.familyId, customer, name);
    if (elsewhere) return { ok: true, unlinked: true, status: "attention", message: `${name} is saved in the portal. ${elsewhere}` };
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
   whatever is still unlinked. It sends nothing for a guardian: a guardian's Parent customer is made when the guardian
   is added, or a closed row reinstated (queueForGuardian(), stage 3's slice 9h). */

type CreateWrite = Extract<RosterWrite, { op: "create" }>;
type LinkPlan = {
  ok: true; realmId: string; familyId: AppFamilyId; familyName: string; familyWrite: CreateWrite | null; familyCustomer: string | null;
  students: { id: AppStudentId; name: string | null }[]; studentTypeId: string | null;
  /** The names a new customer must not be (namesTaken(), read under the lock): each student's is held against them before it is sent. */
  taken: string[];
  /** A sentence for each active student with no link left out as its customer from before an unlink is still in the books (STUDENT_HELD()). */
  leftOut: string[];
} | { ok: false; result: WriteResult };

/**
 * Everything checked before anything is sent, under the roster lock with the page's tag: QuickBooks connected to the
 * roster's company, the shape holding, the family record active, nothing of its own waiting on the queue, no create of
 * its own given up that QuickBooks made a customer for (madeAfterGivingUp(): a second would be made), and a create
 * given up after a try QuickBooks may have taken only once a roster read has run since. With no family link: a name
 * QuickBooks can take (checkName()) and doesn't hold already (namesTaken(), "Name (2)" offered for the family's page),
 * and the type (the shape's family type, or the member type chosen, by typeForNew()). With one: its customer an active
 * family on the roster. Then, only where the shape has a student type, the family's active students with no link and
 * no create of their own waiting, by name as rosterFamilies() orders them, then by id. Since stage 4's slice M3b2,
 * nothing is made whose customer from before an unlink is still in the books (endedLinksHeld()): a family with no link
 * whose ended link's customer the cache holds, with no other family linked to it, is refused before anything else
 * (ENDED_HELD()), and such a student is left out of the creates and said (STUDENT_HELD()), wherever the books have it.
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
      // Unlinked from a customer the books still hold (slice M3b2): not made again, and its students are never reached.
      const ended = await endedHeldRefusal(tx, f.id, recordNameWords(f.name, "family"), shape, cache);
      if (ended !== null) return no(ended);
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
        .where(and(eq(writeQueue.targetQboId, familyCustomer), inArray(writeQueue.state, ["waiting", "stuck"]), blocksOthers)).limit(1);
      if (waiting.length) return no(WRITE_COPY.waiting);
    }
    let students: { id: AppStudentId; name: string | null }[] = [];
    const leftOut: { name: string | null; words: string }[] = [];
    if (shape.kind === "layered" && shape.studentTypeId !== null) {
      const studentType = shape.studentTypeId;
      const rows = await tx.select({ id: student.id, name: student.name }).from(student).where(and(eq(student.familyId, f.id), eq(student.active, true)));
      const links = await linksOf({ families: [], students: rows.map((r) => r.id) }, tx);
      // Those with no link whose ended link's customer the books still hold (slice M3b2), read once for them all.
      const held = (await endedLinksHeld({ students: rows.filter((r) => !links.customerOfStudent.has(r.id)).map((r) => r.id) }, tx)).students;
      for (const r of rows) {
        // A student whose given-up create QuickBooks made, or may have made, is not made again (the Reconciliation page lists those it made).
        if (links.customerOfStudent.has(r.id) || (await studentCreateWaiting(tx, r.id)) || (await givenUpMaybeMade(tx, { studentId: r.id }))
          || (await madeAfterGivingUp(tx, { studentId: r.id })).length > 0) continue;
        // Nor one whose customer from before an unlink is still in the books, wherever the books have it (the
        // lead's decision 4): one child is one customer. It is said, by name; nothing links it here.
        const was = held.get(r.id);
        if (was) {
          const underFamily = familyCustomer !== null && was.parentQboId === familyCustomer && was.typeQboId === studentType && was.active;
          leftOut.push({ name: r.name, words: STUDENT_HELD(recordNameWords(r.name, "student"), was.customerName, underFamily) });
          continue;
        }
        students.push(r);
      }
      students = students.sort((a, b) => COLLATOR.compare(a.name ?? "", b.name ?? "") || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    }
    const leftWords = leftOut.sort((a, b) => COLLATOR.compare(a.name ?? "", b.name ?? "")).map((l) => l.words);
    if (familyWrite === null && students.length === 0) {
      if (leftWords.length === 0) return no("Everything in this family that can be made in QuickBooks is linked already, waiting to be, or was made there after making it was given up (the Reconciliation page lists those), so nothing was made.");
      return { ok: false, result: { ok: false, errors: ["Everything in this family that can be made in QuickBooks is linked already, waiting to be, was made there after making it was given up (the Reconciliation page lists those), or is still in the books from before an unlink, so nothing was made.", ...leftWords] } };
    }
    return { ok: true, realmId: source, familyId: f.id, familyName: recordNameWords(f.name, "family"), familyWrite, familyCustomer, students,
      studentTypeId: shape.kind === "layered" ? shape.studentTypeId : null, taken, leftOut: leftWords };
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

/** The customer of that name in the cache: QuickBooks takes a name once, so it is the one a create's answer was taken in as. */
async function customerMadeFor(name: string): Promise<string | null> {
  const rows = await db.select({ qboId: qboCustomer.qboId, displayName: qboCustomer.displayName }).from(qboCustomer);
  return rows.find((r) => nameKey(r.displayName) === nameKey(name))?.qboId ?? null;
}

/**
 * Whether a family's create, taken in at once, left the family linked to the customer QuickBooks made for it. While the
 * create is on its way the customer has no link, so a roster read can put it among the customers with no family and staff
 * can link another family to it (the accounting links screen's Confirm, or "Create a family from this"); changeOwnRecord()
 * then links nothing. Answered as the words that say so, naming the family linked to it, or null while the family's own
 * link to that customer stands.
 */
async function linkedElsewhereWords(familyId: AppFamilyId, customerQboId: string, said: string): Promise<string | null> {
  if ((await customerOfFamily(familyId)) === customerQboId) return null;
  const other = await familyLinkedTo(customerQboId);
  const [f] = other === null ? [] : await db.select({ name: family.name }).from(family).where(eq(family.id, other));
  const whose = f ? `another family in the portal, ${recordNameWords(f.name, "family")}, was linked to it while its answer was on its way` : "the portal couldn't link the two";
  return `QuickBooks made a customer for ${said}, but ${whose}, so ${said} was left unlinked and nothing more was made for it in QuickBooks. Check in QuickBooks which household that customer is before anything else is made for ${said}.`;
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
  /** `elsewhere`: the family's customer was made, but another family was linked to it first, so pressing again would only make a second. */
  const stop = async (at: Step, from: number, code: string, words: string, maybe: boolean, elsewhere = false): Promise<LinkAnswer> => {
    // The one stopped at may have been made (`maybe`): it is in neither list, the audit row's nor the words'.
    const later = p.students.slice(from).filter((s) => !(maybe && at.kind === "student" && String(s.id) === at.id));
    const notMade = [...(at.kind === "family" && !maybe && !elsewhere ? [String(p.familyId)] : []), ...later.map((s) => String(s.id))];
    await summary("stopped", { ...at, code, maybe }, notMade);
    const notYet = later.map(studentWords);
    return { changed: made.length > 0 || maybe || elsewhere, result: { ok: false, errors: [
      made.length ? `Made in QuickBooks and linked: ${listed(made.map((m) => m.name))}.` : elsewhere ? "Nothing was linked." : "Nothing was made in QuickBooks.",
      words,
      ...(notYet.length ? [`Not made in QuickBooks yet: ${listed(notYet)}.`] : []),
      // The students left out (slice M3b2), once the family has its customer: a stop at the family's own step reached none.
      ...(at.kind === "student" ? p.leftOut : []),
      ...(elsewhere ? [] : [maybe ? "Once the roster has been read again, press “Create in QuickBooks and link” again to carry on with whatever is still unlinked."
        : "Press “Create in QuickBooks and link” again to carry on with whatever is still unlinked."]),
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
    // Its students go under that customer only while the family's own link to it stands: another family may have been
    // linked to it while the answer was on its way, and changeOwnRecord() then linked nothing.
    const elsewhere = await linkedElsewhereWords(p.familyId, sent.customerQboId, p.familyName);
    if (elsewhere) return stop(at, 0, "customer_has_family", elsewhere, false, true);
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
  return { changed: true, result: { ok: true, message: [`Made in QuickBooks and linked: ${listed(made.map((m) => m.name))}.`, ...p.leftOut].join(" ") } };
}

/* ---- An unlinked family's own changes, saved in the portal only (stage 3's slice 9d; spec section 5: "A change to an
   unlinked family stays in the app"; "An unlinked family has no balance to check") ---- */

/**
 * What staff change on a family with no link, or on a student with no link of their own (one a stopped "Create in
 * QuickBooks and link" left in a linked family), as the page sent it: the app's ids, each a uuid. Moving a student, linked
 * or not, into any of the portal's families, linked or not, is moveStudent()'s (slice 9f).
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
      if (await familyMovePending(tx, f.id, null)) return refuse(MOVE_PENDING);
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
   "Send the portal's value" and "Give up"; the portal's value is never undone. A move of a student is saved in the
   portal first the same way since slice 9f (moveStudent(), below). Making anyone inactive keeps slice 9c's order,
   QuickBooks first, under the balance rule and with the link's own version since slice 9g (deactivateLinked(), above). */

type RenameWrite = Extract<RosterWrite, { op: "rename" }>;
type MoveWrite = Extract<RosterWrite, { op: "move" }>;
type QueueRow = typeof writeQueue.$inferSelect;

/** First key of the lock held while a change to one record is being sent; the second is a hash of the record's id. */
export const SENDING_LOCK = 7461012;
/**
 * A student whose "being sent" lock (whileSending()) someone holds at this moment: a move of theirs being saved and sent
 * (linked or not), or a rename of theirs being sent. Said as a change, never as a send, since a move of a student with no
 * link sends nothing.
 */
export const STUDENT_BEING_CHANGED = "This student is being changed at this moment, so nothing else can be changed for them. Try again in a minute.";
/**
 * A family or member whose "being sent" lock someone holds at this moment, or holds shared: its rename being sent, its
 * make-inactive under way, or a student's move into or out of it being saved (moveStudent(), which holds it shared).
 */
export const FAMILY_BEING_CHANGED = "This family is being changed at this moment, so nothing else can be changed on it. Try again in a minute.";
/** A guardian whose "being sent" lock someone holds (a change to their Parent customer being sent: stage 3's slice 9h): nothing else is changed for them meanwhile. */
export const GUARDIAN_BEING_CHANGED = "A change to this guardian's Parent customer is being sent to QuickBooks at this moment, so nothing else can be changed for them. Try again in a minute.";
/** "Try again now" on a change saved first that is being sent at this moment (at once, by "Send the portal's value", or by the worker): nothing is done. */
export const BEING_SENT_NOW = "This change is being sent to QuickBooks at this moment, so it isn't tried again now. Reload the page in a minute to see how it went.";
const NOT_LINKED = "That isn't linked to QuickBooks, so a change to it is saved in the portal only: reload the page and use “Change in the portal”.";
const NOT_AS_SHOWN = "That didn't go through. Reload the page and try again.";
const NO_LONGER_REFUSED = "That is no longer kept: it was sent, given up, or replaced by a later change. Reload the page.";
const RECORD_MOVED_ON = "The portal's own record changed since this was kept (renamed, moved, made inactive or unlinked), so nothing was sent. Reload the page.";
const STUDENT_RENAMED = "The student was renamed in the portal since this page was shown, so nothing was sent. Reload the page to see the name that would be sent.";
const CREATE_FAMILY_FIRST = "The family the student was moved to has no customer in QuickBooks yet, so there is nowhere to put them there and nothing was sent. Create the family in QuickBooks first, with “Create in QuickBooks and link” on its page, then send the move here.";
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
/** The code of a rename or move the portal held back because QuickBooks' live read showed the customer inactive. */
export const INACTIVE_THERE_CODE = "inactive_there";
/**
 * The code of a move whose cache showed the student under another customer than its before-value (the family the
 * portal and QuickBooks last agreed on), or that carries no before-value, and whose live read found it so (slice 9f).
 */
export const PLACE_DIFFERS = "place_differs";
/**
 * A move's before-value for a student QuickBooks has at the top of its tree, under no customer: set by "Send the
 * portal's value" when the row showed them so, and compared with a live parent of none. Not digits, so it is never
 * taken for a customer, never sent and never matched against one.
 */
export const TOP_OF_TREE = "top";
/** The customer a move's before-value names, or null for none (empty) and for the top of the tree. */
const beforeCustomer = (w: MoveWrite): string | null => (w.fromFamilyQboId === "" || w.fromFamilyQboId === TOP_OF_TREE ? null : w.fromFamilyQboId);
/** The code of a linked student's move into a family with no customer in QuickBooks: saved, kept, nothing sent (slice 9f). */
export const NO_FAMILY_CUSTOMER = "no_family_customer";
/** The code of a guardian's Parent customer create kept at once: the person's address is longer than QuickBooks takes. */
export const EMAIL_TOO_LONG = "email_too_long";
/**
 * The code a guardian's Parent customer make-inactive is kept under when its balance couldn't be read (stage 3's slice
 * 9h): nothing was sent, so it is the portal's holding back, never QuickBooks' refusal. The read's own code follows it
 * (`balance_unread:no_balance`, `balance_unread:token_busy` and the like).
 */
export const BALANCE_UNREAD = "balance_unread";
const unreadKept = (code: string) => `${BALANCE_UNREAD}:${code}`;
/** Whether a kept code is a balance that couldn't be read (BALANCE_UNREAD). */
export const balanceUnread = (code: string | null) => code !== null && code.startsWith(BALANCE_UNREAD);
/** How long a change saved first is the at-once try's before the worker may take it: longer than one try takes. */
/**
 * How long a change saved first is held for the try its saver makes at once after the commit, before the worker may
 * take it (queueSaved(), and a staff member's change of a guardian's details since stage 3's slice 11c: QueueAs).
 */
export const SAVED_LEASE_MS = 60_000;
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
 * `refused`: a rename of a family, member or student (a parent's keeps its page's version and today's rules), a
 * student's create filed under the student record, or, since slice 9f, a move of a student record (moveStudent(); a
 * move queued before it was cleared by migration 0042), and, since slice 11b, a parent's phone and mailing address
 * (`contact`: a person's details or a family's, queued by src/lib/parents/contact-queue.ts), and, since slice S11e, a
 * person's sign-in email (`email`, queued by the same module in the confirm's transaction).
 */
export const isSavedFirst = (item: Pick<QueueRow, "request" | "studentId">) => {
  const w = item.request;
  return (w.op === "rename" && w.role !== "parent") || (((w.op === "create" && w.role === "student") || w.op === "move") && item.studentId !== null) || guardianOf(w) !== null
    || w.op === "contact" || w.op === "email";
};
/**
 * The guardian row a queue item makes or changes the Parent customer of (stage 3's slice 9h: a parent's create, rename
 * or make-inactive saved with the guardian's change), or null: an item queued before that slice names none.
 */
export const guardianOf = (w: QueueRow["request"]): string | null =>
  (w.op === "create" || w.op === "rename" || w.op === "deactivate" || w.op === "contact" || w.op === "email") && w.role === "parent" && typeof w.guardianId === "string" ? w.guardianId : null;

/**
 * The lock a change saved first is sent under, by whoever sends it (the staff member at once, "Send the portal's
 * value", or the queue's worker): a rename or a move, its record's "being sent" lock (the student's, else the
 * family's); a student's create, the family's "being made" lock; a guardian's item (stage 3's slice 9h), the guardian
 * row's own "being sent" lock, whatever it is. None for an item filed under no record.
 */
function lockOfItem(item: Pick<QueueRow, "request" | "familyId" | "studentId">): { making: AppFamilyId } | { sending: string } | null {
  const guardianId = guardianOf(item.request);
  if (guardianId !== null) return { sending: guardianId };
  if (item.request.op === "create") return item.familyId === null ? null : { making: item.familyId };
  const id = item.studentId ?? item.familyId;
  return id === null ? null : { sending: String(id) };
}

/** whileItemHeld()'s answer for a guardian's Parent customer create whose family is being changed in QuickBooks at that moment: nothing was done. */
export const FAMILY_HELD = "family_held" as const;
/**
 * Runs `send` holding the lock a change saved first is sent under (lockOfItem()): null, sending nothing, while someone
 * else holds it. A guardian's Parent customer create also takes its family's "being sent" lock, shared, on the same
 * connection, tried and never waited for (the lead's decision 2 in slice 9h's last round): while the family action
 * holds it, nothing is done and the answer is FAMILY_HELD, so nothing is made under a family being made inactive.
 */
export async function whileItemHeld<T>(item: Pick<QueueRow, "request" | "familyId" | "studentId">, send: () => Promise<T>): Promise<T | null | typeof FAMILY_HELD> {
  const lock = lockOfItem(item);
  if (lock === null) return send();
  const guardianId = guardianOf(item.request);
  if (guardianId !== null) {
    const familyId = item.request.op === "create" ? item.familyId : null;
    return whileGuardiansHeld([guardianId], async (hold) => (familyId !== null && !(await familySendingFree(hold, familyId)) ? FAMILY_HELD : send()));
  }
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
 * One send of a move of a linked student (stage 3's slice 9f), by the rule tryRename() follows, with the parent
 * QuickBooks has the student under in place of the name: sent with the version it carries (the student link's own),
 * unless it carries none or no before-value, or the caller already knows the parent differs (`readFirst`). On
 * QuickBooks' stale answer (5010), and in those cases, the customer is read live (stored in the cache when newer) and
 * its parent compared with `fromFamilyQboId`, the family the portal and QuickBooks last agreed on: under the family
 * joined already, nothing is sent (`in_place`); inactive there, nothing is sent (`changed`, `inactive_there`); under the
 * before-value, sent once more with the version just read (`checked`); under anything else, or with no before-value,
 * nothing more is sent (`changed`, kept by the caller, `holds` the customer QuickBooks has them under). A second stale
 * answer is `stale_again`. Never more than one resend.
 */
type MoveTry =
  | { is: "answer"; write: MoveWrite; answer: Record<string, unknown>; resent: "stale" | "no_version" | "differs" | null }
  | { is: "in_place" }
  | { is: "failed"; code: string; sent: boolean; write: MoveWrite }
  | { is: "changed"; code: string; holds: string | null }
  | { is: "stale_again" };
async function tryMove(w: MoveWrite, realmId: string, o: { mayWait: boolean; readFirst: "moved_on" | "differs" | null; actor: Actor; ip: string | null; permission?: string }): Promise<MoveTry> {
  let why: "stale" | "no_version" | "differs" | "moved_on";
  if (o.readFirst) why = o.readFirst;
  else if (w.syncToken === "") why = "no_version";
  else if (w.fromFamilyQboId === "") why = "differs";
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
  // The field is the arbiter: the parent QuickBooks has the student under now, against the family the portal and
  // QuickBooks last agreed on (never the portal's new family, never the cache).
  const live = await readLive(w.qboId, realmId, o.mayWait);
  if (!live.ok) return { is: "failed", code: live.code, sent: false, write: w };
  await storeReadAgain(live.answer, realmId, o);
  const parent = parentOf(live.answer);
  if (parent !== null && parent === w.toFamilyQboId) return { is: "in_place" };
  if (!live.active) return { is: "changed", holds: parent, code: INACTIVE_THERE_CODE };
  if (w.fromFamilyQboId === "" || (parent ?? TOP_OF_TREE) !== w.fromFamilyQboId) {
    return { is: "changed", holds: parent, code: why === "stale" ? "fault_5010" : why === "no_version" ? NO_LINK_VERSION : why === "differs" ? PLACE_DIFFERS : "moved_on" };
  }
  const again: MoveWrite = { ...w, syncToken: live.syncToken, checked: true };
  try {
    return { is: "answer", write: again, answer: await sendWrite(again, realmId, { mayWait: o.mayWait }), resent: why === "moved_on" ? "stale" : why };
  } catch (e) {
    if (!(e instanceof QboError)) throw e;
    const failure = classify(e.code);
    if (failure.kind === "stale") return { is: "stale_again" };
    return { is: "failed", code: e.code, sent: failure.kind === "retry" && failure.sent, write: again };
  }
}
/** The customer a customer answer names as its parent: null for one at the top of the tree. */
const parentOf = (c: Record<string, unknown>): string | null => (isRow(c.ParentRef) && typeof c.ParentRef.value === "string" ? c.ParentRef.value : null);

/* ---- A parent's phone and mailing address sent on (stage 3's slice 11b; app-owned families spec section 5, open
   questions 6 and 10, Appendix B) ----
   A parent saves their phone and address in the portal (src/lib/parents/contact-edits.ts), and that save's transaction
   queues, through the parent-facing src/lib/parents/contact-queue.ts, one change saved first for each record it goes to:
   the own Parent customer of each of the person's open memberships, or, in books with no parent type, the family's own
   linked customer. Nothing a parent does waits on QuickBooks or on a lock a sender holds: the queue's worker sends each
   at its next wake, through trySavedItem(), under the item's lock. Nothing QuickBooks holds that the portal didn't know
   is overwritten unseen: the cache is compared before each send, and a stale answer settled by the fields, against the
   before-values the item carries (`was`, `orWas`), in the one normal form (detailKey()). */

type ContactWrite = Extract<RosterWrite, { op: "contact" }>;
type EmailWrite = Extract<RosterWrite, { op: "email" }>;
/** A change of a guardian's own details sent on to a record of theirs: a phone and mailing address, or a sign-in email (slice S11e). */
type DetailsWrite = ContactWrite | EmailWrite;
/** The code of a contact change the portal held back because QuickBooks holds other details than the ones it last knew of (slice 11b). */
export const CONTACT_DIFFERS = "contact_differs";
/** What a customer QuickBooks just answered with holds of its phone and address, as the cache would keep them. */
const heldInAnswer = (c: Record<string, unknown>): HeldContact => {
  const phone = isRow(c.PrimaryPhone) && typeof c.PrimaryPhone.FreeFormNumber === "string" ? c.PrimaryPhone.FreeFormNumber : "";
  return { phone, address: billingAddressOf(c) };
};
/** The keys of the fields a contact change sends, as `held` holds them: one for the phone, one for the address, null for one it doesn't send. */
const contactKeys = (held: HeldContact, w: Pick<ContactWrite, "change">) =>
  [w.change.phone !== undefined ? detailKey(held.phone) : undefined, w.change.address !== undefined ? detailKey(held.address) : undefined];
/**
 * The details a refused contact change's compare view shows QuickBooks holding, sealed by "Send the portal's value"
 * (portalValueStamp()): a digest, never the values themselves, keyed with the server's secret as portalValueStamp() is,
 * so a guessed phone or address can't be tested against it in the browser.
 */
export function contactShown(held: HeldContact, w: Pick<ContactWrite, "change">): string {
  return contactShownUnder(env.BETTER_AUTH_SECRET, held, w);
}
/** contactShown() under a key given: the server's secret in the portal, another only in a test that it is keyed. */
export function contactShownUnder(key: string, held: HeldContact, w: Pick<ContactWrite, "change">): string {
  return createHmac("sha256", key).update(`contact-shown:${JSON.stringify(contactKeys(held, w))}`).digest("base64url").slice(0, 22);
}

/**
 * One send of a parent's phone and address (stage 3's slice 11b), by the rule tryRename() follows, with the fields in
 * place of the name: sent with the version it carries (the link's own), unless it carries none or the caller already
 * knows QuickBooks holds other details (`readFirst`: the cache shows a field that is neither the new value, nor its
 * before-value, nor an earlier change's, or the queue's look found the record moved on). On QuickBooks' stale answer
 * (5010), and in those cases, the customer is read live (stored in the cache when newer) and compared field by field
 * (contactStands()): holding the change already, nothing is sent (`in_place`); inactive there, nothing is sent
 * (`changed`, `inactive_there`); as the portal last knew it, sent once more with the version just read (`checked`);
 * anything else, nothing is sent (`changed`, CONTACT_DIFFERS): nothing is overwritten. A second stale answer is
 * `stale_again`. Never more than one resend.
 */
type ContactTry =
  | { is: "answer"; write: ContactWrite; answer: Record<string, unknown>; resent: "stale" | "no_version" | "differs" | null }
  | { is: "in_place" }
  | { is: "failed"; code: string; sent: boolean; write: ContactWrite }
  | { is: "changed"; code: string }
  | { is: "stale_again" };
async function tryContact(w: ContactWrite, realmId: string, o: { mayWait: boolean; readFirst: "moved_on" | "differs" | null; actor: Actor; ip: string | null; permission?: string }): Promise<ContactTry> {
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
  // The fields are the arbiter: what QuickBooks holds now, against what the portal last knew it held (never the cache).
  const live = await readLive(w.qboId, realmId, o.mayWait);
  if (!live.ok) return { is: "failed", code: live.code, sent: false, write: w };
  await storeReadAgain(live.answer, realmId, o);
  // A field QuickBooks holds empty is the portal's to fill only where the portal knew it empty (`was` or `orWas`):
  // otherwise someone may have cleared it there, and it is a difference like any other.
  const stands = contactStands(heldInAnswer(live.answer), w);
  if (stands === "in_place") return { is: "in_place" };
  if (!live.active) return { is: "changed", code: INACTIVE_THERE_CODE };
  if (stands === "differs") return { is: "changed", code: CONTACT_DIFFERS };
  const again: ContactWrite = { ...w, syncToken: live.syncToken, checked: true };
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
 * What a kept or waiting contact change says while the portal may not send it yet (contactSendsMayGo()): the row, a
 * press of "Send the portal's value" and "Try again now" all say it, and nothing is sent.
 */
export const CONTACT_AWAITS_READ = "The portal is still waiting for its read of the phones and mailing addresses QuickBooks holds (the first since this version was installed, or since the membership shape was last saved), so nothing is sent for this yet. It goes once that read is done, usually within a few minutes.";
/** What "Send the portal's value" says when a parent saved their details again meanwhile (trySavedItem()'s `superseded`). */
export const CONTACT_SUPERSEDED_AT_PRESS = "Nothing was sent from this row: the parent saved their details again meanwhile, and that newer change, which carries everything this one did, has taken its place. The worker sends it on, and this page lists it if it doesn't go through.";
/** The code a press keeps for it, which is never stored: the press puts the item back as it was kept. */
const CONTACT_AWAITS_READ_CODE = "awaits_read";
/**
 * The roster lock taken shared in the caller's transaction, waited for at most `waitMs` when it is given (a staff
 * member's at-once try of a contact change, sendContactSaved(): past that the transaction fails with Postgres'
 * lock_not_available, which trySavedItem() answers as RosterBusyAtTry), and for as long as it takes otherwise.
 */
async function rosterSharedIn(tx: Tx, waitMs?: number): Promise<void> {
  if (waitMs === undefined) { await tx.execute(sql`select pg_advisory_xact_lock_shared(${ROSTER_LOCK})`); return; }
  await tx.execute(sql.raw(`set local lock_timeout = '${Math.max(1, Math.floor(waitMs))}ms'`));
  await tx.execute(sql`select pg_advisory_xact_lock_shared(${ROSTER_LOCK})`);
  await tx.execute(sql.raw("set local lock_timeout to default"));
}
/** Postgres could not take a lock within its wait (lock_not_available). Drizzle wraps the driver's error, so its cause is read too. */
function lockTimedOut(e: unknown): boolean {
  const code = (v: unknown) => (typeof v === "object" && v !== null ? (v as { code?: unknown }).code : undefined);
  return (code(e) ?? code((e as { cause?: unknown } | null)?.cause)) === "55P03";
}
/**
 * A contact try made with a wait for the roster lock (trySavedItem()'s `rosterWaitMs`) found it held past that wait at
 * one of its own looks: nothing was sent and the item is as it was before the try (its mark as maybe sent taken back).
 */
export class RosterBusyAtTry extends Error {
  constructor() { super("roster_busy"); this.name = "RosterBusyAtTry"; }
}
/** contactSendsSince() under the roster lock held shared, in a transaction of its own: null while nothing may go. */
export const contactReadStands = (waitMs?: number) => db.transaction(async (tx) => {
  await rosterSharedIn(tx, waitMs);
  return contactSendsSince(tx);
});
/** Why a contact change is given up at its try with nothing sent (contactStops()). */
type ContactStop = "guardian_removed" | "not_own" | "family_off" | "family_inactive" | "not_the_family" | "books_changed" | "superseded";
const CONTACT_STOP_NOTES: Record<ContactStop, string> = {
  guardian_removed: "The guardian was removed in the portal, or their family made inactive, before it was sent.",
  not_own: "That Parent customer is no longer the guardian's own record in QuickBooks (moved, retyped, shared or unlinked), so nothing was sent to it.",
  family_off: "The guardian's family is no longer linked to a customer in QuickBooks, or QuickBooks has that customer inactive, so nothing was sent to the guardian's record under it.",
  family_inactive: "The family was made inactive in the portal before it was sent.",
  not_the_family: "That customer is no longer the family's own active record in QuickBooks, so nothing was sent to it.",
  books_changed: "The club's books no longer keep these details there (the membership shape changed, or QuickBooks isn't connected to the roster's company), so nothing was sent.",
  superseded: "The portal's details changed again after this was saved, so this older change was not sent.",
};
/**
 * Why "Send the portal's value" can't go through for a kept contact change, by contactStopsIn()'s answer, in words
 * that say whose record changed (QueueView.notOffered, and the press's answer): the portal's (`record_gone`), QuickBooks'
 * (`not_own`; for a guardian's, the family's own customer, `family_off`), or the club's books (`books_changed`).
 */
export type ContactNotOffered = "record_gone" | "not_own" | "family_off" | "books_changed" | "awaits_read";
export const contactNotOffered = (stop: Exclude<ContactStop, "superseded">): ContactNotOffered =>
  stop === "guardian_removed" || stop === "family_inactive" ? "record_gone" : stop === "books_changed" ? "books_changed" : stop === "family_off" ? "family_off" : "not_own";
export const CONTACT_NOT_OFFERED: Record<ContactNotOffered, string> = {
  record_gone: "The guardian was removed, or the family made inactive, in the portal since this was kept, so the portal's details aren't sent: give it up here.",
  not_own: "QuickBooks no longer has this customer as the guardian's or the family's own record (it was moved, retyped, shared or unlinked), so the portal's details aren't sent to it: give it up here. The portal keeps its details.",
  family_off: "The guardian's family in the portal is no longer linked to a customer in QuickBooks, or QuickBooks has that family's customer inactive, so nothing is sent to the guardian's record under it: give it up here. The portal keeps its details.",
  books_changed: "The club's books don't keep these details on this record just now (the membership shape changed, or QuickBooks isn't connected to the roster's company), so the portal's details can't be sent. Once QuickBooks is connected again and the shape keeps them there, they can be sent from here; or give it up. The portal keeps its details.",
  // The take-in, or a read under the shape saved last, still to come (contactSendsMayGo()).
  awaits_read: CONTACT_AWAITS_READ,
};
/**
 * Whether a contact change must not be sent now, checked at every try under the roster lock shared, whoever makes it:
 * for a person's details, the membership still open in an active family record, and the customer still the row's own
 * Parent customer (ownParentCustomer()'s rule); for a family's, the family record active, the customer still its own
 * linked customer of the family's type (a member's in flat books), and whoseDetails() still the family's; for both,
 * QuickBooks connected to the roster's company and the shape holding. A customer QuickBooks has inactive is no stop:
 * the try reads it live and keeps the change (INACTIVE_THERE_CODE). And, at every try, "Send the portal's value"'s
 * included (on purpose: a newer change carries every field this one does, so nothing is lost by it), the details the
 * change carries still the portal's (`superseded` otherwise): an older change, one that may have been sent while a
 * later one was saved, or one pressed while a parent saved again, never lands after the later one, even once that later
 * one is given up. Null when it may go.
 */
async function contactStops(w: ContactWrite, item: QueueRow, waitMs?: number): Promise<ContactStop | "await_read" | null> {
  return db.transaction(async (tx) => {
    await rosterSharedIn(tx, waitMs);
    if (!(await contactSendsMayGo(tx))) return "await_read";
    const stop = await contactStopsIn(tx, w, item);
    if (stop !== null) return stop;
    const now = await portalDetailsFor(tx, w, item);
    if (now === null) return w.role === "parent" ? "guardian_removed" : "family_inactive";
    return (["phone", "address"] as const).some((f) => w.change[f] !== undefined && detailKey(now[f]) !== detailKey(w.change[f])) ? "superseded" : null;
  });
}
/**
 * The same checks for a page that lists kept contact changes (loadOpenWrites()), with no lock: whether "Send the
 * portal's value" is offered, as contactStopsIn() would answer the press now, for every item at once, from facts read
 * once in one transaction (contactFacts()), never a transaction or a read of the roster cache per row. The press checks
 * it all again. contactStopNow() is the same for one item.
 */
export async function contactStopsNow(items: readonly { id: string; w: ContactWrite; familyId: AppFamilyId | null }[]): Promise<Map<string, ContactNotOffered | null>> {
  if (!items.length) return new Map();
  const facts = await db.transaction((tx) => contactFacts(tx, items));
  return new Map(items.map((i) => { const stop = contactStopFrom(facts, i.w, i); return [i.id, stop === null ? null : contactNotOffered(stop)] as const; }));
}
export async function contactStopNow(w: ContactWrite, item: Pick<QueueRow, "familyId">): Promise<ContactNotOffered | null> {
  const stop = await db.transaction((tx) => contactStopsIn(tx, w, item));
  return stop === null ? null : contactNotOffered(stop);
}
/** contactStops()'s checks of the record, in the caller's transaction, which holds the roster lock. */
async function contactStopsIn(tx: Tx, w: ContactWrite, item: Pick<QueueRow, "familyId">): Promise<Exclude<ContactStop, "superseded"> | null> {
  return contactStopFrom(await contactFacts(tx, [{ w, familyId: item.familyId }]), w, item);
}
/**
 * What contactStopsIn() goes by, read in one transaction for any number of contact items: the shape, whether QuickBooks
 * is connected to the roster's company and the shape's types are all there, the items' guardian rows and family records,
 * the family and guardian links in the records' company, the open guardian rows linked to each customer, and the cache
 * rows of those customers only. A constant number of statements, however many items.
 */
type ContactFacts = {
  shape: MembershipShape | null; connected: boolean; typesHold: boolean;
  /** Each guardian row named, with its person's sign-in address now (an email change's `superseded`, slice S11e). */
  guardians: Map<string, { status: string; familyId: AppFamilyId | null; email: string }>;
  familyActive: Map<string, boolean>;
  familyCustomer: Map<string, string>;
  guardianCustomer: Map<string, string>;
  openRowsOf: Map<string, string[]>;
  cache: Map<string, { typeQboId: string | null; parentQboId: string | null; active: boolean }>;
};
async function contactFacts(tx: Tx, items: readonly { w: DetailsWrite; familyId: AppFamilyId | null }[]): Promise<ContactFacts> {
  const [shape, source, conn, types, realm] = await Promise.all([getShape(tx), getRosterSource(tx), getConnection(tx), tx.select().from(qboCustomerType), recordsCompany(tx)]);
  const connected = !!conn?.realmId && !!conn.refreshTokenCiphertext && source !== null && source === conn.realmId;
  const typesHold = shape !== null && missingTypes(shape, types.map((t) => ({ qboId: t.qboId, name: t.name, active: t.active }))).length === 0;
  const guardianIds = [...new Set(items.flatMap((i) => (i.w.guardianId ? [i.w.guardianId] : [])))];
  const rows = guardianIds.length ? await tx.select({ id: guardian.id, status: guardian.status, familyId: guardian.familyId, email: parent.email }).from(guardian)
    .innerJoin(parent, eq(parent.id, guardian.parentId)).where(inArray(guardian.id, guardianIds)) : [];
  const familyIds = [...new Set([...items.flatMap((i) => (i.familyId === null ? [] : [i.familyId])), ...rows.flatMap((r) => (r.familyId === null ? [] : [r.familyId]))])];
  const [families, links] = await Promise.all([
    familyIds.length ? tx.select({ id: family.id, active: family.active }).from(family).where(inArray(family.id, familyIds)) : Promise.resolve([]),
    linksOf({ families: familyIds, students: [] }, tx)]);
  const guardianLinks = realm !== null && guardianIds.length ? await tx.select({ guardianId: accountingLink.guardianId, customerId: accountingLink.customerId }).from(accountingLink)
    .where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realm), inArray(accountingLink.guardianId, guardianIds))) : [];
  const guardianCustomer = new Map(guardianLinks.flatMap((l) => (l.guardianId === null ? [] : [[l.guardianId, l.customerId] as const])));
  const familyCustomer = new Map([...links.customerOfFamily].map(([f, c]) => [String(f), c] as const));
  const customers = [...new Set([...guardianCustomer.values(), ...familyCustomer.values(), ...items.map((i) => i.w.qboId)])];
  const [openRowsOf, cached] = await Promise.all([openGuardiansOf(tx, source, customers),
    customers.length ? tx.select({ qboId: qboCustomer.qboId, typeQboId: qboCustomer.typeQboId, parentQboId: qboCustomer.parentQboId, active: qboCustomer.active }).from(qboCustomer)
      .where(inArray(qboCustomer.qboId, customers)) : Promise.resolve([])]);
  return { shape, connected, typesHold, guardians: new Map(rows.map((r) => [r.id, { status: r.status, familyId: r.familyId, email: r.email }])),
    familyActive: new Map(families.map((f) => [String(f.id), f.active])), familyCustomer, guardianCustomer, openRowsOf, cache: new Map(cached.map((c) => [c.qboId, c])) };
}
/**
 * contactStopsIn()'s rule, pure, over the facts read for it: for a person's details, the membership still open in the
 * active family record the item is filed under; then the books (layered, with a parent type), the connection and the
 * shape's types; then the family's own customer, linked and active in the cache (`family_off` otherwise: the family's,
 * not the guardian's); then the customer still the row's own Parent customer (ownParentCustomer()'s rule: of the parent
 * type, directly under the family's customer, no other open row linked to it). For a family's, the record active, the
 * books keeping the family's details there, and the customer still its own linked customer of the family's type (a
 * member's in flat books), at the top of the tree.
 */
function contactStopFrom(f: ContactFacts, w: DetailsWrite, item: { familyId: AppFamilyId | null }): Exclude<ContactStop, "superseded"> | null {
  const shape = f.shape;
  if (w.role === "parent") {
    if (!w.guardianId) return "not_own";
    const row = f.guardians.get(w.guardianId);
    if (!row || row.status === "disabled" || row.familyId === null || item.familyId === null || String(row.familyId) !== String(item.familyId)) return "guardian_removed";
    if (f.familyActive.get(String(row.familyId)) !== true) return "guardian_removed";
    if (!shape || shape.kind !== "layered" || shape.parentTypeId === null || !offers(shape, "add_parent")) return "books_changed";
    if (!f.connected || !f.typesHold) return "books_changed";
    const familyCustomer = f.familyCustomer.get(String(row.familyId));
    if (familyCustomer === undefined || f.cache.get(familyCustomer)?.active !== true) return "family_off";
    const customer = f.guardianCustomer.get(w.guardianId);
    if (customer === undefined || customer !== w.qboId) return "not_own";
    const c = f.cache.get(customer);
    if (!c || c.typeQboId !== shape.parentTypeId || c.parentQboId !== familyCustomer || (f.openRowsOf.get(customer) ?? []).some((g) => g !== w.guardianId)) return "not_own";
    return null;
  }
  const familyId = item.familyId;
  if (familyId === null) return "not_the_family";
  if (f.familyActive.get(String(familyId)) !== true) return "family_inactive";
  if (!shape || whoseDetails(shape) !== "family" || !f.connected || !f.typesHold) return "books_changed";
  if ((shape.kind === "flat" ? "member" : "family") !== w.role) return "books_changed";
  if (f.familyCustomer.get(String(familyId)) !== w.qboId) return "not_the_family";
  const c = f.cache.get(w.qboId);
  const ofType = shape.kind === "flat" ? c?.typeQboId !== null && c?.typeQboId !== undefined && shape.memberTypeIds.includes(c.typeQboId) : c?.typeQboId === shape.familyTypeId;
  return c && ofType && c.parentQboId === null ? null : "not_the_family";
}
/** The portal's own details now, for the fields a contact change sends: the person's (by the membership's person), or the family's. Null when the row is gone. */
async function portalDetailsFor(tx: Tx, w: ContactWrite, item: Pick<QueueRow, "familyId">): Promise<ContactWrite["change"] | null> {
  const cols = (t: typeof parent | typeof family) => ({ phone: t.phone, addressLine1: t.addressLine1, addressLine2: t.addressLine2, addressCity: t.addressCity,
    addressRegion: t.addressRegion, addressPostalCode: t.addressPostalCode, addressCountry: t.addressCountry });
  let row: Parameters<typeof heldInCache>[0] | undefined;
  if (w.role === "parent") {
    if (!w.guardianId) return null;
    [row] = await tx.select(cols(parent)).from(guardian).innerJoin(parent, eq(parent.id, guardian.parentId)).where(eq(guardian.id, w.guardianId));
  } else if (item.familyId !== null) [row] = await tx.select(cols(family)).from(family).where(eq(family.id, item.familyId));
  if (!row) return null;
  const now = heldInCache(row);
  return { ...(w.change.phone !== undefined ? { phone: now.phone } : {}), ...(w.change.address !== undefined ? { address: now.address } : {}) };
}
/**
 * A contact change given up with nothing sent (contactStops()), or a change of sign-in email (emailStops(), slice
 * S11e, with a note of its own): audited, only while it is still waiting.
 */
async function giveUpContact(item: QueueRow, why: ContactStop, sentBefore: boolean, o: { actor: Actor; ip: string | null; permission?: string }): Promise<void> {
  const op = item.request.op === "email" ? "email" : "contact";
  await db.transaction(async (tx) => {
    // Its mark as maybe sent is taken back with it, to what it was before this try (a press's own copy says sent): this
    // try sent nothing.
    const [still] = await tx.update(writeQueue).set({ state: "given_up", sent: sentBefore, note: op === "email" ? EMAIL_STOP_NOTES[why] : CONTACT_STOP_NOTES[why], nextTryAt: null,
      finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(writeQueue.id, item.id), eq(writeQueue.state, "waiting"))).returning({ id: writeQueue.id });
    if (!still) return;
    await writeAudit({ actor: o.actor, action: "roster.write.given_up", permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: item.id,
      before: { state: item.state, tries: item.tries, code: item.lastCode, op }, after: { state: "given_up", why, sentNow: false } }, tx);
  });
}

/** A change of the same op, customer and membership (or family: no membership) as this one, by the item's request. */
const sameContactRecord = (w: DetailsWrite) => and(eq(writeQueue.targetQboId, w.qboId), sql`${writeQueue.request}->>'op' = ${w.op}`,
  w.guardianId ? sql`${writeQueue.request}->>'guardianId' = ${w.guardianId}` : sql`${writeQueue.request}->>'guardianId' is null`);
/**
 * Once a contact change is done or kept, every earlier contact change of the same customer and membership still open
 * (waiting, stuck or kept) is closed as replaced, audited (`roster.write.replaced`), in the caller's transaction: an
 * earlier value never lands after a later one, and one kept never waits beside a later one. Only one whose every field
 * this change sends is closed: a later change carries every field of the earlier ones open when it was saved
 * (queueContactChange()), so this is that rule held where it is relied on, and an earlier change of a field this one
 * doesn't send is left to finish. The caller holds the item's lock, so none of them is being sent meanwhile. So, since
 * slice S11e, for a change of sign-in email: once one is done or kept, every earlier one of the same customer and
 * membership still open is closed the same way, so an older address never lands after a newer one.
 */
export async function closeEarlierContacts(tx: Tx, item: Pick<QueueRow, "id" | "request" | "createdAt">, o: { actor: Actor; ip: string | null; permission?: string }): Promise<void> {
  const w = item.request;
  if (w.op !== "contact" && w.op !== "email") return;
  const earlier = await tx.select({ id: writeQueue.id, request: writeQueue.request }).from(writeQueue)
    .where(and(sameContactRecord(w), inArray(writeQueue.state, ["waiting", "stuck", "refused"]), ne(writeQueue.id, item.id), sql`${writeQueue.createdAt} < ${item.createdAt.toISOString()}::timestamptz`));
  const covered = earlier.filter((r) => (w.op === "email" ? r.request.op === "email"
    : r.request.op === "contact" && (["phone", "address"] as const).every((f) => (r.request as ContactWrite).change[f] === undefined || w.change[f] !== undefined)));
  if (!covered.length) return;
  const rows = await tx.update(writeQueue).set({ state: "given_up", note: CONTACT_REPLACED_NOTE, nextTryAt: null, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(inArray(writeQueue.id, covered.map((r) => r.id)), inArray(writeQueue.state, ["waiting", "stuck", "refused"])))
    .returning({ id: writeQueue.id, state: writeQueue.state, lastCode: writeQueue.lastCode });
  for (const r of rows) {
    await writeAudit({ actor: o.actor, action: "roster.write.replaced", permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: r.id,
      before: { code: r.lastCode }, after: { state: "given_up", replacedBy: { op: w.op, queueId: item.id } } }, tx);
  }
}

/* ---- A person's sign-in email sent on (stage 3's slice S11e; app-owned families spec sections 5 and 6, open questions
   7 and 10, Appendix B) ----
   A parent's confirmed change of sign-in email is the portal's own (slice 11d), and that confirm's transaction queues,
   through the parent-facing src/lib/parents/contact-queue.ts, one change saved first for each record of theirs it goes
   to: the own Parent customer of each of their open memberships, or, in books with no parent type, each membership's
   family's own linked customer. Nothing the parent does waits on QuickBooks or on a lock a sender holds: the queue's
   worker sends each at its next wake, through trySavedItem(), under the item's lock. There is no take-in's gate: the
   email field has been kept by every roster read since v1, and a field is never sent unless it was just read live.
   Nothing QuickBooks holds that the portal didn't know is overwritten: the field read live is settled by what it holds
   (the new address there: done; the old one, or an earlier change's that may have been sent, there by the record's
   rule: replaced, every other address left as it was; neither: kept), and a field over 100 characters is never sent. */

/** The code of a change of sign-in email the portal held back: QuickBooks' email field holds neither the address the portal last knew for the person there nor the new one. */
export const EMAIL_DIFFERS = "email_differs";
/** The code of one held back because QuickBooks' email field holds the new address already, beside the one it was to replace. */
export const EMAIL_ALREADY_THERE = "email_already_there";
/** What a customer QuickBooks just answered with holds in its email field, as QuickBooks holds it (null for none). */
const fieldInAnswer = (c: Record<string, unknown>): string | null => (isRow(c.PrimaryEmailAddr) && typeof c.PrimaryEmailAddr.Address === "string" ? c.PrimaryEmailAddr.Address : null);
/**
 * The email field a kept change of sign-in email's compare view shows QuickBooks holding, sealed by "Send the portal's
 * value" (portalValueStamp()): a digest of its addresses as the portal reads them (parseEmailField(): trimmed,
 * lower-cased, so the cache's copy and a live read of one field agree), keyed with the server's secret, so a guessed
 * address can't be tested against it in the browser.
 */
export function emailShown(field: string | null): string {
  return emailShownUnder(env.BETTER_AUTH_SECRET, field);
}
/** emailShown() under a key given: the server's secret in the portal, another only in a test that it is keyed. */
export function emailShownUnder(key: string, field: string | null): string {
  return createHmac("sha256", key).update(`email-shown:${JSON.stringify(parseEmailField(field))}`).digest("base64url").slice(0, 22);
}

/**
 * The addresses a change of sign-in email would replace (emailBefores()) that a person other than the membership's
 * signs in with now (`parent.email`, which the sign-in account's mirrors). Since slice 11d an address a person gives up
 * is free for another person, a guardian of the same family included, and in a field guardians share (a family's, in
 * books with no parent type, or a flat member's) it is then theirs: such an address is never replaced (the lead's
 * decision 2 for slice S11e: another person's address is never touched), so a change that finds only it there is kept
 * as a difference. Read just before each decision that could send.
 */
async function othersSignInWith(w: EmailWrite): Promise<Set<string>> {
  const befores = emailBefores(w);
  if (!befores.length) return new Set();
  const [row] = w.guardianId ? await db.select({ parentId: guardian.parentId }).from(guardian).where(eq(guardian.id, w.guardianId)) : [];
  const others = await db.select({ email: parent.email }).from(parent)
    .where(and(inArray(parent.email, befores), row ? ne(parent.id, row.parentId) : undefined));
  return new Set(others.map((p) => p.email.trim().toLowerCase()));
}

/**
 * One send of a person's sign-in email (stage 3's slice S11e), by the rule tryContact() follows, with the field in
 * place of the details. The field sent is always made from one read live (stored in the cache when newer): the cache
 * keeps a field trimmed and lower-cased, and the other addresses in it are sent exactly as QuickBooks holds them. Read
 * by the record's rule (emailStands()): holding the change already, nothing is sent (`in_place`); inactive there,
 * nothing is sent (`changed`, INACTIVE_THERE_CODE); holding `from` (or an `orFrom` address), that one replaced by `to`
 * and sent with the version just read (`checked`); the result over 100 characters, or holding `to` beside it, nothing
 * is sent (EMAIL_TOO_LONG, EMAIL_ALREADY_THERE); anything else, nothing is sent (EMAIL_DIFFERS): nothing is overwritten.
 * On a stale answer (5010) the field is read once more, by the same rule, and sent once more; a second stale answer is
 * `stale_again`. `preset`: "Send the portal's value", which sends the field its press made from a read of its own,
 * with the version that read showed, once.
 */
type EmailTry =
  | { is: "answer"; write: EmailWrite; answer: Record<string, unknown>; resent: "stale" | "no_version" | "differs" | null }
  | { is: "in_place" }
  | { is: "failed"; code: string; sent: boolean; write: EmailWrite }
  | { is: "changed"; code: string }
  | { is: "stale_again" };
async function tryEmail(w: EmailWrite, realmId: string, o: { mayWait: boolean; preset?: string; actor: Actor; ip: string | null; permission?: string }): Promise<EmailTry> {
  const send = async (sent: EmailWrite, field: string): Promise<{ answer: Record<string, unknown> } | { stale: true } | { failed: EmailTry }> => {
    try {
      return { answer: await sendWrite(sent, realmId, { mayWait: o.mayWait, field }) };
    } catch (e) {
      if (!(e instanceof QboError)) throw e;
      const failure = classify(e.code);
      if (failure.kind === "stale") return { stale: true };
      return { failed: { is: "failed", code: e.code, sent: failure.kind === "retry" && failure.sent, write: sent } };
    }
  };
  if (o.preset !== undefined) {
    const r = await send(w, o.preset);
    return "answer" in r ? { is: "answer", write: w, answer: r.answer, resent: null } : "stale" in r ? { is: "stale_again" } : r.failed;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const live = await readLive(w.qboId, realmId, o.mayWait);
    if (!live.ok) return { is: "failed", code: live.code, sent: false, write: w };
    await storeReadAgain(live.answer, realmId, o);
    const field = fieldInAnswer(live.answer);
    const taken = await othersSignInWith(w);
    const stands = emailStands(field, w, taken);
    if (stands.is === "in_place") return { is: "in_place" };
    if (!live.active) return { is: "changed", code: INACTIVE_THERE_CODE };
    if (stands.is === "differs") return { is: "changed", code: EMAIL_DIFFERS };
    // Only the address the portal knew there is replaced, wherever it stands; another person's is never touched.
    const next = replaceAddressInField(field, stands.held, w.to);
    if (!next.ok) return { is: "changed", code: next.reason === "too_long" ? EMAIL_TOO_LONG : next.reason === "already_there" ? EMAIL_ALREADY_THERE : EMAIL_DIFFERS };
    const sent: EmailWrite = { ...w, syncToken: live.syncToken, checked: true };
    const r = await send(sent, next.field);
    if ("answer" in r) return { is: "answer", write: sent, answer: r.answer, resent: attempt > 0 ? "stale" : w.syncToken === "" ? "no_version" : live.syncToken !== w.syncToken ? "differs" : null };
    if ("failed" in r) return r.failed;
  }
  return { is: "stale_again" };
}

/** The notes a change of sign-in email is given up with when its record is no longer the one it is for, or its address no longer the person's (emailStops()). */
const EMAIL_STOP_NOTES: Record<ContactStop, string> = {
  guardian_removed: "The guardian was removed in the portal, or their family made inactive, before it was sent.",
  not_own: "That Parent customer is no longer the guardian's own record in QuickBooks (moved, retyped, shared or unlinked), so the new sign-in email wasn't sent to it.",
  family_off: "The guardian's family is no longer linked to a customer in QuickBooks, or QuickBooks has that customer inactive, so nothing was sent to the guardian's record under it.",
  family_inactive: "The family was made inactive in the portal before it was sent.",
  not_the_family: "That customer is no longer the family's own active record in QuickBooks, so the new sign-in email wasn't sent to it.",
  books_changed: "The club's books no longer keep this sign-in email on that record (the membership shape changed, or QuickBooks isn't connected to the roster's company), so nothing was sent.",
  superseded: "The person changed their sign-in email again after this was saved, so this older address was not sent.",
};
/**
 * Whether a change of sign-in email must not be sent now, checked at every try under the roster lock shared, whoever
 * makes it (the lead's decision 4 for slice S11e): the membership still open in the active family record the item is
 * filed under; for a person's Parent customer, the customer still the row's own (contactStopFrom()'s rule); for a
 * family's or member's, the family record active, whoseDetails() still the family's and the customer still its own
 * linked customer of its type at the top of the tree; QuickBooks connected to the roster's company and the shape
 * holding; and, at every try, "Send the portal's value"'s included, `to` still the person's sign-in address now
 * (`superseded` otherwise), so an older address never lands after a newer one. There is no take-in's gate for it.
 */
async function emailStops(w: EmailWrite, item: QueueRow, waitMs?: number): Promise<ContactStop | null> {
  return db.transaction(async (tx) => {
    await rosterSharedIn(tx, waitMs);
    return emailStopsIn(tx, w, item);
  });
}
/** emailStops()'s checks, in the caller's transaction, which holds the roster lock (or, for a list, none). */
async function emailStopsIn(tx: Tx, w: EmailWrite, item: Pick<QueueRow, "familyId">): Promise<ContactStop | null> {
  return emailStopFrom(await contactFacts(tx, [{ w, familyId: item.familyId }]), w, item);
}
/** emailStopsIn()'s rule, pure, over the facts read for it (contactFacts()). */
function emailStopFrom(f: ContactFacts, w: EmailWrite, item: { familyId: AppFamilyId | null }): ContactStop | null {
  const row = w.guardianId ? f.guardians.get(w.guardianId) : undefined;
  if (!row || row.status === "disabled" || row.familyId === null || item.familyId === null || String(row.familyId) !== String(item.familyId)) return "guardian_removed";
  const stop = contactStopFrom(f, w, item);
  if (stop !== null) return stop;
  return row.email.trim().toLowerCase() === w.to.trim().toLowerCase() ? null : "superseded";
}
/**
 * Why "Send the portal's value" can't go through for a kept change of sign-in email, by emailStopsIn()'s answer, in
 * words that say whose record changed (QueueView.notOffered, and the press's answer).
 */
export type EmailNotOffered = "email_record_gone" | "email_not_own" | "email_family_off" | "email_books_changed" | "email_superseded";
export const emailNotOffered = (stop: ContactStop): EmailNotOffered =>
  stop === "guardian_removed" || stop === "family_inactive" ? "email_record_gone" : stop === "books_changed" ? "email_books_changed" : stop === "family_off" ? "email_family_off"
    : stop === "superseded" ? "email_superseded" : "email_not_own";
export const EMAIL_NOT_OFFERED: Record<EmailNotOffered, string> = {
  email_record_gone: "The guardian was removed, or the family made inactive, in the portal since this was kept, so the new sign-in email isn't sent: give it up here.",
  email_not_own: "QuickBooks no longer has this customer as the guardian's or the family's own record (it was moved, retyped, shared or unlinked), so the new sign-in email isn't sent to it: give it up here. The person keeps their sign-in email in the portal.",
  email_family_off: "The guardian's family in the portal is no longer linked to a customer in QuickBooks, or QuickBooks has that family's customer inactive, so nothing is sent to the guardian's record under it: give it up here. The person keeps their sign-in email in the portal.",
  email_books_changed: "The club's books don't keep this sign-in email on this record just now (the membership shape changed, or QuickBooks isn't connected to the roster's company), so it can't be sent. Once QuickBooks is connected again and the shape keeps it there, it can be sent from here; or give it up. The person keeps their sign-in email in the portal.",
  email_superseded: "The person changed their sign-in email again since this was kept, so this older address isn't sent: give it up here. The newer change is sent on by itself, and this page lists it if it doesn't go through.",
};
/**
 * emailStopsIn() for a page that lists kept changes of sign-in email (loadOpenWrites()), with no lock, for every item at
 * once, from facts read once in one transaction (contactFacts()). The press checks it all again.
 */
export async function emailStopsNow(items: readonly { id: string; w: EmailWrite; familyId: AppFamilyId | null }[]): Promise<Map<string, EmailNotOffered | null>> {
  if (!items.length) return new Map();
  const facts = await db.transaction((tx) => contactFacts(tx, items));
  return new Map(items.map((i) => { const stop = emailStopFrom(facts, i.w, i); return [i.id, stop === null ? null : emailNotOffered(stop)] as const; }));
}
/** What "Send the portal's value" says when the person changed their sign-in email again meanwhile (emailStopsIn()'s `superseded`). */
export const EMAIL_SUPERSEDED_AT_PRESS = "Nothing was sent from this row: the person changed their sign-in email again meanwhile, so this older address isn't sent, and it is given up. The newer change is sent on by itself, and this page lists it if it doesn't go through.";
/**
 * Why a person's sign-in email the portal kept didn't reach QuickBooks (stage 3's slice S11e), in words, for every code
 * a kept change of sign-in email can hold, saying who stopped it: never the code itself, and never an address (the
 * Reconciliation page's compare view shows those, as text, audited).
 */
export function keptEmailWords(code: string | null): string {
  if (code === EMAIL_DIFFERS) return "The portal held it back: QuickBooks' email field for this record doesn't hold the sign-in address the portal last knew for this person where the portal reads it (the first address, on a guardian's own record or a member's), or that address is another person's sign-in now, so the new address wasn't sent over it.";
  if (code === EMAIL_TOO_LONG) return "The portal held it back: with the new address in it, this record's email field in QuickBooks would be longer than QuickBooks takes (100 characters), so nothing was sent.";
  if (code === EMAIL_ALREADY_THERE) return "The portal held it back: QuickBooks' email field for this record holds the new address already, beside the one it was to replace, so nothing was sent over it.";
  if (code === INACTIVE_THERE_CODE) return "The portal held it back: QuickBooks has this record inactive, and the portal never sends a change to it or makes it active again.";
  if (code === "fault_5010") return "The portal held it back: the record changed in QuickBooks while the new address was being sent, so nothing was overwritten.";
  if (code !== null) {
    const m = /^fault_(\d{1,6})$/.exec(code);
    if (m !== null && EMAIL_UPDATE.faults.validation.test(m[1]!)) return "QuickBooks refused it: it wouldn't take the email field with the new address in it.";
  }
  return keptRefusalWords(code, null);
}
/**
 * The field "Send the portal's value" sends for a kept change of sign-in email, from the field just read (the lead's
 * decision for slice S11e): `to` in place of `from` (or an `orFrom` address) where the field holds it, never one another
 * person signs in with now (`taken`, othersSignInWith()), which is left as it is; else, for a
 * Parent customer's own record or a member's, `to` put first, ahead of what the field holds, and for a family's record
 * in books with no parent type, `to` added at the end. Never a field over 100 characters, nor one holding `to` twice.
 */
function portalEmailField(field: string | null, w: EmailWrite, taken: ReadonlySet<string>): { ok: true; field: string } | { ok: false; error: string } {
  const tooLong = "With the new address in it, this record's email field in QuickBooks would be longer than QuickBooks takes (100 characters), so nothing was sent. The change is still kept on this page: shorten the field in QuickBooks, or give this up.";
  const held = emailBefores(w, taken).find((a) => fieldHolds(field, a));
  if (held !== undefined) {
    const next = replaceAddressInField(field, held, w.to);
    if (next.ok) return next;
    return { ok: false, error: next.reason === "too_long" ? tooLong : "QuickBooks' email field holds the new address already, beside the old one, so nothing was sent. Change it in QuickBooks, or give this up." };
  }
  if (fieldHolds(field, w.to)) return { ok: false, error: "QuickBooks' email field holds the new address already, but not where this record's sign-in is read from, so nothing was sent. Change it in QuickBooks, or give this up." };
  const kept = (field ?? "").trim();
  const made = kept === "" ? w.to : emailRuleOf(w) === "first" ? `${w.to}, ${kept}` : `${kept}, ${w.to}`;
  return made.length > EMAIL_FIELD_MAX ? { ok: false, error: tooLong } : { ok: true, field: made };
}
/**
 * Where QuickBooks has a student, in words: the portal's name of the family a customer is linked to, where it has one,
 * else the customer's name in the roster cache (QuickBooks text, shown as text). Null for none.
 */
async function placeName(customer: string | null): Promise<string | null> {
  if (customer === null) return null;
  const familyId = await familyLinkedTo(customer);
  const [f] = familyId === null ? [] : await db.select({ name: family.name }).from(family).where(eq(family.id, familyId));
  if (f?.name) return f.name;
  const [c] = await db.select({ name: qboCustomer.displayName }).from(qboCustomer).where(eq(qboCustomer.qboId, customer));
  return c?.name ?? null;
}

/**
 * Who stopped a change the portal kept (a `refused` item), by its code: QuickBooks refused it (`quickbooks`); the portal
 * held it back, as QuickBooks has another name than the one it is compared with or has the customer inactive (`held`);
 * or the portal couldn't send it, as QuickBooks wasn't connected, was another company's or needed an Admin, or the id
 * isn't one QuickBooks uses (`not_sent`).
 */
export function whoStopped(code: string | null): "quickbooks" | "held" | "not_sent" {
  if (code === "fault_5010" || code === "moved_on" || code === NO_LINK_VERSION || code === NAME_DIFFERS || code === PLACE_DIFFERS || code === NO_FAMILY_CUSTOMER
    || code === INACTIVE_THERE_CODE || code === "not_the_customer" || code === "open_balance" || code === CREDIT_BALANCE || code === EMAIL_TOO_LONG || code === NAME_UNUSABLE
    || code === CONTACT_DIFFERS || code === EMAIL_DIFFERS || code === EMAIL_ALREADY_THERE || balanceUnread(code)) return "held";
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
  // A guardian's Parent customer the portal didn't make inactive, or didn't make (stage 3's slice 9h; the owner's
  // decision of 2026-11-18 for a removal).
  if (code === "open_balance") return "The portal held it back: QuickBooks shows an amount owed on this customer, so it was left active in QuickBooks. Once it is settled there, send it again.";
  if (code === CREDIT_BALANCE) return "The portal held it back: QuickBooks shows a credit on this customer, so it was left active in QuickBooks. Once the credit is used or refunded there, send it again.";
  if (balanceUnread(code)) return "The portal held it back: it couldn't read what this customer owes in QuickBooks, and it never makes a customer inactive without knowing, so nothing was sent and it was left active in QuickBooks. Send it again to read the balance once more.";
  if (code === EMAIL_TOO_LONG) return "The portal held it back: the person's sign-in address is longer than QuickBooks takes (100 characters), so no Parent customer was made for them.";
  if (code === NAME_UNUSABLE) return "The portal held it back: the person's name can't be used in QuickBooks (it may hold a colon, a tab or a line break, or be too long), so no Parent customer was made for them. Renaming them on their page takes its place.";
  if (code === "fault_6240") return "QuickBooks refused it: that name is already used in QuickBooks (by another customer, a vendor or an employee), and every name there must be different.";
  const kind = code === null ? "retry" : classify(code).kind;
  if (kind === "needs_admin") return "It couldn't be sent to QuickBooks: QuickBooks needs to be connected again, which an Admin can do under QuickBooks.";
  if (kind === "not_connected") return "It couldn't be sent to QuickBooks: QuickBooks wasn't connected.";
  if (kind === "other_company") return "It couldn't be sent to QuickBooks: QuickBooks was connected to a different company from the one the roster was read from.";
  if (code === "bad_id") return "It couldn't be sent to QuickBooks: the customer's id isn't one QuickBooks uses.";
  if (kind === "retry") return "It couldn't be sent to QuickBooks: QuickBooks couldn't be reached at the time.";
  return "QuickBooks refused it: QuickBooks wouldn't take it.";
}

/** For a kept move whose family joined has a customer in QuickBooks now: whether the move can be sent (QueueView.joined). */
export type JoinedNow = "sendable" | "not_offered" | null;
/**
 * Why a move the portal kept didn't go through, in words, for every code a kept move can hold (slice 9f), saying who
 * stopped it: never the code itself. `holds`: where QuickBooks has the student now, by the portal's name of that family
 * where it has a record, else the customer's name in QuickBooks, said as text. `joined`: the family the student was
 * moved to has a customer in QuickBooks now (QueueView.joined), and whether the move can be sent, so a move kept for its
 * having none is told by what is so now.
 */
export function keptMoveWords(code: string | null, holds: string | null, joined: JoinedNow = null): string {
  const now = holds ? ` QuickBooks has the student under “${holds}” now.` : "";
  if (code === NO_FAMILY_CUSTOMER) {
    if (joined !== null) {
      return `The portal held it back when it was saved: the family the student was moved to had no customer in QuickBooks then. It has one now${joined === "sendable"
        ? ", so the portal's move can be sent with “Send the portal's value” on the Reconciliation page." : "."}`;
    }
    return "The portal held it back: the family the student was moved to has no customer in QuickBooks yet, so there is nowhere to put them there. Create the family in QuickBooks first, with “Create in QuickBooks and link” on the family's page, then send the move.";
  }
  if (code === "fault_5010" || code === "moved_on" || code === NO_LINK_VERSION || code === PLACE_DIFFERS) {
    return `The portal held it back: QuickBooks has the student under another family than the one the portal moved them from (someone may have moved them there, or an earlier move from the portal never reached it and was given up), so the portal's move wasn't sent over it.${now}`;
  }
  if (code === INACTIVE_THERE_CODE) return `The portal held it back: QuickBooks has this student inactive, and the portal never sends a change to them or makes them active again.${now}`;
  return keptRefusalWords(code, null);
}
/**
 * Why a parent's phone and address the portal kept didn't reach QuickBooks (stage 3's slice 11b), in words, for every
 * code a kept contact change can hold, saying who stopped it: never the code itself, and never the details (the
 * Reconciliation page's compare view shows those, as text, only to staff who may see a person's details, audited). A
 * difference is said field by field (`differs`, contactDiffers() of what the roster cache holds; else each field the
 * change sends, by what the portal knew of it): where the portal knew none when the change was saved, that it didn't know
 * this record's phone (or mailing address) and QuickBooks holds one; otherwise that QuickBooks holds a different one, or
 * none, from the one the portal last knew. Where the caller compared the roster cache and it shows no difference now
 * (`differs` empty: QuickBooks holds the new value, the before-value, or none where the portal knew none), that it
 * held other details when it was tried and the portal's copy shows none now; where the caller has no cache to compare
 * (`differs` absent, as at a press), each field the change sends, by what the portal knew, said of the time it was
 * tried. Never a guess at who changed it, and never a present claim the caller hasn't compared.
 */
export function keptContactWords(code: string | null, w?: Pick<ContactWrite, "change" | "was">, differs?: readonly ContactDiffer[] | null): string {
  if (code === CONTACT_DIFFERS) {
    if (differs !== undefined && differs !== null && differs.length === 0) {
      return "The portal held it back when it was tried: QuickBooks held other details for this record then than the ones the portal last knew, so the portal's details weren't sent over them. The portal's latest copy of QuickBooks shows no difference now.";
    }
    const fields: { field: "phone" | "address"; portalKnew: boolean; quickbooksHolds: boolean | null }[] = differs?.length ? [...differs]
      : (["phone", "address"] as const).filter((f) => w?.change[f] !== undefined).map((f) => ({ field: f, portalKnew: w!.was[f] !== undefined && detailKey(w!.was[f]) !== null, quickbooksHolds: null }));
    if (!fields.length) return "The portal held it back: QuickBooks held other details for this record when it was tried than the ones the portal last knew, so the portal's details weren't sent over them.";
    const word = (f: "phone" | "address") => (f === "phone" ? "phone" : "mailing address");
    const clauses = fields.map((d) => !d.portalKnew ? `the portal didn't know this record's ${word(d.field)} when the change was saved, and QuickBooks ${d.quickbooksHolds === null ? "held one when it was tried" : "holds one"}`
      : d.quickbooksHolds === false ? `QuickBooks holds no ${word(d.field)} for this record, where the portal last knew one`
        : d.quickbooksHolds === true ? `QuickBooks holds a different ${word(d.field)} for this record from the one the portal last knew`
          : `QuickBooks didn't hold the ${word(d.field)} the portal last knew for this record when it was tried`);
    const sent = fields.length > 1 ? "the portal's details weren't sent over them" : `the portal's ${word(fields[0]!.field)} wasn't sent over it`;
    return `The portal held it back: ${clauses.join("; and ")}, so ${sent}.`;
  }
  if (code === INACTIVE_THERE_CODE) return "The portal held it back: QuickBooks has this record inactive, and the portal never sends a change to it or makes it active again.";
  if (code === "fault_5010") return "The portal held it back: the record changed in QuickBooks twice while the details were being sent, so nothing was overwritten.";
  if (code !== null && valueRefused(code)) {
    return "QuickBooks refused them: it wouldn't take the phone or mailing address as the portal holds them (one may be longer than QuickBooks takes, or hold something it won't accept).";
  }
  return keptRefusalWords(code, null);
}
/** Whether a kept code is QuickBooks' refusal of a value it won't take (CUSTOMER_UPDATE.faults.validation). */
const valueRefused = (code: string) => { const m = /^fault_(\d{1,6})$/.exec(code); return m !== null && CUSTOMER_UPDATE.faults.validation.test(m[1]!); };
/**
 * Why a change the portal kept didn't go through, in words, by what it was: a move's (keptMoveWords()), a parent's
 * details' (keptContactWords(), field by field with `differs` where the caller has it), a person's sign-in email's
 * (keptEmailWords(), slice S11e), or any other's (keptRefusalWords()).
 * `joined`: for a move, whether the family joined has a customer in QuickBooks now, and the move can be sent (QueueView.joined).
 */
export const keptWordsFor = (w: RosterWrite | QueuedWrite, code: string | null, holds: string | null, differs?: readonly ContactDiffer[] | null, joined: JoinedNow = null) =>
  w.op === "move" ? keptMoveWords(code, holds, joined) : w.op === "contact" ? keptContactWords(code, w, differs) : w.op === "email" ? keptEmailWords(code) : keptRefusalWords(code, holds);
/**
 * Whose invoices each family sees while a move hasn't reached the portal's copy of QuickBooks (open question 14:
 * invoices follow once QuickBooks takes the move), in words for staff: `seenBy`, the portal's name of the family that
 * sees them now, or null when no family in the portal does; `finishing`, QuickBooks has the move already and the
 * portal takes it in at its next read of QuickBooks. Built only by moveMoneyNotes(), from where the cache has them.
 */
export function moveMoneyWords(student: string, seenBy: string | null, to: string, finishing: boolean): string {
  if (finishing) {
    return `QuickBooks has the move: ${to} sees ${student}'s invoices after the portal's next read of QuickBooks, and until then ${seenBy === null ? "no family in the portal does" : `${seenBy} still does`}.`;
  }
  return seenBy === null ? `Until QuickBooks has the move, no family in the portal sees ${student}'s invoices, ${to} included.`
    : `Until QuickBooks has the move, ${seenBy} still sees ${student}'s invoices, and ${to} doesn't.`;
}

/** A move a money note is asked for: the student's customer and name, the family joined (the portal's record and name), and whether QuickBooks has the move already (QueueView.finishing). */
export type MoveMoneyAsk = { studentQboId: string; student: string; toFamilyId: AppFamilyId | undefined; to: string; finishing: boolean };

/**
 * The money note of each move asked about (null: none), for moveStudent()'s answer and for the Reconciliation page's and
 * a family's page's rows alike, so the two never disagree. Whose invoices a family sees follows the roster cache's tree
 * (the Money rule: a family customer and its active direct sub-customers, for an active family record linked to it),
 * so the note says who sees them by where the cache has the student's customer now, the place the row's own "QuickBooks
 * has the student under ..." words come from, never by the move's before-value: the active family record linked to the
 * active family customer the cache has them under, else no family in the portal. No note where nobody could (the cache
 * has the student's customer inactive, or doesn't hold it), nor where the family joined sees them already.
 */
export async function moveMoneyNotes(asks: readonly MoveMoneyAsk[], tx?: Tx): Promise<(string | null)[]> {
  if (!asks.length) return [];
  const q = tx ?? db;
  const students = await q.select({ qboId: qboCustomer.qboId, parentQboId: qboCustomer.parentQboId, active: qboCustomer.active }).from(qboCustomer)
    .where(inArray(qboCustomer.qboId, [...new Set(asks.map((a) => a.studentQboId))]));
  const parents = [...new Set(students.flatMap((s) => (s.parentQboId ? [s.parentQboId] : [])))];
  const activeParents = new Set(parents.length ? (await q.select({ qboId: qboCustomer.qboId }).from(qboCustomer)
    .where(and(inArray(qboCustomer.qboId, parents), eq(qboCustomer.active, true)))).map((p) => p.qboId) : []);
  const familyOf = parents.length ? (await linksOfCustomers({ families: parents, students: [] }, tx)).familyOfCustomer : new Map<string, AppFamilyId>();
  const records = [...new Set(familyOf.values())];
  const activeRecords = new Map((records.length ? await q.select({ id: family.id, name: family.name }).from(family).where(and(inArray(family.id, records), eq(family.active, true))) : [])
    .map((f) => [String(f.id), recordNameWords(f.name, "family")]));
  return asks.map((a) => {
    const s = students.find((c) => c.qboId === a.studentQboId);
    if (!s?.active) return null;
    const record = s.parentQboId && activeParents.has(s.parentQboId) ? familyOf.get(s.parentQboId) : undefined;
    const seenBy = record === undefined ? undefined : activeRecords.get(String(record));
    if (seenBy !== undefined && a.toFamilyId !== undefined && String(record) === String(a.toFamilyId)) return null;
    return moveMoneyWords(a.student, seenBy ?? null, a.to, a.finishing);
  });
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

/** A change waiting or stuck for a customer (prepare()'s waitingFor()): a refused one blocks nothing, nor a parent's details (blocksOthers). */
async function waitingForCustomer(tx: Tx, qboId: string): Promise<boolean> {
  return (await tx.select({ id: writeQueue.id }).from(writeQueue).where(and(eq(writeQueue.targetQboId, qboId), inArray(writeQueue.state, ["waiting", "stuck"]), blocksOthers)).limit(1)).length > 0;
}

/** The checks every change saved first makes before anything is saved, under the roster lock with the page's tag: a roster of the company QuickBooks is connected to, and a shape that holds. */
export async function readyToSend(tx: Tx, rosterTag: string): Promise<{ ok: true; shape: MembershipShape; source: string; cache: (Cust & { syncToken: string })[]; roster: Roster } | { ok: false; error: string }> {
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
async function queueSaved(tx: Tx, write: RenameWrite | CreateWrite | MoveWrite | DeactivateWrite, realmId: string, filed: Filed, o: SaverOp): Promise<QueueRow> {
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
 * it was on its way, and it stays so (`why` `superseded`: a parent's change of their details a newer one has taken the
 * place of, given up with nothing sent, at any try, a press's included); `not_yet`, a parent's change of their details the portal may not send yet
 * (contactSendsMayGo(): the take-in, or a read under the shape, still to come), left exactly as it was, no try counted.
 */
export type SavedTry =
  | { is: "done"; cached: boolean }
  | { is: "found" }
  | { is: "waiting"; sent: boolean }
  | { is: "stuck"; code: string }
  | { is: "refused"; code: string; holds: string | null }
  | { is: "not_reached"; code: string }
  | { is: "given_up"; why?: "superseded" }
  | { is: "not_yet" };

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
      if (still) await closeEarlierContacts(tx, item, o);
      return still !== undefined;
    }
    if (to.state === "refused") {
      // `code` null: nothing reached QuickBooks ("Send the portal's value" not reached), so the item is kept as it was.
      const b = to.before;
      const [still] = await tx.update(writeQueue).set({ state: "refused", sent: b.sent, request: b.request, nextTryAt: null, lastCode: to.code === null ? b.lastCode : short(to.code),
        tries: to.code === null ? b.tries : item.tries + 1, lastTriedAt: to.code === null ? b.lastTriedAt : triedAt, updatedAt: new Date() })
        .where(and(eq(writeQueue.id, item.id), eq(writeQueue.state, "waiting"))).returning({ id: writeQueue.id });
      if (still) await audit("roster.write.kept_refused", { op: b.request.op, role: b.request.role, code: short(to.code ?? b.lastCode ?? ""), state: "refused", ...(to.code === null ? { reached: false } : {}) });
      if (still) await closeEarlierContacts(tx, item, o);
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
  await closeEarlierContacts(tx, item, o);
}

/** Whether a guardian row still wants a Parent customer made for it: open, and linked to no customer in the company. */
async function guardianStillWants(guardianId: string, realmId: string): Promise<boolean> {
  const [row] = await db.select({ status: guardian.status }).from(guardian).where(eq(guardian.id, guardianId));
  if (!row || row.status === "disabled") return false;
  const [link] = await db.select({ id: accountingLink.id }).from(accountingLink)
    .where(and(eq(accountingLink.guardianId, guardianId), eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId)));
  return link === undefined;
}
/** Why a guardian's Parent customer create is given up at its try with nothing sent (guardianCreateStops()). */
type GuardianCreateStop = "guardian_removed" | "family_inactive" | "named_elsewhere";
const GUARDIAN_STOP_NOTES: Record<GuardianCreateStop, string> = {
  guardian_removed: "The guardian was removed in the portal, or linked, before it was sent.",
  family_inactive: "The guardian's family was made inactive, or is no longer linked to an active family in QuickBooks, before it was sent: nothing is made under it.",
  named_elsewhere: "QuickBooks has the person's own record under another family of theirs, and takes a name once, so none was made under this family.",
};
/**
 * Whether a guardian's Parent customer create must not be sent now, checked at every try, whoever makes it (the lead's
 * decisions 1(a) and 2 in slice 9h's last round, at the send as well as at the save): the row closed or linked since it
 * was queued; its family record inactive, or no longer linked to the active family customer it was asked under (the
 * family action ran meanwhile: nothing is made under a family being, or made, inactive); or the person's own Parent
 * customer of that name under another family of theirs, which the cache holds now though it didn't when this was queued
 * (ownNamedElsewhere()). Null when it may go.
 */
async function guardianCreateStops(guardianId: string, w: CreateWrite, item: QueueRow): Promise<GuardianCreateStop | null> {
  if (!(await guardianStillWants(guardianId, item.realmId))) return "guardian_removed";
  const familyId = item.familyId;
  if (familyId === null) return null;
  return db.transaction(async (tx) => {
    const [f] = await tx.select({ active: family.active }).from(family).where(eq(family.id, familyId));
    if (!f?.active) return "family_inactive";
    const b = await guardianBooks(tx, familyId);
    // The books or the connection: what the send itself answers (refused, or left for a later try), as before.
    if (!b.ok) return b.why === "family" ? "family_inactive" : null;
    if (b.familyCustomer !== w.familyQboId) return "family_inactive";
    return (await ownNamedElsewhere(tx, b, guardianId, w.name)) !== null ? "named_elsewhere" : null;
  });
}
/** A guardian's Parent customer create given up with nothing sent (guardianCreateStops()): audited, only while it is still waiting. */
async function giveUpForGoneGuardian(item: QueueRow, why: GuardianCreateStop, o: { actor: Actor; ip: string | null; permission?: string }): Promise<void> {
  await db.transaction(async (tx) => {
    // Its mark as maybe sent is taken back with it: this try sent nothing.
    const [still] = await tx.update(writeQueue).set({ state: "given_up", sent: item.sent, note: GUARDIAN_STOP_NOTES[why], nextTryAt: null,
      finishedAt: new Date(), updatedAt: new Date() }).where(and(eq(writeQueue.id, item.id), eq(writeQueue.state, "waiting"))).returning({ id: writeQueue.id });
    if (!still) return;
    await writeAudit({ actor: o.actor, action: "roster.write.given_up", permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: item.id,
      before: { state: item.state, tries: item.tries, code: item.lastCode, op: "create" }, after: { state: "given_up", why, sentNow: false } }, tx);
  });
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
export async function trySavedItem(item: QueueRow, write: RenameWrite | CreateWrite | MoveWrite | DeactivateWrite | ContactWrite | EmailWrite, o: { by: TryBy; readFirst?: "moved_on" | null; linkedBy: string | null; actor: Actor; ip: string | null;
  permission?: string; now?: Date; before?: Before; rosterWaitMs?: number; emailField?: string }): Promise<SavedTry> {
  const before: Before = o.before ?? { request: item.request as RosterWrite, sent: item.sent, lastCode: item.lastCode, tries: item.tries, lastTriedAt: item.lastTriedAt };
  const now = o.now ?? new Date();
  const mayWait = o.by === "worker";
  const filed: Filed = { familyId: item.familyId, studentId: item.studentId };
  const triedAt = new Date();
  const gone: SavedTry = { is: "given_up" };
  // A parent's phone and address (stage 3's slice 11b) are sent only once the cache's details are known to be
  // QuickBooks' (contactSendsMayGo()): until then the item is left exactly as it is, by every path. A press puts it back
  // as it was kept (sendAgainHolding() refuses it first; this is for a read withdrawn meanwhile).
  const notYet = async (): Promise<SavedTry> => (o.by === "press"
    ? ((await settleSaved(item, { state: "refused", code: null, before }, triedAt, o)) ? { is: "not_reached", code: CONTACT_AWAITS_READ_CODE } : gone)
    : { is: "not_yet" });
  // A staff member's at-once try (sendContactSaved()) waits for the roster lock at its own looks no longer than it
  // waited before the try: held past that, nothing is sent, the item is left as it was, and RosterBusyAtTry is thrown.
  const busy = (e: unknown): never => { throw o.rosterWaitMs !== undefined && lockTimedOut(e) ? new RosterBusyAtTry() : e; };
  const gateSince = write.op === "contact" ? await contactReadStands(o.rosterWaitMs).catch(busy) : null;
  if (write.op === "contact" && gateSince === null) return notYet();
  // A contact change's age is counted from when it could first go (contactAgeFrom()): the time it waited for the read
  // above is no time it could be tried in, so it is never stuck by that age at its first failed try.
  const ageFrom = write.op === "contact" ? contactAgeFrom(item.createdAt, gateSince) : item.createdAt;
  const [marked] = await db.update(writeQueue).set({ sent: true, request: write, lastTriedAt: triedAt, updatedAt: new Date() })
    .where(and(eq(writeQueue.id, item.id), eq(writeQueue.state, "waiting"))).returning({ id: writeQueue.id });
  if (!marked) return gone;
  // A guardian's Parent customer create (stage 3's slice 9h) is made only for a row still open and unlinked, under its
  // family's active customer, and only while no record of the person's own has that name under another family: one that
  // no longer is so since it was queued is given up here with nothing sent, whoever tries it (a removal that ran while
  // an earlier try of it was on its way, or a family action that finished while it waited, leaves it to this check).
  const forRow = write.op === "create" ? guardianOf(write) : null;
  const stop = forRow !== null && write.op === "create" ? await guardianCreateStops(forRow, write, item) : null;
  if (stop !== null) {
    await giveUpForGoneGuardian(item, stop, o);
    return gone;
  }
  // A parent's phone and address (stage 3's slice 11b) go only to the record they are for, as it stands at this try:
  // the membership's own Parent customer, or the family's own linked customer. Otherwise given up, nothing sent.
  // Taking back this try's mark, when it sent nothing: keyed on the mark itself (`sent` and this try's own tried-at
  // time), never on the state, so an item given up on Reconciliation while this try waited for the roster lock keeps no
  // mark of a send that never went; a later try's mark (another time) is never touched.
  const unmark = () => db.update(writeQueue).set({ sent: before.sent, request: before.request, lastTriedAt: before.lastTriedAt, updatedAt: new Date() })
    .where(and(eq(writeQueue.id, item.id), eq(writeQueue.sent, true), eq(writeQueue.lastTriedAt, triedAt)));
  const contactStop = write.op === "contact" ? await contactStops(write, item, o.rosterWaitMs).catch(async (e: unknown) => {
    // The roster lock held past an at-once try's wait: its mark as maybe sent is taken back, as nothing was sent.
    if (o.rosterWaitMs !== undefined && lockTimedOut(e)) await unmark();
    return busy(e);
  }) : null;
  if (contactStop === "await_read") {
    // Withdrawn since the look above (a shape save): its mark as maybe sent is taken back, as nothing was sent.
    if (o.by !== "press") await unmark();
    return notYet();
  }
  if (contactStop !== null) {
    await giveUpContact(item, contactStop, before.sent, o);
    return contactStop === "superseded" ? { is: "given_up", why: "superseded" } : gone;
  }
  // A person's sign-in email (stage 3's slice S11e) goes only to the record it is for, as it stands at this try, and
  // only while it is still their address: otherwise given up, nothing sent. It has no take-in's gate.
  const emailStop = write.op === "email" ? await emailStops(write, item, o.rosterWaitMs).catch(async (e: unknown) => {
    if (o.rosterWaitMs !== undefined && lockTimedOut(e)) await unmark();
    return busy(e);
  }) : null;
  if (emailStop !== null) {
    await giveUpContact(item, emailStop, before.sent, o);
    return emailStop === "superseded" ? { is: "given_up", why: "superseded" } : gone;
  }

  const refused = async (code: string, holds: string | null): Promise<SavedTry> =>
    (await settleSaved(item, { state: "refused", code, before }, triedAt, o)) ? { is: "refused", code, holds } : gone;
  /** For a later try: `sentNow`, this try may have reached QuickBooks; `request`, what a later look finds it as. */
  const later = async (code: string, sentNow: boolean, request: RosterWrite): Promise<SavedTry> => {
    if (o.by === "press" && !sentNow) return (await settleSaved(item, { state: "refused", code: null, before }, triedAt, o)) ? { is: "not_reached", code } : gone;
    const next = o.by === "press" ? { state: "waiting" as const, nextTryAt: new Date(Date.now() + SAVED_LEASE_MS) } : afterFailedTry(item.tries + 1, ageFrom, now);
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
  const taken = async (w: RenameWrite | CreateWrite | MoveWrite | DeactivateWrite | ContactWrite | EmailWrite, answer: Record<string, unknown>, resent: "stale" | "no_version" | "differs" | null): Promise<SavedTry> => {
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
  if (write.op === "move") {
    // The cache already shows the student under another customer than the move's before-value, or inactive: read live
    // before anything is sent (stage 3's slice 9f, by the rule a rename follows).
    const [c] = o.readFirst ? [] : await db.select({ parentQboId: qboCustomer.parentQboId, active: qboCustomer.active }).from(qboCustomer).where(eq(qboCustomer.qboId, write.qboId));
    const readFirst = o.readFirst ?? (c !== undefined && ((c.parentQboId ?? TOP_OF_TREE) !== write.fromFamilyQboId || !c.active) ? "differs" : null);
    const t = await tryMove(write, item.realmId, { mayWait, readFirst, actor: o.actor, ip: o.ip, permission: o.permission });
    switch (t.is) {
      case "answer": return taken(t.write, t.answer, t.resent);
      case "in_place": {
        // QuickBooks has the move already: found, nothing sent, the link not aligned (no send of the portal's made it),
        // and both families' figures read again, as the cache now has the student under the family joined.
        const done = await settleSaved(item, { state: "done", resultQboId: write.qboId }, triedAt, o);
        if (done) await db.transaction((tx) => markMoveMoneyStale(tx, write));
        return done ? { is: "found" } : gone;
      }
      case "stale_again": return o.by === "press" ? refused("fault_5010", null) : later("fault_5010", false, before.request);
      case "changed": return refused(t.code, await placeName(t.holds));
      case "failed": return failed(t.code, t.sent, t.write);
    }
  }
  if (write.op === "deactivate") {
    // A guardian's Parent customer made inactive once they are removed (stage 3's slice 9h), under the one balance rule
    // (balanceStops()): read live first, and any balance, owed or a credit, keeps it refused with nothing sent, the
    // customer left active in QuickBooks (the owner's decision of 2026-11-18); a balance that can't be read keeps it so
    // at once, leaves it for a later try for the worker, and as it was for a press. A stale answer is settled by the
    // Active flag (sendDeactivate()); one QuickBooks has inactive already is found made, the link not aligned. One the
    // queue's look found moved on (`readFirst`) carries no version of its own: it is sent with the one its read shows.
    const t = await tryDeactivate(o.readFirst ? { ...write, syncToken: "" } : write, item.realmId, { mayWait, name: "", showAmounts: false, actor: o.actor, ip: o.ip, permission: o.permission });
    switch (t.is) {
      case "answer": return taken(t.write, t.answer, t.resent ? "stale" : null);
      case "inactive_there": return (await settleSaved(item, { state: "done", resultQboId: write.qboId }, triedAt, o)) ? { is: "found" } : gone;
      case "stopped": {
        const code = t.stop.code;
        if (code === "open_balance" || code === CREDIT_BALANCE) return refused(code, null);
        // A balance that couldn't be read: nothing was sent, so it is kept as the portal's holding back, with the read's code.
        if (classify(code).kind !== "retry" || o.by === "at_once") return refused(unreadKept(code), null);
        return later(code, false, before.request);
      }
      case "stale_again": return o.by === "press" ? refused("fault_5010", null) : later("fault_5010", false, before.request);
      case "failed": return failed(t.code, t.sent, t.write);
    }
  }
  if (write.op === "contact") {
    // The cache already shows a field that is neither the new value, nor what the portal last knew QuickBooks held, nor
    // an earlier change's that may have been sent, or QuickBooks has the customer inactive or not at all: read live
    // before anything is sent, so nothing QuickBooks holds that the portal never saw is overwritten (the lead's decision 5).
    // And when the cache holds no phone or address at all for the customer while the portal knew none either: an empty
    // row may only be one no read has filled, so QuickBooks is asked what it holds before anything is sent over it.
    const [c] = o.readFirst ? [] : await db.select().from(qboCustomer).where(eq(qboCustomer.qboId, write.qboId));
    const nothingCached = c !== undefined && detailKey(heldInCache(c).phone) === null && detailKey(heldInCache(c).address) === null;
    const knewNothing = (["phone", "address"] as const).every((f) => write.was[f] === undefined || detailKey(write.was[f]) === null);
    const readFirst = o.readFirst ?? (c === undefined || !c.active || (nothingCached && knewNothing)
      || contactStands(heldInCache(c), write) === "differs" ? "differs" : null);
    const t = await tryContact(write, item.realmId, { mayWait, readFirst, actor: o.actor, ip: o.ip, permission: o.permission });
    switch (t.is) {
      case "answer": return taken(t.write, t.answer, t.resent);
      case "in_place": return (await settleSaved(item, { state: "done", resultQboId: write.qboId }, triedAt, o)) ? { is: "found" } : gone;
      case "stale_again": return o.by === "press" ? refused("fault_5010", null) : later("fault_5010", false, before.request);
      case "changed": return refused(t.code, null);
      case "failed": return failed(t.code, t.sent, t.write);
    }
  }
  if (write.op === "email") {
    // The cache's field already holds the new address by the record's rule, and none it replaces: done, nothing sent.
    // Otherwise the field is read live before anything is sent (tryEmail()), and nothing is kept on the cache's word.
    const [c] = o.readFirst || o.emailField !== undefined ? [] : await db.select({ email: qboCustomer.email }).from(qboCustomer).where(eq(qboCustomer.qboId, write.qboId));
    if (c !== undefined && emailStands(c.email, write, await othersSignInWith(write)).is === "in_place") return (await settleSaved(item, { state: "done", resultQboId: write.qboId }, triedAt, o)) ? { is: "found" } : gone;
    const t = await tryEmail(write, item.realmId, { mayWait, preset: o.emailField, actor: o.actor, ip: o.ip, permission: o.permission });
    switch (t.is) {
      case "answer": return taken(t.write, t.answer, t.resent);
      case "in_place": return (await settleSaved(item, { state: "done", resultQboId: write.qboId }, triedAt, o)) ? { is: "found" } : gone;
      case "stale_again": return o.by === "press" ? refused("fault_5010", null) : later("fault_5010", false, before.request);
      case "changed": return refused(t.code, null);
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
  return (await whileSending(recordId, () => renameHolding(ask.kind, recordId, ask.name, rosterTag, o))) ?? refuse(ask.kind === "student" ? STUDENT_BEING_CHANGED : FAMILY_BEING_CHANGED);
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
    case "stuck": case "not_reached": case "not_yet": return { ok: true, status: "attention", message: `Renamed ${said} in the portal, but not in QuickBooks: see the Reconciliation page.` };
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
    case "found": case "stuck": case "not_reached": case "not_yet": return { ok: true, status: "attention", message: `${said}, but they aren't in QuickBooks yet: see the Reconciliation page.` };
  }
}

/* ---- A student moved to another family, saved in the portal first (stage 3's slice 9f; app-owned families spec
   section 5: "A change to a linked person is saved in the app first, then sent to QuickBooks: ... a student moved to
   another family"; "the follow-ups run only when the move is made in the app"; open questions 10 and 14) ---- */

/** A family a move of a student into or out of which hasn't reached QuickBooks yet: it isn't made inactive meanwhile. */
export const MOVE_PENDING = "A student's move into or out of this family hasn't reached QuickBooks yet (it is waiting, stuck or kept on the Reconciliation page), so nothing was changed. Finish it there, or give it up, then try again.";
/** A move refused because one of its two families is being changed at that moment (its rename being sent, or askFamilyInactive() under way: either holds its "being sent" lock). */
export const FAMILY_BUSY = "One of the two families is being changed at this moment (renamed or made inactive, say), so the student wasn't moved. Try again in a minute.";
/**
 * A move refused because something is being made in QuickBooks for one of its two families at that moment (its
 * "being made" lock held: the family itself, by its add or "Create in QuickBooks and link", or a student added to it).
 */
export const FAMILY_MAKING_NOW = "Something is being made in QuickBooks for one of the two families at this moment (the family itself, or a student added to it), so the student wasn't moved. Try again in a minute.";
const MOVE_FAILED = "That didn't go through, so nothing was changed: the student is still in the family they were in. Try again in a minute.";
const movesOf = (studentId: AppStudentId) => and(eq(writeQueue.studentId, studentId), sql`${writeQueue.request}->>'op' = 'move'`);

/**
 * Whether a move of a student into or out of this family is waiting, stuck or kept refused (slice 9f): the family's
 * make-inactive refuses meanwhile, so QuickBooks is never asked to make a student inactive under a family the portal
 * has moved them out of. By the family record (filed under it as the family left, or named as the family joined) and,
 * where it has one, by its customer.
 */
async function familyMovePending(tx: Tx, familyId: AppFamilyId | null, customer: string | null): Promise<boolean> {
  const isMove = sql`${writeQueue.request}->>'op' = 'move'`;
  const by = or(familyId === null ? undefined : eq(writeQueue.familyId, familyId), familyId === null ? undefined : sql`${writeQueue.request}->>'toFamilyId' = ${String(familyId)}`,
    customer === null ? undefined : sql`${writeQueue.request}->>'fromFamilyQboId' = ${customer}`, customer === null ? undefined : sql`${writeQueue.request}->>'toFamilyQboId' = ${customer}`);
  if (by === undefined) return false;
  return (await tx.select({ id: writeQueue.id }).from(writeQueue).where(and(inArray(writeQueue.state, ["waiting", "stuck", "refused"]), isMove, by)).limit(1)).length > 0;
}

/**
 * Why a move into or out of each of these families would be refused at this moment, for those it would be (the one rule
 * moveStudent() checks a move's two families by, and the move form's list of where a student may go): its own create
 * waiting or stuck on the queue (`FAMILY_WAITING`); something being made in QuickBooks for it (its "being made" lock
 * held: `FAMILY_MAKING_NOW`); it being changed (its "being sent" lock held: its rename being sent or its make-inactive
 * under way, `FAMILY_BUSY`); or a change waiting or stuck for its customer (`WRITE_COPY.waiting`: a make-inactive's step
 * held as possibly made among them). With `locks`, each lock is tried shared, and held so to the end of the caller's
 * transaction (the move's own checks); the page's list leaves the locks alone, held as they are for the seconds of a
 * send, so a page load never stands in the way of one, and the move checks them again. A few queries, whatever the
 * number of families.
 */
async function moveRefusals(tx: Tx, familyIds: readonly AppFamilyId[], o: { locks: boolean }): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(familyIds.map(String))];
  if (!ids.length) return out;
  const say = (id: string, why: string) => { if (!out.has(id)) out.set(id, why); };
  const queued = await tx.select({ familyId: writeQueue.familyId }).from(writeQueue)
    .where(and(inArray(writeQueue.familyId, [...familyIds]), inArray(writeQueue.state, ["waiting", "stuck"]), isFamilyCreate));
  for (const q of queued) if (q.familyId !== null) say(String(q.familyId), FAMILY_WAITING);
  if (o.locks) {
    const locks = (await tx.execute(sql`select id, pg_try_advisory_xact_lock_shared(${sql.raw(String(MAKING_LOCK))}, hashtext(id)) as making,
      pg_try_advisory_xact_lock_shared(${sql.raw(String(SENDING_LOCK))}, hashtext(id)) as sending
      from unnest(array[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::text[]) as id`)) as unknown as { id: string; making: boolean; sending: boolean }[];
    for (const l of locks) {
      if (!l.making) say(l.id, FAMILY_MAKING_NOW);
      if (!l.sending) say(l.id, FAMILY_BUSY);
    }
  }
  const customers = (await linksOf({ families: familyIds, students: [] }, tx)).customerOfFamily;
  if (customers.size) {
    const waiting = new Set((await tx.select({ target: writeQueue.targetQboId }).from(writeQueue)
      .where(and(inArray(writeQueue.targetQboId, [...customers.values()]), inArray(writeQueue.state, ["waiting", "stuck"]), blocksOthers))).map((w) => w.target));
    for (const [f, c] of customers) if (waiting.has(c)) say(String(f), WRITE_COPY.waiting);
  }
  return out;
}

/**
 * Where a student of `fromFamilyId` may be moved now, by the rule moveStudent() checks: `refusedHere`, why no move out
 * of that family would go through (moveRefusals(), in words), else null; `families`, the portal's own active families
 * but that one that moveRefusals() wouldn't refuse (the locks of a send under way aside, which the move checks). By
 * name, as the list shows them; names the list can't tell apart (two the portal knows no name for, or two alike) are
 * told apart by their place in it, as the parent's family chooser tells them apart (numberedWhereRepeated()). The
 * labels are the portal's own names, shown as text only.
 */
export async function moveTargets(fromFamilyId: AppFamilyId): Promise<{ refusedHere: string | null; families: { id: string; name: string }[] }> {
  return db.transaction(async (tx) => {
    const here = (await moveRefusals(tx, [fromFamilyId], { locks: false })).get(String(fromFamilyId)) ?? null;
    const rows = (await tx.select({ id: family.id, name: family.name }).from(family).where(eq(family.active, true)))
      .filter((r) => String(r.id) !== String(fromFamilyId))
      .map((r) => ({ id: r.id, name: recordNameWords(r.name, "family") }))
      .sort((a, b) => COLLATOR.compare(a.name, b.name) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
    const refused = await moveRefusals(tx, rows.map((r) => r.id), { locks: false });
    const offered = rows.filter((r) => !refused.has(String(r.id)));
    const labels = numberedWhereRepeated(offered.map((r) => r.name));
    return { refusedHere: here, families: offered.map((r, i) => ({ id: String(r.id), name: labels[i]! })) };
  });
}

/**
 * A change saved first kept at once as `refused`, with nothing sent (a linked student moved into a family with no
 * customer in QuickBooks: NO_FAMILY_CUSTOMER), in the transaction that saves it, audited (`roster.write.kept_refused`).
 */
async function keepSaved(tx: Tx, write: MoveWrite | CreateWrite, realmId: string, filed: Filed, code: string, o: SaverOp): Promise<QueueRow> {
  const [item] = await tx.insert(writeQueue).values({
    realmId, request: write, targetQboId: write.op === "create" ? null : write.qboId, familyId: filed.familyId, studentId: filed.studentId,
    state: "refused", sent: false, tries: 0, lastCode: short(code), nextTryAt: null, askedBy: o.staffUserId, askedByLabel: o.actor.label,
  }).returning();
  await writeAudit({ actor: o.actor, action: "roster.write.kept_refused", permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: item!.id,
    before: null, after: { op: write.op, role: write.role, code: short(code), state: "refused", sent: false } }, tx);
  return item!;
}

/**
 * A student moved to another of the portal's own active families, saved in the portal first (the lead's decisions 1
 * and 2 for slice 9f): `studentId` and `toFamilyId` are the app's ids the page sent (uuids), checked under the roster
 * lock with the page's tag. It holds the student's "being sent" lock (whileSending()) from before the save until the
 * at-once try's answer is in, or the move is queued or kept: a second change to the student meanwhile (a move, a
 * rename) is refused (`STUDENT_BEING_CHANGED`). Every check comes first, refusing before anything is saved: the student active in
 * an active family that isn't the one asked for; the family asked for one of the portal's own active families; the
 * shape holding and offering the move; neither family's own create waiting, stuck or being sent, nor the student's own
 * create waiting or stuck; nothing waiting or stuck for the student's customer or either family's; and, for a linked
 * student, QuickBooks connected to the roster's company, while a student with no link needs only a roster of the
 * portal's company. Then, in one transaction: a refused move of the student is replaced (inheriting its
 * before-value), the student record's family set, the move's follow-ups run once (afterStudentMoved(), by the app's
 * ids), the save audited (`roster.record.moved`) and, by the links: (a) a student with no link: nothing more, nothing
 * sent (`not_sent`); (b) a linked student into a linked family: the move put on the queue (queueSaved()) carrying the
 * student link's own version, and tried at once (trySavedItem()), unless the cache has them under that family's
 * customer already (`has_it`, no item); (c) a linked student into a family with no link: kept refused at once
 * (NO_FAMILY_CUSTOMER), nothing sent (`kept`). A failure anywhere in that transaction keeps nothing. The guardians
 * whose places were given up are told after the commit. The portal's move is never undone because QuickBooks refused
 * it or couldn't be reached (open question 10); whose invoices a family sees follows QuickBooks' tree (open question 14).
 */
export async function moveStudent(rawStudentId: string, rawToFamilyId: string, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  if (!isUuid(rawStudentId) || !isUuid(rawToFamilyId)) return refuse(WRITE_COPY.gone);
  const studentId = asAppStudentId(rawStudentId.toLowerCase());
  const toFamilyId = asAppFamilyId(rawToFamilyId.toLowerCase());
  return (await whileSending(String(studentId), () => moveHolding(studentId, toFamilyId, rosterTag, o))) ?? refuse(STUDENT_BEING_CHANGED);
}

async function moveHolding(studentId: AppStudentId, toFamilyId: AppFamilyId, rosterTag: string, o: WriteOp & { staffUserId: string }, take?: { stamp: string }): Promise<WriteResult> {
  type Saved = { ok: true; quickbooks: "not_sent" | "sending" | "has_it" | "kept"; item: QueueRow | null; write: MoveWrite | null; tell: () => Promise<unknown>;
    said: { student: string; from: string; to: string }; notes: string[] } | { ok: false; result: WriteResult };
  let saved: Saved;
  try {
    saved = await db.transaction(async (tx): Promise<Saved> => {
      const no = (error: string): Saved => ({ ok: false, result: refuse(error) });
      if (!(await lockRosterAs(tx, rosterTag))) return no(ROSTER_MOVED);
      const [s] = await tx.select().from(student).where(eq(student.id, studentId)).for("update");
      if (!s || s.familyId === null) return no(WRITE_COPY.gone);
      const fromFamilyId = s.familyId;
      const [from] = await tx.select().from(family).where(eq(family.id, fromFamilyId));
      if (!s.active || !from?.active) return no(INACTIVE_HERE);
      const [to] = await tx.select().from(family).where(eq(family.id, toFamilyId));
      if (!to?.active) return no(WRITE_COPY.notOurs);
      if (String(to.id) === String(fromFamilyId)) return no(ALREADY_THERE);
      const [shape, source, conn, types, holds, other] = await Promise.all([getShape(tx), getRosterSource(tx), getConnection(tx), tx.select().from(qboCustomerType), shapeHolds(tx), connectedToAnotherCompany(tx)]);
      const studentCustomer = await customerOfStudent(s.id, tx);
      // A move taken from the books (takeFromBooks(), stage 4's slice M4a) is of a linked student, and sends nothing:
      // it needs no live connection, only a roster of the company the books aren't connected away from.
      if (take && studentCustomer === null) return no(TAKE_CHANGED);
      if (studentCustomer !== null && !take) {
        // A linked student's move is sent: as every change saved first, QuickBooks connected to the roster's company.
        if (!conn?.realmId || !conn.refreshTokenCiphertext) return no(WRITE_COPY.notConnected);
        if (source === null || source !== conn.realmId) return no(WRITE_COPY.otherCompany);
        if (!shape || missingTypes(shape, types.map((t) => ({ qboId: t.qboId, name: t.name, active: t.active }))).length) return no(WRITE_COPY.noRoster);
      } else if (!shape || !holds || source === null || other) return no(WRITE_COPY.noRoster);
      if (!offers(shape, "move_student")) return no(WRITE_COPY.notOffered);
      // Neither family's own create on its way ("Create in QuickBooks and link" could otherwise make the student's
      // customer under one family while the record moves to the other), nor anything else being made for it in
      // QuickBooks at this moment, nor either being changed (askFamilyInactive() holds the family's "being sent" lock for
      // its whole run), nor a change waiting for either's customer: the rule the move form's list is built by
      // (moveRefusals()), its locks tried shared and held to the end of this transaction.
      const refusals = await moveRefusals(tx, [fromFamilyId, to.id], { locks: true });
      for (const f of [fromFamilyId, to.id]) { const why = refusals.get(String(f)); if (why) return no(why); }
      if (await studentCreateWaiting(tx, s.id)) return no(STUDENT_WAITING);
      const [fromCustomer, toCustomer] = await Promise.all([customerOfFamily(fromFamilyId, tx), customerOfFamily(to.id, tx)]);
      if (studentCustomer !== null && (await waitingForCustomer(tx, studentCustomer))) return no(WRITE_COPY.waiting);
      const [cached] = studentCustomer === null ? [] : await tx.select().from(qboCustomer).where(eq(qboCustomer.qboId, studentCustomer));
      if (studentCustomer !== null && !cached) return no(WRITE_COPY.gone);
      // A take moves the student only where the books have them now, directly under the target family's customer, as
      // the row showed it (its stamp): so the only outcome below is `has_it`, and nothing is queued or sent.
      if (take && (studentCustomer === null || toCustomer === null || cached!.parentQboId !== toCustomer
        || !takeStampHolds("place", String(s.id), studentCustomer, [studentCustomer, toCustomer, String(fromFamilyId), String(to.id)], take.stamp))) return no(TAKE_CHANGED);

      // A later move takes the place of a refused one, and takes from it the family the portal and QuickBooks last agreed on.
      const replaced = await replaceRefused(tx, movesOf(s.id), take ? { op: "take", field: "place", studentId: String(s.id), toFamilyId: String(to.id) }
        : { op: "move", studentId: String(s.id), toFamilyId: String(to.id) }, o);
      const agreed = replaced.map((r) => r.request).find((w): w is MoveWrite => w.op === "move" && w.fromFamilyQboId !== "")?.fromFamilyQboId;
      // Who may sign in goes by the family's active students while the Admin's "Families with no active student" is in
      // force (enterableGuardianRows(), src/lib/parents/sessions.ts): a move can close one family's door and open another's.
      const rule = await studentsRuleInForce(tx);
      const hasActive = async (f: AppFamilyId) => (await tx.select({ id: student.id }).from(student).where(and(eq(student.familyId, f), eq(student.active, true))).limit(1)).length > 0;
      const joinedOpens = rule && !(await hasActive(to.id));
      await tx.update(student).set({ familyId: to.id, updatedAt: new Date() }).where(eq(student.id, s.id));
      const leftCloses = rule && !(await hasActive(fromFamilyId));
      // The move's follow-ups, once, here, by the app's own records: never again when QuickBooks takes it.
      const { tell, buyouts } = await afterStudentMoved(tx, { studentId: s.id, fromFamilyId, toFamilyId: to.id, cause: take ? `accounting.difference.take#${s.id}` : `roster.record.moved#${s.id}` }, o);
      const filed: Filed = { familyId: fromFamilyId, studentId: s.id };
      let quickbooks: "not_sent" | "sending" | "has_it" | "kept" = "not_sent", item: QueueRow | null = null, write: MoveWrite | null = null;
      if (studentCustomer !== null) {
        const [link] = await tx.select({ syncedToken: accountingLink.syncedToken }).from(accountingLink)
          .where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, source!), eq(accountingLink.customerId, studentCustomer), isNotNull(accountingLink.studentId)));
        write = { op: "move", role: "student", qboId: studentCustomer, syncToken: link?.syncedToken ?? "", fromFamilyQboId: agreed ?? fromCustomer ?? "",
          toFamilyQboId: toCustomer ?? "", fromFamilyId, toFamilyId: to.id };
        if (toCustomer === null) { item = await keepSaved(tx, write, source!, filed, NO_FAMILY_CUSTOMER, o); quickbooks = "kept"; }
        else if (cached!.parentQboId === toCustomer) { quickbooks = "has_it"; write = null; }
        // Nothing is saved without its queue item: the move goes on the queue in this same transaction, and the try below is a try of it.
        else { item = await queueSaved(tx, write, source!, filed, o); quickbooks = "sending"; }
      }
      // A take's own row, with what it took (the books' family customer), in place of the portal's move's.
      if (take) {
        await writeAudit({ actor: o.actor, action: "accounting.difference.take", permission: o.permission, ip: o.ip, targetType: "student", targetId: String(s.id),
          before: { familyId: String(fromFamilyId) }, after: { field: "place", kind: "student", studentId: String(s.id), familyId: String(to.id), fromFamilyId: String(fromFamilyId),
            customerQboId: studentCustomer, familyQboId: toCustomer, replaced: replaced.map((r) => r.id) } }, tx);
      } else await writeAudit({ actor: o.actor, action: "roster.record.moved", permission: o.permission, ip: o.ip, targetType: "student", targetId: String(s.id),
        before: { familyId: String(fromFamilyId) }, after: { kind: "student", studentId: String(s.id), familyId: String(to.id), fromFamilyId: String(fromFamilyId), quickbooks,
          ...(studentCustomer !== null ? { customerQboId: studentCustomer } : {}), ...(item && write ? { queueId: item.id, comparedWith: write.fromFamilyQboId } : {}),
          ...(replaced.length ? { replaced: replaced.map((r) => r.id) } : {}) } }, tx);
      const said = { student: recordNameWords(s.name, "student"), from: recordNameWords(from.name, "family"), to: recordNameWords(to.name, "family") };
      return { ok: true, quickbooks, item, write, tell, said, notes: moveNotes(said, { buyouts, leftCloses, joinedOpens, taken: Boolean(take) }) };
    });
  } catch {
    // A follow-up, the save or its audit row failed: the transaction kept nothing (no record moved, no follow-up, no item).
    return refuse(MOVE_FAILED);
  }
  if (!saved.ok) return saved.result;
  // The guardians whose places a moved student gave up are told once the move is committed. A mail failure is the
  // notices' own to record; it never undoes the move.
  await saved.tell().catch(() => undefined);
  const answer: WriteResult = take
    ? { ok: true, message: `Moved ${saved.said.student} to ${saved.said.to} in the portal, as the books have them. Nothing about the student was sent to the books.` }
    : await movedAnswer(saved, o);
  if (!saved.notes.length || !answer.ok) return answer;
  return { ...answer, message: `${answer.message} ${saved.notes.join(" ")}` };
}

/**
 * What the follow-ups and the sign-in rule did beside the move itself, in words for the staff member's answer. A move
 * taken from the books (`taken`, slice M4a) has no move on its way to QuickBooks, so its void is said without one.
 */
function moveNotes(said: { student: string; from: string; to: string }, o: { buyouts: { voiding: number; flagged: number }; leftCloses: boolean; joinedOpens: boolean; taken: boolean }): string[] {
  const notes: string[] = [];
  // Voided whatever becomes of the move in QuickBooks: the family that chose the buy-out is no longer the student's.
  if (o.buyouts.voiding) {
    notes.push(o.taken ? `${said.student}'s unpaid volunteer buy-out invoice is to be voided in the books, since the family that chose it is no longer theirs.`
      : `${said.student}'s unpaid volunteer buy-out invoice is to be voided all the same, whatever QuickBooks does with the move, since the family that chose it is no longer theirs.`);
  }
  if (o.buyouts.flagged) notes.push(`A volunteer buy-out of ${said.student}'s that can't simply be voided (a paid one, say) is flagged for the club on the Reconciliation page.`);
  if (o.leftCloses) notes.push(`${said.from} has no active student now, so its guardians can't sign in to it until it has one again.`);
  if (o.joinedOpens) notes.push(`${said.to} has an active student now, so its guardians can sign in to it.`);
  return notes;
}

/** moveStudent()'s answer for a move saved, by what was sent: for a move put on the queue, the at-once try's. */
async function movedAnswer(saved: { quickbooks: "not_sent" | "sending" | "has_it" | "kept"; item: QueueRow | null; write: MoveWrite | null; said: { student: string; from: string; to: string } },
  o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  const { student: who, to } = saved.said;
  const moved = `Moved ${who} to ${to} in the portal`;
  // Whose invoices each family sees, from where the cache has the student once this try is over (moveMoneyNotes()).
  const money = async () => {
    const [note] = saved.write ? await moveMoneyNotes([{ studentQboId: saved.write.qboId, student: who, toFamilyId: saved.write.toFamilyId, to, finishing: false }]) : [null];
    return note ? ` ${note}` : "";
  };
  if (saved.quickbooks === "not_sent") return { ok: true, message: `${moved}. ${who} isn't linked to QuickBooks, so nothing was sent there.` };
  if (saved.quickbooks === "has_it") return { ok: true, message: `${moved}. QuickBooks has them in that family already, so nothing was sent.` };
  if (saved.quickbooks === "kept") {
    return { ok: true, status: "attention", message: `${moved}, but not in QuickBooks: ${to} has no customer in QuickBooks yet, so there is nowhere to put them there. Create ${to} in QuickBooks first, with “Create in QuickBooks and link” on its page, then send the move from the Reconciliation page, where it is kept.${await money()}` };
  }
  const t = await trySavedItem(saved.item!, saved.write!, { by: "at_once", linkedBy: o.staffUserId, actor: o.actor, ip: o.ip, permission: o.permission });
  switch (t.is) {
    case "done": return { ok: true, message: t.cached ? `${moved} and in QuickBooks.` : `${moved} and in QuickBooks. The roster here shows it after its next read of QuickBooks, usually within a few minutes.` };
    case "found": return { ok: true, message: `${moved}. QuickBooks has them in that family already, so nothing was sent.` };
    case "waiting": return { ok: true, status: "waiting", message: t.sent
      ? `${moved}. The portal can't tell yet whether QuickBooks took the move: its answer didn't arrive. The roster is read again within a few minutes to see, and the portal finishes it then without sending it twice; you'll find it on the Reconciliation page until then.${await money()}`
      : `${moved}. QuickBooks couldn't take it just now, so the move is waiting to reach QuickBooks: the portal tries again in a minute, then less often, and you'll find it on the Reconciliation page.${await money()}` };
    case "refused": return { ok: true, status: "attention", message: `${moved}, but not in QuickBooks. ${keptMoveWords(t.code, t.holds)} The portal keeps the move, and the change is kept on the Reconciliation page, where you can send the portal's move to QuickBooks or give it up.${await money()}` };
    case "given_up": return { ok: true, status: "attention", message: `${moved}. The move was given up on the Reconciliation page while it was on its way to QuickBooks, so nothing more is done for it: QuickBooks has it only if that send got through, which the roster shows after its next read.` };
    case "stuck": case "not_reached": case "not_yet": return { ok: true, status: "attention", message: `${moved}, but not in QuickBooks: see the Reconciliation page.${await money()}` };
  }
}

/* ---- Take QuickBooks' into the app (stage 4's slice M4a; app-owned families spec section 5, "Differences": "Take
   QuickBooks' into the app"; open questions 1, 12, 13 and 14) ----
   On the accounting links screen, someone who may link families to accounting settles a difference by taking the
   books' value into the portal: a record's name, a record the books have inactive made inactive, or a student moved to
   the family the books have them under. Each is the press's own change of the portal's record, saved under the roster
   lock with the page's tag and audited (`accounting.difference.take`) in its transaction, and nothing is sent to
   QuickBooks: no request, and no queue item but the buy-out void a move's follow-ups queue, as every move's do. Since
   slice M4b a take also makes a record active again where the books have its customer active (takeActive()), the only
   path that does (open question 12), and holds its family's sign-ins (`family.signin_held_at`) when the family comes
   back or the take would open it to its guardians: they sign in only once someone who may change families lets them in
   (releaseSigninHold(), src/lib/parents/guardians.ts). A take aligns no link. */

/** What a press on the accounting links screen asked to take, as its page bound it: untrusted ids, looked up again under the roster lock. */
export type TakeAsk =
  | { field: "name" | "inactive" | "active"; kind: "family" | "student"; recordId: string; stamp: string }
  | { field: "place"; studentId: string; stamp: string };
/** What a take answers when the value it would take isn't the one its row showed: nothing is changed. */
export const TAKE_CHANGED = "The books or the portal changed since this page was drawn, so nothing was taken. Look at the row again.";
const TAKE_NOT_LINKED = "That isn't linked to the books, so there is nothing to take from them. Look at the row again.";
const TAKE_NO_FAMILY = "No family of the portal is linked to the family the books have this student under, so nothing was taken. Look at the row again.";
const SENT_NOTHING = "Nothing was sent to the books.";
const ACTIVE_HERE = "That is active in the portal already, so nothing was changed.";
const FAMILY_INACTIVE_HERE = "This student's family is inactive in the portal, so they weren't made active: a family comes first. Take its active status from the books on its own row, then this student's.";
const STUDENT_MOVE_PENDING_ACTIVE = "A move of this student hasn't reached QuickBooks yet (it is waiting, stuck or kept on the Reconciliation page), so they weren't made active. Finish it there, or give it up, then try again.";
/** What a take that leaves a family's sign-ins held says, in its answer and beside its press (the owner's choice 5, as the lead recommends it). */
export const heldWords = (familyWords: string) => `${familyWords}'s guardians can't sign in to it until someone who may change families lets them in, on its page.`;
/** Said when a make-inactive of the customer is kept on Reconciliation: the portal's earlier change, which a take leaves as it is. */
export const KEPT_OFF_STAYS = "A make-inactive of its customer kept on the Reconciliation page stays there, as the portal's earlier change: only Send the portal's value or Give up there settles it.";
const isOrAre = (names: readonly string[]) => (names.length === 1 ? "is" : "are");

/**
 * Takes the books' value of one difference into the portal (stage 4's slice M4a), from the accounting links screen's
 * press alone (takeDifferenceAction()), holding the record's "being sent" lock (whileSending(): the family's, or the
 * student's) for its whole run, so no rename, make-inactive or move of it runs meanwhile. A name (takeName()), a record
 * made inactive (takeInactive()), a record made active again (takeActive(), slice M4b) or the family a student is
 * under (moveHolding() with `take`): each works the value
 * out again under the roster lock and refuses, changing nothing, when the row's stamp doesn't seal it (TAKE_CHANGED).
 */
export async function takeFromBooks(ask: TakeAsk, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  const raw = ask.field === "place" ? ask.studentId : ask.recordId;
  if (!isUuid(raw)) return refuse(WRITE_COPY.gone);
  const recordId = raw.toLowerCase();
  const kind = ask.field === "place" ? "student" : ask.kind;
  const held = await whileSending(recordId, () => (ask.field === "name" ? takeName(kind, recordId, ask.stamp, rosterTag, o)
    : ask.field === "inactive" ? takeInactive(kind, recordId, ask.stamp, rosterTag, o)
    : ask.field === "active" ? takeActive(kind, recordId, ask.stamp, rosterTag, o) : takePlace(asAppStudentId(recordId), ask.stamp, rosterTag, o)));
  return held ?? refuse(kind === "student" ? STUDENT_BEING_CHANGED : FAMILY_BEING_CHANGED);
}

/**
 * A take's checks under the roster lock with the page's tag: the roster's company known, the books not connected to
 * another, the shape holding. No live connection: nothing is sent or read live. With the cache, for the customer.
 */
async function takeReady(tx: Tx, rosterTag: string): Promise<{ ok: true; shape: MembershipShape; source: string; cache: (Cust & { syncToken: string })[] } | { ok: false; error: string }> {
  if (!(await lockRosterAs(tx, rosterTag))) return { ok: false, error: ROSTER_MOVED };
  const [shape, source, holds, other] = await Promise.all([getShape(tx), getRosterSource(tx), shapeHolds(tx), connectedToAnotherCompany(tx)]);
  if (other) return { ok: false, error: WRITE_COPY.otherCompany };
  if (!shape || !holds || source === null) return { ok: false, error: WRITE_COPY.noRoster };
  return { ok: true, shape, source, cache: await cacheRows(tx) };
}

type TakeRecord = { name: string | null; active: boolean; familyId: AppFamilyId; studentId: AppStudentId | null; familyName: string | null; customer: string | null };
/**
 * The record a take is of, locked for the transaction: a family (its own active flag) or a student (active only in an
 * active family), its family, and its own link's customer of its kind in the roster's company (null: none).
 */
async function takeRecordOf(tx: Tx, kind: "family" | "student", recordId: string): Promise<({ ok: true } & TakeRecord) | { ok: false; error: string }> {
  if (kind === "family") {
    const [f] = await tx.select().from(family).where(eq(family.id, asAppFamilyId(recordId))).for("update");
    if (!f) return { ok: false, error: WRITE_COPY.gone };
    return { ok: true, name: f.name, active: f.active, familyId: f.id, studentId: null, familyName: f.name, customer: await customerOfFamily(f.id, tx) };
  }
  const [s] = await tx.select().from(student).where(eq(student.id, asAppStudentId(recordId))).for("update");
  if (!s || s.familyId === null) return { ok: false, error: WRITE_COPY.gone };
  const [f] = await tx.select({ name: family.name, active: family.active }).from(family).where(eq(family.id, s.familyId));
  return { ok: true, name: s.name, active: s.active && f?.active === true, familyId: s.familyId, studentId: s.id, familyName: f?.name ?? null, customer: await customerOfStudent(s.id, tx) };
}

/**
 * A name taken from the books, in one transaction under the roster lock: the record active (a student's family too),
 * linked, its customer in the cache with nothing waiting or stuck for it, the books' name one checkName() takes and,
 * for a family or member, no other active family's; the stamp sealing the books' name exactly. Then a kept rename of
 * the customer is closed as replaced by the take, the record renamed and the take audited.
 */
async function takeName(kind: "family" | "student", recordId: string, stamp: string, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  return db.transaction(async (tx): Promise<WriteResult> => {
    const ready = await takeReady(tx, rosterTag);
    if (!ready.ok) return refuse(ready.error);
    const r = await takeRecordOf(tx, kind, recordId);
    if (!r.ok) return refuse(r.error);
    if (!r.active) return refuse(INACTIVE_HERE);
    if (r.customer === null) return refuse(TAKE_NOT_LINKED);
    const c = ready.cache.find((x) => x.qboId === r.customer);
    if (!c) return refuse(WRITE_COPY.gone);
    if (await waitingForCustomer(tx, c.qboId)) return refuse(WRITE_COPY.waiting);
    const name = checkName(c.displayName);
    if (!name.ok) return refuse(`The books' name is “${c.displayName}”, which the portal can't take as a name: ${name.error} Rename the record on its page instead, or the customer in QuickBooks.`);
    if (r.name === name.name) return refuse(ALREADY_NAMED);
    if (kind === "family") {
      const noun = ready.shape.kind === "flat" ? "member" : "family";
      if (nameIn(name.name, await portalFamilyNames(tx, r.familyId))) {
        return refuse(`Another ${noun} in the portal is called “${name.name}”, and every ${noun}'s name must be different, so nothing was taken. Rename one of them on its page, or the customer in QuickBooks.`);
      }
    }
    if (!takeStampHolds("name", recordId, c.qboId, [c.displayName], stamp)) return refuse(TAKE_CHANGED);
    const replaced = await replaceRefused(tx, renamesOf(c.qboId), { op: "take", field: "name", recordId }, o);
    const now = new Date();
    if (kind === "family") await tx.update(family).set({ name: name.name, updatedAt: now }).where(eq(family.id, r.familyId));
    else await tx.update(student).set({ name: name.name, updatedAt: now }).where(eq(student.id, r.studentId!));
    await writeAudit({ actor: o.actor, action: "accounting.difference.take", permission: o.permission, ip: o.ip, targetType: kind, targetId: recordId,
      before: { name: r.name }, after: { field: "name", kind, familyId: String(r.familyId), ...(kind === "student" ? { studentId: recordId } : {}), customerQboId: c.qboId,
        name: name.name, replaced: replaced.map((x) => x.id) } }, tx);
    const closed = replaced.length ? " The rename kept on the Reconciliation page is closed, as this takes its place." : "";
    return { ok: true, message: `Renamed ${name.name} in the portal, as the books have it. ${SENT_NOTHING}${closed}` };
  });
}

/**
 * The active student records of a family that a take of it as inactive goes with, each with its own link's customer
 * (null: none), by name then id.
 */
async function takenWith(tx: Tx, familyId: AppFamilyId, lock: boolean): Promise<{ id: AppStudentId; name: string | null; customer: string | null }[]> {
  const q = tx.select({ id: student.id, name: student.name }).from(student).where(and(eq(student.familyId, familyId), eq(student.active, true)));
  const rows = lock ? await q.for("update") : await q;
  const links = await linksOf({ families: [], students: rows.map((s) => s.id) }, tx);
  return rows.map((s) => ({ id: s.id, name: s.name, customer: links.customerOfStudent.get(s.id) ?? null }))
    .sort((a, b) => COLLATOR.compare(a.name ?? "", b.name ?? "") || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
}

/**
 * A record made inactive as the books have its customer, in one transaction under the roster lock: the record active
 * and linked, its customer inactive in the cache with nothing waiting or stuck for it, the family's own create neither
 * waiting nor being sent. A student: their own create not waiting, no move of theirs waiting, stuck or kept. A layered
 * family: no move into or out of it pending, and every active student record of it either with no link (and no create
 * of theirs waiting) or linked to a customer the cache holds inactive with nothing waiting for it; it goes inactive
 * with them, as a family made inactive in the portal goes with its students. A member (flat books) is its family. No
 * balance is read: the books hold the customer inactive already, and QuickBooks makes no customer with a balance
 * inactive. A kept make-inactive of a customer it takes is closed as replaced by it. Each record changed has its row.
 */
async function takeInactive(kind: "family" | "student", recordId: string, stamp: string, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  return db.transaction(async (tx): Promise<WriteResult> => {
    const ready = await takeReady(tx, rosterTag);
    if (!ready.ok) return refuse(ready.error);
    const r = await takeRecordOf(tx, kind, recordId);
    if (!r.ok) return refuse(r.error);
    if (!r.active) return refuse(INACTIVE_HERE);
    if (r.customer === null) return refuse(TAKE_NOT_LINKED);
    const c = ready.cache.find((x) => x.qboId === r.customer);
    if (!c) return refuse(WRITE_COPY.gone);
    if (c.active) return refuse(TAKE_CHANGED);
    if (await waitingForCustomer(tx, c.qboId)) return refuse(WRITE_COPY.waiting);
    const making = await familyCreateWaiting(tx, r.familyId);
    if (making) return refuse(making === "sending" ? FAMILY_SENDING : FAMILY_WAITING);
    const familyWords = recordNameWords(r.familyName, "family");
    const audit = (targetType: "family" | "student", targetId: string, after: Record<string, unknown>) =>
      writeAudit({ actor: o.actor, action: "accounting.difference.take", permission: o.permission, ip: o.ip, targetType, targetId, before: { active: true }, after: { field: "inactive", ...after, active: false } }, tx);
    const offs = (customers: readonly string[]) => and(inArray(writeQueue.targetQboId, [...customers]), sql`${writeQueue.request}->>'op' = 'deactivate'`);
    const closedWords = (n: number) => (n === 0 ? "" : n === 1 ? " The make-inactive kept on the Reconciliation page is closed, as this takes its place."
      : " The make-inactives kept on the Reconciliation page are closed, as this takes their place.");

    if (kind === "student") {
      if (await studentCreateWaiting(tx, r.studentId!)) return refuse(STUDENT_WAITING);
      const moves = await tx.select({ id: writeQueue.id }).from(writeQueue).where(and(movesOf(r.studentId!), inArray(writeQueue.state, ["waiting", "stuck", "refused"]))).limit(1);
      if (moves.length) return refuse(STUDENT_MOVE_PENDING);
      if (!takeStampHolds("inactive", recordId, c.qboId, [], stamp)) return refuse(TAKE_CHANGED);
      const replaced = await replaceRefused(tx, offs([c.qboId]), { op: "take", field: "inactive", recordId }, o);
      const change = await changeOwnRecord(tx, { op: "deactivate", role: "student", qboId: c.qboId, syncToken: "" }, c.qboId, { realmId: ready.source, linkedBy: o.staffUserId, studentId: r.studentId });
      if (!change) return refuse(TAKE_CHANGED);
      await audit("student", recordId, { kind: "student", studentId: recordId, familyId: String(r.familyId), customerQboId: c.qboId, replaced: replaced.map((x) => x.id) });
      // Who may sign in goes by the family's active students while the students rule is in force (enterableGuardianRows()).
      const leftCloses = (await studentsRuleInForce(tx)) && (await takenWith(tx, r.familyId, false)).length === 0;
      return { ok: true, message: `Made ${recordNameWords(r.name, "student")} inactive in the portal, as the books have them. ${SENT_NOTHING}${closedWords(replaced.length)}`
        + (leftCloses ? ` ${familyWords} has no active student now, so its guardians can't sign in to it until it has one again.` : "") };
    }

    const layered = ready.shape.kind === "layered";
    if (await familyMovePending(tx, r.familyId, c.qboId)) return refuse(MOVE_PENDING);
    // In flat books a member stands alone; a layered family goes inactive with its active students.
    const under = layered ? await takenWith(tx, r.familyId, true) : [];
    const stillActive: string[] = [], notHeld: string[] = [];
    for (const s of under) {
      const sc = s.customer === null ? undefined : ready.cache.find((x) => x.qboId === s.customer);
      if (s.customer === null) { if (await studentCreateWaiting(tx, s.id)) return refuse(STUDENT_WAITING); }
      else if (sc === undefined) notHeld.push(recordNameWords(s.name, "student"));
      else if (sc.active) stillActive.push(recordNameWords(s.name, "student"));
      else if (await waitingForCustomer(tx, sc.qboId)) return refuse(WRITE_COPY.waiting);
    }
    if (stillActive.length) return refuse(`${stillActive.join(", ")} ${isOrAre(stillActive)} still active in the books, so the family can't be taken as inactive until they are made inactive there or moved.`);
    if (notHeld.length) return refuse(`The books' copy doesn't hold the customer of ${notHeld.join(", ")} now, so the family can't be taken as inactive. Look at the row again after the next read of the books.`);
    if (!takeStampHolds("inactive", recordId, c.qboId, under.map((s) => String(s.id)).sort(), stamp)) return refuse(TAKE_CHANGED);
    const customers = [c.qboId, ...under.flatMap((s) => (s.customer === null ? [] : [s.customer]))];
    const replaced = await replaceRefused(tx, offs(customers), { op: "take", field: "inactive", recordId }, o);
    const replacedOf = (customer: string | null) => replaced.filter((x) => x.request.op === "deactivate" && x.request.qboId === customer).map((x) => x.id);
    const now = new Date();
    if (under.length) await tx.update(student).set({ active: false, updatedAt: now }).where(inArray(student.id, under.map((s) => s.id)));
    await tx.update(family).set({ active: false, updatedAt: now }).where(eq(family.id, r.familyId));
    for (const s of under) {
      await audit("student", String(s.id), { kind: "student", studentId: String(s.id), familyId: String(r.familyId), customerQboId: s.customer, withFamily: true, replaced: replacedOf(s.customer) });
    }
    await audit("family", recordId, { kind: "family", familyId: recordId, customerQboId: c.qboId, students: under.map((s) => String(s.id)), replaced: replacedOf(c.qboId) });
    const noun = layered ? "family" : "member";
    const withThem = under.length === 0 ? "" : `, with ${under.length === 1 ? "its student" : `its ${under.length} students`} ${under.map((s) => recordNameWords(s.name, "student")).join(", ")}`;
    return { ok: true, message: `Made ${familyWords} inactive in the portal${withThem}, as the books have it. ${SENT_NOTHING} Its guardians can't sign in to the ${noun} now.${closedWords(replaced.length)}` };
  });
}

/**
 * Whether a make-inactive of this customer is kept refused on the queue (the portal's earlier change, QuickBooks refused
 * it): a take of active leaves it as it is, and says so.
 */
async function offKept(tx: Tx, customer: string): Promise<boolean> {
  return (await tx.select({ id: writeQueue.id }).from(writeQueue)
    .where(and(eq(writeQueue.targetQboId, customer), eq(writeQueue.state, "refused"), sql`${writeQueue.request}->>'op' = 'deactivate'`)).limit(1)).length > 0;
}

/**
 * A record made active again as the books have its customer (stage 4's slice M4b; open question 12: the only way a
 * record becomes active again), in one transaction under the roster lock with the page's tag, sending nothing. A
 * student: their record inactive, in a family record that is active (a student of an inactive family isn't taken: the
 * family comes first, and its own take leaves its students inactive); linked, the cache holding the customer active and
 * the roster listing it directly under the customer the family's own link names (differencesOf()'s condition for the
 * difference); nothing waiting or stuck for the customer, no move of theirs waiting, stuck or kept, the family's create
 * neither waiting nor being sent. A family or member: its record inactive; linked, the cache holding the customer active
 * and the roster listing it as a family or member that stands (linkStanding()); nothing waiting or stuck for it, no move
 * into or out of it pending, its create neither waiting nor being sent, and its name, when it has one, held by no active
 * family. The stamp seals, for a student, whether the family's sign-ins are held after the take (`holds`: the take
 * would open the family to its guardians, as the students rule is in force and the family has no active student, or a
 * hold stands already), and for a family its own name, which the name check is made on. Then the record is made active
 * alone (a family's students stay inactive, each with its own press once the family is listed), its family's sign-ins
 * held when the family comes back, or when the student's take opens it (a family keeps a hold it has: its first), and
 * one audit row, `accounting.difference.take`, saying whether this take set the hold. No guardian row is touched: none
 * is opened, closed or reinstated. A make-inactive of the customer kept on Reconciliation stays as it is (the portal's
 * earlier change: only Send or Give up settles it), said when there is one.
 */
async function takeActive(kind: "family" | "student", recordId: string, stamp: string, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  return db.transaction(async (tx): Promise<WriteResult> => {
    const ready = await takeReady(tx, rosterTag);
    if (!ready.ok) return refuse(ready.error);
    const roster = buildRoster(ready.shape, ready.cache);
    const now = new Date();
    const hold = { signinHeldAt: now, signinHeldBy: o.staffUserId };
    const audit = (targetType: "family" | "student", after: Record<string, unknown>) =>
      writeAudit({ actor: o.actor, action: "accounting.difference.take", permission: o.permission, ip: o.ip, targetType, targetId: recordId, before: { active: false },
        after: { field: "active", kind: targetType, ...after, active: true } }, tx);
    const keptWords = async (customer: string) => ((await offKept(tx, customer)) ? ` ${KEPT_OFF_STAYS}` : "");

    if (kind === "student") {
      const [s] = await tx.select().from(student).where(eq(student.id, asAppStudentId(recordId))).for("update");
      if (!s || s.familyId === null) return refuse(WRITE_COPY.gone);
      const [f] = await tx.select().from(family).where(eq(family.id, s.familyId)).for("update");
      if (!f) return refuse(WRITE_COPY.gone);
      if (s.active) return refuse(ACTIVE_HERE);
      if (!f.active) return refuse(FAMILY_INACTIVE_HERE);
      const customer = await customerOfStudent(s.id, tx);
      if (customer === null) return refuse(TAKE_NOT_LINKED);
      const c = ready.cache.find((x) => x.qboId === customer);
      if (!c) return refuse(WRITE_COPY.gone);
      const familyCustomer = await customerOfFamily(f.id, tx);
      const listedUnder = familyCustomer !== null && roster.kind === "layered"
        && (roster.families.find((x) => x.customer.qboId === familyCustomer)?.students.some((x) => x.qboId === c.qboId) ?? false);
      if (!c.active || !listedUnder) return refuse(TAKE_CHANGED);
      if (await waitingForCustomer(tx, c.qboId)) return refuse(WRITE_COPY.waiting);
      const moves = await tx.select({ id: writeQueue.id }).from(writeQueue).where(and(movesOf(s.id), inArray(writeQueue.state, ["waiting", "stuck", "refused"]))).limit(1);
      if (moves.length) return refuse(STUDENT_MOVE_PENDING_ACTIVE);
      const making = await familyCreateWaiting(tx, f.id);
      if (making) return refuse(making === "sending" ? FAMILY_SENDING : FAMILY_WAITING);
      // Who may sign in goes by the family's active students while the students rule is in force (enterableGuardianRows()):
      // a take that gives the family its first active student would open it, so it holds the family's sign-ins.
      const others = await tx.select({ id: student.id }).from(student).where(and(eq(student.familyId, f.id), eq(student.active, true))).limit(1);
      const opens = (await studentsRuleInForce(tx)) && others.length === 0;
      const holds = opens || f.signinHeldAt !== null;
      if (!takeStampHolds("active", recordId, c.qboId, [holds], stamp)) return refuse(TAKE_CHANGED);
      const sets = opens && f.signinHeldAt === null;
      await tx.update(student).set({ active: true, updatedAt: now }).where(eq(student.id, s.id));
      if (sets) await tx.update(family).set({ ...hold, updatedAt: now }).where(eq(family.id, f.id));
      await audit("student", { familyId: String(f.id), studentId: recordId, customerQboId: c.qboId, held: sets });
      return { ok: true, message: `Made ${recordNameWords(s.name, "student")} active in the portal, as the books have them. ${SENT_NOTHING}`
        + (holds ? ` ${heldWords(recordNameWords(f.name, "family"))}` : "") + (await keptWords(c.qboId)) };
    }

    const [f] = await tx.select().from(family).where(eq(family.id, asAppFamilyId(recordId))).for("update");
    if (!f) return refuse(WRITE_COPY.gone);
    if (f.active) return refuse(ACTIVE_HERE);
    const customer = await customerOfFamily(f.id, tx);
    if (customer === null) return refuse(TAKE_NOT_LINKED);
    const c = ready.cache.find((x) => x.qboId === customer);
    if (!c) return refuse(WRITE_COPY.gone);
    const listedAsFamily = new Set(roster.kind === "flat" ? roster.members.map((m) => m.qboId) : roster.families.map((x) => x.customer.qboId));
    if (!c.active || linkStanding(c, { cacheHasCustomers: true, listedAsFamily }).is !== "stands") return refuse(TAKE_CHANGED);
    if (await waitingForCustomer(tx, c.qboId)) return refuse(WRITE_COPY.waiting);
    if (await familyMovePending(tx, f.id, c.qboId)) return refuse(MOVE_PENDING);
    const making = await familyCreateWaiting(tx, f.id);
    if (making) return refuse(making === "sending" ? FAMILY_SENDING : FAMILY_WAITING);
    const noun = ready.shape.kind === "flat" ? "member" : "family";
    const familyWords = recordNameWords(f.name, "family");
    if (f.name !== null && nameIn(f.name, await portalFamilyNames(tx, f.id))) {
      return refuse(`Another ${noun} in the portal is called “${f.name}”, and every ${noun}'s name must be different, so ${familyWords} wasn't made active. Rename one of them on its page first.`);
    }
    if (!takeStampHolds("active", recordId, c.qboId, [f.name], stamp)) return refuse(TAKE_CHANGED);
    const sets = f.signinHeldAt === null;
    await tx.update(family).set({ active: true, ...(sets ? hold : {}), updatedAt: now }).where(eq(family.id, f.id));
    await audit("family", { familyId: recordId, customerQboId: c.qboId, held: sets });
    const [withStudents] = noun === "family" ? await tx.select({ id: student.id }).from(student).where(eq(student.familyId, f.id)).limit(1) : [];
    const students = withStudents ? " Its students stay inactive in the portal: each the books have active shows on the family's row, with a press of its own." : "";
    return { ok: true, message: `Made ${familyWords} active in the portal, as the books have it. ${SENT_NOTHING}${students} ${heldWords(familyWords)}${await keptWords(c.qboId)}` };
  });
}

/**
 * The family a student is under taken from the books: the family record linked to the customer the cache has the
 * student's customer directly under, found here, then moved to by moveHolding()'s own checks and follow-ups (`take`),
 * which find the same under the roster lock or refuse, sending nothing.
 */
async function takePlace(studentId: AppStudentId, stamp: string, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  const customer = await customerOfStudent(studentId);
  if (customer === null) return refuse(TAKE_NOT_LINKED);
  const [cached] = await db.select({ parentQboId: qboCustomer.parentQboId }).from(qboCustomer).where(eq(qboCustomer.qboId, customer));
  if (!cached) return refuse(WRITE_COPY.gone);
  const toFamilyId = cached.parentQboId === null ? null : await familyLinkedTo(cached.parentQboId);
  if (toFamilyId === null) return refuse(TAKE_NO_FAMILY);
  return moveHolding(studentId, toFamilyId, rosterTag, o, { stamp });
}

/* ---- Send the app's to QuickBooks (stage 4's slice M5a; app-owned families spec section 5, "Differences": "Send the
   app's to QuickBooks"; open questions 10, 11, 12 and 14) ----
   On the accounting links screen, staff who may link families to accounting and change families settle a difference by
   sending the portal's value to QuickBooks over the one the books show: a record's name, the family a student is under,
   or a student or member inactive in the portal whose customer the books have active. Each goes through a write the
   portal makes today, with today's body: a rename and a move saved first, queued in the press's transaction and tried
   at once (queueSaved(), trySavedItem()), so a stale answer is settled by the field against the books' value the row
   showed (`was`, `fromFamilyQboId`), never the portal's last agreed one; a make-inactive QuickBooks first, the balance
   read live before it is sent (tryDeactivate(), open question 11), never queued but for a lost answer. Nothing here
   makes a customer active (open question 12): the one active flag write is sendWrite()'s, with `false`. The portal's
   records are changed by nothing here but what applyWritten() does with an answer, as for every write. */

/** What a press on the accounting links screen asked to send, as its page bound it: untrusted ids, looked up again under the roster lock. */
export type SendAsk =
  | { field: "name"; kind: "family" | "student"; recordId: string; stamp: string }
  | { field: "inactive"; kind: "family" | "student"; recordId: string; stamp: string }
  | { field: "place"; studentId: string; stamp: string };
/** What a send answers when the value it would send over isn't the one its row showed: nothing is sent. */
export const SEND_CHANGED = "The books or the portal changed since this page was drawn, so nothing was sent. Look at the row again.";
const SEND_NOT_LINKED = "That isn't linked to the books, so there is nothing to send it to. Look at the row again.";
export const SEND_FAMILY_NOT_LINKED = "The student's family in the portal isn't linked to an active family customer in the books, so there is nowhere to send them to. Look at the row again.";
/** A name another customer in the books holds: the portal's name is the one sent, so no other is offered. */
export const sendNameTakenWords = (name: string) =>
  `QuickBooks has another customer named “${name}”, and every name there must be different, so nothing was sent. Rename the record on its page instead, to a name QuickBooks doesn't hold.`;
/** A name only a create or rename waiting or stuck on the queue holds: on its way to QuickBooks, which doesn't have it yet. */
export const sendNameQueuedWords = (name: string) =>
  `A change on its way to QuickBooks, on the Reconciliation page, gives another customer the name “${name}”, and every name there must be different, so nothing was sent. Rename the record on its page instead, or give that change up.`;
const SEND_NAME_UNUSABLE =(error: string) => `The portal's name for this record can't be sent to QuickBooks as it is: ${error} Rename the record on its page instead.`;
/** A family of layered books is made inactive only together with everyone under it: never sent from a difference. */
export const SEND_FAMILY_INACTIVE = "The books make a family inactive only together with everyone under it, so this family's inactive status isn't sent from here.";
const SEND_STUDENT_FAMILY_INACTIVE = "This student's family is inactive in the portal, so nothing was sent for the student.";

/**
 * Sends the portal's value of one difference to QuickBooks (stage 4's slice M5a), from the accounting links screen's
 * press alone (sendDifferenceAction()), holding the record's "being sent" lock (whileSending(): the family's for a
 * family or member, the student's otherwise) for its whole run, so no rename, make-inactive, move or take of it runs
 * meanwhile, and a change saved first is tried at once under the lock it is sent under (lockOfItem()). A name
 * (sendName()), a student's family (sendPlace()) or a student or member made inactive (sendInactive()): each works the
 * value out again under the roster lock and refuses, sending nothing, when the row's stamp doesn't seal it (SEND_CHANGED).
 */
export async function sendToBooks(ask: SendAsk, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  const raw = ask.field === "place" ? ask.studentId : ask.recordId;
  if (!isUuid(raw)) return refuse(WRITE_COPY.gone);
  const recordId = raw.toLowerCase();
  const kind = ask.field === "place" ? "student" : ask.kind;
  const held = await whileSending(recordId, () => (ask.field === "name" ? sendName(kind, recordId, ask.stamp, rosterTag, o)
    : ask.field === "inactive" ? sendInactive(kind, recordId, ask.stamp, rosterTag, o) : sendPlace(asAppStudentId(recordId), ask.stamp, rosterTag, o)));
  return held ?? refuse(kind === "student" ? STUDENT_BEING_CHANGED : FAMILY_BEING_CHANGED);
}

/** The version the portal last aligned with on a customer's link of one kind in the records' company: "" for none, which a send settles by a live read. */
async function linkVersionOf(tx: Tx, source: string, customer: string, kind: "family" | "student"): Promise<string> {
  const [link] = await tx.select({ syncedToken: accountingLink.syncedToken }).from(accountingLink)
    .where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, source), eq(accountingLink.customerId, customer),
      kind === "family" ? isNotNull(accountingLink.familyId) : isNotNull(accountingLink.studentId)));
  return link?.syncedToken ?? "";
}

/** What a send queues in the caller's transaction (queueSendIn()): a name, or a student's family. */
export type QueueAsk = Exclude<SendAsk, { field: "inactive" }>;
/** What readyToSend() found, for a caller that queues sends in its own transaction under the roster lock (queueSendIn()). */
export type SendReady = Extract<Awaited<ReturnType<typeof readyToSend>>, { ok: true }>;
/**
 * What queueSendIn() answers: the item queued, with what the at-once try needs (a place: whom it moves, to which family,
 * in words), or the refusal, nothing saved. `busy`: with `lock: "try"`, someone held the record's "being sent" lock.
 */
export type QueuedSend =
  | { ok: true; field: "name"; write: RenameWrite; item: QueueRow }
  | { ok: true; field: "place"; write: MoveWrite; item: QueueRow; who: string; to: string; toFamilyId: AppFamilyId }
  | { ok: false; result: WriteResult; busy?: true };
type QueueHow = { pressId?: string; lock: "held" | "try" };
const bulkOf = (how: QueueHow) => (how.pressId === undefined ? {} : { bulk: how.pressId });

/**
 * The in-transaction half of a send of a name or a student's family (stage 4's slice M5b: moved out of sendName() and
 * sendPlace(), unchanged), in the caller's transaction, which holds the roster lock and has found what readyToSend()
 * finds (`ready`): every check, the stamp, a kept change of the record closed as replaced (replaceRefused()), the
 * change queued as one saved first (queueSaved(), waiting out SAVED_LEASE_MS before the worker may take it) and the
 * `accounting.difference.send` row, with `bulk` when a press of Send the app's for all queued it (`pressId`). It sends
 * nothing and tries nothing: a single send tries the item after its commit, and the bulk leaves it to the queue's
 * worker. `lock`: `held`, the caller holds the record's "being sent" lock already (sendToBooks()'s whileSending());
 * `try`, it is tried here, exclusively, and held to the caller's commit, and a record someone holds it for is refused
 * (`busy`), never waited for (a send holds it and then waits for the roster lock, which the caller holds).
 */
export async function queueSendIn(tx: Tx, ready: SendReady, ask: QueueAsk, o: WriteOp & { staffUserId: string }, how: QueueHow): Promise<QueuedSend> {
  const recordId = ask.field === "place" ? ask.studentId : ask.recordId;
  const kind = ask.field === "place" ? "student" : ask.kind;
  if (how.lock === "try") {
    const [lock] = (await tx.execute(sql`select pg_try_advisory_xact_lock(${sql.raw(String(SENDING_LOCK))}, hashtext(${recordId}::text)) as locked`)) as unknown as { locked: boolean }[];
    if (!lock?.locked) return { ok: false, result: refuse(kind === "student" ? STUDENT_BEING_CHANGED : FAMILY_BEING_CHANGED), busy: true };
  }
  return ask.field === "name" ? queueNameIn(tx, ready, kind, recordId, ask.stamp, o, how) : queuePlaceIn(tx, ready, asAppStudentId(recordId), ask.stamp, o, how);
}

/** queueSendIn() for a name: sendName()'s checks, the stamp, the kept rename replaced, the rename queued and audited. */
async function queueNameIn(tx: Tx, ready: SendReady, kind: "family" | "student", recordId: string, stamp: string, o: WriteOp & { staffUserId: string }, how: QueueHow): Promise<QueuedSend> {
  const no = (error: string): QueuedSend => ({ ok: false, result: refuse(error) });
  const { shape, source, cache, roster } = ready;
  const r = await takeRecordOf(tx, kind, recordId);
  if (!r.ok) return no(r.error);
  if (!r.active) return no(INACTIVE_HERE);
  if (r.customer === null) return no(SEND_NOT_LINKED);
  const c = cache.find((x) => x.qboId === r.customer);
  const where = c ? roleIn(roster, c.qboId) : null;
  if (!c || !where || (kind === "family" ? where.role !== "family" && where.role !== "member" : where.role !== "student")) return no(WRITE_COPY.gone);
  // The portal never sends a change to a customer QuickBooks has inactive, and never makes one active.
  if (!c.active) return no(INACTIVE_THERE);
  if (!offers(shape, renameOf(where.role))) return no(WRITE_COPY.notOffered);
  if (await waitingForCustomer(tx, c.qboId)) return no(WRITE_COPY.waiting);
  const name = checkName(r.name ?? "");
  if (!name.ok) return no(SEND_NAME_UNUSABLE(name.error));
  if (name.name !== r.name) return no(SEND_NAME_UNUSABLE("it isn't written as the portal writes names."));
  // Held by another customer in the books, or only by a create or rename on its way there: said as which it is.
  if (nameIn(name.name, await namesTaken(tx, cache, c.qboId))) {
    return no(nameIn(name.name, cache.filter((x) => x.qboId !== c.qboId).map((x) => x.displayName)) ? sendNameTakenWords(name.name) : sendNameQueuedWords(name.name));
  }
  if (!sendStampHolds("name", recordId, c.qboId, [c.displayName, r.name], stamp)) return no(SEND_CHANGED);
  // The send takes the place of a rename of the customer kept on Reconciliation, the portal's earlier change.
  const replaced = await replaceRefused(tx, renamesOf(c.qboId), { op: "send", field: "name", recordId }, o);
  // Overwritten on purpose, but only over what the row showed: `was` is the books' name, so a name QuickBooks has
  // changed to since is held by the field (tryRename()), never sent over.
  const write: RenameWrite = { op: "rename", role: where.role, qboId: c.qboId, syncToken: await linkVersionOf(tx, source, c.qboId, kind), name: name.name, was: c.displayName };
  const item = await queueSaved(tx, write, source, { familyId: r.familyId, studentId: r.studentId }, o);
  await writeAudit({ actor: o.actor, action: "accounting.difference.send", permission: o.permission, ip: o.ip, targetType: kind, targetId: recordId,
    before: { name: c.displayName }, after: { field: "name", kind, familyId: String(r.familyId), ...(kind === "student" ? { studentId: recordId } : {}), customerQboId: c.qboId,
      name: name.name, queueId: item.id, replaced: replaced.map((x) => x.id), ...bulkOf(how) } }, tx);
  return { ok: true, field: "name", write, item };
}

/** queueSendIn() for a student's family: sendPlace()'s checks, the stamp, the kept move replaced, the move queued and audited. */
async function queuePlaceIn(tx: Tx, ready: SendReady, studentId: AppStudentId, stamp: string, o: WriteOp & { staffUserId: string }, how: QueueHow): Promise<QueuedSend> {
  const no = (error: string): QueuedSend => ({ ok: false, result: refuse(error) });
  const { shape, source, cache, roster } = ready;
  const [s] = await tx.select().from(student).where(eq(student.id, studentId)).for("update");
  if (!s || s.familyId === null) return no(WRITE_COPY.gone);
  const [f] = await tx.select().from(family).where(eq(family.id, s.familyId));
  if (!s.active || !f?.active) return no(INACTIVE_HERE);
  if (!offers(shape, "move_student")) return no(WRITE_COPY.notOffered);
  const studentCustomer = await customerOfStudent(s.id, tx);
  if (studentCustomer === null) return no(SEND_NOT_LINKED);
  const familyCustomer = await customerOfFamily(f.id, tx);
  const fc = familyCustomer === null ? undefined : cache.find((x) => x.qboId === familyCustomer);
  const listedAsFamily = new Set(roster.kind === "flat" ? roster.members.map((m) => m.qboId) : roster.families.map((x) => x.customer.qboId));
  if (familyCustomer === null || !fc?.active || linkStanding(fc, { cacheHasCustomers: true, listedAsFamily }).is !== "stands") return no(SEND_FAMILY_NOT_LINKED);
  const c = cache.find((x) => x.qboId === studentCustomer);
  if (!c) return no(WRITE_COPY.gone);
  if (!c.active) return no(INACTIVE_THERE);
  if (c.parentQboId === familyCustomer) return no(SEND_CHANGED);
  // The family record the books have the student under now, when its customer is one a family record is linked to.
  const fromFamilyId = c.parentQboId === null ? null : await familyLinkedTo(c.parentQboId, tx);
  // Both families, by the rule a move goes by: the student's, and the one the books have them under, whose "being
  // sent" lock askFamilyInactive() holds for its whole run, so a family being made inactive with everyone under it
  // never makes this student inactive under the family the move sends them to.
  const families = fromFamilyId === null ? [f.id] : [f.id, fromFamilyId];
  const refusals = await moveRefusals(tx, families, { locks: true });
  for (const id of families) { const why = refusals.get(String(id)); if (why) return no(why); }
  if (await studentCreateWaiting(tx, s.id)) return no(STUDENT_WAITING);
  for (const customer of [studentCustomer, familyCustomer, c.parentQboId]) if (customer !== null && (await waitingForCustomer(tx, customer))) return no(WRITE_COPY.waiting);
  if (!sendStampHolds("place", String(s.id), studentCustomer, [studentCustomer, c.parentQboId ?? "", String(f.id), familyCustomer], stamp)) return no(SEND_CHANGED);
  // The send takes the place of a move of the student kept on Reconciliation, the portal's earlier change.
  const replaced = await replaceRefused(tx, movesOf(s.id), { op: "send", field: "place", studentId: String(s.id) }, o);
  // Overwritten on purpose, but only over what the row showed: the move's before-value is the customer the cache has
  // them under, so a place QuickBooks has moved them to since is held by the field (tryMove()), never sent over.
  const write: MoveWrite = { op: "move", role: "student", qboId: studentCustomer, syncToken: await linkVersionOf(tx, source, studentCustomer, "student"),
    fromFamilyQboId: c.parentQboId ?? TOP_OF_TREE, toFamilyQboId: familyCustomer, ...(fromFamilyId !== null ? { fromFamilyId } : {}), toFamilyId: f.id };
  const item = await queueSaved(tx, write, source, { familyId: fromFamilyId ?? f.id, studentId: s.id }, o);
  await writeAudit({ actor: o.actor, action: "accounting.difference.send", permission: o.permission, ip: o.ip, targetType: "student", targetId: String(s.id),
    before: { familyQboId: c.parentQboId }, after: { field: "place", kind: "student", studentId: String(s.id), familyId: String(f.id), ...(fromFamilyId !== null ? { fromFamilyId: String(fromFamilyId) } : {}),
      customerQboId: studentCustomer, familyQboId: familyCustomer, queueId: item.id, replaced: replaced.map((x) => x.id), ...bulkOf(how) } }, tx);
  return { ok: true, field: "place", write, item, who: recordNameWords(s.name, "student"), to: recordNameWords(f.name, "family"), toFamilyId: f.id };
}

/**
 * The portal's name sent over the books', in one transaction under readyToSend() (a live connection to the roster's
 * company, the shape holding): the record active (a student's family too) and linked in its kind, its customer in the
 * cache, active, on the roster in the role a rename needs, the shape offering it, nothing waiting or stuck for it; the
 * portal's name one checkName() takes as it is and no other customer of the cache, nor a create or rename waiting,
 * holds (nameKey(): refused in words, nothing saved, no other name offered: the portal's is the one sent; said as
 * another customer's, or as a change's on its way there, whichever holds it); the stamp
 * sealing the books' name and the portal's. Then a kept rename of the customer is closed as replaced, the rename queued
 * as a change saved first with the link's own version and `was` the books' name the row showed, and the send audited
 * (`accounting.difference.send`), in that transaction; then tried at once (trySavedItem()). QuickBooks having renamed it
 * again since the row is held by tryRename()'s rule (the live name isn't `was`) and kept, nothing sent over a name nobody
 * was shown. The portal's record isn't changed: it has the name already.
 */
async function sendName(kind: "family" | "student", recordId: string, stamp: string, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  const saved = await db.transaction(async (tx): Promise<QueuedSend> => {
    const ready = await readyToSend(tx, rosterTag);
    if (!ready.ok) return { ok: false, result: refuse(ready.error) };
    return queueSendIn(tx, ready, { field: "name", kind, recordId, stamp }, o, { lock: "held" });
  });
  if (!saved.ok) return saved.result;
  if (saved.field !== "name") throw new Error("queueSendIn() answered for another field than the name asked");
  const { write, item } = saved;
  const said = `“${write.name}”`, was = `“${write.was}”`;
  const t = await trySavedItem(item, write, { by: "at_once", linkedBy: o.staffUserId, actor: o.actor, ip: o.ip, permission: o.permission });
  switch (t.is) {
    case "done": return { ok: true, message: `Sent the portal's name ${said} to QuickBooks, in place of ${was}.${t.cached ? "" : " The roster here shows it after its next read of QuickBooks, usually within a few minutes."}` };
    case "found": return { ok: true, message: `QuickBooks has the name ${said} already, so nothing more was sent.` };
    case "waiting": return { ok: true, status: "waiting", message: t.sent
      ? `The portal can't tell yet whether QuickBooks took the name ${said}: its answer didn't arrive. The roster is read again within a few minutes to see, and the portal finishes it then without sending it twice; you'll find it on the Reconciliation page until then.`
      : `QuickBooks couldn't take the name ${said} just now, so it is waiting to reach QuickBooks: the portal tries again in a minute, then less often, and you'll find it on the Reconciliation page.` };
    case "refused": {
      const why = t.code === "fault_5010" || t.code === "moved_on" || t.code === NO_LINK_VERSION || t.code === NAME_DIFFERS
        ? `The portal held it back: QuickBooks' name changed again since this page was drawn${t.holds ? ` (it has “${t.holds}” now)` : ""}, so the portal's name wasn't sent over it.`
        : keptRefusalWords(t.code, t.holds);
      return { ok: true, status: "attention", message: `The name ${said} wasn't sent to QuickBooks. ${why} The change is kept on the Reconciliation page, where you can send it again or give it up.` };
    }
    case "given_up": return { ok: true, status: "attention", message: `The name ${said} was given up on the Reconciliation page while it was on its way to QuickBooks, so nothing more is done for it: QuickBooks has it only if that send got through, which the roster shows after its next read.` };
    case "stuck": case "not_reached": case "not_yet": return { ok: true, status: "attention", message: `The name ${said} isn't in QuickBooks yet: see the Reconciliation page.` };
  }
}

/**
 * The family a student is in, in the portal, sent to QuickBooks as the customer they are under: in one transaction under
 * readyToSend() and the student's lock (held by sendToBooks()): the student active and linked, in an active family record
 * whose family link stands to an active family customer; the cache holding the student's customer active and not under
 * that customer; the shape offering a move; the family's own create, its locks and its customer's changes by the one rule
 * a move goes by (moveRefusals()), the student's create, and nothing waiting or stuck for the student's customer, the
 * family's or the customer the books have them under; the stamp sealing the student's customer, the customer the cache
 * has them under (`""` for the top of the tree), the family record and its customer. Then a kept move of the student is
 * closed as replaced, the move queued as a change saved first with the student link's own version, `fromFamilyQboId`
 * the customer the row showed them under (TOP_OF_TREE for none) and the family records on both sides where they are
 * (filed under the one the books have them under when it is a family record, else the student's own), and the send
 * audited, in that transaction; then tried at once (trySavedItem()). The portal's record doesn't move, so no follow-up
 * runs (afterStudentMoved()): their forms, volunteer places and buy-outs stay as they are. Whose invoices a family sees
 * follows QuickBooks' tree (open question 14), said in the answer while QuickBooks doesn't have it (moveMoneyNotes()).
 */
async function sendPlace(studentId: AppStudentId, stamp: string, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  const saved = await db.transaction(async (tx): Promise<QueuedSend> => {
    const ready = await readyToSend(tx, rosterTag);
    if (!ready.ok) return { ok: false, result: refuse(ready.error) };
    return queueSendIn(tx, ready, { field: "place", studentId: String(studentId), stamp }, o, { lock: "held" });
  });
  if (!saved.ok) return saved.result;
  if (saved.field !== "place") throw new Error("queueSendIn() answered for another field than the place asked");
  const { write, item, who, to } = saved;
  const money = async () => {
    const [note] = await moveMoneyNotes([{ studentQboId: write.qboId, student: who, toFamilyId: saved.toFamilyId, to, finishing: false }]);
    return note ? ` ${note}` : "";
  };
  const stays = "Nothing of theirs in the portal moved: their forms, volunteer places and buy-outs stay as they are.";
  const t = await trySavedItem(item, write, { by: "at_once", linkedBy: o.staffUserId, actor: o.actor, ip: o.ip, permission: o.permission });
  switch (t.is) {
    // Whose invoices a family sees follows QuickBooks' tree as the roster cache holds it (open question 14).
    case "done": return { ok: true, message: `Sent ${who}'s family to QuickBooks: QuickBooks has them under ${to} now, as the portal has them. ${stays} ${t.cached
      ? `${to} sees their invoices in the portal now.`
      : `${to} sees their invoices in the portal once the roster here reads QuickBooks again, usually within a few minutes.`}` };
    case "found": return { ok: true, message: `QuickBooks has ${who} under ${to} already, so nothing more was sent. ${stays}` };
    case "waiting": return { ok: true, status: "waiting", message: (t.sent
      ? `The portal can't tell yet whether QuickBooks took ${who}'s move to ${to}: its answer didn't arrive. The roster is read again within a few minutes to see, and the portal finishes it then without sending it twice; you'll find it on the Reconciliation page until then.`
      : `QuickBooks couldn't take ${who}'s move to ${to} just now, so it is waiting to reach QuickBooks: the portal tries again in a minute, then less often, and you'll find it on the Reconciliation page.`) + (await money()) };
    case "refused": {
      const why = t.code === "fault_5010" || t.code === "moved_on" || t.code === NO_LINK_VERSION || t.code === PLACE_DIFFERS
        ? `The portal held it back: QuickBooks moved them again since this page was drawn${t.holds ? ` (it has them under “${t.holds}” now)` : ""}, so the portal's family wasn't sent over it.`
        : keptMoveWords(t.code, t.holds);
      return { ok: true, status: "attention", message: `${who}'s move to ${to} wasn't sent to QuickBooks. ${why} The change is kept on the Reconciliation page, where you can send it again or give it up.${await money()}` };
    }
    case "given_up": return { ok: true, status: "attention", message: `${who}'s move to ${to} was given up on the Reconciliation page while it was on its way to QuickBooks, so nothing more is done for it: QuickBooks has it only if that send got through, which the roster shows after its next read.` };
    case "stuck": case "not_reached": case "not_yet": return { ok: true, status: "attention", message: `${who}'s move to ${to} isn't in QuickBooks yet: see the Reconciliation page.${await money()}` };
  }
}

/**
 * A student or member inactive in the portal made inactive in QuickBooks, whose customer the books have active: in one
 * transaction under readyToSend() and the record's lock (held by sendToBooks()): the record inactive (a student in an
 * active family record), linked in its kind; its customer active in the cache, on the roster in the role a
 * make-inactive needs (a student directly under the family's own customer; a member; never a layered family, which goes
 * with everyone under it: SEND_FAMILY_INACTIVE), the shape offering it; nothing waiting or stuck for it, the family's
 * create neither waiting nor being sent, the student's create not waiting, no move of the student waiting, stuck or
 * kept; the stamp sealing the customer. Then, outside it, one try by the one balance rule (tryDeactivate(): the balance
 * read live, and any balance, owed or a credit, or one that can't be read, stops it with nothing sent: open question 11,
 * never queued for that) with the link's own version, each outcome taken as deactivateLinked() takes it: an answer by
 * applyWritten() (the record is inactive already, so what changes is the cache, the link's version and the write's own
 * audit row); inactive there already, the answer stored and a roster read asked for; a stop or a refusal audited
 * `roster.write.refused`, nothing queued; a lost answer queued with enqueue(). Then the press's own row, with how it
 * went, in a transaction of its own, which closes a make-inactive of the customer kept on Reconciliation once QuickBooks
 * has the customer inactive. The record is never made active, nor changed but by applyWritten().
 */
async function sendInactive(kind: "family" | "student", recordId: string, stamp: string, rosterTag: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  type Ready = { ok: true; write: DeactivateWrite; realmId: string; filed: Filed; name: string; who: string; them: string } | { ok: false; result: WriteResult };
  const p = await db.transaction(async (tx): Promise<Ready> => {
    const no = (error: string): Ready => ({ ok: false, result: refuse(error) });
    const ready = await readyToSend(tx, rosterTag);
    if (!ready.ok) return no(ready.error);
    const { shape, source, cache, roster } = ready;
    let active: boolean, customer: string | null, filed: Filed, who: string, familyCustomer: string | null = null;
    if (kind === "family") {
      const [f] = await tx.select().from(family).where(eq(family.id, asAppFamilyId(recordId))).for("update");
      if (!f) return no(WRITE_COPY.gone);
      active = f.active; customer = await customerOfFamily(f.id, tx); filed = { familyId: f.id, studentId: null }; who = recordNameWords(f.name, "family");
    } else {
      const [s] = await tx.select().from(student).where(eq(student.id, asAppStudentId(recordId))).for("update");
      if (!s || s.familyId === null) return no(WRITE_COPY.gone);
      const [f] = await tx.select({ active: family.active }).from(family).where(eq(family.id, s.familyId));
      if (!f?.active) return no(SEND_STUDENT_FAMILY_INACTIVE);
      active = s.active; customer = await customerOfStudent(s.id, tx); filed = { familyId: s.familyId, studentId: s.id }; who = recordNameWords(s.name, "student");
      familyCustomer = await customerOfFamily(s.familyId, tx);
    }
    // Active in the portal: there is no inactive status of the portal's to send.
    if (active) return no(SEND_CHANGED);
    if (customer === null) return no(SEND_NOT_LINKED);
    const c = cache.find((x) => x.qboId === customer);
    const where = c ? roleIn(roster, customer) : null;
    if (!c || !where) return no(WRITE_COPY.gone);
    if (kind === "family" && where.role === "family") return no(SEND_FAMILY_INACTIVE);
    if (kind === "family" ? where.role !== "member" : where.role !== "student" || where.familyQboId !== familyCustomer) return no(SEND_CHANGED);
    // Inactive in the books already: the difference is gone, and nothing is sent.
    if (!c.active) return no(SEND_CHANGED);
    if (!offers(shape, deactivateOf(where.role))) return no(WRITE_COPY.notOffered);
    if (await waitingForCustomer(tx, customer)) return no(WRITE_COPY.waiting);
    const making = await familyCreateWaiting(tx, filed.familyId!);
    if (making) return no(making === "sending" ? FAMILY_SENDING : FAMILY_WAITING);
    if (filed.studentId !== null) {
      if (await studentCreateWaiting(tx, filed.studentId)) return no(STUDENT_WAITING);
      const moves = await tx.select({ id: writeQueue.id }).from(writeQueue).where(and(movesOf(filed.studentId), inArray(writeQueue.state, ["waiting", "stuck", "refused"]))).limit(1);
      if (moves.length) return no(STUDENT_MOVE_PENDING);
    }
    if (!sendStampHolds("inactive", recordId, customer, [customer], stamp)) return no(SEND_CHANGED);
    return { ok: true, write: { op: "deactivate", role: where.role, qboId: customer, syncToken: await linkVersionOf(tx, source, customer, kind) }, realmId: source, filed, name: c.displayName, who, them: kind === "student" ? "them" : "it" };
  });
  if (!p.ok) return p.result;
  const refused = (code: string, write: DeactivateWrite) => writeAudit({ actor: o.actor, action: "roster.write.refused", permission: o.permission, ip: o.ip,
    targetType: "qbo_customer", targetId: write.qboId, after: { op: "deactivate", role: write.role, code: short(code) } });
  // The press's own row, with how it went; a make-inactive of the customer kept on Reconciliation is closed once QuickBooks has it inactive.
  const sendRow = (outcome: "sent" | "inactive_there" | "stopped" | "stale_again" | "queued" | "refused", extra: Record<string, unknown> = {}) => db.transaction(async (tx) => {
    const replaced = outcome === "sent" || outcome === "inactive_there"
      ? await replaceRefused(tx, and(eq(writeQueue.targetQboId, p.write.qboId), sql`${writeQueue.request}->>'op' = 'deactivate'`), { op: "send", field: "inactive", recordId }, o) : [];
    await writeAudit({ actor: o.actor, action: "accounting.difference.send", permission: o.permission, ip: o.ip, targetType: kind, targetId: recordId, before: { active: true },
      after: { field: "inactive", kind, familyId: String(p.filed.familyId), ...(kind === "student" ? { studentId: recordId } : {}), customerQboId: p.write.qboId, active: false, outcome,
        ...extra, replaced: replaced.map((x) => x.id) } }, tx);
  });
  const t = await tryDeactivate(p.write, p.realmId, { mayWait: false, name: p.name, showAmounts: o.showAmounts === true, actor: o.actor, ip: o.ip, permission: o.permission });
  switch (t.is) {
    case "answer": {
      const { cached } = await applyWritten(t.write, t.answer, { realmId: p.realmId, actor: o.actor, ip: o.ip, permission: o.permission, linkedBy: o.staffUserId, filed: p.filed,
        auditExtra: { sentFrom: "accounting.difference.send", ...(t.resent ? { resent: "stale" } : {}) } });
      await sendRow("sent");
      return { ok: true, message: `Made ${p.who} inactive in QuickBooks, as the portal has ${p.them}: QuickBooks showed no balance on the account first.${cached ? "" : " The roster here shows it after its next read of QuickBooks, usually within a few minutes."}` };
    }
    case "inactive_there": {
      // The cache is behind QuickBooks: the answer is stored and the roster read again. The link isn't aligned: it wasn't the portal's send that made it inactive.
      await storeReadAgain(t.answer, p.realmId, o);
      await db.transaction((tx) => askForRosterRefresh(tx));
      await sendRow("inactive_there");
      return { ok: true, message: `QuickBooks has ${p.who} inactive already, so nothing ${t.sent ? "more " : ""}was sent.` };
    }
    case "stopped":
      await refused(t.stop.code, p.write);
      await sendRow("stopped", { code: short(t.stop.code) });
      return refuse(t.stop.words);
    case "stale_again":
      await refused("fault_5010", t.write);
      await sendRow("stale_again", { code: "fault_5010" });
      return refuse(STALE_TWICE);
    case "failed": {
      const failure = classify(t.code);
      if (failure.kind === "retry") {
        await enqueue({ write: t.write, realmId: p.realmId, ...p.filed }, t.code, failure.sent, o);
        await sendRow("queued", { code: short(t.code), sent: failure.sent });
        return { ok: true, queued: true, status: "waiting", message: WRITE_COPY.queued };
      }
      await refused(t.code, t.write);
      await sendRow("refused", { code: short(t.code) });
      return refuse(refusalWords(t.code, p.name) ?? (failure.kind === "not_connected" ? WRITE_COPY.notConnected : failure.kind === "needs_admin" ? WRITE_COPY.needsAdmin
        : failure.kind === "other_company" ? WRITE_COPY.otherCompany : t.code === "bad_id" ? WRITE_COPY.notSent : WRITE_COPY.refused));
    }
  }
}

/**
 * The stamp the Reconciliation page puts on "Send the portal's value": the item and the value the row showed (for a
 * rename, the name the cache has for it, which the press compares QuickBooks' with; for a student's create, the
 * student's current name in the portal, which the press sends; for a move, the customer the cache has the student
 * under, which the press compares QuickBooks' parent with), sealed, so a value the press sends back is never
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
/** A kept change of sign-in email given up at a press because the person changed their address again since (`superseded`), audited, only while it is still kept. */
async function giveUpSupersededEmailIn(tx: Tx, item: QueueRow, o: { actor: Actor; ip: string | null; permission?: string }): Promise<void> {
  const [given] = await tx.update(writeQueue).set({ state: "given_up", note: EMAIL_STOP_NOTES.superseded, nextTryAt: null, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(writeQueue.id, item.id), eq(writeQueue.state, "refused"))).returning({ id: writeQueue.id });
  if (!given) return;
  await writeAudit({ actor: o.actor, action: "roster.write.given_up", permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: item.id,
    before: { state: "refused", tries: item.tries, code: item.lastCode, op: "email" }, after: { state: "given_up", why: "superseded", sentNow: false } }, tx);
}
async function refusedFoundIn(tx: Tx, item: QueueRow, resultQboId: string | null, o: { actor: Actor; ip: string | null; permission?: string }): Promise<boolean> {
  const [still] = await tx.update(writeQueue).set({ state: "done", resultQboId, tries: item.tries + 1, lastTriedAt: new Date(), nextTryAt: null, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(writeQueue.id, item.id), eq(writeQueue.state, "refused"))).returning({ id: writeQueue.id });
  if (!still) return false;
  await writeAudit({ actor: o.actor, action: "roster.write.done", permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: item.id,
    before: { state: "refused", tries: item.tries, code: item.lastCode }, after: { state: "done", how: "found", tries: item.tries + 1, ...(resultQboId ? { resultQboId } : {}) } }, tx);
  await closeEarlierContacts(tx, item, o);
  return true;
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
  // A guardian's Parent customer create while its family is being changed in QuickBooks: the item stays kept.
  if (held === FAMILY_HELD) return refuse(GUARDIAN_FAMILY_CHANGING);
  return held ?? refuse(guardianOf(pre.request) !== null ? GUARDIAN_BEING_CHANGED : pre.request.op === "create" ? FAMILY_SENDING : pre.studentId !== null ? STUDENT_BEING_CHANGED : FAMILY_BEING_CHANGED);
}

async function sendAgainHolding(itemId: string, shown: string, o: WriteOp & { staffUserId: string }): Promise<WriteResult> {
  type Plan = { ok: true; item: QueueRow; write: CreateWrite | RenameWrite | MoveWrite | DeactivateWrite | ContactWrite | EmailWrite; realmId: string } | { ok: false; result: WriteResult };
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
    // A parent's phone and address (stage 3's slice 11b): still the record they are for, active in the cache, nothing
    // else waiting for it; what is sent is the portal's details as they are now, never the item's.
    if (w.op === "contact") {
      if (!(await contactSendsMayGo(tx))) return no(CONTACT_AWAITS_READ);
      const stop = await contactStopsIn(tx, w, item);
      if (stop !== null) return no(CONTACT_NOT_OFFERED[contactNotOffered(stop)]);
      if (!cache.find((c) => c.qboId === w.qboId)?.active) return no(INACTIVE_THERE);
      if (await waitingForCustomer(tx, w.qboId)) return no(WRITE_COPY.waiting);
      const now = await portalDetailsFor(tx, w, item);
      if (now === null) return no(RECORD_MOVED_ON);
      return { ok: true, item, write: { ...w, change: now }, realmId: source };
    }
    // A person's sign-in email (stage 3's slice S11e): still the record it is for, active in the cache, nothing else
    // waiting for it, and still the person's address. One they have changed again since is given up here, nothing sent.
    if (w.op === "email") {
      const stop = await emailStopsIn(tx, w, item);
      if (stop === "superseded") {
        await giveUpSupersededEmailIn(tx, item, o);
        return { ok: false, result: { ok: true, status: "waiting", message: EMAIL_SUPERSEDED_AT_PRESS } };
      }
      if (stop !== null) return no(EMAIL_NOT_OFFERED[emailNotOffered(stop)]);
      if (!cache.find((c) => c.qboId === w.qboId)?.active) return no(INACTIVE_THERE);
      if (await waitingForCustomer(tx, w.qboId)) return no(WRITE_COPY.waiting);
      return { ok: true, item, write: w, realmId: source };
    }
    // A guardian's Parent customer (stage 3's slice 9h): checked against the guardian row and its person, never the family's records.
    const guardianId = guardianOf(w);
    if (guardianId !== null) {
      // A removed guardian's Parent customer the cache has inactive now (made so in QuickBooks once its balance was
      // settled): the change is done as found, nothing sent, the link not aligned.
      if (w.op === "deactivate" && !cache.find((c) => c.qboId === w.qboId)?.active && (await customerOfGuardian(guardianId, tx)) === w.qboId) {
        await refusedFoundIn(tx, item, w.qboId, o);
        return { ok: false, result: { ok: true, message: "QuickBooks has the parent inactive already, so nothing was sent. The change is done." } };
      }
      const g = await guardianPress(tx, item, w, guardianId, shown, source, cache);
      return g.ok ? { ok: true, item, write: g.write, realmId: source } : no(g.error);
    }
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
    if (w.op === "move" && item.studentId !== null) {
      // The student still where the item moves them, linked to the customer it was asked for, and active here and there.
      const [s] = await tx.select().from(student).where(eq(student.id, item.studentId)).for("update");
      if (!s?.active || s.familyId === null || w.toFamilyId === undefined || String(s.familyId) !== String(w.toFamilyId)) return no(RECORD_MOVED_ON);
      if ((await customerOfStudent(s.id, tx)) !== w.qboId) return no(RECORD_MOVED_ON);
      const [f] = await tx.select({ active: family.active }).from(family).where(eq(family.id, s.familyId));
      if (!f?.active) return no(RECORD_MOVED_ON);
      // Offered only while the cache has the student active: the portal never makes a customer active again.
      if (!cache.find((c) => c.qboId === w.qboId)?.active) return no(INACTIVE_THERE);
      const toCustomer = await customerOfFamily(s.familyId, tx);
      if (toCustomer === null) return no(CREATE_FAMILY_FIRST);
      const fromCustomer = w.fromFamilyId === undefined ? null : await customerOfFamily(w.fromFamilyId, tx);
      for (const c of [w.qboId, toCustomer, fromCustomer, beforeCustomer(w)]) if (c !== null && (await waitingForCustomer(tx, c))) return no(WRITE_COPY.waiting);
      return { ok: true, item, write: { ...w, toFamilyQboId: toCustomer }, realmId: source };
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
  if (write.op === "move") {
    const live = await readLive(write.qboId, realmId, false);
    if (!live.ok) return refuse(`QuickBooks couldn't be asked where it has the student just now, so nothing was sent. ${classify(live.code).kind === "retry" ? "Try again in a few minutes." : unreadWords(live.code)}`);
    await storeReadAgain(live.answer, realmId, o);
    if (!live.active) return refuse(INACTIVE_THERE);
    const parent = parentOf(live.answer);
    if (parent === write.toFamilyQboId) {
      const w = write;
      await db.transaction(async (tx) => { if (await lockRosterAs(tx, rosterTagOf(realmId))) { await refusedFoundIn(tx, item, w.qboId, o); await markMoveMoneyStale(tx, w); } });
      return { ok: true, message: "QuickBooks has the student in that family already, so nothing was sent. The change is done." };
    }
    // Nothing is ever sent over a place nobody was shown: the row is drawn again with where QuickBooks has them now.
    if ((parent ?? "") !== shown) {
      return { ok: false, errors: [`QuickBooks moved the student again since this page was shown${(await placeName(parent)) ? `: it has them under “${await placeName(parent)}” now` : ""}. Nothing was sent. Reload the page to see it, then send the portal's move if it is still wanted.`] };
    }
    // Sent with the live version, on purpose, from the place the staff member was shown: that place is what a later try
    // compares QuickBooks' parent with (`fromFamilyQboId`), should this answer be lost; a row that showed them under no
    // customer is compared so (TOP_OF_TREE), never as a move with no before-value, which is held whatever QuickBooks has.
    write = { ...write, syncToken: live.syncToken, checked: true, fromFamilyQboId: shown === "" ? TOP_OF_TREE : shown };
  }
  if (write.op === "deactivate") {
    // A removed guardian's Parent customer (stage 3's slice 9h): the balance read live again, by the one rule. Any
    // balance, or one that can't be read, sends nothing and the item stays kept; inactive there already, it is done.
    const read = await owedBy(write.qboId, realmId);
    if (!read.ok) return refuse(`${unreadWords(read.code)} The change is still kept on this page.`);
    await storeReadAgain(read.answer, realmId, o);
    if (!read.active) {
      const found = write.qboId;
      await db.transaction(async (tx) => { if (await lockRosterAs(tx, rosterTagOf(realmId))) await refusedFoundIn(tx, item, found, o); });
      return { ok: true, message: "QuickBooks has the parent inactive already, so nothing was sent. The change is done." };
    }
    const stop = balanceStops(read, "This parent", o.showAmounts === true);
    if (stop) return refuse(`${stop.who} So nothing was sent, and the parent stays active in QuickBooks. ${WRITE_COPY.balanceFix} The change is still kept on this page.`);
    if (read.syncToken === null) return refuse("QuickBooks' answer couldn't be read (it didn't say which version it holds), so nothing was sent. Try again in a few minutes.");
    write = { ...write, syncToken: read.syncToken, checked: true };
  }
  if (write.op === "contact") {
    const live = await readLive(write.qboId, realmId, false);
    if (!live.ok) return refuse(`QuickBooks couldn't be asked which details it holds just now, so nothing was sent. ${classify(live.code).kind === "retry" ? "Try again in a few minutes." : unreadWords(live.code)}`);
    await storeReadAgain(live.answer, realmId, o);
    if (!live.active) return refuse(INACTIVE_THERE);
    const held = heldInAnswer(live.answer);
    // The portal's details there already: done, nothing sent.
    if (contactStands(held, { change: write.change, was: write.change }) === "in_place") {
      await db.transaction(async (tx) => { if (await lockRosterAs(tx, rosterTagOf(realmId))) await refusedFoundIn(tx, item, item.targetQboId, o); });
      return { ok: true, message: "QuickBooks has the portal's details already, so nothing was sent. The change is done." };
    }
    // Nothing is ever sent over details nobody was shown: the row is drawn again with what QuickBooks holds now.
    if (contactShown(held, write) !== shown) return { ok: false, errors: ["QuickBooks changed these details again since this page was shown. Nothing was sent. Reload the page to see them, then send the portal's details if they are still wanted."] };
    // Sent with the live version, on purpose, over the details the staff member was shown: those are what a later try
    // compares QuickBooks' with (`was`), should this answer be lost, so the queue sends it again only while they still read so.
    const was = { ...(write.change.phone !== undefined ? { phone: held.phone } : {}), ...(write.change.address !== undefined ? { address: held.address } : {}) };
    const next: ContactWrite = { ...write, syncToken: live.syncToken, checked: true, was };
    delete next.orWas;
    write = next;
  }
  // A person's sign-in email (stage 3's slice S11e): the field read live, compared with the one the compare view showed,
  // and the portal's address put in it (portalEmailField()), sent with the version just read, on purpose.
  let emailField: string | undefined;
  if (write.op === "email") {
    const live = await readLive(write.qboId, realmId, false);
    if (!live.ok) return refuse(`QuickBooks couldn't be asked which email field it holds just now, so nothing was sent. ${classify(live.code).kind === "retry" ? "Try again in a few minutes." : unreadWords(live.code)}`);
    await storeReadAgain(live.answer, realmId, o);
    if (!live.active) return refuse(INACTIVE_THERE);
    const field = fieldInAnswer(live.answer);
    // An address the person gave up that another person signs in with now is theirs, and never replaced.
    const taken = await othersSignInWith(write);
    // The new address there already, by the record's rule: done, nothing sent. The live read ran outside the plan's
    // transaction, and the confirm takes no lock a press holds, so the item's stops are checked again under the roster
    // lock in the transaction that marks it done, and it is done only while it is still refused: a newer change that took
    // its place meanwhile, or a removal that gave it up, is said so, never "done".
    if (emailStands(field, write, taken).is === "in_place") {
      const w = write;
      const found = await db.transaction(async (tx): Promise<"done" | "roster" | "gone" | ContactStop> => {
        if (!(await lockRosterAs(tx, rosterTagOf(realmId)))) return "roster";
        const stop = await emailStopsIn(tx, w, item);
        if (stop !== null) return stop;
        return (await refusedFoundIn(tx, item, item.targetQboId, o)) ? "done" : "gone";
      });
      if (found === "roster") return refuse(WRITE_COPY.noRoster);
      if (found === "gone") return refuse(NO_LONGER_REFUSED);
      if (found === "superseded") {
        await db.transaction((tx) => giveUpSupersededEmailIn(tx, item, o));
        return { ok: true, status: "waiting", message: EMAIL_SUPERSEDED_AT_PRESS };
      }
      if (found !== "done") return refuse(EMAIL_NOT_OFFERED[emailNotOffered(found)]);
      return { ok: true, message: "QuickBooks has the person's new sign-in email already, so nothing was sent. The change is done." };
    }
    // Nothing is ever sent over a field nobody was shown: the row is drawn again with what QuickBooks holds now.
    if (emailShown(field) !== shown) return { ok: false, errors: ["QuickBooks changed this email field again since this page was shown. Nothing was sent. Reload the page to see it, then send the portal's address if it is still wanted."] };
    const made = portalEmailField(field, write, taken);
    if (!made.ok) return refuse(made.error);
    emailField = made.field;
    write = { ...write, syncToken: live.syncToken, checked: true };
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
      before: { state: "refused", code: item.lastCode }, after: { state: "waiting", sent: true, op: sent.op, role: sent.role,
        ...(sent.op === "move" ? { toFamilyQboId: sent.toFamilyQboId } : sent.op === "deactivate" || sent.op === "contact" || sent.op === "email" ? {} : { name: sent.name }), ...(guardianOf(sent) ? { guardianId: guardianOf(sent) } : {}),
        ...(sent.op !== "create" ? { syncToken: sent.syncToken } : {}) } }, tx);
    return "moved";
  });
  if (moved === "roster") return refuse(WRITE_COPY.noRoster);
  if (moved === "gone") return refuse(NO_LONGER_REFUSED);
  const before: Before = { request: item.request as RosterWrite, sent: item.sent, lastCode: item.lastCode, tries: item.tries, lastTriedAt: item.lastTriedAt };
  const t = await trySavedItem({ ...item, state: "waiting", sent: true, request: sent }, sent, { by: "press", before, linkedBy: o.staffUserId, actor: o.actor, ip: o.ip, permission: o.permission,
    ...(emailField !== undefined ? { emailField } : {}) });
  const what = sent.op === "rename" ? "QuickBooks has the portal's name now" : sent.op === "contact" ? "QuickBooks has the portal's details now" : sent.op === "email" ? "QuickBooks has the person's new sign-in email now"
    : sent.op === "move" ? "QuickBooks has the student in the family the portal moved them to now"
    : sent.op === "deactivate" ? "QuickBooks has the parent inactive now" : guardianOf(sent) ? "QuickBooks has the parent now" : "QuickBooks has the student now";
  switch (t.is) {
    case "done": return t.cached ? { ok: true, message: `Sent: ${what}${sent.op === "create" ? ", linked to their record here" : ""}.` }
      : { ok: true, ...(sent.op === "create" ? { status: "waiting" as const } : {}), message: `Sent: ${what}. The portal finishes it on its side after its next read of QuickBooks, usually within a few minutes.` };
    case "found": return { ok: true, message: sent.op === "move" ? "QuickBooks has the student in that family already, so nothing was sent. The change is done."
      : sent.op === "deactivate" ? "QuickBooks has the parent inactive already, so nothing more was sent. The change is done."
      : sent.op === "contact" ? "QuickBooks has the portal's details already, so nothing was sent. The change is done."
        : sent.op === "email" ? "QuickBooks has the person's new sign-in email already, so nothing was sent. The change is done." : "QuickBooks has the portal's name already, so nothing was sent. The change is done." };
    case "waiting": return { ok: true, status: "waiting", message: "The portal can't tell yet whether QuickBooks took it: its answer didn't arrive. The roster is read again within a few minutes to see, and the portal finishes it then without sending it twice." };
    case "not_reached": return refuse(t.code === CONTACT_AWAITS_READ_CODE ? CONTACT_AWAITS_READ : "QuickBooks couldn't take it just now, so nothing was changed there. The change is still kept here: try again in a few minutes.");
    case "not_yet": return refuse(CONTACT_AWAITS_READ);
    case "refused": return refuse(`It didn't go through this time either. ${keptWordsFor(sent, t.code, t.holds)} The change is still kept on this page.`);
    // A parent saved their details again while this was pressed (stage 3's slice 11b): the newer change, which carries
    // every field this one did, takes its place, and nothing was sent from this row.
    case "given_up": if (t.why === "superseded") return { ok: true, status: "waiting", message: sent.op === "email" ? EMAIL_SUPERSEDED_AT_PRESS : CONTACT_SUPERSEDED_AT_PRESS };
      return { ok: true, status: "attention", message: `The change was given up on this page while it was on its way to QuickBooks, so it stays given up and nothing in the portal was changed or linked for it, whatever QuickBooks did with it. ${sent.op === "rename"
      ? "QuickBooks has the portal's name only if that send got through, which the roster shows after its next read."
      : sent.op === "move" ? "QuickBooks has the move only if that send got through, which the roster shows after its next read."
      : sent.op === "contact" ? "QuickBooks has the portal's details only if that send got through, which the roster shows after its next read."
      : sent.op === "email" ? "QuickBooks has the person's new sign-in email only if that send got through, which the roster shows after its next read."
      : "After the next roster read, this page says whether QuickBooks made the student anyway."}` };
    case "stuck": return refuse("It didn't go through: see this page for where it stands.");
  }
}

/* ---- A guardian's own Parent customer follows the portal (stage 3's slice 9h; app-owned families spec section 5: "A
   change to a linked person is saved in the app first, then sent to QuickBooks: a name ...; a new student or guardian;
   ... someone made inactive"; section 6, removing a guardian; open questions 7, 10, 11 and 12; Appendix B, "A parent's
   link belongs to a membership, not to the person") ----
   Where the books have a parent type (layered, `shape.parentTypeId`) and the family is linked, a guardian staff add, a
   person renamed and a guardian removed are the portal's own changes first, as slice 7b made them, and each puts its
   Parent customer's change on the queue in the same transaction, as a change saved first (queueSaved(): waiting, never
   sent, filed under the row's family, its request naming the guardian row as `guardianId`). Every send is after the
   guardian's commit, in a transaction of its own, under the row's "being sent" lock (whileGuardiansHeld(), the lock
   lockOfItem() gives a guardian's item), so QuickBooks' answer, refusal or slowness never delays or undoes the portal's
   change to access. A row's own Parent customer is the customer of its own link (customerOfGuardian()), only while the
   roster cache holds it as a customer of the parent type directly under the family's customer and no other open
   guardian row is linked to it (ownParentCustomer()). Nothing is sent for a guardian in flat books, in books with no
   parent type (the family's email field, open question 7, is S11d's) or for a family with no link. The portal never
   matches a person to a customer by name or address by itself: when the family already has a customer of the person's
   name under it, nothing is sent and nothing is kept: a Parent customer there is linked to a row only by a staff
   member's press on Accounting links (stage 4's slice M3c, src/lib/accounting/guardian-links.ts). A Parent customer
   made here is linked `created`, never `carried_over`, so the take-in of contact details never reads it as a parent's
   own record. */

/** Who saves a change first: the staff member's actor, the permission used and their staff user id (null for none). */
type SaverOp = { actor: Actor; ip: string | null; permission?: string; staffUserId: string | null };
/** A guardian's change, as the guardian functions (src/lib/parents/guardians.ts, people.ts) are given it. */
export type GuardianOp = { actor: Actor; ip: string | null; permission?: string };
const saverOf = (o: GuardianOp): SaverOp => ({ actor: o.actor, ip: o.ip, permission: o.permission, staffUserId: o.actor.door === "staff" ? o.actor.id : null });

/** A Parent customer that is a portal guardian's own is changed through the guardian: askRosterWrite() refuses its forms. */
export const GUARDIAN_HERE = "That Parent customer is linked to a guardian in the portal, so it isn't changed from here: a guardian's own Parent customer is changed through them (rename the person on their page, or remove them under Portal sign-ins on this page), and one several guardians share, or one linked to a guardian of another family, is changed in QuickBooks, or sorted out on Accounting links: unlink from it each guardian whose it isn't, and once one guardian of this family alone is linked to it, it is theirs; if none of this family's is left on it, one who isn't linked to a customer can be linked to it there. Nothing was changed.";
/** The family action while a guardian's Parent customer change for the family is waiting or stuck. */
export const GUARDIAN_PENDING = "A change to a guardian's Parent customer in this family hasn't reached QuickBooks yet (it is waiting or stuck on the Reconciliation page), so nothing was changed. Once it has gone through, or been given up there, try again.";
/** The code of a guardian's Parent customer create found made as a customer another open guardian row is linked to already (foundDone(), ./queue.ts). */
export const CUSTOMER_HAS_GUARDIAN = "customer_has_guardian";
/** The code of a guardian's Parent customer create kept at once: the person's name is one QuickBooks can't take (checkName()). */
export const NAME_UNUSABLE = "name_unusable";
/**
 * A guardian's Parent customer create QuickBooks refused as a taken name: another customer there has it. Nothing is
 * promised of a rename (the lead's decision 1 in slice 9h's last round): a person has one name, so a rename changes it
 * on their own record in QuickBooks, and replaces this only when the new name is free by the portal's knowledge.
 */
export const GUARDIAN_TAKEN_NAME = "QuickBooks refused the person's name as taken: another customer in QuickBooks has that name, so it isn't sent again as it is. Renaming the person changes their name in the portal and on their own record in QuickBooks. “Give up” leaves the guardian as they are, with no record of their own in QuickBooks; after that, a Parent customer under the family that no guardian is linked to can be linked to them on Accounting links, in the opening of the family's row.";
/** A guardian's Parent customer rename QuickBooks refused as a taken name: another customer there has it. */
export const GUARDIAN_RENAME_TAKEN = "QuickBooks refused that name as taken: another customer in QuickBooks has it, so it isn't sent again as it is. Renaming the person again changes their name in the portal and on their own record in QuickBooks. “Give up” leaves this Parent customer with the name it has in QuickBooks.";
/** A guardian's Parent customer create not sent at once, or on a press, while its family is being changed in QuickBooks (the family action: the lead's decision 2). */
export const GUARDIAN_FAMILY_CHANGING = "The guardian's family is being changed in QuickBooks at this moment, so nothing was sent for their Parent customer just now. Try again in a minute.";
/** How long a guardian's at-once send waits for the roster lock before it is left for the worker: the guardian writes' three seconds. */
const GUARDIAN_ROSTER_WAIT_MS = 3000;
const ofGuardian = (guardianId: string) => sql`${writeQueue.request}->>'guardianId' = ${guardianId}`;
const isOp = (op: string) => sql`${writeQueue.request}->>'op' = ${op}`;

/** The open guardian rows linked to each of these customers in a company (several rows may share one). */
async function openGuardiansOf(tx: Tx, realmId: string | null, customers: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (realmId === null || !customers.length) return out;
  const rows = await tx.select({ customerId: accountingLink.customerId, guardianId: guardian.id }).from(accountingLink).innerJoin(guardian, eq(guardian.id, accountingLink.guardianId))
    .where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId), inArray(accountingLink.customerId, [...customers]), ne(guardian.status, "disabled")));
  for (const r of rows) out.set(r.customerId, [...(out.get(r.customerId) ?? []), r.guardianId]);
  return out;
}
/** Whether an open guardian row other than `except` is linked to this customer: it is then nobody's own, and no second link is made to it. */
export async function guardianCustomerHeld(tx: Tx, realmId: string, customerId: string, except: string): Promise<boolean> {
  return ((await openGuardiansOf(tx, realmId, [customerId])).get(customerId) ?? []).some((g) => g !== except);
}
/**
 * Whether any guardian row other than `except`, open or closed, is linked to this customer: a guardian's create found
 * made by name (foundDone(), ./queue.ts) links its row only to a customer no guardian row is linked to, since a closed
 * row's customer is a removed guardian's own, which they take back if reinstated.
 */
export async function guardianCustomerLinked(tx: Tx, realmId: string, customerId: string, except: string): Promise<boolean> {
  const rows = await tx.select({ guardianId: accountingLink.guardianId }).from(accountingLink)
    .where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId), eq(accountingLink.customerId, customerId), isNotNull(accountingLink.guardianId)));
  return rows.some((r) => r.guardianId !== null && r.guardianId !== except);
}
/**
 * The customers of these (a family's Parent customers) that an open guardian row is linked to, in the roster's company,
 * for a family's page, which offers them no forms (askRosterWrite() refuses them, GUARDIAN_HERE): `own`, one open row
 * of this family alone is linked to it, so it is that guardian's own and changed through them; `other`, it is shared by
 * several open rows or linked to a guardian of another family, so the portal sends nothing for it (ownParentCustomer()),
 * and it is changed in QuickBooks, or sorted out on Accounting links (stage 4's slice M3c): each guardian whose it isn't
 * unlinked from it (Unlink this guardian), and where none of this family's is left on it, one linked to it there (Link
 * this guardian); `removed`, no open row is linked to it, a
 * removed guardian's row of this family is, and the cache holds it active: their own, left active in QuickBooks (a removal makes it inactive only when
 * its balance allows), which they take back if reinstated.
 */
export async function guardianCustomers(customers: readonly string[], familyId: AppFamilyId): Promise<Map<string, "own" | "other" | "removed">> {
  return db.transaction(async (tx) => {
    const out = new Map<string, "own" | "other" | "removed">();
    const realmId = await getRosterSource(tx);
    if (realmId === null || (await connectedToAnotherCompany(tx))) return out;
    const held = await openGuardiansOf(tx, realmId, customers);
    const rows = [...new Set([...held.values()].flat())];
    const familyOfRow = new Map((rows.length ? await tx.select({ id: guardian.id, familyId: guardian.familyId }).from(guardian).where(inArray(guardian.id, rows)) : [])
      .map((r) => [r.id, r.familyId === null ? null : String(r.familyId)]));
    for (const [customer, ids] of held) out.set(customer, ids.length === 1 && familyOfRow.get(ids[0]!) === String(familyId) ? "own" : "other");
    const rest = customers.filter((c) => !held.has(c));
    if (rest.length) {
      // Only one the cache holds active: that is what the family's page says of it.
      const closed = await tx.select({ customerId: accountingLink.customerId }).from(accountingLink).innerJoin(guardian, eq(guardian.id, accountingLink.guardianId))
        .innerJoin(qboCustomer, and(eq(qboCustomer.qboId, accountingLink.customerId), eq(qboCustomer.active, true)))
        .where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId), inArray(accountingLink.customerId, rest), eq(guardian.familyId, familyId),
          eq(guardian.status, "disabled"), ne(guardian.disabledReason, "company_changed")));
      for (const c of closed) out.set(c.customerId, "removed");
    }
    return out;
  });
}
/**
 * Whether nobody is changing this family in QuickBooks at this moment (its "being sent" lock, held by the family action
 * from before its checks to its last step, and by its rename on its way): tried shared, and held so to the end of the
 * caller's transaction, as a move tries it (moveRefusals()). A guardian add or reinstate is refused while it is held, so
 * no Parent customer is made under a family whose customers are being made inactive (stage 3's slice 9h).
 */
export async function familySendingFree(tx: Tx, familyId: AppFamilyId): Promise<boolean> {
  return recordSendingFree(tx, String(familyId));
}
/**
 * Whether nobody holds this record's "being sent" lock at this moment (a family's, a student's or a guardian row's: one
 * key shape, by the record's id, whileSending(), lockOfItem()): tried shared, and held so to the end of the caller's
 * transaction. It changes nothing. An unlink (stage 4's slice M3b, src/lib/accounting/link-writes.ts) tries it for the
 * family, each of its student records and each of its guardian rows.
 */
export async function recordSendingFree(tx: Tx, recordId: string): Promise<boolean> {
  const [r] = (await tx.execute(sql`select pg_try_advisory_xact_lock_shared(${sql.raw(String(SENDING_LOCK))}, hashtext(${recordId}::text)) as locked`)) as unknown as { locked: boolean }[];
  return r?.locked === true;
}
/** Whether a guardian's Parent customer change filed under this family is waiting or stuck (askFamilyInactive() refuses meanwhile). */
async function guardianItemsWaiting(tx: Tx, familyId: AppFamilyId): Promise<boolean> {
  return (await tx.select({ id: writeQueue.id }).from(writeQueue)
    .where(and(eq(writeQueue.familyId, familyId), inArray(writeQueue.state, ["waiting", "stuck"]), sql`${writeQueue.request}->>'guardianId' is not null`, blocksOthers)).limit(1)).length > 0;
}

/**
 * Why nothing is sent for a guardian: the club's books (flat, or no parent type), the family (no link, or its customer
 * inactive or not on the roster), or the connection (not connected to the roster's company, or a shape that doesn't hold).
 */
export type GuardianNotSent = "books" | "family" | "connection" | "failed";
/** Why nothing is sent for a guardian, as guardianBooks() reads it (`failed` is queueForGuardian()'s own: its savepoint failed). */
type BooksNotSent = Exclude<GuardianNotSent, "failed">;
type GuardianBooks = { ok: true; realmId: string; parentTypeId: string; familyCustomer: string; cache: (Cust & { syncToken: string })[] } | { ok: false; why: BooksNotSent };
type Books = Extract<GuardianBooks, { ok: true }>;
/** Where anything may be sent for a guardian of this family, read in the caller's transaction, which holds the roster lock. */
async function guardianBooks(tx: Tx, familyId: AppFamilyId | null): Promise<GuardianBooks> {
  const [shape, source, conn, types] = await Promise.all([getShape(tx), getRosterSource(tx), getConnection(tx), tx.select().from(qboCustomerType)]);
  if (!shape || shape.kind !== "layered" || shape.parentTypeId === null || !offers(shape, "add_parent")) return { ok: false, why: "books" };
  if (familyId === null) return { ok: false, why: "family" };
  const familyCustomer = await customerOfFamily(familyId, tx);
  if (familyCustomer === null) return { ok: false, why: "family" };
  if (!conn?.realmId || !conn.refreshTokenCiphertext || source === null || source !== conn.realmId
    || missingTypes(shape, types.map((t) => ({ qboId: t.qboId, name: t.name, active: t.active }))).length) return { ok: false, why: "connection" };
  const cache = await cacheRows(tx);
  if (!cache.find((c) => c.qboId === familyCustomer)?.active) return { ok: false, why: "family" };
  return { ok: true, realmId: source, parentTypeId: shape.parentTypeId, familyCustomer, cache };
}
type OwnParent = { is: "own"; customer: string; active: boolean; syncToken: string; name: string } | { is: "not_own"; customer: string } | { is: "none" };
/**
 * The row's own Parent customer (item 1 of the slice): its link's customer, only while the cache holds it as a customer
 * of the parent type directly under the family's customer, and no other open guardian row is linked to it. A row with a
 * link that isn't so (`not_own`) has nothing sent for it; one with no link (`none`) may have one made.
 */
async function ownParentCustomer(tx: Tx, guardianId: string, b: Books): Promise<OwnParent> {
  const customer = await customerOfGuardian(guardianId, tx);
  if (customer === null) return { is: "none" };
  const c = b.cache.find((x) => x.qboId === customer);
  if (!c || c.typeQboId !== b.parentTypeId || c.parentQboId !== b.familyCustomer || (await guardianCustomerHeld(tx, b.realmId, customer, guardianId))) return { is: "not_own", customer };
  const [link] = await tx.select({ syncedToken: accountingLink.syncedToken }).from(accountingLink)
    .where(and(eq(accountingLink.guardianId, guardianId), eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, b.realmId)));
  return { is: "own", customer, active: c.active, syncToken: link?.syncedToken ?? "", name: c.displayName };
}
/**
 * The name of the Parent customer this guardian row was linked to until that link ended (stage 4's slice
 * M3b2: its latest ended link, by its family's unlink or, since slice M3c, its own (unlinkGuardian()), whose customer the books still hold with no guardian link naming it, endedLinksHeld()),
 * only while the cache holds it as a customer of the parent type directly under the family's customer now: a family
 * relinked to the same customer, or a family still linked whose guardian's own link was ended alone. Under another customer (a family relinked to another) it is null: one Parent customer
 * per family is the portal's rule (ownNamedElsewhere()), and a new family customer gets its own.
 */
async function linkedBefore(tx: Tx, guardianId: string, b: Books): Promise<string | null> {
  return heldUnderFamily((await endedLinksHeld({ guardians: [guardianId] }, tx)).guardians.get(guardianId), b);
}
/** linkedBefore()'s rule, for a row's answer from endedLinksHeld() read already (guardianStandings() reads every row's at once). */
const heldUnderFamily = (held: EndedHeld | undefined, b: Books): string | null =>
  held !== undefined && held.parentQboId === b.familyCustomer && held.typeQboId === b.parentTypeId ? held.customerName : null;
/** An active customer directly under the family's customer with the person's name, by the portal's comparison (nameKey()): item 2(a). */
const namedUnder = (b: Books, name: string) => b.cache.find((c) => c.active && c.parentQboId === b.familyCustomer && nameKey(c.displayName) === nameKey(name)) ?? null;
/** The guardian row's own queue items in these states, oldest first. */
const itemsOfRow = (tx: Tx, guardianId: string, states: QueueRow["state"][]) =>
  tx.select().from(writeQueue).where(and(ofGuardian(guardianId), inArray(writeQueue.state, states))).orderBy(asc(writeQueue.createdAt));

/**
 * Whether a guardian's change must wait (reinstating a row, renaming a person): a change of one of these rows' Parent
 * customers waiting or stuck on the queue (its own item, or any change waiting for the customer its link names). Read in
 * the caller's transaction, before anything is written.
 */
export async function guardianChangeWaiting(tx: Tx, guardianIds: readonly string[]): Promise<boolean> {
  for (const id of guardianIds) {
    if ((await itemsOfRow(tx, id, ["waiting", "stuck"])).some((i) => !isDetailsSend(i.request))) return true;
    const customer = await customerOfGuardian(id, tx);
    if (customer !== null && (await waitingForCustomer(tx, customer))) return true;
  }
  return false;
}

/**
 * Whether anything could be sent to QuickBooks for these open guardian rows of a person being renamed (the lead's
 * decision 3(c) in slice 9h's last round): one of them in a linked family, in layered books with a parent type, or an
 * item of theirs on the queue (waiting, stuck or kept). Otherwise their rename is the portal's alone, as before slice
 * 9h: no roster lock, no "being sent" lock, nothing queued. Read in the caller's transaction, or unlocked (`tx` absent).
 */
export async function guardianMaySend(rows: readonly { guardianId: string; familyId: AppFamilyId | null }[], tx?: Tx): Promise<boolean> {
  if (!rows.length) return false;
  const ids = rows.map((r) => r.guardianId);
  const [item] = await (tx ?? db).select({ id: writeQueue.id }).from(writeQueue)
    .where(and(inArray(sql`${writeQueue.request}->>'guardianId'`, ids), inArray(writeQueue.state, ["waiting", "stuck", "refused"]), blocksOthers)).limit(1);
  if (item) return true;
  const shape = await getShape(tx);
  if (!shape || shape.kind !== "layered" || shape.parentTypeId === null || !offers(shape, "add_parent")) return false;
  for (const r of rows) if (r.familyId !== null && (await customerOfFamily(r.familyId, tx)) !== null) return true;
  return false;
}

/**
 * Runs `send` holding the "being sent" lock of each of these guardian rows (the lock lockOfItem() gives their items), in
 * a transaction of its own that holds nothing else, from before the guardian's change is saved until the at-once tries
 * are over: the worker, "Try again now" and "Send the portal's value" never send such an item meanwhile. Null, doing
 * nothing, when someone else holds one of them. `send` is given that holding transaction, on whose connection a
 * Parent customer's create also takes its family's "being sent" lock, shared, for its send (sendGuardianSaved()).
 */
export async function whileGuardiansHeld<T>(guardianIds: readonly string[], send: (hold: Tx) => Promise<T>): Promise<T | null> {
  const ids = [...new Set(guardianIds.map((g) => g.toLowerCase()))].sort();
  return db.transaction(async (hold) => {
    for (const id of ids) {
      const [lock] = (await hold.execute(sql`select pg_try_advisory_xact_lock(${sql.raw(String(SENDING_LOCK))}, hashtext(${id}::text)) as locked`)) as unknown as { locked: boolean }[];
      if (!lock?.locked) return null;
    }
    return send(hold);
  });
}

/**
 * Whether the roster lock is free within `waitMs` (a guardian's at-once send, the lead's decision 3(e) in slice 9h's
 * last round): taken shared in a short transaction of its own and let go at once. False when a roster read held it that
 * long: the item is then left waiting for the worker, nothing sent.
 */
async function rosterFreeWithin(waitMs: number): Promise<boolean> {
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local lock_timeout = '${Math.max(1, Math.floor(waitMs))}ms'`));
      await tx.execute(sql`select pg_advisory_xact_lock_shared(${ROSTER_LOCK})`);
    });
    return true;
  } catch (e) {
    const code = (v: unknown) => (typeof v === "object" && v !== null ? (v as { code?: unknown }).code : undefined);
    if ((code(e) ?? code((e as { cause?: unknown } | null)?.cause)) === "55P03") return false;
    throw e;
  }
}

/** What a guardian's change asks of their Parent customers, in the guardian's own transaction (queueForGuardian()). */
export type GuardianAsk =
  /** A row just opened (added, reused at a second press, or reinstated): a Parent customer made where it has none. */
  | { op: "grant"; guardianId: string; familyId: AppFamilyId; name: string; email: string }
  /** A row just closed: its own creates that never left given up, its own Parent customer made inactive under the balance rule. */
  | { op: "remove"; guardianId: string; familyId: AppFamilyId | null }
  /** A person renamed (`was`, the name before): each open row's own Parent customer renamed, a create kept as a taken name made again under the new one. */
  | { op: "rename"; rows: { guardianId: string; familyId: AppFamilyId | null }[]; name: string; was: string; email: string };

/**
 * What became of one row's Parent customer at the save: nothing sent (`not_sent`, why), a customer of that name under
 * the family not linked to them (`named_like`, `holds` its name: item 2(a)), the row's own customer kept as it is
 * (`has_one`), inactive in QuickBooks (`inactive_there`: nothing is made active again), a link that isn't the row's own
 * (`not_own`), a change of the row's already on the queue (`create_open`), a change queued (`queued`, with its item and
 * write), kept at once (`kept`, with its code), a create that may have reached QuickBooks left to finish (`maybe_made`),
 * or nothing to do.
 */
export type GuardianOutcome = "not_sent" | "named_like" | "named_elsewhere" | "has_one" | "inactive_there" | "not_own" | "create_open" | "queued" | "kept" | "name_held"
  | "name_once" | "maybe_made" | "nothing" | "linked_before";
/**
 * Beside those (the lead's decision 1 in slice 9h's last round, one person, one name): `named_elsewhere`, the person's
 * own Parent customer under another family of theirs has that name (`elsewhere`, that family's name), so none is made
 * here; `name_held`, a create kept as a taken name stays kept at a rename, as the new name isn't free (`elsewhere` when
 * another record of theirs has it or is about to, else `holds` the new name, which another customer has); `name_once`,
 * a rename not queued, as the same rename gives the new name to another record of theirs first (`elsewhere`). Since
 * stage 4's slice M3b2, `linked_before`: at a grant, the Parent customer the row was linked to under this family until
 * that link ended is still there (`holds`, its name: linkedBefore()), so none is made beside it.
 */
export type GuardianQueued = { guardianId: string; familyName: string; outcome: GuardianOutcome; why?: GuardianNotSent; holds?: string; code?: string; elsewhere?: string;
  item?: QueueRow; write?: RenameWrite | CreateWrite | DeactivateWrite };
/**
 * One row's Parent customer after its at-once try (`tried`, trySavedItem()'s outcome; absent when nothing was tried).
 * `deferred`: not tried at once, left waiting for the worker: its family being changed in QuickBooks (`family`), or a
 * roster read holding the roster lock past the wait (`roster`).
 */
export type GuardianSent = GuardianQueued & { tried?: SavedTry; deferred?: "family" | "roster" };

/** A change put on the queue for a guardian, audited in the caller's transaction (`roster.write.queued`, naming the row). */
async function queueForRow(tx: Tx, write: RenameWrite | CreateWrite | DeactivateWrite, realmId: string, familyId: AppFamilyId | null, o: SaverOp): Promise<QueueRow> {
  const item = await queueSaved(tx, write, realmId, { familyId, studentId: null }, o);
  await writeAudit({ actor: o.actor, action: "roster.write.queued", permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: item.id,
    after: { op: write.op, role: write.role, guardianId: guardianOf(write), state: "waiting", sent: false } }, tx);
  return item;
}

/**
 * The portal's name of another family of this row's person whose open row is linked to an active Parent customer with
 * this name (rule (a) of the lead's decision 1 in slice 9h's last round): QuickBooks takes a name once by the portal's
 * model (the client's own: a name any other customer holds is refused), so that record is theirs, and none of that name
 * is made for this row. Null for none.
 */
async function ownNamedElsewhere(tx: Tx, b: Books, guardianId: string, name: string): Promise<string | null> {
  const [me] = await tx.select({ parentId: guardian.parentId }).from(guardian).where(eq(guardian.id, guardianId));
  if (!me) return null;
  const rows = await tx.select({ customerId: accountingLink.customerId, familyName: family.name, familyId: guardian.familyId }).from(guardian)
    .innerJoin(accountingLink, and(eq(accountingLink.guardianId, guardian.id), eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, b.realmId)))
    .leftJoin(family, eq(family.id, guardian.familyId))
    .where(and(eq(guardian.parentId, me.parentId), ne(guardian.id, guardianId), ne(guardian.status, "disabled"))).orderBy(asc(guardian.id));
  const hit = rows.find((r) => {
    const c = b.cache.find((x) => x.qboId === r.customerId);
    return c !== undefined && c.active && c.typeQboId === b.parentTypeId && nameKey(c.displayName) === nameKey(name);
  });
  return hit ? recordNameWords(hit.familyName, "family") : null;
}

/**
 * A Parent customer's create for a row with none, by item 2: (a) a customer of the person's name under the family, or
 * their own Parent customer of that name under another family of theirs (ownNamedElsewhere()), nothing; a name or
 * address QuickBooks can't take, kept at once; otherwise queued.
 */
async function createForRow(tx: Tx, b: Books, guardianId: string, familyId: AppFamilyId, familyName: string, name: string, email: string, o: SaverOp): Promise<GuardianQueued> {
  const like = namedUnder(b, name);
  if (like) return { guardianId, familyName, outcome: "named_like", holds: like.displayName };
  const elsewhere = await ownNamedElsewhere(tx, b, guardianId, name);
  if (elsewhere !== null) return { guardianId, familyName, outcome: "named_elsewhere", elsewhere };
  const checked = checkName(name);
  const write: CreateWrite = { op: "create", role: "parent", name: checked.ok ? checked.name : name, typeQboId: b.parentTypeId, familyQboId: b.familyCustomer, email, guardianId };
  const keepCode = !checked.ok ? NAME_UNUSABLE : email.length > 100 ? EMAIL_TOO_LONG : null;
  if (keepCode) return { guardianId, familyName, outcome: "kept", code: keepCode, item: await keepSaved(tx, write, b.realmId, { familyId, studentId: null }, keepCode, o), write };
  return { guardianId, familyName, outcome: "queued", item: await queueForRow(tx, write, b.realmId, familyId, o), write };
}

/**
 * The Parent customer changes a guardian's change asks for, decided and queued in the guardian's own transaction (the
 * caller holds the parents' settings lock, the person's locks and the roster lock shared, in that order, and has made
 * its own change to the rows already). It reads the shape, the links and the cache, and sends nothing: the at-once
 * tries are sendGuardianSaved()'s, after the commit. Its writes go in a savepoint: should one fail, nothing of it is
 * kept and the guardian's own change commits all the same, said as nothing sent.
 * - grant: a row with a Parent customer of its own creates none (`has_one`; a refused make-inactive of the row is
 *   replaced, roster.write.replaced; `inactive_there` when QuickBooks has it inactive, open question 12); one with a link
 *   that isn't its own nothing (`not_own`); one with none goes by item 2: a create already on the queue (`create_open`),
 *   the Parent customer it was linked to under the family's customer before an unlink, still in the books
 *   (`linked_before`, slice M3b2), a customer of the person's name under the family (`named_like`), else a create queued.
 * - remove: the row's own creates kept refused, or never sent, given up, whoever holds the row's lock (the update is
 *   conditioned on `sent` false, so a sender that has marked one as maybe sent keeps it); one that may have been sent or
 *   is being sent left to finish (`maybe_made`), and a later try of it finds the row closed and gives it up unsent
 *   (trySavedItem()); its own active Parent customer's make-inactive queued (the balance rule is the at-once try's), with
 *   the link's version.
 * - rename: for each open row, its own active Parent customer's rename queued (the link's version; `was` the person's
 *   name before, or a replaced refused rename's), a refused rename of it replaced; nothing for one QuickBooks has
 *   inactive; and a create kept refused as a taken name replaced by a create under the new name, by item 2.
 */
export async function queueForGuardian(tx: Tx, ask: GuardianAsk, op: GuardianOp): Promise<GuardianQueued[]> {
  const o = saverOf(op);
  const familyNameOf = async (familyId: AppFamilyId | null) => {
    const [f] = familyId === null ? [] : await tx.select({ name: family.name }).from(family).where(eq(family.id, familyId));
    return recordNameWords(f?.name ?? null, "family");
  };
  try {
    return await tx.transaction(async (sp): Promise<GuardianQueued[]> => {
      if (ask.op === "grant") {
        const familyName = await familyNameOf(ask.familyId);
        const at = { guardianId: ask.guardianId, familyName };
        // The row is open again: a make-inactive of it the portal kept refused is replaced, whatever QuickBooks now holds
        // for it (inactive there, a link that isn't its own, books where nothing is sent any more).
        await replaceRefused(sp, and(ofGuardian(ask.guardianId), isOp("deactivate")), { op: "reinstate", guardianId: ask.guardianId }, o);
        const b = await guardianBooks(sp, ask.familyId);
        if (!b.ok) return [{ ...at, outcome: "not_sent", why: b.why }];
        const own = await ownParentCustomer(sp, ask.guardianId, b);
        if (own.is === "own") return [{ ...at, outcome: own.active ? "has_one" : "inactive_there", holds: own.name }];
        if (own.is === "not_own") return [{ ...at, outcome: "not_own" }];
        if ((await itemsOfRow(sp, ask.guardianId, ["waiting", "stuck", "refused"])).some((i) => i.request.op === "create")) return [{ ...at, outcome: "create_open" }];
        // The Parent customer the row was linked to under this family's customer before an unlink, still in the books
        // (slice M3b2): no second one is made beside it, and the portal doesn't link the row to it here.
        const before = await linkedBefore(sp, ask.guardianId, b);
        if (before !== null) return [{ ...at, outcome: "linked_before", holds: before }];
        return [await createForRow(sp, b, ask.guardianId, ask.familyId, familyName, ask.name, ask.email, o)];
      }
      if (ask.op === "remove") {
        const familyName = await familyNameOf(ask.familyId);
        const at = { guardianId: ask.guardianId, familyName };
        // The row's own creates: one that never left is given up with the membership; one that may have, left to finish.
        let maybeMade = false;
        for (const c of (await itemsOfRow(sp, ask.guardianId, ["waiting", "stuck", "refused"])).filter((i) => i.request.op === "create")) {
          // Decided by the item itself, never by whose lock is held: one kept refused, or one never sent as it reads when the
          // update runs (a sender's mark of it as maybe sent, committed meanwhile, is seen, and keeps it).
          const [gone] = c.state === "refused" || !c.sent ? await sp.update(writeQueue).set({ state: "given_up", note: "The guardian was removed in the portal.", nextTryAt: null, finishedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(writeQueue.id, c.id), c.state === "refused" ? eq(writeQueue.state, "refused") : and(eq(writeQueue.state, c.state), eq(writeQueue.sent, false))))
            .returning({ id: writeQueue.id }) : [];
          if (gone) {
            await writeAudit({ actor: o.actor, action: "roster.write.given_up", permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: c.id,
              before: { state: c.state, tries: c.tries, code: c.lastCode, op: "create" }, after: { state: "given_up", why: "guardian_removed" } }, sp);
          } else maybeMade = true;
        }
        // The row's phone and address changes (stage 3's slice 11b), and its sign-in email's (slice S11e), by the same
        // rule: one kept, or never sent, given up with the membership; one that may have been sent is left to finish, and
        // its next try finds the row closed and gives it up unsent (contactStops(), emailStops()). Nothing is said of
        // them: the details and the address stay the person's in the portal.
        for (const c of (await itemsOfRow(sp, ask.guardianId, ["waiting", "stuck", "refused"])).filter((i) => isDetailsSend(i.request))) {
          const [gone] = c.state === "refused" || !c.sent ? await sp.update(writeQueue).set({ state: "given_up", note: "The guardian was removed in the portal.", nextTryAt: null, finishedAt: new Date(), updatedAt: new Date() })
            .where(and(eq(writeQueue.id, c.id), c.state === "refused" ? eq(writeQueue.state, "refused") : and(eq(writeQueue.state, c.state), eq(writeQueue.sent, false))))
            .returning({ id: writeQueue.id }) : [];
          if (gone) {
            await writeAudit({ actor: o.actor, action: "roster.write.given_up", permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: c.id,
              before: { state: c.state, tries: c.tries, code: c.lastCode, op: c.request.op }, after: { state: "given_up", why: "guardian_removed" } }, sp);
          }
        }
        const b = await guardianBooks(sp, ask.familyId);
        if (!b.ok) return [{ ...at, outcome: maybeMade ? "maybe_made" : "not_sent", why: b.why }];
        const own = await ownParentCustomer(sp, ask.guardianId, b);
        if (own.is !== "own") return [{ ...at, outcome: maybeMade ? "maybe_made" : own.is === "not_own" ? "not_own" : "nothing" }];
        if (!own.active) return [{ ...at, outcome: "inactive_there", holds: own.name }];
        if ((await itemsOfRow(sp, ask.guardianId, ["waiting", "stuck"])).some((i) => i.request.op === "deactivate")) return [{ ...at, outcome: "create_open" }];
        const write: DeactivateWrite = { op: "deactivate", role: "parent", qboId: own.customer, syncToken: own.syncToken, guardianId: ask.guardianId };
        return [{ ...at, outcome: "queued", item: await queueForRow(sp, write, b.realmId, ask.familyId, o), write, holds: own.name }];
      }
      const out: GuardianQueued[] = [];
      // One person, one name (the lead's decision 1(d) in slice 9h's last round): the new name goes to one record of
      // theirs in this go, the first in their rows' order, since QuickBooks takes a name once by the portal's model.
      // Each name given here, by key, with the portal's name of the family whose record it goes to.
      const given = new Map<string, string>();
      const key = nameKey(ask.name);
      for (const row of ask.rows) {
        const at = { guardianId: row.guardianId, familyName: await familyNameOf(row.familyId) };
        const b = await guardianBooks(sp, row.familyId);
        if (!b.ok) { out.push({ ...at, outcome: "not_sent", why: b.why }); continue; }
        const own = await ownParentCustomer(sp, row.guardianId, b);
        if (own.is === "own") {
          if (!own.active) { out.push({ ...at, outcome: "inactive_there", holds: own.name }); continue; }
          // Given to another record of theirs first in this go: not queued, so QuickBooks is never asked for it twice, and
          // a refused rename of this one is left as it is.
          const first = given.get(key);
          if (first !== undefined && own.name !== ask.name) { out.push({ ...at, outcome: "name_once", elsewhere: first }); continue; }
          // A later rename takes the place of a refused one, and takes from it the name the two last agreed on.
          const replaced = await replaceRefused(sp, and(renamesOf(own.customer), ofGuardian(row.guardianId)), { op: "rename", name: ask.name, guardianId: row.guardianId }, o);
          const agreed = replaced.map((r) => r.request).find((w): w is RenameWrite => w.op === "rename")?.was;
          if (own.name === ask.name) { given.set(key, at.familyName); out.push({ ...at, outcome: "has_one", holds: own.name }); continue; }
          const write: RenameWrite = { op: "rename", role: "parent", qboId: own.customer, syncToken: own.syncToken, name: ask.name, was: agreed ?? ask.was, guardianId: row.guardianId };
          given.set(key, at.familyName);
          out.push({ ...at, outcome: "queued", item: await queueForRow(sp, write, b.realmId, row.familyId, o), write, holds: own.name });
          continue;
        }
        if (own.is === "not_own" || row.familyId === null) { out.push({ ...at, outcome: own.is === "not_own" ? "not_own" : "nothing" }); continue; }
        // A create QuickBooks refused as a taken name, or kept as a name it can't take: the new name takes its place only
        // when it is free by the portal's own knowledge (decision 1(c)): no other record of theirs has it or is about to,
        // and no customer QuickBooks holds, nor a change waiting, has it (namesTaken()). Otherwise it stays kept, said.
        const taken = (await itemsOfRow(sp, row.guardianId, ["refused"])).filter((i) => i.request.op === "create" && (i.lastCode === "fault_6240" || i.lastCode === NAME_UNUSABLE));
        if (!taken.length) { out.push({ ...at, outcome: "nothing" }); continue; }
        const elsewhere = given.get(key) ?? (await ownNamedElsewhere(sp, b, row.guardianId, ask.name));
        if (elsewhere !== null) { out.push({ ...at, outcome: "name_held", elsewhere }); continue; }
        if ((await namesTaken(sp, b.cache, null)).some((n) => nameKey(n) === key)) { out.push({ ...at, outcome: "name_held", holds: ask.name }); continue; }
        await replaceRefused(sp, inArray(writeQueue.id, taken.map((t) => t.id)), { op: "create", name: ask.name, guardianId: row.guardianId }, o);
        const made = await createForRow(sp, b, row.guardianId, row.familyId, at.familyName, ask.name, ask.email, o);
        if (made.outcome === "queued") given.set(key, at.familyName);
        out.push(made);
      }
      return out;
    });
  } catch {
    // Nothing of the Parent customers' side is kept; the guardian's own change goes ahead (the lead's decision 6).
    const rows = ask.op === "rename" ? ask.rows.map((r) => r.guardianId) : [ask.guardianId];
    return rows.map((guardianId) => ({ guardianId, familyName: "this family", outcome: "not_sent" as const, why: "failed" as const }));
  }
}

/**
 * The at-once tries of what queueForGuardian() queued, after the guardian's commit, each in transactions of its own
 * (trySavedItem(), the one path every try of a change saved first takes): the caller holds each row's "being sent" lock
 * (whileGuardiansHeld()). A make-inactive goes by the balance rule there. Whatever QuickBooks answers, the guardian's
 * own change stands. Nothing is made under a family while it is being changed in QuickBooks (the lead's decision 2 in
 * slice 9h's last round): a create first takes its family's "being sent" lock, shared, on `hold`, the connection that
 * holds the row's own lock, tried and never waited for, and held so until the tries are over; while the family action
 * holds it, nothing is sent and the item is left waiting for the worker (`deferred` "family"). And no try waits behind
 * a roster read for long (decision 3(e)): when the roster lock isn't free within the guardian writes' three seconds,
 * nothing is sent and the item is left waiting for the worker (`deferred` "roster"), never marked as sent.
 */
export async function sendGuardianSaved(queued: readonly GuardianQueued[], op: GuardianOp, o: { hold: Tx; rosterWaitMs?: number }): Promise<GuardianSent[]> {
  const out: GuardianSent[] = [];
  for (const q of queued) {
    if (q.outcome !== "queued" || !q.item || !q.write) { out.push(q); continue; }
    if (q.write.op === "create" && q.item.familyId !== null && !(await familySendingFree(o.hold, q.item.familyId))) { out.push({ ...q, deferred: "family" }); continue; }
    if (!(await rosterFreeWithin(o.rosterWaitMs ?? GUARDIAN_ROSTER_WAIT_MS))) { out.push({ ...q, deferred: "roster" }); continue; }
    const tried = await trySavedItem(q.item, q.write, { by: "at_once", linkedBy: saverOf(op).staffUserId, actor: op.actor, ip: op.ip, permission: op.permission });
    out.push({ ...q, tried });
  }
  return out;
}

/**
 * What became of each Parent customer a guardian's change touched, in words for the staff member's answer (the add, the
 * reinstate, the removal, a person's rename): one sentence per family, or none where nothing is sent for this club's
 * books, this family or while QuickBooks isn't connected (the pages say which). Names are the portal's own and
 * QuickBooks text, as text.
 */
export function guardianSentWords(sent: readonly GuardianSent[], op: "grant" | "remove" | "rename", who: string): string[] {
  return sent.flatMap((s): string[] => {
    const under = `under ${s.familyName}`;
    switch (s.outcome) {
      // Nothing is said where nothing is sent for this club's books, this family or while QuickBooks isn't connected:
      // the Portal sign-ins box and the person's page say which.
      case "not_sent": return s.why === "failed" ? ["Nothing was sent to QuickBooks for their Parent customer: the portal couldn't save that part of the change, so nothing will be sent for it. Their access in the portal is as said."] : [];
      case "nothing": case "not_own": return op === "remove" ? ["Nothing was sent to QuickBooks for them: they have no Parent customer of their own there."] : [];
      case "named_like": return [`QuickBooks already has a customer named “${s.holds}” ${under} that isn't linked to ${who}, so no Parent customer was made for them. If it is a Parent customer no guardian is linked to, the two can be linked on Accounting links, in the opening of the family's row, by someone who may link families to accounting.`];
      // One person, one name (the lead's decision 1 in slice 9h's last round).
      case "named_elsewhere": return [`QuickBooks already has ${who}'s record under ${s.elsewhere}, and takes a name once, so no Parent customer was made for them ${under}.`];
      case "name_held": return [`Nothing was sent for their Parent customer ${under}, which QuickBooks refused before as a taken name: ${s.elsewhere !== undefined
        ? `the new name goes to their record under ${s.elsewhere}, and QuickBooks takes a name once`
        : `another customer in QuickBooks has the name “${s.holds}” already`}. It stays kept on the Reconciliation page, where you can give it up.`];
      case "linked_before": return [`QuickBooks has the Parent customer “${s.holds}” ${under} that ${who} was linked to until that link ended, so no second one was made for them. While it is active in QuickBooks, it can be linked to them again on Accounting links, in the opening of the family's row.`];
      case "name_once": return [`Their Parent customer ${under} keeps the name it has in QuickBooks: QuickBooks takes a name once, and the new name goes to their record under ${s.elsewhere}.`];
      case "has_one": return op === "rename" ? [`Their Parent customer ${under} has that name in QuickBooks already.`] : [`${who} already has their own Parent customer ${under} in QuickBooks, so none was made.`];
      case "inactive_there": return [op === "remove" ? `Their Parent customer ${under} is inactive in QuickBooks already, so nothing was sent.`
        : `Their Parent customer ${under} is inactive in QuickBooks, and the portal never makes a customer active again, so nothing was sent there.`];
      case "create_open": return [`A change to their Parent customer ${under} is on the Reconciliation page already.`];
      case "maybe_made": return [`Making their Parent customer ${under} may have reached QuickBooks already, so it was left to finish: if QuickBooks made it, the portal links it to them when it finds it there, and it is theirs again if they are added back; if it is given up, one QuickBooks made anyway is linked to nobody in the portal, and once they are added back it can be linked to them on Accounting links, in the opening of the family's row.`];
      case "kept": return [`No Parent customer was made for them ${under}. ${keptRefusalWords(s.code ?? null, null)} It is kept on the Reconciliation page, where you can give it up.`];
      case "queued": break;
    }
    const what = s.write?.op === "create" ? `Making their Parent customer ${under}` : s.write?.op === "rename" ? `Renaming their Parent customer ${under}` : `Making their Parent customer ${under} inactive`;
    const t = s.tried;
    if (s.deferred === "family") return [`${what} wasn't sent just now: ${s.familyName} is being changed in QuickBooks at this moment. It is saved, and the portal sends it shortly; you'll find it on the Reconciliation page until then.`];
    if (s.deferred === "roster") return [`${what} is saved, and will be sent to QuickBooks shortly: the portal is reading the roster from QuickBooks just now. You'll find it on the Reconciliation page until then.`];
    if (!t) return [`${what} is waiting to reach QuickBooks: you'll find it on the Reconciliation page.`];
    switch (t.is) {
      case "done": {
        const done = s.write?.op === "create" ? `QuickBooks has a Parent customer for ${who} ${under} now${t.cached ? ", linked to them" : ""}.`
          : s.write?.op === "rename" ? `Their Parent customer ${under} has the new name in QuickBooks too.` : `Their Parent customer ${under} is inactive in QuickBooks now.`;
        return [t.cached ? done : `${done} The portal finishes it on its side after its next read of QuickBooks, usually within a few minutes.`];
      }
      case "found": return [s.write?.op === "deactivate" ? `Their Parent customer ${under} is inactive in QuickBooks already, so nothing more was sent.` : `QuickBooks has that ${under} already, so nothing was sent.`];
      case "waiting": return [t.sent ? `The portal can't tell yet whether QuickBooks took it (${what.charAt(0).toLowerCase()}${what.slice(1)}): its answer didn't arrive. The portal finishes it after its next read of QuickBooks, and you'll find it on the Reconciliation page until then.`
        : `${what} is waiting to reach QuickBooks: the portal tries again in a minute, then less often, and you'll find it on the Reconciliation page.`];
      case "refused": {
        if (s.write?.op === "create" && t.code === "fault_6240") {
          return [`QuickBooks refused the name “${s.write.name}” as taken: another customer in QuickBooks has that name, so no Parent customer was made for ${who} ${under}. Renaming ${who} changes their name in the portal and on their own record in QuickBooks. “Give up” on the Reconciliation page leaves them as they are, with no record of their own in QuickBooks; after that, a Parent customer under the family that no guardian is linked to can be linked to them on Accounting links, in the opening of the family's row.`];
        }
        if (s.write?.op === "deactivate") {
          const why = t.code === "open_balance" ? "QuickBooks shows an amount owed on it" : t.code === CREDIT_BALANCE ? "QuickBooks shows a credit on it"
            : balanceUnread(t.code) ? "its balance couldn't be read, and nothing is made inactive without it"
              : whoStopped(t.code) === "quickbooks" ? "QuickBooks refused it" : "the portal couldn't send it to QuickBooks at the time";
          return [`Their Parent customer ${under} was left active in QuickBooks: ${why}. It is kept on the Reconciliation page, where you can send it again once that is settled, or give it up.`];
        }
        return [`${what} didn't go through. ${keptRefusalWords(t.code, t.holds)} It is kept on the Reconciliation page.`];
      }
      case "given_up": case "stuck": case "not_reached": case "not_yet": return [`${what} didn't go through: see the Reconciliation page.`];
    }
  });
}

/**
 * Where QuickBooks stands for each of these guardian rows, in words, for a family's Portal sign-ins box and a person's
 * page: their own Parent customer (active or not), a change waiting or kept on the Reconciliation page, a customer of
 * their name under the family not linked to them (item 2(a)), or nothing sent for this club's books or this family;
 * then, since stage 3's slice 11c, a change of their phone or mailing address waiting, stuck or kept there, in words of
 * its own (contactStanding()), and, since slice S11e, one of their sign-in email (emailStanding()). `name` is the
 * person's name. None for a closed row with nothing kept.
 */
export async function guardianStandings(rows: readonly { guardianId: string; familyId: AppFamilyId | null; name: string; open: boolean }[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!rows.length) return out;
  return db.transaction(async (tx) => {
    // Each open row's ended link whose Parent customer the books still hold (slice M3b2), read once for them all: two
    // queries whatever the number of rows, none with no open row.
    const held = (await endedLinksHeld({ guardians: rows.filter((r) => r.open).map((r) => r.guardianId) }, tx)).guardians;
    for (const r of rows) {
      const items = await itemsOfRow(tx, r.guardianId, ["waiting", "stuck", "refused"]);
      const said = [await parentCustomerStanding(tx, r, items.filter((i) => !isDetailsSend(i.request)), held.get(r.guardianId)), contactStanding(items.filter((i) => i.request.op === "contact")),
        emailStanding(items.filter((i) => i.request.op === "email"))]
        .filter((w): w is string => w !== null);
      if (said.length) out.set(r.guardianId, said.join(" "));
    }
    return out;
  });
}
/** guardianStandings()' words for one row's own Parent customer, from its items that aren't a change of its details. */
async function parentCustomerStanding(tx: Tx, r: { guardianId: string; familyId: AppFamilyId | null; name: string; open: boolean }, items: QueueRow[],
  held: EndedHeld | undefined): Promise<string | null> {
  const kept = items.find((i) => i.state === "refused"), open = items.find((i) => i.state !== "refused");
  if (open) return open.state === "stuck" ? "A change to their Parent customer is stuck: see the Reconciliation page." : "A change to their Parent customer is waiting to reach QuickBooks.";
  if (kept) {
    return kept.request.op === "deactivate" ? "Their Parent customer was left active in QuickBooks (kept: see the Reconciliation page)."
      : kept.request.op === "create" ? "No Parent customer was made for them (kept: see the Reconciliation page)." : "Their Parent customer's new name didn't reach QuickBooks (kept: see the Reconciliation page).";
  }
  const b = await guardianBooks(tx, r.familyId);
  if (!b.ok) {
    return b.why === "books" ? "Nothing is sent to QuickBooks for a guardian in this club's books."
      : b.why === "family" ? "Nothing is sent to QuickBooks for them: this family isn't linked to an active family there."
        // Nothing is sent later for what wasn't sent then: say so, never "for now" (no reconnect queues a create).
        : "Nothing is sent to QuickBooks for them while QuickBooks isn't connected to the roster's company, or its customer types don't match the club's setup. Nothing that wasn't sent is sent later by itself: a Parent customer of theirs already under this family in QuickBooks can be linked to them on Accounting links, in the opening of the family's row, while the books' customer types match the club's setup.";
  }
  const own = await ownParentCustomer(tx, r.guardianId, b);
  if (own.is === "own") return own.active ? `Linked to their own Parent customer “${own.name}”.` : `Their own Parent customer “${own.name}” is inactive in QuickBooks; the portal never makes it active again.`;
  if (own.is === "not_own") return "Linked to a customer that isn't their own Parent customer under this family, so nothing is sent for them.";
  if (!r.open) return null;
  // The Parent customer they were linked to under this family until that link ended (slice M3b2: a family's unlink, or
  // since slice M3c Unlink this guardian): none is made beside it.
  const before = heldUnderFamily(held, b);
  if (before !== null) return `QuickBooks has the Parent customer “${before}” under this family that they were linked to until that link ended, so no second one is made. No Parent customer in QuickBooks is linked to them, and none is being made: while it is active, it can be linked to them again on Accounting links, in the opening of the family's row.`;
  const like = namedUnder(b, r.name);
  const elsewhere = like ? null : await ownNamedElsewhere(tx, b, r.guardianId, r.name);
  // An open row with no link and nothing on the queue has nothing coming (added while nothing could be sent, or its
  // create given up): nothing makes one later by itself.
  return like ? `QuickBooks has a customer named “${like.displayName}” under this family that isn't linked to them.`
    : elsewhere !== null ? `QuickBooks already has their record under ${elsewhere}, and takes a name once, so none is made under this family.`
      : "No Parent customer in QuickBooks is linked to them, and none is being made: one under this family in QuickBooks that no guardian is linked to can be linked to them on Accounting links, in the opening of the family's row.";
}
/** Which of a guardian's details a contact change sends, in words. */
const detailsWhat = (w: Pick<ContactWrite, "change">) =>
  w.change.phone !== undefined && w.change.address !== undefined ? "phone and mailing address" : w.change.phone !== undefined ? "phone" : "mailing address";
/**
 * guardianStandings()' words for one row's changes of the guardian's phone and mailing address (stage 3's slice 11c):
 * one waiting (or stuck) to reach their record in QuickBooks, else one the portal kept; null for none. Never the values,
 * and never what QuickBooks holds: Reconciliation's compare view shows both, audited.
 */
function contactStanding(items: QueueRow[]): string | null {
  const item = items.find((i) => i.state !== "refused") ?? items.find((i) => i.state === "refused");
  if (!item || item.request.op !== "contact") return null;
  const what = detailsWhat(item.request);
  if (item.state === "stuck") return `A change to their ${what} is stuck: see the Reconciliation page.`;
  if (item.state === "waiting") return `A change to their ${what} is waiting to reach QuickBooks.`;
  return `A change to their ${what} didn't reach QuickBooks (kept: see the Reconciliation page).`;
}
/**
 * guardianStandings()' words for one row's changes of the person's sign-in email (stage 3's slice S11e), to their own
 * Parent customer or their family's record: one waiting (or stuck), else one kept; null for none. Never an address.
 */
function emailStanding(items: QueueRow[]): string | null {
  const item = items.find((i) => i.state !== "refused") ?? items.find((i) => i.state === "refused");
  if (!item || item.request.op !== "email") return null;
  const where = item.request.role === "parent" ? "their record" : "their family's record";
  if (item.state === "stuck") return `Their new sign-in email is stuck on its way to ${where} in QuickBooks: see the Reconciliation page.`;
  if (item.state === "waiting") return `Their new sign-in email is waiting to reach ${where} in QuickBooks.`;
  return `Their new sign-in email didn't reach ${where} in QuickBooks (kept: see the Reconciliation page).`;
}

/**
 * The kept change of a guardian's phone and mailing address (a `refused` contact item) of each of these rows whose
 * record still stands (the row open, in the active family record it is filed under: compareContact()'s rule), by row:
 * the item a person's page links Reconciliation's compare view to (stage 3's slice 11c). The newest, where several.
 */
export async function keptContactsOf(guardianIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!guardianIds.length) return out;
  const rows = await db.select({ id: writeQueue.id, request: writeQueue.request, familyId: writeQueue.familyId, rowFamily: guardian.familyId, status: guardian.status, active: family.active })
    .from(writeQueue).innerJoin(guardian, sql`${guardian.id}::text = ${writeQueue.request}->>'guardianId'`).innerJoin(family, eq(family.id, guardian.familyId))
    .where(and(eq(writeQueue.state, "refused"), sql`${writeQueue.request}->>'op' = 'contact'`, inArray(guardian.id, [...guardianIds]))).orderBy(desc(writeQueue.createdAt));
  for (const r of rows) {
    const g = guardianOf(r.request);
    if (g === null || out.has(g) || r.status === "disabled" || !r.active || r.familyId === null || String(r.familyId) !== String(r.rowFamily)) continue;
    out.set(g, r.id);
  }
  return out;
}

/* ---- Staff change a guardian's phone and mailing address (stage 3's slice 11c; app-owned families spec section 9,
   open questions 6 and 10, Appendix B) ----
   Staff save a person's details on the person's page, or a family's (books with no parent type) on the family's page,
   through the parent's own save (saveDetails(), src/lib/parents/contact-edits.ts), which queues each change in its
   transaction as a parent's are (queueContactChange()), held for the at-once try (QueueAs: the lease of a change saved
   first, asked by the staff member). After the commit, sendContactSaved() tries each at once, by the one path every try
   takes (trySavedItem()), under the item's lock tried and never waited for, with the guardian writes' wait for the
   roster lock: anything not sent at once is left for the worker, once its lease has run out. The portal's details stand
   whatever QuickBooks does. */

/** What a staff member's save is answered with beside what became of each record (contactSavedWords()). */
export const STAFF_DETAILS_COPY = {
  savedPerson: "Saved. These are their phone and mailing address in the portal now.",
  savedFamily: "Saved. These are the family's phone and mailing address in the portal now, for every guardian of the family.",
  unchanged: "Those are the details the portal holds already, so nothing was changed.",
  changed: "These details changed while you were editing (the parent, or someone else here, saved them meanwhile), so nothing was saved. Here they are as they stand now: make your change again if it is still needed.",
  whoseChanged: "Whose details these are changed while you were editing (the club's membership shape was saved: in books with parents of their own they are each person's, otherwise each family's), so nothing was saved. Reload the page.",
} as const;

/**
 * What became of one record a staff member's save goes to (sendContactSaved()), by the family it is under: `nothing`,
 * nothing was queued for it; `held`, the item's lock was held (another change to the same record under way, or its
 * sender), so nothing was sent and it waits for the worker; `roster`, the roster lock wasn't free within the wait, the
 * same; `replaced`, given up with nothing sent as a newer change of the same record, saved meanwhile, has taken its
 * place and carries it (a later save closed it, or the try found the details changed and such a change is open or done);
 * `outdated`, given up with nothing sent as the portal's details changed again after it and no newer change of that
 * record was queued (none could be: the record inactive in QuickBooks' copy, or no longer the row's own alone);
 * `stopped`, given up with nothing sent as its record is no longer the one it is for (`note`, its reason, in words);
 * `abandoned`, given up meanwhile otherwise (staff on Reconciliation), with `sent` whether any try may have reached
 * QuickBooks (null when the item is gone and the portal can't tell); else trySavedItem()'s outcome.
 */
export type ContactGot = { is: "nothing" } | { is: "held" } | { is: "roster" } | { is: "replaced" } | { is: "outdated" } | { is: "stopped"; note: string }
  | { is: "abandoned"; sent: boolean | null } | SavedTry;
export type ContactSent = { familyName: string; itemId: string | null; write: ContactWrite | null; got: ContactGot };

/** The notes a contact change is given up with when its record is no longer the one it is for (giveUpContact(), and a guardian's removal). */
const CONTACT_RECORD_NOTES = new Set<string>([...Object.entries(CONTACT_STOP_NOTES).flatMap(([k, v]) => (k === "superseded" ? [] : [v])), "The guardian was removed in the portal."]);
/** What a contact item that isn't waiting now holds, told from its row and never guessed (sendContactSaved()). */
async function contactHeld(itemId: string): Promise<ContactGot> {
  const [r] = await db.select().from(writeQueue).where(eq(writeQueue.id, itemId));
  if (!r) return { is: "abandoned", sent: null };
  if (r.state === "done") return { is: "done", cached: true };
  if (r.state === "refused") return { is: "refused", code: r.lastCode ?? "", holds: null };
  if (r.state === "stuck") return { is: "stuck", code: r.lastCode ?? "" };
  if (r.state === "waiting") return { is: "waiting", sent: r.sent };
  // Closed by a later save (queueContactChange()), which queued the change that takes its place.
  if (r.note === CONTACT_REPLACED_NOTE) return { is: "replaced" };
  // The try found the portal's details changed: a newer change carries them only where one of the same record was queued.
  if (r.note === CONTACT_STOP_NOTES.superseded) return (await newerContactOf(r)) ? { is: "replaced" } : { is: "outdated" };
  if (r.note !== null && CONTACT_RECORD_NOTES.has(r.note)) return { is: "stopped", note: r.note };
  return { is: "abandoned", sent: r.sent };
}
/**
 * Whether a contact change of the same record and membership as `r` (queueContactChange()'s own match: the company,
 * the customer, the guardian row or none) was queued after it and is open or done: the change that carries its details.
 */
async function newerContactOf(r: QueueRow): Promise<boolean> {
  const g = guardianOf(r.request);
  const [newer] = await db.select({ id: writeQueue.id }).from(writeQueue).where(and(ne(writeQueue.id, r.id), eq(writeQueue.realmId, r.realmId),
    r.targetQboId === null ? sql`false` : eq(writeQueue.targetQboId, r.targetQboId), sql`${writeQueue.request}->>'op' = 'contact'`,
    g === null ? sql`${writeQueue.request}->>'guardianId' is null` : sql`${writeQueue.request}->>'guardianId' = ${g}`,
    gte(writeQueue.createdAt, r.createdAt), ne(writeQueue.state, "given_up"))).limit(1);
  return newer !== undefined;
}

/**
 * The records a staff member's save of `of` goes to, each by the family it is under (the person's open memberships in
 * active family records, by row; or the family itself), with the item queued for each where there is one. An item
 * queued for a membership the list no longer has (closed between the save and this) is kept too, by its family.
 */
async function contactPlaces(of: DetailsOf, items: readonly QueueRow[]): Promise<{ familyName: string; item: QueueRow | null }[]> {
  const nameOf = async (ids: AppFamilyId[]) => new Map((ids.length ? await db.select({ id: family.id, name: family.name }).from(family).where(inArray(family.id, ids)) : [])
    .map((f) => [String(f.id), recordNameWords(f.name, "family")]));
  if (of.kind === "family") {
    const names = await nameOf([of.familyId]);
    const item = items.find((i) => i.request.op === "contact" && guardianOf(i.request) === null) ?? null;
    return [{ familyName: names.get(String(of.familyId)) ?? recordNameWords(null, "family"), item }];
  }
  const rows = await db.select({ id: guardian.id, familyId: guardian.familyId }).from(guardian).innerJoin(family, eq(family.id, guardian.familyId))
    .where(and(eq(guardian.parentId, of.parentId), ne(guardian.status, "disabled"), eq(family.active, true))).orderBy(asc(guardian.id));
  const names = await nameOf([...new Set([...rows.flatMap((r) => (r.familyId === null ? [] : [r.familyId])), ...items.flatMap((i) => (i.familyId === null ? [] : [i.familyId]))])]);
  const named = (id: AppFamilyId | null) => (id === null ? undefined : names.get(String(id))) ?? recordNameWords(null, "family");
  const placed = rows.map((r) => ({ familyName: named(r.familyId), item: items.find((i) => guardianOf(i.request) === r.id) ?? null }));
  const left = items.filter((i) => !placed.some((p) => p.item?.id === i.id)).map((i) => ({ familyName: named(i.familyId), item: i }));
  return [...placed, ...left];
}

/**
 * The at-once tries of a staff member's save of a guardian's phone and mailing address (stage 3's slice 11c, the lead's
 * decision 3), after the save's commit and never inside it: for each record the save goes to (contactPlaces()), the item
 * queued for it (`itemIds`, saveDetails()'s), read again, then, holding the item's lock (whileItemHeld(), tried and
 * never waited for: held by someone else, nothing is sent and the item waits for the worker, which takes it once its
 * lease has run out), the roster lock waited for at most the guardian writes' three seconds (rosterFreeWithin(): past
 * that nothing is sent, the item is never marked as sent, and the worker takes it), then one try by the one path every
 * try takes (trySavedItem()), so the gate (contactSendsMayGo()), the record's checks (contactStops()), the comparison
 * (tryContact()), the version and the stale settle are the worker's; its own looks under the roster lock wait no longer
 * than that wait either (RosterBusyAtTry: nothing sent, the item as it was). The row is read again once the item's lock
 * is held, and the try is made from that row, only while it is still waiting and no try has been made of it since it was
 * first read (the worker takes an item whose lease ran out while an earlier item's try was under way): otherwise it is
 * left to the worker, untouched. An item that is no longer waiting, or that the try finds given up, is told from what
 * its row holds (contactHeld()), and so is one found given up when it is read again after a lock held or a busy roster
 * left nothing sent. `rosterWaitMs` is for tests.
 */
export async function sendContactSaved(of: DetailsOf, itemIds: readonly string[], op: GuardianOp & { staffUserId: string }, o: { rosterWaitMs?: number } = {}): Promise<ContactSent[]> {
  const items = itemIds.length ? await db.select().from(writeQueue).where(inArray(writeQueue.id, [...itemIds])) : [];
  const wait = o.rosterWaitMs ?? GUARDIAN_ROSTER_WAIT_MS;
  const out: ContactSent[] = [];
  for (const { familyName, item } of await contactPlaces(of, items)) {
    if (!item || item.request.op !== "contact") { out.push({ familyName, itemId: null, write: null, got: { is: "nothing" } }); continue; }
    const write = item.request;
    const at = { familyName, itemId: item.id, write };
    if (item.state !== "waiting") { out.push({ ...at, got: await contactHeld(item.id) }); continue; }
    const tried = await whileItemHeld(item, async (): Promise<SavedTry | "roster" | "moved_on"> => {
      if (!(await rosterFreeWithin(wait))) return "roster";
      // Read again under the item's lock: only the row as it stands now is tried, and only while nobody has tried it since.
      const [now] = await db.select().from(writeQueue).where(eq(writeQueue.id, item.id));
      if (!now || now.state !== "waiting" || now.sent !== item.sent || now.tries !== item.tries || now.request.op !== "contact") return "moved_on";
      try {
        return await trySavedItem(now, now.request, { by: "at_once", linkedBy: op.staffUserId, actor: op.actor, ip: op.ip, permission: op.permission, rosterWaitMs: wait });
      } catch (e) {
        if (e instanceof RosterBusyAtTry) return "roster";
        throw e;
      }
    });
    // Nothing sent as a lock was held or the roster busy: read again, so an item given up meanwhile (on Reconciliation,
    // while this waited) is told from what its row holds, never promised to the worker.
    const leftFor = async (g: ContactGot): Promise<ContactGot> => {
      const [r] = await db.select({ state: writeQueue.state }).from(writeQueue).where(eq(writeQueue.id, item.id));
      return r?.state === "waiting" ? g : contactHeld(item.id);
    };
    const got: ContactGot = tried === null || tried === FAMILY_HELD ? await leftFor({ is: "held" }) : tried === "roster" ? await leftFor({ is: "roster" })
      : tried === "moved_on" || tried.is === "given_up" ? await contactHeld(item.id) : tried;
    out.push({ ...at, got });
  }
  return out;
}

/**
 * What became of each record a staff member's save of a guardian's details goes to, in words (one sentence per family:
 * the person's own record under each family they are a guardian of, or the family's own record), with the answer's
 * status as the other changes saved first use it (`waiting`, information; `attention`, needs attention; none when each
 * is in QuickBooks, or nothing was sent for it), and the kept items a reader who may open Reconciliation's compare view
 * is linked to (`compare`). Never a promise that QuickBooks will hold the details: what was done, and what is left to
 * the worker. `whose`: a person's details, or a family's. `mayCompare`: the reader may open the compare view; otherwise
 * `whoCompares` says who can. Names are the portal's own, as text.
 */
export function contactSavedWords(sent: readonly ContactSent[], whose: "person" | "family", o: { mayCompare: boolean; whoCompares: string }):
  { sentences: string[]; status?: "waiting" | "attention"; compare: string[] } {
  const sentences: string[] = [];
  const compare: string[] = [];
  let waiting = false, attention = false;
  for (const s of sent) {
    const rec = whose === "person" ? `their record under ${s.familyName}` : `${s.familyName}'s record`;
    const got = s.got;
    switch (got.is) {
      case "nothing":
        sentences.push(whose === "person" ? `Nothing was sent to QuickBooks for their membership of ${s.familyName}: the “In QuickBooks” column says where QuickBooks stands for it.`
          : `Nothing was sent to QuickBooks for ${s.familyName}.`);
        break;
      case "done":
        sentences.push(got.cached ? `QuickBooks has them on ${rec} now.` : `QuickBooks took them for ${rec}; the portal's copy of QuickBooks shows them after its next read.`);
        break;
      case "found":
        sentences.push(`QuickBooks held them on ${rec} already, so nothing was sent.`);
        break;
      case "not_yet":
        waiting = true;
        sentences.push(`Nothing was sent to ${rec} yet: the portal is still waiting for its read of the phones and mailing addresses QuickBooks holds (the first since this version was installed, or since the membership shape was last saved). They are sent once that read is done, usually within a few minutes, and you'll find them on the Reconciliation page until then.`);
        break;
      case "waiting":
        waiting = true;
        sentences.push(got.sent ? `The portal can't tell yet whether QuickBooks took them for ${rec}: its answer didn't arrive. The portal finishes it after its next read of QuickBooks, and you'll find it on the Reconciliation page until then.`
          : `Sending them to ${rec} is waiting to reach QuickBooks: the portal tries again in a minute, then less often, and you'll find it on the Reconciliation page.`);
        break;
      case "held":
        waiting = true;
        sentences.push(`Nothing was sent to ${rec} just now: another change to this record is under way at this moment. The portal tries them shortly, and you'll find them on the Reconciliation page until then.`);
        break;
      case "roster":
        waiting = true;
        sentences.push(`Nothing was sent to ${rec} just now: the roster is busy at this moment. The portal tries them shortly, and you'll find them on the Reconciliation page until then.`);
        break;
      case "replaced":
        waiting = true;
        sentences.push(`Nothing was sent to ${rec} from this save: a newer change to these details, saved meanwhile, has taken its place and carries them. The portal sends that one on, and the Reconciliation page lists it if it doesn't go through.`);
        break;
      case "stopped":
        attention = true;
        sentences.push(`Nothing was sent to ${rec}: ${got.note.charAt(0).toLowerCase()}${got.note.slice(1)}`);
        break;
      case "refused": {
        attention = true;
        const may = o.mayCompare && s.itemId !== null;
        if (may) compare.push(s.itemId!);
        sentences.push(`They didn't reach ${rec} in QuickBooks. ${keptContactWords(got.code, s.write ?? undefined)} It is kept on the Reconciliation page: ${may ? "compare the two there, from the link below." : o.whoCompares}`);
        break;
      }
      case "outdated":
        attention = true;
        sentences.push(`Nothing was sent to ${rec} from this save: the portal's details changed again after it, and no newer change of them was queued for this record, so nothing goes to QuickBooks for it. This page shows the details the portal holds now.`);
        break;
      case "abandoned": case "given_up": {
        attention = true;
        // Told from the row: whether any try of it may have reached QuickBooks, never guessed (null: the item is gone).
        const sentOnce = got.is === "abandoned" ? got.sent : null;
        sentences.push(sentOnce === false
          ? `Nothing was sent to ${rec}: the change was given up on the Reconciliation page meanwhile. The portal keeps the details.`
          : `The change for ${rec} was given up on the Reconciliation page while it was being sent, so QuickBooks has the details only if that try got through. The portal keeps them.`);
        break;
      }
      case "stuck": case "not_reached":
        attention = true;
        sentences.push(`Sending them to ${rec} didn't go through: see the Reconciliation page.`);
        break;
    }
  }
  return { sentences, ...(attention ? { status: "attention" as const } : waiting ? { status: "waiting" as const } : {}), compare };
}

/**
 * "Send the portal's value" for a guardian's kept item (sendAgainHolding()), checked under the roster lock: a create,
 * the row still open and unlinked, the family still linked to the active customer it was asked under, no customer of
 * the person's name under it (item 2(a)), the person's current name the one the row showed and usable, the address
 * within its limit, never a taken name (6240: a rename of the person takes its place); a rename, the row still open
 * and its own active Parent customer the one asked about, the person's name still the one asked, never a taken name; a
 * make-inactive, the row still closed and still linked to that customer, active in the cache, nothing waiting for it.
 * The balance is the caller's to read live.
 */
async function guardianPress(tx: Tx, item: QueueRow, w: RosterWrite, guardianId: string, shown: string, realmId: string, cache: (Cust & { syncToken: string })[]):
  Promise<{ ok: true; write: CreateWrite | RenameWrite | DeactivateWrite } | { ok: false; error: string }> {
  const no = (error: string) => ({ ok: false as const, error });
  const [row] = await tx.select({ id: guardian.id, status: guardian.status, familyId: guardian.familyId, parentId: guardian.parentId }).from(guardian).where(eq(guardian.id, guardianId)).for("update");
  if (!row || row.familyId === null || item.familyId === null || String(row.familyId) !== String(item.familyId)) return no(RECORD_MOVED_ON);
  const [p] = await tx.select({ name: parent.name }).from(parent).where(eq(parent.id, row.parentId));
  if (!p) return no(RECORD_MOVED_ON);
  const linked = await customerOfGuardian(guardianId, tx);
  if (w.op === "create") {
    if (item.lastCode === "fault_6240") return no(GUARDIAN_TAKEN_NAME);
    if (row.status === "disabled" || linked !== null) return no(RECORD_MOVED_ON);
    const familyCustomer = await customerOfFamily(row.familyId, tx);
    if (familyCustomer === null || familyCustomer !== w.familyQboId || !cache.find((c) => c.qboId === familyCustomer)?.active) return no("The guardian's family isn't linked to that active family in QuickBooks now, so nothing was sent. Reload the page.");
    if (p.name !== shown) return no("The person was renamed since this page was shown, so nothing was sent. Reload the page to see the name that would be sent.");
    const like = cache.find((c) => c.active && c.parentQboId === familyCustomer && nameKey(c.displayName) === nameKey(p.name));
    if (like) return no(`QuickBooks has a customer named “${like.displayName}” under this family now, which isn't linked to them, so nothing was sent. Give this up: then, if it is a Parent customer no guardian is linked to, the two can be linked on Accounting links, in the opening of the family's row.`);
    const shape = await getShape(tx);
    const parentType = shape?.kind === "layered" ? shape.parentTypeId : null;
    const elsewhere = parentType === null ? null : await ownNamedElsewhere(tx, { ok: true, realmId, parentTypeId: parentType, familyCustomer, cache }, guardianId, p.name);
    if (elsewhere !== null) return no(`QuickBooks already has their record under ${elsewhere}, and takes a name once, so nothing was sent. Give this up: they keep their access in the portal.`);
    const name = checkName(p.name);
    if (!name.ok) return no(`The person's name can't be used in QuickBooks: ${name.error} Rename them on their page first.`);
    if ((w.email ?? "").length > 100) return no(keptRefusalWords(EMAIL_TOO_LONG, null));
    if (await waitingForCustomer(tx, familyCustomer)) return no(WRITE_COPY.waiting);
    return { ok: true, write: { ...w, name: name.name } };
  }
  if (w.op !== "rename" && w.op !== "deactivate") return no(NO_LONGER_REFUSED);
  if (linked !== w.qboId) return no(RECORD_MOVED_ON);
  if (!cache.find((x) => x.qboId === w.qboId)?.active) return no(INACTIVE_THERE);
  if (await guardianCustomerHeld(tx, realmId, w.qboId, guardianId)) return no(RECORD_MOVED_ON);
  if (await waitingForCustomer(tx, w.qboId)) return no(WRITE_COPY.waiting);
  if (w.op === "rename") {
    if (row.status === "disabled") return no(RECORD_MOVED_ON);
    if (item.lastCode === "fault_6240") return no(GUARDIAN_RENAME_TAKEN);
    if (p.name !== w.name) return no(RECORD_MOVED_ON);
    return { ok: true, write: w };
  }
  if (row.status !== "disabled") return no("The guardian was added back since this was kept, so nothing was sent. Give this up.");
  return { ok: true, write: w };
}
