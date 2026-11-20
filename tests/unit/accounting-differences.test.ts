import { describe, it, expect } from "vitest";
import { differenceKinds, differencesOf, differenceWords, indexQueue, noteSentence, type Difference, type FamilyToCompare, type LinkedStudent, type QueueFact } from "@/lib/accounting/differences";
import { asAppStudentId, type AppStudentId } from "@/lib/families/ids";
import { buildRoster, type Cust } from "@/lib/roster/model";
import type { MembershipShape } from "@/lib/roster/shape";

/**
 * The accounting links screen's differences (stage 4's slice M2; src/lib/accounting/differences.ts): pure, over one
 * roster and the cache's customers. Family 1, Parent 2, Student 3, School 4.
 */
const c = (qboId: string, displayName: string, typeQboId: string | null, parentQboId: string | null = null, extra: Partial<Cust> = {}): Cust =>
  ({ qboId, displayName, active: true, parentQboId, typeQboId, email: null, phone: null, ...extra });
const company: Cust[] = [
  c("10", "Rivera Family", "1"), c("11", "Ana Rivera", "2", "10"), c("12", "Leo Rivera", "3", "10"),
  c("20", "Chen Family", "1"), c("22", "Sam Chen", "3", "20"),
  c("30", "Lincoln High", "4"), c("31", "Kim Lincoln", "3", "30"), c("50", "Stray Student", "3"), c("60", "Now A Parent", "2", "10"),
];
const LAYERED: MembershipShape = { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: "2" };
const NO_PARENTS: MembershipShape = { kind: "layered", familyTypeId: "1", studentTypeId: "3", parentTypeId: null };
const NO_STUDENTS: MembershipShape = { kind: "layered", familyTypeId: "1", studentTypeId: null, parentTypeId: "2" };
const FLAT: MembershipShape = { kind: "flat", memberTypeIds: ["1"] };

const S1 = asAppStudentId("00000000-0000-4000-8000-000000000001"), S2 = asAppStudentId("00000000-0000-4000-8000-000000000002");
const S3 = asAppStudentId("00000000-0000-4000-8000-000000000003");
const student = (id: AppStudentId, name: string | null, customerId: string | null, active = true) => ({ id, name, active, customerId });
/** The Rivera family as the portal has it, every record matching the books, Ana's guardian row linked to her Parent customer. */
const rivera = (o: Partial<FamilyToCompare> = {}): FamilyToCompare => ({ kind: "family", name: "Rivera Family", customerId: "10",
  students: [student(S1, "Leo Rivera", "12")], guardians: [{ id: "g-ana", customerId: "11" }], ...o });
/** The student records the links name, by customer: Leo Rivera's (12) and Sam Chen's (22), each active in their own family. */
const RECORDS: Record<string, LinkedStudent> = { "12": { id: S1, active: true, family: "Rivera Family" }, "22": { id: S2, active: true, family: "Chen Family" } };
/** `studentLinked`: which of RECORDS' customers a student link names; `records`: others, or those records changed. */
function compare(f: FamilyToCompare, o: { shape?: MembershipShape; customers?: Cust[]; studentLinked?: string[]; records?: Record<string, LinkedStudent>; guardianLinked?: string[]; queue?: QueueFact[] } = {}) {
  const shape = o.shape ?? LAYERED, customers = o.customers ?? company;
  const studentRecords = new Map<string, LinkedStudent>([...(o.studentLinked ?? ["12", "22"]).map((id): [string, LinkedStudent] => [id, RECORDS[id]!]), ...Object.entries(o.records ?? {})]);
  return differencesOf({ shape, roster: buildRoster(shape, customers), customers, studentRecords,
    guardianLinked: new Set(o.guardianLinked ?? ["11", "60"]), queue: o.queue ?? [] })(f);
}
const changed = (id: string, change: Partial<Cust>) => company.map((x) => (x.qboId === id ? { ...x, ...change } : x));
/** The queue's words a single difference carries, or null. */
const wordsOf = (d: Difference) => (d.kind === "name" || d.kind === "active" || d.kind === "place" || d.kind === "student_unlinked" ? d.queue?.words ?? null : null);
const fact = (f: Partial<QueueFact> & Pick<QueueFact, "op">): QueueFact => ({ state: "waiting", words: "Waiting to reach QuickBooks", role: null, qboId: null, studentId: null, guardianId: null, ...f });

