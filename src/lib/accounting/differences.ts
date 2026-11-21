// The differences of the accounting links screen (stage 4's slice M2 of docs/superpowers/specs/2026-11-18-app-owned-families-design.md,
// section 5, "Differences"): for a family whose link stands, where the portal's own records and the portal's copy of
// the books disagree, each with both values. Only the structural differences are here: names, whether each record is
// active, the family a student is under, and students and Parent customers on one side only. Phone, mailing address
// and email wait for a later slice. Since slice M3c3 a guardian's own Parent customer is compared with the guardian
// too: its name with the person's, and whether it is active with whether they are the family's guardian. Worked out at
// each view from what the screen's one reader already reads
// (loadAccountingLinks(), ./mapping.ts) and stored nowhere. Pure: it reads nothing, and every input is passed in. It
// settles nothing either: no difference here is sent, taken or promised to be.
import type { AppStudentId } from "@/lib/families/ids";
import { recordNameWords } from "@/lib/families/words";
import type { Cust, Family, Roster } from "@/lib/roster/model";
import { normalName } from "@/lib/roster/names";
import { placesOf, placeWords, type StudentPlace } from "@/lib/roster/place";
import type { MembershipShape } from "@/lib/roster/shape";

/** A change on the write queue that explains a difference, in the queue's own words (worded by the reader: queueNoteOf() in ./mapping.ts). */
export type QueueNote = { state: "waiting" | "stuck" | "refused"; words: string };
/**
 * A queue item as this module needs it: what it changes, by the ids it names, and its words. Every item the queue
 * gives is of the roster's company: a change of company's clear gives up every item still to go, a different company
 * is refused, and loadOpenWrites() reads only the roster's company's (ofRosterCompany, src/lib/roster/source.ts: stage
 * 4's slice M7a3), so a parent's change saved as the clear ran, open until the worker's next wake, is never among them.
 */
export type QueueFact = QueueNote & { op: string; role: string | null; qboId: string | null; studentId: string | null; guardianId: string | null };

/**
 * One difference:
 * - `name`: the record's name (`portal`, null when the portal knows none) against its linked customer's (`books`);
 * - `active`: the record is active in the portal and its customer inactive in the books (`portalActive`), or the
 *   reverse (an inactive student record whose customer the roster lists active under the family);
 * - `place`: where the books have an active student's linked customer, when that isn't under the family's own;
 * - `student_customer`: an active student customer under the family's customer that no student record is linked to;
 * - `student_elsewhere`: an active student customer under the family's customer whose linked student record isn't
 *   this family's: the portal has it in another family (`portal.family`, the record's words for it), in no family, or
 *   inactive. The record's own family's row, when compared, tells it too, as its place: each row truly, once each;
 * - `student_unlinked`: an active student record of the family with no link of its own;
 * - `parent_customers`: how many active Parent customers under the family's customer no guardian row is linked to;
 * - `guardians_unlinked`: how many of the family's open guardian rows have no link, with the queue's words for those a
 *   Parent customer create is on the queue for, as counts;
 * - `guardian_name` (slice M3c3): an open guardian row's own Parent customer, active in the books, whose name (`books`)
 *   isn't the person's (`portal`, and `who`);
 * - `guardian_active` (slice M3c3): a guardian's own Parent customer inactive in the books while they are the family's
 *   guardian (`portalOpen`), or active while they are removed from the family.
 * `of` names the record: the family (layered books), the member (flat books) or a student, by its record's id (`studentId`). `queue`: the change on the
 * write queue that explains it, if any (still a difference: the values differ until the books or the portal change).
 */
export type Difference =
  | ({ kind: "name"; portal: string | null; books: string; queue: QueueNote | null } & RecordOf)
  | ({ kind: "active"; who: string; portalActive: boolean; queue: QueueNote | null } & RecordOf)
  | { kind: "place"; who: string; studentId: AppStudentId; place: Exclude<StudentPlace, { at: "here" } | { at: "unknown" }>; queue: QueueNote | null }
  | { kind: "student_customer"; books: string }
  | { kind: "student_elsewhere"; books: string; studentId: AppStudentId; portal: StudentElsewhere; queue: QueueNote | null }
  | { kind: "student_unlinked"; who: string; studentId: AppStudentId; queue: QueueNote | null }
  | { kind: "parent_customers"; count: number }
  | { kind: "guardians_unlinked"; count: number; queue: { note: QueueNote; count: number }[] }
  | { kind: "guardian_name"; guardianId: string; who: string; portal: string; books: string; queue: QueueNote | null }
  | { kind: "guardian_active"; guardianId: string; who: string; portalOpen: boolean; queue: QueueNote | null };
