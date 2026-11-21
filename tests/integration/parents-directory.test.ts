import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { eq } from "drizzle-orm";
import { accountingLink, auditLog, family, guardian, parent, student } from "@/lib/db/schema";
import { familyNames, familySignins, getPerson, listPeople } from "@/lib/parents/directory";
import { resetDb, seedGuardian, seedParent } from "../helpers/db";
import { seedCache, seedShape, seedParentSettings, SIGNINS_ON, fam, par } from "../helpers/roster-cache";
import { recordOfCustomer, syncAppRecords } from "../helpers/app-records";
import { setRosterSource } from "@/lib/roster/source";

// The roster is read from a company first (withCompany()), so each family of the cache has its record and its link, and
// each guardian row stands on its family record and its own link, as seedGuardian() writes them (stage 3's slice 12b1):
// a person's rows are listed by the customer their family's own link names, and named from the family record. A
// family's sign-ins are read by its own record (`guardian.family_id`). The people and their rows are written directly,
// as the portal holds them: nothing makes a sign-in from QuickBooks.
const withCompany = () => db.transaction((tx) => setRosterSource(tx, "1111"));
const signinsOf = async (customer: string) => familySignins(await recordOfCustomer(customer, "family"));
const HELD_WORDS = "Can't sign in: the address was under more than one family, and held for staff to review";
/** An open row with no family record: the gate lets nobody in through it. */
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
    await withCompany(); await seedCache(ALL);
    const { ana } = await seedPeople();
    await db.update(parent).set({ welcomedAt: new Date("2026-11-01T12:00:00Z") }).where(eq(parent.id, ana.id));
    await db.insert(auditLog).values({ door: "parent", actorId: ana.id, actorLabel: ana.email, action: "signin", targetType: "parent", targetId: ana.id, at: new Date("2026-11-05T12:00:00Z") });
    expect((await listPeople("ana"))).toEqual([{ parentId: ana.id, name: "Ana Rivera", email: "ana@example.com", blocked: false,
      families: [{ guardianId: expect.any(String), familyQboId: "10", familyId: await recordOfCustomer("10", "family"), familyName: "Rivera Family", previousCompany: false, pageStands: true,
        kind: "can", words: "Can sign in (hasn't yet)", open: true, reinstatable: false }],
      lastSigninAt: "2026-11-05T12:00:00.000Z", welcomedAt: "2026-11-01T12:00:00.000Z" }]);
    expect((await listPeople("RIVERA")).length).toBe(1);
    expect((await listPeople("ana@ex")).length).toBe(1);
    expect(await listPeople("zzz")).toEqual([]);
    expect(await getPerson(ana.id)).toMatchObject({ name: "Ana Rivera", blockedReason: null, blockedAt: null, welcomeOwed: false });
    expect(await getPerson("00000000-0000-4000-8000-00000000dead")).toBeNull();
  });

  it("gives an old row its closing reason's words for good, naming no other family", async () => {
    await withCompany(); await seedCache(ALL);
    await seedPeople();
    const [sam] = await listPeople("sam");
    expect(sam!.families).toEqual([
      { guardianId: expect.any(String), familyQboId: "10", familyId: await recordOfCustomer("10", "family"), familyName: "Rivera Family", previousCompany: false, pageStands: true, kind: "cannot", words: HELD_WORDS, open: false, reinstatable: true },
      { guardianId: expect.any(String), familyQboId: "20", familyId: await recordOfCustomer("20", "family"), familyName: "Chen Family", previousCompany: false, pageStands: true, kind: "cannot", words: HELD_WORDS, open: false, reinstatable: true },
    ]);
  });

  it("names a current row in no family record in words, never from the cache, and lists it with the rows of families with no link", async () => {
    await withCompany(); await seedCache(ALL);
    const { ana } = await seedPeople();
    // A row made before its family had a record (the cache still holds "20", the Chen Family): in no family record.
    const bare = await seedGuardian({ parentId: ana.id, familyId: null, status: "invited" });
    const [person] = await listPeople("ana");
    expect(person!.families.map((f) => [f.familyQboId, f.familyName])).toEqual([["10", "Rivera Family"], [null, "A family whose name the portal doesn't know"]]);
    expect(person!.families[1]).toMatchObject({ guardianId: bare.id, familyId: null, pageStands: false, kind: "cannot", words: NO_RECORD_WORDS });
  });

  it("names a row that names no customer (slice 9d) from its family record, listing it after the rows that name one", async () => {
    await withCompany(); await seedCache(ALL);
    const { ana } = await seedPeople();
    // Two families staff added in the portal, with no link: one named, one whose name the portal never knew.
    const [oak] = await db.insert(family).values({ name: "Oak Family", active: true }).returning({ id: family.id });
    const [nameless] = await db.insert(family).values({ name: null, active: true }).returning({ id: family.id });
    const rows = await db.insert(guardian).values([oak!, nameless!].map((f) => ({ parentId: ana.id, familyQboId: null, familyId: f.id, status: "invited" as const, sourceQboId: null }))).returning();
    const [person] = await listPeople("ana");
    expect(person!.families.map((f) => [f.familyQboId, f.familyName])).toEqual([["10", "Rivera Family"],
      ...rows.sort((a, b) => (a.id < b.id ? -1 : 1)).map((r) => [null, r.familyId === oak!.id ? "Oak Family" : "A family whose name the portal doesn't know"])]);
    expect(person!.families.at(-1)).toMatchObject({ previousCompany: false, open: true });
    // Each family's page stands while its record is active, linked or not; one made inactive with no link has none to open.
    expect(person!.families.map((f) => f.pageStands)).toEqual([true, true, true]);
    // Linked since, to a customer that sorts first: Oak's row comes first, by its family's link (stage 3's slice 12b1).
    await db.insert(accountingLink).values({ system: "quickbooks", realmId: "1111", customerId: "5", familyId: oak!.id, origin: "confirmed", linkedBy: null });
    expect((await listPeople("ana"))[0]!.families.map((f) => [f.familyQboId, f.familyName])).toEqual([["5", "Oak Family"], ["10", "Rivera Family"], [null, "A family whose name the portal doesn't know"]]);
    await db.delete(accountingLink).where(eq(accountingLink.familyId, oak!.id));
    await db.update(family).set({ active: false }).where(eq(family.id, oak!.id));
    const after = (await listPeople("ana"))[0]!.families;
    expect(after.filter((f) => f.familyId !== null && String(f.familyId) === String(oak!.id)).map((f) => f.pageStands)).toEqual([false]);
    expect(after.filter((f) => f.familyId === null || String(f.familyId) !== String(oak!.id)).map((f) => f.pageStands)).toEqual([true, true]);
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
    // Inactive but linked: its page still stands (the roster lists its customer), so it is still linked to.
    expect((await listPeople("ana"))[0]!.families).toEqual([expect.objectContaining({ kind: "cannot", words: "Can't sign in now: the family is inactive", pageStands: true })]);
    // A closed row keeps its own reason's words.
    expect((await signinsOf("10")).find((s) => s.parentId !== ana.id)).toMatchObject({ kind: "cannot", words: HELD_WORDS });
    expect((await db.select().from(guardian).where(eq(guardian.parentId, ana.id))).map((g) => g.status)).toEqual(["invited"]);
  });

  it("shows a blocked person as blocked, and a link made by hand as it stands", async () => {
    await seedParentSettings({ signin: false });
    await withCompany(); await seedCache(ALL);
    const p = await seedParent({ name: "Hand Seeded", email: "seeded@example.com", blocked: true });
    const g = await seedGuardian({ parentId: p.id, familyQboId: "10" });
    await syncAppRecords(); // the cache's families and students: the row has its family record already (seedGuardian())
    expect(await signinsOf("10")).toEqual([{ guardianId: g.id, parentId: p.id, name: "Hand Seeded", email: "seeded@example.com", kind: "blocked", words: "Blocked", open: true, reinstatable: false }]);
  });

  it("keeps two same-named people in one family apart, one row each", async () => {
    await withCompany(); await seedCache([fam("10", "Rivera Family")]);
    const one = await seedParent({ name: "Pat Rivera", email: "pat.one@example.com" }), two = await seedParent({ name: "Pat Rivera", email: "pat.two@example.com" });
    const g1 = await seedGuardian({ parentId: one.id, familyQboId: "10" }), g2 = await seedGuardian({ parentId: two.id, familyQboId: "10" });
    await syncAppRecords();
    expect((await signinsOf("10")).map((s) => [s.guardianId, s.email])).toEqual([[g1.id, "pat.one@example.com"], [g2.id, "pat.two@example.com"]]);
  });

  it("marks a link from a previous QuickBooks company, never naming the family its old ID names now", async () => {
    await withCompany(); await seedCache(ALL);
    const { ana } = await seedPeople();
    const old = await seedGuardian({ parentId: ana.id, familyQboId: "20", status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active" });
    // As the clear left it: in no family, holding the old company's copy of the customer, which nothing reads.
    await db.update(guardian).set({ familyQboId: "20", sourceQboId: "21" }).where(eq(guardian.id, old.id));
    expect((await getPerson(ana.id))!.families).toEqual([
      { guardianId: expect.any(String), familyQboId: "10", familyId: await recordOfCustomer("10", "family"), familyName: "Rivera Family", previousCompany: false, pageStands: true, kind: "can", words: "Can sign in (hasn't yet)", open: true, reinstatable: false },
      { guardianId: old.id, familyQboId: null, familyId: null, familyName: "A family in the previous QuickBooks company", previousCompany: true, pageStands: false, kind: "cannot", words: "Can't sign in: a different QuickBooks company was connected", open: false, reinstatable: false },
    ]);
  });

  it("reads a family's sign-ins by the membership's own family record, not by the QuickBooks ID the row was made with", async () => {
    await seedParentSettings({ signin: false });
    await withCompany(); await seedCache(ALL);
    const p = await seedParent({ name: "Hand Seeded", email: "seeded@example.com" });
    const [g] = await db.insert(guardian).values({ parentId: p.id, familyQboId: "10", status: "invited" }).returning();
    // Until a membership is in a family record it is in no family's box, as a row a change of company closed never is;
    // its old copy of the customer puts it in none, and no import does (stage 3's slice 12b1).
    expect(await signinsOf("10")).toEqual([]);
    await syncAppRecords();
    expect(await signinsOf("10")).toEqual([]);
    await db.update(guardian).set({ familyId: await recordOfCustomer("10", "family") }).where(eq(guardian.id, g!.id));
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