describe("a family whose records match the books", () => {
  it("has no differences, in each shape", () => {
    expect(compare(rivera())).toEqual({ differences: [], inactiveUnrecorded: 0 });
    expect(compare(rivera(), { shape: NO_PARENTS })).toEqual({ differences: [], inactiveUnrecorded: 0 });
    expect(compare(rivera(), { shape: NO_STUDENTS })).toEqual({ differences: [], inactiveUnrecorded: 0 });
    expect(compare(rivera({ kind: "member", students: [], guardians: [] }), { shape: FLAT })).toEqual({ differences: [], inactiveUnrecorded: 0 });
  });
  it("has none when the cache doesn't hold its customer (Customer gone is a status, not a difference)", () => {
    expect(compare(rivera({ customerId: "99", name: "Anyone" }))).toEqual({ differences: [], inactiveUnrecorded: 0 });
  });
});

describe("names", () => {
  it("the family's and a student's, compared exactly: a difference of case or spacing shows", () => {
    expect(compare(rivera({ name: "Rivera family" })).differences).toEqual([{ kind: "name", of: "family", portal: "Rivera family", books: "Rivera Family", queue: null }]);
    expect(compare(rivera({ students: [student(S1, "Leo  Rivera", "12")] })).differences).toEqual([{ kind: "name", of: "student", portal: "Leo  Rivera", books: "Leo Rivera", queue: null }]);
  });
  it("a record with no name differs from any name the books hold, said in the portal's words for none", () => {
    const [d] = compare(rivera({ name: null })).differences;
    expect(d).toEqual({ kind: "name", of: "family", portal: null, books: "Rivera Family", queue: null });
    expect(differenceWords(d!)).toEqual({ what: "The family's name", portal: "A family whose name the portal doesn't know", books: "“Rivera Family”" });
    expect(differenceWords(compare(rivera({ students: [student(S1, null, "12")] })).differences[0]!).portal).toBe("A student whose name the portal doesn't know");
  });
  it("a member's, in flat books", () => {
    expect(compare(rivera({ kind: "member", name: "The Riveras", students: [], guardians: [] }), { shape: FLAT }).differences)
      .toEqual([{ kind: "name", of: "member", portal: "The Riveras", books: "Rivera Family", queue: null }]);
  });
});

describe("whether each is active", () => {
  it("the family active in the portal and inactive in the books, said as only what is so", () => {
    const { differences } = compare(rivera(), { customers: changed("10", { active: false }) });
    expect(differences).toEqual([{ kind: "active", of: "family", who: "Rivera Family", portalActive: true, queue: null }]);
    expect(differenceWords(differences[0]!)).toEqual({ what: "Whether Rivera Family is active", portal: "Active", books: "Inactive" });
  });
  it("an active student whose customer is inactive, and an inactive student record whose customer the roster lists active under the family", () => {
    expect(compare(rivera(), { customers: changed("12", { active: false }) }).differences)
      .toEqual([{ kind: "active", of: "student", who: "Leo Rivera", portalActive: true, queue: null }]);
    const gone = compare(rivera({ students: [student(S1, "Leo Rivera", "12", false)] }));
    expect(gone.differences).toEqual([{ kind: "active", of: "student", who: "Leo Rivera", portalActive: false, queue: null }]);
    expect(differenceWords(gone.differences[0]!)).toMatchObject({ portal: "Inactive", books: "Active" });
    // An inactive record whose customer is inactive too, or not under the family, differs in nothing.
    expect(compare(rivera({ students: [student(S1, "Leo Rivera", "12", false)] }), { customers: changed("12", { active: false }) }).differences).toEqual([]);
    expect(compare(rivera({ students: [student(S1, "Leo Rivera", "22", false)] })).differences).toEqual([]);
  });
});

describe("the family a student is under", () => {
  const placeOf = (customerId: string, customers = company) => compare(rivera({ students: [student(S1, "Leo Rivera", customerId)] }), { customers }).differences
    .filter((d) => d.kind === "place");
  it("under another family, at the top of the tree, under a customer that is no family, not a student customer now, or gone", () => {
    expect(placeOf("22")).toEqual([{ kind: "place", who: "Leo Rivera", studentId: S1, place: { at: "other_family", familyQboId: "20", familyName: "Chen Family" }, queue: null }]);
    expect(placeOf("50").map((d) => d.place)).toEqual([{ at: "top" }]);
    expect(placeOf("31").map((d) => d.place)).toEqual([{ at: "under_other" }]);
    expect(placeOf("60").map((d) => d.place)).toEqual([{ at: "not_student" }]);
    expect(placeOf("99").map((d) => d.place)).toEqual([{ at: "gone" }]);
  });
  it("says it in the family's page's words", () => {
    expect(differenceWords(placeOf("22")[0]!)).toEqual({ what: "Where Leo Rivera is", portal: "In this family", books: "Under Chen Family in QuickBooks" });
  });
  it("isn't compared with no student type, nor in flat books", () => {
    expect(compare(rivera({ students: [student(S1, "Leo Rivera", "22")] }), { shape: NO_STUDENTS }).differences.filter((d) => d.kind === "place")).toEqual([]);
    expect(compare(rivera({ kind: "member", students: [student(S1, "Leo Rivera", "22")], guardians: [] }), { shape: FLAT }).differences.filter((d) => d.kind === "place")).toEqual([]);
  });
});

