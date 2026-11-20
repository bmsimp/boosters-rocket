// Privacy: the one query a parent page reads its family through. It takes the session's ParentCtx and nothing else,
// reads only the rows of that family, and returns that family alone. The family's name and students are the app's own
// records (ctx.familyId, src/lib/families/session-family.ts), with no link and no roster cache, and so are the contact
// details a parent sees (`me`: the person's own, or the family's in books with no parent type; stage 3's slice 11a).
// Only the person's own QuickBooks record that the change of sign-in email writes (loadMyRecord()) is still read from
// the roster cache, through the family's own link and the guardian row's source. It never imports the staff-only
// modules (src/lib/roster/queries.ts, the staff functions of ./directory.ts): tests/integration/page-guards.test.ts
// scans this file.
import "server-only";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { family, guardian, parent, parentEmailChange, qboConnection, qboCustomer, qboCustomerType } from "@/lib/db/schema";
import type { ParentCtx } from "@/lib/guards";
import { getShape, missingTypes, type MembershipShape } from "@/lib/roster/shape";
import { getRosterSource } from "@/lib/roster/source";
import type { AppStudentId } from "@/lib/families/ids";
import { customerOfFamily } from "@/lib/families/links";
import { sessionFamily } from "@/lib/families/session-family";
import { recordNameWords } from "@/lib/families/words";
import type { ContactValues } from "./contact-fields";
import { fieldHasChange, fieldSignsIn } from "./email-field";

/**
 * One of the family's active students: the app's own record, and its name in words. A page keys and matches a student
 * by `id`, never by name.
 */
export type MyStudent = { id: AppStudentId; name: string };
/** A contact record: the name, the email and the phone. On a QuickBooks record the email field is shown as written there; it can hold more than one address. */
export type MyContact = {
  name: string; email: string | null; phone: string | null;
  /**
   * Whose phone and address the signed-in person may change from the portal (./contact-edits.ts): "own" for the
   * person's own, "family" for the family's, which every parent of that family shares (books with no parent type).
   */
  edits?: "own" | "family";
};
/** What a parent's pages show of their contact details: the person's name and sign-in address, and the phone they change. */
export type MyDetailsShown = MyContact & { email: string; edits: "own" | "family" };
export type MyFamily = {
  /** The family's name as its record holds it, in words when the portal knows none (in a flat club, the member's own name). */
  name: string;
  /** The family's active students, by name. Null when the membership shape lists no students: the page says nothing rather than guess. */
  students: MyStudent[] | null;
  /**
   * The signed-in person's name and sign-in address with the phone the portal holds for them: their own, or, in books
   * with no parent type, their family's (whoseDetails()). The portal's own records alone (stage 3's slice 11a): every
   * guardian the gate lets in has it, whether or not QuickBooks holds a record of them.
   */
  me: MyDetailsShown;
};
/**
 * The signed-in person's own QuickBooks record, for the code that changes their sign-in email in it
 * (./email-change.ts). The id is for the server only: it is never given to a page or a client component.
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

/**
 * Whose contact details a parent sees and changes (open question 6 of the app-owned families spec): the family's while
 * the stored membership shape says the club's books have no parent type (flat, or layered with no parent type), where
 * every guardian of the family shares one set; the person's otherwise, a missing shape included, one set whatever
 * families they are in. Pure.
 */
export function whoseDetails(shape: MembershipShape | null): "person" | "family" {
  return shape !== null && (shape.kind === "flat" || shape.parentTypeId === null) ? "family" : "person";
}

