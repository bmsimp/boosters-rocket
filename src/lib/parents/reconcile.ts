import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { guardian, heldAddress, parent, parentAuthUser, parentEmailChange, qboCustomer, qboCustomerType, type DisabledReason } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getShape, missingTypes, ROSTER_LOCK, type MembershipShape } from "@/lib/roster/shape";
import { buildRoster, type Cust, type Roster } from "@/lib/roster/model";
import { decideAccess, type AccessDecision, type HoldSets } from "./access-rules";
import { getParentSettings, type ParentSettings } from "./settings";
import { deleteUnusedSigninCodes, endFamilySessions, endParentSessions } from "./sessions";

export const RECONCILE_ACTOR: Actor = { door: "system", id: null, label: "reconcile" };
/** Thrown by the roster refresh when the reconcile inside it fails, so the refresh can say which part failed. */
export class ReconcileFailed extends Error {}
export type ReconcileResult = { ran: boolean; granted: number; ended: number; emailChanged: number; welcomeOwed: number };
export type Loaded = { decision: AccessDecision; settings: ParentSettings; shape: MembershipShape; roster: Roster };

/**
 * The rules' answer for the roster as it is cached now. Null when there is nothing safe to decide from: no shape, or a
 * shape naming a type QuickBooks no longer has (which includes an empty cache). `requireActiveStudents` overrides the
 * saved setting, for the preview that shows what switching it on would do.
 */
export async function loadDecision(tx?: Tx, o: { requireActiveStudents?: boolean } = {}): Promise<Loaded | null> {
  const q = tx ?? db;
  const shape = await getShape(tx);
  if (!shape) return null;
  const types = (await q.select().from(qboCustomerType)).map((t) => ({ qboId: t.qboId, name: t.name, active: t.active }));
  if (missingTypes(shape, types).length) return null;
  const settings = await getParentSettings(tx);
  const customers: Cust[] = (await q.select().from(qboCustomer)).map((c) =>
    ({ qboId: c.qboId, displayName: c.displayName, active: c.active, parentQboId: c.parentQboId, typeQboId: c.typeQboId, email: c.email, phone: c.phone }));
  const holds = new Map<string, HoldSets>((await q.select().from(heldAddress)).map((h) => [h.email, { approved: h.approvedFamilyQboIds, rejected: h.rejectedFamilyQboIds }]));
  const roster = buildRoster(shape, customers);
  const requireActiveStudents = (o.requireActiveStudents ?? settings.requireActiveStudents) && shape.kind === "layered" && shape.studentTypeId !== null;
  return { decision: decideAccess({ roster, shape, holds, requireActiveStudents }), settings, shape, roster };
}

/**
 * Brings the stored people and family links in line with the rules (spec §2), applying only the differences. The
 * caller holds ROSTER_LOCK and owns the transaction; nothing here sends mail. While parent sign-ins are off it changes
 * nothing. A link follows its QuickBooks customer (`sourceQboId`): when that customer's address changes, the person's
 * address is changed in place if nobody else has the new one and they have no other link (which signs them out);
 * otherwise the link moves.
 */
