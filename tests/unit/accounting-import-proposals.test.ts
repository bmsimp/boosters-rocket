import { describe, it, expect } from "vitest";
import { IMPORT_MAX, importAddresses, importKeys, proposeImport, type ImportInput, type ImportPerson, type ProposedFamily } from "@/lib/accounting/import-proposals";
import { bulkStamp, importStamp, importStampHolds, sendAllStamp } from "@/lib/accounting/stamp";
import { buildRoster, type Cust } from "@/lib/roster/model";
import type { MembershipShape } from "@/lib/roster/shape";

/**
 * The reviewed import's proposer (stage 4's slice M6; src/lib/accounting/import-proposals.ts): for each customer no
 * family is linked to that the screen doesn't aim at a family the portal has, in the roster's order and at most
 * IMPORT_MAX, the family "Create a family from this" would make, its students, and its guardians by open question 4's
 * rules for each shape of the books. Pure: the screen feeds it its own reads.
 */
const LAYERED: MembershipShape = { kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: "P" };
const NO_PARENT_TYPE: MembershipShape = { kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null };
const FLAT: MembershipShape = { kind: "flat", memberTypeIds: ["M"] };

const c = (qboId: string, displayName: string, typeQboId: string, o: Partial<Cust> = {}): Cust =>
  ({ qboId, displayName, typeQboId, active: true, parentQboId: null, email: null, phone: null, ...o });
const fam = (qboId: string, name: string, o: Partial<Cust> = {}) => c(qboId, name, "F", o);
const stu = (qboId: string, name: string, under: string, o: Partial<Cust> = {}) => c(qboId, name, "S", { parentQboId: under, ...o });
const par = (qboId: string, name: string, under: string, email: string | null, o: Partial<Cust> = {}) => c(qboId, name, "P", { parentQboId: under, email, ...o });

/**
 * The input as the screen builds it (importInputOf()): the roster of the shape and the cache, and the pool, here every
 * active top-level family customer (a member in flat books) with no family link (`linked`), in the roster's order.
 */
function input(shape: MembershipShape, customers: Cust[], o: { linked?: string[]; aimed?: string[]; studentLinked?: string[]; taken?: string[]; held?: string[] } = {}): ImportInput {
  const roster = buildRoster(shape, customers);
  const linked = new Set(o.linked ?? []);
  const listed = roster.kind === "flat" ? roster.members : roster.families.map((f) => f.customer);
  return { shape, roster, customers, pool: listed.filter((x) => x.active && x.parentQboId === null && !linked.has(x.qboId)).map((x) => ({ qboId: x.qboId })),
    aimed: new Set(o.aimed ?? []), studentLinked: new Set(o.studentLinked ?? []), parentTaken: new Set(o.taken ?? []), parentHeld: new Set(o.held ?? []) };
}
const NOBODY = new Map<string, ImportPerson>();
const only = (p: ReturnType<typeof proposeImport>, customerId: string): ProposedFamily => p.families.find((f) => f.customerId === customerId)!;
const shown = (f: ProposedFamily) => ({
  made: f.students.made.map((s) => s.name), leftAlone: f.students.leftAlone.map((s) => s.name),
  guardians: f.guardians.map((g) => `${g.name} <${g.email}> ${g.link ? `linked to ${g.link.name}` : `unlinked${g.linkNot ? ` (${g.linkNot})` : ""}`} ${g.person.kind === "new" ? "new" : `reusing ${g.person.name}`}`),
  not: f.notProposed.map((n) => `${n.customer}: ${n.why}${n.address ? ` ${n.address}` : ""}${n.sameAs ? ` as ${n.sameAs}` : ""}`),
});

