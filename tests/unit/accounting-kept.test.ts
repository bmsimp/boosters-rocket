import { describe, it, expect } from "vitest";
import { keptPlacesOf, type KeptBasics, type LinkRow } from "@/lib/accounting/mapping";
import type { Difference } from "@/lib/accounting/differences";
import { asAppFamilyId, asAppStudentId, type AppFamilyId } from "@/lib/families/ids";
import type { QueueView } from "@/lib/roster/queue";
import type { QueuedWrite } from "@/lib/db/schema";

/**
 * Where the accounting links screen shows a change kept in the portal (stage 4's slice M5c; keptPlacesOf(), the rule
 * keptOnLinksOf() and the view share, in src/lib/accounting/mapping.ts): pure, over rows already worked out. Rivera
 * (customer 10) with Leo (12), Chen (20) with Sam (22), and Patel (30), inactive in the portal, on the inactive list.
 */
const RIVERA = asAppFamilyId("00000000-0000-4000-8000-0000000000a1"), CHEN = asAppFamilyId("00000000-0000-4000-8000-0000000000a2");
const PATEL = asAppFamilyId("00000000-0000-4000-8000-0000000000a3");
const LEO = asAppStudentId("00000000-0000-4000-8000-0000000000b1"), SAM = asAppStudentId("00000000-0000-4000-8000-0000000000b2");
const basics = (o: Partial<KeptBasics> = {}): KeptBasics => ({
  state: "listed",
  linkOfFamily: new Map([[String(RIVERA), { customerId: "10" }], [String(CHEN), { customerId: "20" }], [String(PATEL), { customerId: "30" }]]) as unknown as KeptBasics["linkOfFamily"],
  familyOfCustomer: new Map<string, AppFamilyId>([["10", RIVERA], ["20", CHEN], ["30", PATEL]]),
  customerOfStudent: new Map([[String(LEO), "12"], [String(SAM), "22"]]),
  everyStudent: [{ id: LEO, familyId: RIVERA, name: "Leo Rivera", active: true }, { id: SAM, familyId: CHEN, name: "Sam Chen", active: true }],
  ...o,
});
const NOTE = { state: "refused" as const, words: "QuickBooks refused it." };
const row = (familyId: AppFamilyId, differences: Difference[], status: LinkRow["status"] = { key: "with_differences", made: { key: "carried_over", at: "2026-11-01T00:00:00.000Z" } }) =>
  ({ familyId, status, differences });
const familyName: Difference = { kind: "name", of: "family", portal: "Rivera Family", books: "Rivera Household", queue: NOTE };
const leoName: Difference = { kind: "name", of: "student", studentId: LEO, portal: "Leo Rivera", books: "Leo Riviera", queue: NOTE };
const leoInactive: Difference = { kind: "active", of: "student", studentId: LEO, who: "Leo Rivera", portalActive: false, queue: NOTE };
const leoPlace: Difference = { kind: "place", who: "Leo Rivera", studentId: LEO, place: { at: "other_family", familyQboId: "20", familyName: "Chen Family" }, queue: NOTE };
const leoElsewhere = (at: "family" | "inactive"): Difference => ({ kind: "student_elsewhere", books: "Leo Rivera", studentId: LEO,
  portal: at === "family" ? { at: "family", family: "Rivera Family" } : { at: "inactive" }, queue: NOTE });
let n = 0;
const item = (write: QueuedWrite, o: Partial<QueueView> = {}): QueueView => ({
  id: `item-${++n}`, state: "refused", write, words: "A change", askedBy: null, askedAt: "", lastTriedAt: "", nextTryAt: null, tries: 1, lastCode: "fault_6000",
  familyId: null, studentId: null, moneyNote: null, finishing: false, awaitsRead: false, holds: null, shown: "", mayResend: true, notOffered: null, differs: null, joined: null, ...o,
});
const renameFamily = (o: Partial<QueueView> = {}) => item({ op: "rename", role: "family", qboId: "10", syncToken: "0", name: "Rivera Family", was: "Rivera Old" }, { familyId: RIVERA, ...o });
const renameLeo = (o: Partial<QueueView> = {}) => item({ op: "rename", role: "student", qboId: "12", syncToken: "0", name: "Leo Rivera", was: "Leo" }, { familyId: RIVERA, studentId: LEO, ...o });
const moveLeo = (o: Partial<QueueView> = {}) => item({ op: "move", role: "student", qboId: "12", syncToken: "0", fromFamilyQboId: "20", toFamilyQboId: "10", fromFamilyId: CHEN, toFamilyId: RIVERA },
  { familyId: CHEN, studentId: LEO, ...o });
const offLeo = (o: Partial<QueueView> = {}) => item({ op: "deactivate", role: "student", qboId: "12", syncToken: "0" }, { familyId: RIVERA, studentId: LEO, ...o });
const offPatel = (o: Partial<QueueView> = {}) => item({ op: "deactivate", role: "member", qboId: "30", syncToken: "0" }, { familyId: PATEL, ...o });
const places = (queue: QueueView[], rows = [row(RIVERA, [familyName, leoName, leoInactive, leoPlace]), row(CHEN, [])], b = basics()) =>
  keptPlacesOf(b, queue, rows, [{ familyId: PATEL }]);

