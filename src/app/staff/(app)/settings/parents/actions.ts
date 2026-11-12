"use server";
import { revalidatePath } from "next/cache";
import { staffAction, type StaffCtx } from "@/lib/guards";
import { setSignins, setWelcome, setRequireStudents, setReviewEmails } from "@/lib/parents/switches";
import { decideMatch, acceptStrongMatches } from "@/lib/parents/matches";
import { deletePreviousCompany } from "@/lib/parents/company-change";
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
const ID_MAX = 64;
const familyId = (v: unknown): v is string => typeof v === "string" && v.length <= ID_MAX;

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
export const setReviewEmailsAction = staffAction(P, async (ctx, on: boolean): Promise<Done> => {
  if (typeof on !== "boolean") return NOT_FROM_PAGE;
  return done(await setReviewEmails(on, op(ctx)), on ? "Saved. Staff are emailed when there is something new to review." : "Saved. Staff won't be emailed; the notice on the staff home stays.");
});

export const decideMatchAction = staffAction(P, async (ctx, oldFamilyQboId: string, newFamilyQboId: string | null): Promise<Done> => {
  if (!familyId(oldFamilyQboId) || (newFamilyQboId !== null && !familyId(newFamilyQboId))) return NOT_FROM_PAGE;
  return done(await decideMatch(oldFamilyQboId, newFamilyQboId, op(ctx)), "Saved.");
});
export const acceptStrongMatchesAction = staffAction(P, async (ctx): Promise<Done> => {
  const { accepted } = await acceptStrongMatches(op(ctx));
  return done({ ok: true }, `Accepted ${accepted} ${accepted === 1 ? "match" : "matches"}.`);
});
export const deletePreviousCompanyAction = staffAction(P, async (ctx): Promise<Done> => {
  await deletePreviousCompany({ ...op(ctx), reason: "admin" });
  return done({ ok: true }, "Deleted.");
});
