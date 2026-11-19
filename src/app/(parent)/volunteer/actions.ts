"use server";
import { revalidatePath } from "next/cache";
import { parentAction } from "@/lib/guards";
import { checkIn } from "@/lib/volunteer/check-in";
import { cancelMySignup, signUpForShift } from "@/lib/volunteer/my-volunteer";

/**
 * Signing up for a volunteer shift and cancelling a sign-up (v1 spec §11.2). Both arguments come from the browser,
 * whatever their types say: the library checks each one's type and size, finds the shift as one that is offered, the
 * student among the session family's own active students, and the sign-up among the session family's own. The family
 * is the session's alone. Every page that shows a sign-up or a requirement's progress is shown again afterward.
 */
export const signUpAction = parentAction(async (ctx, shiftId: unknown, who: unknown) => {
  const r = await signUpForShift(ctx, shiftId, who);
  if (r.ok) revalidatePath("/", "layout");
  return r;
});

export const cancelSignupAction = parentAction(async (ctx, signupId: unknown) => {
  const r = await cancelMySignup(ctx, signupId);
  if (r.ok) revalidatePath("/", "layout");
  return r;
});

/**
 * Checking in at a shift with its code (v1 spec §11.4, §12 invariant 8): `code` and `signupId` (or "all") come from the
 * browser. The library finds the shift by the code, the sign-up among the session family's own live sign-ups on it,
 * and checks the window again at the moment of writing.
 */
export const checkInAction = parentAction(async (ctx, code: unknown, signupId: unknown) => {
  const r = await checkIn(ctx, code, signupId);
  if (r.ok) revalidatePath("/", "layout");
  return r;
});
