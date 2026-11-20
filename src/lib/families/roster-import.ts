// The import of the app's own records from the roster cache. It reads every family's customers, sign-ins and records,
// so it is staff code only, never imported by a parent page (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts).
//
// Since stage 3's slice 9c of the app-owned families spec the records stand alone: no roster read, staff write,
// read-again, shape save or email confirm changes them from the cache any more, and a staff write changes its own
// record itself (changeOwnRecord(), src/lib/roster/writes.ts). Its one caller under src/ is "Create a family from this"
// (stage 3's slice 10, src/lib/roster/no-family.ts), which runs it narrowed to one family customer (`one`). Stage 4's
// reviewed import is a later slice of its own and will not run it whole: a whole run would rewrite records the portal
// owns (families added by hand made inactive, renames undone, students moved back). It is also the one statement of the rules migration 0023's fill followed
// (tests/integration/app-records-fill.test.ts proves the two make the same records). The tests' helpers call it after
// they write the cache (syncAppRecords(), tests/helpers/app-records.ts), so the records they seed are the ones an
// import would make.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { accountingLink, family, guardian, qboCustomer, student } from "@/lib/db/schema";
import { getShape } from "@/lib/roster/shape";
import { getRosterSource } from "@/lib/roster/source";
import { asAppFamilyId, asAppStudentId, QUICKBOOKS, type AppFamilyId, type AppStudentId } from "./ids";
import { EMPTY_PLAN, planAppRecords, planForOneFamily, type PlanInput, type PlanRef } from "./plan";
import { noAppRecordChanges, type AppRecordChanges } from "./changes";

const CHUNK = 500;

/**
 * Every customer a record of the current company names, with the kind of record it names it as (Appendix A of the
 * app-owned families spec). Signed-form evidence of an earlier company (`earlier_company_at`) is never read: it gets no
 * app record, even when its number is a current family's. Left out on purpose: QuickBooks' own copies and the money
 * records' customers, items and invoices (they stay QuickBooks ids), a waiting email change's record, the held
 * addresses and the match review's families (retired, never re-keyed), and the audit log. Also left out: the records
 * since re-keyed to the app's own ids (the season's chosen lists, ticks, waivers and reminder claims, migrations
 * 0024 and 0025; volunteering's sign-ups, credit and reminder claims, migrations 0026 and 0027; form requests and the
 * current company's signed-form evidence, migrations 0028 and 0029; buy-outs, migrations 0030 and 0031; the money
 * cache, migrations 0032 and 0033, a row of which is only ever written for a family that has a record; and the write
 * queue, migrations 0034 and 0035, whose items name the family they are filed under and the student they are for by
 * their records' ids: the customers they send stay QuickBooks', and the restrict keys keep the records; and parents'
 * sessions and pending email changes, migrations 0037 and 0038, which name the family a session chose, or a change was
 * asked in, by its record's id), which name a record by its id and keep it, inactive, for as long as they do. So what
 * is read here is guardian rows alone (but those a change of company closed), each naming a family. Migration 0023 read
 * the same in SQL, with those as they were; tests/helpers/app-records-fill.ts leaves them out when it runs 0023's fill
 * again on today's tables. Change the two together.
 */