/**
 * Whose `name` or `active` difference it is: the family's or the member's (the row's own record), or a student's, with
 * the student record's id (stage 4's slice M4a: Take QuickBooks' into the app names the record it changes).
 */
export type RecordOf = { of: "family" | "member" } | { of: "student"; studentId: AppStudentId };
/** Where the portal has a student record whose customer the books have under another family: by the record's words for its family, in none, or inactive. */
export type StudentElsewhere = { at: "family"; family: string } | { at: "no_family" } | { at: "inactive" };
/** A student record some student link names, as the screen needs it: its id, whether it is active, and its family's words (null: in none). */
export type LinkedStudent = { id: AppStudentId; active: boolean; family: string | null };
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
  /**
   * Since slice M3c3, its guardian rows with a link of the records' company, to compare with their own Parent customers,
   * in the order the differences list them: the open rows, then the closed ones not closed by a change of company, each
   * by name then id. None given, none compared.
   */
  ownParents?: readonly GuardianToCompare[];
};

/**
 * A guardian row of the family with a link of the records' company, as differencesOf() compares it with its own Parent
 * customer (slice M3c3): the person's name (`who`), whether the row is open (`open`: a guardian of the family) or closed
 * (removed from it, but not by a change of company), its link's customer, whether no other open row is linked to that
 * customer (`alone`), and, for an open row, ownNamedElsewhere()'s rule (src/lib/roster/writes.ts): another open row of
 * the person's is linked to an active customer of the parent type with their name by nameKey() (`namedElsewhere`).
 */
export type GuardianToCompare = { guardianId: string; who: string; open: boolean; customerId: string; alone: boolean; namedElsewhere: boolean };

/**
 * Which queue item explains which difference: the first in the order given (loadOpenWrites()'s, newest first) of each
 * kind. A name, a `rename` of that customer; active, a `deactivate` of it; a student's place, a `move` of that student
 * record; a student record with no link, a student's `create` filed under it; a guardian row with no link, a `create`
 * naming that row (guardianOf()). Any other item explains nothing here, an op this module doesn't know included (a
 * parent's phone or address waiting to be sent, `contact`, or any later one): it is passed over, never thrown on,
 * whatever ids it names.
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
 * `studentRecords` are the customers any student link of the records' company names, each with its record, and
 * `guardianLinked` the customers any guardian link names (of an open or a closed row). A customer either kind of link
 * names is on no side "only". Every active student customer directly under the family's customer is told in this row:
 * one whose record is an active student of this family is compared as that record; one whose record is this family's
 * but inactive, as that record's active difference; one whose record isn't this family's, as `student_elsewhere`,
 * whatever that record's own family's row says (that row may not be compared at all: a family with no link, Not a
 * family now, Customer gone, or no family), with a move of that record on the queue (filed under the family left) as
 * its note, or for an inactive record a make-inactive of its customer. One a guardian link names (the books changed its
 * type between Parent and Student) shows in the opening's guardians, never as a customer with no record. Names are
 * compared after the portal's own name rule (normalName(), which checkName() applies to every name staff type:
 * composed accents, trimmed, each run of spaces one), so two names that differ only there, which look alike on the page
 * and which no rename in the portal could change (the portal's name is already in that form), are the same; a
 * difference of case or of any visible character is a difference (nameKey(), which ignores case, is the rule of which
 * names are taken, not this one). A record with no name differs from any name. Nothing of students (a name, whether
 * active, a place, one on either side only) is compared unless the shape has a student type, in layered books; nothing
 * of Parent customers or guardians unless it has a parent type.
 *
 * A guardian with their own Parent customer (slice M3c3, `ownParents`): a customer the cache holds, of the parent type,
 * directly under the family's customer, that no other open row is linked to (ownParentCustomer()'s rule in
 * src/lib/roster/writes.ts, M3c's `own` standing). An open row's: inactive in the books, `guardian_active` (no name is
 * compared, as nothing is renamed there); active, `guardian_name` where its name isn't the person's by the same name
 * rule, but not while another open row of the person's holds their name (`namedElsewhere`: QuickBooks takes a name once,
 * so this customer could never have it). A closed row's, active in the books: `guardian_active`, removed in the portal,
 * with a make-inactive of it as its note. A shared, elsewhere or gone link has its own words in the row's opening, and
 * is not compared here. After every other kind, in the order given.
 */
