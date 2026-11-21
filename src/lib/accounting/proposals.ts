// Which students a family's link would link with it (stage 4's slice M3a of docs/superpowers/specs/2026-11-18-app-owned-families-design.md,
// open question 3: "Each student and parent link proposed under the family is shown in the row and confirmed with it; a
// name or email match only fills in the suggestion"). The lead's rule for M3a: by name alone, one to one, by the
// portal's own uniqueness rule (nameKey(), src/lib/roster/names.ts: case and composed accents ignored); anything that
// could be paired the wrong way round is left, shown, and reads after the press as the accounting links screen's
// differences. Pure: it reads nothing. The screen draws the proposals with it and the confirm works them out again
// with it under the roster lock (src/lib/accounting/link-writes.ts), so the two never differ. Since slice M3c2 the
// guardians too ("A match on a parent record suggests the family above it, and the parent record is linked under it",
// section 4): by a sign-in address alone, one to one, the match's rule (proposeGuardians()), never by a name.
import type { AppStudentId } from "@/lib/families/ids";
import { parseEmailField } from "@/lib/parents/emails";
import { nameKey } from "@/lib/roster/names";

/** A student record of the family: `linked` when it has a student link of any company. */
export type RecordSide = { id: AppStudentId; name: string | null; active: boolean; linked: boolean };
/** A student customer the books list directly under the chosen customer: `linked` when a student link of the records' company names it. */
export type CustomerSide = { qboId: string; displayName: string; active: boolean; linked: boolean };
/** A pair proposed: the record and the customer of one name, each the only one of that name on its side. */
export type Pair = { studentId: AppStudentId; recordName: string; customerQboId: string; customerName: string; customerActive: boolean };
/** A guardian row of the family (slice M3c2): `linked` when it has a guardian link of the records' company. */
export type GuardianSide = { id: string; name: string; email: string; blocked: boolean; open: boolean; linked: boolean };
/**
 * A customer the roster lists directly under the chosen customer, of any type (buildRoster()'s `parents`): `linked` when
 * any link of the records' company names it (a guardian row's, open or closed, a student's or a family's).
 */
export type ParentCustomerSide = { qboId: string; displayName: string; email: string | null; active: boolean; typeQboId: string | null; parentQboId: string | null; linked: boolean };
/** A guardian pair proposed: the row (by the person's name) and the Parent customer whose email field holds its sign-in address. */
export type GuardianPair = { guardianId: string; who: string; customerQboId: string; customerName: string };
/** A guardian pair held back by the write queue (slice M3c2): linked by neither press, and said. */
export type GuardianHeld = { guardianId: string; who: string; customerName: string };
/** What a press would do of students: the pairs, and the records and customers no pair takes. */
export type StudentProposals = { pairs: Pair[]; recordsLeft: { id: AppStudentId; name: string | null }[]; customersLeft: { qboId: string; name: string; active: boolean }[] };
/**
 * What a press would link, and what it would leave: the records (active, with no student link) and the customers (with
 * no student link) no pair takes, each in the order given. Every list empty when the books have no students to pair.
 * Since slice M3c2 the guardian rows it would link to a Parent customer under the customer (`guardians`) and the pairs
 * the write queue holds back (`guardiansHeld`), both empty in books with no parent type.
 */
export type Proposals = StudentProposals & { guardians: GuardianPair[]; guardiansHeld: GuardianHeld[] };

export const NO_PROPOSALS: Proposals = { pairs: [], recordsLeft: [], customersLeft: [], guardians: [], guardiansHeld: [] };

/**
 * The proposals for linking a family to a customer. `students` is false in flat books and in a shape with no student
 * type: nothing is proposed or left then. The two sides: the family's active student records with no student link, and
 * the student customers directly under the customer, active or not, that no student link names (a record or customer
 * already linked takes no part, on either side). A record and a customer are paired when their names are the same by
 * nameKey() and that name is held by exactly one record and exactly one customer of the two sides; a record with no
 * name is never paired. Emails never pair students.
 */
