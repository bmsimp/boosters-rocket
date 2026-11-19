"use server";
import { revalidatePath } from "next/cache";
import { parentAction } from "@/lib/guards";
import { confirmMyBuyout, switchMyBuyoutBack } from "@/lib/buyouts/writes";

/**
 * Paying instead of volunteering, and switching back (v1 spec §11.5). Every argument comes from the browser, whatever
 * its type says: the requirement id, the choice key the page was given for one of the family's own subjects, and the
 * stamp of the quote it showed (to switch back, the stamp of the subject it showed). The library checks each one's type and size, finds the requirement and the subject
 * within the session's family, and works the amount out again; nothing sent here names a customer, an item or an
 * amount. Every page that shows the requirement or the family's money is shown again afterward.
 */
export const confirmBuyoutAction = parentAction(async (ctx, requirementId: unknown, key: unknown, stamp: unknown) => {
  const r = await confirmMyBuyout(ctx, requirementId, key, stamp);
  revalidatePath("/", "layout");
  return r;
});

export const switchBackAction = parentAction(async (ctx, requirementId: unknown, key: unknown, stamp: unknown) => {
  const r = await switchMyBuyoutBack(ctx, requirementId, key, stamp);
  revalidatePath("/", "layout");
  return r;
});
