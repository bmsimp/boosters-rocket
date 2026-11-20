// The differences of the accounting links screen (stage 4's slice M2 of docs/superpowers/specs/2026-11-18-app-owned-families-design.md,
// section 5, "Differences"): for a family whose link stands, where the portal's own records and the portal's copy of
// the books disagree, each with both values. Only the structural differences are here: names, whether each record is
// active, the family a student is under, and students and Parent customers on one side only. Phone, mailing address
// and email wait for a later slice. Worked out at each view from what the screen's one reader already reads
// (loadAccountingLinks(), ./mapping.ts) and stored nowhere. Pure: it reads nothing, and every input is passed in. It
// settles nothing either: no difference here is sent, taken or promised to be.
import type { AppStudentId } from "@/lib/families/ids";
import { recordNameWords } from "@/lib/families/words";
import type { Cust, Family, Roster } from "@/lib/roster/model";
import { placesOf, placeWords, type StudentPlace } from "@/lib/roster/place";
import type { MembershipShape } from "@/lib/roster/shape";

/** A change on the write queue that explains a difference, in the queue's own words (worded by the reader: queueNoteOf() in ./mapping.ts). */
export type QueueNote = { state: "waiting" | "stuck" | "refused"; words: string };
/**
 * A queue item as this module needs it: what it changes, by the ids it names, and its words. Every item the queue
 * gives is of the roster's company: a change of company's clear deletes the queue, and a different company is refused.
 */
export type QueueFact = QueueNote & { op: string; role: string | null; qboId: string | null; studentId: string | null; guardianId: string | null };

/**
 * One difference:
 * - `name`: the record's name (`portal`, null when the portal knows none) against its linked customer's (`books`);
 * - `active`: the record is active in the portal and its customer inactive in the books (`portalActive`), or the
 *   reverse (an inactive student record whose customer the roster lists active under the family);
 * - `place`: where the books have an active student's linked customer, when that isn't under the family's own;
 * - `student_customer`: an active student customer under the family's customer that no student record is linked to;
 * - `student_unlinked`: an active student record of the family with no link of its own;
 * - `parent_customers`: how many active Parent customers under the family's customer no guardian row is linked to;
 * - `guardians_unlinked`: how many of the family's open guardian rows have no link, with the queue's words for those a
 *   Parent customer create is on the queue for, as counts.
 * `of` names the record: the family (layered books), the member (flat books) or a student. `queue`: the change on the
 * write queue that explains it, if any (still a difference: the values differ until the books or the portal change).
 */
export type Difference =
  | { kind: "name"; of: "family" | "member" | "student"; portal: string | null; books: string; queue: QueueNote | null }
  | { kind: "active"; of: "family" | "member" | "student"; who: string; portalActive: boolean; queue: QueueNote | null }
  | { kind: "place"; who: string; studentId: AppStudentId; place: Exclude<StudentPlace, { at: "here" } | { at: "unknown" }>; queue: QueueNote | null }
  | { kind: "student_customer"; books: string }
  | { kind: "student_unlinked"; who: string; studentId: AppStudentId; queue: QueueNote | null }
  | { kind: "parent_customers"; count: number }
  | { kind: "guardians_unlinked"; count: number; queue: { note: QueueNote; count: number }[] };
export type FamilyDifferences = {
  differences: Difference[];
  /** Inactive student customers under the family's customer with no student record: only counted, never a difference. */
  inactiveUnrecorded: number;
};

/** A family whose link stands, as the reader gives it: its records, each with its own link's customer in the records' company. */
export type FamilyToCompare = {
  /** `family` in layered books, `member` in flat books. */
  kind: "family" | "member";
  /** The record's own name, null when the portal knows none. */
  name: string | null;
  /** The customer its family link names, which the cache holds (the link stands). */
  customerId: string;
  /** Every student record of the family, active or not, with its student link's customer (null: none). */
  students: readonly { id: AppStudentId; name: string | null; active: boolean; customerId: string | null }[];
  /** Its open guardian rows, by id, with their own link's customer (null: none). */
  guardians: readonly { id: string; customerId: string | null }[];
};

