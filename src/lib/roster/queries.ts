import { eq, desc, and, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { qboCustomer, qboCustomerType, jobRun, guardian, parent, family, student } from "@/lib/db/schema";
import { connectionView, getConnection } from "@/lib/quickbooks/connection";
import { getShape, missingTypes, describeShape, type MembershipShape, type TypeRow } from "./shape";
import { buildRoster, type Cust, type Roster } from "./model";
import { needsAttention, type AttentionItem, type SignIn } from "./attention";
import { ROSTER_JOB, getRosterSource } from "./source";
import { linksOf } from "@/lib/families/links";
import type { AppFamilyId, AppStudentId } from "@/lib/families/ids";
import { recordNameWords } from "@/lib/families/words";

export type RosterPage = {
  connected: boolean; shape: MembershipShape | null; shapeWords: string | null; brokenTypes: string[]; roster: Roster | null;
  attention: AttentionItem[]; signIns: SignIn[]; types: TypeRow[];
  lastRun: { at: string; ok: boolean; detail: string | null } | null; lastOkAt: string | null;
};
export type ShapePreview = {
  families: number; students: number; parents: number; members: number; outside: number;
  samples: { families: string[]; students: string[]; parents: string[]; members: string[] };
};

const customers = async (): Promise<Cust[]> => (await db.select().from(qboCustomer)).map((c) =>
  ({ qboId: c.qboId, displayName: c.displayName, active: c.active, parentQboId: c.parentQboId, typeQboId: c.typeQboId, email: c.email, phone: c.phone }));
const types = async (): Promise<TypeRow[]> => (await db.select().from(qboCustomerType)).map((t) => ({ qboId: t.qboId, name: t.name, active: t.active }))
  .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
/**
 * Every portal sign-in by its membership's family (`guardian.family_id`), with the customer that family record is linked
 * to, looked up for all of them at once. Those from a previous company are left out: they belong to no family here.
 */
async function signIns(): Promise<SignIn[]> {
  const rows = await db.select({ guardianId: guardian.id, familyId: guardian.familyId, name: parent.name, email: parent.email, status: guardian.status })
    .from(guardian).innerJoin(parent, eq(guardian.parentId, parent.id)).where(sql`${guardian.disabledReason} is distinct from 'company_changed'`);
  const families = [...new Set(rows.flatMap((r) => (r.familyId === null ? [] : [r.familyId])))];
  const links = await linksOf({ families, students: [] });
  return rows.map((r) => ({ ...r, customerQboId: r.familyId === null ? null : links.customerOfFamily.get(r.familyId) ?? null }));
}

/**
 * Everything the roster pages and the settings view show. A broken shape gives no roster rather than a wrong one (spec §1
 * Rules). While connected, a cache read from another company (or one that doesn't say which) is treated as not read
 * yet: none of it, nor that company's run history, is shown under the connected company's name. Disconnected, the last
 * roster is still shown, marked no longer current.
 */
export async function loadRosterPage(): Promise<RosterPage> {
  const [conn, c, from, anyCustomer, shape, typeRows, people, [last], [lastOk]] = await Promise.all([
    connectionView(), getConnection(), getRosterSource(), db.select({ qboId: qboCustomer.qboId }).from(qboCustomer).limit(1), getShape(), types(), signIns(),
    db.select().from(jobRun).where(eq(jobRun.job, ROSTER_JOB)).orderBy(desc(jobRun.id)).limit(1),
    db.select().from(jobRun).where(and(eq(jobRun.job, ROSTER_JOB), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1),
  ]);
  const hasCache = typeRows.length > 0 || anyCustomer.length > 0;
  if (conn.connected && (from !== null ? from !== c?.realmId : hasCache)) {
    return { connected: true, shape: null, shapeWords: null, brokenTypes: [], roster: null, attention: [], signIns: people, types: [], lastRun: null, lastOkAt: null };
  }
  const brokenTypes = shape && lastOk ? missingTypes(shape, typeRows) : [];
  const roster = shape && !brokenTypes.length ? buildRoster(shape, await customers()) : null;
  // A cache that names no company has no family records yet (keepAppRecordsInStep() makes none until a read records
  // it), so no sign-in can be held to one: the two sign-in rules wait for that read, which the Families list says is
  // coming, rather than flag every open sign-in as attached to no family. QuickBooks' own tidy rules still run.
  const judged = from === null ? [] : people;
  return {
    connected: conn.connected, shape, shapeWords: shape ? describeShape(shape, typeRows) : null, brokenTypes, roster,
    attention: roster && shape ? needsAttention(roster, shape, judged) : [], signIns: people, types: typeRows,
    lastRun: last ? { at: (last.finishedAt ?? last.startedAt).toISOString(), ok: last.outcome === "ok", detail: last.detail } : null,
    lastOkAt: lastOk?.finishedAt?.toISOString() ?? null,
  };
}

/** What a shape would give, before it is saved: counts and the first three names in each role (spec §3 step 3). */
export async function previewShape(shape: MembershipShape): Promise<ShapePreview> {
  const r = buildRoster(shape, await customers());
  const first = (list: Cust[]) => list.slice(0, 3).map((c) => c.displayName);
  if (r.kind === "flat") return { families: 0, students: 0, parents: 0, members: r.members.length, outside: r.outside, samples: { families: [], students: [], parents: [], members: first(r.members) } };
  const students = r.families.flatMap((f) => f.students), parents = r.families.flatMap((f) => f.parents);
  return { families: r.families.length, students: students.length, parents: parents.length, members: 0, outside: r.outside,
    samples: { families: first(r.families.map((f) => f.customer)), students: first(students), parents: first(parents), members: [] } };
}

/**
 * A student as the app keeps it (`student`, by its `family_id`), with what QuickBooks holds for them: their customer
 * through the student link, as the roster lists it under the family's customer (`customer`; null when it has no link,
 * or the roster lists that customer elsewhere or not at all). Names are the record's (recordNameWords() when the
 * portal knows none).
 */
export type RecordStudent = { id: AppStudentId; name: string; active: boolean; customer: Cust | null };
/**
 * A family as the app keeps it (`family`), with what QuickBooks holds for it: its customer through the family link, as
 * the roster lists it as a family (a member, in flat books; `customer`, null when it has none, or the roster doesn't
 * list that customer as one), its students, and the Parent sub-customers the roster lists under that customer
 * (`parents`: QuickBooks' own, which have no record of their own; none without a customer). The write forms send
 * QuickBooks ids and versions, so only what has a `customer` can be changed from the page.
 */
export type RecordFamily = { id: AppFamilyId; name: string; active: boolean; customer: Cust | null; students: RecordStudent[]; parents: Cust[] };

const COLLATOR = new Intl.Collator("en", { sensitivity: "base" });
const numeric = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });
/** By name, as the roster has always listed them (case and accents ignored), then by QuickBooks ID as numbers, then by the record's own id. */
const byName = (a: { id: unknown; name: string; customer: Cust | null }, b: { id: unknown; name: string; customer: Cust | null }) =>
  COLLATOR.compare(a.name, b.name) || numeric(a.customer?.qboId ?? "", b.customer?.qboId ?? "") || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);

