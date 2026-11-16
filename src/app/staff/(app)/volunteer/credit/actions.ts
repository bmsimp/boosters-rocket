"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { isUuid } from "@/lib/seasons/ids";
import { addMissedCheckIn, addOutsideCredit, NOTE_MAX, REASON_MAX, removeCredit, type OutsideInput } from "@/lib/volunteer/staff-credit";

// Correcting volunteer credit (v1 spec §11.4) needs Volunteer.Credit.ReadWrite. Each id a page sends (a sign-up, a
// credit, a family, a student, a requirement) is checked again in the library, under the roster lock, against the
// roster tag the page was shown; a value no page sends gets one plain refusal.
const CREDIT = "Volunteer.Credit.ReadWrite" as const;
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const op = (ctx: StaffCtx) => ({ actor: { door: "staff" as const, id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: CREDIT });
// Credit changes how families' requirements stand: on their pages, the staff progress pages and the volunteer pages.
const refresh = () => revalidatePath("/", "layout");
const NOT_FROM_PAGE: Done = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const tag = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v);
const qboId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 64;
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

export const addCheckInAction = staffAction(CREDIT, async (ctx, signupId: string, rosterTag: string): Promise<Done> => {
  if (!isUuid(signupId) || !tag(rosterTag)) return NOT_FROM_PAGE;
  const r = await addMissedCheckIn(signupId, rosterTag, op(ctx));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Checked in. It counts as if they had checked in themselves." };
});

export const removeCreditAction = staffAction(CREDIT, async (ctx, creditId: string, rosterTag: string, reason: string): Promise<Done> => {
  if (!isUuid(creditId) || !tag(rosterTag) || !str(reason, REASON_MAX * 2)) return NOT_FROM_PAGE;
  const r = await removeCredit(creditId, reason, rosterTag, op(ctx));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Removed. It no longer counts toward anything." };
});

type OutsideFields = Omit<OutsideInput, "familyQboId">;
const outsideFields = (v: unknown): v is OutsideFields => {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return isUuid(f.requirementId) && qboId(f.who) && str(f.amount, 12) && str(f.note, NOTE_MAX * 2);
};

export const addOutsideCreditAction = staffAction(CREDIT, async (ctx, rosterTag: string, familyQboId: string, fields: OutsideFields): Promise<Done> => {
  if (!tag(rosterTag) || !qboId(familyQboId) || !outsideFields(fields)) return NOT_FROM_PAGE;
  // Only the fields named here go on: an object from the browser can carry anything else.
  const r = await addOutsideCredit({ familyQboId, requirementId: fields.requirementId, who: fields.who, amount: fields.amount, note: fields.note }, rosterTag, op(ctx));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Credited. The family sees it as added by the club; only staff see the note." };
});