/** The contact details the portal holds for a person or a family, as its columns hold them. */
type DetailColumns = {
  phone: string | null; addressLine1: string | null; addressLine2: string | null; addressCity: string | null;
  addressRegion: string | null; addressPostalCode: string | null; addressCountry: string | null; contactVersion: number;
};
const DETAIL_COLUMNS = (t: typeof parent | typeof family) => ({
  phone: t.phone, addressLine1: t.addressLine1, addressLine2: t.addressLine2, addressCity: t.addressCity,
  addressRegion: t.addressRegion, addressPostalCode: t.addressPostalCode, addressCountry: t.addressCountry, contactVersion: t.contactVersion,
});
/** The columns as the form holds them: what isn't set is an empty string. */
const valuesOf = (r: DetailColumns): ContactValues => ({
  phone: r.phone ?? "", line1: r.addressLine1 ?? "", line2: r.addressLine2 ?? "", city: r.addressCity ?? "",
  region: r.addressRegion ?? "", postalCode: r.addressPostalCode ?? "", country: r.addressCountry ?? "",
});

/**
 * The contact details a parent sees and changes, from the portal's own records alone: whose they are (whoseDetails()),
 * the person's name and sign-in address, the values, and the version they were read at (`contact_version`). The
 * person's are read by ctx.parentId, the family's by ctx.familyId, each only while the family's record is active (null otherwise).
 * Nothing of the roster cache or QuickBooks is read. With `tx`, read inside that transaction (the save).
 */
export type MyDetails = { whose: "person" | "family"; name: string; email: string; values: ContactValues; version: number };
export async function readMyDetails(ctx: ParentCtx, shape: MembershipShape | null, tx?: Tx): Promise<MyDetails | null> {
  const q = tx ?? db;
  const whose = whoseDetails(shape);
  // The family's record is read either way: nothing is shown or changed from a session whose family isn't active.
  const [[person], [theFamily]] = await Promise.all([
    q.select({ name: parent.name, ...DETAIL_COLUMNS(parent) }).from(parent).where(eq(parent.id, ctx.parentId)),
    q.select(DETAIL_COLUMNS(family)).from(family).where(and(eq(family.id, ctx.familyId), eq(family.active, true))),
  ]);
  const held = whose === "family" ? theFamily : person;
  if (!person || !theFamily || !held) return null;
  return { whose, name: person.name, email: ctx.email, values: valuesOf(held), version: held.contactVersion };
}

/**
 * The signed-in parent's family, or null when its record is not active: the page says the club hasn't finished
 * setting the family up, whatever the reason. Its name and its active students are the app's own records, read by
 * ctx.familyId alone. Students are listed only while the membership shape says who is a student (a layered shape with
 * a student type); otherwise `students` is null.
 *
 * `me` is the person's name and sign-in address with the phone the portal holds (the person's own, or the family's in
 * books with no parent type): the portal's own records alone, for every guardian the gate let in. Neither the roster
 * cache nor QuickBooks decides what a parent sees here or may edit.
 */
export async function loadMyFamily(ctx: ParentCtx): Promise<MyFamily | null> {
  const [records, shape] = await Promise.all([sessionFamily(ctx.familyId), getShape()]);
  if (records === null) return null;
  const students = shape?.kind === "layered" && shape.studentTypeId !== null ? records.students.map((s) => ({ id: s.id, name: s.name })) : null;
  const details = await readMyDetails(ctx, shape);
  const edits = whoseDetails(shape) === "family" ? "family" : "own";
  const me: MyDetailsShown = { name: details?.name ?? ctx.name, email: ctx.email, phone: details?.values.phone || null, edits };
  return { name: recordNameWords(records.name, "family"), students, me };
}

/**
 * The person's own QuickBooks record that the change of sign-in email writes (./email-change.ts), by the rules
 * ownRecordIn() gives, from the session alone: null when the family's record is not active, or the person has no
 * record of their own here (a sign-in made by hand, or a link that names a record that isn't theirs).
 */
export async function loadMyRecord(ctx: ParentCtx): Promise<MyRecord | null> {
  return recordOf(ctx, "signs_in");
}