const refsQuery = () => sql`
  SELECT DISTINCT customer_id, kind FROM (
    SELECT family_qbo_id AS customer_id, 'family' AS kind FROM guardian WHERE disabled_reason IS DISTINCT FROM 'company_changed'
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
  const refs: PlanRef[] = Array.from(await tx.execute<{ customer_id: string; kind: string }>(refsQuery()))
    .filter((r) => r.kind === "family" || r.kind === "student").map((r) => ({ customerId: r.customer_id, kind: r.kind as PlanRef["kind"] }));
  const hints = new Map(Array.from(await tx.execute<{ customer_id: string; name: string }>(hintsQuery(realmId))).map((h) => [h.customer_id, h.name]));
  return { shape, customers, refs, hints, guardians };
}

/** Thrown when the import fails, with what failed as its cause, so a caller can tell it from its own failures. */
export class AppRecordsFailed extends Error {}

const inChunks = async <T>(rows: T[], f: (chunk: T[]) => Promise<unknown>) => { for (let i = 0; i < rows.length; i += CHUNK) await f(rows.slice(i, i + CHUNK)); };

/**
 * One family customer to import alone, by a staff member who confirmed it ("Create a family from this"): the plan is
 * narrowed to that customer's family record and its students' (planForOneFamily()), and each link made is `confirmed`
 * by `linkedBy` (a `staff_user.id`).
 */
export type OneFamily = { familyCustomerId: string; linkedBy: string };
/**
 * What a run narrowed to one family made: the family record (null when the customer had one already, or the plan has
 * none of it), the student records made, and the students the plan holds under it that have a record already (another
 * family's, or inactive), left exactly as they are, each with its customer.
 */
export type OneFamilyImport = {
  changes: AppRecordChanges;
  family: AppFamilyId | null;
  students: { made: { id: AppStudentId; customerId: string }[]; leftAlone: { id: AppStudentId; customerId: string }[] };
};

/**
 * Imports the app's own records and links from the roster cache and what the current company's records name
 * (./plan.ts says what that is). Until stage 3's slice 9c a mirror of the cache ran it after every change of it (the
 * note at the top of this file says who runs it now). It changes only what differs, so a second run changes nothing.
 * It never deletes a record or a link: one nothing needs any more is made inactive and keeps its id and its link, and
 * is the same record, active again, when its customer is named again. Only a change of company removes them
 * (clearAppRecords(), ./company-change.ts). A cache that names no company leaves every record inactive. Every link a
 * whole run makes is carried over from the roster, now, with nobody named.
 *
 * Given `one`, it runs by the same rules narrowed to that family customer (planForOneFamily()) and only makes what is
 * missing there: the family record and its link, and a record and link for each student customer under it that has no
 * student record yet; it changes no record that exists (a student with a record is left alone, and counted), points
 * or links no guardian row, and each link it makes is `confirmed` by `one.linkedBy`.
 *
 * It writes no audit row of its own and returns what it made and changed: its caller puts that on its own audit row,
 * in the same transaction (appRecordsAudit() for a whole run). The caller owns the transaction and holds the roster
 * lock (ROSTER_LOCK) exclusively.
 */
export async function importRecordsFromRoster(tx: Tx): Promise<AppRecordChanges>;
export async function importRecordsFromRoster(tx: Tx, one: OneFamily): Promise<OneFamilyImport>;
export async function importRecordsFromRoster(tx: Tx, one?: OneFamily): Promise<AppRecordChanges | OneFamilyImport> {
  try {
    const made = await importInto(tx, one);
    return one === undefined ? made.changes : made;
  } catch (e) {
    throw new AppRecordsFailed("The portal's own family records couldn't be brought up to date.", { cause: e });
  }
}

async function importInto(tx: Tx, one: OneFamily | undefined): Promise<OneFamilyImport> {
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
  const whole = realmId === null ? EMPTY_PLAN : planAppRecords({ ...(await loadPlanInput(tx, realmId)), known });
  const plan = one === undefined ? whole : planForOneFamily(whole, one.familyCustomerId);
  // A whole run's links are carried over from the roster, by nobody; one family's are confirmed by who asked.
  const linkedAs = one === undefined ? { origin: "carried_over" as const } : { origin: "confirmed" as const, linkedBy: one.linkedBy };
  // Narrowed to one family, nothing that exists is changed: only what is missing there is made.
  const changeExisting = one === undefined;
  // A new link starts aligned with its customer's version in the cache (`synced_token`, stage 3's slice 9e), as
  // migration 0041 filled every link: the customer staff confirmed, or the roster carried over. None for a customer the
  // cache doesn't hold. A link that exists keeps its version, but a guardian's link moved to another customer takes that one's.
  const tokenOf = new Map((await tx.select({ qboId: qboCustomer.qboId, syncToken: qboCustomer.syncToken }).from(qboCustomer)).map((c) => [c.qboId, c.syncToken]));
  const alignedAt = new Date();
  const aligned = (customerId: string) => (tokenOf.has(customerId) ? { syncedToken: tokenOf.get(customerId)!, syncedAt: alignedAt } : {});

  // 1. Families: new ones with their links; every existing one as the plan has it, or inactive when it isn't there.
  const newFamilies = [...plan.families].filter(([customerId]) => !familyIdOf.has(customerId))
    .map(([customerId, f]) => { const id = asAppFamilyId(randomUUID()); familyIdOf.set(customerId, id); return { id, customerId, ...f }; });
  await inChunks(newFamilies, (rows) => tx.insert(family).values(rows.map((f) => ({ id: f.id, name: f.name, active: f.active }))));
  await inChunks(newFamilies, (rows) => tx.insert(accountingLink).values(rows.map((f) => ({ system: QUICKBOOKS, realmId: realmId!, customerId: f.customerId, familyId: f.id, ...linkedAs, ...aligned(f.customerId) }))));
  changes.families.made = newFamilies.length;
  const customerOfFamily = new Map([...familyIdOf].map(([customerId, id]) => [id, customerId]));
  for (const f of changeExisting ? families : []) {
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
  const leftAlone = [...plan.students.keys()].flatMap((customerId) => { const id = studentIdOf.get(customerId); return id === undefined ? [] : [{ id, customerId }]; });
  const newStudents = [...plan.students].filter(([customerId]) => !studentIdOf.has(customerId))
    .map(([customerId, s]) => { const id = asAppStudentId(randomUUID()); studentIdOf.set(customerId, id); return { id, customerId, ...s }; });
  await inChunks(newStudents, (rows) => tx.insert(student).values(rows.map((s) => ({ id: s.id, name: s.name, active: s.active, familyId: familyFor(s.familyCustomerId) }))));
  await inChunks(newStudents, (rows) => tx.insert(accountingLink).values(rows.map((s) => ({ system: QUICKBOOKS, realmId: realmId!, customerId: s.customerId, studentId: s.id, ...linkedAs, ...aligned(s.customerId) }))));
  changes.students.made = newStudents.length;
  const customerOfStudent = new Map([...studentIdOf].map(([customerId, id]) => [id, customerId]));
  for (const s of changeExisting ? students : []) {
    const customerId = customerOfStudent.get(s.id);
    const want = customerId === undefined ? undefined : plan.students.get(customerId);
    const familyId = want && want.familyCustomerId !== null ? familyFor(want.familyCustomerId) : s.familyId;
    const next = want ? { name: want.name, active: want.active, familyId } : { name: s.name, active: false, familyId };
    if (s.name === next.name && s.active === next.active && s.familyId === next.familyId) continue;
    await tx.update(student).set({ ...next, updatedAt: new Date() }).where(eq(student.id, s.id));
    changes.students.changed++;
  }

  // 3. Each guardian row in its family, and linked to the record its sign-in came from. A row whose sign-in no longer
  //    comes from a record of its own keeps the link it had: it says where the sign-in came from. Narrowed to one
  //    family, no guardian row is touched (the narrowed plan holds none).
  for (const m of changeExisting ? memberships : []) {
    // A row that names no customer (made while its family had no link) is not in the plan: it keeps the family it has.
    if (!plan.memberships.has(m.id)) continue;
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
    // Now another customer's link, it holds that customer's version from the cache (or none), never the old one's.
    await tx.update(accountingLink).set({ customerId, linkedAt: new Date(), ...(tokenOf.has(customerId) ? aligned(customerId) : { syncedToken: null, syncedAt: null }), updatedAt: new Date() }).where(eq(accountingLink.id, had.id));
    changes.memberships.relinked++;
  }
  await inChunks(newLinks, (rows) => tx.insert(accountingLink).values(rows.map(([guardianId, customerId]) => ({ system: QUICKBOOKS, realmId: realmId!, customerId, guardianId, ...linkedAs, ...aligned(customerId) }))));
  changes.memberships.linked = newLinks.length;
  return { changes, family: newFamilies[0]?.id ?? null, students: { made: newStudents.map((s) => ({ id: s.id, customerId: s.customerId })), leftAlone } };
}
