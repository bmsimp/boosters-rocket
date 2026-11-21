"use server";
import { beforeSignInAction } from "@/lib/guards";
import { signInFromLink } from "@/lib/auth/parent-link-signin";
import { PASSWORD_COPY } from "@/lib/parents/password-copy";
import { choosePasswordFromLink, type PasswordSetResult } from "@/lib/parents/password-set";
import { askForPasswordLink } from "@/lib/parents/password-request";

/**
 * The form of a set-up or reset link (./set-up/[token], ./reset/[token]): an action taken before signing in. No
 * session: the link is the guard (beforeSignInAction, src/lib/guards.ts). Every argument comes from the browser,
 * whatever its type says, and choosePasswordFromLink() checks each (the purpose, the token's shape, two strings of a
 * bounded length), limits the tries per address and per link, and answers every refusal of the link the same way.
 *
 * A set-up while the club's level is Standard then signs the parent in, through the one finish every sign-in goes
 * through (signInFromLink(), src/lib/auth/parent-link-signin.ts), and answers where to go (`next`); under Strict, since
 * slice SI-10a, a set-up for a person with no second factor signs them in as Strict's enrolment, landing on
 * /one-more-step. If that finish refuses, the password stays set and the answer is the one a reset gets: the password
 * is set, and sign in. A reset, and a set-up under Strict for a person who holds a second factor, sign nobody in. The
 * proof the set made never leaves the server.
 */
export const choosePasswordAction = beforeSignInAction(async (ctx, purpose: unknown, token: unknown, password: unknown, again: unknown): Promise<PasswordSetResult> => {
  const r = await choosePasswordFromLink({ purpose, token, password, again }, { ip: ctx.ip });
  if (!r.ok) return r;
  const next = r.signIn ? await signInFromLink(r.signIn) : null;
  return next ? { ok: true, message: PASSWORD_COPY.signingIn, next } : { ok: true, message: r.message };
});

/**
 * The page "Set up or reset my password" (./password): an action taken before signing in, whose guard is its limits
 * and its one answer. It takes an email address, whatever the browser sends, and always answers with the same words,
 * whatever the address and whatever happened, a failure included; askForPasswordLink() (src/lib/parents/
 * password-request.ts) checks the argument, limits the asks per IP address and per address, and mails a set-up or reset
 * link only to a person the portal may mail. The mail is not waited for.
 */
export const askPasswordLinkAction = beforeSignInAction(async (ctx, email: unknown): Promise<{ ok: true; message: string }> => {
  try {
    const { delivery } = await askForPasswordLink(email, ctx.ip);
    void delivery;
  } catch {
    // Audited where it can be; the answer is the same either way.
  }
  return { ok: true, message: PASSWORD_COPY.askAnswer };
});
