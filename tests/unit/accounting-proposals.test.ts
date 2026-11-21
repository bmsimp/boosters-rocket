import { describe, it, expect } from "vitest";
import { NO_PROPOSALS, pairKeys, proposeGuardians, proposeStudents, type CustomerSide, type GuardianSide, type ParentCustomerSide, type Proposals, type RecordSide } from "@/lib/accounting/proposals";
import { asAppStudentId } from "@/lib/families/ids";

/**
 * Which students a family's link would link with it (stage 4's slice M3a; src/lib/accounting/proposals.ts): by name
 * alone, one to one, by nameKey(); anything ambiguous is left on its side. Pure.
 */
const rec = (id: string, name: string | null, o: Partial<RecordSide> = {}): RecordSide =>
  ({ id: asAppStudentId(`00000000-0000-4000-8000-${id.padStart(12, "0")}`), name, active: true, linked: false, ...o });
const cust = (qboId: string, displayName: string, o: Partial<CustomerSide> = {}): CustomerSide => ({ qboId, displayName, active: true, linked: false, ...o });
const ids = (p: ReturnType<typeof proposeStudents>) => ({
  pairs: p.pairs.map((x) => `${x.recordName}=${x.customerName}`),
  recordsLeft: p.recordsLeft.map((r) => r.name),
  customersLeft: p.customersLeft.map((c) => c.name),
});

describe("proposeStudents", () => {
  it("pairs a record and a customer of one name, ignoring case and composed accents, and leaves the rest on each side", () => {
    const p = proposeStudents({ students: true,
      records: [rec("1", "Leo Rivera"), rec("2", "José Rivera"), rec("3", "Mia Rivera")],
      customers: [cust("12", "LEO RIVERA"), cust("13", "José rivera"), cust("14", "Ana Rivera")] });
    expect(ids(p)).toEqual({ pairs: ["Leo Rivera=LEO RIVERA", "José Rivera=José rivera"], recordsLeft: ["Mia Rivera"], customersLeft: ["Ana Rivera"] });
    expect(p.pairs[0]).toMatchObject({ customerQboId: "12", customerActive: true });
    expect(pairKeys(p)).toEqual([`${String(rec("1", "").id)}=12`, `${String(rec("2", "").id)}=13`]);
  });

  it("pairs a name whose accent is written decomposed on one side with the same name composed on the other", () => {
    // "José" as "Jose" and a combining acute accent (U+0301) in the portal, and as one "é" (U+00E9) in the books.
    const decomposed = "Jose\u0301 Rivera", composed = "Jos\u00e9 rivera";
    expect(decomposed).not.toBe("Jos\u00e9 Rivera");
    const p = proposeStudents({ students: true, records: [rec("1", decomposed)], customers: [cust("13", composed)] });
    expect(ids(p)).toEqual({ pairs: [`${decomposed}=${composed}`], recordsLeft: [], customersLeft: [] });
  });

  it("leaves two records of one name, and the customer of that name, unpaired", () => {
    const p = proposeStudents({ students: true, records: [rec("1", "Sam Lee"), rec("2", "sam lee")], customers: [cust("30", "Sam Lee")] });
    expect(ids(p)).toEqual({ pairs: [], recordsLeft: ["Sam Lee", "sam lee"], customersLeft: ["Sam Lee"] });
  });

  it("leaves two customers of one name, and the record of that name, unpaired", () => {
    const p = proposeStudents({ students: true, records: [rec("1", "Sam Lee")], customers: [cust("30", "Sam Lee"), cust("31", "Sam Lee", { active: false })] });
    expect(ids(p)).toEqual({ pairs: [], recordsLeft: ["Sam Lee"], customersLeft: ["Sam Lee", "Sam Lee"] });
  });

  it("never pairs a record with no name, which is left", () => {
    const p = proposeStudents({ students: true, records: [rec("1", null)], customers: [cust("30", "Kim Park")] });
    expect(ids(p)).toEqual({ pairs: [], recordsLeft: [null], customersLeft: ["Kim Park"] });
  });

  it("pairs an inactive customer with an active record, and says it is inactive", () => {
    const p = proposeStudents({ students: true, records: [rec("1", "Kim Park")], customers: [cust("30", "Kim Park", { active: false })] });
    expect(ids(p).pairs).toEqual(["Kim Park=Kim Park"]);
    expect(p.pairs[0]!.customerActive).toBe(false);
  });

  it("leaves out a record or customer already linked, and an inactive record, on both sides: they take no part in the count either", () => {
    const p = proposeStudents({ students: true,
      records: [rec("1", "Kim Park", { linked: true }), rec("2", "Kim Park"), rec("3", "Lu Park", { active: false }), rec("4", "Bo Park")],
      customers: [cust("30", "Kim Park"), cust("31", "Bo Park", { linked: true }), cust("32", "Lu Park")] });
    expect(ids(p)).toEqual({ pairs: ["Kim Park=Kim Park"], recordsLeft: ["Bo Park"], customersLeft: ["Lu Park"] });
  });

  it("proposes and leaves nothing in flat books or a shape with no student type", () => {
    expect(proposeStudents({ students: false, records: [rec("1", "Kim Park")], customers: [cust("30", "Kim Park")] })).toEqual(NO_PROPOSALS);
  });
});

