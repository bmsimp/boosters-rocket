// Staff add, remove and reinstate a family's guardians (stage 3's slice 7b of the app-owned families spec, section 6:
// "Staff add a guardian to a family with a name and email"), the portal's own change first. Since stage 3's slice 9h a
// guardian's own Parent customer follows, where the books have a parent type and the family is linked: its create on
// an add or reinstate, its make-inactive (under the balance rule) on a removal, queued in the guardian's own
// transaction and sent after it commits, under the row's "being sent" lock (src/lib/roster/writes.ts,
// queueForGuardian(), sendGuardianSaved()); nothing QuickBooks says changes who may sign in. A family's email field in
// books with no parent type is S11's. Staff
// only: called from src/app/staff/(app)/parents/actions.ts behind `Roster.Family.ReadWrite` (the lead's choice: giving
// an address a family's sign-in goes with the permission that changes a family); never from parent code, which may not
// import it (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts): it gives any address access to any family.
//
// Every write here holds what keeps a family record and its link still under it: the roster lock, shared, taken before
// the family is looked at and before any guardian row is, so no staff roster write (which may change a family's
// record) and no change of company runs between the check and the write. The locks come in the one order ./sessions.ts gives
// (lockedPerson()): the parents' settings lock, shared, first (a switch takes it before the people it touches, so a
// welcome switched on or off meanwhile is seen as it ends); then the person's own: for an add, the address lock and the
// `parent` row that holds the address; for a remove or a reinstate, the `parent` row alone (their address isn't
// changed or claimed); then the roster lock, as a parent's email confirm takes it after the same person's locks (were
// the roster lock held while waiting for the person, that confirm, holding the person and asking for the roster, would
// close a cycle Postgres ends by aborting one of the two); then the guardian row, and what hangs on the person (their
// requests, codes and sessions) last. The roster lock is waited for at most three seconds, as the email confirm waits
// for it (a roster read holds it through its whole QuickBooks read, and the person's row held meanwhile would hold up
// that person's code request and the daily clean-up): when it is busy, nothing has been written and the answer is
// `busy`. A guardian row names the family itself in `family_id` (a person is in a family record once, the unique index
// of migration 0040): nothing else gives a row its family since stage 3's slice 9c (no roster read brings the records
// into step). Since stage 3's slice 9d a family with no link takes guardians too: a row made while its family has a
// link keeps naming that customer in `family_qbo_id`, as the old unique index by customer still needs, and one made
// while it has none names no customer, and is never given one later.
import { randomUUID } from "node:crypto";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { family, guardian, parent, parentAuthUser } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { normalizeEmail } from "@/lib/email";
import { customerOfFamily, familyLinkState } from "@/lib/families/links";
import type { AppFamilyId } from "@/lib/families/ids";
import { recordNameWords } from "@/lib/families/words";
import { ROSTER_LOCK } from "@/lib/roster/shape";
import { familyCreateWaiting, familySendingFree, guardianChangeWaiting, guardianSentWords, queueForGuardian, sendGuardianSaved, whileGuardiansHeld, type GuardianQueued } from "@/lib/roster/writes";
import { closeMembership } from "./membership";
import type { StaffOp } from "./people";
import { lockEmail } from "./sessions";
import { getParentSettings, PARENTS_KEY } from "./settings";

/** The longest name staff may give a person, and the longest address the portal reads. */
export const PERSON_NAME_MAX = 100;
const EMAIL_MAX = 320;
/** The longest note staff may keep when removing a guardian. */
export const REMOVE_NOTE_MAX = 500;
/** How long a staff guardian write waits for the roster lock before it answers `busy`: the email confirm's three seconds. */
export const ROSTER_WAIT_MS = 3000;
/** How long the roster lock is waited for; a test may shorten or lengthen it. */
export type Waits = { rosterWaitMs?: number };

/** A person's name as staff typed it, trimmed, with its spaces closed up: 1 to 100 characters, none a control character. */
export function personName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= PERSON_NAME_MAX && !/\p{Cc}/u.test(name) ? name : null;
}

