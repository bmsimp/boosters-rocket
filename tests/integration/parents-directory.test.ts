import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { eq } from "drizzle-orm";
import { auditLog, family, guardian, parent, student } from "@/lib/db/schema";
import { familyNames, familySignins, getPerson, listPeople } from "@/lib/parents/directory";
import { resetDb, seedGuardian, seedParent } from "../helpers/db";
import { seedCache, seedShape, seedParentSettings, SIGNINS_ON, fam, par } from "../helpers/roster-cache";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";
import { setRosterSource } from "@/lib/roster/source";

// The cache here names no company, so there are no app records: each membership's family (`familyId`) is null, and a
// person's page links no family (the family's page is addressed by its record). tests/integration/parents-pages.test.ts
// reads a roster with a company, where it links each one. A family's sign-ins are read by its own record
// (`guardian.family_id`), so the tests of familySignins() read the roster from a company first (withCompany()).
// The people and their rows are written directly, as the portal holds them: nothing makes a sign-in from QuickBooks.
const withCompany = () => db.transaction((tx) => setRosterSource(tx, "1111"));
const signinsOf = async (customer: string) => familySignins(await recordOfCustomer(customer, "family"));
const HELD_WORDS = "Can't sign in: the address was under more than one family, and held for staff to review";
/** An open row with no family record, as every row is here while the cache names no company: the gate lets nobody in through it. */
const NO_RECORD_WORDS = "Can't sign in now: the family isn't set up in the portal";

