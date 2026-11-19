import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { z } from "zod";
import { clientIpFrom } from "@/lib/request";
import { refuseCodeWithoutStep, sendSecondStepCode, verifySigninCode } from "@/lib/parents/signin-codes";
import { checkPasswordSignin, MOST_TYPED_ADDRESS, MOST_TYPED_PASSWORD } from "@/lib/parents/password-signin";
import { MAX_RETURN_PATH } from "./return-path";
import { finishParentSignin } from "./parent-signin-finish";
import { clearPendingStep, pendingStepEnd, readDeviceToken, readPendingStep, setPendingStep } from "./parent-signin-step";

type Ctx = { headers?: Headers; request?: Request };
const ipOf = (ctx: Ctx) => { const h = ctx.headers ?? ctx.request?.headers; return h ? clientIpFrom(h) : null; };
const REJECTED = { ok: false, error: "rejected" } as const;

/**
 * The portal's parent door (spec §1, and the sign-in release, slice SI-3b). A sign-in is the address and the password,
 * checked by portal code (checkPasswordSignin(), src/lib/parents/password-signin.ts), then, on a device the portal
 * doesn't remember for the person, the emailed code (signin-codes.ts), through a pending step that only a right password
 * makes (parent-signin-step.ts): a code with no pending step this server signed signs nobody in. Better Auth only makes
 * the session and its cookie, in the one finish every sign-in goes through (finishParentSignin(),
 * parent-signin-finish.ts), which only this plugin's endpoints call. The endpoints are named off /sign-in, so the
 * library's own rule of 3 tries in 10 seconds for /sign-in paths never meets them (their caps are customRules in
 * parent-auth.ts). Better Auth's own sign-up and password routes are never reachable: the only ways in are a password
 * and a second step, or a set-up link's new password, for an existing person, whose auth user the portal made with them.
 */
export const parentCodePlugin = () => ({
  id: "booster-parent-code",
  endpoints: {
    portalPasswordCheck: createAuthEndpoint("/portal-password/check", {
      // `next` is the page the parent asked for before signing in. It comes from the browser: it is only ever used
      // through landingPath() and withReturnPath(), which drop anything that is not a parent page of this site.
      method: "POST",
      body: z.object({ email: z.string().max(MOST_TYPED_ADDRESS), password: z.string().max(MOST_TYPED_PASSWORD), next: z.string().max(MAX_RETURN_PATH).optional() }),
    }, async (ctx) => {
      const ip = ipOf(ctx);
      const now = new Date();
      const r = await checkPasswordSignin(ctx.body.email, ctx.body.password, readDeviceToken(ctx), ip, now);
      if (!r.ok) return ctx.json(REJECTED);
      if (r.device) {
        // A device the portal remembers for this person: the password and the device are the proof, and no code is asked.
        const done = await finishParentSignin(ctx, { parentId: r.person.id, email: r.person.email, proof: { password: r.password, deviceId: r.device.deviceId }, ip, next: ctx.body.next });
        return ctx.json(done.ok ? { ok: true, next: done.next } : REJECTED);
      }
      // Any other device: the second step. Its answer never says what happened to the mail (spec §12 invariant 9), and
      // doesn't wait for it.
      // A code that could not be sent because the step can't go on (a block or an address change landing just now) sets
      // no pending step; the answer is the same.
      // The step and its first code end together (pendingStepEnd()).
      const endsAt = pendingStepEnd(now);
      const { delivery, ended } = await sendSecondStepCode({ parentId: r.person.id, email: r.person.email, password: r.password, endsAt }, ip, now);
      void delivery;
      if (!ended) await setPendingStep(ctx, { parentId: r.person.id, email: r.person.email, ...r.password, endsAt }, now);
      return ctx.json({ ok: true, step: "code" });
    }),
    // The code again, for the pending step's person; nothing the browser sends names anyone. Always the same answer. The
    // step is not extended: the code resent ends when it does (sendSecondStepCode(), which says so in its mail and sends
    // none in the step's last minute).
    portalCodeResend: createAuthEndpoint("/portal-code/resend", { method: "POST" }, async (ctx) => {
      const now = new Date();
      const step = await readPendingStep(ctx, now);
      if (step) {
        const { delivery, ended } = await sendSecondStepCode({ parentId: step.parentId, email: step.email,
          password: { credentialId: step.credentialId, credentialUpdatedAt: step.credentialUpdatedAt }, endsAt: step.endsAt }, ipOf(ctx), now);
        void delivery;
        if (ended) clearPendingStep(ctx);
      }
      return ctx.json({ ok: true });
    }),
    portalCodeCheck: createAuthEndpoint("/portal-code/check", {
      method: "POST", body: z.object({ code: z.string().max(20), next: z.string().max(MAX_RETURN_PATH).optional() }),
    }, async (ctx) => {
      const ip = ipOf(ctx);
      const now = new Date();
      const step = await readPendingStep(ctx, now);
      if (!step) {
        const why = await refuseCodeWithoutStep(ip, now);
        return ctx.json({ ok: false, error: why });
      }
      const r = await verifySigninCode({ parentId: step.parentId, email: step.email,
        password: { credentialId: step.credentialId, credentialUpdatedAt: step.credentialUpdatedAt } }, ctx.body.code, ip, now);
      if (!r.ok) {
        if (r.ended) clearPendingStep(ctx);
        return ctx.json({ ok: false, error: r.reason });
      }
      // Everything after the code is checked is the one finish every sign-in goes through (parent-signin-finish.ts).
      const done = await finishParentSignin(ctx, { parentId: step.parentId, email: step.email, ip, next: ctx.body.next,
        proof: { password: { credentialId: step.credentialId, credentialUpdatedAt: step.credentialUpdatedAt }, codeId: r.codeId } });
      if (!done.ok) clearPendingStep(ctx); // the code is spent: the step can't go on
      return ctx.json(done.ok ? { ok: true, next: done.next } : REJECTED);
    }),
    // A set-up link's sign-in (the sign-in release, slice SI-3a): the link form's action has set the password and holds
    // the proof of what it spent (choosePasswordFromLink(), password-set.ts), and finishes the sign-in here, through the
    // same finish, by auth.api from portal code (signInFromLink(), parent-link-signin.ts). Server only: it has no path,
    // so the router serves it to nobody (tests/integration/parent-door.test.ts lists every reachable path), and nothing a
    // browser sends reaches its body. The parent lands on their page or the chooser, and since slice SI-3b the device it
    // was used on is remembered, since the link proved the mailbox and its form set the password.
    finishLinkSignin: createAuthEndpoint.serverOnly({
      method: "POST",
      body: z.object({ parentId: z.string(), email: z.string(), linkId: z.string(), credentialId: z.string(), credentialUpdatedAt: z.number() }),
    }, async (ctx) => {
      const b = ctx.body;
      const proof = { link: { linkId: b.linkId, credentialId: b.credentialId, credentialUpdatedAt: new Date(b.credentialUpdatedAt) } };
      return ctx.json(await finishParentSignin(ctx, { parentId: b.parentId, email: b.email, proof, ip: ipOf(ctx) }));
    }),
  },
}) satisfies BetterAuthPlugin;