describe("layered books with a parent type", () => {
  const PATELS = [fam("70", "Patel Family", { email: "family@example.com" }), stu("71", "Asha Patel", "70", { email: "asha.student@example.com" }), stu("72", "Ravi Patel", "70", { active: false }),
    par("73", "Nita Patel", "70", " Nita@Example.com, second@example.com"), par("74", "Nita Second", "70", "nita@example.com"), par("75", "Old Dev", "70", "dev@example.com", { active: false }),
    par("76", "No Address", "70", "not-an-address"), par("77", "Raj Patel", "70", "raj@example.com")];

  it("proposes the family as the narrowed import makes it, its students, and one guardian per active Parent customer by its first usable address, linked to it", () => {
    const p = proposeImport(input(LAYERED, PATELS), NOBODY);
    expect(p).toMatchObject({ aimed: 0, pastCap: 0, from: "parent_customer" });
    expect(p.families.map((f) => [f.customerId, f.name])).toEqual([["70", "Patel Family"]]);
    const f = only(p, "70");
    expect(shown(f)).toEqual({
      // Active or not, as "Create a family from this" makes them.
      made: ["Asha Patel", "Ravi Patel"], leftAlone: [],
      // Nita by her first address only, lower-cased; Raj; neither from the family's own field nor a student's.
      guardians: ["Nita Patel <nita@example.com> linked to Nita Patel new", "Raj Patel <raj@example.com> linked to Raj Patel new"],
      // A second Parent customer of the same first address gives no second guardian and is linked to nobody; an
      // inactive one and one with no usable address give none.
      not: ["Nita Second: same_address nita@example.com as Nita Patel", "No Address: no_address", "Old Dev: inactive"],
    });
    expect(f.students.made.map((s) => s.active)).toEqual([true, false]);
    expect(f.guardians.map((g) => g.link?.qboId)).toEqual(["73", "77"]);
    expect(f.unusable).toBe(1); // "not-an-address", counted and never shown
    expect(JSON.stringify(p)).not.toContain("not-an-address");
    expect(JSON.stringify(p)).not.toContain("asha.student@example.com");
    expect(JSON.stringify(p)).not.toContain("family@example.com");
    expect(importAddresses(input(LAYERED, PATELS))).toEqual(["nita@example.com", "raj@example.com"]);
  });

  it("counts a student customer with a student record as left alone, as the narrowed import does", () => {
    const f = only(proposeImport(input(LAYERED, PATELS, { studentLinked: ["71"] }), NOBODY), "70");
    expect(shown(f)).toMatchObject({ made: ["Ravi Patel"], leftAlone: ["Asha Patel"] });
  });

  it("links no guardian to a Parent customer another link names or keeps, or a change waits for, and says which", () => {
    const f = only(proposeImport(input(LAYERED, PATELS, { taken: ["73"], held: ["77"] }), NOBODY), "70");
    expect(shown(f).guardians).toEqual(["Nita Patel <nita@example.com> unlinked (taken) new", "Raj Patel <raj@example.com> unlinked (held) new"]);
  });

  it("names a guardian as their Parent customer, closing up spaces, and proposes none for a name the portal can't take", () => {
    const f = only(proposeImport(input(LAYERED, [fam("70", "Patel Family"), par("73", "  Nita   Patel ", "70", "nita@example.com"), par("74", "x".repeat(101), "70", "long@example.com")]), NOBODY), "70");
    expect(f.guardians.map((g) => g.name)).toEqual(["Nita Patel"]);
    expect(f.notProposed).toEqual([{ customer: "x".repeat(101), why: "name", address: "long@example.com", sameAs: null }]);
  });
});

describe("layered books with no parent type", () => {
  it("proposes one guardian per usable address in the family customer's field, named as the family customer, linked to nothing", () => {
    const f = only(proposeImport(input(NO_PARENT_TYPE, [fam("70", "Patel Family", { email: "nita@example.com; RAJ@example.com, junk" }), stu("71", "Asha Patel", "70", { email: "asha@example.com" })]), NOBODY), "70");
    expect(shown(f)).toEqual({ made: ["Asha Patel"], leftAlone: [],
      guardians: ["Patel Family <nita@example.com> unlinked new", "Patel Family <raj@example.com> unlinked new"], not: [] });
    expect(f.guardians.every((g) => g.from === "family_field")).toBe(true);
    expect(f.unusable).toBe(1);
  });

  it("proposes none for a family whose field holds no usable address, and says so", () => {
    const f = only(proposeImport(input(NO_PARENT_TYPE, [fam("70", "Patel Family")]), NOBODY), "70");
    expect(shown(f)).toMatchObject({ guardians: [], not: ["Patel Family: no_address"] });
  });
});

