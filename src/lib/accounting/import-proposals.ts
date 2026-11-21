// The reviewed import's proposer (stage 4's slice M6 of docs/superpowers/specs/2026-11-18-app-owned-families-design.md,
// section 4: "Import, once, if the club wants it. The app reads the customers and proposes families with their students
// and guardians, using the customer types as today. An admin reviews the list before anything is saved. Families made
// this way are linked from the start", and open question 4). Pure: the accounting links screen feeds it its own reads
// (importInputOf(), src/lib/accounting/mapping.ts) and the persons who hold the addresses it proposes, for the review
// and, again in the save's transaction under the roster lock, for the save (./import-writes.ts), so the two never differ.
//
// It proposes only for the customers no family is linked to (the pool, noFamilyPool()'s rule), leaving out every one
// the screen aims at a family the portal has (customerAims()), and never proposes a change to a record, a person or a
// link that exists: a family and its students are what "Create a family from this" makes of the customer (the plan
// narrowed to it, planForOneFamily(), one definition), and a guardian's person is an address nobody holds (a new
// person) or the person who holds it, unchanged.
import { planAppRecords, planForOneFamily } from "@/lib/families/plan";
import { recordNameWords } from "@/lib/families/words";
import { parseEmailField } from "@/lib/parents/emails";
import { guardianEmail, personName } from "@/lib/parents/guardian-input";
import type { Cust, Roster } from "@/lib/roster/model";
import type { MembershipShape } from "@/lib/roster/shape";

/**
 * At most this many families are proposed, and so made, by one press of the import (the lead's decision 1 for slice M6,
 * beside BULK_MAX): its guardian half is one transaction a person, each waiting at most ROSTER_WAIT_MS for the roster lock.
 */
export const IMPORT_MAX = 25;

/** What the proposer is given, all of it read once by the screen (importInputOf()). */
export type ImportInput = {
  shape: MembershipShape;
  /** buildRoster() of the shape and the cache: which customer is a family, a student or a parent, as everywhere on the screen. */
  roster: Roster;
  /** The cache's customers, with their email fields. */
  customers: readonly Cust[];
  /** The customers no family is linked to, in the roster's order (noFamilyPool()). */
  pool: readonly { qboId: string }[];
  /** Those of the pool the screen aims at a family the portal has (customerAims(): suggested, a candidate, or a given-up create's). */
  aimed: ReadonlySet<string>;
  /** Student customers with a student link of the records' company: the narrowed import leaves them alone. */
  studentLinked: ReadonlySet<string>;
  /**
   * Customers no guardian may be linked to now, by linkGuardian()'s rules: one a link of the records' company names (a
   * guardian row's, open or closed, a student's or a family's), or one a guardian row's latest ended link keeps for it.
   */
  parentTaken: ReadonlySet<string>;
  /** Customers a change that blocks others targets, waiting, stuck or kept on the queue: Link this guardian refuses them too. */
  parentHeld: ReadonlySet<string>;
};

/** A person who holds a proposed address now: their name as the portal holds it, whether they are blocked, and the families they are an open guardian of, by name. */
export type ImportPerson = { id: string; name: string; blocked: boolean; families: string[] };

/**
 * Where a proposed guardian comes from, and so what they are named (the lead's decision 4 for slice M6): a Parent
 * customer directly under the family's customer, named as it (layered books with a parent type); an address in the family
 * customer's own email field, named as the family customer, since the field holds no name (layered books with no parent
 * type, open question 4); a flat member's first address, named as the member (open question 4).
 */
export type GuardianFrom = "parent_customer" | "family_field" | "member";
/** How each guardian is named, in words, for the review (the lead's decision 4: each rule in one constant). */
export const GUARDIAN_NAMED: Record<GuardianFrom, string> = {
  parent_customer: "Each guardian is named as their Parent customer in the books, from the first address in its email field.",
  family_field: "The books have no parent type, so each address in the family customer's email field is a guardian, named as the family customer, since the field holds no name.",
  member: "Each member's guardian is the first address in the member's email field, named as the member.",
};

