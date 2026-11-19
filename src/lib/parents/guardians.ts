// Staff add, remove and reinstate a family's guardians, in the app only (stage 3's slice 7b of the app-owned families
// spec, section 6: "Staff add a guardian to a family with a name and email"). Nothing is sent to QuickBooks: a
// guardian's Parent customer, or their address in a family's email field, arrives with the source move (S9). Staff
// only: called from src/app/staff/(app)/parents/actions.ts behind `Roster.Family.ReadWrite` (the lead's choice: giving
// an address a family's sign-in goes with the permission that changes a family); never from parent code, which may not
// import it (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts): it gives any address access to any family.
//
// Every write here holds what keeps a family record and its link still under it: the roster lock, shared, taken before
// the family is looked at and before any guardian row is, so no roster read (which brings the app's records into step)
// and no change of company runs between the check and the write. The locks come in the one order ./sessions.ts gives
// (lockedPerson()): the parents' settings lock, shared, first (a switch takes it before the people it touches, so a
// welcome switched on or off meanwhile is seen as it ends); then the person's own: for an add, the address lock and the
// `parent` row that holds the address; for a remove or a reinstate, the `parent` row alone (their address isn't
// changed or claimed); then the roster lock, as a parent's email confirm takes it after the same person's locks (were
// the roster lock held while waiting for the person, that confirm, holding the person and asking for the roster, would
// close a cycle Postgres ends by aborting one of the two); then the guardian row, and what hangs on the person (their
// requests, codes and sessions) last. The roster lock is waited for at most three seconds, as the email confirm waits
// for it (a roster read holds it through its whole QuickBooks read, and the person's row held meanwhile would hold up
// that person's code request and the daily clean-up): when it is busy, nothing has been written and the answer is
// `busy`. A guardian row keeps `family_qbo_id` the family's own linked customer, since keepAppRecordsInStep()
// (src/lib/families/in-step.ts) still puts a row in the family that column names: a row written so is in step already,
// and the next run changes nothing.
import { randomUUID } from "node:crypto";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { family, guardian, parent, parentAuthUser } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { normalizeEmail } from "@/lib/email";
import { customerOfFamily } from "@/lib/families/links";
import type { AppFamilyId } from "@/lib/families/ids";
import { recordNameWords } from "@/lib/families/words";
import { ROSTER_LOCK } from "@/lib/roster/shape";
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
async function holdRoster(tx: Tx, w: Waits): Promise<boolean> {
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

/** Why a family can't take a guardian now, or null when it can: its record, active, and its own family link. */
async function familyRefusal(tx: Tx, familyId: AppFamilyId | null): Promise<{ refusal: "no_family" | "inactive" | "no_link" } | { customer: string }> {
  if (familyId === null) return { refusal: "no_family" };
  const [f] = await tx.select({ active: family.active }).from(family).where(eq(family.id, familyId));
  if (!f) return { refusal: "no_family" };
  if (!f.active) return { refusal: "inactive" };
  // Until the source move lets a membership stand without one, a guardian row names the family's customer.
  const customer = await customerOfFamily(familyId, tx);
  return customer === null ? { refusal: "no_link" } : { customer };
}

/** The names of the families a person is an open guardian of now, by name: what staff are shown before an add reuses them. */
async function openFamiliesOf(tx: Tx, parentId: string): Promise<string[]> {
  const rows = await tx.select({ name: family.name }).from(guardian).innerJoin(family, eq(family.id, guardian.familyId))
    .where(and(eq(guardian.parentId, parentId), ne(guardian.status, "disabled"))).orderBy(asc(family.name), asc(family.id));
  return rows.map((r) => recordNameWords(r.name, "family"));
}

/**
 * Opens a closed row again as it was before it closed (`status_before_disable`, else invited), in the family it names,
 * and records it (`parent.access.granted`, `reinstated`, with `more`: what an add adds). The caller holds the person's
 * row and this row FOR UPDATE.
 */
async function reopen(tx: Tx, row: Row, p: Person, familyId: AppFamilyId, customer: string, o: StaffOp, more: Record<string, unknown> = {}): Promise<void> {
  const status = row.statusBeforeDisable ?? "invited";
  const before = { status: row.status, disabledReason: row.disabledReason };
  await tx.update(guardian).set({ status, disabledReason: null, statusBeforeDisable: null, updatedAt: new Date() }).where(eq(guardian.id, row.id));
  const owed = await oweWelcome(tx, p);
  await writeAudit({ actor: o.actor, action: "parent.access.granted", permission: o.permission, targetType: "guardian", targetId: row.id, ip: o.ip,
    before, after: { parentId: p.id, familyId: String(familyId), familyQboId: customer, status, reinstated: true, ...more, ...owed } }, tx);
}

export type AddGuardianResult =
  | { ok: true; outcome: "added" | "reinstated"; person: "new" | "existing"; name: string; guardianId: string; parentId: string }
  /** The address belongs to a person already: nothing was written; staff are asked whether this is them. */
  | { ok: false; reason: "same_person"; person: { id: string; name: string; families: string[] } }
  | { ok: false; reason: "invalid_name" | "invalid_email" | "no_family" | "inactive" | "no_link" | "blocked" | "already" | "busy" };

/**
 * Adds a guardian to a family: one address is one person (spec section 6: "one guardian simply belongs to both"). Under
 * the address lock, an address nobody holds makes a person with their sign-in account (`emailVerified`, the name and
 * address mirrored), audited `parent.create`. An address a person holds already changes nothing at the first press: the
 * answer is `same_person`, with the name the portal holds for them and the families they are a guardian of now, so a
 * mistyped address that lands on a real person never gives them the family unseen. Only a press that carries that
 * person's id as shown (`samePerson`), checked again under the locks, reuses them, their name unchanged; one that names
 * anyone but who holds the address now is asked again. The membership is a new `invited` guardian row in the family's
 * record, naming the family's own linked customer as `family_qbo_id` and no `source_qbo_id`, audited
 * `parent.access.granted` with whether the person was reused and the name staff typed; or, where the person's row in
 * that family is closed, that row reinstated (reinstateGuardian()'s rule), and the answer says so; or, where it was
 * closed by a change of company (its ids are another company's), that row taken for the new membership, as the unique
 * (family, person) index needs. A welcome is owed by oweWelcome()'s rule. Refused, changing nothing: a name or address
 * the portal can't take, a family record that isn't there or is inactive, a family with no link, a blocked person, one
 * with an open row in the family already, and a roster read holding its lock past the wait (`busy`). Emails nobody:
 * the welcome job sends the welcome.
 */
export async function addGuardian(familyId: AppFamilyId, input: { name: string; email: string; samePerson?: string | null }, o: StaffOp, w: Waits = {}): Promise<AddGuardianResult> {
  const name = personName(input.name);
  if (name === null) return { ok: false, reason: "invalid_name" };
  const email = guardianEmail(input.email);
  if (email === null) return { ok: false, reason: "invalid_email" };
  return db.transaction(async (tx): Promise<AddGuardianResult> => {
    await holdSettings(tx);
    await lockEmail(tx, email);
    let [p] = await tx.select().from(parent).where(eq(parent.email, email)).for("update");
    if (!(await holdRoster(tx, w))) return { ok: false, reason: "busy" };
    const fam = await familyRefusal(tx, familyId);
    if ("refusal" in fam) return { ok: false, reason: fam.refusal };
    if (p?.blocked) return { ok: false, reason: "blocked" };
    const [held] = p ? await tx.select().from(guardian).where(and(eq(guardian.parentId, p.id), eq(guardian.familyQboId, fam.customer))).for("update") : [];
    if (held && held.status !== "disabled") return { ok: false, reason: "already" };
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
    if (row && row.disabledReason !== "company_changed") {
      await reopen(tx, row, who, familyId, fam.customer, o, { addedBy: "staff", ...said });
      return { ok: true, outcome: "reinstated", person, name: who.name, guardianId: row.id, parentId: who.id };
    }
    let guardianId: string;
    const before = row ? { status: row.status, disabledReason: row.disabledReason, sourceQboId: row.sourceQboId } : null;
    if (row) {
      // Another company's row for this person under the same number: the unique index makes it the new membership.
      await tx.update(guardian).set({ familyId, status: "invited", disabledReason: null, statusBeforeDisable: null, sourceQboId: null, isPrimary: false, updatedAt: new Date() })
        .where(eq(guardian.id, row.id));
      guardianId = row.id;
    } else {
      const [made] = await tx.insert(guardian).values({ familyQboId: fam.customer, familyId, parentId: who.id, status: "invited", sourceQboId: null }).returning({ id: guardian.id });
      guardianId = made!.id;
    }
    const owed = await oweWelcome(tx, who);
    await writeAudit({ actor: o.actor, action: "parent.access.granted", permission: o.permission, targetType: "guardian", targetId: guardianId, ip: o.ip,
      before, after: { parentId: who.id, familyId: String(familyId), familyQboId: fam.customer, status: "invited", addedBy: "staff", ...said,
        ...(row ? { reopenedFrom: "company_changed" } : {}), ...owed } }, tx);
    return { ok: true, outcome: "added", person, name: who.name, guardianId, parentId: who.id };
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

export type RemoveGuardianResult = { ok: true; sessionsEnded: number } | { ok: false; reason: "invalid_note" | "not_found" | "not_open" | "busy" };

/**
 * Removes a guardian from a family: their row closes with the reason `removed` (closeMembership(), in this
 * transaction): their unused email change requests asked in that family go, and once it was the person's last open
 * row all their unused requests and codes; that family's sessions end, every session once it was the last open row;
 * the family's unfinished forms still waiting for their signature start again; and `parent.access.ended` keeps staff's
 * note. Access ends at once whatever the guardian owes (the owner's decision of 2026-11-18); their Parent record in
 * QuickBooks is made inactive, under the balance rule, only once the source move sends it (S9). A row already closed
 * is refused, and so is a roster read holding its lock past the wait.
 */
export async function removeGuardian(guardianId: string, rawNote: string, o: StaffOp, w: Waits = {}): Promise<RemoveGuardianResult> {
  const note = rawNote.trim();
  if (!note || note.length > REMOVE_NOTE_MAX) return { ok: false, reason: "invalid_note" };
  return db.transaction(async (tx): Promise<RemoveGuardianResult> => {
    const held = await lockedRow(tx, guardianId, w);
    if (held === "busy") return { ok: false, reason: "busy" };
    if (!held) return { ok: false, reason: "not_found" };
    if (held.row.status === "disabled") return { ok: false, reason: "not_open" };
    const { sessionsEnded } = await closeMembership(tx, held.row, { reason: "removed", actor: o.actor, note, permission: o.permission, ip: o.ip });
    return { ok: true, sessionsEnded };
  });
}

export type ReinstateGuardianResult = { ok: true } | { ok: false; reason: "not_found" | "already_open" | "previous_company" | "blocked" | "no_family" | "inactive" | "no_link" | "busy" };

/**
 * Opens a closed membership again: the same row, as it was before it closed (`status_before_disable`, else invited),
 * whatever closed it (staff, or a reason the retired reconcile recorded) but a change of company, whose row names no
 * family and is offered nothing. Audited `parent.access.granted`, `reinstated`; a welcome is owed by oweWelcome()'s
 * rule. Refused for a blocked person, a family record that is gone or inactive, a family with no link, and a roster
 * read holding its lock past the wait.
 */
export async function reinstateGuardian(guardianId: string, o: StaffOp, w: Waits = {}): Promise<ReinstateGuardianResult> {
  return db.transaction(async (tx): Promise<ReinstateGuardianResult> => {
    const held = await lockedRow(tx, guardianId, w);
    if (held === "busy") return { ok: false, reason: "busy" };
    if (!held) return { ok: false, reason: "not_found" };
    const { row, p } = held;
    if (row.status !== "disabled") return { ok: false, reason: "already_open" };
    if (row.disabledReason === "company_changed") return { ok: false, reason: "previous_company" };
    if (p.blocked) return { ok: false, reason: "blocked" };
    const fam = await familyRefusal(tx, row.familyId);
    if ("refusal" in fam) return { ok: false, reason: fam.refusal };
    // In step, the row names its family's own customer; one that names another is not this family's to reopen.
    if (fam.customer !== row.familyQboId) return { ok: false, reason: "no_link" };
    await reopen(tx, row, p, row.familyId!, fam.customer, o);
    return { ok: true };
  });
}
