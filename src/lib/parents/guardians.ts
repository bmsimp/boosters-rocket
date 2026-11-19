// Staff add, remove and reinstate a family's guardians, in the app only (stage 3's slice 7b of the app-owned families
// spec, section 6: "Staff add a guardian to a family with a name and email"). Nothing is sent to QuickBooks: a
// guardian's Parent customer, or their address in a family's email field, arrives with the source move (S9). Staff
// only: called from src/app/staff/(app)/parents/actions.ts behind `Parents.ReadWrite`; never from parent code.
//
// Every write here holds what keeps a family record and its link still under it: the roster lock, shared, taken before
// the family is looked at and before any guardian row is, so no roster read (which brings the app's records into step)
// and no change of company runs between the check and the write. The locks come in the one order ./sessions.ts gives
// (lockedPerson()): the parents' settings lock, shared, first (a switch takes it before the people it touches, so a
// welcome switched on or off meanwhile is seen as it ends); then the person's own, the address lock and the `parent`
// row; then the roster lock, as a parent's email confirm takes it after the same person's locks (were the roster lock
// held while waiting for the person, that confirm, holding the person and asking for the roster, would close a cycle
// Postgres ends by aborting one of the two); then the guardian row, and what hangs on the person (their sessions)
// last. A roster read never waits for a person's row, so holding one while waiting for the roster is safe against it.
// A guardian row keeps `family_qbo_id` the
// family's own linked customer, since keepAppRecordsInStep() (src/lib/families/in-step.ts) still puts a row in the
// family that column names: a row written so is in step already, and the next run changes nothing.
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { family, guardian, parent, parentAuthUser } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { normalizeEmail } from "@/lib/email";
import { customerOfFamily } from "@/lib/families/links";
import type { AppFamilyId } from "@/lib/families/ids";
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

/** A person's name as staff typed it, trimmed, with its spaces closed up: 1 to 100 characters, none a control character. */
export function personName(raw: string): string | null {
  const name = raw.replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= PERSON_NAME_MAX && !/\p{Cc}/u.test(name) ? name : null;
}

/** The address staff typed, by the portal's own rule (normalizeEmail(): trimmed, lower-cased, a valid address). */
export const guardianEmail = (raw: string): string | null => (raw.length <= EMAIL_MAX ? normalizeEmail(raw) : null);

