// Staff only: a staff member's changes to the roster in QuickBooks (v1 spec §6.1, §6.3). It loads every family in the
// club, so it is never imported by parent code (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts). It is
// the only module that may call the client's roster writes (tests/unit/quickbooks-writes.test.ts): the staff roster
// actions and the write queue's job reach QuickBooks through it.
import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { qboCustomer, qboCustomerType, writeQueue, type RosterRole, type RosterWrite } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getConnection } from "@/lib/quickbooks/connection";
import { qboCreateCustomer, qboCustomerById, qboMoveCustomer, qboRenameCustomer, qboSetCustomerActive } from "@/lib/quickbooks/client";
import { QboError } from "@/lib/quickbooks/endpoints";
import { normalizeEmail } from "@/lib/email";
import { lockRosterAs, rosterTagOf, ROSTER_MOVED } from "@/lib/seasons/roster-lock";
import { reconcileAccess } from "@/lib/parents/reconcile";
import { askForRosterRefresh, ROSTER_ASK_KEY } from "@/lib/parents/refresh-ask";
import { formsForMovedStudent } from "@/lib/forms/moved";
import { volunteerForMovedStudent } from "@/lib/volunteer/moved-student";
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

export type WriteOp = { actor: Actor; ip: string | null; permission: string };

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
  queued: "QuickBooks couldn't take this just now, so it is waiting to reach QuickBooks. The portal tries again in a minute, then less often, and you'll find it on the Reconciliation page.",
} as const;

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

type Prepared = { ok: true; write: RosterWrite; realmId: string; familyQboId: string | null; tag: string } | { ok: false; result: WriteResult };

/**
 * Everything checked before anything is sent, under the roster lock (lockRosterAs): the page was shown this company's
 * roster, QuickBooks is connected to that company, the shape offers the change, every id is on the roster in the role
 * the change needs, nothing is waiting for the same record, and the name is free. Returns the write as it will be sent.
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
    const done = (write: RosterWrite, familyQboId: string | null): Prepared => ({ ok: true, write, realmId: source, familyQboId, tag: rosterTag });

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
    const [open] = await tx.select({ id: writeQueue.id }).from(writeQueue)
      .where(and(eq(writeQueue.targetQboId, record.qboId), inArray(writeQueue.state, ["waiting", "stuck"]))).limit(1);
    if (open) return no(WRITE_COPY.waiting);

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
      return done({ op: "move", role: "student", qboId: record.qboId, syncToken: ask.syncToken, fromFamilyQboId: where.familyQboId!, toFamilyQboId: ask.toFamilyQboId }, where.familyQboId);
    }
    if (!allowed(deactivateOf(where.role))) return no(WRITE_COPY.notOffered);
    if (!record.active) return no("That is inactive in QuickBooks already, so there was nothing to change.");
    return done({ op: "deactivate", role: where.role, qboId: record.qboId, syncToken: ask.syncToken }, where.familyQboId);
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
 * only for a customer the shape names, as the refresh keeps them. Returns the row as the cache now has it.
 */
async function upsertFromAnswer(tx: Tx, answer: Record<string, unknown>, shape: MembershipShape | null) {
  const row = customerRow(answer, new Set(shapeTypeIds(shape)), new Date());
  if (!row) return null;
  const [cached] = await tx.select().from(qboCustomer).where(eq(qboCustomer.qboId, row.qboId)).for("update");
  if (cached && tokenNumber(cached.syncToken) >= tokenNumber(row.syncToken)) return cached;
  if (cached) await tx.update(qboCustomer).set(row).where(eq(qboCustomer.qboId, row.qboId));
  else await tx.insert(qboCustomer).values(row);
  return row;
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
 * stays with the family it was earned for), then the audit row of the move's follow-up with their counts. The answer's
 * `tell` emails the guardians whose places were given up: call it after the transaction commits.
 */
export async function afterStudentMoved(tx: Tx, move: { studentQboId: string; fromFamilyQboId: string; toFamilyQboId: string; cause: string },
  o: { actor: Actor; ip: string | null }): Promise<{ tell: () => Promise<unknown> }> {
  const who = { studentQboId: move.studentQboId, fromFamilyQboId: move.fromFamilyQboId, toFamilyQboId: move.toFamilyQboId };
  const forms = await formsForMovedStudent(tx, { ...who, actor: o.actor, ip: o.ip });
  const volunteer = await volunteerForMovedStudent(tx, who, { actor: o.actor, ip: o.ip });
  await writeAudit({ actor: { door: "system", id: null, label: "roster" }, action: "roster.student.move.followed", targetType: "qbo_customer", targetId: move.studentQboId,
    after: { fromFamilyQboId: move.fromFamilyQboId, toFamilyQboId: move.toFamilyQboId, cause: move.cause,
      formsMoved: forms.moved, formsReset: forms.reset, formsToWithdraw: forms.toWithdraw.length, placesGivenUp: volunteer.cancelled } }, tx);
  return { tell: volunteer.tell };
}

