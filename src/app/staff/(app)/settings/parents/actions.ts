"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { oweSetupMails, setLevel, setSignins, setWelcome, setRequireStudents } from "@/lib/parents/switches";
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
  return done(r, r.owed === 0 ? "Nobody needs one now: everyone who can sign in has a password, has a link to choose one that still works, or is already waiting for theirs to be sent."
    : `${r.owed === 1 ? "1 person is" : `${r.owed} people are`} queued for a link to choose a password. They go out a few each minute.`);
});
// The club's sign-in level, step 3 (the sign-in release, slice SI-10b). For Strict the page sends the count of guardians
// with neither a passkey nor an authenticator app it showed, which setLevel() checks again under the lock; for
// Standard, null. With sign-ins off (as setLevel() read them under its lock) nobody can be signed in (the gate ends any
// session while the door is closed), so Strict's answer says nobody was signed out, and why, even when `signedOut`
// counts a session left from a value that can't be read (LevelResult).
export const setLevelAction = staffAction(P, async (ctx, level: unknown, shown: unknown): Promise<Done> => {
  if (level === "strict") {
    if (typeof shown !== "number" || !Number.isSafeInteger(shown) || shown < 0 || shown > 1_000_000) return NOT_FROM_PAGE;
  } else if (level !== "standard" || shown !== null) return NOT_FROM_PAGE;
  const r = await setLevel(level, shown, op(ctx));
  if (!r.ok) return r;
  return done(r, level === "standard" ? "The club is at Standard. Nobody was signed out."
    : !r.signinOn ? "The club is at Strict. Parent sign-ins are off, so nobody was signed out."
    : r.signedOut === 0 ? "The club is at Strict. Nobody needed signing out."
    : r.signedOut === 1 ? "The club is at Strict. 1 guardian with neither a passkey nor an authenticator app was signed out."
    : `The club is at Strict. ${r.signedOut} guardians with neither a passkey nor an authenticator app were signed out.`);
});
