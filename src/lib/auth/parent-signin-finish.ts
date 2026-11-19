// The one way a parent's sign-in is finished (the sign-in release, slice SI-3a). Every way in that proves who a person
// is (the emailed code, a set-up link's password) ends here, and nowhere else is a parent session made or its cookie
// set: tests/unit/one-way-in.test.ts reads every source file under src/ and fails for anything that does either outside
// this module, and for a call of the finish from anywhere but the parent code plugin (parent-code-plugin.ts), whose
// endpoints are the only callers. So no way in can skip the checks below. Server only.
import "server-only";
import type { GenericEndpointContext } from "better-auth";
import { setSessionCookie } from "better-auth/cookies";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parentAuthUser } from "@/lib/db/schema";
import { signinStands, type LinkSigninProof } from "@/lib/parents/signin-codes";
import { completeParentSignin } from "@/lib/parents/family-choice";
import { PARENT_SESSION_COOKIE_SECONDS } from "@/lib/parents/sessions";
import { landingPath, withReturnPath } from "./return-path";

/** What the sign-in spent: a code's row id (verifySigninCode()), or a set-up link's proof (choosePasswordFromLink()). */
export type SigninProof = { codeId: string } | { link: LinkSigninProof };

/** Where to go, or one refusal with no reason: the reasons are in the audit rows the checks write (`signin.refused`). */
export type SigninFinish = { ok: true; next: string } | { ok: false };
const REFUSED: SigninFinish = { ok: false };

/**
 * Finishes a sign-in whose proof has been checked, in this order, which must not change:
 * 1. the person's sign-in account (`parent_auth_user`) and Better Auth's user for it, refused when there is none;
 * 2. the session, made with no family chosen (`familyId: null`). It is stored before the last check and before
 *    anything is audited as a sign-in, so an address change, a block or a password reset that lands at this moment
 *    cannot leave a session behind;
 * 3. the last check (signinStands(), signin-codes.ts), which reads under the person's lock that the address is still
 *    theirs, they are not blocked and what the sign-in spent still stands; refused, the session is deleted;
 * 4. completeParentSignin() (family-choice.ts): invited rows become active, one family that counts is entered and the
 *    sign-in audited; a session ended in the meantime, or a person left with no row that counts, is refused with no
 *    cookie;
 * 5. the cookie, sent this once with the longest life browsers allow (PARENT_SESSION_COOKIE_SECONDS, 400 days), since
 *    it has to outlive the session row, which use renews (sessions.ts);
 * 6. where to go: the page asked for (`next`, from the browser, only through landingPath() and withReturnPath(), which
 *    drop anything that is not a parent page of this site) once a family is entered, else the chooser carrying it.
 * `ctx` is the Better Auth endpoint that is finishing the sign-in; `email` is the address the sign-in was proved with
 * (what the parent typed for a code; what the set read under the person's lock for a link).
 */
export async function finishParentSignin(ctx: GenericEndpointContext,
  o: { parentId: string; email: string; proof: SigninProof; ip: string | null; next?: string }): Promise<SigninFinish> {
  const [u] = await db.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, o.parentId));
  const user = u ? await ctx.context.internalAdapter.findUserById(u.id) : null;
  if (!user) return REFUSED;
  const session = await ctx.context.internalAdapter.createSession(user.id, false, { familyId: null });
  if (!(await signinStands(o.parentId, o.email, o.ip, "codeId" in o.proof ? o.proof.codeId : o.proof.link))) {
    await ctx.context.internalAdapter.deleteSession(session.token);
    return REFUSED;
  }
  const { familyId, sessionEnded } = await completeParentSignin(o.parentId, o.ip, session.id);
  if (sessionEnded) return REFUSED;   // ended while it was being made: no cookie for it
  await setSessionCookie(ctx, { session, user }, false, { maxAge: PARENT_SESSION_COOKIE_SECONDS });
  return { ok: true, next: familyId ? landingPath(o.next) : withReturnPath("/choose-family", o.next) };
}
