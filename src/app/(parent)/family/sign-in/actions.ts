"use server";
import { revalidatePath } from "next/cache";
import { parentAction } from "@/lib/guards";
import { askAgainCode, askAgainPassword } from "@/lib/parents/asking-again";
import { askMySetupLink, changeMyPassword, signOutEverywhere } from "@/lib/parents/signin-settings";

/**
 * A parent's sign-in settings (src/lib/parents/signin-settings.ts) and asking again (src/lib/parents/asking-again.ts).
 *
 * Every argument comes from the browser, whatever its type says, and is handed on as it is, to be checked there for its
 * type and size. None names a person, a session, a family or a customer, and none is looked for: whose password, whose
 * sessions and whose code are decided from the session (ctx) alone. The one value the server made is the stamp asking
 * again hands the page between the password and the code, and it is checked against this session and person.
 *
 * Only a proof revalidates, since it changes what the pages draw (the change form in place of the asking). A password
 * changed and a press of "Sign out everywhere" end this session too, so drawing the page again would only send the
 * parent to sign in before they had read the answer; the answer itself offers the way there.
 */
export const askAgainPasswordAction = parentAction(async (ctx, password: string) => askAgainPassword(ctx, password as unknown));

export const askAgainCodeAction = parentAction(async (ctx, stamp: string, code: string) => {
  const result = await askAgainCode(ctx, stamp as unknown, code as unknown);
  if (result.ok) for (const path of ["/family/sign-in", "/family/email"]) revalidatePath(path);
  return result;
});

export const changePasswordAction = parentAction(async (ctx, password: string, again: string) =>
  changeMyPassword(ctx, { password: password as unknown, again: again as unknown }));

export const signOutEverywhereAction = parentAction(async (ctx) => signOutEverywhere(ctx));

export const askSetupLinkAction = parentAction(async (ctx) => askMySetupLink(ctx));