/**
 * For the change of sign-in email alone (./email-change.ts: the page a link opens, and the confirm), never for what a
 * parent is shown or may edit: the record loadMyRecord() gives, or else the one the person's own live email change
 * request was asked for, while its email field, as the roster cache holds it, reads as the change that request asks
 * for (heldByMyChange()). QuickBooks may have taken the change while the portal's side did not finish (an answer lost,
 * or the app's transaction failing), and a roster read since then has put the new address in the cache; this lets the
 * link find the record, see the change made, and finish the portal's side. The field alone can't say who put the
 * address there: staff can type the same address into QuickBooks, for this person or another. The person takes it as
 * their sign-in only by holding the link mailed to it, so the mailbox is the proof, as for any change; nothing else
 * of the record (its name, its phone, its other addresses) is shown to them through this.
 */
export async function loadMyRecordForMyEmailChange(ctx: ParentCtx): Promise<MyRecord | null> {
  return recordOf(ctx, "signs_in_or_my_live_change");
}

/** Which field makes a record the person's own: one that holds their sign-in address, or (the email change only) one that reads as their live change. */
type Holding = "signs_in" | "signs_in_or_my_live_change";

async function recordOf(ctx: ParentCtx, holding: Holding): Promise<MyRecord | null> {
  const [records, shape] = await Promise.all([sessionFamily(ctx.familyId), getShape()]);
  if (records === null) return null;
  const own = await myOwnRecord(ctx, shape, holding);
  if (!own) return null;
  return { qboId: own.mine.row.qboId, parentQboId: own.mine.row.parentQboId, contact: own.contact, signsInBy: own.mine.signsInBy, typeQboIds: own.mine.typeQboIds };
}

/** A customer of the roster cache as ownRecordIn() reads it. */
export type CachedRecord = { qboId: string; displayName: string; active: boolean; parentQboId: string | null; typeQboId: string | null; email: string | null; phone: string | null };
/** A guardian row's own QuickBooks record, by ownRecordIn()'s rule. */
export type OwnRecord<R extends CachedRecord> = {
  row: R;
  /** "own" for a parent's own record, "family" for a family's or a flat member's, which every guardian of it signs in through. */
  edits: "own" | "family";
  signsInBy: MyRecord["signsInBy"];
  typeQboIds: readonly string[];
  /** Whether its email field holds the person's sign-in address, by the record's own rule (fieldSignsIn()). */
  signsIn: boolean;
};

/**
 * The QuickBooks record a guardian row's sign-in comes from, by the membership shape, from the roster cache's rows of
 * the family's own linked customer and those directly under it (`rows`), and the row's `source_qbo_id`. Pure: the one
 * rule for whose record a cached customer is, read by myOwnRecord() (a parent's change of sign-in email) and by the
 * take-in of contact details (./contact-take-in.ts), so the two can't disagree.
 * - Flat: the member itself, of a member type, when the row's source is it.
 * - Layered: the family customer of the family type, active; and the row's source an active customer of the parent type
 *   directly under it, or, when the books have no parent type, the family customer itself.
 * Null whenever any of it doesn't hold. `signsIn` says whether the record's email field holds `email` by the record's
 * rule: the first address on a parent's own record or a flat member's, any of them on a family's with no parent type.
 * A record whose field doesn't hold it is not the person's; only the email change may still take it, by their own
 * live request (heldByMyChange()).
 */
export function ownRecordIn<R extends CachedRecord>(shape: MembershipShape, familyQboId: string, rows: readonly R[], sourceQboId: string | null, email: string): OwnRecord<R> | null {
  // By its ID, never by position: the rows come back in no order.
  const top = rows.find((r) => r.qboId === familyQboId);
  if (!top || !top.active) return null;
  if (sourceQboId === null) return null;

  if (shape.kind === "flat") {
    // The member is its own family: its own record and nothing under it.
    if (top.typeQboId === null || !shape.memberTypeIds.includes(top.typeQboId)) return null;
    if (sourceQboId !== familyQboId) return null;
    // Every address on a member's record signs in through it, so its details are shared like a family's.
    return { row: top, edits: "family", signsInBy: "first", typeQboIds: shape.memberTypeIds, signsIn: fieldSignsIn(top.email, email, "first") };
  }

  if (top.typeQboId !== shape.familyTypeId) return null;
  // The record a guardian row came from (its `source_qbo_id`): a parent directly under the family, or, when
  // QuickBooks has no parent type, the family customer itself. A link that names anything else is ignored.
  if (shape.parentTypeId === null) {
    if (sourceQboId !== familyQboId) return null;
    return { row: top, edits: "family", signsInBy: "every", typeQboIds: [shape.familyTypeId], signsIn: fieldSignsIn(top.email, email, "every") };
  }
  const mine = rows.find((r) => r.parentQboId === familyQboId && r.active && r.typeQboId !== shape.familyTypeId && r.qboId === sourceQboId && r.typeQboId === shape.parentTypeId);
  if (!mine) return null;
  return { row: mine, edits: "own", signsInBy: "first", typeQboIds: [shape.parentTypeId], signsIn: fieldSignsIn(mine.email, email, "first") };
}

