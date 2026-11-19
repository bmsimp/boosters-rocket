// Reads every family's customers, sign-ins and records to keep the app's own records in step: staff and worker code
// only, never imported by a parent page (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts).
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { accountingLink, family, guardian, qboCustomer, student } from "@/lib/db/schema";
import { getShape } from "@/lib/roster/shape";
import { getRosterSource } from "@/lib/roster/source";
import { asAppFamilyId, asAppStudentId, QUICKBOOKS, type AppFamilyId, type AppStudentId } from "./ids";
import { EMPTY_PLAN, planAppRecords, type PlanInput, type PlanRef } from "./plan";
import { noAppRecordChanges, type AppRecordChanges } from "./changes";

const CHUNK = 500;

/**
 * Every customer a record of the current company names, with the kind of record it names it as (Appendix A of the
 * app-owned families spec). Signed-form evidence of an earlier company (`earlier_company_at`) is never read: it gets no
 * app record, even when its number is a current family's. Left out on purpose: QuickBooks' own copies and the money
 * records' customers, items and invoices (they stay QuickBooks ids), a waiting email change's record, the held
 * addresses and the match review's families (retired, never re-keyed), and the audit log. Also left out: the records
 * stage 2 has re-keyed to the app's own ids (the season's chosen lists, ticks, waivers and reminder claims, migrations
 * 0024 and 0025; volunteering's sign-ups, credit and reminder claims, migrations 0026 and 0027; form requests and the
 * current company's signed-form evidence, migrations 0028 and 0029; buy-outs, migrations 0030 and 0031; the money
 * cache, migrations 0032 and 0033, a row of which is only ever written for a family that has a record), which name a
 * record by its id and keep it, inactive, for as long as they do. Migration 0023 read the same in SQL, with those as they were;
 * tests/helpers/app-records-fill.ts leaves them out when it runs 0023's fill again on today's tables. Change the two
 * together.
 */
const refsQuery = (realmId: string) => sql`
  SELECT DISTINCT customer_id, kind FROM (
    SELECT family_qbo_id AS customer_id, 'family' AS kind FROM guardian WHERE disabled_reason IS DISTINCT FROM 'company_changed'
    UNION ALL SELECT family_qbo_id, 'family' FROM parent_email_change
    UNION ALL SELECT family_qbo_id, 'family' FROM parent_auth_session
    UNION ALL SELECT family_qbo_id, 'family' FROM write_queue WHERE realm_id = ${realmId}
    UNION ALL SELECT target_qbo_id, CASE WHEN request->>'role' = 'student' THEN 'student' ELSE 'family' END FROM write_queue
      WHERE realm_id = ${realmId} AND request->>'op' IN ('rename', 'move', 'deactivate') AND request->>'role' IN ('family', 'member', 'student')
  ) refs WHERE customer_id IS NOT NULL`;

/**
 * What the portal last knew a customer as, for one the cache doesn't hold: the newest current-company kept form's
 * family or subject name, from the names and customers it keeps as its own copies. Migration 0023 read the newest
 * form request's subject name and the newest sign-up's student name too, after it; each now names its record, which
 * keeps the name it has. Migration 0023 reads
 * the rest the same in SQL; change the two together.
 */
const hintsQuery = (realmId: string) => sql`
  SELECT DISTINCT ON (customer_id) customer_id, name FROM (
    SELECT family_qbo_id AS customer_id, family_name AS name, 1 AS rank, stored_at AS at, id FROM signed_form_evidence
      WHERE earlier_company_at IS NULL AND realm_id = ${realmId} AND btrim(family_name) <> ''
    UNION ALL SELECT subject_qbo_id, subject_name, 1, stored_at, id FROM signed_form_evidence
      WHERE earlier_company_at IS NULL AND realm_id = ${realmId} AND btrim(subject_name) <> ''
  ) hints ORDER BY customer_id, rank, at DESC, id DESC`;

