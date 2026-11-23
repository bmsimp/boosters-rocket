import { eq } from "drizzle-orm";
import { db, type Tx } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";
import { writeAudit, type Actor } from "@/lib/audit/log";

/**
 * The club's one setting for messages (club messages, spec section 10): whether a message may be emailed to families.
 * Off until an Admin turns it on (Settings, Messages); while it is off nothing is queued, whatever a form sends. Kept in
 * the `setting` table under this key as `{ emailAllowed: boolean }`.
 */
export const MESSAGES_SETTING = "messages.email_allowed";
export const MESSAGES_PERMISSION = "Settings.Messages.ReadWrite" as const;

/** Whether messages may be emailed. Anything stored but `true` reads as off, so a value that can't be read never emails. */
export async function messagesEmailAllowed(tx: Tx | typeof db = db): Promise<boolean> {
  const [row] = await tx.select({ value: setting.value }).from(setting).where(eq(setting.key, MESSAGES_SETTING));
  return (row?.value as { emailAllowed?: unknown } | undefined)?.emailAllowed === true;
}

/**
 * Turns emailing messages on or off, audited with before and after in the same transaction. Saving what is already set
 * changes nothing and writes no row.
 */
export async function setMessagesEmailAllowed(on: boolean, o: { actor: Actor; ip: string | null }): Promise<{ ok: true; changed: boolean }> {
  return db.transaction(async (tx) => {
    // Once the row exists it is locked while it is read, so two Admins pressing at once are taken in turn, each audited
    // with its true before.
    const [row] = await tx.select({ value: setting.value }).from(setting).where(eq(setting.key, MESSAGES_SETTING)).for("update");
    const before = (row?.value as { emailAllowed?: unknown } | undefined)?.emailAllowed === true;
    if (before === on) return { ok: true as const, changed: false };
    const value = { emailAllowed: on };
    await tx.insert(setting).values({ key: MESSAGES_SETTING, value })
      .onConflictDoUpdate({ target: setting.key, set: { value, updatedAt: new Date() } });
    await writeAudit({ actor: o.actor, action: "settings.messages.change", permission: MESSAGES_PERMISSION,
      targetType: "setting", targetId: MESSAGES_SETTING, before: { emailAllowed: before }, after: value, ip: o.ip }, tx);
    return { ok: true as const, changed: true };
  });
}