const contact = (r: CachedRecord, edits: "own" | "family"): MyContact & { edits: "own" | "family" } => ({ name: r.displayName, email: r.email, phone: r.phone, edits });

/**
 * The person's own QuickBooks record in this family, from the roster cache: found through the family's own link (its
 * customer, in the records' company) and the source of the guardian row the session chose, by ownRecordIn()'s rule,
 * with the same safety checks as the staff roster (loadRosterPage), narrowly: while QuickBooks is connected, a cache
 * read from another company, or one that doesn't say which, gives none; so does a membership shape that is missing or
 * names a customer type QuickBooks no longer has, and a family with no link to its customer, or one the cache doesn't
 * hold active as a family. Only the family's own customer and its direct sub-customers are read. It is theirs only
 * while its email field holds the person's sign-in address (fieldSignsIn()). Nothing rewrites a row's source when the
 * club re-addresses or reuses a record, so the field is what says the record is still theirs. With `holding`
 * "signs_in_or_my_live_change", asked only by loadMyRecordForMyEmailChange(), a field that reads as the change the
 * person's own live email change request asks for counts too (heldByMyChange()).
 */
async function myOwnRecord(ctx: ParentCtx, shape: MembershipShape | null, holding: Holding): Promise<{ contact: MyContact & { edits: "own" | "family" }; mine: { row: CachedRecord } & Pick<MyRecord, "signsInBy" | "typeQboIds"> } | null> {
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

  const own = ownRecordIn(shape, familyId, rows, link?.sourceQboId ?? null, ctx.email);
  if (!own) return null;
  if (!own.signsIn && !(holding === "signs_in_or_my_live_change" && (await heldByMyChange(ctx, own.row, own.signsInBy === "first")))) return null;
  return { contact: contact(own.row, own.edits), mine: { row: own.row, signsInBy: own.signsInBy, typeQboIds: own.typeQboIds } };
}

/**
 * Whether `row`'s email field reads as the change the person's own live email change request for this record asks for
 * (the request ./email-change.ts finds by its link: unused, unexpired, this person's, asked under the session's own
 * guardian row and family, for this record), the session's address replaced by the new one by the same rule the confirm
 * uses (fieldHasChange()). It can't tell a write the portal sent from staff typing the same address into QuickBooks
 * (for this person or for another the club gave the record to), so it is never asked for what a parent is shown or
 * may edit: only for the email change, which the person finishes by holding the link mailed to that address. Once the
 * request is used or expires, nothing holds the record by it.
 */
async function heldByMyChange(ctx: ParentCtx, row: { qboId: string; email: string | null }, firstOnly: boolean): Promise<boolean> {
  const asked = await db.select({ newEmail: parentEmailChange.newEmail }).from(parentEmailChange).where(and(
    eq(parentEmailChange.parentId, ctx.parentId), eq(parentEmailChange.guardianId, ctx.guardianId), eq(parentEmailChange.familyId, ctx.familyId),
    eq(parentEmailChange.recordQboId, row.qboId), isNull(parentEmailChange.usedAt), gt(parentEmailChange.expiresAt, new Date())));
  return asked.some((r) => fieldHasChange(row.email, ctx.email, r.newEmail, firstOnly));
}
