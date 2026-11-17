"use server";
import { parentAction } from "@/lib/guards";
import { confirmMyEmailChange, requestMyEmailChange } from "@/lib/parents/email-change";

/**
 * A parent's change of the address they sign in with (src/lib/parents/email-change.ts).
 *
 * Both take what the browser sent, whatever its type says, and hand it on as it is: the new address from the form's
 * one field, and the token from the link. Neither names a customer or a person, and none is looked for: whose record
 * and whose request are decided from the session (ctx) alone.
 *
 * Neither revalidates a page. A confirmation that was made ends the person's sessions, so drawing the page again would
 * only send them to sign in before they had read the answer; the answer itself offers the way there.
 */
export const requestEmailChangeAction = parentAction(async (ctx, form: FormData) => {
  const sent = form as unknown;
  return requestMyEmailChange(ctx, sent instanceof FormData ? sent.get("email") : undefined);
});

export const confirmEmailChangeAction = parentAction(async (ctx, token: string) => confirmMyEmailChange(ctx, token as unknown));