/** The parents' settings lock, shared: the first lock of every write here, before the person's. */
const holdSettings = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${PARENTS_KEY}))`);
/** The roster lock, shared: after the person's locks, before the family is looked at or a guardian row taken. */
const holdRoster = (tx: Tx) => tx.execute(sql`select pg_advisory_xact_lock_shared(${ROSTER_LOCK})`);

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

/**
 * Opens a closed row again as it was before it closed (`status_before_disable`, else invited), in the family it names,
 * and records it (`parent.access.granted`, `reinstated`). The caller holds the person's row and this row FOR UPDATE.
 */
async function reopen(tx: Tx, row: Row, p: Person, familyId: AppFamilyId, customer: string, o: StaffOp): Promise<void> {
  const status = row.statusBeforeDisable ?? "invited";
  const before = { status: row.status, disabledReason: row.disabledReason };
  await tx.update(guardian).set({ status, disabledReason: null, statusBeforeDisable: null, updatedAt: new Date() }).where(eq(guardian.id, row.id));
  const owed = await oweWelcome(tx, p);
  await writeAudit({ actor: o.actor, action: "parent.access.granted", permission: o.permission, targetType: "guardian", targetId: row.id, ip: o.ip,
    before, after: { parentId: p.id, familyId: String(familyId), familyQboId: customer, status, reinstated: true, ...owed } }, tx);
}

export type AddGuardianResult =
  | { ok: true; outcome: "added" | "reinstated"; person: "new" | "existing"; name: string; guardianId: string; parentId: string }
  | { ok: false; reason: "invalid_name" | "invalid_email" | "no_family" | "inactive" | "no_link" | "blocked" | "already" };

/**
 * Adds a guardian to a family: one address is one person (spec section 6: "one guardian simply belongs to both"). Under
 * the address lock a person who holds the address already is reused, their name unchanged; otherwise a person is made
 * with their sign-in account (`emailVerified`, the name and address mirrored), audited `parent.create`. The membership
 * is a new `invited` guardian row in the family's record, naming the family's own linked customer as `family_qbo_id`
 * and no `source_qbo_id`, audited `parent.access.granted`; or, where the person's row in that family is closed, that row
 * reinstated (reinstateGuardian()'s rule), and the answer says so; or, where it was closed by a change of company (its
 * ids are another company's), that row taken for the new membership, as the unique (family, person) index needs. A
 * welcome is owed by oweWelcome()'s rule. Refused, changing nothing: a name or address the portal can't take, a
 * family record that isn't there or is inactive, a family with no link, a blocked person, and one with an open row in
 * the family already. Emails nobody: the welcome job sends the welcome.
 */
export async function addGuardian(familyId: AppFamilyId, input: { name: string; email: string }, o: StaffOp): Promise<AddGuardianResult> {
  const name = personName(input.name);
  if (name === null) return { ok: false, reason: "invalid_name" };
  const email = guardianEmail(input.email);
  if (email === null) return { ok: false, reason: "invalid_email" };
  return db.transaction(async (tx): Promise<AddGuardianResult> => {
    await holdSettings(tx);
    await lockEmail(tx, email);
    let [p] = await tx.select().from(parent).where(eq(parent.email, email)).for("update");
    await holdRoster(tx);
    const fam = await familyRefusal(tx, familyId);
    if ("refusal" in fam) return { ok: false, reason: fam.refusal };
    if (p?.blocked) return { ok: false, reason: "blocked" };
    const person = p ? "existing" as const : "new" as const;
    if (!p) {
      [p] = await tx.insert(parent).values({ name, email }).returning();
      await tx.insert(parentAuthUser).values({ id: randomUUID(), name, email, emailVerified: true, parentId: p!.id });
      await writeAudit({ actor: o.actor, action: "parent.create", permission: o.permission, targetType: "parent", targetId: p!.id, ip: o.ip,
        after: { name, email, familyId: String(familyId) } }, tx);
    }
    const who = p!;
    const [row] = await tx.select().from(guardian).where(and(eq(guardian.parentId, who.id), eq(guardian.familyQboId, fam.customer))).for("update");
    if (row && row.status !== "disabled") return { ok: false, reason: "already" };
    if (row && row.disabledReason !== "company_changed") {
      await reopen(tx, row, who, familyId, fam.customer, o);
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
      before, after: { parentId: who.id, familyId: String(familyId), familyQboId: fam.customer, status: "invited", addedBy: "staff",
        ...(row ? { reopenedFrom: "company_changed" } : {}), ...owed } }, tx);
    return { ok: true, outcome: "added", person, name: who.name, guardianId, parentId: who.id };
  });
}

/**
 * The guardian row `guardianId` and its person, both FOR UPDATE, in the one order: the settings lock, the person's row,
 * the roster lock, then the guardian row (a row's person never changes, so it is read unlocked to find them). Null when
 * there is no such row.
 */
async function lockedRow(tx: Tx, guardianId: string): Promise<{ row: Row; p: Person } | null> {
  await holdSettings(tx);
  const [seen] = await tx.select({ parentId: guardian.parentId }).from(guardian).where(eq(guardian.id, guardianId));
  if (!seen) return null;
  const [p] = await tx.select().from(parent).where(eq(parent.id, seen.parentId)).for("update");
  await holdRoster(tx);
  const [row] = await tx.select().from(guardian).where(eq(guardian.id, guardianId)).for("update");
  return p && row ? { row, p } : null;
}

export type RemoveGuardianResult = { ok: true; sessionsEnded: number } | { ok: false; reason: "invalid_note" | "not_found" | "not_open" };

/**
 * Removes a guardian from a family: their row closes with the reason `removed` (closeMembership(), in this
 * transaction): that family's sessions end, every session once it was the person's last open row, the family's
 * unfinished forms still waiting for their signature start again, and `parent.access.ended` keeps staff's note. Access
 * ends at once whatever the guardian owes (the owner's decision of 2026-11-18); their Parent record in QuickBooks is made
 * inactive, under the balance rule, only once the source move sends it (S9). A row already closed is refused.
 */
export async function removeGuardian(guardianId: string, rawNote: string, o: StaffOp): Promise<RemoveGuardianResult> {
  const note = rawNote.trim();
  if (!note || note.length > REMOVE_NOTE_MAX) return { ok: false, reason: "invalid_note" };
  return db.transaction(async (tx): Promise<RemoveGuardianResult> => {
    const held = await lockedRow(tx, guardianId);
    if (!held) return { ok: false, reason: "not_found" };
    if (held.row.status === "disabled") return { ok: false, reason: "not_open" };
    const { sessionsEnded } = await closeMembership(tx, held.row, { reason: "removed", actor: o.actor, note, permission: o.permission, ip: o.ip });
    return { ok: true, sessionsEnded };
  });
}

export type ReinstateGuardianResult = { ok: true } | { ok: false; reason: "not_found" | "already_open" | "previous_company" | "blocked" | "no_family" | "inactive" | "no_link" };

/**
 * Opens a closed membership again: the same row, as it was before it closed (`status_before_disable`, else invited),
 * whatever closed it (staff, or a reason the retired reconcile recorded) but a change of company, whose row names no
 * family and is offered nothing. Audited `parent.access.granted`, `reinstated`; a welcome is owed by oweWelcome()'s
 * rule. Refused for a blocked person, a family record that is gone or inactive, and a family with no link.
 */
export async function reinstateGuardian(guardianId: string, o: StaffOp): Promise<ReinstateGuardianResult> {
  return db.transaction(async (tx): Promise<ReinstateGuardianResult> => {
    const held = await lockedRow(tx, guardianId);
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
