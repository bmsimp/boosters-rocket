import { eq, desc, and } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { qboCustomer, qboCustomerType, jobRun, guardian, parent } from "@/lib/db/schema";
import { connectionView, getConnection } from "@/lib/quickbooks/connection";
import { getShape, missingTypes, describeShape, type MembershipShape, type TypeRow } from "./shape";
import { buildRoster, type Cust, type Family, type Roster } from "./model";
import { needsAttention, type AttentionItem, type SignIn } from "./attention";
import { ROSTER_JOB, getRosterSource } from "./source";

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
const signIns = async (): Promise<SignIn[]> => db.select({ guardianId: guardian.id, familyQboId: guardian.familyQboId, name: parent.name, email: parent.email, status: guardian.status })
  .from(guardian).innerJoin(parent, eq(guardian.parentId, parent.id));

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
  return {
    connected: conn.connected, shape, shapeWords: shape ? describeShape(shape, typeRows) : null, brokenTypes, roster,
    attention: roster && shape ? needsAttention(roster, shape, people) : [], signIns: people, types: typeRows,
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

export type RosterEntry = { kind: "family"; family: Family; signIns: SignIn[] } | { kind: "member"; member: Cust; signIns: SignIn[] };

/** One family (layered) or one member (flat) found in a page already loaded, with the portal sign-ins attached to its QuickBooks ID; null for anything else. */
export function entryFrom(page: RosterPage, qboId: string): RosterEntry | null {
  if (!page.roster) return null;
  const mine = page.signIns.filter((s) => s.familyQboId === qboId);
  if (page.roster.kind === "flat") {
    const member = page.roster.members.find((m) => m.qboId === qboId);
    return member ? { kind: "member", member, signIns: mine } : null;
  }
  const family = page.roster.families.find((f) => f.customer.qboId === qboId);
  return family ? { kind: "family", family, signIns: mine } : null;
}

export async function rosterEntry(qboId: string): Promise<RosterEntry | null> {
  return entryFrom(await loadRosterPage(), qboId);
}
