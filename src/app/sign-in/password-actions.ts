"use server";
import { beforeSignInAction } from "@/lib/guards";
import { signInFromLink } from "@/lib/auth/parent-link-signin";
import { PASSWORD_COPY } from "@/lib/parents/password-copy";
import { choosePasswordFromLink, type PasswordSetResult } from "@/lib/parents/password-set";

/**
 * The form of a set-up or reset link (./set-up/[token], ./reset/[token]): an action taken before signing in. No
 * session: the link is the guard (beforeSignInAction, src/lib/guards.ts). Every argument comes from the browser,
 * whatever its type says, and choosePasswordFromLink() checks each (the purpose, the token's shape, two strings of a
 * bounded length), limits the tries per address and per link, and answers every refusal of the link the same way.
 *
 * A set-up while the club's level is Standard then signs the parent in, through the one finish every sign-in goes
 * through (signInFromLink(), src/lib/auth/parent-link-signin.ts), and answers where to go (`next`). If that finish
 * refuses, the password stays set and the answer is the one a reset gets: the password is set, and sign in. A reset,
 * and a set-up under Strict, sign nobody in. The proof the set made never leaves the server.
 */
export const choosePasswordAction = beforeSignInAction(async (ctx, purpose: unknown, token: unknown, password: unknown, again: unknown): Promise<PasswordSetResult> => {
  const r = await choosePasswordFromLink({ purpose, token, password, again }, { ip: ctx.ip });
  if (!r.ok) return r;
  const next = r.signIn ? await signInFromLink(r.signIn) : null;
  return next ? { ok: true, message: PASSWORD_COPY.signingIn, next } : { ok: true, message: r.message };
});