export function differencesOf(o: { shape: MembershipShape; roster: Roster; customers: readonly Cust[]; studentRecords: ReadonlyMap<string, LinkedStudent>;
  guardianLinked: ReadonlySet<string>; queue: readonly QueueFact[] }): (f: FamilyToCompare) => FamilyDifferences {
  const byId = new Map(o.customers.map((c) => [c.qboId, c]));
  const listed = new Map<string, Family>(o.roster.kind === "flat" ? [] : o.roster.families.map((f) => [f.customer.qboId, f]));
  const placeOf = placesOf(o.shape, o.roster, o.customers);
  const q = indexQueue(o.queue);
  const studentType = o.shape.kind === "layered" && o.shape.studentTypeId !== null;
  const parentTypeId = o.shape.kind === "layered" ? o.shape.parentTypeId : null;
  const parentType = parentTypeId !== null;
  const linked = (id: string) => o.studentRecords.has(id) || o.guardianLinked.has(id);
  return (f) => {
    const customer = byId.get(f.customerId);
    if (customer === undefined) return { differences: [], inactiveUnrecorded: 0 };
    const out: Difference[] = [];
    if (!sameName(f.name, customer.displayName)) out.push({ kind: "name", of: f.kind, portal: f.name, books: customer.displayName, queue: q.rename.get(customer.qboId) ?? null });
    if (!customer.active) out.push({ kind: "active", of: f.kind, who: recordNameWords(f.name, "family"), portalActive: true, queue: q.deactivate.get(customer.qboId) ?? null });
    const there = listed.get(f.customerId);
    for (const s of studentType ? f.students : []) {
      const who = recordNameWords(s.name, "student");
      if (s.customerId === null) {
        if (s.active) out.push({ kind: "student_unlinked", who, studentId: s.id, queue: q.studentCreate.get(String(s.id)) ?? null });
        continue;
      }
      const c = byId.get(s.customerId);
      if (!s.active) {
        // An inactive record shows here only where the roster lists its customer, active, directly under the family's (as
        // the Families pages list it). One whose customer the books have active under another family is told in that
        // family's row, as a student whose record is inactive (student_elsewhere, below).
        if (c?.active && there?.students.some((x) => x.qboId === c.qboId)) out.push({ kind: "active", of: "student", studentId: s.id, who, portalActive: false, queue: q.deactivate.get(c.qboId) ?? null });
        continue;
      }
      if (c !== undefined && !sameName(s.name, c.displayName)) out.push({ kind: "name", of: "student", studentId: s.id, portal: s.name, books: c.displayName, queue: q.rename.get(c.qboId) ?? null });
      if (c !== undefined && !c.active) out.push({ kind: "active", of: "student", studentId: s.id, who, portalActive: true, queue: q.deactivate.get(c.qboId) ?? null });
      const place = placeOf(s.customerId, f.customerId);
      if (place.at !== "here" && place.at !== "unknown") out.push({ kind: "place", who, studentId: s.id, place, queue: q.move.get(String(s.id)) ?? null });
    }
    let inactiveUnrecorded = 0;
    if (studentType && there !== undefined) {
      for (const c of there.students) {
        const record = o.studentRecords.get(c.qboId);
        if (record !== undefined) {
          // This family's record: compared above (an active one), or told above as inactive (an inactive one).
          if (!c.active || f.students.some((s) => s.id === record.id)) continue;
          out.push({ kind: "student_elsewhere", books: c.displayName, studentId: record.id,
            portal: !record.active ? { at: "inactive" } : record.family === null ? { at: "no_family" } : { at: "family", family: record.family },
            queue: q.move.get(String(record.id)) ?? (record.active ? undefined : q.deactivate.get(c.qboId)) ?? null });
          continue;
        }
        if (o.guardianLinked.has(c.qboId)) continue;
        if (c.active) out.push({ kind: "student_customer", books: c.displayName });
        else inactiveUnrecorded++;
      }
    }
    if (parentType && there !== undefined) {
      const parents = there.parents.filter((c) => c.active && !linked(c.qboId)).length;
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
    for (const g of parentType ? f.ownParents ?? [] : []) {
      const c = byId.get(g.customerId);
      if (c === undefined || c.typeQboId !== parentTypeId || c.parentQboId !== f.customerId || !g.alone) continue;
      if (!g.open) {
        if (c.active) out.push({ kind: "guardian_active", guardianId: g.guardianId, who: g.who, portalOpen: false, queue: q.deactivate.get(c.qboId) ?? null });
        continue;
      }
      if (!c.active) out.push({ kind: "guardian_active", guardianId: g.guardianId, who: g.who, portalOpen: true, queue: null });
      else if (!g.namedElsewhere && !sameName(g.who, c.displayName)) out.push({ kind: "guardian_name", guardianId: g.guardianId, who: g.who, portal: g.who, books: c.displayName, queue: q.rename.get(c.qboId) ?? null });
    }
    return { differences: out, inactiveUnrecorded };
  };
}

/** Whether the portal's name and the books' are the same by the portal's own name rule (differencesOf()); none is no name. */
const sameName = (portal: string | null, books: string) => portal !== null && normalName(portal) === normalName(books);

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
    case "student_elsewhere": return { what: "A student the books have under this family", books: `${quoted(d.books)}, a student customer under this family`,
      portal: d.portal.at === "family" ? `Their record is in ${d.portal.family}` : d.portal.at === "no_family" ? "Their record is in no family" : "Their record is inactive" };
    case "student_unlinked": return { what: "A student in the portal only", portal: d.who, books: "No customer of their own" };
    case "parent_customers": return { what: "Parent customers in the books only", portal: "No guardian linked to them",
      books: plural(d.count, "active Parent customer under this family", "active Parent customers under this family") };
    case "guardians_unlinked": return { what: "Guardians in the portal only", portal: plural(d.count, "guardian with no Parent customer of their own", "guardians with no Parent customer of their own"),
      books: "No Parent customer linked to them" };
    case "guardian_name": return { what: `${d.who}'s name on their Parent customer`, portal: quoted(d.portal), books: quoted(d.books) };
    case "guardian_active": return { what: `Whether ${d.who} is this family's guardian`, portal: d.portalOpen ? "A guardian of this family" : "Removed from this family",
      books: d.portalOpen ? "Their Parent customer is inactive" : "Their Parent customer is active" };
  }
}

