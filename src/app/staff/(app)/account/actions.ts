"use server";
import { revalidatePath } from "next/cache";
import { staffSelfAction } from "@/lib/guards";
import { setOwnContactEmail } from "@/lib/staff/contact-email";

/**
 * The staff member's own contact email, shown to families beside their messages (club messages): an address, or null to
 * go back to their sign-in address. It takes no id: the record is the session's own. setOwnContactEmail() checks the
 * value's type and size, whatever the browser sent.
 */
export const setMyContactEmailAction = staffSelfAction(async (ctx, email: unknown) => {
  const r = await setOwnContactEmail(ctx.staffUserId, email, { actor: { door: "staff", id: ctx.staffUserId, label: ctx.email }, ip: ctx.ip });
  if (r.ok) revalidatePath("/staff/account");
  return r;
});