async function loadPlanInput(tx: Tx, realmId: string): Promise<Omit<PlanInput, "known">> {
  const shape = await getShape(tx);
  const customers = await tx.select({ qboId: qboCustomer.qboId, displayName: qboCustomer.displayName, active: qboCustomer.active,
    parentQboId: qboCustomer.parentQboId, typeQboId: qboCustomer.typeQboId }).from(qboCustomer);
  const guardians = await tx.select({ id: guardian.id, familyQboId: guardian.familyQboId, sourceQboId: guardian.sourceQboId,
    status: guardian.status, disabledReason: guardian.disabledReason }).from(guardian);
  const refs: PlanRef[] = Array.from(await tx.execute<{ customer_id: string; kind: string }>(refsQuery(realmId)))
    .filter((r) => r.kind === "family" || r.kind === "student").map((r) => ({ customerId: r.customer_id, kind: r.kind as PlanRef["kind"] }));
  const hints = new Map(Array.from(await tx.execute<{ customer_id: string; name: string }>(hintsQuery(realmId))).map((h) => [h.customer_id, h.name]));
  return { shape, customers, refs, hints, guardians };
}

/** Thrown when bringing the records into step fails, so the roster read can say which part failed (app_records_failed). */
export class AppRecordsFailed extends Error {}

const inChunks = async <T>(rows: T[], f: (chunk: T[]) => Promise<unknown>) => { for (let i = 0; i < rows.length; i += CHUNK) await f(rows.slice(i, i + CHUNK)); };

/**
 * Makes the app's own records and links agree with the roster cache and what the current company's records name
 * (./plan.ts says what that is): the one definition of "in step" until stage 3 makes the app the source. It changes
 * only what differs, so a second run changes nothing. It never deletes a record or a link: one nothing needs any more
 * is made inactive and keeps its id and its link, and is the same record, active again, when its customer is named
 * again. Only a change of company removes them (clearAppRecords(), ./company-change.ts). A cache that names no company
 * leaves every record inactive. Every link it makes is carried over from the roster, now, with nobody named.
 *
 * It writes no audit row of its own and returns what it made and changed: the change that ran it puts that on its own
 * audit row, in the same transaction, whenever anything changed (appRecordsAudit()). Its callers are reconcileAccess()
 * (src/lib/parents/reconcile.ts), which runs it last and returns its counts, for every roster read, staff roster write,
 * read-again, reconcile and confirmed change of a parent's sign-in email; and saveShape() after a new membership shape.
 * The caller owns the transaction and holds the roster lock (ROSTER_LOCK) exclusively.
 */
export async function keepAppRecordsInStep(tx: Tx): Promise<AppRecordChanges> {
  try {
    return await bringIntoStep(tx);
  } catch (e) {
    throw new AppRecordsFailed("The portal's own family records couldn't be brought up to date.", { cause: e });
  }
}

