"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { oweSetupMails, setSignins, setWelcome, setRequireStudents } from "@/lib/parents/switches";
import { getParentSettings } from "@/lib/parents/settings";

const P = "Settings.Parents.ReadWrite" as const;
type Done = { ok: true; message: string } | { ok: false; errors: string[] };
const op = (ctx: StaffCtx) => ({ actor: { door: "staff" as const, id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip, permission: P });
const done = (r: { ok: true } | { ok: false; errors: string[] }, message: string): Done => {
  if (!r.ok) return r;
  revalidatePath("/staff", "layout");
  return { ok: true, message };
};

// A server action can be called with any values, not only the ones its page sends: each argument is checked here,
// before the library sees it, and nothing is coerced. A value no page sends gets one plain refusal.
const NOT_FROM_PAGE: Done = { ok: false, errors: ["That didn't go through. Reload the page and try again."] };

export const setSigninsAction = staffAction(P, async (ctx, on: boolean): Promise<Done> => {
  if (typeof on !== "boolean") return NOT_FROM_PAGE;
  // Read first only for the words: switching off what wasn't on changes nothing, and must not say everyone was signed out.
  const wasOn = (await getParentSettings()).signin;
  return done(await setSignins(on, op(ctx)), on ? "Parent sign-ins are on."
    : wasOn ? "Parent sign-ins are off. Every parent has been signed out, and welcome emails are off." : "Parent sign-ins weren't on.");
});
export const setWelcomeAction = staffAction(P, async (ctx, on: boolean): Promise<Done> => {
  if (typeof on !== "boolean") return NOT_FROM_PAGE;
  return done(await setWelcome(on, op(ctx)), on ? "Welcome emails are on. They go out a few each minute." : "Welcome emails are off.");
});
export const setRequireStudentsAction = staffAction(P, async (ctx, on: boolean): Promise<Done> => {
  if (typeof on !== "boolean") return NOT_FROM_PAGE;
  return done(await setRequireStudents(on, op(ctx)), on ? "Saved. Families with no active student can't sign in." : "Saved. Students no longer affect who can sign in.");
});
// The press for everyone who can sign in and hasn't chosen a password (the sign-in release, slice SI-4). It takes no
// argument: who is emailed is worked out under the lock, never sent by the page.
export const oweSetupMailsAction = staffAction(P, async (ctx): Promise<Done> => {
  const r = await oweSetupMails(op(ctx));
  if (!r.ok) return r;
  return done(r, r.owed === 0 ? "Nobody needs one now: everyone who can sign in has a password, or was sent a link a moment ago."
    : `${r.owed === 1 ? "1 person is" : `${r.owed} people are`} queued for a link to choose a password. They go out a few each minute.`);
});