describe("the people directory", () => {
  beforeEach(async () => { await resetDb(); await seedShape(); await seedParentSettings(SIGNINS_ON); });
  const ALL = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), par("12", "No Mail", "10", null),
    par("13", "Shared Sam", "10", "sam@example.com"), fam("20", "Chen Family"), par("21", "Shared Sam", "20", "sam@example.com")];
  /** Ana, invited to the Rivera family from her record; Sam, whose two rows the retired held-address review closed. */
  const seedPeople = async () => {
    const ana = await seedParent({ name: "Ana Rivera", email: "ana@example.com" });
    await seedGuardian({ parentId: ana.id, familyQboId: "10", sourceQboId: "11", status: "invited" });
    const sam = await seedParent({ name: "Shared Sam", email: "sam@example.com" });
    await seedGuardian({ parentId: sam.id, familyQboId: "10", sourceQboId: "13", status: "disabled", disabledReason: "held", statusBeforeDisable: "invited" });
    await seedGuardian({ parentId: sam.id, familyQboId: "20", sourceQboId: "21", status: "disabled", disabledReason: "held", statusBeforeDisable: "invited" });
    await syncAppRecords();
    return { ana, sam };
  };

  it("lists what each person can reach, with family names, last sign-in and welcome, and finds by name or email", async () => {
    await seedCache(ALL);
    const { ana } = await seedPeople();
    await db.update(parent).set({ welcomedAt: new Date("2026-11-01T12:00:00Z") }).where(eq(parent.id, ana.id));
    await db.insert(auditLog).values({ door: "parent", actorId: ana.id, actorLabel: ana.email, action: "signin", targetType: "parent", targetId: ana.id, at: new Date("2026-11-05T12:00:00Z") });
    expect((await listPeople("ana"))).toEqual([{ parentId: ana.id, name: "Ana Rivera", email: "ana@example.com", blocked: false,
      families: [{ familyQboId: "10", familyId: null, familyName: "Rivera Family", previousCompany: false, kind: "cannot", words: NO_RECORD_WORDS }],
      lastSigninAt: "2026-11-05T12:00:00.000Z", welcomedAt: "2026-11-01T12:00:00.000Z" }]);
    expect((await listPeople("RIVERA")).length).toBe(1);
    expect((await listPeople("ana@ex")).length).toBe(1);
    expect(await listPeople("zzz")).toEqual([]);
    expect(await getPerson(ana.id)).toMatchObject({ name: "Ana Rivera", blockedReason: null, blockedAt: null, welcomeOwed: false });
    expect(await getPerson("00000000-0000-4000-8000-00000000dead")).toBeNull();
  });

  it("gives an old row its closing reason's words for good, naming no other family", async () => {
    await seedCache(ALL);
    await seedPeople();
    const [sam] = await listPeople("sam");
    expect(sam!.families).toEqual([
      { familyQboId: "10", familyId: null, familyName: "Rivera Family", previousCompany: false, kind: "cannot", words: HELD_WORDS },
      { familyQboId: "20", familyId: null, familyName: "Chen Family", previousCompany: false, kind: "cannot", words: HELD_WORDS },
    ]);
  });

  it("shows a family's guardian rows, open and closed, in words, and no row worked out from QuickBooks", async () => {
    await withCompany(); await seedCache(ALL);
    const { ana, sam } = await seedPeople();
    const rows = await signinsOf("10");
    expect(rows.map((s) => `${s.name}: ${s.words}`)).toEqual(["Ana Rivera: Can sign in (hasn't yet)", `Shared Sam: ${HELD_WORDS}`]);
    expect(rows.map((s) => s.parentId)).toEqual([ana.id, sam.id]);
    // No Mail has a parent record in QuickBooks and no address: no sign-in, and no row of words for one.
    expect(JSON.stringify(rows)).not.toContain("No Mail");
    expect(JSON.stringify(rows)).not.toContain("Chen");
    expect(await signinsOf("20")).toEqual([expect.objectContaining({ parentId: sam.id, kind: "cannot", words: HELD_WORDS })]);
  });

  // The gate keeps a person out of a family that doesn't count, and closes no row for it: the words say so, from the
  // app's own records, so staff read what the gate does (enterableGuardianRows()).
  it("says an open row's family can't be entered now when it is inactive, or has no active student while that is asked", async () => {
    await withCompany(); await seedCache(ALL);
    const { ana } = await seedPeople();
    const rivera = await recordOfCustomer("10", "family");
    expect((await signinsOf("10")).find((s) => s.parentId === ana.id)).toMatchObject({ kind: "can", words: "Can sign in (hasn't yet)" });
    // No active student in the family: nothing changes until the Admin asks for one.
    await seedParentSettings({ requireActiveStudents: true });
    expect((await signinsOf("10")).find((s) => s.parentId === ana.id)).toMatchObject({ kind: "cannot", words: "Can't sign in now: the family has no active students" });
    expect((await getPerson(ana.id))!.families).toEqual([expect.objectContaining({ familyQboId: "10", kind: "cannot", words: "Can't sign in now: the family has no active students" })]);
    await db.insert(student).values({ familyId: rivera, name: "Leo", active: true });
    expect((await signinsOf("10")).find((s) => s.parentId === ana.id)).toMatchObject({ kind: "can" });
    // An inactive family record, whatever its students.
    await db.update(family).set({ active: false }).where(eq(family.id, rivera));
    expect((await signinsOf("10")).find((s) => s.parentId === ana.id)).toMatchObject({ kind: "cannot", words: "Can't sign in now: the family is inactive" });
    expect((await listPeople("ana"))[0]!.families).toEqual([expect.objectContaining({ kind: "cannot", words: "Can't sign in now: the family is inactive" })]);
    // A closed row keeps its own reason's words.
    expect((await signinsOf("10")).find((s) => s.parentId !== ana.id)).toMatchObject({ kind: "cannot", words: HELD_WORDS });
    expect((await db.select().from(guardian).where(eq(guardian.parentId, ana.id))).map((g) => g.status)).toEqual(["invited"]);
  });

  it("shows a blocked person as blocked, and a link made by hand as it stands", async () => {
    await seedParentSettings({ signin: false, everEnabled: false });
    await withCompany(); await seedCache(ALL);
    const p = await seedParent({ name: "Hand Seeded", email: "seeded@example.com", blocked: true });
    const g = await seedGuardian({ parentId: p.id, familyQboId: "10" });
    await syncAppRecords(); // the membership's family record, as the next roster read would set it
    expect(await signinsOf("10")).toEqual([{ guardianId: g.id, parentId: p.id, name: "Hand Seeded", email: "seeded@example.com", kind: "blocked", words: "Blocked" }]);
  });

  it("keeps two same-named people in one family apart, one row each", async () => {
    await withCompany(); await seedCache([fam("10", "Rivera Family")]);
    const one = await seedParent({ name: "Pat Rivera", email: "pat.one@example.com" }), two = await seedParent({ name: "Pat Rivera", email: "pat.two@example.com" });
    const g1 = await seedGuardian({ parentId: one.id, familyQboId: "10" }), g2 = await seedGuardian({ parentId: two.id, familyQboId: "10" });
    await syncAppRecords();
    expect((await signinsOf("10")).map((s) => [s.guardianId, s.email])).toEqual([[g1.id, "pat.one@example.com"], [g2.id, "pat.two@example.com"]]);
  });

  it("marks a link from a previous QuickBooks company, keeping its old ID but never naming the family that ID has now", async () => {
    await seedCache(ALL);
    const { ana } = await seedPeople();
    await seedGuardian({ parentId: ana.id, familyQboId: "20", sourceQboId: "21", status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active" });
    expect((await getPerson(ana.id))!.families).toEqual([
      { familyQboId: "10", familyId: null, familyName: "Rivera Family", previousCompany: false, kind: "cannot", words: NO_RECORD_WORDS },
      { familyQboId: "20", familyId: null, familyName: "A family in the previous QuickBooks company", previousCompany: true, kind: "cannot", words: "Can't sign in: a different QuickBooks company was connected" },
    ]);
  });

  it("reads a family's sign-ins by the membership's own family record, not by the QuickBooks ID the row was made with", async () => {
    await seedParentSettings({ signin: false, everEnabled: false });
    await withCompany(); await seedCache(ALL);
    const p = await seedParent({ name: "Hand Seeded", email: "seeded@example.com" });
    const [g] = await db.insert(guardian).values({ parentId: p.id, familyQboId: "10", status: "invited" }).returning();
    // Until a membership is in a family record it is in no family's box, as a row a change of company closed never is.
    expect(await signinsOf("10")).toEqual([]);
    await syncAppRecords();
    expect((await signinsOf("10")).map((s) => s.email)).toEqual(["seeded@example.com"]);
    // The row's family record is what counts: pointed at the Chen family's, it is in their box and no longer the Riveras'.
    await db.update(guardian).set({ familyId: await recordOfCustomer("20", "family") }).where(eq(guardian.id, g!.id));
    expect(await signinsOf("10")).toEqual([]);
    expect((await signinsOf("20")).map((s) => s.email)).toEqual(["seeded@example.com"]);
  });

  it("gives family names from the roster, and a stand-in for an ID it doesn't know", async () => {
    await seedCache(ALL);
    expect(await familyNames(["10", "NOPE"])).toEqual(new Map([["10", "Rivera Family"], ["NOPE", "Family account NOPE"]]));
  });
});
