// Staff roster writes in tests (src/lib/roster/writes.ts, queue.ts): a company connected through the QuickBooks stub,
// its roster read and its shape chosen, and staff members holding exactly the permissions a test names.
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, role, roleAssignment, roleRule, writeQueue, type RosterWrite } from "@/lib/db/schema";
import { refreshRoster } from "@/lib/roster/refresh";
import { saveShape, type MembershipShape } from "@/lib/roster/shape";
import { currentRosterTag } from "@/lib/seasons/roster-lock";
import { getRosterSource } from "@/lib/roster/source";
import { customerOfFamily } from "@/lib/families/links";
import type { AppFamilyId } from "@/lib/families/ids";
import { familyRecord, studentRecord } from "./volunteer";
import { seedStaff } from "./db";
import { fznCompany, FZN_SHAPE, seedConnected, type QboStub } from "./qbo-stub";

export const WORKER = { startedBy: "worker", actor: { door: "system" as const, id: null, label: "worker" }, ip: null };
export const REALM = "9130000000000001";

/**
 * The stub holds an FZN-shaped company (fznCompany(), unless `company` is given), QuickBooks is connected to it, the
 * shape is saved and the roster read once. Returns the roster tag a page would carry.
 */
export async function connectRoster(stub: QboStub, o: { shape?: MembershipShape; company?: ReturnType<typeof fznCompany>; accessExpiresInMs?: number } = {}): Promise<string> {
  Object.assign(stub, o.company ?? fznCompany());
  await seedConnected(stub, { realmId: REALM, accessExpiresInMs: o.accessExpiresInMs });
  await saveShape(o.shape ?? FZN_SHAPE, { actor: WORKER.actor, ip: null });
  const r = await refreshRoster(WORKER);
  if (!r.ok) throw new Error(`the roster couldn't be read from the stub: ${r.reason}`);
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
 * is filed under is given by customer (`familyQboId`; by default a create's family, or the family or member itself, as prepare() in
 * src/lib/roster/writes.ts files them), and a student's change names its student: each stored as the app's record of
 * that kind (familyRecord(), studentRecord()), as the writer stores it. An item of a company other than the roster's
 * names no record, as migration 0034 leaves one.
 */
export async function seedQueued(w: RosterWrite, o: { sent?: boolean; state?: "waiting" | "stuck" | "done" | "given_up"; tries?: number; createdAt?: Date; lastTriedAt?: Date;
  nextTryAt?: Date | null; familyQboId?: string | null; code?: string; finishedAt?: Date | null; realmId?: string } = {}) {
  const now = new Date();
  const realmId = o.realmId ?? REALM;
  const ours = realmId === (await getRosterSource());
  const familyQboId = o.familyQboId !== undefined ? o.familyQboId : w.op === "create" ? w.familyQboId : w.role === "member" || w.role === "family" ? w.qboId : null;
  const familyId = ours && familyQboId !== null ? await familyRecord(familyQboId) : null;
  const studentId = ours && w.op !== "create" && w.role === "student" ? await studentRecord(w.qboId) : null;
  const [item] = await db.insert(writeQueue).values({
    realmId, request: w, targetQboId: w.op === "create" ? null : w.qboId, familyId, studentId,
    state: o.state ?? "waiting", sent: o.sent ?? false, tries: o.tries ?? 1, lastCode: o.code ?? "token_busy", createdAt: o.createdAt ?? now, lastTriedAt: o.lastTriedAt ?? o.createdAt ?? now,
    nextTryAt: o.nextTryAt === undefined ? now : o.nextTryAt, askedByLabel: "registrar@club.org", finishedAt: o.finishedAt ?? null,
  }).returning();
  return item!;
}

/** The customer of the family record a queue item is filed under, through its link, or null: how a test reads the item's family. */
export async function queuedFamilyQboId(item: { familyId: AppFamilyId | null }): Promise<string | null> {
  return item.familyId === null ? null : customerOfFamily(item.familyId);
}

export const queueItem = async (id: string) => (await db.select().from(writeQueue).where(eq(writeQueue.id, id)))[0];
export const auditsOf = async (action: string) => (await db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(desc(auditLog.id)));
