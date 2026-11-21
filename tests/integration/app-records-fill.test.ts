import { describe, it, expect, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, guardian, setting, signedFormEvidence, student } from "@/lib/db/schema";
import { setRosterSource } from "@/lib/roster/source";
import type { MembershipShape } from "@/lib/roster/shape";
import { resetDb, seedParent } from "../helpers/db";
import { fam, par, seedCache, seedShape, stu, type CacheCustomer } from "../helpers/roster-cache";
import { appRecordsFillStatements } from "../helpers/app-records-fill";
import { NO_CHANGES, appRecordsByCustomer, syncAppRecords, whatAFreshRunWouldChange } from "../helpers/app-records";

/**
 * Migration 0023 fills the app's own records in SQL from what the database holds, so that stage 2's migrations find
 * them however soon they run after it (docs/agents/app-records.md). The fill must make exactly what the
 * TypeScript import makes from nothing (importRecordsFromRoster(), src/lib/families/roster-import.ts, which since stage
 * 3's slice 10 the portal runs only narrowed to one family, from "Create a family from this" in
 * src/lib/roster/no-family.ts, and stage 4's import will run whole): here each is run on the
 * same data from empty tables, in turn, and what they made is compared customer by customer: the families, the students
 * and their links. Guardian rows are compared no more: since stage 3's slice 12b1 neither touches one (a row is given its
 * family and its own link by whoever makes it, and the fill is run with 0023's guardian statements left out,
 * GUARDIANS_LEFT_OUT in tests/helpers/app-records-fill.ts). And after the fill, the function finds nothing to change.
 */
const REALM = "4620000000000001";

async function emptyAppRecords() {
  await db.update(guardian).set({ familyId: null });
  await db.delete(accountingLink); await db.delete(student); await db.delete(family);
}
async function runFill() {
  const statements = appRecordsFillStatements();
  await db.transaction(async (tx) => { for (const s of statements) await tx.execute(sql.raw(s)); });
}
/** The families, students and links, by customer: what the fill and the function are compared on. */
async function records() {
  const { families, students, links } = await appRecordsByCustomer();
  return { families, students, links };
}
/** What the function makes from empty tables, then what the fill makes from the same data. */
async function bothWays() {
  await emptyAppRecords();
  await syncAppRecords();
  const byFunction = await records();
  await emptyAppRecords();
  await runFill();
  const byFill = await records();
  return { byFunction, byFill };
}
const company = () => db.transaction((tx) => setRosterSource(tx, REALM));

