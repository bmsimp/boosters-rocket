"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { addFamily, askFamilyInactive, askRosterWrite, changeInPortal, createInQuickBooksAndLink, type PortalChange, type WriteAsk, type WriteResult } from "@/lib/roster/writes";
import { giveUp, tryAgainNow, NOTE_MAX } from "@/lib/roster/queue";
import { NAME_MAX } from "@/lib/roster/names";

// Staff changes to the roster in QuickBooks (v1 spec §6.1). Each action needs Roster.Family.ReadWrite, and also
// Roster.Read, the pages' own permission: the forms show only to staff who hold both. A server action can be called
// with any values, not only the ones its page sends, so each argument is checked here, and every id again in the write
// module, against the roster cache under the roster lock.
const P = "Roster.Family.ReadWrite" as const;
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const NOT_FROM_PAGE = { ok: false as const, errors: ["That didn't go through. Reload the page and try again."] };
const ID_MAX = 64, TAG_MAX = 64, EMAIL_MAX = 320, TOKEN_MAX = 20;
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

/** A student under a family, or a parent with their own email address. */
export const addToFamilyAction = staffAction(P, async (ctx, rosterTag: string, role: "student" | "parent", familyQboId: string, newName: string, email?: string | null): Promise<WriteResult> => {
  const address = email ?? null; // a student's form, bound to fewer arguments, leaves it out
  if (!tag(rosterTag) || (role !== "student" && role !== "parent") || !id(familyQboId) || !name(newName)) return NOT_FROM_PAGE;
  if (role === "parent" ? !str(address, EMAIL_MAX) : address !== null) return NOT_FROM_PAGE;
  return run(ctx, { op: "create", role, name: newName, familyQboId, email: address, typeQboId: null }, rosterTag);
});

export const renameAction = staffAction(P, async (ctx, rosterTag: string, qboId: string, syncToken: string, newName: string): Promise<WriteResult> => {
  if (!tag(rosterTag) || !id(qboId) || !version(syncToken) || !name(newName)) return NOT_FROM_PAGE;
  return run(ctx, { op: "rename", qboId, syncToken, name: newName }, rosterTag);
});

export const moveAction = staffAction(P, async (ctx, rosterTag: string, qboId: string, syncToken: string, toFamilyQboId: string): Promise<WriteResult> => {
  if (!tag(rosterTag) || !id(qboId) || !version(syncToken) || !id(toFamilyQboId)) return NOT_FROM_PAGE;
  return run(ctx, { op: "move", qboId, syncToken, toFamilyQboId }, rosterTag);
});

export const deactivateAction = staffAction(P, async (ctx, rosterTag: string, qboId: string, syncToken: string): Promise<WriteResult> => {
  if (!tag(rosterTag) || !id(qboId) || !version(syncToken)) return NOT_FROM_PAGE;
  return run(ctx, { op: "deactivate", qboId, syncToken }, rosterTag);
});

/** The most customers one family's list may hold: far more than any family has, and a bound on what a caller can send. */
const COVER_MAX = 200;
/** The list the page showed: pairs of a QuickBooks id and the version shown, the family's among them. */
const shownList = (v: unknown): v is [string, string][] => Array.isArray(v) && v.length > 0 && v.length <= COVER_MAX
  && v.every((pair) => Array.isArray(pair) && pair.length === 2 && id(pair[0]) && version(pair[1]));

/**
 * A family made inactive with everyone under it, as staff confirmed the list on its page (src/lib/roster/writes.ts,
 * askFamilyInactive). The pages are made again whenever anything may have changed, a stop part way included, so the
 * list shown next is who is still active.
 */
export const familyInactiveAction = staffAction(P, async (ctx, rosterTag: string, familyQboId: string, shown: [string, string][]): Promise<WriteResult> => {
  if (!canRead(ctx) || !tag(rosterTag) || !id(familyQboId) || !shownList(shown)) return NOT_FROM_PAGE;
  const { result, changed } = await askFamilyInactive(familyQboId, shown, rosterTag, op(ctx));
  if (changed) revalidatePath("/", "layout");
  return result;
});

/* ---- The write queue, from the Reconciliation page ---- */

/** "Try again now": a family's or member's create, which makes its customer and links it, also takes the linking permission (tryAgainNow()). */
export const tryAgainAction = staffAction(P, async (ctx, itemId: string): Promise<Done> => {
  if (!canRead(ctx) || !uuid(itemId)) return NOT_FROM_PAGE;
  const r = await tryAgainNow(itemId, { ...op(ctx), mayLink: mayLink(ctx) });
  if (r.ok) revalidatePath("/staff", "layout");
  return r;
});

export const giveUpAction = staffAction(P, async (ctx, itemId: string, note: string): Promise<Done> => {
  if (!canRead(ctx) || !uuid(itemId) || !str(note, NOTE_MAX * 4)) return NOT_FROM_PAGE;
  const r = await giveUp(itemId, note, op(ctx));
  if (r.ok) revalidatePath("/staff", "layout");
  return r;
});
