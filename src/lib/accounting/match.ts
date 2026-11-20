// Suggestions for the accounting links screen (stage 4's slice M1 of docs/superpowers/specs/2026-11-18-app-owned-families-design.md,
// section 4, "The mapping screen"): which customer in the books looks like a family's, by its guardians' sign-in
// addresses alone. Pure: it reads nothing, and is given the roster and the customers that may be suggested.
import type { Cust, Roster } from "@/lib/roster/model";
import { parseEmailField } from "@/lib/parents/emails";

/** A family with no link, by its key (the app's family id, in the portal), and its open guardians' sign-in addresses. */
export type FamilyToMatch<K> = { key: K; addresses: readonly string[] };
/** Where a matching address sits: in the family customer's own email field, or in a Parent customer's directly under it. */
export type Holder = { address: string; on: { kind: "family" } | { kind: "parent"; customerId: string; name: string } };
/** A customer that holds at least one of the family's addresses, with each address it holds and where. Names and fields are the books' text. */
export type Candidate = { customerId: string; name: string; email: string | null; holders: Holder[] };
/**
 * What a family is offered:
 * - `suggested`: exactly one customer holds one of its addresses, and that customer holds no other unlinked family's;
 * - `several`, `many`: two customers or more hold its addresses, so none is filled in;
 * - `several`, `shared`: the one customer that holds its addresses holds another unlinked family's too (`alsoMatches`),
 *   so it is filled in for neither, and no two rows can ever aim at one customer;
 * - `none`: no customer that may be suggested holds any of them.
 */
export type Suggestion<K> =
  | { kind: "suggested"; candidate: Candidate }
  | { kind: "several"; why: "many"; candidates: Candidate[] }
  | { kind: "several"; why: "shared"; candidates: [Candidate]; alsoMatches: K[] }
  | { kind: "none" };

/**
 * The suggestion for each family, by an exact match of addresses (the spec's statuses; the lead's decision 3 for M1):
 * an address matches when it is the same once trimmed and lower-cased as a usable address of the customer's own email
 * field (parseEmailField(): a field may hold several), or of the field of an active Parent customer the roster lists
 * directly under it (layered books with a parent type: `parents` of buildRoster()'s family; none in flat books or
 * books with no parent type). A match on a Parent customer suggests the family customer above it, and says which
 * Parent customer held it. A student customer's email never counts (buildRoster() lists students apart), nor does a
 * stray Parent customer under no family, nor a name: a name never suggests by itself.
 *
 * Only the customers in `pool` may be suggested: the customers no family is linked to (src/lib/roster/no-family.ts,
 * noFamilyPool()), found in `roster` as families (members in flat books). Nothing narrows between candidates: a
 * guardian in two families whose address is on both families' customers makes each family `several`, as does any one
 * address that two unlinked families share; staff pick by hand (a later slice).
 */
export function suggestCustomers<K>(families: readonly FamilyToMatch<K>[], roster: Roster, pool: ReadonlySet<string>): Map<K, Suggestion<K>> {
  const offered: { customer: Cust; parents: Cust[] }[] = roster.kind === "flat"
    ? roster.members.filter((m) => pool.has(m.qboId)).map((m) => ({ customer: m, parents: [] }))
    : roster.families.filter((f) => pool.has(f.customer.qboId)).map((f) => ({ customer: f.customer, parents: f.parents.filter((p) => p.active) }));
  // Every address a candidate holds, and where.
  const holdersOf = offered.map(({ customer, parents }) => [
    ...parseEmailField(customer.email).usable.map((address): Holder => ({ address, on: { kind: "family" } })),
    ...parents.flatMap((p) => parseEmailField(p.email).usable.map((address): Holder => ({ address, on: { kind: "parent", customerId: p.qboId, name: p.displayName } }))),
  ]);
  const matched = families.map((f) => {
    const mine = new Set(f.addresses.map((a) => a.trim().toLowerCase()).filter((a) => a !== ""));
    return offered.flatMap((o, i) => {
      const holders = holdersOf[i]!.filter((h) => mine.has(h.address));
      return holders.length ? [{ index: i, candidate: { customerId: o.customer.qboId, name: o.customer.displayName, email: o.customer.email, holders } }] : [];
    });
  });
  // Which families each candidate matched, so a candidate two families match is filled in for neither.
  const familiesOf = new Map<number, K[]>();
  families.forEach((f, n) => { for (const m of matched[n]!) familiesOf.set(m.index, [...(familiesOf.get(m.index) ?? []), f.key]); });
  const out = new Map<K, Suggestion<K>>();
  families.forEach((f, n) => {
    const mine = matched[n]!;
    if (mine.length === 0) out.set(f.key, { kind: "none" });
    else if (mine.length > 1) out.set(f.key, { kind: "several", why: "many", candidates: mine.map((m) => m.candidate) });
    else {
      const others = (familiesOf.get(mine[0]!.index) ?? []).filter((k) => k !== f.key);
      out.set(f.key, others.length ? { kind: "several", why: "shared", candidates: [mine[0]!.candidate], alsoMatches: others } : { kind: "suggested", candidate: mine[0]!.candidate });
    }
  });
  return out;
}