/**
 * Which queue item explains which difference: the first in the order given (loadOpenWrites()'s, newest first) of each
 * kind. A name, a `rename` of that customer; active, a `deactivate` of it; a student's place, a `move` of that student
 * record; a student record with no link, a student's `create` filed under it; a guardian row with no link, a `create`
 * naming that row (guardianOf()). Any other item explains nothing here.
 */
export function indexQueue(items: readonly QueueFact[]) {
  const rename = new Map<string, QueueNote>(), deactivate = new Map<string, QueueNote>(), move = new Map<string, QueueNote>();
  const studentCreate = new Map<string, QueueNote>(), guardianCreate = new Map<string, QueueNote>();
  const first = (m: Map<string, QueueNote>, key: string | null, i: QueueFact) => { if (key !== null && !m.has(key)) m.set(key, { state: i.state, words: i.words }); };
  for (const i of items) {
    if (i.op === "rename") first(rename, i.qboId, i);
    else if (i.op === "deactivate") first(deactivate, i.qboId, i);
    else if (i.op === "move") first(move, i.studentId, i);
    else if (i.op === "create" && i.guardianId !== null) first(guardianCreate, i.guardianId, i);
    else if (i.op === "create" && i.role === "student") first(studentCreate, i.studentId, i);
  }
  return { rename, deactivate, move, studentCreate, guardianCreate };
}

/**
 * The differences of each family whose link stands, over one roster: built once for the view, then asked per family.
 * `studentLinked` and `guardianLinked` are the customers any student or guardian link of the records' company names
 * (a guardian's: of an open or a closed row). Names are compared exactly (===), as renameLinked() decides a record has
 * a name already (ALREADY_NAMED) and tryRename() compares QuickBooks' with the portal's: the screen calls two names the
 * same exactly when a rename would send nothing, so a difference of case or spacing shows (nameKey() is the rule of
 * which names are taken, not this one). Students and Parent customers are compared only where the shape has their
 * type, in layered books; a student's place only where it has a student type.
 */
