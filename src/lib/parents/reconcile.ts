import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { guardian, heldAddress, parent, parentAuthUser, parentEmailChange, qboCustomer, qboCustomerType, type DisabledReason } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { getShape, missingTypes, type MembershipShape } from "@/lib/roster/shape";
import { buildRoster, type Cust, type Roster } from "@/lib/roster/model";
import { decideAccess, type AccessDecision, type HoldSets } from "./access-rules";
import { getParentSettings, type ParentSettings } from "./settings";
import { deleteUnusedSigninCodes, endFamilySessions, endParentSessions } from "./sessions";
import { formsForGoneSigner } from "@/lib/forms/signer-gone";
import { keepAppRecordsInStep } from "@/lib/families/in-step";
import type { AppRecordChanges } from "@/lib/families/changes";

export const RECONCILE_ACTOR: Actor = { door: "system", id: null, label: "reconcile" };
/** Thrown by the roster refresh when the reconcile inside it fails, so the refresh can say which part failed. */
export class ReconcileFailed extends Error {}

/**
 * The server log line for a reconcile that failed inside a refresh, or the app records' step after it (`part`): the
 * error's class name and, for a database error, its SQLSTATE and the constraint it broke. Never the message, the query
 * or its parameters: any of them can hold an address. Drizzle wraps a driver error, so the code and constraint are looked for on its cause too. It lives here, not
 * in the roster code, which logs nothing at all (QuickBooks spec §7).
 */
export function logReconcileFailure(e: unknown, part: "reconcile" | "app records" = "reconcile"): void {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const err = (typeof e === "object" && e !== null ? e : {}) as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
  const pg = (err.code === undefined && typeof err.cause === "object" && err.cause !== null ? err.cause : err) as typeof err;
  const name = typeof e === "object" && e !== null ? e.constructor?.name ?? "Object" : typeof e;
  console.error(`[roster] ${part} failed`, { name, code: str(pg.code), constraint: str(pg.constraint_name) ?? str(pg.constraint) });
}
/**
 * What a reconcile did: to sign-ins (`ran` says whether it could look at them), and to the app's own records, which the
 * caller puts on its own audit row when they changed (appRecordsAudit(), src/lib/families/in-step.ts).
 */
export type ReconcileResult = { ran: boolean; granted: number; ended: number; emailChanged: number; welcomeOwed: number; appRecords: AppRecordChanges };
type SigninsResult = Omit<ReconcileResult, "appRecords">;
/** Collects the links a run closes (owner as before the run), for the clean-up preview's dry run. */
export type EndedReport = { ended: { name: string; email: string; familyQboId: string }[] };
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
 * Brings the stored people and family links in line with the rules (spec §2), applying only the differences, then the
 * app's own records and links in line with the cache and those links (keepAppRecordsInStep(), src/lib/families/in-step.ts),
 * whether or not sign-ins are on, and returns what that changed too. Every roster read, staff roster write, read-again
 * and confirmed change of a parent's sign-in email calls this after it changes the cache, so this one call keeps both
 * in step; each caller writes what changed in the records on its own audit row. The caller holds ROSTER_LOCK and owns the
 * transaction; nothing here sends mail. While parent sign-ins are off it changes no sign-in. A link follows its
 * QuickBooks customer (`sourceQboId`): when that customer's address changes, the person's address is changed in place
 * if nobody else has the new one and they have no other link (which signs them out); otherwise the link moves.
 * `assumeSignin` proceeds as if sign-ins were on, for a dry run that is rolled back.
 */
export async function reconcileAccess(tx: Tx, o: { cause: string; report?: EndedReport; assumeSignin?: boolean }): Promise<ReconcileResult> {
  const r = await reconcileSignins(tx, o);
  return { ...r, appRecords: await keepAppRecordsInStep(tx) };
}

