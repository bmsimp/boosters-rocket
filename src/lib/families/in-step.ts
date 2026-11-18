// Reads every family's customers, sign-ins and records to keep the app's own records in step: staff and worker code
// only, never imported by a parent page (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts).
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { accountingLink, family, guardian, qboCustomer, student } from "@/lib/db/schema";
import { getShape } from "@/lib/roster/shape";
import { getRosterSource } from "@/lib/roster/source";
import { asAppFamilyId, asAppStudentId, QUICKBOOKS, type AppFamilyId, type AppStudentId } from "./ids";
import { EMPTY_PLAN, planAppRecords, type PlanInput, type PlanRef } from "./plan";

const CHUNK = 500;

/**
 * Every customer a record of the current company names, with the kind of record it names it as (Appendix A of the
 * app-owned families spec). Signed-form evidence of an earlier company (`earlier_company_at`) is never read: it gets no
 * app record, even when its number is a current family's. Left out on purpose: QuickBooks' own copies and the money
 * records' customers, items and invoices (they stay QuickBooks ids), a waiting email change's record, the held
 * addresses and the match review's families (retired, never re-keyed), and the audit log. Migration 0023 reads the
 * same in SQL; change the two together.
 */
const refsQuery = (realmId: string) => sql`
  SELECT DISTINCT customer_id, kind FROM (
    SELECT family_qbo_id AS customer_id, 'family' AS kind FROM guardian WHERE disabled_reason IS DISTINCT FROM 'company_changed'
    UNION ALL SELECT family_qbo_id, 'family' FROM parent_email_change
    UNION ALL SELECT family_qbo_id, 'family' FROM parent_auth_session
    UNION ALL SELECT family_qbo_id, 'family' FROM family_money WHERE realm_id IS NULL OR realm_id = ${realmId}
    UNION ALL SELECT family_qbo_id, 'family' FROM write_queue WHERE realm_id = ${realmId}
    UNION ALL SELECT target_qbo_id, CASE WHEN request->>'role' = 'student' THEN 'student' ELSE 'family' END FROM write_queue
      WHERE realm_id = ${realmId} AND request->>'op' IN ('rename', 'move', 'deactivate') AND request->>'role' IN ('family', 'member', 'student')
    UNION ALL SELECT c.subject_qbo_id, r.applies_to FROM requirement_cover c JOIN requirement r ON r.id = c.requirement_id
    UNION ALL SELECT p.subject_qbo_id, r.applies_to FROM requirement_progress p JOIN requirement r ON r.id = p.requirement_id
    UNION ALL SELECT family_qbo_id, 'family' FROM requirement_reminder
    UNION ALL SELECT family_qbo_id, 'family' FROM volunteer_signup
    UNION ALL SELECT student_qbo_id, 'student' FROM volunteer_signup
    UNION ALL SELECT family_qbo_id, 'family' FROM volunteer_credit
    UNION ALL SELECT student_qbo_id, 'student' FROM volunteer_credit
    UNION ALL SELECT family_qbo_id, 'family' FROM volunteer_reminder
    UNION ALL SELECT family_qbo_id, 'family' FROM buyout WHERE realm_id = ${realmId}
    UNION ALL SELECT b.subject_qbo_id, r.applies_to FROM buyout b JOIN requirement r ON r.id = b.requirement_id WHERE b.realm_id = ${realmId}
    UNION ALL SELECT family_qbo_id, 'family' FROM signature_request
    UNION ALL SELECT s.subject_qbo_id, r.applies_to FROM signature_request s JOIN requirement r ON r.id = s.requirement_id
    UNION ALL SELECT family_qbo_id, 'family' FROM signed_form_evidence WHERE earlier_company_at IS NULL AND realm_id = ${realmId}
    UNION ALL SELECT subject_qbo_id, subject_kind FROM signed_form_evidence WHERE earlier_company_at IS NULL AND realm_id = ${realmId}
  ) refs WHERE customer_id IS NOT NULL`;

/**
 * What the portal last knew a customer as, for one the cache doesn't hold: the newest current-company kept form's
 * family or subject name, then the newest form request's subject name, then the newest sign-up's student name.
 * Migration 0023 reads the same in SQL; change the two together.
 */
