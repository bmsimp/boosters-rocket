import type { BetterAuthPlugin, GenericEndpointContext } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { z } from "zod";
import { clientIpFrom } from "@/lib/request";
import { refuseCodeWithoutStep, sendSecondStepCode, verifySecondFactor, verifySigninCode, type SecondFactorProof } from "@/lib/parents/signin-codes";
import { checkPasskeySignin } from "@/lib/parents/passkey-signin";
import { checkPasswordSignin, MOST_TYPED_ADDRESS, MOST_TYPED_PASSWORD } from "@/lib/parents/password-signin";
import { getParentSettings, parentDoorClosed } from "@/lib/parents/settings";
import { MAX_RETURN_PATH } from "./return-path";
import { finishParentSignin } from "./parent-signin-finish";
import { clearPendingStep, pendingStepEnd, readDeviceToken, readPendingStep, setPendingStep, type PendingStep } from "./parent-signin-step";
import { verifyAssertion } from "./passkey-check";

/** The passkey library's challenge, the one library path the door leaves open that writes a row (parent-auth.ts). */
export const PASSKEY_CHALLENGE_PATH = "/passkey/generate-authenticate-options";
/**
 * Better Auth's own answer for a path the portal turned off (its router's onRequest, for PARENT_DISABLED_PATHS): the
 * challenge answers it while the parent door is closed, the same as the library's six other passkey paths always do.
 */
const notFound = () => new Response("Not Found", { status: 404 });

type Ctx = { headers?: Headers; request?: Request };
const ipOf = (ctx: Ctx) => { const h = ctx.headers ?? ctx.request?.headers; return h ? clientIpFrom(h) : null; };
const REJECTED = { ok: false, error: "rejected" } as const;
const LIMITED = { ok: false, error: "rate_limited" } as const;

/**
 * The end of a second step that went through, the emailed code's (/portal-code/check), since slice SI-6a the
 * authenticator app's or a backup code's (/portal-app/check) and since slice SI-7a a passkey's after a password
 * (/portal-passkey/check) alike: the one finish every sign-in goes through, with the
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
 * app in force, its code or a backup code (verifySecondFactor()), or, since slice SI-7a, for a person with a passkey, the
 * passkey (checkPasskeySignin(), passkey-signin.ts); a code of either kind with no pending step this server signed signs
 * nobody in. A passkey also signs in alone, with no address asked and no password (open questions 30 and 35): the
 * browser offers it, and its own unlock is the second step. Better Auth only makes
 * the session and its cookie, in the one finish every sign-in goes through (finishParentSignin(),
 * parent-signin-finish.ts), which only this plugin's endpoints call. The endpoints are named off /sign-in, so the
 * library's own rule of 3 tries in 10 seconds for /sign-in paths never meets them (their caps are customRules in
 * parent-auth.ts). Better Auth's own sign-up and password routes are never reachable: the only ways in are a password
 * and a second step, or a set-up link's new password, for an existing person, whose auth user the portal made with them.
 */
