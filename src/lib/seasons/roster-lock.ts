// Guards the writes that name families and students against a roster read from another company: the season's (by
// the app's own ids, whose links name that company's customers) and the other areas' (by QuickBooks ids).
import "server-only";
import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { type Tx } from "@/lib/db/client";
import { env } from "@/env";
import { getRosterSource } from "@/lib/roster/source";
import { ROSTER_LOCK } from "@/lib/roster/shape";

/** What staff are told when the roster was read from another QuickBooks company after their page was opened. */
export const ROSTER_MOVED = "The roster has been read from another QuickBooks company since this page was opened, so nothing was changed. Reload the page.";

/**
 * A tag for the QuickBooks company the roster cache was read from, to carry in a page that offers a tick, a waiver or a
 * chosen list: the roster on that page is that company's, and so are the customers the links of the app records its
 * ids name. "none" while the cache names no company. Keyed with the server
 * secret, so the company's own id can't be read back from a page (it is never sent to one: roster/source.ts).
 */
export const rosterTagOf = (realmId: string | null): string =>
  realmId === null ? "none" : createHmac("sha256", env.BETTER_AUTH_SECRET).update(`roster-source:${realmId}`).digest("base64url").slice(0, 22);

export const currentRosterTag = async (tx?: Tx): Promise<string> => rosterTagOf(await getRosterSource(tx));

/**
 * The first thing a write that names families or students does in its transaction (a season's tick, waiver or chosen
 * list by the app's own ids, and the other areas' writes by QuickBooks ids). It takes the roster lock, so no refresh,
 * staff roster write (which may change a family's or student's record) or change of company can run between the write's look at
 * the roster and its commit; and it refuses when the page that sent the ids was shown a roster from another company.
 * The caller reads the roster after this, so what it checks is what it writes against.
 */
export async function lockRosterAs(tx: Tx, tag: string): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock(${ROSTER_LOCK})`);
  return (await currentRosterTag(tx)) === tag;
}
