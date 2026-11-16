"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { can } from "@/lib/permissions/effective";
import { askRosterWrite, type WriteAsk, type WriteResult } from "@/lib/roster/writes";
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
const op = (ctx: StaffCtx) => ({ actor: { door: "staff" as const, id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P, staffUserId: ctx.staffUserId });
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

/** A new family, or a new member in a flat club (`typeQboId`: the member type staff chose, when the club has several). */
export const createAction = staffAction(P, async (ctx, rosterTag: string, role: "family" | "member", newName: string, typeQboId?: string | null): Promise<WriteResult> => {
  const type = typeQboId ?? null; // a form for a family, bound to fewer arguments, leaves it out
  if (!tag(rosterTag) || (role !== "family" && role !== "member") || !name(newName) || (type !== null && !id(type))) return NOT_FROM_PAGE;
  return run(ctx, { op: "create", role, name: newName, familyQboId: null, email: null, typeQboId: type }, rosterTag);
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

/* ---- The write queue, from the Reconciliation page ---- */

export const tryAgainAction = staffAction(P, async (ctx, itemId: string): Promise<Done> => {
  if (!canRead(ctx) || !uuid(itemId)) return NOT_FROM_PAGE;
  const r = await tryAgainNow(itemId, op(ctx));
  if (r.ok) revalidatePath("/staff", "layout");
  return r;
});

export const giveUpAction = staffAction(P, async (ctx, itemId: string, note: string): Promise<Done> => {
  if (!canRead(ctx) || !uuid(itemId) || !str(note, NOTE_MAX * 4)) return NOT_FROM_PAGE;
  const r = await giveUp(itemId, note, op(ctx));
  if (r.ok) revalidatePath("/staff", "layout");
  return r;
});