export function differencesOf(o: { shape: MembershipShape; roster: Roster; customers: readonly Cust[]; studentLinked: ReadonlySet<string>;
  guardianLinked: ReadonlySet<string>; queue: readonly QueueFact[] }): (f: FamilyToCompare) => FamilyDifferences {
  const byId = new Map(o.customers.map((c) => [c.qboId, c]));
  const listed = new Map<string, Family>(o.roster.kind === "flat" ? [] : o.roster.families.map((f) => [f.customer.qboId, f]));
  const placeOf = placesOf(o.shape, o.roster, o.customers);
  const q = indexQueue(o.queue);
  const studentType = o.shape.kind === "layered" && o.shape.studentTypeId !== null;
  const parentType = o.shape.kind === "layered" && o.shape.parentTypeId !== null;
  return (f) => {
    const customer = byId.get(f.customerId);
    if (customer === undefined) return { differences: [], inactiveUnrecorded: 0 };
    const out: Difference[] = [];
    if (f.name !== customer.displayName) out.push({ kind: "name", of: f.kind, portal: f.name, books: customer.displayName, queue: q.rename.get(customer.qboId) ?? null });
    if (!customer.active) out.push({ kind: "active", of: f.kind, who: recordNameWords(f.name, "family"), portalActive: true, queue: q.deactivate.get(customer.qboId) ?? null });
    const there = listed.get(f.customerId);
    for (const s of f.students) {
      const who = recordNameWords(s.name, "student");
      if (s.customerId === null) {
        if (s.active && studentType) out.push({ kind: "student_unlinked", who, studentId: s.id, queue: q.studentCreate.get(String(s.id)) ?? null });
        continue;
      }
      const c = byId.get(s.customerId);
      if (!s.active) {
        // An inactive record shows only where the roster lists its customer, active, directly under the family's (as the Families pages list it).
        if (c?.active && there?.students.some((x) => x.qboId === c.qboId)) out.push({ kind: "active", of: "student", who, portalActive: false, queue: q.deactivate.get(c.qboId) ?? null });
        continue;
      }
      if (c !== undefined && s.name !== c.displayName) out.push({ kind: "name", of: "student", portal: s.name, books: c.displayName, queue: q.rename.get(c.qboId) ?? null });
      if (c !== undefined && !c.active) out.push({ kind: "active", of: "student", who, portalActive: true, queue: q.deactivate.get(c.qboId) ?? null });
      if (studentType) {
        const place = placeOf(s.customerId, f.customerId);
        if (place.at !== "here" && place.at !== "unknown") out.push({ kind: "place", who, studentId: s.id, place, queue: q.move.get(String(s.id)) ?? null });
      }
    }
    let inactiveUnrecorded = 0;
    if (studentType && there !== undefined) {
      for (const c of there.students) {
        if (o.studentLinked.has(c.qboId)) continue;
        if (c.active) out.push({ kind: "student_customer", books: c.displayName });
        else inactiveUnrecorded++;
      }
    }
    if (parentType && there !== undefined) {
      const parents = there.parents.filter((c) => c.active && !o.guardianLinked.has(c.qboId)).length;
      if (parents > 0) out.push({ kind: "parent_customers", count: parents });
      const rows = f.guardians.filter((g) => g.customerId === null);
      if (rows.length > 0) {
        const notes = new Map<string, { note: QueueNote; count: number }>();
        for (const g of rows) {
          const note = q.guardianCreate.get(g.id);
          if (note === undefined) continue;
          const had = notes.get(note.words);
          if (had) had.count++; else notes.set(note.words, { note, count: 1 });
        }
        out.push({ kind: "guardians_unlinked", count: rows.length, queue: [...notes.values()] });
      }
    }
    return { differences: out, inactiveUnrecorded };
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const quoted = (s: string) => `“${s}”`;
const recordWho = (of: "family" | "member" | "student") => (of === "family" ? "The family" : of === "member" ? "The member" : "A student");

/**
 * A difference in words: what differs, the portal's value and the books' value, each as text (the books' text and a
 * person's name are shown as text only). Only what is so: nothing here promises a way to make anything active (open
 * question 12), or says anything of money or sign-ins. A student's place is said in the words a family's page says it
 * in (placeWords()), which name QuickBooks; everything else says "the books".
 */
export function differenceWords(d: Difference): { what: string; portal: string; books: string } {
  switch (d.kind) {
    case "name": return { what: `${recordWho(d.of)}'s name`, portal: d.portal === null || d.portal.trim() === "" ? recordNameWords(null, d.of === "student" ? "student" : "family") : quoted(d.portal), books: quoted(d.books) };
    case "active": return { what: `Whether ${d.who} is active`, portal: d.portalActive ? "Active" : "Inactive", books: d.portalActive ? "Inactive" : "Active" };
    case "place": return { what: `Where ${d.who} is`, portal: "In this family", books: placeWords(d.place) };
    case "student_customer": return { what: "A student in the books only", portal: "No student record", books: `${quoted(d.books)}, a student customer under this family` };
    case "student_unlinked": return { what: "A student in the portal only", portal: d.who, books: "No customer of their own" };
    case "parent_customers": return { what: "Parent customers in the books only", portal: "No guardian linked to them",
      books: plural(d.count, "active Parent customer under this family", "active Parent customers under this family") };
    case "guardians_unlinked": return { what: "Guardians in the portal only", portal: plural(d.count, "guardian with no Parent customer of their own", "guardians with no Parent customer of their own"),
      books: "No Parent customer linked to them" };
  }
}

/** The kinds a row's differences are of, in words, each once, in a fixed order: for the row's status line. */
export function differenceKinds(ds: readonly Difference[]): string[] {
  const groups: [string, Difference["kind"][]][] = [
    ["names", ["name"]], ["whether a record is active", ["active"]], ["where a student is", ["place"]],
    ["students on one side only", ["student_customer", "student_unlinked"]], ["Parent customers or guardians on one side only", ["parent_customers", "guardians_unlinked"]],
  ];
  return groups.filter(([, kinds]) => ds.some((d) => kinds.includes(d.kind))).map(([words]) => words);
}

/** A queue note in a sentence: the queue's words, ending with a full stop once. */
export const noteSentence = (n: QueueNote) => (n.words.endsWith(".") ? n.words : `${n.words}.`);
