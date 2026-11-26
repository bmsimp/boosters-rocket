"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { addFamily, addStudentToLinked, askFamilyInactive, askRosterWrite, changeInPortal, contactSavedWords, createInQuickBooksAndLink, deactivateLinked, linkStudentMadeAfterGivingUp, moveStudent, renameLinked, SAVED_LEASE_MS, sendContactSaved, sendPortalValue, STAFF_DETAILS_COPY,
  type PortalChange, type WriteAsk, type WriteResult } from "@/lib/roster/writes";
import { giveUp, giveUpEach, tryAgainEach, tryAgainNow, NOTE_MAX } from "@/lib/roster/queue";
import { bulkWords, idsFrom, type BulkDone } from "@/lib/bulk";
import { NAME_MAX } from "@/lib/roster/names";
import { getShape } from "@/lib/roster/shape";
import { familyRecordAt } from "@/lib/families/address";
import { parseContactForm, type ContactForm } from "@/lib/parents/contact-fields";
import { saveDetails } from "@/lib/parents/contact-edits";
import { whoseDetails } from "@/lib/parents/my-family";

// Staff changes to the roster in QuickBooks (v1 spec §6.1). Each action needs Roster.Family.ReadWrite, and also
// Roster.Read, the pages' own permission: the forms show only to staff who hold both. A server action can be called
// with any values, not only the ones its page sends, so each argument is checked here, and every id again in the write
// module, against the roster cache under the roster lock.
const P = "Roster.Family.ReadWrite" as const;
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const NOT_FROM_PAGE = { ok: false as const, errors: ["That didn't go through. Reload the page and try again."] };
const ID_MAX = 64, TAG_MAX = 64, TOKEN_MAX = 20;
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const id = (v: unknown): v is string => str(v, ID_MAX) && v.length > 0;
const tag = (v: unknown): v is string => str(v, TAG_MAX) && v.length > 0;
const version = (v: unknown): v is string => str(v, TOKEN_MAX) && /^\d+$/.test(v);
// A name is checked for its rules in the library; here only that it is text of a size a page could send.
const name = (v: unknown): v is string => str(v, NAME_MAX * 4);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
// A balance that stops a change is said with its amount only to staff who may see money (Finance.Balance.Read).
const op = (ctx: StaffCtx) => ({ actor: { door: "staff" as const, id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P, staffUserId: ctx.staffUserId,
  showAmounts: can(ctx.effective, "Finance.Balance.Read") });
// The pages are Roster.Read's: someone who can change the roster but not see it is refused like anyone without the permission.
const canRead = (ctx: StaffCtx) => can(ctx.effective, "Roster.Read");

async function run(ctx: StaffCtx, ask: WriteAsk, rosterTag: string): Promise<WriteResult> {
  if (!canRead(ctx)) return NOT_FROM_PAGE;
  const r = await askRosterWrite(ask, rosterTag, op(ctx));
  // A refusal changed nothing; a change, or a change read again from QuickBooks, shows on every staff page and on the
  // parents' pages, which read the same cache.
  if (r.ok || r.current) revalidatePath("/", "layout");
  return r;
}

/** Who may send a family's create to QuickBooks and link it: the linking permission (the owner's decision of 2026-11-18). */
const mayLink = (ctx: StaffCtx) => can(ctx.effective, "Accounting.Link.ReadWrite");

/**
 * A new family, or a new member in a flat club (`typeQboId`: the member type staff chose, when the club has several):
 * the portal's own record first (stage 3's slice 9d, addFamily()), sent to QuickBooks only for a staff member who may
 * link families to accounting.
 */
export const createAction = staffAction(P, async (ctx, rosterTag: string, role: "family" | "member", newName: string, typeQboId?: string | null): Promise<WriteResult> => {
  const type = typeQboId ?? null; // a form for a family, bound to fewer arguments, leaves it out
  if (!canRead(ctx) || !tag(rosterTag) || (role !== "family" && role !== "member") || !name(newName) || (type !== null && !id(type))) return NOT_FROM_PAGE;
  const r = await addFamily({ role, name: newName, typeQboId: type }, rosterTag, { ...op(ctx), mayLink: mayLink(ctx) });
  if (r.ok) revalidatePath("/", "layout");
  return r;
});

/**
 * "Create in QuickBooks and link", on the page of a family with no link, or with students who have none
 * (createInQuickBooksAndLink()): for staff who may change families and link them to accounting, both checked here, with
 * the pages' Roster.Read. `typeQboId`, in flat books with several member types, the one staff chose.
 */
export const createAndLinkAction = staffAction(P, async (ctx, rosterTag: string, familyId: string, typeQboId?: string | null): Promise<WriteResult> => {
  const type = typeQboId ?? null;
  if (!canRead(ctx) || !mayLink(ctx) || !tag(rosterTag) || !uuid(familyId) || (type !== null && !id(type))) return NOT_FROM_PAGE;
  const { result, changed } = await createInQuickBooksAndLink(familyId, type, rosterTag, op(ctx));
  if (changed) revalidatePath("/", "layout");
  return result;
});

/** A change to a family with no link, or to a student with none, saved in the portal only (changeInPortal()). */
async function inPortal(ctx: StaffCtx, ask: PortalChange, rosterTag: string): Promise<WriteResult> {
  const r = await changeInPortal(ask, rosterTag, op(ctx));
  if (r.ok) revalidatePath("/", "layout");
  return r;
}

/** A student added to a family with no link: the portal's own record only. */
export const addStudentHereAction = staffAction(P, async (ctx, rosterTag: string, familyId: string, newName: string): Promise<WriteResult> => {
  if (!canRead(ctx) || !tag(rosterTag) || !uuid(familyId) || !name(newName)) return NOT_FROM_PAGE;
  return inPortal(ctx, { op: "add_student", familyId, name: newName }, rosterTag);
});

/** A family with no link, or a student with none, renamed in the portal only. */
export const renameHereAction = staffAction(P, async (ctx, rosterTag: string, kind: "family" | "student", recordId: string, newName: string): Promise<WriteResult> => {
  if (!canRead(ctx) || !tag(rosterTag) || (kind !== "family" && kind !== "student") || !uuid(recordId) || !name(newName)) return NOT_FROM_PAGE;
  return inPortal(ctx, kind === "family" ? { op: "rename_family", familyId: recordId, name: newName } : { op: "rename_student", studentId: recordId, name: newName }, rosterTag);
});

/** A family with no link (with its active students), or a student with none, made inactive in the portal only: no balance to read. */
export const deactivateHereAction = staffAction(P, async (ctx, rosterTag: string, kind: "family" | "student", recordId: string): Promise<WriteResult> => {
  if (!canRead(ctx) || !tag(rosterTag) || (kind !== "family" && kind !== "student") || !uuid(recordId)) return NOT_FROM_PAGE;
  return inPortal(ctx, kind === "family" ? { op: "deactivate_family", familyId: recordId } : { op: "deactivate_student", studentId: recordId }, rosterTag);
});

/**
 * A student added to a linked family (stage 3's slice 9e): the portal's own record first, then made in QuickBooks
 * (addStudentToLinked()). The page sends the family's app id, a uuid, never its customer's.
 */
export const addStudentAction = staffAction(P, async (ctx, rosterTag: string, familyId: string, newName: string): Promise<WriteResult> => {
  if (!canRead(ctx) || !tag(rosterTag) || !uuid(familyId) || !name(newName)) return NOT_FROM_PAGE;
  const r = await addStudentToLinked(familyId, newName, rosterTag, op(ctx));
  if (r.ok) revalidatePath("/", "layout");
  return r;
});

/**
 * A linked family, member or student renamed (stage 3's slice 9e): saved in the portal first, then sent to QuickBooks
 * with the link's own version (renameLinked()). The page sends the record's kind and app id, a uuid, and no version.
 */
export const renameLinkedAction = staffAction(P, async (ctx, rosterTag: string, kind: "family" | "student", recordId: string, newName: string): Promise<WriteResult> => {
  if (!canRead(ctx) || !tag(rosterTag) || (kind !== "family" && kind !== "student") || !uuid(recordId) || !name(newName)) return NOT_FROM_PAGE;
  const r = await renameLinked({ kind, recordId, name: newName }, rosterTag, op(ctx));
  if (r.ok) revalidatePath("/", "layout");
  return r;
});

/** A Parent customer renamed: it has no record in the portal, so QuickBooks first, with the version its page was shown. */
export const renameParentAction = staffAction(P, async (ctx, rosterTag: string, qboId: string, syncToken: string, newName: string): Promise<WriteResult> => {
  if (!tag(rosterTag) || !id(qboId) || !version(syncToken) || !name(newName)) return NOT_FROM_PAGE;
  return run(ctx, { op: "rename", qboId, syncToken, name: newName, parentOnly: true }, rosterTag);
});

/**
 * A student moved to another of the portal's own families (stage 3's slice 9f): saved in the portal first, with what
 * follows a move, then sent to QuickBooks for a linked student (moveStudent()). The page sends the student's and the
 * family's app ids, uuids, and no version and no QuickBooks id.
 */
export const moveAction = staffAction(P, async (ctx, rosterTag: string, studentId: string, toFamilyId: string): Promise<WriteResult> => {
  if (!canRead(ctx) || !tag(rosterTag) || !uuid(studentId) || !uuid(toFamilyId)) return NOT_FROM_PAGE;
  const r = await moveStudent(studentId, toFamilyId, rosterTag, op(ctx));
  if (r.ok) revalidatePath("/", "layout");
  return r;
});

/**
 * A Parent customer made inactive: it has no record in the portal, so QuickBooks first, with the version its page was
 * shown, under the balance rule (askRosterWrite(); a linked student's or member's is deactivateLinkedAction's, and the
 * write module refuses one here).
 */
export const deactivateAction = staffAction(P, async (ctx, rosterTag: string, qboId: string, syncToken: string): Promise<WriteResult> => {
  if (!tag(rosterTag) || !id(qboId) || !version(syncToken)) return NOT_FROM_PAGE;
  return run(ctx, { op: "deactivate", qboId, syncToken }, rosterTag);
});

/**
 * A linked student (layered) or member (flat) made inactive (stage 3's slice 9g): QuickBooks first, under the balance
 * rule, with the link's own version (deactivateLinked()). The page sends the record's kind and app id, a uuid, and no
 * version and no QuickBooks id.
 */
export const deactivateLinkedAction = staffAction(P, async (ctx, rosterTag: string, kind: "family" | "student", recordId: string): Promise<WriteResult> => {
  if (!canRead(ctx) || !tag(rosterTag) || (kind !== "family" && kind !== "student") || !uuid(recordId)) return NOT_FROM_PAGE;
  const r = await deactivateLinked({ kind, recordId }, rosterTag, op(ctx));
  if (r.ok) revalidatePath("/", "layout");
  return r;
});

/** The stamp of whom the page covered (coverStamp()): base64url of a fixed length. */
const stampOk = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{22}$/.test(v);

/**
 * A family made inactive with everyone under it, as staff confirmed the list on its page (src/lib/roster/writes.ts,
 * askFamilyInactive): the family record's app id, a uuid, and the stamp of whom the page covered, never an id or a
 * version to trust. The pages are made again whenever anything may have changed, a stop part way included, so the
 * list shown next is who is still active.
 */
export const familyInactiveAction = staffAction(P, async (ctx, rosterTag: string, familyId: string, stamp: string): Promise<WriteResult> => {
  if (!canRead(ctx) || !tag(rosterTag) || !uuid(familyId) || !stampOk(stamp)) return NOT_FROM_PAGE;
  const { result, changed } = await askFamilyInactive(familyId, stamp, rosterTag, op(ctx));
  if (changed) revalidatePath("/", "layout");
  return result;
});

/**
 * A family's phone and mailing address, changed by staff on the family's page (stage 3's slice 11c), in books where they
 * are each family's (whoseDetails(): no parent type, flat books included): `familyId`, the family record's app id the
 * page bound, a uuid of a family record (NOT_FROM_PAGE otherwise; saveDetails() answers none for one that isn't
 * active); `sent`, the seven fields and the version the form was shown (`f:<n>`), read whole by parseContactForm(). The
 * one save (saveDetails()), its items held for the at-once try (QueueAs), then, after its commit, that try
 * (sendContactSaved()). `compare`: the kept items whose compare view the reader may open (it takes Parents.ReadWrite).
 */
type DetailsDone = { ok: true; message: string; status?: "waiting" | "attention"; current: ContactForm; compare: string[] } | { ok: false; errors: string[]; current?: ContactForm };
export const saveFamilyDetailsAction = staffAction(P, async (ctx, familyId: string, sent: unknown): Promise<DetailsDone> => {
  if (!canRead(ctx) || !uuid(familyId)) return NOT_FROM_PAGE;
  const parsed = parseContactForm(sent);
  if (!parsed.ok) return NOT_FROM_PAGE;
  const record = await familyRecordAt(familyId);
  if (!record) return NOT_FROM_PAGE;
  // Whose details these are, read before the save: a form drawn for the family's details that comes back after a shape
  // save made them each person's is answered as changed, and nothing is saved on either row.
  if (whoseDetails(await getShape()) !== "family") return { ok: false, errors: [STAFF_DETAILS_COPY.whoseChanged] };
  const of = { kind: "family" as const, familyId: record };
  const r = await saveDetails(of, parsed.form, { actor: op(ctx).actor, ip: ctx.ip, permission: P, queueAs: { askedBy: ctx.staffUserId, nextTryAt: new Date(Date.now() + SAVED_LEASE_MS) } });
  if (r.is === "none") return { ok: false, errors: ["This family is inactive in the portal, so its details can't be changed. Nothing was saved."] };
  if (r.is === "invalid") return { ok: false, errors: r.errors };
  if (r.is === "stale") return r.current ? { ok: false, errors: [STAFF_DETAILS_COPY.changed], current: r.current } : NOT_FROM_PAGE;
  if (r.is === "unchanged") return { ok: true, message: STAFF_DETAILS_COPY.unchanged, current: r.current, compare: [] };
  revalidatePath("/", "layout");
  const said = contactSavedWords(await sendContactSaved(of, r.queueIds, { actor: op(ctx).actor, ip: ctx.ip, permission: P, staffUserId: ctx.staffUserId }), "family",
    { mayCompare: can(ctx.effective, "Parents.ReadWrite"), whoCompares: "someone who may see parents' details can compare the two there." });
  return { ok: true, message: [STAFF_DETAILS_COPY.savedFamily, ...said.sentences].join(" "), ...(said.status ? { status: said.status } : {}), current: r.current, compare: said.compare };
});

/* ---- The write queue, from the Reconciliation page ---- */

/** "Try again now": a family's or member's create, which makes its customer and links it, also takes the linking permission (tryAgainNow()). */
export const tryAgainAction = staffAction(P, async (ctx, itemId: string): Promise<Done> => {
  if (!canRead(ctx) || !uuid(itemId)) return NOT_FROM_PAGE;
  const r = await tryAgainNow(itemId, { ...op(ctx), mayLink: mayLink(ctx) });
  if (r.ok) revalidatePath("/staff", "layout");
  return r;
});

/**
 * Try again for many, Reconciliation's bulk press on its selection (src/lib/bulk.ts): the change ids ticked, checked here
 * for their type, count and format, each asked for by "Try again now"'s own function (tryAgainEach()), in its own
 * transaction. The same permissions as "Try again now".
 */
export const tryAgainManyAction = staffAction(P, async (ctx, itemIds: string[]): Promise<BulkDone> => {
  const ids = canRead(ctx) ? idsFrom(itemIds, uuid) : null;
  if (ids === null) return NOT_FROM_PAGE;
  const r = await tryAgainEach(ids, { ...op(ctx), mayLink: mayLink(ctx) });
  if (r.rows.some((x) => x.outcome === "done")) revalidatePath("/staff", "layout");
  return { ok: true, message: bulkWords(r, "asked to be tried again"), ...r };
});

/**
 * "Link the student to it": a student's given-up create that QuickBooks made all the same, linked to that customer
 * (linkStudentMadeAfterGivingUp()). Linking takes the linking permission as well, checked here with the page's Roster.Read.
 */
export const linkMadeStudentAction = staffAction(P, async (ctx, rosterTag: string, itemId: string): Promise<WriteResult> => {
  if (!canRead(ctx) || !mayLink(ctx) || !tag(rosterTag) || !uuid(itemId)) return NOT_FROM_PAGE;
  const r = await linkStudentMadeAfterGivingUp(itemId, rosterTag, op(ctx));
  if (r.ok) revalidatePath("/", "layout");
  return r;
});

/**
 * "Send the portal's value", for a change QuickBooks refused that the portal kept (sendPortalValue()): `shown` is what the
 * row showed of QuickBooks and `stamp` seals it to the item, so a value the form sends that isn't what the row showed is
 * refused.
 */
export const sendPortalValueAction = staffAction(P, async (ctx, itemId: string, shown: string, stamp: string): Promise<WriteResult> => {
  if (!canRead(ctx) || !uuid(itemId) || !str(shown, NAME_MAX * 4) || !str(stamp, TAG_MAX)) return NOT_FROM_PAGE;
  const r = await sendPortalValue(itemId, shown, stamp, op(ctx));
  revalidatePath("/", "layout");
  return r;
});

export const giveUpAction = staffAction(P, async (ctx, itemId: string, note: string): Promise<Done> => {
  if (!canRead(ctx) || !uuid(itemId) || !str(note, NOTE_MAX * 4)) return NOT_FROM_PAGE;
  const r = await giveUp(itemId, note, op(ctx));
  if (r.ok) revalidatePath("/staff", "layout");
  return r;
});

/**
 * Give up on many, Reconciliation's bulk press on its selection, with one note for them all: the change ids ticked,
 * checked here for their type, count and format, and the note, each given up by "Give up"'s own function
 * (giveUpEach()), in its own transaction with the same note. The same permissions as "Give up".
 */
export const giveUpManyAction = staffAction(P, async (ctx, itemIds: string[], note: string): Promise<BulkDone> => {
  const ids = canRead(ctx) && str(note, NOTE_MAX * 4) ? idsFrom(itemIds, uuid) : null;
  if (ids === null) return NOT_FROM_PAGE;
  const r = await giveUpEach(ids, note, op(ctx));
  if (!r.ok) return r;
  if (r.rows.some((x) => x.outcome === "done")) revalidatePath("/staff", "layout");
  return { ok: true, message: bulkWords(r, "given up"), rows: r.rows, left: r.left };
});
