"use server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { parentAction } from "@/lib/guards";
import { NOT_YOUR_FORM, agreeToSign, checkMyForm, startMyFormAgain, type FormActionResult } from "@/lib/forms/signing";

/**
 * What a guardian does on a form's page (v1 spec §9.2). Each action takes the id of the request from the page's
 * address. After an action that worked, the pages that show the form are revalidated, and Next.js draws the page the
 * guardian is on again in the same answer: the page never asks for itself a second time (two draws at once would
 * both try to make the form's document).
 * The id comes from the browser, whatever its type says: it is checked here for type and size, and the library
 * looks it up within the session's family (findMyForm), so an id that is another family's, or nobody's, gets the same
 * refusal and changes nothing. Whose signature this is comes from the session alone.
 */
const idFrom = (value: unknown): string | null => (typeof value === "string" && value.length <= 64 ? value : null);
// The pages that say how a form stands: the list, the form itself, and the lines on Home and Season.
function shown(): void {
  for (const path of ["/forms", "/", "/season"]) revalidatePath(path);
  revalidatePath("/forms/[id]", "page");
}

/** "I agree to sign electronically": records the consent. The next draw of the page makes the document and shows it. */
export const agreeToSignAction = parentAction(async (ctx, requestId: string): Promise<FormActionResult> => {
  const id = idFrom(requestId);
  if (!id) return NOT_YOUR_FORM;
  const result = await agreeToSign(ctx, id, (await headers()).get("user-agent"));
  if (result.ok) shown();
  return result;
});

/**
 * Asks Documenso how the form stands and stores what it says. The page calls it when the signing frame says this
 * guardian has finished: that message alone records nothing. `settled` is false while the signed copy is still being
 * finished, so the page knows to ask again.
 */
export const checkFormAction = parentAction(async (ctx, requestId: string): Promise<FormActionResult & { settled?: boolean }> => {
  const id = idFrom(requestId);
  if (!id) return NOT_YOUR_FORM;
  const { state, ...result } = await checkMyForm(ctx, id);
  if (!result.ok) return result;
  // Drawn again whatever the answer: the webhook or the worker may have stored it a moment before this asked.
  shown();
  return { ...result, settled: state !== "signed" };
});

/** Starts a declined form again, so it can be signed after all. */
export const startFormAgainAction = parentAction(async (ctx, requestId: string): Promise<FormActionResult> => {
  const id = idFrom(requestId);
  if (!id) return NOT_YOUR_FORM;
  const result = await startMyFormAgain(ctx, id);
  if (result.ok) shown();
  return result;
});