/**
 * Which guardians a family's link would link with it (stage 4's slice M3c2; src/lib/accounting/proposals.ts): an open,
 * unblocked row with no link and an active Parent customer directly under the chosen customer that no link names, by the
 * row's sign-in address in the customer's email field alone, one to one, a customer an ended link keeps for a row being
 * that row's alone. Pure. The chosen customer is 70, the parent type P.
 */
const row = (id: string, name: string, email: string, o: Partial<GuardianSide> = {}): GuardianSide => ({ id: `g-${id}`, name, email, blocked: false, open: true, linked: false, ...o });
const pc = (qboId: string, displayName: string, email: string | null, o: Partial<ParentCustomerSide> = {}): ParentCustomerSide =>
  ({ qboId, displayName, email, active: true, typeQboId: "P", parentQboId: "70", linked: false, ...o });
const guardians = (rows: GuardianSide[], customers: ParentCustomerSide[], o: { parents?: boolean; held?: { rows: Set<string>; customers: Set<string> } } = {}) => {
  const p = proposeGuardians({ parents: o.parents ?? true, rows, customers, parentTypeId: "P", customerId: "70", held: o.held });
  return { linked: p.guardians.map((g) => `${g.who}=${g.customerName}`), held: p.guardiansHeld.map((g) => `${g.who}=${g.customerName}`) };
};