export const parentCodePlugin = () => ({
  id: "booster-parent-code",
  // The passkey library's challenge (slice SI-7a) writes a row of parent_auth_verification for every visitor who asks,
  // so while the parent door is closed (parentDoorClosed(), sign-ins switched off) it is refused before the library
  // runs, after Better Auth's in-memory cap (customRules, parent-auth.ts), with the answer a disabled path gives: no
  // row, no cookie, and no answer of its own to say why. The door's own endpoints refuse with their one answer.
  onRequest: async (request: Request, context: { baseURL: string }) => {
    if (new URL(request.url).pathname !== `${new URL(context.baseURL).pathname}${PASSKEY_CHALLENGE_PATH}`) return;
    if (parentDoorClosed(await getParentSettings())) return { response: notFound() };
  },
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
        // A person with an authenticator app in force (the sign-in release, slice SI-6a; open question 24), or a passkey
        // (slice SI-7a), is never sent the emailed code: the same pending step is set, and they are asked for all they
        // have, the passkey first (/portal-passkey/check), with their app's code or a backup code beside it when they
        // have an app too (`app`, /portal-app/check).
        await setPendingStep(ctx, { parentId: r.person.id, email: r.person.email, ...r.password, endsAt }, now);
        return ctx.json(r.factors.passkey ? { ok: true, step: "passkey", app: r.factors.app } : { ok: true, step: "app" });
      }
      // The emailed code. Its answer never says what happened to the mail (spec §12 invariant 9), and doesn't wait for it.
      // A code that could not be sent because the step can't go on (a block or an address change landing just now) sets
      // no pending step; the answer is the same.
      // An app or a passkey that came into force after the password's reads (the send reads them again under the
      // person's lock) sends nothing, and that is asked for instead, with the same pending step.
      const { delivery, ended, app, passkey } = await sendSecondStepCode({ parentId: r.person.id, email: r.person.email, password: r.password, endsAt }, ip, now);
      void delivery;
      if (!ended) await setPendingStep(ctx, { parentId: r.person.id, email: r.person.email, ...r.password, endsAt }, now);
      return ctx.json(passkey ? { ok: true, step: "passkey", app: app === true } : { ok: true, step: app ? "app" : "code" });
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
        // A refusal that ends the step says only that (`ended`), whatever ended it (the app turned off since, a block, the
        // password or the address changed), so the page goes back to the password step (slice SI-6b, decision 10).
        if (r.ended) clearPendingStep(ctx);
        return ctx.json(r.ended ? { ok: false, error: r.reason, ended: true } : { ok: false, error: r.reason });
      }
      return ctx.json(await finishSecondStep(ctx, step, r.proof, ip, ctx.body.next));
    }),
    // A passkey (the sign-in release, slice SI-7a; open questions 24, 30 and 35): the assertion the passkey library's
    // browser ceremony made, for a challenge from /passkey/generate-authenticate-options, posted here instead of to the
    // library's own verify path (which is disabled, and whose session the instance's guard refuses). `next` and `alone`
    // ride in the query string, beside the body the library's ceremony builds ({ response }). The first screen's "Sign in
    // with a passkey" says `alone=1`: it signs in alone, and a pending step the browser still carries (a right password
    // whose step was left, by Start again or by going away, on a shared device perhaps somebody else's) is cleared and
    // never read, so it can't turn another person's passkey into a refused second step. The passkey step's own button
    // sends no `alone`: with a pending step it is the step's second step and must be its person's; with none it signs in
    // alone. The check (checkPasskeySignin()) has its own
    // limit, order and rows, and runs the library's verification in process (verifyAssertion(), passkey-check.ts); a
    // passkey that went through ends in the one finish, so the device is remembered and the session proved strong.
    portalPasskeyCheck: createAuthEndpoint("/portal-passkey/check", {
      method: "POST", body: z.looseObject({}), query: z.looseObject({}).optional(),
    }, async (ctx) => {
      const ip = ipOf(ctx);
      const now = new Date();
      // `next` from the query string: absent, or a string of at most MAX_RETURN_PATH; `alone`: absent, or "1". Anything
      // else is the one refusal, uncounted, as a body the other endpoints' schemas refuse is.
      const rawNext = ctx.query?.next;
      if (rawNext !== undefined && (typeof rawNext !== "string" || rawNext.length > MAX_RETURN_PATH)) return ctx.json(REJECTED);
      const rawAlone = ctx.query?.alone;
      if (rawAlone !== undefined && rawAlone !== "1") return ctx.json(REJECTED);
      const next = typeof rawNext === "string" ? rawNext : undefined;
      const left = await readPendingStep(ctx, now);
      // Alone, a step left in the browser ends here: nothing of it is read.
      if (rawAlone === "1" && left) clearPendingStep(ctx);
      const step = rawAlone === "1" ? null : left;
      const headers = ctx.headers ?? ctx.request?.headers ?? new Headers();
      const r = await checkPasskeySignin(ctx.body.response,
        step ? { parentId: step.parentId, email: step.email, password: { credentialId: step.credentialId, credentialUpdatedAt: step.credentialUpdatedAt } } : null,
        (assertion) => verifyAssertion(headers, assertion), ip, now);
      if (!r.ok) {
        // A refusal that ends the step says only that (`ended`), as /portal-app/check does, so the page goes back to the
        // password step; a passkey's other refusals keep it.
        if (r.ended) clearPendingStep(ctx);
        return ctx.json(r.ended ? { ok: false, error: r.reason, ended: true } : { ok: false, error: r.reason });
      }
      if (step) return ctx.json(await finishSecondStep(ctx, step, r.proof, ip, next));
      const done = await finishParentSignin(ctx, { parentId: r.person.id, email: r.person.email, proof: r.proof, ip, next });
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