async function bringIntoStep(tx: Tx): Promise<AppRecordChanges> {
  const realmId = await getRosterSource(tx);
  const changes = noAppRecordChanges();

  const links = await tx.select().from(accountingLink).orderBy(accountingLink.id).for("update");
  const families = await tx.select().from(family).orderBy(family.id).for("update");
  const students = await tx.select().from(student).orderBy(student.id).for("update");
  const memberships = await tx.select({ id: guardian.id, familyId: guardian.familyId }).from(guardian);

  // This company's links by kind: the record of each customer, and each guardian row's link. Another company's links
  // are left as they are: a change of company removes them, and no lookup reads them.
  const ours = links.filter((l) => realmId !== null && l.system === QUICKBOOKS && l.realmId === realmId);
  const familyIdOf = new Map<string, AppFamilyId>(), studentIdOf = new Map<string, AppStudentId>();
  const linkOfRow = new Map<string, { id: string; customerId: string }>();
  for (const l of ours) {
    if (l.familyId !== null) familyIdOf.set(l.customerId, l.familyId);
    else if (l.studentId !== null) studentIdOf.set(l.customerId, l.studentId);
    else if (l.guardianId !== null) linkOfRow.set(l.guardianId, { id: l.id, customerId: l.customerId });
  }
  // The name each record has now: what the portal last knew a customer the cache no longer holds as.
  const nameOfFamily = new Map(families.map((f) => [f.id, f.name])), nameOfStudent = new Map(students.map((s) => [s.id, s.name]));
  const known = { families: new Map<string, string>(), students: new Map<string, string>() };
  for (const [customerId, id] of familyIdOf) { const name = nameOfFamily.get(id); if (name) known.families.set(customerId, name); }
  for (const [customerId, id] of studentIdOf) { const name = nameOfStudent.get(id); if (name) known.students.set(customerId, name); }
  const plan = realmId === null ? EMPTY_PLAN : planAppRecords({ ...(await loadPlanInput(tx, realmId)), known });

  // 1. Families: new ones with their links; every existing one as the plan has it, or inactive when it isn't there.
  const newFamilies = [...plan.families].filter(([customerId]) => !familyIdOf.has(customerId))
    .map(([customerId, f]) => { const id = asAppFamilyId(randomUUID()); familyIdOf.set(customerId, id); return { id, customerId, ...f }; });
  await inChunks(newFamilies, (rows) => tx.insert(family).values(rows.map((f) => ({ id: f.id, name: f.name, active: f.active }))));
  await inChunks(newFamilies, (rows) => tx.insert(accountingLink).values(rows.map((f) => ({ system: QUICKBOOKS, realmId: realmId!, customerId: f.customerId, familyId: f.id, origin: "carried_over" as const }))));
  changes.families.made = newFamilies.length;
  const customerOfFamily = new Map([...familyIdOf].map(([customerId, id]) => [id, customerId]));
  for (const f of families) {
    const customerId = customerOfFamily.get(f.id);
    const want = customerId === undefined ? undefined : plan.families.get(customerId);
    const next = want ?? { name: f.name, active: false };
    if (f.name === next.name && f.active === next.active) continue;
    await tx.update(family).set({ name: next.name, active: next.active, updatedAt: new Date() }).where(eq(family.id, f.id));
    changes.families.changed++;
  }
  const familyFor = (customerId: string | null | undefined) => (customerId ? familyIdOf.get(customerId) ?? null : null);

  // 2. Students the same way, each in the family the roster holds them under; one it doesn't keeps the family they were
  //    last in (none, for one never held under a family).
  const newStudents = [...plan.students].filter(([customerId]) => !studentIdOf.has(customerId))
    .map(([customerId, s]) => { const id = asAppStudentId(randomUUID()); studentIdOf.set(customerId, id); return { id, customerId, ...s }; });
  await inChunks(newStudents, (rows) => tx.insert(student).values(rows.map((s) => ({ id: s.id, name: s.name, active: s.active, familyId: familyFor(s.familyCustomerId) }))));
  await inChunks(newStudents, (rows) => tx.insert(accountingLink).values(rows.map((s) => ({ system: QUICKBOOKS, realmId: realmId!, customerId: s.customerId, studentId: s.id, origin: "carried_over" as const }))));
  changes.students.made = newStudents.length;
  const customerOfStudent = new Map([...studentIdOf].map(([customerId, id]) => [id, customerId]));
  for (const s of students) {
    const customerId = customerOfStudent.get(s.id);
    const want = customerId === undefined ? undefined : plan.students.get(customerId);
    const familyId = want && want.familyCustomerId !== null ? familyFor(want.familyCustomerId) : s.familyId;
    const next = want ? { name: want.name, active: want.active, familyId } : { name: s.name, active: false, familyId };
    if (s.name === next.name && s.active === next.active && s.familyId === next.familyId) continue;
    await tx.update(student).set({ ...next, updatedAt: new Date() }).where(eq(student.id, s.id));
    changes.students.changed++;
  }

  // 3. Each guardian row in its family, and linked to the record its sign-in came from. A row whose sign-in no longer
  //    comes from a record of its own keeps the link it had: it says where the sign-in came from.
  for (const m of memberships) {
    const now = familyFor(plan.memberships.get(m.id));
    if (m.familyId === now) continue;
    await tx.update(guardian).set({ familyId: now }).where(eq(guardian.id, m.id));
    changes.memberships.pointed++;
  }
  const newLinks: [string, string][] = [];
  for (const [guardianId, customerId] of plan.membershipLinks) {
    const had = linkOfRow.get(guardianId);
    if (!had) { newLinks.push([guardianId, customerId]); continue; }
    if (had.customerId === customerId) continue;
    await tx.update(accountingLink).set({ customerId, linkedAt: new Date(), updatedAt: new Date() }).where(eq(accountingLink.id, had.id));
    changes.memberships.relinked++;
  }
  await inChunks(newLinks, (rows) => tx.insert(accountingLink).values(rows.map(([guardianId, customerId]) => ({ system: QUICKBOOKS, realmId: realmId!, customerId, guardianId, origin: "carried_over" as const }))));
  changes.memberships.linked = newLinks.length;
  return changes;
}
