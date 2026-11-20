import { describe, it, expect } from "vitest";
import { NO_PROPOSALS, pairKeys, proposeStudents, type CustomerSide, type RecordSide } from "@/lib/accounting/proposals";
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