/**
 * What follows a write QuickBooks said yes to (spec 6.1: QuickBooks first, then the cache from its answer). In one
 * transaction that holds the roster lock: when the cache is still the company the write was sent to, the customer is
 * stored from the answer (only if newer), a moved student's follow-ups run, a family made inactive asks the worker for
 * a roster refresh (QuickBooks may have changed the customers under it), and the reconcile brings sign-ins in line (a
 * new parent can sign in at once; an inactive family, student or parent ends what the rules say). The write is audited
 * with before and after, whether or not the cache could take it. `inside` runs last, in the same transaction.
 */
export async function applyWritten(w: RosterWrite, answer: Record<string, unknown>, o: { realmId: string; actor: Actor; ip: string | null; permission?: string;
  queueId?: string; inside?: (tx: Tx) => Promise<void> }): Promise<void> {
  let tell: (() => Promise<unknown>) | null = null;
  await db.transaction(async (tx) => {
    const ours = await lockRosterAs(tx, rosterTagOf(o.realmId));
    const [cached] = w.op === "create" ? [] : await tx.select().from(qboCustomer).where(eq(qboCustomer.qboId, w.qboId));
    const cause = `${AUDIT_ACTION[w.op]}#${w.op === "create" ? nameKey(w.name).slice(0, 40) : w.qboId}`;
    const fits = answerIsFor(w, answer);
    let refreshAsked = false;
    if (ours && fits) {
      await upsertFromAnswer(tx, answer, await getShape(tx));
      if (w.op === "move") ({ tell } = await afterStudentMoved(tx, { studentQboId: w.qboId, fromFamilyQboId: w.fromFamilyQboId, toFamilyQboId: w.toFamilyQboId, cause }, o));
      if (w.op === "deactivate" && w.role === "family") { await askForRosterRefresh(tx); refreshAsked = true; }
      await reconcileAccess(tx, { cause });
    } else if (ours) {
      await askForRosterRefresh(tx); refreshAsked = true; // the answer wasn't the record asked about: read the roster again rather than guess
    }
    await writeAudit({ actor: o.actor, action: AUDIT_ACTION[w.op], permission: o.permission, ip: o.ip, targetType: "qbo_customer",
      targetId: w.op === "create" ? (typeof answer.Id === "string" ? answer.Id.slice(0, 64) : "unknown") : w.qboId,
      before: auditBefore(w, cached), after: { ...auditAfter(w, answer), ...(o.queueId ? { queueId: o.queueId } : {}), ...(refreshAsked ? { refreshAsked } : {}),
        ...(!ours ? { code: "company_changed" } : !fits ? { code: "answer_other" } : {}) } }, tx);
    if (o.inside) await o.inside(tx);
  });
  // The guardians whose places a moved student gave up are told once the move is committed. A mail failure is the
  // notices' own to record; it never undoes the move.
  if (tell) await (tell as () => Promise<unknown>)().catch(() => undefined);
}

/** Puts a write that may go through later on the queue, audited, in one transaction. */
async function enqueue(p: { write: RosterWrite; realmId: string; familyQboId: string | null }, code: string, sent: boolean, o: WriteOp & { staffUserId: string | null }): Promise<void> {
  await db.transaction(async (tx) => {
    const [item] = await tx.insert(writeQueue).values({
      realmId: p.realmId, request: p.write, targetQboId: p.write.op === "create" ? null : p.write.qboId, familyQboId: p.familyQboId,
      sent, lastCode: code.slice(0, 40), nextTryAt: new Date(Date.now() + 60_000), askedBy: o.staffUserId, askedByLabel: o.actor.label,
    }).returning({ id: writeQueue.id });
    await writeAudit({ actor: o.actor, action: "roster.write.queued", permission: o.permission, ip: o.ip, targetType: "write_queue", targetId: item!.id,
      after: { op: p.write.op, role: p.write.role, code: code.slice(0, 40), sent } }, tx);
  });
}

/** The record read again after it changed in QuickBooks, stored in the cache when newer, as the page shows it. */
async function readAgain(qboId: string, realmId: string): Promise<CurrentRecord | null> {
  let answer: Record<string, unknown> | null;
  try { answer = await qboCustomerById(qboId, { failFast: true, realmId, timeoutMs: 5_000 }); } catch (e) { if (e instanceof QboError) return null; throw e; }
  if (!answer || answer.Id !== qboId) return null;
  return db.transaction(async (tx) => {
    if (!(await lockRosterAs(tx, rosterTagOf(realmId)))) return null;
    const row = await upsertFromAnswer(tx, answer, await getShape(tx));
    await reconcileAccess(tx, { cause: `roster.read_again#${qboId}` });
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
        const current = p.write.op === "create" ? null : await readAgain(p.write.qboId, p.realmId);
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
      default:
        await audited(e.code, p.write, target);
        return refuse(failure.kind === "not_connected" ? WRITE_COPY.notConnected : failure.kind === "needs_admin" ? WRITE_COPY.needsAdmin
          : failure.kind === "other_company" ? WRITE_COPY.otherCompany : e.code === "bad_id" ? WRITE_COPY.notSent : WRITE_COPY.refused);
    }
  }
  await applyWritten(p.write, answer, { realmId: p.realmId, actor: o.actor, ip: o.ip, permission: o.permission });
  return { ok: true, message: DONE_WORDS[p.write.op] };
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
