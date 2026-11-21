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

const sealed = (domain: string, values: unknown[]) => createHmac("sha256", env.BETTER_AUTH_SECRET).update(`${domain}:${JSON.stringify(values)}`).digest("base64url").slice(0, 22);
const same = (want: string, got: string) => { const w = Buffer.from(want), g = Buffer.from(got); return g.length === w.length && timingSafeEqual(g, w); };

/**
 * Confirm all exact email matches (slice M3a2): the filter as the page parsed it (its status key or none, and its
 * search text), how many rows it showed, and every one of them (bulkKeys(): `<family id>=<customer id>|<its pairs>`,
 * sorted), sealed in a domain of its own, so a row's stamp is never a bulk stamp nor the other way round. The press
 * works the rows out again under the roster lock and they must seal to the same stamp.
 */
export function bulkStamp(filter: { status: string | null; q: string }, count: number, rows: readonly string[]): string {
  return sealed("accounting-bulk", [filter.status, filter.q, count, [...rows].sort()]);
}
export const bulkStampHolds = (filter: { status: string | null; q: string }, count: number, rows: readonly string[], stamp: string): boolean =>
  same(bulkStamp(filter, count, rows), stamp);

/**
 * Confirm this link, for a carried-over link (slice M3a2): the family's app id, its family link's id, the customer, and
 * the ids of the student links the press confirms with it (sorted), sealed in a domain of their own.
 */
export function reviewStamp(familyId: string, linkId: string, customerId: string, studentLinkIds: readonly string[]): string {
  return sealed("accounting-review", [familyId.toLowerCase(), linkId.toLowerCase(), customerId, [...studentLinkIds].map((id) => id.toLowerCase()).sort()]);
}
export const reviewStampHolds = (familyId: string, linkId: string, customerId: string, studentLinkIds: readonly string[], stamp: string): boolean =>
  same(reviewStamp(familyId, linkId, customerId, studentLinkIds), stamp);

/**
 * Unlink from the books (slice M3b): the family's app id, its family link's id, that link's customer, and the ids of
 * its student records' links the press ends with it (sorted), sealed in a domain of their own, so neither a review's
 * stamp nor any other is ever an unlink's.
 */
export function unlinkStamp(familyId: string, linkId: string, customerId: string, studentLinkIds: readonly string[]): string {
  return sealed("accounting-unlink", [familyId.toLowerCase(), linkId.toLowerCase(), customerId, [...studentLinkIds].map((id) => id.toLowerCase()).sort()]);
}
export const unlinkStampHolds = (familyId: string, linkId: string, customerId: string, studentLinkIds: readonly string[], stamp: string): boolean =>
  same(unlinkStamp(familyId, linkId, customerId, studentLinkIds), stamp);

/** How a guardian's Parent customer was chosen (slice M3c): the one filled in on the row (`suggested`), or another of its candidates (`picked`). */
export const GUARDIAN_CHOSEN = ["suggested", "picked"] as const;
export type GuardianChosen = (typeof GUARDIAN_CHOSEN)[number];
export const isGuardianChosen = (s: unknown): s is GuardianChosen => typeof s === "string" && (GUARDIAN_CHOSEN as readonly string[]).includes(s);

/**
 * Link a guardian to a Parent customer (slice M3c): the guardian row's id, the id of its family's link the row was
 * drawn under, the customer, and how it was chosen, sealed in a domain of their own, so no family press's stamp is ever
 * a guardian's. The press works the row's candidates out again under the roster lock and they must seal to the same stamp.
 */
export function guardianLinkStamp(guardianId: string, familyLinkId: string, customerId: string, chosen: GuardianChosen): string {
  return sealed("accounting-guardian-link", [guardianId.toLowerCase(), familyLinkId.toLowerCase(), customerId, chosen]);
}
export const guardianLinkStampHolds = (guardianId: string, familyLinkId: string, customerId: string, chosen: GuardianChosen, stamp: string): boolean =>
  same(guardianLinkStamp(guardianId, familyLinkId, customerId, chosen), stamp);

/** Unlink a guardian from their Parent customer (slice M3c): the guardian row's id, its link's id and that link's customer, sealed in a domain of their own. */
export function guardianUnlinkStamp(guardianId: string, linkId: string, customerId: string): string {
  return sealed("accounting-guardian-unlink", [guardianId.toLowerCase(), linkId.toLowerCase(), customerId]);
}
export const guardianUnlinkStampHolds = (guardianId: string, linkId: string, customerId: string, stamp: string): boolean =>
  same(guardianUnlinkStamp(guardianId, linkId, customerId), stamp);

/**
 * Take QuickBooks' into the app (slice M4a): what a difference's press takes (`field`: `name`, `inactive` or `place`),
 * the record it changes (the family's or the student's app id), its customer, and the value the row showed, sealed in a
 * domain of their own: for a name the books' name exactly; for a family taken as inactive the ids of the active student
 * records it takes with it, sorted; for a place the student's customer, the books' family customer, the family record
 * left and the family record joined. The press works each value out again under the roster lock and must seal to it.
 */
export function takeStamp(field: string, recordId: string, customerId: string, value: readonly unknown[]): string {
  return sealed("accounting-take", [field, recordId.toLowerCase(), customerId, [...value]]);
}
export const takeStampHolds = (field: string, recordId: string, customerId: string, value: readonly unknown[], stamp: string): boolean =>
  same(takeStamp(field, recordId, customerId, value), stamp);

/**
 * Send the app's to QuickBooks (slice M5a): what a difference's press sends (`field`: `name`, `inactive` or `place`), the
 * record it is of (the family's or the student's app id), its customer, and what the row showed, sealed in a domain of
 * its own, so no take's or link press's stamp is ever a send's: for a name the books' name and the portal's; for a place
 * the student's customer, the customer the cache has them under (`""` for the top of the tree), the family record they
 * are in and that family's customer; for a make-inactive the record's customer. The press works each value out again
 * under the roster lock and must seal to it, so what it sends over is only what the row showed.
 */
export function sendStamp(field: string, recordId: string, customerId: string, value: readonly unknown[]): string {
  return sealed("accounting-send", [field, recordId.toLowerCase(), customerId, [...value]]);
}
export const sendStampHolds = (field: string, recordId: string, customerId: string, value: readonly unknown[], stamp: string): boolean =>
  same(sendStamp(field, recordId, customerId, value), stamp);
