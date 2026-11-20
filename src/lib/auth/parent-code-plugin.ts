import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { z } from "zod";
import { clientIpFrom } from "@/lib/request";
import { refuseCodeWithoutStep, sendSecondStepCode, verifySecondFactor, verifySigninCode, type SecondFactorProof } from "@/lib/parents/signin-codes";
import { checkPasswordSignin, MOST_TYPED_ADDRESS, MOST_TYPED_PASSWORD } from "@/lib/parents/password-signin";
import { MAX_RETURN_PATH } from "./return-path";
import { finishParentSignin } from "./parent-signin-finish";
import { clearPendingStep, pendingStepEnd, readDeviceToken, readPendingStep, setPendingStep, type PendingStep } from "./parent-signin-step";

type Ctx = { headers?: Headers; request?: Request };
const ipOf = (ctx: Ctx) => { const h = ctx.headers ?? ctx.request?.headers; return h ? clientIpFrom(h) : null; };
const REJECTED = { ok: false, error: "rejected" } as const;
const LIMITED = { ok: false, error: "rate_limited" } as const;

/**
 * The end of a second step that went through, the emailed code's (/portal-code/check) and, since slice SI-6a, the
 * authenticator app's or a backup code's (/portal-app/check) alike: the one finish every sign-in goes through, with the
 * pending step's person and password and what the step spent as the proof; refused, the pending step is cleared, since
 * what it spent can't be used again.
 */
async function finishSecondStep(ctx: GenericEndpointContext, step: PendingStep, spent: { codeId: string } | SecondFactorProof,
  ip: string | null, next: string | undefined) {
  const done = await finishParentSignin(ctx, { parentId: step.parentId, email: step.email, ip, next,
    proof: { password: { credentialId: step.credentialId, credentialUpdatedAt: step.credentialUpdatedAt }, ...spent } });
  if (!done.ok) clearPendingStep(ctx);
  return done.ok ? { ok: true as const, next: done.next } : REJECTED;
}

/**
 * The portal's parent door (spec §1, and the sign-in release, slice SI-3b). A sign-in is the address and the password,
 * checked by portal code (checkPasswordSignin(), src/lib/parents/password-signin.ts), then, on a device the portal
 * doesn't remember for the person, the second step, through a pending step that only a right password makes
 * (parent-signin-step.ts): the emailed code (signin-codes.ts), or, since slice SI-6a, for a person with an authenticator
 * app in force, its code or a backup code (verifySecondFactor()); a code of either kind with no pending step this server
 * signed signs nobody in. Better Auth only makes
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
      // The request's signal: a try whose client has gone leaves the wait for a password check (inTurn()).
      const r = await checkPasswordSignin(ctx.body.email, ctx.body.password, readDeviceToken(ctx), ip, new Date(), ctx.request?.signal);
      // Over a limit, or turned away by a full wait for a check, the page says so; the count was taken by what the
      // visitor sent alone, so it is the same for an address on file and one that isn't. Every other refusal is one answer.
      if (!r.ok) return ctx.json(r.limited ? LIMITED : REJECTED);
      // What follows is timed from when the check finished (r.at), so a wait for its turn never shortens the step.
      const now = r.at;
      if (r.device) {
        // A device the portal remembers for this person: the password and the device are the proof, and no code is asked.
        const done = await finishParentSignin(ctx, { parentId: r.person.id, email: r.person.email, proof: { password: r.password, deviceId: r.device.deviceId }, ip, next: ctx.body.next });
        return ctx.json(done.ok ? { ok: true, next: done.next } : REJECTED);
      }
      // Any other device: the second step. The step and its first code end together (pendingStepEnd()).
      const endsAt = pendingStepEnd(now);
      if (r.step === "second_factor") {
        // A person with an authenticator app in force (the sign-in release, slice SI-6a; open question 24) is never sent
        // the emailed code: the same pending step is set, and their app's code or a backup code is checked at
        // /portal-app/check.
        await setPendingStep(ctx, { parentId: r.person.id, email: r.person.email, ...r.password, endsAt }, now);
        return ctx.json({ ok: true, step: "app" });
      }
      // The emailed code. Its answer never says what happened to the mail (spec §12 invariant 9), and doesn't wait for it.
      // A code that could not be sent because the step can't go on (a block or an address change landing just now) sets
      // no pending step; the answer is the same.
      // An app that came into force after the password's reads (the send reads it again under the person's lock) sends
      // nothing, and the app is asked for instead, with the same pending step.
      const { delivery, ended, app } = await sendSecondStepCode({ parentId: r.person.id, email: r.person.email, password: r.password, endsAt }, ip, now);
      void delivery;
      if (!ended) await setPendingStep(ctx, { parentId: r.person.id, email: r.person.email, ...r.password, endsAt }, now);
      return ctx.json({ ok: true, step: app ? "app" : "code" });
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
      return ctx.json(await finishSecondStep(ctx, step, { codeId: r.codeId }, ip, ctx.body.next));
    }),
    // The second step of a person with an authenticator app in force (the sign-in release, slice SI-6a): the app's
    // six-digit code, or one of their backup codes, for the pending step's person alone, as /portal-code/check takes the
    // emailed code. With no pending step it signs nobody in (refuseCodeWithoutStep(), counted and audited as a code with
    // none is). The check (verifySecondFactor(), signin-codes.ts) has its own limits, replay guard and rows; a right one
    // goes through the one finish with its proof, so the device is remembered and the session proved strong.
    portalAppCheck: createAuthEndpoint("/portal-app/check", {
      method: "POST", body: z.object({ code: z.string().max(20), next: z.string().max(MAX_RETURN_PATH).optional() }),
    }, async (ctx) => {
      const ip = ipOf(ctx);
      const now = new Date();
      const step = await readPendingStep(ctx, now);
      if (!step) {
        const why = await refuseCodeWithoutStep(ip, now);
        return ctx.json({ ok: false, error: why });
      }
      const r = await verifySecondFactor({ parentId: step.parentId, email: step.email,
        password: { credentialId: step.credentialId, credentialUpdatedAt: step.credentialUpdatedAt } }, ctx.body.code, ip, now);
      if (!r.ok) {
        if (r.ended) clearPendingStep(ctx);
        return ctx.json({ ok: false, error: r.reason });
      }
      return ctx.json(await finishSecondStep(ctx, step, r.proof, ip, ctx.body.next));
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