const hintsQuery = (realmId: string) => sql`
  SELECT DISTINCT ON (customer_id) customer_id, name FROM (
    SELECT family_qbo_id AS customer_id, family_name AS name, 1 AS rank, stored_at AS at, id FROM signed_form_evidence
      WHERE earlier_company_at IS NULL AND realm_id = ${realmId} AND btrim(family_name) <> ''
    UNION ALL SELECT subject_qbo_id, subject_name, 1, stored_at, id FROM signed_form_evidence
      WHERE earlier_company_at IS NULL AND realm_id = ${realmId} AND btrim(subject_name) <> ''
    UNION ALL SELECT subject_qbo_id, subject_name, 2, updated_at, id FROM signature_request WHERE btrim(subject_name) <> ''
    UNION ALL SELECT student_qbo_id, filler_name, 3, created_at, id FROM volunteer_signup WHERE student_qbo_id IS NOT NULL AND btrim(filler_name) <> ''
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

export type AppRecordChanges = {
  families: { made: number; changed: number; removed: number };
  students: { made: number; changed: number; removed: number };
  memberships: { linked: number; unlinked: number; pointed: number };
};

const inChunks = async <T>(rows: T[], f: (chunk: T[]) => Promise<unknown>) => { for (let i = 0; i < rows.length; i += CHUNK) await f(rows.slice(i, i + CHUNK)); };

/**
 * Makes the app's own records and links agree with the roster cache and what the current company's records name
 * (./plan.ts says what that is): the one definition of "in step" until stage 3 makes the app the source. It changes
 * only what differs, so a second run changes nothing, and each record keeps its id while its customer stays the same
 * kind. A cache that names no company has no records at all. Every link it makes is carried over from the roster, now,
 * with nobody named. It writes no audit row of its own: it follows the change that called it, whose audit row is in the
 * same transaction (the roster read, a staff roster write, the reconcile, a parent's change of address, a shape save).
 *
 * The caller owns the transaction and holds the roster lock (ROSTER_LOCK) exclusively: reconcileAccess()
 * (src/lib/parents/reconcile.ts) calls it last, for every roster read, staff roster write, reconcile and confirmed
 * change of address; saveShape() calls it after a new membership shape.
 */
export async function keepAppRecordsInStep(tx: Tx): Promise<AppRecordChanges> {
  const realmId = await getRosterSource(tx);
  const changes: AppRecordChanges = { families: { made: 0, changed: 0, removed: 0 }, students: { made: 0, changed: 0, removed: 0 }, memberships: { linked: 0, unlinked: 0, pointed: 0 } };

  const links = await tx.select().from(accountingLink).orderBy(accountingLink.id).for("update");
  const families = await tx.select().from(family).orderBy(family.id).for("update");
  const students = await tx.select().from(student).orderBy(student.id).for("update");
  const memberships = await tx.select({ id: guardian.id, familyId: guardian.familyId }).from(guardian);
  // The name each of this company's customers' records has now: what the portal last knew one the cache no longer holds as.
  const nameOfFamily = new Map(families.map((f) => [f.id, f.name])), nameOfStudent = new Map(students.map((s) => [s.id, s.name]));
  const known = new Map<string, string>();
  for (const l of links) {
    if (realmId === null || l.system !== QUICKBOOKS || l.realmId !== realmId) continue;
    const name = l.familyId !== null ? nameOfFamily.get(l.familyId) : l.studentId !== null ? nameOfStudent.get(l.studentId) : undefined;
    if (name !== undefined) known.set(l.customerId, name);
  }
  const plan = realmId === null ? EMPTY_PLAN : planAppRecords({ ...(await loadPlanInput(tx, realmId)), known });

  // The links that stay: this company's, to a record of the kind the plan has for that customer, or to the guardian
  // row the plan links that customer to. Every other link goes, and every record left without one.
  const familyIdOf = new Map<string, AppFamilyId>(), studentIdOf = new Map<string, AppStudentId>(), linkedRows = new Set<string>();
  const keptFamilies = new Map<AppFamilyId, string>(), keptStudents = new Map<AppStudentId, string>(); // record -> its customer
  const goingLinks: string[] = [];
  for (const l of links) {
    const ours = realmId !== null && l.system === QUICKBOOKS && l.realmId === realmId;
    if (ours && l.familyId !== null && plan.families.has(l.customerId)) { familyIdOf.set(l.customerId, l.familyId); keptFamilies.set(l.familyId, l.customerId); }
    else if (ours && l.studentId !== null && plan.students.has(l.customerId)) { studentIdOf.set(l.customerId, l.studentId); keptStudents.set(l.studentId, l.customerId); }
    else if (ours && l.guardianId !== null && plan.membershipLinks.get(l.guardianId) === l.customerId) linkedRows.add(l.guardianId);
    else { goingLinks.push(l.id); if (l.guardianId !== null) changes.memberships.unlinked++; }
  }
  const goingFamilies = families.filter((f) => !keptFamilies.has(f.id)).map((f) => f.id);
  const goingStudents = students.filter((s) => !keptStudents.has(s.id)).map((s) => s.id);

  // New records get their ids now, so a student can name a family made in this same run.
  const newFamilies = [...plan.families].filter(([customerId]) => !familyIdOf.has(customerId))
    .map(([customerId, f]) => { const id = asAppFamilyId(randomUUID()); familyIdOf.set(customerId, id); return { id, customerId, ...f }; });
  const newStudents = [...plan.students].filter(([customerId]) => !studentIdOf.has(customerId))
    .map(([customerId, s]) => { const id = asAppStudentId(randomUUID()); studentIdOf.set(customerId, id); return { id, customerId, ...s }; });
  const familyFor = (customerId: string | null | undefined) => (customerId ? familyIdOf.get(customerId) ?? null : null);

  // 1. The links that go, so a customer can be linked again as another kind below. A guardian row that changes family
  //    lets go of the old one first, so no family that goes is still named.
  await inChunks(goingLinks, (ids) => tx.delete(accountingLink).where(inArray(accountingLink.id, ids)));
  const pointed = memberships.map((m) => ({ id: m.id, was: m.familyId, now: familyFor(plan.memberships.get(m.id)) })).filter((m) => m.was !== m.now);
  const letGo = pointed.filter((m) => m.was !== null).map((m) => m.id);
  await inChunks(letGo, (ids) => tx.update(guardian).set({ familyId: null }).where(inArray(guardian.id, ids)));

  // 2. New families, with their links.
  await inChunks(newFamilies, (rows) => tx.insert(family).values(rows.map((f) => ({ id: f.id, name: f.name, active: f.active }))));
  await inChunks(newFamilies, (rows) => tx.insert(accountingLink).values(rows.map((f) => ({ system: QUICKBOOKS, realmId: realmId!, customerId: f.customerId, familyId: f.id, origin: "carried_over" as const }))));
  changes.families.made = newFamilies.length;

  // 3. Students that stay take their name, state and family; those that go, go; then the families that go.
  for (const s of students) {
    const customerId = keptStudents.get(s.id);
    if (customerId === undefined) continue;
    const want = plan.students.get(customerId)!;
    const familyId = familyFor(want.familyCustomerId);
    if (s.name === want.name && s.active === want.active && s.familyId === familyId) continue;
    await tx.update(student).set({ name: want.name, active: want.active, familyId, updatedAt: new Date() }).where(eq(student.id, s.id));
    changes.students.changed++;
  }
  await inChunks(goingStudents, (ids) => tx.delete(student).where(inArray(student.id, ids)));
  changes.students.removed = goingStudents.length;
  await inChunks(goingFamilies, (ids) => tx.delete(family).where(inArray(family.id, ids)));
  changes.families.removed = goingFamilies.length;
  for (const f of families) {
    const customerId = keptFamilies.get(f.id);
    if (customerId === undefined) continue;
    const want = plan.families.get(customerId)!;
    if (f.name === want.name && f.active === want.active) continue;
    await tx.update(family).set({ name: want.name, active: want.active, updatedAt: new Date() }).where(eq(family.id, f.id));
    changes.families.changed++;
  }

  // 4. New students, with their links.
  await inChunks(newStudents, (rows) => tx.insert(student).values(rows.map((s) => ({ id: s.id, name: s.name, active: s.active, familyId: familyFor(s.familyCustomerId) }))));
  await inChunks(newStudents, (rows) => tx.insert(accountingLink).values(rows.map((s) => ({ system: QUICKBOOKS, realmId: realmId!, customerId: s.customerId, studentId: s.id, origin: "carried_over" as const }))));
  changes.students.made = newStudents.length;

  // 5. Each guardian row in its family, and linked to the record its sign-in came from.
  for (const m of pointed) if (m.now !== null) await tx.update(guardian).set({ familyId: m.now }).where(eq(guardian.id, m.id));
  changes.memberships.pointed = pointed.length;
  const newLinks = [...plan.membershipLinks].filter(([guardianId]) => !linkedRows.has(guardianId));
  await inChunks(newLinks, (rows) => tx.insert(accountingLink).values(rows.map(([guardianId, customerId]) => ({ system: QUICKBOOKS, realmId: realmId!, customerId, guardianId, origin: "carried_over" as const }))));
  changes.memberships.linked = newLinks.length;
  return changes;
}
