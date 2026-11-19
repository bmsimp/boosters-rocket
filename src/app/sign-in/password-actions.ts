"use server";
import { beforeSignInAction } from "@/lib/guards";
import { choosePasswordFromLink } from "@/lib/parents/password-set";

/**
 * The form of a set-up or reset link (./set-up/[token], ./reset/[token]): the portal's one action taken before signing
 * in. No session: the link is the guard (beforeSignInAction, src/lib/guards.ts). Every argument comes from the browser,
 * whatever its type says, and choosePasswordFromLink() checks each (the purpose, the token's shape, two strings of a
 * bounded length), limits the tries per address and per link, and answers every refusal of the link the same way.
 * Nothing here signs anyone in.
 */
export const choosePasswordAction = beforeSignInAction(async (ctx, purpose: unknown, token: unknown, password: unknown, again: unknown) =>
  choosePasswordFromLink({ purpose, token, password, again }, { ip: ctx.ip }));