export type ImportPersonShown = { kind: "new" } | { kind: "existing"; id: string; name: string; families: string[] };
export type ProposedGuardian = {
  /** The name a new person is given (QuickBooks text, by personName()); a person reused keeps theirs (`person.name`). */
  name: string;
  email: string;
  from: GuardianFrom;
  /** The customer it came from, by name: the Parent customer, the family customer or the member (QuickBooks text). */
  customer: string;
  /** The Parent customer the guardian is linked to (layered books with a parent type); null otherwise, or when `linkNot` says why not. */
  link: { qboId: string; name: string } | null;
  /** Why a Parent customer they came from isn't linked to them: another link names it or keeps it (`taken`), or a change waits for it (`held`). */
  linkNot: "taken" | "held" | null;
  person: ImportPersonShown;
  /** The other families this proposal gives the same address, by name: one person, a guardian in each. */
  alsoIn: string[];
};
/** A customer read for a guardian that gives none, and why: shown, never echoing an email field beyond the address it read. */
export type NotProposedGuardian = {
  customer: string;
  why: "inactive" | "no_address" | "same_address" | "blocked" | "name";
  /** The address read, for `blocked` and `same_address`; null otherwise. */
  address: string | null;
  /** For `same_address`: the Parent customer of the same family the address gave a guardian first. */
  sameAs: string | null;
};
export type ProposedFamily = {
  customerId: string;
  /** Its name, as the narrowed import names the family record (the plan's), in words. */
  name: string;
  /** Its student customers, the narrowed import's rule (the plan's): those it makes, and those with a student record already, left alone. */
  students: { made: { qboId: string; name: string; active: boolean }[]; leftAlone: { qboId: string; name: string }[] };
  guardians: ProposedGuardian[];
  notProposed: NotProposedGuardian[];
  /** Pieces of the email fields read for guardians that aren't an address the portal can use: counted, never shown. */
  unusable: number;
};
export type ImportProposal = {
  families: ProposedFamily[];
  /** How many customers of the pool aren't proposed because the screen aims them at a family the portal has: linked there instead. */
  aimed: number;
  /** How many more would be proposed past IMPORT_MAX: proposed once these are made, at the next press. */
  pastCap: number;
  from: GuardianFrom;
};

type Candidate = Omit<ProposedGuardian, "person" | "alsoIn">;
type Draft = Omit<ProposedFamily, "guardians"> & { candidates: Candidate[] };

/** The guardians' source for the books' shape. */
const fromOf = (shape: MembershipShape): GuardianFrom => (shape.kind === "flat" ? "member" : shape.parentTypeId !== null ? "parent_customer" : "family_field");

/** The usable addresses of an email field the portal takes (parseEmailField(), each within guardianEmail()'s rule), and how many pieces aren't. */
function addressesOf(field: string | null): { usable: string[]; unusable: number } {
  const parsed = parseEmailField(field);
  const usable = parsed.usable.filter((a) => guardianEmail(a) === a);
  return { usable, unusable: parsed.unusable.length + parsed.usable.length - usable.length };
}

/** The families the proposal holds, before the persons are known: in the roster's order, at most IMPORT_MAX. */
function drafts(i: ImportInput): { drafts: Draft[]; aimed: number; pastCap: number } {
  const plan = planAppRecords({ shape: i.shape, customers: i.customers.map((c) => ({ qboId: c.qboId, displayName: c.displayName, active: c.active, parentQboId: c.parentQboId, typeQboId: c.typeQboId })) });
  const byId = new Map(i.customers.map((c) => [c.qboId, c]));
  const aimed = i.pool.filter((c) => i.aimed.has(c.qboId)).length;
  const eligible = i.pool.filter((c) => !i.aimed.has(c.qboId) && plan.families.has(c.qboId));
  const taken = eligible.slice(0, IMPORT_MAX);
  const from = fromOf(i.shape);
  const layered = i.roster.kind === "layered" ? new Map(i.roster.families.map((f) => [f.customer.qboId, f])) : new Map<string, never>();
  return {
    aimed, pastCap: eligible.length - taken.length,
    drafts: taken.map(({ qboId }): Draft => {
      const one = planForOneFamily(plan, qboId);
      const customer = byId.get(qboId)!;
      const inRoster = layered.get(qboId);
      // The plan's students, in the roster's order (by name, then id), as the family's page lists them.
      const order = new Map((inRoster?.students ?? []).map((c, n) => [c.qboId, n]));
      const students = [...one.students].sort(([a], [b]) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0));
      const candidates: Candidate[] = [];
      const notProposed: NotProposedGuardian[] = [];
      let unusable = 0;
      if (from === "parent_customer") {
        // Each active Parent customer directly under it, by its first usable address; a second of the same first address gives no second guardian.
        const firstOf = new Map<string, string>();
        for (const p of inRoster?.parents ?? []) {
          if (!p.active) { notProposed.push({ customer: p.displayName, why: "inactive", address: null, sameAs: null }); continue; }
          const read = addressesOf(p.email);
          unusable += read.unusable;
          const first = read.usable[0];
          if (first === undefined) { notProposed.push({ customer: p.displayName, why: "no_address", address: null, sameAs: null }); continue; }
          const seen = firstOf.get(first);
          if (seen !== undefined) { notProposed.push({ customer: p.displayName, why: "same_address", address: first, sameAs: seen }); continue; }
          const name = personName(p.displayName);
          if (name === null) { notProposed.push({ customer: p.displayName, why: "name", address: first, sameAs: null }); continue; }
          firstOf.set(first, p.displayName);
          const linkNot = i.parentTaken.has(p.qboId) ? "taken" as const : i.parentHeld.has(p.qboId) ? "held" as const : null;
          candidates.push({ name, email: first, from, customer: p.displayName, link: linkNot === null ? { qboId: p.qboId, name: p.displayName } : null, linkNot });
        }
      } else {
        // The family customer's own field (no parent type: every usable address) or the member's (flat: the first).
        const read = addressesOf(customer.email);
        unusable += read.unusable;
        const addresses = from === "member" ? read.usable.slice(0, 1) : read.usable;
        const name = personName(customer.displayName);
        if (addresses.length === 0) notProposed.push({ customer: customer.displayName, why: "no_address", address: null, sameAs: null });
        for (const email of addresses) {
          if (name === null) notProposed.push({ customer: customer.displayName, why: "name", address: email, sameAs: null });
          else candidates.push({ name, email, from, customer: customer.displayName, link: null, linkNot: null });
        }
      }
      return {
        customerId: qboId, name: recordNameWords(one.families.get(qboId)?.name ?? null, "family"),
        students: {
          made: students.filter(([id]) => !i.studentLinked.has(id)).map(([id, s]) => ({ qboId: id, name: recordNameWords(s.name, "student"), active: s.active })),
          leftAlone: students.filter(([id]) => i.studentLinked.has(id)).map(([id, s]) => ({ qboId: id, name: recordNameWords(s.name, "student") })),
        },
        candidates, notProposed, unusable,
      };
    }),
  };
}