describe("proposeGuardians", () => {
  it("pairs a row with the Parent customer whose email field holds its address, trimmed and in any case, among several addresses; never by a name", () => {
    const p = proposeGuardians({ parents: true, parentTypeId: "P", customerId: "70",
      rows: [row("1", "Asha Patel", " Asha@Example.com "), row("2", "Raj Patel", "raj@example.com"), row("3", "Mia Patel", "mia@example.com")],
      customers: [pc("74", "A. Patel", "office@example.com; ASHA@example.com"), pc("75", "Raj Patel", "rajesh@example.com"), pc("76", "Someone", null)] });
    expect(p).toEqual({ guardians: [{ guardianId: "g-1", who: "Asha Patel", customerQboId: "74", customerName: "A. Patel" }], guardiansHeld: [] });
  });

  it("pairs each of two rows with its own customer, in the rows' order", () => {
    expect(guardians([row("1", "Raj Patel", "raj@example.com"), row("2", "Asha Patel", "asha@example.com")],
      [pc("74", "Asha", "asha@example.com"), pc("75", "Raj", "raj@example.com")])).toEqual({ linked: ["Raj Patel=Raj", "Asha Patel=Asha"], held: [] });
  });

  it("pairs none for an address two customers taking part hold, nor for a customer holding two rows' addresses", () => {
    expect(guardians([row("1", "Asha Patel", "asha@example.com")], [pc("74", "Asha", "asha@example.com"), pc("75", "Asha too", "asha@example.com")])).toEqual({ linked: [], held: [] });
    expect(guardians([row("1", "Asha Patel", "asha@example.com"), row("2", "Raj Patel", "raj@example.com")], [pc("74", "Both", "asha@example.com, raj@example.com")]))
      .toEqual({ linked: [], held: [] });
  });

  it("leaves out a blocked person's row, a closed row and a row with a link, which then take no part in the count", () => {
    for (const o of [{ blocked: true }, { open: false }, { linked: true }]) {
      expect(guardians([row("1", "Asha Patel", "asha@example.com", o)], [pc("74", "Asha", "asha@example.com")]), JSON.stringify(o)).toEqual({ linked: [], held: [] });
    }
    // A closed row of another person whose address the customer holds too takes no part, so Raj is still paired.
    expect(guardians([row("1", "Asha Patel", "asha@example.com", { open: false }), row("2", "Raj Patel", "raj@example.com")], [pc("74", "Both", "asha@example.com raj@example.com")]))
      .toEqual({ linked: ["Raj Patel=Both"], held: [] });
  });

  it("leaves out a customer a link names, an inactive one, one of another type and one under another customer, which then take no part in the count", () => {
    for (const o of [{ linked: true }, { active: false }, { typeQboId: "S" }, { typeQboId: null }, { parentQboId: "80" }]) {
      expect(guardians([row("1", "Asha Patel", "asha@example.com")], [pc("74", "Asha", "asha@example.com", o)]), JSON.stringify(o)).toEqual({ linked: [], held: [] });
    }
    // A linked customer holding the same address takes no part: the other is the one.
    expect(guardians([row("1", "Asha Patel", "asha@example.com")], [pc("74", "Asha", "asha@example.com", { linked: true }), pc("75", "Asha P.", "asha@example.com")]))
      .toEqual({ linked: ["Asha Patel=Asha P."], held: [] });
  });

  it("gives a customer an ended link keeps for a row to that row alone, and to no other: it takes no part for them", () => {
    const bea = row("1", "Bea Ru", "bea@example.com", { open: false }), cal = row("2", "Cal Ru", "cal@example.com");
    // Kept for Bea, removed: Cal isn't paired with it, though it holds his address and no other row taking part's.
    expect(guardians([bea, cal], [pc("501", "Bea Ru", "bea@example.com; cal@example.com", { keptFor: ["g-1"] })])).toEqual({ linked: [], held: [] });
    // Kept for Cal himself: his.
    expect(guardians([bea, cal], [pc("501", "Cal Ru", "cal@example.com", { keptFor: ["g-2"] })])).toEqual({ linked: ["Cal Ru=Cal Ru"], held: [] });
    // Kept for Bea, it takes no part for Cal, so the other customer holding his address is the one.
    expect(guardians([bea, cal], [pc("501", "Bea Ru", "cal@example.com", { keptFor: ["g-1"] }), pc("502", "C. Ru", "cal@example.com")])).toEqual({ linked: ["Cal Ru=C. Ru"], held: [] });
    // Kept for no row: as any other.
    expect(guardians([cal], [pc("501", "Cal Ru", "cal@example.com", { keptFor: [] })])).toEqual({ linked: ["Cal Ru=Cal Ru"], held: [] });
  });

  it("holds a pair back whose row an item names or whose customer a blocking change targets, the rest linked", () => {
    const rows = [row("1", "Asha Patel", "asha@example.com"), row("2", "Raj Patel", "raj@example.com"), row("3", "Mia Patel", "mia@example.com")];
    const customers = [pc("74", "Asha", "asha@example.com"), pc("75", "Raj", "raj@example.com"), pc("76", "Mia", "mia@example.com")];
    const p = proposeGuardians({ parents: true, parentTypeId: "P", customerId: "70", rows, customers, held: { rows: new Set(["g-1"]), customers: new Set(["75"]) } });
    expect(p).toEqual({ guardians: [{ guardianId: "g-3", who: "Mia Patel", customerQboId: "76", customerName: "Mia" }],
      guardiansHeld: [{ guardianId: "g-1", who: "Asha Patel", customerName: "Asha" }, { guardianId: "g-2", who: "Raj Patel", customerName: "Raj" }] });
  });

  it("proposes nothing in books with no parent type", () => {
    expect(guardians([row("1", "Asha Patel", "asha@example.com")], [pc("74", "Asha", "asha@example.com")], { parents: false })).toEqual({ linked: [], held: [] });
    expect(proposeGuardians({ parents: true, parentTypeId: null, customerId: "70", rows: [row("1", "Asha Patel", "asha@example.com")], customers: [pc("74", "Asha", "asha@example.com")] }))
      .toEqual({ guardians: [], guardiansHeld: [] });
  });
});

describe("pairKeys", () => {
  it("seals a student pair as it always has and a guardian pair as g:<row>=<customer>, lower-cased, sorted; a held pair in no key", () => {
    const student = rec("1", "Kim Park").id;
    const p: Proposals = { ...NO_PROPOSALS, pairs: [{ studentId: student, recordName: "Kim Park", customerQboId: "71", customerName: "Kim Park", customerActive: true }],
      guardians: [{ guardianId: "ABCDEF00-0000-4000-8000-000000000001", who: "Asha Patel", customerQboId: "74", customerName: "Asha" }],
      guardiansHeld: [{ guardianId: "abcdef00-0000-4000-8000-000000000002", who: "Raj Patel", customerName: "Raj" }] };
    expect(pairKeys(p)).toEqual([`${String(student)}=71`, "g:abcdef00-0000-4000-8000-000000000001=74"].sort());
  });
});