describe("flat books", () => {
  it("proposes the member's first usable address, named as the member, linked to nothing, with no students", () => {
    const p = proposeImport(input(FLAT, [c("70", "Patel Family", "M", { email: "nita@example.com, raj@example.com" }), c("71", "Asha Patel", "S", { parentQboId: "70", email: "asha@example.com" })]), NOBODY);
    expect(p.from).toBe("member");
    expect(shown(only(p, "70"))).toEqual({ made: [], leftAlone: [], guardians: ["Patel Family <nita@example.com> unlinked new"], not: [] });
  });
});

describe("the persons who hold the addresses", () => {
  const BOOKS = [fam("70", "Patel Family"), par("73", "Nita Patel", "70", "nita@example.com"), par("77", "Raj Patel", "70", "raj@example.com"),
    fam("80", "Okafor Family"), par("83", "Nita Okafor", "80", "nita@example.com")];

  it("reuses a person who holds an address, their name unchanged, with their families now; gives no guardian for a blocked one", () => {
    const persons = new Map<string, ImportPerson>([["nita@example.com", { id: "AAAAAAAA-0000-4000-8000-000000000001", name: "Nita (as the portal knows her)", blocked: false, families: ["The Riveras"] }],
      ["raj@example.com", { id: "00000000-0000-4000-8000-000000000002", name: "Raj", blocked: true, families: [] }]]);
    const f = only(proposeImport(input(LAYERED, BOOKS), persons), "70");
    expect(shown(f)).toMatchObject({ guardians: ["Nita Patel <nita@example.com> linked to Nita Patel reusing Nita (as the portal knows her)"], not: ["Raj Patel: blocked raj@example.com"] });
    expect(f.guardians[0]!.person).toEqual({ kind: "existing", id: "AAAAAAAA-0000-4000-8000-000000000001", name: "Nita (as the portal knows her)", families: ["The Riveras"] });
  });

  it("makes an address two proposed families give one person in both, each shown with the other", () => {
    const p = proposeImport(input(LAYERED, BOOKS), NOBODY);
    expect(only(p, "70").guardians.find((g) => g.email === "nita@example.com")).toMatchObject({ person: { kind: "new" }, alsoIn: ["Okafor Family"] });
    expect(only(p, "80").guardians).toEqual([expect.objectContaining({ email: "nita@example.com", name: "Nita Okafor", alsoIn: ["Patel Family"] })]);
    expect(only(p, "70").guardians.find((g) => g.email === "raj@example.com")!.alsoIn).toEqual([]);
    expect(importAddresses(input(LAYERED, BOOKS))).toEqual(["nita@example.com", "raj@example.com"]);
  });
});

describe("what isn't proposed", () => {
  it("leaves out the customers the screen aims at a family the portal has, and those linked already, counting the aimed", () => {
    const p = proposeImport(input(LAYERED, [fam("70", "Patel Family"), fam("80", "Okafor Family"), fam("90", "Quiet Family"), fam("10", "Rivera Family")],
      { aimed: ["80", "90"], linked: ["10"] }), NOBODY);
    expect(p.families.map((f) => f.customerId)).toEqual(["70"]);
    expect(p).toMatchObject({ aimed: 2, pastCap: 0 });
  });

  it("proposes at most IMPORT_MAX, in the roster's order, and says how many more there are; reads addresses only of those", () => {
    const many = Array.from({ length: IMPORT_MAX + 2 }, (_, n) => [fam(String(100 + n), `Family ${String(n).padStart(2, "0")}`), par(String(200 + n), `Parent ${n}`, String(100 + n), `p${n}@example.com`)]).flat();
    const i = input(LAYERED, many);
    const p = proposeImport(i, NOBODY);
    expect(IMPORT_MAX).toBe(25);
    expect(p.families).toHaveLength(IMPORT_MAX);
    expect(p.families[0]!.name).toBe("Family 00");
    expect(p.families.at(-1)!.name).toBe("Family 24");
    expect(p.pastCap).toBe(2);
    expect(importAddresses(i)).toHaveLength(IMPORT_MAX);
    expect(importAddresses(i)).not.toContain("p25@example.com");
  });
});

