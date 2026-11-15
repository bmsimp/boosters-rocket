import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parentAuthUser } from "@/lib/db/schema";
import { clientIpFrom } from "@/lib/request";
import { requestSigninCode, signinStands, verifySigninCode } from "@/lib/parents/signin-codes";
import { completeParentSignin } from "@/lib/parents/family-choice";
import { PARENT_SESSION_COOKIE_SECONDS } from "@/lib/parents/sessions";
import { MAX_RETURN_PATH, landingPath, withReturnPath } from "./return-path";

type Ctx = { headers?: Headers; request?: Request };
const ipOf = (ctx: Ctx) => { const h = ctx.headers ?? ctx.request?.headers; return h ? clientIpFrom(h) : null; };

/**
 * The portal's email-code door (spec §1). Codes, tries and limits are portal code (src/lib/parents/signin-codes.ts);
 * Better Auth only makes the session and its cookie. Better Auth's own sign-up is never reachable: the only way in is
 * a code for an existing person, whose auth user the portal made with them.
 */
export const parentCodePlugin = () => ({
  id: "booster-parent-code",
  endpoints: {
    portalCodeSend: createAuthEndpoint("/portal-code/send", { method: "POST", body: z.object({ email: z.string().max(320) }) }, async (ctx) => {
      // The answer doesn't wait for the email and doesn't depend on what happened (spec §12 invariant 9).
      const { delivery } = await requestSigninCode(ctx.body.email, ipOf(ctx));
      void delivery;
      return ctx.json({ ok: true });
    }),
    portalCodeVerify: createAuthEndpoint("/portal-code/verify", {
      // `next` is the page the parent asked for before signing in. It comes from the browser: it is only ever used
      // through landingPath() and withReturnPath(), which drop anything that is not a parent page of this site.
      method: "POST", body: z.object({ email: z.string().max(320), code: z.string().max(20), next: z.string().max(MAX_RETURN_PATH).optional() }),
    }, async (ctx) => {
      const ip = ipOf(ctx);
      const r = await verifySigninCode(ctx.body.email, ctx.body.code, ip);
      if (!r.ok) return ctx.json({ ok: false, error: r.reason });
      const [u] = await db.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, r.parentId));
      const user = u ? await ctx.context.internalAdapter.findUserById(u.id) : null;
      if (!user) return ctx.json({ ok: false, error: "rejected" });
      // The session is stored before the last check and before anything is audited as a sign-in, so an address change
      // or a block that lands at this moment cannot leave a session behind (signinStands).
      const session = await ctx.context.internalAdapter.createSession(user.id, false, { familyQboId: null });
      if (!(await signinStands(r.parentId, ctx.body.email, ip))) {
        await ctx.context.internalAdapter.deleteSession(session.token);
        return ctx.json({ ok: false, error: "rejected" });
      }
      const { familyQboId, sessionEnded } = await completeParentSignin(r.parentId, ip, session.id);
      if (sessionEnded) return ctx.json({ ok: false, error: "rejected" });   // ended while it was being made: no cookie for it
      // The cookie is sent this once and has to outlive the session row, which use renews (sessions.ts).
      await setSessionCookie(ctx, { session, user }, false, { maxAge: PARENT_SESSION_COOKIE_SECONDS });
      return ctx.json({ ok: true, next: familyQboId ? landingPath(ctx.body.next) : withReturnPath("/choose-family", ctx.body.next) });
    }),
  },
}) satisfies BetterAuthPlugin;