describe("students on one side only", () => {
  it("an active student customer under the family no student link names, by name; inactive ones only counted", () => {
    const customers = [...company, c("13", "Zoe Rivera", "3", "10"), c("14", "Old Rivera", "3", "10", { active: false })];
    const r = compare(rivera(), { customers });
    expect(r.differences).toEqual([{ kind: "student_customer", books: "Zoe Rivera" }]);
    expect(r.inactiveUnrecorded).toBe(1);
    expect(differenceWords(r.differences[0]!)).toEqual({ what: "A student in the books only", portal: "No student record", books: "“Zoe Rivera”, a student customer under this family" });
  });
  it("never one another family's student record is linked to: both rows tell it, this one as a student whose record is elsewhere, that one as its place", () => {
    const customers = changed("22", { parentQboId: "10" }); // Sam Chen moved under the Riveras in the books alone
    const r = compare(rivera(), { customers }).differences;
    expect(r).toEqual([{ kind: "student_elsewhere", books: "Sam Chen", studentId: S2, portal: { at: "family", family: "Chen Family" }, queue: null }]);
    expect(differenceWords(r[0]!)).toEqual({ what: "A student the books have under this family", portal: "Their record is in Chen Family", books: "“Sam Chen”, a student customer under this family" });
    expect(differenceKinds(r)).toEqual(["where a student is"]);
    const chen: FamilyToCompare = { kind: "family", name: "Chen Family", customerId: "20", students: [student(S2, "Sam Chen", "22")], guardians: [] };
    expect(compare(chen, { customers }).differences.map((d) => d.kind)).toEqual(["place"]);
  });
  it("an active student record with no link; none for an inactive one", () => {
    expect(compare(rivera({ students: [student(S1, "Leo Rivera", "12"), student(S3, "Ivy Rivera", null), student(S2, "Gone Rivera", null, false)] })).differences)
      .toEqual([{ kind: "student_unlinked", who: "Ivy Rivera", studentId: S3, queue: null }]);
  });
  it("isn't compared with no student type", () => {
    const customers = [...company, c("13", "Zoe Rivera", "3", "10")];
    expect(compare(rivera({ students: [student(S3, "Ivy Rivera", null)] }), { shape: NO_STUDENTS, customers }).differences).toEqual([]);
  });
});

