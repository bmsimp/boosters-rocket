// The stamp a link press carries (stage 4's slice M3a): what the accounting links screen showed for the press, sealed
// with the portal's secret in the manner of coverStamp() and portalValueStamp() (src/lib/roster/writes.ts), so nothing
// about the students it would link is taken from the browser: the confirm works the proposals out again under the
// roster lock (src/lib/accounting/link-writes.ts) and they must seal to the same stamp.
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/env";

/** How the customer was chosen: the row's suggestion, one of a Several possible row's candidates, or picked from the pool. */
export const CHOSEN = ["suggested", "several", "picked"] as const;
export type Chosen = (typeof CHOSEN)[number];
export const isChosen = (s: unknown): s is Chosen => typeof s === "string" && (CHOSEN as readonly string[]).includes(s);

/**
 * The family's app id, the customer's id, the way it was chosen and the proposed pairs (pairKeys(): each `<student record
 * id>=<customer id>`, sorted), sealed.
 */
export function linkStamp(familyId: string, customerId: string, chosen: Chosen, pairs: readonly string[]): string {
  return createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(`accounting-link:${familyId.toLowerCase()}|${customerId}|${chosen}|${[...pairs].sort().join(",")}`).digest("base64url").slice(0, 22);
}

/** Whether a stamp from the page is the one these values seal to, compared in constant time. */
export function linkStampHolds(familyId: string, customerId: string, chosen: Chosen, pairs: readonly string[], stamp: string): boolean {
  const want = Buffer.from(linkStamp(familyId, customerId, chosen, pairs)), got = Buffer.from(stamp);
  return got.length === want.length && timingSafeEqual(got, want);
}
