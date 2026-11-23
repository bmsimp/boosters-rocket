import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { staffUser } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";
import { normalizeEmail } from "@/lib/email";

/**
 * The address parents see on a staff member's profile beside their messages (club messages, spec section 4): their
 * sign-in address until they set another, such as a club mailbox. Only the staff member themself changes it, from Your
 * account, through a staffSelfAction that takes no id. Stored trimmed and lower-cased in `staff_user.contact_email`;
 * null means the sign-in address, and so does an address set to the sign-in address itself, so a later change of sign-in
 * address is followed.
 */
export const CONTACT_EMAIL_MAX = 254;
const NOT_FROM_PAGE = "That didn't go through. Reload the page and try again.";

/** The address shown to families: the contact email when one is set, else the sign-in address. Pure. */
export const shownContactEmail = (s: { email: string; contactEmail: string | null }): string => s.contactEmail ?? s.email;

/** A staff member's own contact email for Your account: the address shown, and whether it is one they set. */
export async function ownContactEmail(staffUserId: string): Promise<{ shown: string; own: boolean } | null> {
  const [me] = await db.select({ email: staffUser.email, contactEmail: staffUser.contactEmail }).from(staffUser).where(eq(staffUser.id, staffUserId));
  return me ? { shown: shownContactEmail(me), own: me.contactEmail !== null } : null;
}

/**
 * Sets the staff member's own contact email, or with `null` goes back to their sign-in address, audited with before
 * and after in the same transaction (`permission` null: their own record). Saving what is already shown writes nothing.
 */
export async function setOwnContactEmail(staffUserId: string, raw: unknown, o: { actor: Actor; ip: string | null }):
  Promise<{ ok: true; message: string } | { ok: false; errors: string[] }> {
  let typed: string | null;
  if (raw === null) typed = null;
  else if (typeof raw !== "string" || raw.length > 1000) return { ok: false, errors: [NOT_FROM_PAGE] };
  else {
    if (raw.trim() === "") return { ok: false, errors: ["Enter an email address, or use your sign-in address."] };
    typed = normalizeEmail(raw);
    if (typed === null || typed.length > CONTACT_EMAIL_MAX) return { ok: false, errors: ["That isn't an email address we can use. Check it and try again."] };
  }
  return db.transaction(async (tx) => {
    const [me] = await tx.select().from(staffUser).where(eq(staffUser.id, staffUserId)).for("update");
    if (!me) return { ok: false as const, errors: [NOT_FROM_PAGE] };
    const next = typed === null || typed === me.email ? null : typed;
    const message = next === null ? "Saved. Families see your sign-in address." : "Saved. Families see this address.";
    if (next === me.contactEmail) return { ok: true as const, message };
    await tx.update(staffUser).set({ contactEmail: next, updatedAt: new Date() }).where(eq(staffUser.id, staffUserId));
    await writeAudit({ actor: o.actor, action: "staff.contact_email.change", targetType: "staff_user", targetId: staffUserId,
      before: { contactEmail: shownContactEmail(me), own: me.contactEmail !== null },
      after: { contactEmail: next ?? me.email, own: next !== null }, ip: o.ip }, tx);
    return { ok: true as const, message };
  });
}
