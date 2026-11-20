// The statuses of the accounting links screen (stage 4's slice M1 of docs/superpowers/specs/2026-11-18-app-owned-families-design.md,
// section 4, "Statuses"), worked out at each view and stored nowhere. Pure: it reads nothing.
import type { Cust } from "@/lib/roster/model";

/**
 * Each status's fixed key, in the order the screen offers them. "Linked, with differences" (slice M2) and "Left
 * unlinked" (a mark a later slice stores) are not here yet.
 */
export const STATUS_KEYS = ["suggested", "several", "no_match", "carried_over", "linked", "not_a_family", "customer_gone", "not_checked"] as const;
export type StatusKey = (typeof STATUS_KEYS)[number];
export const isStatusKey = (s: unknown): s is StatusKey => typeof s === "string" && (STATUS_KEYS as readonly string[]).includes(s);

/** A status in words: what the row and the filter say. */
export const STATUS_WORDS: Record<StatusKey, string> = {
  suggested: "Suggested", several: "Several possible", no_match: "No match", carried_over: "Carried over", linked: "Linked",
  not_a_family: "Not a family now", customer_gone: "Customer gone", not_checked: "Not checked",
};

/** Why a linked customer isn't a family now, by the rule of the customers that may be suggested (noFamilyPool()). */
export type NotAFamilyReason = "other_type" | "no_type" | "under_another" | "inactive";
export const NOT_A_FAMILY_WORDS: Record<NotAFamilyReason, string> = {
  other_type: "it has another customer type there", no_type: "it has no customer type there", under_another: "it is under another customer there", inactive: "it is inactive in the books",
};

/**
 * How a family's own link stands against the roster cache:
 * - `gone`: the cache holds customers and the linked one isn't among them (open question 13: the link is kept);
 * - `not_a_family`: it is there, but not an active family at the top of the tree (a member, in flat books), by the
 *   rule of the customers that may be suggested: listed as a family by the shape (`listedAsFamily`, from
 *   buildRoster(); a customer of another type is `other_type`, one with no type `no_type`), active, and under no other customer; each reason that applies, in that order. Null for
 *   `listedAsFamily` when the shape can't be trusted, and then this is not worked out;
 * - `stands`: neither, or the cache holds no customer at all, so nothing can be told.
 */
export function linkStanding(customer: Cust | undefined, o: { cacheHasCustomers: boolean; listedAsFamily: ReadonlySet<string> | null }):
  { is: "gone" } | { is: "not_a_family"; reasons: NotAFamilyReason[] } | { is: "stands" } {
  if (customer === undefined) return o.cacheHasCustomers ? { is: "gone" } : { is: "stands" };
  if (o.listedAsFamily === null) return { is: "stands" };
  const reasons: NotAFamilyReason[] = [];
  // Not listed as a family by the shape: of another type, or of none at all, each said in its own words.
  if (!o.listedAsFamily.has(customer.qboId)) reasons.push(customer.typeQboId === null ? "no_type" : "other_type");
  if (customer.parentQboId !== null) reasons.push("under_another");
  if (!customer.active) reasons.push("inactive");
  return reasons.length ? { is: "not_a_family", reasons } : { is: "stands" };
}

/** The list's filter, from the address: anything it doesn't know is dropped, never guessed at. */
export type LinksFilter = { status: StatusKey | null; q: string; tooLong: boolean };
export const SEARCH_MAX = 100;
export function parseLinksFilter(sp: Record<string, string | string[] | undefined>): LinksFilter {
  const status = isStatusKey(sp.status) ? sp.status : null;
  if (typeof sp.q !== "string") return { status, q: "", tooLong: false };
  const q = sp.q.trim();
  return q.length > SEARCH_MAX ? { status, q: "", tooLong: true } : { status, q, tooLong: false };
}

/** Whether a search matches any of a row's texts, ignoring case: a plain substring, so nothing typed is a pattern. */
export const searchMatches = (q: string, texts: readonly (string | null)[]): boolean => {
  const needle = q.toLowerCase();
  return needle === "" || texts.some((t) => t !== null && t.toLowerCase().includes(needle));
};
