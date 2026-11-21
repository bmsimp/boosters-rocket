// Staff roster writes in tests (src/lib/roster/writes.ts, queue.ts): a company connected through the QuickBooks stub,
// its roster read and its shape chosen, and staff members holding exactly the permissions a test names.
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, qboCustomer, role, roleAssignment, roleRule, writeQueue, type RosterWrite } from "@/lib/db/schema";
import { refreshRoster } from "@/lib/roster/refresh";
import { saveShape, type MembershipShape } from "@/lib/roster/shape";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { getRosterSource } from "@/lib/roster/source";
import { customerOfFamily } from "@/lib/families/links";
import type { AppFamilyId } from "@/lib/families/ids";
import { familyRecord, studentRecord } from "./volunteer";
import { seedGuardian, seedParent, seedStaff } from "./db";
import { syncAppRecords } from "./app-records";
import { fznCompany, FZN_SHAPE, seedConnected, type QboStub } from "./qbo-stub";

export const WORKER = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
export const REALM = "9130000000000001";

/**
 * Ana Rivera as the portal holds her, beside fznCompany()'s parent record of hers (customer 11, under the Rivera
 * Family, 10): the person, her sign-in account and an invited guardian row in that family from that record, written
 * directly (since stage 3 of the app-owned families spec nothing makes a sign-in from QuickBooks). Seeded after the
 * roster read (connectRoster()), her row is in the Rivera family's record and linked to customer 11, as seedGuardian()
 * writes them, with no import. A roster read made after it changes neither.
 */
export async function seedAnaRivera(o: { status?: "invited" | "active" } = {}) {
  const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
  const row = await seedGuardian({ parentId: ana.id, familyQboId: "10", sourceQboId: "11", status: o.status ?? "invited" });
  return { ana, row };
}

/**
 * The stub holds an FZN-shaped company (fznCompany(), unless `company` is given), QuickBooks is connected to it, the
 * shape is saved and the roster read once, and the app's own records are imported from that read (syncAppRecords()):
 * since stage 3's slice 9c a read makes no record, so this stands for a club whose records migration 0023 made from
 * the same roster. Returns the roster tag a page would carry.
 */
export async function connectRoster(stub: QboStub, o: { shape?: MembershipShape; company?: ReturnType<typeof fznCompany>; accessExpiresInMs?: number } = {}): Promise<string> {
  Object.assign(stub, o.company ?? fznCompany());
  await seedConnected(stub, { realmId: REALM, accessExpiresInMs: o.accessExpiresInMs });
  await saveShape(o.shape ?? FZN_SHAPE, { actor: WORKER.actor, ip: null });
  const r = await refreshRoster(WORKER);
  if (!r.ok) throw new Error(`the roster couldn't be read from the stub: ${r.reason}`);
  await syncAppRecords();
  return currentRosterTag();
}

/** A staff member whose one role holds exactly these patterns (`[]`: signed in, with no permission at all). */
export async function staffWith(email: string, patterns: string[]) {
  const s = await seedStaff({ email, name: email.split("@")[0] });
  if (patterns.length) {
    const [r] = await db.insert(role).values({ key: `r-${email.split("@")[0]}`, name: email }).returning();
    await db.insert(roleRule).values(patterns.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  }
  return s;
}

/** How a write module call is made by a staff member, as the actions make it. */
export const asOp = (staff: { id: string; email: string }) => ({ actor: { door: "staff" as const, id: staff.id, label: staff.email }, ip: "203.0.113.9",
  permission: "Roster.Family.ReadWrite", staffUserId: staff.id });

/**
 * A queue item put straight into the table, as a staff write that QuickBooks didn't take would leave it. The family it
 * is filed under is given by customer (`familyQboId`; by default as prepare() in src/lib/roster/writes.ts files it: a
 * create's family, the family or member itself, the family a student is moved from, and for any other change of a
 * student or parent the family the cache holds it under, none for one under no family), and a student's change names its student: each stored as the app's record of
 * that kind (familyRecord(), studentRecord()), as the writer stores it. An item of a company other than the roster's
 * names no record, as migration 0034 leaves one.
 */
export async function seedQueued(w: RosterWrite, o: { sent?: boolean; state?: "waiting" | "stuck" | "done" | "given_up" | "refused"; tries?: number; createdAt?: Date; lastTriedAt?: Date;
  nextTryAt?: Date | null; familyQboId?: string | null; code?: string; finishedAt?: Date | null; realmId?: string; familyId?: AppFamilyId } = {}) {
  const now = new Date();
  const realmId = o.realmId ?? REALM;
  const ours = realmId === (await getRosterSource());
  const familyQboId = o.familyQboId !== undefined ? o.familyQboId
    : w.op === "create" ? w.familyQboId
    : w.role === "member" || w.role === "family" ? w.qboId
    : w.op === "move" ? w.fromFamilyQboId
    : ours ? await familyInCache(w.qboId) : null;
  // `familyId`: the record itself, for a family's create filed under the record saved first (stage 3's slice 9d).
  const familyId = o.familyId ?? (ours && familyQboId !== null ? await familyRecord(familyQboId) : null);
  const studentId = ours && w.op !== "create" && w.role === "student" ? await studentRecord(w.qboId) : null;
  const [item] = await db.insert(writeQueue).values({
    realmId, request: w, targetQboId: w.op === "create" ? null : w.qboId, familyId, studentId,
    state: o.state ?? "waiting", sent: o.sent ?? false, tries: o.tries ?? 1, lastCode: o.code ?? "token_busy", createdAt: o.createdAt ?? now, lastTriedAt: o.lastTriedAt ?? o.createdAt ?? now,
    nextTryAt: o.nextTryAt === undefined ? now : o.nextTryAt, askedByLabel: "registrar@club.org", finishedAt: o.finishedAt ?? null,
  }).returning();
  return item!;
}

/** The customer the roster cache holds this one directly under, or null. */
async function familyInCache(qboId: string): Promise<string | null> {
  const [c] = await db.select({ parent: qboCustomer.parentQboId }).from(qboCustomer).where(eq(qboCustomer.qboId, qboId));
  return c?.parent ?? null;
}

/** The customer of the family record a queue item is filed under, through its link, or null: how a test reads the item's family. */
export async function queuedFamilyQboId(item: { familyId: AppFamilyId | null }): Promise<string | null> {
  return item.familyId === null ? null : customerOfFamily(item.familyId);
}

export const queueItem = async (id: string) => (await db.select().from(writeQueue).where(eq(writeQueue.id, id)))[0];
export const auditsOf = async (action: string) => (await db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.id)));
