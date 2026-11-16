"use server";
import { revalidatePath } from "next/cache";
import { staffAction } from "@/lib/guards";
import { remindNow, saveReminderSchedule } from "@/lib/signed-forms/reminders";
import { startRequestAgain } from "@/lib/signed-forms/start-again";
import { isUuid } from "@/lib/seasons/ids";

// What staff do on the signed forms pages (v1 spec §9.3): remind guardians to sign, set a form's reminder schedule,
// and start a form that isn't finished again. Every argument comes from the browser: each is checked here for type and
// size, and the library checks it again against what is stored. All under Forms.Signature.ReadWrite.
const WRITE = "Forms.Signature.ReadWrite" as const;
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const NOT_FROM_PAGE: Done = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };
const op = (ctx: { staffUserId: string; email: string; ip: string | null }) => ({ actor: { door: "staff" as const, id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: WRITE });
const shownAgain = () => revalidatePath("/staff/forms", "layout");

/** "Remind now" for one form: every guardian who still has to sign it. */
export const remindFormAction = staffAction(WRITE, async (ctx, requirementId: string): Promise<Done> => {
  if (!isUuid(requirementId)) return NOT_FROM_PAGE;
  const r = await remindNow({ kind: "form", requirementId }, op(ctx));
  return r.ok ? { ok: true, message: r.message } : r;
});

/** "Remind now" for one family: its guardians, about each of its forms they still have to sign. */
export const remindFamilyAction = staffAction(WRITE, async (ctx, familyQboId: string): Promise<Done> => {
  if (typeof familyQboId !== "string" || familyQboId.length === 0 || familyQboId.length > 64) return NOT_FROM_PAGE;
  const r = await remindNow({ kind: "family", familyQboId }, op(ctx));
  return r.ok ? { ok: true, message: r.message } : r;
});

/** "Remind now" for one request. */
export const remindRequestAction = staffAction(WRITE, async (ctx, requestId: string): Promise<Done> => {
  if (!isUuid(requestId)) return NOT_FROM_PAGE;
  const r = await remindNow({ kind: "request", requestId }, op(ctx));
  return r.ok ? { ok: true, message: r.message } : r;
});

/** A form's reminder schedule: some of 14, 7, 3 and 1 days before it is due, and once a week after it. */
export const saveScheduleAction = staffAction(WRITE, async (ctx, requirementId: string, before: number[], weeklyAfter: boolean): Promise<Done> => {
  if (!isUuid(requirementId) || !Array.isArray(before) || before.length > 4 || before.some((d) => typeof d !== "number") || typeof weeklyAfter !== "boolean") return NOT_FROM_PAGE;
  const r = await saveReminderSchedule(requirementId, { before, weeklyAfter }, op(ctx));
  if (r.ok) shownAgain();
  return r;
});

/** Starts a form that isn't complete again, with the reason staff chose and an optional note, both kept for staff. */
export const startAgainAction = staffAction(WRITE, async (ctx, requestId: string, reason: string, note: string): Promise<Done> => {
  if (!isUuid(requestId) || typeof reason !== "string" || reason.length > 40 || typeof note !== "string" || note.length > 2000) return NOT_FROM_PAGE;
  const r = await startRequestAgain(requestId, reason, note, op(ctx));
  if (r.ok) { shownAgain(); revalidatePath("/", "layout"); }
  return r;
});
