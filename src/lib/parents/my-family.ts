// Privacy: the one query a parent page reads its family through. It takes the session's ParentCtx and nothing else,
// reads only the rows of that family, and returns that family alone. The family's name and students are the app's own
// records (ctx.familyId, src/lib/families/session-family.ts), with no link and no roster cache; only the person's own
// QuickBooks record (`me`, and the record the parent's two writes change) is still read from the roster cache, through
// the family's own link and the guardian row's source. It never imports the staff-only modules
// (src/lib/roster/queries.ts, the staff functions of ./directory.ts): tests/integration/page-guards.test.ts scans this file.
import "server-only";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { guardian, jobRun, qboConnection, qboCustomer, qboCustomerType } from "@/lib/db/schema";
import type { ParentCtx } from "@/lib/guards";
import { getShape, missingTypes } from "@/lib/roster/shape";
import { ROSTER_JOB, getRosterSource } from "@/lib/roster/source";
import type { AppStudentId } from "@/lib/families/ids";
import { customerOfFamily } from "@/lib/families/links";
import { sessionFamily } from "@/lib/families/session-family";
import { recordNameWords } from "@/lib/families/words";

/**
 * One of the family's active students: the app's own record, and its name in words. A page keys and matches a student
 * by `id`, never by name.
 */
export type MyStudent = { id: AppStudentId; name: string };
/** A contact record as QuickBooks has it. The email field is shown as written there; it can hold more than one address. */
export type MyContact = {
  name: string; email: string | null; phone: string | null;
  /**
   * Set on a QuickBooks record whose phone and address the signed-in person may change from the portal
   * (./contact-edits.ts): "own" for a parent's own record, "family" for the family's record, which every parent of
   * that family signs in through and shares. Not set on details the portal made up from the sign-in itself.
   */
  edits?: "own" | "family";
};
export type MyFamily = {
  /** The family's name as its record holds it, in words when the portal knows none (in a flat club, the member's own name). */
  name: string;
  /** The family's active students, by name. Null when the membership shape lists no students: the page says nothing rather than guess. */
  students: MyStudent[] | null;
  /** The signed-in person's own QuickBooks record, when their sign-in came from one in this family; otherwise null. */
  me: MyContact | null;
  /** When the roster was last read from QuickBooks successfully. */
  rosterReadAt: string | null;
};
/**
 * The signed-in person's own QuickBooks record, for the code that reads and changes it in QuickBooks
 * (./contact-edits.ts). The id is for the server only: it is never given to a page or a client component.
 */
export type MyRecord = {
  qboId: string; parentQboId: string | null; contact: MyContact & { edits: "own" | "family" };
  /**
   * Which of the addresses in the record's email field are the person's through it: the first alone on a
   * parent's or a flat member's record; every one on a family's record in a club with no parent type.
   */
  signsInBy: "first" | "every";
  /**
   * The customer types the record may have and be this person's, by the membership shape: the parent type for a
   * parent's own record, the family type for a family's, any of the member types for a flat member's.
   */
  typeQboIds: readonly string[];
};

type Row = { qboId: string; displayName: string; active: boolean; parentQboId: string | null; typeQboId: string | null; email: string | null; phone: string | null };
type Mine = { row: Row } & Pick<MyRecord, "signsInBy" | "typeQboIds">;

const contact = (r: Row, edits: "own" | "family"): MyContact & { edits: "own" | "family" } => ({ name: r.displayName, email: r.email, phone: r.phone, edits });

/**
 * The signed-in parent's family, or null when its record is not active: the page says the club hasn't finished
 * setting the family up, whatever the reason. Its name and its active students are the app's own records, read by
 * ctx.familyId alone. Students are listed only while the membership shape says who is a student (a layered shape with
 * a student type); otherwise `students` is null.
 *
 * `me` is the person's own QuickBooks record as the roster cache holds it, with the same safety checks as the staff
 * roster (loadRosterPage), narrowly: while QuickBooks is connected, a cache read from another company, or one that
 * doesn't say which, gives none; so does a membership shape that is missing or names a customer type QuickBooks no
 * longer has, and a family with no link to its customer, or one the cache doesn't hold active as a family. Only the
 * family's own customer and its direct sub-customers are read. Inactive records are left out.
 */
export async function loadMyFamily(ctx: ParentCtx): Promise<MyFamily | null> {
  return (await read(ctx))?.family ?? null;
}

/**
 * The record `me` was read from, by the same rules and from the session alone: null when loadMyFamily() shows no
 * family, or shows one with no `me` (a sign-in made by hand, or a link that names a record that isn't theirs).
 */