/**
 * The families the Families pages list, from the app's own records (stage 3 of the app-owned families spec): every
 * active family record, and an inactive one where the roster lists its customer as a family (a member, in flat
 * books), as the pages have always shown a family QuickBooks has made inactive; each with its student records, the
 * active ones and an inactive one where the roster lists its customer under the family's. What only QuickBooks holds
 * (each customer's id, version, type, active flag, email and phone, and the Parent sub-customers) is joined from the
 * page's roster, read once with the page: three queries in all, whatever the number of families. Null when the page
 * has no roster to show (no shape, a broken one, or another company's cache), as the pages show nothing then.
 * `only` narrows it to one family, for that family's page.
 */
export async function rosterFamilies(page: RosterPage, only?: AppFamilyId): Promise<RecordFamily[] | null> {
  const roster = page.roster;
  if (!roster) return null;
  const [families, students] = await Promise.all([
    db.select({ id: family.id, name: family.name, active: family.active }).from(family).where(only === undefined ? undefined : eq(family.id, only)),
    db.select({ id: student.id, familyId: student.familyId, name: student.name, active: student.active }).from(student)
      .where(only === undefined ? isNotNull(student.familyId) : eq(student.familyId, only)),
  ]);
  const links = await linksOf({ families: families.map((f) => f.id), students: students.map((s) => s.id) });
  // What the roster lists as a family, by customer: in flat books a member, with nobody under it.
  const listed = new Map<string, { customer: Cust; students: Cust[]; parents: Cust[] }>(roster.kind === "flat"
    ? roster.members.map((m) => [m.qboId, { customer: m, students: [], parents: [] }])
    : roster.families.map((f) => [f.customer.qboId, f]));
  const under = new Map<string, typeof students>();
  for (const s of students) if (s.familyId !== null) under.set(String(s.familyId), [...(under.get(String(s.familyId)) ?? []), s]);
  const out: RecordFamily[] = [];
  for (const f of families) {
    const customerId = links.customerOfFamily.get(f.id);
    const there = customerId === undefined ? undefined : listed.get(customerId);
    if (!f.active && !there) continue;
    const mine = (under.get(String(f.id)) ?? []).flatMap((s): RecordStudent[] => {
      const studentCustomer = links.customerOfStudent.get(s.id);
      const customer = studentCustomer === undefined ? undefined : there?.students.find((c) => c.qboId === studentCustomer);
      return !s.active && !customer ? [] : [{ id: s.id, name: recordNameWords(s.name, "student"), active: s.active, customer: customer ?? null }];
    });
    out.push({ id: f.id, name: recordNameWords(f.name, "family"), active: f.active, customer: there?.customer ?? null, students: mine.sort(byName), parents: there?.parents ?? [] });
  }
  return out.sort(byName);
}

/** One family's page: the family as rosterFamilies() lists it (`kind` "member" in flat books), with the sign-ins whose membership is in its record. */
export type RosterEntry = { kind: "family" | "member"; family: RecordFamily; signIns: SignIn[] };

/**
 * The roster entry a staff page's address names, by the app's own family id (stage 3 of the app-owned families spec;
 * checked by familyRecordAt() first), from a page already loaded: the family as the roster list shows it. Null when
 * the list doesn't show it: an inactive record whose customer the roster doesn't list as a family (a member, in flat
 * books), or a page with no roster.
 */
export async function familyEntry(page: RosterPage, familyId: AppFamilyId): Promise<RosterEntry | null> {
  const [found] = (await rosterFamilies(page, familyId)) ?? [];
  if (!found || !page.roster) return null;
  return { kind: page.roster.kind === "flat" ? "member" : "family", family: found, signIns: page.signIns.filter((s) => s.familyId === familyId) };
}

export async function rosterEntry(familyId: AppFamilyId): Promise<RosterEntry | null> {
  return familyEntry(await loadRosterPage(), familyId);
}
