import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { z } from "zod";
import { clientIpFrom } from "@/lib/request";
import { requestSigninCode, verifySigninCode } from "@/lib/parents/signin-codes";
import { MAX_RETURN_PATH } from "./return-path";
import { finishParentSignin } from "./parent-signin-finish";

type Ctx = { headers?: Headers; request?: Request };
const ipOf = (ctx: Ctx) => { const h = ctx.headers ?? ctx.request?.headers; return h ? clientIpFrom(h) : null; };

/**
 * The portal's email-code door (spec §1). Codes, tries and limits are portal code (src/lib/parents/signin-codes.ts);
 * Better Auth only makes the session and its cookie, in the one finish every sign-in goes through (finishParentSignin(),
 * parent-signin-finish.ts), which only this plugin's endpoints call. Better Auth's own sign-up is never reachable: the
 * only ways in are a code, or a set-up link's new password, for an existing person, whose auth user the portal made
 * with them.
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
      // Everything after the code is checked is the one finish every sign-in goes through (parent-signin-finish.ts).
      const done = await finishParentSignin(ctx, { parentId: r.parentId, email: ctx.body.email, proof: { codeId: r.codeId }, ip, next: ctx.body.next });
      return ctx.json(done.ok ? { ok: true, next: done.next } : { ok: false, error: "rejected" });
    }),
  },
}) satisfies BetterAuthPlugin;
