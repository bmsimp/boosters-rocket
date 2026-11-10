import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parentAuthUser } from "@/lib/db/schema";
import { clientIpFrom } from "@/lib/request";
import { requestSigninCode, verifySigninCode } from "@/lib/parents/signin-codes";
import { completeParentSignin } from "@/lib/parents/family-choice";

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
      method: "POST", body: z.object({ email: z.string().max(320), code: z.string().max(20) }),
    }, async (ctx) => {
      const ip = ipOf(ctx);
      const r = await verifySigninCode(ctx.body.email, ctx.body.code, ip);
      if (!r.ok) return ctx.json({ ok: false, error: r.reason });
      const [u] = await db.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, r.parentId));
      const user = u ? await ctx.context.internalAdapter.findUserById(u.id) : null;
      if (!user) return ctx.json({ ok: false, error: "rejected" });
      const { familyQboId } = await completeParentSignin(r.parentId, ip);
      const session = await ctx.context.internalAdapter.createSession(user.id, false, { familyQboId });
      await setSessionCookie(ctx, { session, user });
      return ctx.json({ ok: true, next: familyQboId ? "/" : "/choose-family" });
    }),
  },
}) satisfies BetterAuthPlugin;