describe("a student customer under the family whose record the portal has elsewhere", () => {
  // Leo Rivera's customer (12) stays under the Riveras in the books; his record isn't the Riveras' in the portal.
  const leoIs = (record: LinkedStudent, queue: QueueFact[] = []) => compare(rivera({ students: [] }), { records: { "12": record }, queue }).differences;
  it("in a family with no link, after a move kept refused as that family has no customer: with the move's words", () => {
    const kept = fact({ op: "move", studentId: String(S1), qboId: "12", state: "refused",
      words: "The portal held it back: the family the student was moved to has no customer in QuickBooks yet, so there is nowhere to put them there." });
    const r = leoIs({ id: S1, active: true, family: "The Patels" }, [kept]);
    expect(r).toEqual([{ kind: "student_elsewhere", books: "Leo Rivera", studentId: S1, portal: { at: "family", family: "The Patels" }, queue: { state: "refused", words: kept.words } }]);
  });
  it("in a family whose link reads Not a family now, so its row compares nothing", () => {
    // The Chens' customer is a School now; Sam Chen's customer is under the Riveras.
    const customers = changed("22", { parentQboId: "10" }).map((x) => (x.qboId === "20" ? { ...x, typeQboId: "4" } : x));
    expect(compare(rivera(), { customers }).differences).toEqual([{ kind: "student_elsewhere", books: "Sam Chen", studentId: S2, portal: { at: "family", family: "Chen Family" }, queue: null }]);
  });
  it("in no family", () => {
    const r = leoIs({ id: S1, active: true, family: null });
    expect(r).toEqual([{ kind: "student_elsewhere", books: "Leo Rivera", studentId: S1, portal: { at: "no_family" }, queue: null }]);
    expect(differenceWords(r[0]!).portal).toBe("Their record is in no family");
  });
  it("inactive, in another family, its customer active here: told here, with a make-inactive of its customer as its note, and nothing in its own family's row", () => {
    const customers = changed("22", { parentQboId: "10" });
    const off = fact({ op: "deactivate", qboId: "22", state: "stuck", words: "Stuck: it needs someone to look at it" });
    const r = compare(rivera(), { customers, records: { "22": { id: S2, active: false, family: "Chen Family" } }, queue: [off] }).differences;
    expect(r).toEqual([{ kind: "student_elsewhere", books: "Sam Chen", studentId: S2, portal: { at: "inactive" }, queue: { state: "stuck", words: off.words } }]);
    expect(differenceWords(r[0]!).portal).toBe("Their record is inactive");
    const chen: FamilyToCompare = { kind: "family", name: "Chen Family", customerId: "20", students: [student(S2, "Sam Chen", "22", false)], guardians: [] };
    expect(compare(chen, { customers, records: { "22": { id: S2, active: false, family: "Chen Family" } } }).differences).toEqual([]);
  });
  it("the ordinary case is unchanged: a record of this family, active or inactive, is told as that record, never as elsewhere", () => {
    expect(compare(rivera()).differences).toEqual([]);
    expect(compare(rivera({ students: [student(S1, "Leo Rivera", "12", false)] }), { records: { "12": { id: S1, active: false, family: "Rivera Family" } } }).differences)
      .toEqual([{ kind: "active", of: "student", who: "Leo Rivera", portalActive: false, queue: null }]);
    // An inactive customer whose record is elsewhere is neither told nor counted.
    const r = compare(rivera({ students: [] }), { customers: changed("12", { active: false }), records: { "12": { id: S1, active: true, family: "Chen Family" } } });
    expect(r).toEqual({ differences: [], inactiveUnrecorded: 0 });
  });
});

describe("Parent customers and guardians, as counts", () => {
  it("active Parent customers no guardian link names, and open guardian rows with no link", () => {
    const customers = [...company, c("15", "Raul Rivera", "2", "10"), c("16", "Old Parent", "2", "10", { active: false })];
    const r = compare(rivera({ guardians: [{ id: "g-ana", customerId: "11" }, { id: "g-raul", customerId: null }, { id: "g-sol", customerId: null }] }), { customers });
    expect(r.differences).toEqual([{ kind: "parent_customers", count: 1 }, { kind: "guardians_unlinked", count: 2, queue: [] }]);
    expect(differenceWords(r.differences[0]!)).toEqual({ what: "Parent customers in the books only", portal: "No guardian linked to them", books: "1 active Parent customer under this family" });
    expect(differenceWords(r.differences[1]!)).toEqual({ what: "Guardians in the portal only", portal: "2 guardians with no Parent customer of their own", books: "No Parent customer linked to them" });
  });
  it("a Parent customer a closed row's link names counts as linked", () => {
    expect(compare(rivera({ guardians: [] }), { guardianLinked: ["11", "60"] }).differences).toEqual([]);
    expect(compare(rivera({ guardians: [] }), { guardianLinked: ["60"] }).differences).toEqual([{ kind: "parent_customers", count: 1 }]);
  });
  it("a customer whose type the books changed between Student and Parent shows once, through the record it is linked to", () => {
    // Leo's customer retyped as a Parent: his place says so, and it isn't counted as a Parent customer with no guardian.
    expect(compare(rivera(), { customers: changed("12", { typeQboId: "2" }) }).differences.map((d) => d.kind)).toEqual(["place"]);
    // Ana's Parent customer retyped as a Student: her guardian row is linked to it, so it is no student with no record.
    expect(compare(rivera(), { customers: changed("11", { typeQboId: "3" }) }).differences).toEqual([]);
  });
  it("aren't compared with no parent type, nor in flat books", () => {
    const f = rivera({ guardians: [{ id: "g-sol", customerId: null }] });
    expect(compare(f, { shape: NO_PARENTS, guardianLinked: [] }).differences).toEqual([]);
    expect(compare({ ...f, kind: "member", students: [] }, { shape: FLAT, guardianLinked: [] }).differences).toEqual([]);
  });
});