export async function loadMyRecord(ctx: ParentCtx): Promise<MyRecord | null> {
  const got = await read(ctx);
  const edits = got?.family.me?.edits;
  if (!got?.mine || !got.family.me || !edits) return null;
  return { qboId: got.mine.row.qboId, parentQboId: got.mine.row.parentQboId, contact: { ...got.family.me, edits }, signsInBy: got.mine.signsInBy, typeQboIds: got.mine.typeQboIds };
}

async function read(ctx: ParentCtx): Promise<{ family: MyFamily; mine: Mine | null } | null> {
  const [records, shape, [lastOk]] = await Promise.all([
    sessionFamily(ctx.familyId),
    getShape(),
    db.select({ finishedAt: jobRun.finishedAt }).from(jobRun).where(and(eq(jobRun.job, ROSTER_JOB), eq(jobRun.outcome, "ok"))).orderBy(desc(jobRun.id)).limit(1),
  ]);
  if (records === null) return null;
  const rosterReadAt = lastOk?.finishedAt?.toISOString() ?? null;
  const students = shape?.kind === "layered" && shape.studentTypeId !== null ? records.students.map((s) => ({ id: s.id, name: s.name })) : null;
  const own = await myOwnRecord(ctx, shape);
  return { family: { name: recordNameWords(records.name, "family"), students, me: own?.contact ?? null, rosterReadAt }, mine: own?.mine ?? null };
}

type Shape = NonNullable<Awaited<ReturnType<typeof getShape>>>;

/**
 * The person's own QuickBooks record in this family, from the roster cache: found through the family's own link (its
 * customer, in the records' company) and the source of the guardian row the session chose, by the rules loadMyFamily()
 * gives. Null whenever any of it doesn't hold.
 */
async function myOwnRecord(ctx: ParentCtx, shape: Shape | null): Promise<{ contact: MyContact & { edits: "own" | "family" }; mine: Mine } | null> {
  if (!shape) return null;
  const familyId = await customerOfFamily(ctx.familyId);
  if (familyId === null) return null;
  const [[conn], source, types, rows, [link]] = await Promise.all([
    // "Connected" as connectionView() means it, without loading the tokens.
    db.select({ realmId: qboConnection.realmId, hasRefreshToken: sql<boolean>`${qboConnection.refreshTokenCiphertext} is not null` }).from(qboConnection),
    getRosterSource(),
    db.select({ qboId: qboCustomerType.qboId, name: qboCustomerType.name, active: qboCustomerType.active }).from(qboCustomerType),
    db.select({ qboId: qboCustomer.qboId, displayName: qboCustomer.displayName, active: qboCustomer.active, parentQboId: qboCustomer.parentQboId,
      typeQboId: qboCustomer.typeQboId, email: qboCustomer.email, phone: qboCustomer.phone })
      .from(qboCustomer).where(or(eq(qboCustomer.qboId, familyId), eq(qboCustomer.parentQboId, familyId))),
    // The session's own row, and only if it is this person's row in this family, of that same customer.
    db.select({ sourceQboId: guardian.sourceQboId }).from(guardian)
      .where(and(eq(guardian.id, ctx.guardianId), eq(guardian.parentId, ctx.parentId), eq(guardian.familyId, ctx.familyId), eq(guardian.familyQboId, familyId))),
  ]);

  const connected = Boolean(conn?.realmId && conn.hasRefreshToken);
  if (connected && source !== conn!.realmId) return null;
  if (missingTypes(shape, types).length) return null;

  // By its ID, never by position: the rows come back in no order.
  const family = rows.find((r) => r.qboId === familyId);
  if (!family || !family.active) return null;
  const sourceId = link?.sourceQboId ?? null;
  if (sourceId === null) return null;

  if (shape.kind === "flat") {
    // The member is its own family: its own record and nothing under it.
    if (family.typeQboId === null || !shape.memberTypeIds.includes(family.typeQboId)) return null;
    // Every address on a member's record signs in through it, so its details are shared like a family's.
    return sourceId === familyId ? { contact: contact(family, "family"), mine: { row: family, signsInBy: "first", typeQboIds: shape.memberTypeIds } } : null;
  }

  if (family.typeQboId !== shape.familyTypeId) return null;
  const under = rows.filter((r) => r.parentQboId === familyId && r.active && r.typeQboId !== shape.familyTypeId);
  // The record a guardian row came from (its `source_qbo_id`): a parent directly under the family, or, when
  // QuickBooks has no parent type, the family customer itself. A link that names anything else is ignored.
  const mine = shape.parentTypeId === null ? (sourceId === familyId ? family : undefined)
    : under.find((r) => r.qboId === sourceId && r.typeQboId === shape.parentTypeId);
  if (!mine) return null;
  return { contact: contact(mine, shape.parentTypeId === null ? "family" : "own"),
    mine: shape.parentTypeId === null ? { row: mine, signsInBy: "every", typeQboIds: [shape.familyTypeId] } : { row: mine, signsInBy: "first", typeQboIds: [shape.parentTypeId] } };
}
