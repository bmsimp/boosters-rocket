// Privacy: the one query a parent page reads its family through. It takes the session's ParentCtx and nothing else,
// reads only the rows of that family, and returns that family alone. It never imports the staff-only modules
// (src/lib/roster/queries.ts, the staff functions of ./directory.ts): tests/integration/page-guards.test.ts scans this file.
import "server-only";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { guardian, jobRun, qboConnection, qboCustomer, qboCustomerType } from "@/lib/db/schema";
import type { ParentCtx } from "@/lib/guards";
import { getShape, missingTypes } from "@/lib/roster/shape";
import { ROSTER_JOB, getRosterSource } from "@/lib/roster/source";

export type MyStudent = { qboId: string; name: string };
/** A contact record as QuickBooks has it. The email field is shown as written there; it can hold more than one address. */
export type MyContact = { name: string; email: string | null; phone: string | null };
export type MyFamily = {
  /** The family's name in QuickBooks (in a flat club, the member's own name). */
  name: string;
  /** The family's active students, by name. Null when QuickBooks doesn't say who is a student: the page says nothing rather than guess. */
  students: MyStudent[] | null;
  /** The signed-in person's own QuickBooks record, when their sign-in came from one in this family; otherwise null. */
  me: MyContact | null;
  /** When the roster was last read from QuickBooks successfully. */
  rosterReadAt: string | null;
};

type Row = { qboId: string; displayName: string; active: boolean; parentQboId: string | null; typeQboId: string | null; email: string | null; phone: string | null };

// The order the staff roster lists people in (src/lib/roster/model.ts).
const byName = (a: Row, b: Row) => a.displayName.localeCompare(b.displayName, "en", { sensitivity: "base" }) || a.qboId.localeCompare(b.qboId, "en", { numeric: true });
const contact = (r: Row): MyContact => ({ name: r.displayName, email: r.email, phone: r.phone });

/**
 * The signed-in parent's family from the roster cache, or null when there is nothing the portal may show for it.
 *
 * It makes the same safety checks as the staff roster (loadRosterPage), narrowly. While QuickBooks is connected, a
 * cache read from another company, or one that doesn't say which, shows nothing. A membership shape that is missing,
 * or names a customer type QuickBooks no longer has, shows nothing. Disconnected, the last roster is still shown.
 * A family that isn't in the cache, is inactive, or isn't what the shape calls a family (a sign-in made by hand can
 * name any ID) is null too: the page says the club hasn't finished setting the family up, whatever the reason.
 *
 * Only the family's own customer and its direct sub-customers are read. A sub-customer with the family type is another
 * family and is never shown. Inactive records are left out: QuickBooks renames them with " (deleted)".
 */
export async function loadMyFamily(ctx: ParentCtx): Promise<MyFamily | null> {
  const familyId = ctx.familyQboId;
  const [[conn], source, shape, types, rows, [link], [lastOk]] = await Promise.all([
    // "Connected" as connectionView() means it, without loading the tokens.
    db.select({ realmId: qboConnection.realmId, hasRefreshToken: sql<boolean>`${qboConnection.refreshTokenCiphertext} is not null` }).from(qboConnection),
    getRosterSource(),
    getShape(),
    db.select({ qboId: qboCustomerType.qboId, name: qboCustomerType.name, active: qboCustomerType.active }).from(qboCustomerType),
    db.select({ qboId: qboCustomer.qboId, displayName: qboCustomer.displayName, active: qboCustomer.active, parentQboId: qboCustomer.parentQboId,
      typeQboId: qboCustomer.typeQboId, email: qboCustomer.email, phone: qboCustomer.phone })
      .from(qboCustomer).where(or(eq(qboCustomer.qboId, familyId), eq(qboCustomer.parentQboId, familyId))),
    // The session's own link, and only if it is this person's link to this family.
    db.select({ sourceQboId: guardian.sourceQboId }).from(guardian)
      .where(and(eq(guardian.id, ctx.guardianId), eq(guardian.parentId, ctx.parentId), eq(guardian.familyQboId, familyId))),
    db.select({ finishedAt: jobRun.finishedAt }).from(jobRun).where(and(eq(jobRun.job, ROSTER_JOB), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1),
  ]);

  const connected = Boolean(conn?.realmId && conn.hasRefreshToken);
  if (connected && source !== conn!.realmId) return null;
  if (!shape || missingTypes(shape, types).length) return null;

  // By its ID, never by position: the rows come back in no order.
  const family = rows.find((r) => r.qboId === familyId);
  if (!family || !family.active) return null;
  const sourceId = link?.sourceQboId ?? null;
  const rosterReadAt = lastOk?.finishedAt?.toISOString() ?? null;

  if (shape.kind === "flat") {
    // The member is its own family: its own record and nothing under it.
    if (family.typeQboId === null || !shape.memberTypeIds.includes(family.typeQboId)) return null;
    return { name: family.displayName, students: null, me: sourceId === familyId ? contact(family) : null, rosterReadAt };
  }

  if (family.typeQboId !== shape.familyTypeId) return null;
  const under = rows.filter((r) => r.parentQboId === familyId && r.active && r.typeQboId !== shape.familyTypeId);
  const students = shape.studentTypeId === null ? null
    : under.filter((r) => r.typeQboId === shape.studentTypeId).sort(byName).map((r) => ({ qboId: r.qboId, name: r.displayName }));
  // The record a sign-in comes from (src/lib/parents/access-rules.ts): a parent directly under the family, or, when
  // QuickBooks has no parent type, the family customer itself. A link that names anything else is ignored.
  const mine = sourceId === null ? undefined
    : shape.parentTypeId === null ? (sourceId === familyId ? family : undefined)
    : under.find((r) => r.qboId === sourceId && r.typeQboId === shape.parentTypeId);
  return { name: family.displayName, students, me: mine ? contact(mine) : null, rosterReadAt };
}
