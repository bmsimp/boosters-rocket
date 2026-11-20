import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/lib/db/client";
import { setting } from "@/lib/db/schema";

/**
 * The setting of the take-in of a guardian's phone and mailing address (./contact-take-in.ts), apart from it so that a
 * shape save (src/lib/roster/shape.ts) can withdraw its note without importing the take-in, which reads every person.
 * Written by migration 0044 as `{ after }`; a roster read made under a shape that holds adds `addressesReadAt`, the
 * worker's own ask for such a read `readAskedAt`, and the take-in `doneAt` once it has run.
 */
export const TAKE_IN_KEY = "parents.contact_take_in";

/**
 * Withdraws, in the caller's transaction (saveShape()'s), the note that a roster read kept the billing addresses: that
 * read kept them only for the types the shape named then, and a save never fills in the types it names now, so only a
 * read made under the saved shape lets the take-in run. Nothing once the take-in has run.
 */
export async function withdrawAddressesNote(tx: Tx): Promise<void> {
  await tx.update(setting).set({ value: sql`${setting.value} - 'addressesReadAt'`, updatedAt: new Date() })
    .where(and(eq(setting.key, TAKE_IN_KEY), sql`${setting.value}->'doneAt' is null`, sql`${setting.value}->'addressesReadAt' is not null`));
}
