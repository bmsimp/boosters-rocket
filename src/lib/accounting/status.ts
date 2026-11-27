// The statuses of the accounting links screen (stage 4's slices M1, M2 and M3a of docs/superpowers/specs/2026-11-18-app-owned-families-design.md,
// section 4, "Statuses"), worked out at each view and stored nowhere. Pure: it reads nothing.
import type { Cust } from "@/lib/roster/model";

/**
 * Each status's fixed key, in the order the screen offers them. `left_unlinked` (slice M3a) is a family staff chose to
 * leave with no customer for now: the mark stored on the family (`family.accounting_left_unlinked_at`).
 */
export const STATUS_KEYS = ["suggested", "several", "no_match", "left_unlinked", "carried_over", "linked", "with_differences", "not_a_family", "customer_gone", "not_checked"] as const;
export type StatusKey = (typeof STATUS_KEYS)[number];
export const isStatusKey = (s: unknown): s is StatusKey => typeof s === "string" && (STATUS_KEYS as readonly string[]).includes(s);

/** A status in words: what the row and the filter say. */
export const STATUS_WORDS: Record<StatusKey, string> = {
  suggested: "Suggested by email", several: "Several possible", no_match: "No match", left_unlinked: "Left unlinked", carried_over: "Carried over", linked: "Linked",
  with_differences: "Linked, with differences", not_a_family: "Not a family now", customer_gone: "Gone from your books", not_checked: "Not checked",
};

/** Why a linked customer isn't a family now, by the rule of the customers that may be suggested (noFamilyPool()). */
export type NotAFamilyReason = "other_type" | "no_type" | "under_another" | "inactive";
export const NOT_A_FAMILY_WORDS: Record<NotAFamilyReason, string> = {
  other_type: "it has another customer type there", no_type: "it has no customer type there", under_another: "it is under another customer there", inactive: "it is inactive in the books",
};

/**
 * How a family's own link stands against the roster cache:
 * - `gone`: the cache holds customers and the linked one isn't among them (open question 13: the link is kept);
 * - `not_a_family`: it is there, but not a family at the top of the tree (a member, in flat books): not listed as a
 *   family by the shape (`listedAsFamily`, from buildRoster(); a customer of another type is `other_type`, one with no
 *   type `no_type`), or under another customer; each reason that applies, in that order, and then `inactive` too when
 *   it is inactive in the books. Inactive alone doesn't make it one (open question 13: an inactive customer that is
 *   otherwise a family is a difference, and the link is kept; slice M2). Null for `listedAsFamily` when the shape
 *   can't be trusted, and then this is not worked out;
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
  if (reasons.length === 0) return { is: "stands" };
  if (!customer.active) reasons.push("inactive");
  return { is: "not_a_family", reasons };
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