/** The addresses the proposal reads for guardians, each once: the persons who hold them are read for it (personsHolding()). */
export function importAddresses(i: ImportInput): string[] {
  return [...new Set(drafts(i).drafts.flatMap((d) => d.candidates.map((c) => c.email)))].sort();
}

/**
 * The proposal: for each customer of the pool the screen doesn't aim at a family the portal has, in the roster's order,
 * at most IMPORT_MAX, the family, its students and its guardians, each guardian's person found among `persons` (keyed
 * by address): an address nobody holds is a new person; one a person holds reuses them, their name unchanged, with the
 * families they are a guardian of now; one a blocked person holds gives no guardian. An address two proposed families
 * give is one person in both, each shown with the other. Pure.
 */
export function proposeImport(i: ImportInput, persons: ReadonlyMap<string, ImportPerson>): ImportProposal {
  const d = drafts(i);
  const families = d.drafts.map(({ candidates, notProposed, ...f }): ProposedFamily => {
    const not = [...notProposed];
    const guardians: ProposedGuardian[] = [];
    for (const c of candidates) {
      const p = persons.get(c.email);
      if (p?.blocked) { not.push({ customer: c.customer, why: "blocked", address: c.email, sameAs: null }); continue; }
      guardians.push({ ...c, person: p === undefined ? { kind: "new" } : { kind: "existing", id: p.id, name: p.name, families: p.families }, alsoIn: [] });
    }
    return { ...f, guardians, notProposed: not };
  });
  const familiesOf = new Map<string, string[]>();
  for (const f of families) for (const g of f.guardians) familiesOf.set(g.email, [...(familiesOf.get(g.email) ?? []), f.customerId]);
  const nameOf = new Map(families.map((f) => [f.customerId, f.name]));
  for (const f of families) for (const g of f.guardians) g.alsoIn = (familiesOf.get(g.email) ?? []).filter((id) => id !== f.customerId).map((id) => nameOf.get(id)!);
  return { families, aimed: d.aimed, pastCap: d.pastCap, from: fromOf(i.shape) };
}

/**
 * What the import's stamp seals (importStamp(), ./stamp.ts), for each family the review shows, in its order: its
 * customer and the name the family is made with, the student customers it makes (each with the name and whether active
 * it is made with) and those it leaves alone (by name, as shown), and each guardian's name, address, Parent customer
 * linked (`""` for none) and person (`new`, or the person's id). So a read of the same company's roster between the
 * review and the press that renames a customer or changes a student's active flag refuses the press, rather than make
 * records or people under names the review never showed. A reused person's own name and families aren't sealed: the
 * person is, by id, and keeps their name. The ticks are the press's, not the stamp's.
 */
export const importKeys = (families: readonly ProposedFamily[]): string[] => families.map((f) => JSON.stringify([f.customerId, f.name,
  f.students.made.map((s) => [s.qboId, s.name, s.active]), f.students.leftAlone.map((s) => [s.qboId, s.name]),
  f.guardians.map((g) => [g.name, g.email, g.link?.qboId ?? "", g.person.kind === "new" ? "new" : g.person.id.toLowerCase()])]));