/** The address staff typed, by the portal's own rule (normalizeEmail(): trimmed, lower-cased, a valid address). */
export const guardianEmail = (raw: string): string | null => (raw.length <= EMAIL_MAX ? normalizeEmail(raw) : null);

/** The parents' settings lock, shared: the first lock of every write here, before the person's. */
const holdSettings = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${PARENTS_KEY}))`);

const pgCode = (e: unknown): unknown => {
  const code = (v: unknown) => (typeof v === "object" && v !== null ? (v as { code?: unknown }).code : undefined);
  return code(e) ?? code((e as { cause?: unknown } | null)?.cause);
};

/**
 * The roster lock, shared: after the person's locks, before the family is looked at or a guardian row taken. Waited for
 * at most `waitMs`, in a savepoint (the lock, once taken, is the transaction's until it ends); false when it was busy
 * that long, with nothing written.
 */
export async function holdRoster(tx: Tx, w: Waits): Promise<boolean> {
  const waitMs = Math.max(1, Math.floor(w.rosterWaitMs ?? ROSTER_WAIT_MS));
  try {
    await tx.transaction(async (sp) => {
      await sp.execute(sql.raw(`set local lock_timeout = '${waitMs}ms'`));
      await sp.execute(sql`select pg_advisory_xact_lock_shared(${ROSTER_LOCK})`);
      await sp.execute(sql`set local lock_timeout to default`);
    });
    return true;
  } catch (e) {
    if (pgCode(e) === "55P03") return false; // lock_not_available: a roster read holds it
    throw e;
  }
}

type Person = typeof parent.$inferSelect;
type Row = typeof guardian.$inferSelect;

/**
 * Marks the person as owed a welcome when welcomes are on and they were never welcomed, aren't owed one already and
 * aren't blocked: whether or not their row counts yet (the welcome job sends it once they have a row that counts,
 * hasRowThatCounts(), and skips them until then). Returns what the grant's audit row records.
 */
async function oweWelcome(tx: Tx, p: Person): Promise<{ welcomeOwed?: true }> {
  if (!(await getParentSettings(tx)).welcome || p.welcomedAt || p.welcomeOwed || p.blocked) return {};
  await tx.update(parent).set({ welcomeOwed: true, updatedAt: new Date() }).where(eq(parent.id, p.id));
  p.welcomeOwed = true;
  return { welcomeOwed: true };
}

/**
 * Why a family can't take a guardian now, or the customer its own family link names when it can (null for a family
 * with no link, which takes guardians since stage 3's slice 9d): its record, active, no create of its own waiting or
 * stuck on the queue (`waiting`) or being sent at this moment (`making`: nothing else is changed on a family while its
 * customer is still being made), a linked family not being changed in QuickBooks at this moment (`changing`: the family
 * action or its rename on its way, stage 3's slice 9h), and whether it has a link known (`other_company` while the portal can't tell, as
 * when QuickBooks is connected to another company than the roster's: a row made then would name no customer for a
 * family that has one, and is never filled in later).
 */
async function familyRefusal(tx: Tx, familyId: AppFamilyId | null): Promise<{ refusal: "no_family" | "inactive" | "waiting" | "making" | "changing" | "other_company" } | { customer: string | null }> {
  if (familyId === null) return { refusal: "no_family" };
  const [f] = await tx.select({ active: family.active }).from(family).where(eq(family.id, familyId));
  if (!f) return { refusal: "no_family" };
  if (!f.active) return { refusal: "inactive" };
  const making = await familyCreateWaiting(tx, familyId);
  if (making) return { refusal: making === "sending" ? "making" : "waiting" };
  const link = await familyLinkState(familyId, tx);
  if (link.state === "unknown") return { refusal: "other_company" };
  // A linked family being changed in QuickBooks at this moment (its "being sent" lock held: the family action making
  // everyone under it inactive, or its rename on its way): no guardian is added or brought back meanwhile, whose Parent
  // customer would be made under it after that action read who is there (stage 3's slice 9h). Tried shared, and held so
  // to the end of this transaction; the family action then finds this guardian's create waiting (GUARDIAN_PENDING).
  if (link.state === "linked" && !(await familySendingFree(tx, familyId))) return { refusal: "changing" };
  return { customer: link.state === "linked" ? link.customerId : null };
}

/** The names of the families a person is an open guardian of now, by name: what staff are shown before an add reuses them. */
async function openFamiliesOf(tx: Tx, parentId: string): Promise<string[]> {
  const rows = await tx.select({ name: family.name }).from(guardian).innerJoin(family, eq(family.id, guardian.familyId))
    .where(and(eq(guardian.parentId, parentId), ne(guardian.status, "disabled"))).orderBy(asc(family.name), asc(family.id));
  return rows.map((r) => recordNameWords(r.name, "family"));
}

/**
 * Opens a closed row again as it was before it closed (`status_before_disable`, else invited), in the family it names,
 * and records it (`parent.access.granted`, `reinstated`, with `more`: what an add adds), naming the customer the row
 * itself names (`family_qbo_id`; none for a row made while its family had no link, even once the family is linked).
 * The caller holds the person's
 * row and this row FOR UPDATE.
 */
async function reopen(tx: Tx, row: Row, p: Person, familyId: AppFamilyId, o: StaffOp, more: Record<string, unknown> = {}): Promise<void> {
  const status = row.statusBeforeDisable ?? "invited";
  const before = { status: row.status, disabledReason: row.disabledReason };
  await tx.update(guardian).set({ status, disabledReason: null, statusBeforeDisable: null, updatedAt: new Date() }).where(eq(guardian.id, row.id));
  const owed = await oweWelcome(tx, p);
  await writeAudit({ actor: o.actor, action: "parent.access.granted", permission: o.permission, targetType: "guardian", targetId: row.id, ip: o.ip,
    before, after: { parentId: p.id, familyId: String(familyId), familyQboId: row.familyQboId, status, reinstated: true, ...more, ...owed } }, tx);
}

export type AddGuardianResult =
  /** `quickbooks`: what became of their Parent customer in QuickBooks, in words (stage 3's slice 9h; empty where nothing is sent for this club's books or this family). */
  | { ok: true; outcome: "added" | "reinstated"; person: "new" | "existing"; name: string; guardianId: string; parentId: string; quickbooks: string[] }
  /** The address belongs to a person already: nothing was written; staff are asked whether this is them. */
  | { ok: false; reason: "same_person"; person: { id: string; name: string; families: string[] } }
  /**
   * `qbo_pending`: a change to the row's Parent customer is waiting or stuck, so a closed row isn't reopened meanwhile;
   * `being_changed`: someone holds the row's "being sent" lock at this moment (a change to it being saved or sent);
   * `raced`: another add of this address in this family got there first. Each its own cause, said in its own words.
   */
  | { ok: false; reason: "invalid_name" | "invalid_email" | "no_family" | "inactive" | "waiting" | "making" | "changing" | "other_company" | "blocked" | "already" | "busy" | "qbo_pending"
    | "being_changed" | "raced" };

/**
 * The row an add would open for this address in this family, read before the add's transaction, unlocked: the person's
 * row in the family record, or, for a linked family, their row under its customer. Its "being sent" lock is taken
 * before the save (whileGuardiansHeld()), and the add checks under its locks that it is still the row it opens.
 */
async function rowToOpen(familyId: AppFamilyId, email: string): Promise<string | null> {
  const [p] = await db.select({ id: parent.id }).from(parent).where(eq(parent.email, email));
  if (!p) return null;
  const [inFamily] = await db.select({ id: guardian.id }).from(guardian).where(and(eq(guardian.parentId, p.id), eq(guardian.familyId, familyId)));
  if (inFamily) return inFamily.id;
  const customer = await customerOfFamily(familyId);
  const [under] = customer === null ? [] : await db.select({ id: guardian.id }).from(guardian).where(and(eq(guardian.parentId, p.id), eq(guardian.familyQboId, customer)));
  return under?.id ?? null;
}

/**
 * Adds a guardian to a family: one address is one person (spec section 6: "one guardian simply belongs to both"). Under
 * the address lock, an address nobody holds makes a person with their sign-in account (`emailVerified`, the name and
 * address mirrored), audited `parent.create`. An address a person holds already changes nothing at the first press: the
 * answer is `same_person`, with the name the portal holds for them and the families they are a guardian of now, so a
 * mistyped address that lands on a real person never gives them the family unseen. Only a press that carries that
 * person's id as shown (`samePerson`), checked again under the locks, reuses them, their name unchanged; one that names
 * anyone but who holds the address now is asked again. The membership is a new `invited` guardian row in the family's
 * record, naming the family's own linked customer as `family_qbo_id` (none, for a family with no link: stage 3's slice
 * 9d) and no `source_qbo_id`, audited `parent.access.granted` with whether the person was reused and the name staff
 * typed; or, where the person's row in that family record is closed, that row reinstated (reinstateGuardian()'s rule),
 * and the answer says so; or, for a linked family, where the person's row under its customer was closed by a change of
 * company (its ids are another company's), that row taken for the new membership, as the old unique (customer, person)
 * index needs. The person's row is found by its family record (`guardian_family_id_parent_uq`), and for a linked family
 * by its customer too. A welcome is owed by oweWelcome()'s rule. Refused, changing nothing: a name or address the
 * portal can't take, a family record that isn't there or is inactive, one whose own create is waiting on the queue or
 * being sent (`making`), one whose link the portal can't tell (`other_company`: familyRefusal()), a blocked person, one with an open row in the family already, and a roster read holding its lock past the wait
 * (`busy`). Emails nobody: the welcome job sends the welcome.
 *
 * Then, in that same transaction, the row's own Parent customer (stage 3's slice 9h, queueForGuardian()'s grant): where
 * the books have a parent type and the family is linked, a row with none has its create queued, unless QuickBooks has a
 * customer of the person's name under the family already (nothing sent, nothing kept, no link guessed); and after the
 * commit it is tried at once (sendGuardianSaved()), holding the row's "being sent" lock from before the save: the row
 * the add reopens, read before and checked again under the locks (`raced` if it is another by then: another add got
 * there first), or the new row, whose id is chosen here. A closed row whose Parent customer change is waiting or stuck
 * is not reopened (`qbo_pending`), nor one whose lock someone holds (`being_changed`). A create is tried at once only
 * while its family isn't being changed in QuickBooks and no roster read holds the roster lock past ROSTER_WAIT_MS
 * (sendGuardianSaved()): otherwise it waits for the worker, said. What QuickBooks answers is said in `quickbooks`, and
 * never changes the row or its access.
 */
export async function addGuardian(familyId: AppFamilyId, input: { name: string; email: string; samePerson?: string | null }, o: StaffOp, w: Waits = {}): Promise<AddGuardianResult> {
  const name = personName(input.name);
  if (name === null) return { ok: false, reason: "invalid_name" };
  const email = guardianEmail(input.email);
  if (email === null) return { ok: false, reason: "invalid_email" };
  const existing = await rowToOpen(familyId, email);
  const lockId = existing ?? randomUUID();
  const r = await whileGuardiansHeld([lockId], async (hold) => {
    const saved = await saveGuardian(familyId, name, email, input.samePerson ?? null, lockId, existing !== null, o, w);
    if (!saved.ok) return saved;
    const sent = await sendGuardianSaved(saved.queued, o, { hold, rosterWaitMs: w.rosterWaitMs });
    return { ...saved.result, quickbooks: guardianSentWords(sent, "grant", saved.result.name) };
  });
  return r ?? { ok: false, reason: "being_changed" };
}

/** addGuardian()'s save, holding the row's "being sent" lock: `rowId` is the row it opens (`known`: one that was there before), or the new row's id. */
type SavedGuardian = { ok: true; result: Omit<Extract<AddGuardianResult, { ok: true }>, "quickbooks">; queued: GuardianQueued[] } | Exclude<AddGuardianResult, { ok: true }>;
async function saveGuardian(familyId: AppFamilyId, name: string, email: string, samePerson: string | null, rowId: string, known: boolean, o: StaffOp, w: Waits): Promise<SavedGuardian> {
  const input = { samePerson };
  return db.transaction(async (tx): Promise<SavedGuardian> => {
    await holdSettings(tx);
    await lockEmail(tx, email);
    let [p] = await tx.select().from(parent).where(eq(parent.email, email)).for("update");
    if (!(await holdRoster(tx, w))) return { ok: false, reason: "busy" };
    const fam = await familyRefusal(tx, familyId);
    if ("refusal" in fam) return { ok: false, reason: fam.refusal };
    if (p?.blocked) return { ok: false, reason: "blocked" };
    // The person's row in this family record; for a linked family, else their row under its customer (a change of
    // company closed it, or it was made before the family had a record): the old unique index holds that place.
    const [inFamily] = p ? await tx.select().from(guardian).where(and(eq(guardian.parentId, p.id), eq(guardian.familyId, familyId))).for("update") : [];
    const [underCustomer] = p && !inFamily && fam.customer !== null
      ? await tx.select().from(guardian).where(and(eq(guardian.parentId, p.id), eq(guardian.familyQboId, fam.customer))).for("update") : [];
    const held = inFamily ?? underCustomer;
    if (held && held.status !== "disabled") return { ok: false, reason: "already" };
    // The row whose "being sent" lock is held must be the one opened: another by now (an add raced this one) is `raced`.
    if (held ? held.id !== rowId : known) return { ok: false, reason: "raced" };
    // Someone holds the address: nothing is written until staff have said, seeing who it is, that this is them.
    if (p && input.samePerson !== p.id) return { ok: false, reason: "same_person", person: { id: p.id, name: p.name, families: await openFamiliesOf(tx, p.id) } };
    const person = p ? "existing" as const : "new" as const;
    const said = { person, typedName: name };
    if (!p) {
      [p] = await tx.insert(parent).values({ name, email }).returning();
      await tx.insert(parentAuthUser).values({ id: randomUUID(), name, email, emailVerified: true, parentId: p!.id });
      await writeAudit({ actor: o.actor, action: "parent.create", permission: o.permission, targetType: "parent", targetId: p!.id, ip: o.ip,
        after: { name, email, familyId: String(familyId) } }, tx);
    }
    const who = p!;
    const row = held;
    const grant = (guardianId: string) => queueForGuardian(tx, { op: "grant", guardianId, familyId, name: who.name, email: who.email }, o);
    if (row && row.disabledReason !== "company_changed") {
      if (await guardianChangeWaiting(tx, [row.id])) return { ok: false, reason: "qbo_pending" };
      await reopen(tx, row, who, familyId, o, { addedBy: "staff", ...said });
      return { ok: true, result: { ok: true, outcome: "reinstated", person, name: who.name, guardianId: row.id, parentId: who.id }, queued: await grant(row.id) };
    }
    let guardianId: string;
    const before = row ? { status: row.status, disabledReason: row.disabledReason, sourceQboId: row.sourceQboId } : null;
    if (row) {
      // Another company's row for this person under the same number: the unique index makes it the new membership.
      await tx.update(guardian).set({ familyId, status: "invited", disabledReason: null, statusBeforeDisable: null, sourceQboId: null, isPrimary: false, updatedAt: new Date() })
        .where(eq(guardian.id, row.id));
      guardianId = row.id;
    } else {
      const [made] = await tx.insert(guardian).values({ id: rowId, familyQboId: fam.customer, familyId, parentId: who.id, status: "invited", sourceQboId: null }).returning({ id: guardian.id });
      guardianId = made!.id;
    }
    const owed = await oweWelcome(tx, who);
    await writeAudit({ actor: o.actor, action: "parent.access.granted", permission: o.permission, targetType: "guardian", targetId: guardianId, ip: o.ip,
      before, after: { parentId: who.id, familyId: String(familyId), familyQboId: fam.customer, status: "invited", addedBy: "staff", ...said,
        ...(row ? { reopenedFrom: "company_changed" } : {}), ...owed } }, tx);
    return { ok: true, result: { ok: true, outcome: "added", person, name: who.name, guardianId, parentId: who.id }, queued: await grant(guardianId) };
  });
}

/**
 * The guardian row `guardianId` and its person, both FOR UPDATE, in the one order: the settings lock, the person's row,
 * the roster lock, then the guardian row (a row's person never changes, so it is read unlocked to find them). Null when
 * there is no such row; "busy" when the roster lock was held past the wait.
 */
async function lockedRow(tx: Tx, guardianId: string, w: Waits): Promise<{ row: Row; p: Person } | null | "busy"> {
  await holdSettings(tx);
  const [seen] = await tx.select({ parentId: guardian.parentId }).from(guardian).where(eq(guardian.id, guardianId));
  if (!seen) return null;
  const [p] = await tx.select().from(parent).where(eq(parent.id, seen.parentId)).for("update");
  if (!(await holdRoster(tx, w))) return "busy";
  const [row] = await tx.select().from(guardian).where(eq(guardian.id, guardianId)).for("update");
  return p && row ? { row, p } : null;
}

/** `quickbooks`: what became of their Parent customer in QuickBooks, in words (stage 3's slice 9h). */
export type RemoveGuardianResult = { ok: true; sessionsEnded: number; quickbooks: string[] } | { ok: false; reason: "invalid_note" | "not_found" | "not_open" | "busy" };

/**
 * Removes a guardian from a family: their row closes with the reason `removed` (closeMembership(), in this
 * transaction): their unused email change requests asked in that family go, and once it was the person's last open
 * row all their unused requests and codes; that family's sessions end, every session once it was the last open row;
 * the family's unfinished forms still waiting for their signature start again; and `parent.access.ended` keeps staff's
 * note. Access ends at once whatever the guardian owes, and whatever QuickBooks says, holds or can be asked (the
 * owner's decision of 2026-11-18). A row already closed is refused, and so is a roster read holding its lock past the
 * wait.
 *
 * Then, in that same transaction (stage 3's slice 9h, queueForGuardian()'s remove): the row's own creates that never
 * left given up, whoever holds the row's lock (one that may have reached QuickBooks, or is being sent, left to finish,
 * and said; should that try then reach nothing, its next try finds the row closed and gives it up unsent), and, for a row with
 * a Parent customer of its own, its make-inactive queued. After the commit, while the row's "being sent" lock is held
 * from before the save, it is tried at once (sendGuardianSaved()) by the balance rule: no balance, made inactive; any
 * balance, or one that can't be read, nothing sent and the item kept refused, the customer left active in QuickBooks.
 * When someone else holds that lock (a change to the Parent customer being sent at that moment), access still ends at
 * once: the make-inactive is queued for the worker, and nothing is tried now.
 */
export async function removeGuardian(guardianId: string, rawNote: string, o: StaffOp, w: Waits = {}): Promise<RemoveGuardianResult> {
  const note = rawNote.trim();
  if (!note || note.length > REMOVE_NOTE_MAX) return { ok: false, reason: "invalid_note" };
  const run = async (hold: Tx | null): Promise<RemoveGuardianResult> => {
    type Saved = { ok: true; sessionsEnded: number; queued: GuardianQueued[]; name: string } | Exclude<RemoveGuardianResult, { ok: true }>;
    const saved = await db.transaction(async (tx): Promise<Saved> => {
      const held = await lockedRow(tx, guardianId, w);
      if (held === "busy") return { ok: false, reason: "busy" };
      if (!held) return { ok: false, reason: "not_found" };
      if (held.row.status === "disabled") return { ok: false, reason: "not_open" };
      const { sessionsEnded } = await closeMembership(tx, held.row, { reason: "removed", actor: o.actor, note, permission: o.permission, ip: o.ip });
      const queued = await queueForGuardian(tx, { op: "remove", guardianId: held.row.id, familyId: held.row.familyId }, o);
      return { ok: true, sessionsEnded, queued, name: held.p.name };
    });
    if (!saved.ok) return saved;
    const sent = hold ? await sendGuardianSaved(saved.queued, o, { hold, rosterWaitMs: w.rosterWaitMs }) : saved.queued;
    return { ok: true, sessionsEnded: saved.sessionsEnded, quickbooks: guardianSentWords(sent, "remove", saved.name) };
  };
  return (await whileGuardiansHeld([guardianId], (hold) => run(hold))) ?? run(null);
}

export type ReinstateGuardianResult = { ok: true; quickbooks: string[] }
  | { ok: false; reason: "not_found" | "already_open" | "previous_company" | "blocked" | "no_family" | "inactive" | "waiting" | "making" | "changing" | "other_company" | "other_customer" | "busy" | "qbo_pending"
    | "being_changed" };

/**
 * Opens a closed membership again: the same row, as it was before it closed (`status_before_disable`, else invited),
 * whatever closed it (staff, or a reason the retired reconcile recorded) but a change of company, whose row names no
 * family and is offered nothing. Audited `parent.access.granted`, `reinstated`; a welcome is owed by oweWelcome()'s
 * rule. A family with no link takes it back too (stage 3's slice 9d): the row names no customer, or the family's own,
 * and one that names another customer (`other_customer`) is not this family's to reopen. Refused for a blocked person,
 * a family record that is gone or inactive, one whose own create is waiting on the queue or being sent, one whose link
 * the portal can't tell (familyRefusal()), and a roster read holding its lock past the wait.
 *
 * Its Parent customer (stage 3's slice 9h, queueForGuardian()'s grant): a row with one of its own creates none, sends
 * nothing to one QuickBooks has inactive (open question 12: said in words), and replaces a refused make-inactive of the
 * row; a row with none goes by the add's rule. A change to it waiting or stuck refuses the reinstate, changing nothing
 * (`qbo_pending`), and so does someone holding the row's lock (`being_changed`).
 */
export async function reinstateGuardian(guardianId: string, o: StaffOp, w: Waits = {}): Promise<ReinstateGuardianResult> {
  const r = await whileGuardiansHeld([guardianId], async (hold): Promise<ReinstateGuardianResult> => {
    type Saved = { ok: true; queued: GuardianQueued[]; name: string } | Exclude<ReinstateGuardianResult, { ok: true }>;
    const saved = await db.transaction(async (tx): Promise<Saved> => {
      const held = await lockedRow(tx, guardianId, w);
      if (held === "busy") return { ok: false, reason: "busy" };
      if (!held) return { ok: false, reason: "not_found" };
      const { row, p } = held;
      if (row.status !== "disabled") return { ok: false, reason: "already_open" };
      if (row.disabledReason === "company_changed") return { ok: false, reason: "previous_company" };
      if (p.blocked) return { ok: false, reason: "blocked" };
      const fam = await familyRefusal(tx, row.familyId);
      if ("refusal" in fam) return { ok: false, reason: fam.refusal };
      // The row names no customer (made while the family had no link), or the family's own; one that names another is not
      // this family's to reopen.
      if (row.familyQboId !== null && row.familyQboId !== fam.customer) return { ok: false, reason: "other_customer" };
      if (await guardianChangeWaiting(tx, [row.id])) return { ok: false, reason: "qbo_pending" };
      await reopen(tx, row, p, row.familyId!, o);
      return { ok: true, queued: await queueForGuardian(tx, { op: "grant", guardianId: row.id, familyId: row.familyId!, name: p.name, email: p.email }, o), name: p.name };
    });
    if (!saved.ok) return saved;
    return { ok: true, quickbooks: guardianSentWords(await sendGuardianSaved(saved.queued, o, { hold, rosterWaitMs: w.rosterWaitMs }), "grant", saved.name) };
  });
  return r ?? { ok: false, reason: "being_changed" };
}