describe("what the screen shows beside its difference", () => {
  it("a kept rename of the family, of a member and of a student, a kept move and a kept make-inactive of a student: each on its own row, at its difference", () => {
    const [f, s, m, off] = [renameFamily(), renameLeo(), moveLeo(), offLeo()];
    const got = places([f, s, m, off]);
    expect(got.get(f.id)).toEqual({ familyId: RIVERA, at: 0 });
    expect(got.get(s.id)).toEqual({ familyId: RIVERA, at: 1 });
    expect(got.get(off.id)).toEqual({ familyId: RIVERA, at: 2 });
    // A move is shown on the row of the family the portal has the student in, never the family left's, which tells it too.
    expect(places([m], [row(RIVERA, [leoPlace]), row(CHEN, [leoElsewhere("family")])]).get(m.id)).toEqual({ familyId: RIVERA, at: 0 });
    const member = item({ op: "rename", role: "member", qboId: "10", syncToken: "0", name: "Rivera Family", was: "Rivera Old" });
    expect(places([member], [row(RIVERA, [{ ...familyName, of: "member" }])]).get(member.id)).toEqual({ familyId: RIVERA, at: 0 });
  });

  it("a kept make-inactive of an inactive member whose customer the books have active: on the inactive list, the first one only", () => {
    const [a, b] = [offPatel(), offPatel()];
    const got = places([a, b]);
    expect(got.get(a.id)).toEqual({ familyId: PATEL, inactive: true });
    expect(got.has(b.id)).toBe(false);
  });

  it("one whose difference the books' copy no longer shows: on its row with no difference (`at` null)", () => {
    const f = renameFamily(), m = moveLeo();
    const got = places([f, m], [row(RIVERA, []), row(CHEN, [])]);
    expect(got.get(f.id)).toEqual({ familyId: RIVERA, at: null });
    expect(got.get(m.id)).toEqual({ familyId: RIVERA, at: null });
  });
});

describe("what stays on Reconciliation alone", () => {
  it("anything not kept, a guardian's, a create, a phone and address or a sign-in email", () => {
    const queue = [renameFamily({ state: "waiting" }), renameLeo({ state: "stuck" }),
      item({ op: "rename", role: "parent", qboId: "11", syncToken: "0", name: "Ana", was: "Ann", guardianId: "g-ana" }),
      item({ op: "deactivate", role: "parent", qboId: "11", syncToken: "0", guardianId: "g-ana" }),
      item({ op: "create", role: "student", name: "Leo Rivera", typeQboId: "3", familyQboId: "10", email: null }, { studentId: LEO }),
      item({ op: "contact", role: "family", qboId: "10", syncToken: "0", change: { phone: "555" }, was: {} } as unknown as QueuedWrite),
      item({ op: "email", role: "member", qboId: "10", syncToken: "0", from: "a@b.org", to: "c@b.org" })];
    expect(places(queue)).toEqual(new Map());
  });

  it("a balance hold, each kind, and a name refused as taken", () => {
    for (const lastCode of ["open_balance", "credit_balance", "balance_unread:no_balance", "fault_6220"]) {
      expect(places([offLeo({ lastCode })]), lastCode).toEqual(new Map());
      expect(places([offPatel({ lastCode })]), lastCode).toEqual(new Map());
    }
    expect(places([renameFamily({ lastCode: "fault_6240", notOffered: "taken", mayResend: false })])).toEqual(new Map());
  });

  it("any kept item while the screen's state isn't `listed`", () => {
    for (const state of ["no_company", "other_company", "no_shape"] as const) {
      expect(places([renameFamily(), offLeo(), offPatel()], undefined, basics({ state }))).toEqual(new Map());
    }
  });

  it("a record whose link no longer names the customer, or ended; a row whose link doesn't stand; a family the view draws nowhere", () => {
    // Leo's link names another customer now; Rivera's family link ended (no family is linked to 10).
    expect(places([renameLeo(), moveLeo(), offLeo()], undefined, basics({ customerOfStudent: new Map([[String(LEO), "99"]]) }))).toEqual(new Map());
    expect(places([renameFamily()], undefined, basics({ familyOfCustomer: new Map([["20", CHEN]]) }))).toEqual(new Map());
    expect(places([renameFamily(), renameLeo()], [row(RIVERA, [], { key: "customer_gone" })])).toEqual(new Map());
    // Patel inactive and not on the inactive list (the books have its customer inactive too); a rename of an inactive family.
    expect(keptPlacesOf(basics(), [offPatel()], [], [])).toEqual(new Map());
    expect(places([item({ op: "rename", role: "member", qboId: "30", syncToken: "0", name: "Patel", was: "Patels" })])).toEqual(new Map());
  });

  it("one whose difference carries another item's note, or that only another family's row shows", () => {
    // A waiting rename of the same customer came first: the difference carries its note, so the kept one stays put.
    const kept = renameFamily(), waiting = renameFamily({ state: "waiting" });
    expect(places([waiting, kept]).has(kept.id)).toBe(false);
    expect(places([kept, waiting]).get(kept.id)).toEqual({ familyId: RIVERA, at: 0 });
    // Leo inactive in the portal, his customer active under Chen in the books: only Chen's row tells it.
    const off = offLeo();
    expect(places([off], [row(RIVERA, []), row(CHEN, [leoElsewhere("inactive")])]).has(off.id)).toBe(false);
  });

  it("family A's row never shows family B's kept item", () => {
    const sam = item({ op: "rename", role: "student", qboId: "22", syncToken: "0", name: "Sam Chen", was: "Sam" }, { familyId: CHEN, studentId: SAM });
    const samName: Difference = { kind: "name", of: "student", studentId: SAM, portal: "Sam Chen", books: "Sammy Chen", queue: NOTE };
    const got = places([sam, renameFamily()], [row(RIVERA, [familyName]), row(CHEN, [samName])]);
    expect(got.get(sam.id)).toEqual({ familyId: CHEN, at: 0 });
    expect([...got.values()].filter((p) => String(p.familyId) === String(RIVERA))).toHaveLength(1);
  });
});
