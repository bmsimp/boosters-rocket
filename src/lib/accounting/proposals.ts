// Which students a family's link would link with it (stage 4's slice M3a of docs/superpowers/specs/2026-11-18-app-owned-families-design.md,
// open question 3: "Each student and parent link proposed under the family is shown in the row and confirmed with it; a
// name or email match only fills in the suggestion"). The lead's rule for M3a: by name alone, one to one, by the
// portal's own uniqueness rule (nameKey(), src/lib/roster/names.ts: case and composed accents ignored); anything that
// could be paired the wrong way round is left, shown, and reads after the press as the accounting links screen's
// differences. Pure: it reads nothing. The screen draws the proposals with it and the confirm works them out again
// with it under the roster lock (src/lib/accounting/link-writes.ts), so the two never differ.
import type { AppStudentId } from "@/lib/families/ids";
import { nameKey } from "@/lib/roster/names";

/** A student record of the family: `linked` when it has a student link of any company. */
export type RecordSide = { id: AppStudentId; name: string | null; active: boolean; linked: boolean };
/** A student customer the books list directly under the chosen customer: `linked` when a student link of the records' company names it. */
export type CustomerSide = { qboId: string; displayName: string; active: boolean; linked: boolean };
/** A pair proposed: the record and the customer of one name, each the only one of that name on its side. */
export type Pair = { studentId: AppStudentId; recordName: string; customerQboId: string; customerName: string; customerActive: boolean };
/**
 * What a press would link, and what it would leave: the records (active, with no student link) and the customers (with
 * no student link) no pair takes, each in the order given. Every list empty when the books have no students to pair.
 */
export type Proposals = { pairs: Pair[]; recordsLeft: { id: AppStudentId; name: string | null }[]; customersLeft: { qboId: string; name: string; active: boolean }[] };

export const NO_PROPOSALS: Proposals = { pairs: [], recordsLeft: [], customersLeft: [] };

/**
 * The proposals for linking a family to a customer. `students` is false in flat books and in a shape with no student
 * type: nothing is proposed or left then. The two sides: the family's active student records with no student link, and
 * the student customers directly under the customer, active or not, that no student link names (a record or customer
 * already linked takes no part, on either side). A record and a customer are paired when their names are the same by
 * nameKey() and that name is held by exactly one record and exactly one customer of the two sides; a record with no
 * name is never paired. Emails never pair students.
 */
export function proposeStudents(o: { students: boolean; records: readonly RecordSide[]; customers: readonly CustomerSide[] }): Proposals {
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

/** The pairs as the stamp seals them: each `<student record id>=<customer id>`, sorted. */
export const pairKeys = (p: Proposals): string[] => p.pairs.map((x) => `${String(x.studentId)}=${x.customerQboId}`).sort();
