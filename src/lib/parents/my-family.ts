// Privacy: the one query a parent page reads its family through. It takes the session's ParentCtx and nothing else,
// reads only the rows of that family, and returns that family alone. The family's name and students are the app's own
// records (ctx.familyId, src/lib/families/session-family.ts), with no link and no roster cache, and so are the contact
// details a parent sees (`me`: the person's own, or the family's in books with no parent type; stage 3's slice 11a).
// Nothing here reads the roster cache or QuickBooks for a page (since stage 3's slice 11d not even the change of
// sign-in email); ownRecordIn(), below, is the pure rule the take-in of contact details reads the cache by. It never
// imports the staff-only modules (src/lib/roster/queries.ts, the staff functions of ./directory.ts):
// tests/integration/page-guards.test.ts scans this file.
import "server-only";
import { and, eq } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { family, parent } from "@/lib/db/schema";
import type { ParentCtx } from "@/lib/guards";
import { getShape, type MembershipShape } from "@/lib/roster/shape";
import type { AppStudentId } from "@/lib/families/ids";
import { sessionFamily } from "@/lib/families/session-family";
import { recordNameWords } from "@/lib/families/words";
import type { ContactValues } from "./contact-fields";
import { fieldSignsIn } from "./email-field";

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

/** A customer of the roster cache as ownRecordIn() reads it. */
export type CachedRecord = { qboId: string; displayName: string; active: boolean; parentQboId: string | null; typeQboId: string | null; email: string | null; phone: string | null };
/** A guardian row's own QuickBooks record, by ownRecordIn()'s rule. */
export type OwnRecord<R extends CachedRecord> = {
  row: R;
  /** "own" for a parent's own record, "family" for a family's or a flat member's, which every guardian of it signs in through. */
  edits: "own" | "family";
  /**
   * Which of the addresses in the record's email field are the person's through it: the first alone on a parent's or a
   * flat member's record; every one on a family's record in a club with no parent type.
   */
  signsInBy: "first" | "every";
  typeQboIds: readonly string[];
  /** Whether its email field holds the person's sign-in address, by the record's own rule (fieldSignsIn()). */
  signsIn: boolean;
};

/**
 * The QuickBooks record a guardian row's sign-in comes from, by the membership shape, from the roster cache's rows of
 * the family's own linked customer and those directly under it (`rows`), and the customer the row's own link names
 * (`ownCustomerId`: its `carried_over` membership link, the record its sign-in came from; null for a row with none).
 * Pure: the one rule for whose record a cached customer is, read by the take-in of contact details
 * (./contact-take-in.ts). Until stage 3's slice 11d the change of sign-in email read its record by it too; since then
 * that change reads no record.
 * - Flat: the member itself, of a member type, when the row's own customer is it.
 * - Layered: the family customer of the family type, active; and the row's own customer an active customer of the parent
 *   type directly under it, or, when the books have no parent type, the family customer itself.
 * Null whenever any of it doesn't hold. `signsIn` says whether the record's email field holds `email` by the record's
 * rule: the first address on a parent's own record or a flat member's, any of them on a family's with no parent type.
 * A record whose field doesn't hold it is not the person's.
 */
export function ownRecordIn<R extends CachedRecord>(shape: MembershipShape, familyQboId: string, rows: readonly R[], ownCustomerId: string | null, email: string): OwnRecord<R> | null {
  // By its ID, never by position: the rows come back in no order.
  const top = rows.find((r) => r.qboId === familyQboId);
  if (!top || !top.active) return null;
  if (ownCustomerId === null) return null;

  if (shape.kind === "flat") {
    // The member is its own family: its own record and nothing under it.
    if (top.typeQboId === null || !shape.memberTypeIds.includes(top.typeQboId)) return null;
    if (ownCustomerId !== familyQboId) return null;
    // Every address on a member's record signs in through it, so its details are shared like a family's.
    return { row: top, edits: "family", signsInBy: "first", typeQboIds: shape.memberTypeIds, signsIn: fieldSignsIn(top.email, email, "first") };
  }

  if (top.typeQboId !== shape.familyTypeId) return null;
  // The record a guardian row came from (its own link's customer): a parent directly under the family, or, when
  // QuickBooks has no parent type, the family customer itself. A link that names anything else is ignored.
  if (shape.parentTypeId === null) {
    if (ownCustomerId !== familyQboId) return null;
    return { row: top, edits: "family", signsInBy: "every", typeQboIds: [shape.familyTypeId], signsIn: fieldSignsIn(top.email, email, "every") };
  }
  const mine = rows.find((r) => r.parentQboId === familyQboId && r.active && r.typeQboId !== shape.familyTypeId && r.qboId === ownCustomerId && r.typeQboId === shape.parentTypeId);
  if (!mine) return null;
  return { row: mine, edits: "own", signsInBy: "first", typeQboIds: [shape.parentTypeId], signsIn: fieldSignsIn(mine.email, email, "first") };
}
