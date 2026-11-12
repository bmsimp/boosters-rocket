"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { decideHold, reverseHold } from "@/lib/parents/holds";
import { blockPerson, unblockPerson } from "@/lib/parents/people";
import { resendWelcome } from "@/lib/parents/welcome";

const P = "Parents.ReadWrite" as const;
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const op = (ctx: StaffCtx) => ({ actor: { door: "staff" as const, id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P });
const refresh = () => revalidatePath("/staff", "layout");

// A server action can be called with any values, not only the ones its page sends: each argument is checked here,
// before the library sees it. A value no page sends gets one plain refusal.
const NOT_FROM_PAGE: Done = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const EMAIL_MAX = 320, ID_MAX = 64, TEXT_MAX = 2000, SHOWN_MAX = 50;
// A person's ID is a UUID; anything else would reach Postgres as a bad cast and throw.
const personId = (v: unknown): v is string => str(v, ID_MAX) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const familyIds = (v: unknown): v is string[] => Array.isArray(v) && v.length <= SHOWN_MAX && v.every((id) => str(id, ID_MAX));

export const decideHoldAction = staffAction(P, async (ctx, email: string, decision: "same_person" | "not_same", shownFamilyQboIds: string[], note: string): Promise<Done> => {
  if (!str(email, EMAIL_MAX) || (decision !== "same_person" && decision !== "not_same") || !familyIds(shownFamilyQboIds) || !str(note, TEXT_MAX)) return NOT_FROM_PAGE;
  const r = await decideHold(email, decision, [...shownFamilyQboIds], note, op(ctx));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: decision === "same_person" ? "Saved. They can sign in to each of those families now." : "Saved. The address stays held until the records are corrected in QuickBooks." };
});

export const reverseHoldAction = staffAction(P, async (ctx, email: string, note: string): Promise<Done> => {
  if (!str(email, EMAIL_MAX) || !str(note, TEXT_MAX)) return NOT_FROM_PAGE;
  const r = await reverseHold(email, note, op(ctx));
  if (!r.ok) return r;
  refresh();
  return { ok: true, message: "Reversed. The address is held again." };
});

export const blockAction = staffAction(P, async (ctx, parentId: string, reason: string): Promise<Done> => {
  if (!personId(parentId) || !str(reason, TEXT_MAX)) return NOT_FROM_PAGE;
  const r = await blockPerson(parentId, reason, op(ctx));
  if (!r.ok) return { ok: false, errors: [r.reason === "invalid" ? "Say why, in a few words. Only staff see it." : "That person isn't in the portal any more."] };
  refresh();
  return { ok: true, message: "Blocked. They are signed out and can't get a code." };
});

export const unblockAction = staffAction(P, async (ctx, parentId: string): Promise<Done> => {
  if (!personId(parentId)) return NOT_FROM_PAGE;
  const r = await unblockPerson(parentId, op(ctx));
  if (!r.ok) return { ok: false, errors: ["That person isn't in the portal any more."] };
  refresh();
  return { ok: true, message: "Unblocked." };
});

const RESEND_FAILED = {
  not_found: "That person isn't in the portal any more.", blocked: "This person is blocked, so no email was sent.",
  no_access: "This person can't sign in to any family right now, so no email was sent.", mail_failed: "The email couldn't be sent. Check outgoing mail under Mail.",
} as const;
export const resendWelcomeAction = staffAction(P, async (ctx, parentId: string): Promise<Done> => {
  if (!personId(parentId)) return NOT_FROM_PAGE;
  const r = await resendWelcome(parentId, op(ctx));
  if (!r.ok) return { ok: false, errors: [RESEND_FAILED[r.reason]] };
  refresh();
  return { ok: true, message: "Sent." };
});