/**
 * What staff can do about a guardian's difference (slice M3c3), in one sentence drawn in place of a press: neither
 * value is taken or sent from the screen. Only what the code makes so: a person's rename is refused while a change of
 * one of their rows' Parent customers is waiting or stuck (renamePerson(), guardianChangeWaiting()), and otherwise asks
 * QuickBooks to rename their own active Parent customer only while QuickBooks is connected to the roster's company and
 * the family's customer is active (queueForGuardian()'s rename, guardianBooks(), which gives a name to one record of
 * theirs only); a guardian added back has their own Parent customer again (queueForGuardian()'s grant, `has_one`); and nothing
 * the portal sends for a guardian goes to a customer the books have inactive (queueForGuardian(), and the targets of
 * the details and sign-in email queues, src/lib/parents/contact-queue.ts), which it never makes active (open question
 * 12). Null for any other kind.
 */
export function guardianDifferenceNext(d: Difference): string | null {
  if (d.kind === "guardian_name") return GUARDIAN_NEXT.name;
  if (d.kind === "guardian_active") return d.portalOpen ? GUARDIAN_NEXT.inactive : GUARDIAN_NEXT.removed;
  return null;
}
const GUARDIAN_NEXT = {
  name: "Neither name is taken or sent from this page. Rename their Parent customer in QuickBooks, and this row shows it after the portal's next roster read; or, if the person's name should change, rename them on their page under Parents once nothing for them or their Parent customers is waiting or stuck on Reconciliation. While QuickBooks is connected and the family's customer is active, that asks QuickBooks to rename it too, unless the same rename gives that name to their own Parent customer under another family first.",
  removed: "Neither is taken or sent from this page. Make their Parent customer inactive in QuickBooks once its balance, owed or a credit, is settled; or, if they are added back under Portal sign-ins, it is theirs again.",
  inactive: "Neither is taken or sent from this page, and the portal never makes a customer active in the books. If they are still this family's guardian, make it active in QuickBooks; if they aren't, remove them under Portal sign-ins. While it is inactive the portal sends it nothing for them: no rename, and no change of their phone, mailing address or sign-in email.",
} as const;

/** The kinds a row's differences are of, in words, each once, in a fixed order: for the row's status line. */
export function differenceKinds(ds: readonly Difference[]): string[] {
  const groups: [string, Difference["kind"][]][] = [
    ["names", ["name"]], ["whether a record is active", ["active"]], ["where a student is", ["place", "student_elsewhere"]],
    ["students on one side only", ["student_customer", "student_unlinked"]], ["Parent customers or guardians on one side only", ["parent_customers", "guardians_unlinked"]],
    ["guardians' Parent customers", ["guardian_name", "guardian_active"]],
  ];
  return groups.filter(([, kinds]) => ds.some((d) => kinds.includes(d.kind))).map(([words]) => words);
}

/** A queue note in a sentence: the queue's words, ending with a full stop once. */
export const noteSentence = (n: QueueNote) => (n.words.endsWith(".") ? n.words : `${n.words}.`);
