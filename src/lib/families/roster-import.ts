// The import of the app's families and students from the roster cache, with their links: staff code only, never
// imported by a parent page (STAFF_ONLY_IMPORTS in tests/integration/page-guards.test.ts). It touches no guardian row.
// Its one caller under src/ is "Create a family from this" (src/lib/roster/no-family.ts), narrowed to one family
// customer (`one`); the tests' helpers run it whole after they write the cache (syncAppRecords(),
// tests/helpers/app-records.ts), and a whole run makes the records migration 0023's fill made (app-records-fill.test.ts).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { accountingLink, family, qboCustomer, student } from "@/lib/db/schema";
import { getShape } from "@/lib/roster/shape";
import { getRosterSource } from "@/lib/roster/source";
import { asAppFamilyId, asAppStudentId, QUICKBOOKS, type AppFamilyId, type AppStudentId } from "./ids";
import { EMPTY_PLAN, planAppRecords, planForOneFamily, type PlanInput } from "./plan";
import { noAppRecordChanges, type AppRecordChanges } from "./changes";

const CHUNK = 500;

async function loadPlanInput(tx: Tx): Promise<PlanInput> {
  const shape = await getShape(tx);
  const customers = await tx.select({ qboId: qboCustomer.qboId, displayName: qboCustomer.displayName, active: qboCustomer.active,
    parentQboId: qboCustomer.parentQboId, typeQboId: qboCustomer.typeQboId }).from(qboCustomer);
  return { shape, customers };
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
 * Imports the app's own families and students and their links from the roster cache (./plan.ts says what that is). It
 * changes only what differs, so a second run changes nothing.
 * It never deletes a record or a link: one nothing needs any more is made inactive and keeps its id and its link, and
 * is the same record, active again, when its customer is named again. A change of company removes no record either: it
 * ends every link, into the link history (endLinksOfEarlierCompany(), ./company-change.ts). A cache that names no company leaves every record inactive. Every link a
 * whole run makes is carried over from the roster, now, with nobody named.
 *
 * Given `one`, it runs by the same rules narrowed to that family customer (planForOneFamily()) and only makes what is
 * missing there: the family record and its link, and a record and link for each student customer under it that has no
 * student record yet; it changes no record that exists (a student with a record is left alone, and counted), and each
 * link it makes is `confirmed` by `one.linkedBy`.
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

  // This company's family and student links: the record of each customer. A guardian row's link is not the import's,
  // and another company's links are left as they are: a change of company removes them, and no lookup reads them.
  const ours = links.filter((l) => realmId !== null && l.system === QUICKBOOKS && l.realmId === realmId);
  const familyIdOf = new Map<string, AppFamilyId>(), studentIdOf = new Map<string, AppStudentId>();
  for (const l of ours) {
    if (l.familyId !== null) familyIdOf.set(l.customerId, l.familyId);
    else if (l.studentId !== null) studentIdOf.set(l.customerId, l.studentId);
  }
  const whole = realmId === null ? EMPTY_PLAN : planAppRecords(await loadPlanInput(tx));
  const plan = one === undefined ? whole : planForOneFamily(whole, one.familyCustomerId);
  // A whole run's links are carried over from the roster, by nobody; one family's are confirmed by who asked.
  const linkedAs = one === undefined ? { origin: "carried_over" as const } : { origin: "confirmed" as const, linkedBy: one.linkedBy };
  // Narrowed to one family, nothing that exists is changed: only what is missing there is made.
  const changeExisting = one === undefined;
  // A new link starts aligned with its customer's version in the cache (`synced_token`, stage 3's slice 9e), as
  // migration 0041 filled every link: the customer staff confirmed, or the roster carried over. None for a customer the
  // cache doesn't hold. A link that exists keeps its version.
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

  return { changes, family: newFamilies[0]?.id ?? null, students: { made: newStudents.map((s) => ({ id: s.id, customerId: s.customerId })), leftAlone } };
}