export async function reconcileAccess(tx: Tx, o: { cause: string }): Promise<ReconcileResult> {
  const r: ReconcileResult = { ran: false, granted: 0, ended: 0, emailChanged: 0, welcomeOwed: 0 };
  const loaded = await loadDecision(tx);
  if (!loaded || !loaded.settings.signin) return r;
  r.ran = true;
  const { decision, settings } = loaded;
  const audit = (action: string, targetType: string, targetId: string, before: unknown, after: Record<string, unknown>) =>
    writeAudit({ actor: RECONCILE_ACTOR, action, targetType, targetId, before, after: { ...after, cause: o.cause } }, tx);

  for (const h of decision.held) {
    const made = await tx.insert(heldAddress).values({ email: h.email }).onConflictDoNothing().returning({ email: heldAddress.email });
    if (made.length) await audit("parent.hold.opened", "held_address", h.email, null, {});
  }

  // Lock everything this step may change, in a fixed order.
  const links = await tx.select().from(guardian).orderBy(guardian.id).for("update");
  const people = new Map((await tx.select().from(parent).orderBy(parent.id).for("update")).map((p) => [p.id, p]));
  const byEmail = new Map([...people.values()].map((p) => [p.email, p]));
  type Link = (typeof links)[number];
  type Person = NonNullable<ReturnType<typeof people.get>>;
  const ownerOf = (l: Link) => people.get(l.parentId)!;
  const kept = new Set<string>();
  // Decided from the run's start, never from changes made during it, so one change can't make room for the next
  // (a chain E to X, F to E would otherwise move F's record onto E's address).
  const heldAtStart = new Set(byEmail.keys());
  const grantEmails = new Set(decision.grants.map((g) => g.email));
  const handMade = new Set(links.filter((l) => l.sourceQboId === null).map((l) => l.id));
  // A link closed by a company change holds another company's IDs: it is never matched as the same link. Only the
  // unique (family, person) index can make its row be reused, and then as a new link.
  const foreign = new Set(links.filter((l) => l.status === "disabled" && l.disabledReason === "company_changed").map((l) => l.id));
  const ours = (l: Link) => !foreign.has(l.id);

  const close = async (l: Link, reason: DisabledReason, dropSource = false) => {
    const was = l.status === "disabled" ? l.statusBeforeDisable : l.status;
    const set = { status: "disabled" as const, disabledReason: reason, statusBeforeDisable: was, ...(dropSource ? { sourceQboId: null } : {}) };
    await tx.update(guardian).set({ ...set, updatedAt: new Date() }).where(eq(guardian.id, l.id));
    Object.assign(l, set);
    let sessionsEnded = await endFamilySessions(l.parentId, l.familyQboId, tx);
    if (!links.some((x) => x.parentId === l.parentId && x.status !== "disabled")) sessionsEnded += await endParentSessions(l.parentId, tx);
    await audit("parent.access.ended", "guardian", l.id, { status: was }, { parentId: l.parentId, familyQboId: l.familyQboId, reason, sessionsEnded });
    r.ended++;
  };
  /** Marks the person as owed a welcome when that is due; the caller records it on the grant's audit row. */
  const owe = async (p: Person): Promise<{ welcomeOwed?: true }> => {
    if (!settings.welcome || p.welcomedAt || p.welcomeOwed) return {};
    await tx.update(parent).set({ welcomeOwed: true, updatedAt: new Date() }).where(eq(parent.id, p.id));
    p.welcomeOwed = true; r.welcomeOwed++;
    return { welcomeOwed: true };
  };
  const createPerson = async (email: string, name: string): Promise<Person> => {
    const [p] = await tx.insert(parent).values({ name, email }).returning();
    await tx.insert(parentAuthUser).values({ id: randomUUID(), name, email, emailVerified: true, parentId: p!.id });
    people.set(p!.id, p!); byEmail.set(email, p!);
    return p!;
  };

  for (const g of decision.grants) {
    const name = decision.personNames.get(g.email) ?? g.name;
    const fromSource = links.filter((l) => ours(l) && l.familyQboId === g.familyQboId && l.sourceQboId === g.sourceQboId);
    // The link for this grant: from this customer and owned by this address; or one made by hand for this family and address.
    let link: Link | undefined = fromSource.find((l) => ownerOf(l).email === g.email)
      ?? links.find((l) => ours(l) && handMade.has(l.id) && l.familyQboId === g.familyQboId && l.sourceQboId === null && ownerOf(l).email === g.email);
    let person = byEmail.get(g.email);

    if (!link) {
      // The customer's address changed: a link from it whose owner's address no grant from it claims any more.
      const stale = fromSource.find((l) => !kept.has(l.id)
        && !decision.grants.some((x) => x.familyQboId === g.familyQboId && x.sourceQboId === g.sourceQboId && x.email === ownerOf(l).email));
      if (stale) {
        const owner = ownerOf(stale);
        // In place only when nobody had the new address at the start, nobody keeps the old address under this decision,
        // and the person has no other link of ours.
        const inPlace = !person && !heldAtStart.has(g.email) && !grantEmails.has(owner.email)
          && !links.some((l) => ours(l) && l.id !== stale.id && l.parentId === owner.id);
        if (inPlace) {
          const old = owner.email;
          await tx.update(parent).set({ email: g.email, updatedAt: new Date() }).where(eq(parent.id, owner.id));
          await tx.update(parentAuthUser).set({ email: g.email, updatedAt: new Date() }).where(eq(parentAuthUser.parentId, owner.id));
          await deleteUnusedSigninCodes(owner.id, tx);        // a code sent to the old address must not work
          await tx.delete(parentEmailChange).where(and(eq(parentEmailChange.parentId, owner.id), isNull(parentEmailChange.usedAt)));
          // A session was proved with the old address; as with a staff email change, the person signs in again.
          const sessionsEnded = await endParentSessions(owner.id, tx);
          byEmail.delete(old); owner.email = g.email; byEmail.set(g.email, owner);
          await audit("parent.email.changed", "parent", owner.id, { email: old }, { email: g.email, sourceQboId: g.sourceQboId, sessionsEnded });
          r.emailChanged++; link = stale; person = owner;
        } else {
          await close(stale, "address_changed", true);        // the source is dropped so the new link can carry it
        }
      }
    }
    if (!link) {
      person ??= await createPerson(g.email, name);
      link = links.find((l) => l.familyQboId === g.familyQboId && l.parentId === person!.id);
      if (link && foreign.has(link.id)) {
        // Another company's row for this person and family: the unique index forces its reuse, as a new link.
        const before = { status: link.status, disabledReason: link.disabledReason, sourceQboId: link.sourceQboId };
        const set = { status: "invited" as const, disabledReason: null, statusBeforeDisable: null, sourceQboId: g.sourceQboId };
        await tx.update(guardian).set({ ...set, updatedAt: new Date() }).where(eq(guardian.id, link.id));
        Object.assign(link, set); foreign.delete(link.id);
        const owed = await owe(person);
        await audit("parent.access.granted", "guardian", link.id, before,
          { parentId: person.id, familyQboId: g.familyQboId, sourceQboId: g.sourceQboId, status: "invited", reopenedFrom: "company_changed", ...owed });
        r.granted++;
      } else if (!link) {
        const [row] = await tx.insert(guardian).values({ familyQboId: g.familyQboId, parentId: person.id, sourceQboId: g.sourceQboId, status: "invited" }).returning();
        links.push(row!); link = row!;
        const owed = await owe(person);
        await audit("parent.access.granted", "guardian", link.id, null, { parentId: person.id, familyQboId: g.familyQboId, sourceQboId: g.sourceQboId, status: "invited", ...owed });
        r.granted++;
      }
    }
    person = ownerOf(link);
    if (link.status === "disabled") {
      // Reopened as it was before it closed; a change of source, if any, is on the same audit row.
      const status = link.statusBeforeDisable ?? "invited";
      const before = { status: "disabled", disabledReason: link.disabledReason, sourceQboId: link.sourceQboId };
      const set = { status, disabledReason: null, statusBeforeDisable: null, sourceQboId: g.sourceQboId };
      await tx.update(guardian).set({ ...set, updatedAt: new Date() }).where(eq(guardian.id, link.id));
      Object.assign(link, set);
      const owed = await owe(person);
      await audit("parent.access.granted", "guardian", link.id, before, { parentId: person.id, familyQboId: g.familyQboId, sourceQboId: g.sourceQboId, status, ...owed });
      r.granted++;
    } else if (link.sourceQboId !== g.sourceQboId) {
      // Taking over a hand-made link, or re-pointing a link to the record that now carries this address.
      const was = link.sourceQboId;
      await tx.update(guardian).set({ sourceQboId: g.sourceQboId, updatedAt: new Date() }).where(eq(guardian.id, link.id));
      link.sourceQboId = g.sourceQboId;
      await audit("parent.access.moved", "guardian", link.id, { sourceQboId: was }, { sourceQboId: g.sourceQboId, parentId: person.id, familyQboId: g.familyQboId });
    }
    if (person.name !== name) {
      await tx.update(parent).set({ name, updatedAt: new Date() }).where(eq(parent.id, person.id));
      await tx.update(parentAuthUser).set({ name, updatedAt: new Date() }).where(eq(parentAuthUser.parentId, person.id));
      await audit("parent.name.changed", "parent", person.id, { name: person.name }, { name });
      person.name = name;
    }
    kept.add(link.id);
  }

  // Why a link closes: the denial for its own record and address (for a hand-made link, any denial for its address in
  // that family); else a denial of the whole record, one that names no address; else it is not in QuickBooks.
  const exact = new Map<string, DisabledReason>(), byFamilyEmail = new Map<string, DisabledReason>(), wholeRecord = new Map<string, DisabledReason>();
  const first = (m: Map<string, DisabledReason>, k: string, v: DisabledReason) => { if (!m.has(k)) m.set(k, v); };
  for (const d of decision.denials) {
    if (d.email) { first(exact, `${d.familyQboId}|${d.sourceQboId}|${d.email}`, d.reason); first(byFamilyEmail, `${d.familyQboId}|${d.email}`, d.reason); }
    else first(wholeRecord, `${d.familyQboId}|${d.sourceQboId}`, d.reason);
  }
  const whyNot = (l: Link): DisabledReason => {
    const email = ownerOf(l).email;
    return (l.sourceQboId === null ? byFamilyEmail.get(`${l.familyQboId}|${email}`) : exact.get(`${l.familyQboId}|${l.sourceQboId}|${email}`))
      ?? wholeRecord.get(`${l.familyQboId}|${l.sourceQboId}`) ?? "not_in_quickbooks";
  };
  for (const l of links) {
    if (l.status !== "disabled" && !kept.has(l.id)) await close(l, whyNot(l));
  }
  return r;
}

/** The reconcile on its own, for a staff decision or a switch: takes the roster lock, so it waits for a running refresh. */
export async function runReconcile(o: { cause: string }): Promise<ReconcileResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
    return reconcileAccess(tx, o);
  });
}