export function proposeStudents(o: { students: boolean; records: readonly RecordSide[]; customers: readonly CustomerSide[] }): StudentProposals {
  if (!o.students) return NO_PROPOSALS;
  const records = o.records.filter((r) => r.active && !r.linked);
  const customers = o.customers.filter((c) => !c.linked);
  const count = <T>(items: readonly T[], keyOf: (t: T) => string | null) => {
    const n = new Map<string, number>();
    for (const t of items) { const k = keyOf(t); if (k !== null) n.set(k, (n.get(k) ?? 0) + 1); }
    return n;
  };
  const recordKey = (r: RecordSide) => (r.name === null ? null : nameKey(r.name));
  const customerKey = (c: CustomerSide) => nameKey(c.displayName);
  const recordsOf = count(records, recordKey), customersOf = count(customers, customerKey);
  const one = (k: string | null): k is string => k !== null && recordsOf.get(k) === 1 && customersOf.get(k) === 1;
  const customerOf = new Map(customers.filter((c) => one(customerKey(c))).map((c) => [customerKey(c), c]));
  const pairs: Pair[] = records.flatMap((r) => {
    const k = recordKey(r);
    const c = one(k) ? customerOf.get(k) : undefined;
    return c === undefined ? [] : [{ studentId: r.id, recordName: r.name!, customerQboId: c.qboId, customerName: c.displayName, customerActive: c.active }];
  });
  const pairedRecords = new Set(pairs.map((p) => String(p.studentId))), pairedCustomers = new Set(pairs.map((p) => p.customerQboId));
  return {
    pairs,
    recordsLeft: records.filter((r) => !pairedRecords.has(String(r.id))).map((r) => ({ id: r.id, name: r.name })),
    customersLeft: customers.filter((c) => !pairedCustomers.has(c.qboId)).map((c) => ({ qboId: c.qboId, name: c.displayName, active: c.active })),
  };
}

/**
 * The guardians a link of the family to this customer would link with it (slice M3c2; the lead's decision 2). `parents`
 * is false in flat books and in a shape with no parent type: nothing is proposed then. The two sides: the family's
 * guardian rows that are open, whose person isn't blocked (a blocked person's address is never matched) and that have
 * no guardian link; and the customers that are active, of the parent type, directly under the chosen customer, that no
 * link names. A row and a customer are paired when the customer's email field holds the row's sign-in address
 * (parseEmailField()'s usable addresses, against the address trimmed and lower-cased: the match's rule,
 * suggestCustomers()), that address is held by exactly one customer taking part, and that customer holds the address
 * of exactly one row taking part. A name never pairs a guardian. A pair whose row an item on the write queue names, or
 * whose customer a change that blocks others targets (`held`), is given as held instead: linked by neither press. In
 * the rows' order.
 */
export function proposeGuardians(o: { parents: boolean; rows: readonly GuardianSide[]; customers: readonly ParentCustomerSide[]; parentTypeId: string | null; customerId: string;
  held?: { rows: ReadonlySet<string>; customers: ReadonlySet<string> } }): Pick<Proposals, "guardians" | "guardiansHeld"> {
  if (!o.parents || o.parentTypeId === null) return { guardians: [], guardiansHeld: [] };
  const rows = o.rows.filter((r) => r.open && !r.blocked && !r.linked).map((r) => ({ r, address: r.email.trim().toLowerCase() })).filter((x) => x.address !== "");
  const customers = o.customers.filter((c) => c.active && c.typeQboId === o.parentTypeId && c.parentQboId === o.customerId && !c.linked)
    .map((c) => ({ c, holds: new Set(parseEmailField(c.email).usable) }));
  const guardians: GuardianPair[] = [], guardiansHeld: GuardianHeld[] = [];
  for (const { r, address } of rows) {
    const holding = customers.filter((x) => x.holds.has(address));
    if (holding.length !== 1) continue;
    const { c, holds } = holding[0]!;
    if (rows.filter((x) => holds.has(x.address)).length !== 1) continue;
    if (o.held !== undefined && (o.held.rows.has(r.id) || o.held.customers.has(c.qboId))) guardiansHeld.push({ guardianId: r.id, who: r.name, customerName: c.displayName });
    else guardians.push({ guardianId: r.id, who: r.name, customerQboId: c.qboId, customerName: c.displayName });
  }
  return { guardians, guardiansHeld };
}

/**
 * The pairs as the stamp seals them: each student pair `<student record id>=<customer id>`, and since slice M3c2 each
 * guardian pair `g:<guardian row id>=<customer id>` (lower-cased), sorted. A held guardian pair is in no key.
 */
export const pairKeys = (p: { pairs: readonly Pair[]; guardians?: readonly GuardianPair[] }): string[] => [
  ...p.pairs.map((x) => `${String(x.studentId)}=${x.customerQboId}`),
  ...(p.guardians ?? []).map((g) => `g:${g.guardianId.toLowerCase()}=${g.customerQboId.toLowerCase()}`),
].sort();