async function reconcileSignins(tx: Tx, o: { cause: string; report?: EndedReport; assumeSignin?: boolean }): Promise<SigninsResult> {
  const r: SigninsResult = { ran: false, granted: 0, ended: 0, emailChanged: 0, welcomeOwed: 0 };
  const loaded = await loadDecision(tx);
  if (!loaded || !(loaded.settings.signin || o.assumeSignin)) return r;
  r.ran = true;
  const { decision, settings } = loaded;
  const audit = (action: string, targetType: string, targetId: string, before: unknown, after: Record<string, unknown>) =>
    writeAudit({ actor: RECONCILE_ACTOR, action, targetType, targetId, before, after: { ...after, cause: o.cause } }, tx);

  for (const h of decision.held) {
    const made = await tx.insert(heldAddress).values({ email: h.email }).onConflictDoNothing().returning({ email: heldAddress.email });
    if (made.length) await audit("parent.hold.opened", "held_address", h.email, null, {});
  }

  // Lock everything this step may change, in a fixed order. People are locked FOR NO KEY UPDATE, so a row that only
  // references a person (a new sign-in code) is not held up by the run; changing an address takes the stronger lock then.
  const links = await tx.select().from(guardian).orderBy(guardian.id).for("update");
  const people = new Map((await tx.select().from(parent).orderBy(parent.id).for("no key update")).map((p) => [p.id, p]));
  const byEmail = new Map([...people.values()].map((p) => [p.email, p]));
  // Who each person was before this run changed anything, for the clean-up preview's list of ended sign-ins.
  const startedAs = new Map([...people.values()].map((p) => [p.id, { name: p.name, email: p.email }]));
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
    const wasOpen = l.status !== "disabled";
    const was = l.status === "disabled" ? l.statusBeforeDisable : l.status;
    const droppedSource = l.sourceQboId;
    const set = { status: "disabled" as const, disabledReason: reason, statusBeforeDisable: was, ...(dropSource ? { sourceQboId: null } : {}) };
    await tx.update(guardian).set({ ...set, updatedAt: new Date() }).where(eq(guardian.id, l.id));
    Object.assign(l, set);
    let sessionsEnded = await endFamilySessions(l.parentId, l.familyQboId, tx);
    if (!links.some((x) => x.parentId === l.parentId && x.status !== "disabled")) sessionsEnded += await endParentSessions(l.parentId, tx);
    // A document already made for them keeps a working signing link: their unfinished forms for this family start again.
    const formsReset = wasOpen ? await formsForGoneSigner(tx, { parentId: l.parentId, familyQboId: l.familyQboId, reason: "access_ended", actor: RECONCILE_ACTOR }) : 0;
    // A dropped source is gone from the row: the audit row keeps what it was.
    await audit("parent.access.ended", "guardian", l.id, dropSource ? { status: was, sourceQboId: droppedSource } : { status: was },
      { parentId: l.parentId, familyQboId: l.familyQboId, reason, sessionsEnded, ...(formsReset ? { formsReset } : {}) });
    r.ended++;
    if (o.report && wasOpen) o.report.ended.push({ ...startedAs.get(l.parentId)!, familyQboId: l.familyQboId });
  };
  /** Marks the person as owed a welcome when that is due; the caller records it on the grant's audit row. */
  const owe = async (p: Person): Promise<{ welcomeOwed?: true }> => {
    if (!settings.welcome || p.welcomedAt || p.welcomeOwed || p.blocked) return {};
    await tx.update(parent).set({ welcomeOwed: true, updatedAt: new Date() }).where(eq(parent.id, p.id));
    p.welcomeOwed = true; r.welcomeOwed++;
    return { welcomeOwed: true };
  };
  const createPerson = async (email: string, name: string, sourceQboId: string): Promise<Person> => {
    const [p] = await tx.insert(parent).values({ name, email }).returning();
    await tx.insert(parentAuthUser).values({ id: randomUUID(), name, email, emailVerified: true, parentId: p!.id });
    await audit("parent.create", "parent", p!.id, null, { name, email, sourceQboId });
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
      person ??= await createPerson(g.email, name, g.sourceQboId);
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

  // Why a link closes: the denial for its own record and address; else any denial for its address in that family (the
  // address may now be on another record there); else a denial of the whole record, one that names no address; else it
  // is not in QuickBooks.
  const exact = new Map<string, DisabledReason>(), byFamilyEmail = new Map<string, DisabledReason>(), wholeRecord = new Map<string, DisabledReason>();
  const first = (m: Map<string, DisabledReason>, k: string, v: DisabledReason) => { if (!m.has(k)) m.set(k, v); };
  for (const d of decision.denials) {
    if (d.email) { first(exact, `${d.familyQboId}|${d.sourceQboId}|${d.email}`, d.reason); first(byFamilyEmail, `${d.familyQboId}|${d.email}`, d.reason); }
    else first(wholeRecord, `${d.familyQboId}|${d.sourceQboId}`, d.reason);
  }
  const whyNot = (l: Link): DisabledReason => {
    const email = ownerOf(l).email;
    return (l.sourceQboId === null ? undefined : exact.get(`${l.familyQboId}|${l.sourceQboId}|${email}`))
      ?? byFamilyEmail.get(`${l.familyQboId}|${email}`) ?? wholeRecord.get(`${l.familyQboId}|${l.sourceQboId}`) ?? "not_in_quickbooks";
  };
  for (const l of links) {
    if (l.status !== "disabled" && !kept.has(l.id)) await close(l, whyNot(l));
  }
  return r;
}