describe("the import's stamp", () => {
  const BOOKS = [fam("70", "Patel Family"), stu("71", "Asha Patel", "70"), stu("72", "Ravi Patel", "70"), par("73", "Nita Patel", "70", "nita@example.com"), fam("80", "Okafor Family")];
  const keys = (o: Parameters<typeof input>[2] = {}, persons = NOBODY, customers = BOOKS) => importKeys(proposeImport(input(LAYERED, customers, o), persons).families);

  it("holds for the list it sealed, in a domain of its own", () => {
    const k = keys();
    const stamp = importStamp(k);
    expect(importStampHolds(k, stamp)).toBe(true);
    expect(importStampHolds(k, `${stamp}x`)).toBe(false);
    expect(importStampHolds(k, "")).toBe(false);
    // Neither the bulk confirm's stamp nor Send the app's for all's is ever the import's, of the same values.
    expect(stamp).not.toBe(bulkStamp({ status: null, q: "" }, k.length, k));
    expect(stamp).not.toBe(sendAllStamp({ status: null, q: "" }, k.length, k));
  });

  it("changes with every field it seals: a family, its name, its order, a student made or left alone, their names and active flags, a guardian's name, address, Parent customer and person", () => {
    const stamp = importStamp(keys());
    const persons = new Map<string, ImportPerson>([["nita@example.com", { id: "00000000-0000-4000-8000-000000000001", name: "Nita", blocked: false, families: [] }]]);
    const changed = [
      keys({ aimed: ["80"] }), // a family gone from the list
      [...keys()].reverse(), // the families in another order
      keys({ studentLinked: ["72"] }), // a student left alone instead of made
      keys({}, NOBODY, BOOKS.filter((x) => x.qboId !== "71")), // a student gone
      keys({}, NOBODY, BOOKS.map((x) => (x.qboId === "73" ? { ...x, email: "nita.new@example.com" } : x))), // the guardian's address
      keys({ taken: ["73"] }), // the guardian's Parent customer no longer linked
      keys({}, persons), // the address held by a person now
      keys({}, NOBODY, BOOKS.map((x) => (x.qboId === "70" ? { ...x, displayName: "Patel Household" } : x))), // the family's name
      keys({}, NOBODY, BOOKS.map((x) => (x.qboId === "71" ? { ...x, displayName: "Asha P. Patel" } : x))), // a student's name
      keys({}, NOBODY, BOOKS.map((x) => (x.qboId === "72" ? { ...x, active: false } : x))), // a student made inactive
      keys({ studentLinked: ["72"] }, NOBODY, BOOKS.map((x) => (x.qboId === "72" ? { ...x, displayName: "Ravi P. Patel" } : x))), // a student left alone, renamed
      keys({}, NOBODY, BOOKS.map((x) => (x.qboId === "73" ? { ...x, displayName: "Anita Okafor-Patel" } : x))), // the name a new guardian is given
    ];
    // The student left alone, renamed, against the list that leaves it alone as it was.
    expect(importStampHolds(keys({ studentLinked: ["72"] }, NOBODY, BOOKS.map((x) => (x.qboId === "72" ? { ...x, displayName: "Ravi P. Patel" } : x))),
      importStamp(keys({ studentLinked: ["72"] })))).toBe(false);
    for (const k of changed) expect(importStampHolds(k, stamp), JSON.stringify(k)).toBe(false);
    // A person's name or families aren't sealed: the person is, by id.
    const renamed = new Map([["nita@example.com", { ...persons.get("nita@example.com")!, name: "Nita Renamed", families: ["The Riveras"] }]]);
    expect(importStampHolds(keys({}, renamed), importStamp(keys({}, persons)))).toBe(true);
  });
});
