// The app's own families, students and links in tests (stage 1 of the app-owned families spec): the one function that
// keeps them in step, run as the portal runs it, and ways to read them back by the customers they are linked to.
import { and, asc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, family, guardian, student } from "@/lib/db/schema";
import { keepAppRecordsInStep } from "@/lib/families/in-step";
import { noAppRecordChanges, type AppRecordChanges } from "@/lib/families/changes";
import { QUICKBOOKS, type AppFamilyId, type AppStudentId } from "@/lib/families/ids";
import { getRosterSource } from "@/lib/roster/source";

/** Runs keepAppRecordsInStep() in its own transaction, as the roster read does inside its own. */
export const syncAppRecords = (): Promise<AppRecordChanges> => db.transaction((tx) => keepAppRecordsInStep(tx));

/** What a run that finds the records in step returns. */
export const NO_CHANGES: AppRecordChanges = noAppRecordChanges();

class RolledBack extends Error {}

/**
 * What a run of keepAppRecordsInStep() would change now, worked out and rolled back: NO_CHANGES when the records are
 * in step. The one definition of "in step" is that function, so this is how a test asks whether they are.
 */
export async function whatAFreshRunWouldChange(): Promise<AppRecordChanges> {
  const out: { changes?: AppRecordChanges } = {};
  try {
    await db.transaction(async (tx) => { out.changes = await keepAppRecordsInStep(tx); throw new RolledBack(); });
  } catch (e) {
    if (!(e instanceof RolledBack)) throw e;
  }
  return out.changes!;
}

/**
 * The app's own record of a customer, of one kind, in the company the roster was read from: the one its link of that
 * kind names. One the records don't hold yet (a customer the roster no longer holds, which a season record names) is
 * made inactive with its link, as migration 0023 made one, named by nobody: so a test can seed a season record of a
 * customer that has left the roster. Throws while the roster names no company: there are no records then.
 */
export async function recordOfCustomer(customerId: string, kind: "family"): Promise<AppFamilyId>;
export async function recordOfCustomer(customerId: string, kind: "student"): Promise<AppStudentId>;
export async function recordOfCustomer(customerId: string, kind: "family" | "student"): Promise<AppFamilyId | AppStudentId>;
export async function recordOfCustomer(customerId: string, kind: "family" | "student"): Promise<AppFamilyId | AppStudentId> {
  const realmId = await getRosterSource();
  if (realmId === null) throw new Error(`recordOfCustomer(${customerId}): the roster names no company, so there are no app records to name. Seed a roster read first (seedRosterRead(), seedFamilyMoney() or setRosterSource()).`);
  const [l] = await db.select().from(accountingLink).where(and(eq(accountingLink.system, QUICKBOOKS), eq(accountingLink.realmId, realmId), eq(accountingLink.customerId, customerId),
    isNotNull(kind === "family" ? accountingLink.familyId : accountingLink.studentId)));
  if (l) return (kind === "family" ? l.familyId : l.studentId)!;
  if (kind === "family") {
    const [f] = await db.insert(family).values({ name: null, active: false }).returning({ id: family.id });
    await db.insert(accountingLink).values({ system: QUICKBOOKS, realmId, customerId, familyId: f!.id, origin: "carried_over" });
    return f!.id;
  }
  const [s] = await db.insert(student).values({ name: null, active: false }).returning({ id: student.id });
  await db.insert(accountingLink).values({ system: QUICKBOOKS, realmId, customerId, studentId: s!.id, origin: "carried_over" });
  return s!.id;
}

/** The columns a season row (a chosen list's entry, a tick or waiver) names a customer's app record by, for a requirement of this kind. */
export async function subjectColumns(customerId: string, kind: "family" | "student"): Promise<{ familyId: AppFamilyId; studentId: null } | { familyId: null; studentId: AppStudentId }> {
  return kind === "family" ? { familyId: await recordOfCustomer(customerId, "family"), studentId: null } : { familyId: null, studentId: await recordOfCustomer(customerId, "student") };
}

/** By code unit, so the order is the same on every machine: "F-1" before "F1" before "F2". */
const byText = (a: string | null, b: string | null) => ((a ?? "") < (b ?? "") ? -1 : (a ?? "") > (b ?? "") ? 1 : 0);

/**
 * The app's records as the customers they are linked to name them, with no uuid but a guardian row's: two runs that
 * made different ids read the same. A record or a family named by no link reads as "(no link)".
 */
export async function appRecordsByCustomer() {
  const links = await db.select().from(accountingLink);
  const customerOf = new Map<string, string>();
  for (const l of links) if (l.familyId !== null) customerOf.set(`f:${String(l.familyId)}`, l.customerId);
  for (const l of links) if (l.studentId !== null) customerOf.set(`s:${String(l.studentId)}`, l.customerId);
  const ofFamily = (id: unknown) => (id === null ? null : customerOf.get(`f:${String(id)}`) ?? "(no link)");
  const families = (await db.select().from(family)).map((f) => ({ customer: ofFamily(f.id), name: f.name, active: f.active }))
    .sort((a, b) => byText(a.customer, b.customer));
  const students = (await db.select().from(student)).map((s) => ({ customer: customerOf.get(`s:${String(s.id)}`) ?? "(no link)", name: s.name, active: s.active, family: ofFamily(s.familyId) }))
    .sort((a, b) => byText(a.customer, b.customer));
  const memberships = (await db.select({ id: guardian.id, familyId: guardian.familyId }).from(guardian).orderBy(asc(guardian.id)))
    .map((g) => ({ guardianId: g.id, family: ofFamily(g.familyId) }));
  const linked = links.map((l) => ({ system: l.system, realmId: l.realmId, customer: l.customerId,
    kind: l.familyId !== null ? "family" : l.studentId !== null ? "student" : "membership", guardianId: l.guardianId, origin: l.origin, linkedBy: l.linkedBy }))
    .sort((a, b) => byText(a.customer, b.customer) || byText(a.kind, b.kind) || byText(a.guardianId, b.guardianId));
  return { families, students, memberships, links: linked };
}

/** Each family and student record's id by its kind and customer ("family:10", "student:12"): to prove an id is kept. */
export async function recordIds(): Promise<Record<string, string>> {
  return Object.fromEntries((await db.select().from(accountingLink)).filter((l) => l.guardianId === null)
    .map((l) => [l.familyId !== null ? `family:${l.customerId}` : `student:${l.customerId}`, String(l.familyId ?? l.studentId)]));
}

/** Every row of the three tables and each guardian row's family, ids and times and all: for "nothing changed". */
export async function appRecordRows() {
  return {
    families: await db.select().from(family).orderBy(asc(family.id)),
    students: await db.select().from(student).orderBy(asc(student.id)),
    links: await db.select().from(accountingLink).orderBy(asc(accountingLink.id)),
    memberships: await db.select({ id: guardian.id, familyId: guardian.familyId }).from(guardian).orderBy(asc(guardian.id)),
  };
}