describe("several at once", () => {
  it("lists each, and says their kinds once each, in order", () => {
    const customers = [...changed("10", { displayName: "Rivera Household", active: false }), c("13", "Zoe Rivera", "3", "10")];
    // Sam Chen's record is the Riveras' in the portal, his customer under the Chens in the books; Leo and Zoe Rivera have no student record.
    const r = compare(rivera({ students: [student(S1, "Sam Chen", "22"), student(S3, "Ivy Rivera", null)], guardians: [{ id: "g-sol", customerId: null }] }),
      { customers, studentLinked: ["22"], guardianLinked: [] });
    expect(r.differences.map((d) => d.kind)).toEqual(["name", "active", "place", "student_unlinked", "student_customer", "student_customer", "parent_customers", "guardians_unlinked"]);
    expect(differenceKinds(r.differences)).toEqual(["names", "whether a record is active", "where a student is", "students on one side only", "Parent customers or guardians on one side only"]);
  });
});

describe("the queue's words", () => {
  const kept = fact({ op: "rename", qboId: "10", state: "refused", words: "QuickBooks refused it: QuickBooks wouldn't take it." });
  it("explain a difference of their own kind, the first in the queue's order", () => {
    const newer = fact({ op: "rename", qboId: "10", state: "stuck", words: "Stuck: it needs someone to look at it" });
    expect(compare(rivera({ name: "Riveras" }), { queue: [newer, kept] }).differences[0]).toMatchObject({ kind: "name", queue: { state: "stuck", words: "Stuck: it needs someone to look at it" } });
    expect(compare(rivera({ name: "Riveras" }), { queue: [kept] }).differences[0]).toMatchObject({ queue: { state: "refused", words: kept.words } });
  });
  it("a move explains a student's place, a create filed under a student its missing link, a deactivate an active difference", () => {
    const move = fact({ op: "move", studentId: String(S1), qboId: "12" });
    const create = fact({ op: "create", role: "student", studentId: String(S3), words: "Done in QuickBooks: the portal finishes it on its side after its next read of QuickBooks" });
    const off = fact({ op: "deactivate", qboId: "10" });
    const r = compare(rivera({ students: [student(S1, "Sam Chen", "22"), student(S3, "Ivy Rivera", null)] }), { customers: changed("10", { active: false }), queue: [move, create, off] });
    expect(r.differences.map((d) => [d.kind, wordsOf(d)])).toEqual([
      ["active", "Waiting to reach QuickBooks"], ["place", "Waiting to reach QuickBooks"], ["student_unlinked", create.words]]);
  });
  it("explain nothing that isn't there: an item with no difference of its kind is not shown", () => {
    const r = compare(rivera(), { queue: [kept, fact({ op: "move", studentId: String(S1) }), fact({ op: "deactivate", qboId: "12" }), fact({ op: "create", role: "student", studentId: String(S3) })] });
    expect(r.differences).toEqual([]);
    // A rename of another customer explains no name of this family's.
    expect(compare(rivera({ name: "Riveras" }), { queue: [fact({ op: "rename", qboId: "12" })] }).differences[0]).toMatchObject({ queue: null });
  });
  it("count the guardian rows with no link a Parent customer create is on the queue for, by its words", () => {
    const waiting = fact({ op: "create", role: "parent", guardianId: "g-raul" });
    const keptCreate = fact({ op: "create", role: "parent", guardianId: "g-sol", state: "refused", words: "QuickBooks refused it: that name is already used in QuickBooks." });
    const alsoWaiting = fact({ op: "create", role: "parent", guardianId: "g-tia" });
    const r = compare(rivera({ guardians: [{ id: "g-raul", customerId: null }, { id: "g-sol", customerId: null }, { id: "g-tia", customerId: null }, { id: "g-uma", customerId: null }] }),
      { queue: [waiting, keptCreate, alsoWaiting, fact({ op: "create", role: "parent", guardianId: "g-ana" })] });
    expect(r.differences).toEqual([{ kind: "guardians_unlinked", count: 4, queue: [
      { note: { state: "waiting", words: "Waiting to reach QuickBooks" }, count: 2 }, { note: { state: "refused", words: keptCreate.words }, count: 1 }] }]);
  });
  it("index only the kinds that explain a difference, the first of each", () => {
    const i = indexQueue([fact({ op: "invoice_create" }), fact({ op: "rename", qboId: "10", words: "first" }), fact({ op: "rename", qboId: "10", words: "second" })]);
    expect(i.rename.get("10")).toEqual({ state: "waiting", words: "first" });
    expect([i.deactivate.size, i.move.size, i.studentCreate.size, i.guardianCreate.size]).toEqual([0, 0, 0, 0]);
  });
  it("end in one full stop", () => {
    expect(noteSentence({ state: "waiting", words: "Waiting to reach QuickBooks" })).toBe("Waiting to reach QuickBooks.");
    expect(noteSentence({ state: "refused", words: "QuickBooks refused it." })).toBe("QuickBooks refused it.");
  });
});
