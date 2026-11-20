import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";

/**
 * The setting of the take-in of a guardian's phone and mailing address (./contact-take-in.ts), apart from it so that a
 * shape save (src/lib/roster/shape.ts) can withdraw its note without importing the take-in, which reads every person.
 * Written by migration 0044 as `{ after }`; a roster read made under a shape that holds adds `addressesReadAt`, the
 * worker's own ask for such a read `readAskedAt`, and the take-in `doneAt` once it has run. `addressesReadAt` is kept
 * after the take-in too (stage 3's slice 11b): every roster read under a shape that holds marks it, and a shape save
 * withdraws it, since a parent's change of their details is sent on only while it stands (contactSendsMayGo()).
 */
export const TAKE_IN_KEY = "parents.contact_take_in";

/**
 * Withdraws, in the caller's transaction (saveShape()'s), the note that a roster read kept the billing addresses: that
 * read kept them only for the types the shape named then, and a save never fills in the types it names now, so only a
 * read made under the saved shape lets the take-in run, and, once it has run, lets a parent's change be sent on.
 */
export async function withdrawAddressesNote(tx: Tx): Promise<void> {
  await tx.update(setting).set({ value: sql`${setting.value} - 'addressesReadAt' - 'addressesSince'`, updatedAt: new Date() })
    .where(and(eq(setting.key, TAKE_IN_KEY), sql`(${setting.value}->'addressesReadAt' is not null or ${setting.value}->'addressesSince' is not null)`));
}

/**
 * Whether a parent's change of their phone and mailing address may be sent on now (stage 3's slice 11b), the one place
 * that decides it, read in the caller's transaction, which holds the roster lock shared: only once the take-in has run
 * (`doneAt`) and while the roster cache's contact details are known to have been read under the membership shape that
 * holds now (`addressesReadAt`, which a shape save withdraws and the next read under a shape that holds marks again).
 * Until then the cache's empty columns say nothing of what QuickBooks holds, and nothing is sent for any contact item.
 */
export async function contactSendsMayGo(tx: Tx): Promise<boolean> {
  return (await contactSendsSince(tx)) !== null;
}

/**
 * contactSendsMayGo()'s answer as a time: since when a parent's change of their details has been free to go, the later
 * of the take-in (`doneAt`) and the first read under the shape that holds now (`addressesSince`, which a read keeps and
 * a shape save withdraws with `addressesReadAt`; `addressesReadAt` itself where a read marked none), or null while it
 * may not go. A contact item's age, which makes a queue item stuck after a day, is counted from it, never from before
 * it (the time it waited for this read is not a time it could be tried in).
 */
export async function contactSendsSince(tx: Tx): Promise<Date | null> {
  const [row] = await tx.select({ value: setting.value }).from(setting).where(eq(setting.key, TAKE_IN_KEY));
  const v = row?.value as { doneAt?: unknown; addressesReadAt?: unknown; addressesSince?: unknown } | undefined;
  const at = (x: unknown) => (typeof x === "string" && !Number.isNaN(Date.parse(x)) ? Date.parse(x) : null);
  if (v === undefined || v === null || typeof v !== "object") return null;
  const done = at(v.doneAt);
  const read = at(v.addressesReadAt);
  if (done === null || read === null) return null;
  return new Date(Math.max(done, at(v.addressesSince) ?? read));
}

/**
 * The time a contact item's age is counted from for afterFailedTry(): the later of its own making and the time sends
 * of its kind have been free to go (contactSendsSince()), so an item that waited out the take-in or a shape save's read
 * gets the queue's usual tries and gaps once it may go, rather than being stuck by the age it reached while it couldn't.
 */
export const contactAgeFrom = (createdAt: Date, since: Date | null): Date => (since !== null && since > createdAt ? since : createdAt);