const person = (name: string) => seedParent({ name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@fill.example` });
const member = (qboId: string, displayName: string, o: Partial<CacheCustomer> = {}): CacheCustomer => ({ qboId, displayName, typeQboId: "M", ...o });

/**
 * Evidence of an earlier company, which still names customers and is never read. No record of the current company
 * names a customer for the fill or the function to make a record of any more: the season's, volunteering's, the forms',
 * the buy-outs', the money cache's and the write queue's name the app's own records (migrations 0024 to 0035,
 * RE_KEYED_SINCE_0023), so do parents' sessions and pending email changes (0037 and 0038), and since stage 3's slice
 * 12b1 neither reads a guardian row's old copies (GUARDIANS_LEFT_OUT). So the cases of a customer the cache doesn't
 * hold, or of a roster student named as a family, went with the guardian rows that named them: each makes nothing now.
 */
async function seedRecordsNamingOthers() {
  const evidence = (o: { family: string; familyName: string; realmId: string; earlier: boolean }) => ({
    requestId: null, realmId: o.realmId, earlierCompanyAt: o.earlier ? new Date() : null, familyQboId: o.family, subjectQboId: o.family, subjectKind: "family" as const,
    formTitle: "Fill form", familyName: o.familyName, subjectName: o.familyName, envelopeId: `envelope_fill${o.family.replace(/\W/g, "")}`, signers: [], consents: [], originals: [],
  });
  await db.insert(signedFormEvidence).values([
    evidence({ family: "F-ARCHIVED", familyName: "Archived Family", realmId: "EARLIER-REALM", earlier: true }),
  ]);
}

describe("migration 0023's fill makes what the import makes", () => {
  beforeEach(async () => { await resetDb(); });

  it("in layered books with a parent type, with customers of other types and a student under a customer the cache doesn't hold", async () => {
    await company();
    await seedShape();
    await seedCache([
      fam("F1", "Ash Family"), par("P1", "Ash Parent", "F1", "ash@fill.example"), stu("S1", "Ash Kid", "F1"), stu("S2", "Ash Old Kid", "F1", { active: false }),
      fam("F2", "Birch Family", { active: false }), par("P2", "Birch Parent", "F2", "birch@fill.example"), stu("S3", "Birch Kid", "F2"),
      stu("S9", "Stray Kid", "NOT-CACHED"), member("X1", "Lincoln High"),
    ]);
    await seedRecordsNamingOthers();

    const { byFunction, byFill } = await bothWays();
    expect(byFill).toEqual(byFunction);
    // And what that is, so the two can't agree by both making nothing.
    expect(byFunction.families).toEqual([
      { customer: "F1", name: "Ash Family", active: true },
      { customer: "F2", name: "Birch Family", active: false },
    ]);
    expect(byFunction.students).toEqual([
      { customer: "S1", name: "Ash Kid", active: true, family: "F1" },
      { customer: "S2", name: "Ash Old Kid", active: false, family: "F1" },
      { customer: "S3", name: "Birch Kid", active: true, family: "F2" },
    ]);
    // Never an earlier company's evidence, a parent, a customer of another type, or a student the roster holds under no family.
    for (const customer of ["F-ARCHIVED", "P1", "P2", "X1", "S9"]) expect(byFunction.links.map((l) => l.customer)).not.toContain(customer);
    expect(byFunction.links.filter((l) => l.kind === "membership")).toEqual([]);
    for (const l of byFunction.links) expect(l).toMatchObject({ system: "quickbooks", realmId: REALM, origin: "carried_over", linkedBy: null });
    // Each link starts aligned with its customer's version in the cache, by the fill (0041's) as by the import (stage 3's
    // slice 9e), so the comparison above holds the tokens too.
    expect(byFunction.links.find((l) => l.customer === "F1")!.syncedToken).not.toBeNull();
  });

  it("neither puts a guardian row in a family nor links it, whatever its old copies name", async () => {
    await company();
    await seedShape();
    await seedCache([fam("F1", "Ash Family"), par("P1", "Ash Parent", "F1", "ash@fill.example"), stu("S1", "Ash Kid", "F1")]);
    const ash = await person("Ash Parent");
    // A row holding only the old copies, as 0023's fill read them, and no family record.
    const [row] = await db.insert(guardian).values({ parentId: ash.id, familyQboId: "F1", sourceQboId: "P1", status: "active" }).returning();
    const { byFunction, byFill } = await bothWays();
    expect(byFill).toEqual(byFunction);
    expect(byFunction.families).toEqual([{ customer: "F1", name: "Ash Family", active: true }]);
    expect((await db.select().from(guardian).where(eq(guardian.id, row!.id)))[0]!.familyId).toBeNull();
    expect(await db.select().from(accountingLink).where(eq(accountingLink.guardianId, row!.id))).toEqual([]);
  });

  it("in flat books, where a member is a family of one", async () => {
    await company();
    await seedShape({ kind: "flat", memberTypeIds: ["M"] } satisfies MembershipShape);
    await seedCache([member("M1", "Dana Member"), member("M2", "Eli Member", { active: false }), fam("F1", "Not A Family Here")]);
    const { byFunction, byFill } = await bothWays();
    expect(byFill).toEqual(byFunction);
    expect(byFunction.families).toEqual([
      { customer: "M1", name: "Dana Member", active: true },
      { customer: "M2", name: "Eli Member", active: false },
    ]);
    expect(byFunction.students).toEqual([]);
    expect(byFunction.links.filter((l) => l.kind === "membership")).toEqual([]);
  });

  it("in layered books with no parent type", async () => {
    await company();
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null });
    await seedCache([fam("F1", "Ash Family", { email: "ash@fill.example" }), stu("S1", "Ash Kid", "F1")]);
    const { byFunction, byFill } = await bothWays();
    expect(byFill).toEqual(byFunction);
    expect(byFunction.families).toEqual([{ customer: "F1", name: "Ash Family", active: true }]);
    expect(byFunction.links.map((l) => [l.kind, l.customer])).toEqual([["family", "F1"], ["student", "S1"]]);
  });

  it.each([
    ["no membership shape", null],
    ["a layered shape with a key missing", { kind: "layered", familyTypeId: "F", studentTypeId: "S" }],
    ["a layered shape with an empty type id", { kind: "layered", familyTypeId: "", studentTypeId: "S", parentTypeId: "P" }],
    ["a flat shape whose member types aren't strings", { kind: "flat", memberTypeIds: ["F", 5] }],
    ["a flat shape with no member types", { kind: "flat", memberTypeIds: [] }],
    ["a shape of no kind the portal knows", { kind: "nested", familyTypeId: "F" }],
  ])("with %s, which the portal reads as no shape: nothing, since no record names a customer", async (_what, shape) => {
    await company();
    if (shape) await db.insert(setting).values({ key: "membership.shape", value: shape });
    await seedCache([fam("F1", "Ash Family"), stu("S1", "Ash Kid", "F1")]);
    const { byFunction, byFill } = await bothWays();
    expect(byFill).toEqual(byFunction);
    expect(byFunction.families).toEqual([]);
    expect(byFunction.students).toEqual([]);
  });

  it("while the cache names no company: nothing at all", async () => {
    await seedShape();
    await seedCache([fam("F1", "Ash Family"), stu("S1", "Ash Kid", "F1")]);
    expect((await db.select().from(setting)).map((s) => s.key)).not.toContain("roster.source");
    const { byFunction, byFill } = await bothWays();
    expect(byFill).toEqual(byFunction);
    expect(byFunction.families).toEqual([]);
    expect(byFunction.students).toEqual([]);
    expect(byFunction.links).toEqual([]);
  });

  it("leaves records the function finds nothing to change in", async () => {
    await company();
    await seedShape();
    await seedCache([fam("F1", "Ash Family"), par("P1", "Ash Parent", "F1", "ash@fill.example"), stu("S1", "Ash Kid", "F1"), fam("F2", "Birch Family"), stu("S3", "Birch Kid", "F2")]);
    await seedRecordsNamingOthers();
    await emptyAppRecords();
    await runFill();
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    // The fill run here leaves no audit row: that is the migration's own, once.
    expect((await db.select().from(auditLog)).filter((r) => r.action === "accounting.link.carried_over")).toEqual([]);
  });
});
