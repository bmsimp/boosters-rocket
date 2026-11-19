import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, guardian, setting, signedFormEvidence, student } from "@/lib/db/schema";
import { setRosterSource } from "@/lib/roster/source";
import type { MembershipShape } from "@/lib/roster/shape";
import { resetDb, seedGuardian, seedParent } from "../helpers/db";
import { fam, par, seedCache, seedShape, stu, type CacheCustomer } from "../helpers/roster-cache";
import { appRecordsFillStatements } from "../helpers/app-records-fill";
import { NO_CHANGES, appRecordsByCustomer, syncAppRecords, whatAFreshRunWouldChange } from "../helpers/app-records";

/**
 * Migration 0023 fills the app's own records in SQL from what the database holds, so that stage 2's migrations find
 * them however soon they run after it (AGENTS.md, The app's own records). The fill must make exactly what the
 * TypeScript function makes from nothing (keepAppRecordsInStep(), src/lib/families/in-step.ts): here each is run on the
 * same data from empty tables, in turn, and what they made is compared customer by customer. And after the fill, the
 * function finds nothing to change.
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
/** What the function makes from empty tables, then what the fill makes from the same data. */
async function bothWays() {
  await emptyAppRecords();
  await syncAppRecords();
  const byFunction = await appRecordsByCustomer();
  await emptyAppRecords();
  await runFill();
  const byFill = await appRecordsByCustomer();
  return { byFunction, byFill };
}
const company = () => db.transaction((tx) => setRosterSource(tx, REALM));

const person = (name: string) => seedParent({ name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@fill.example` });
const member = (qboId: string, displayName: string, o: Partial<CacheCustomer> = {}): CacheCustomer => ({ qboId, displayName, typeQboId: "M", ...o });

/**
 * Evidence of an earlier company, which still names customers and is never read. The records of the current company
 * that name customers the cache doesn't hold, or a roster student as a family, are the guardian rows each test seeds:
 * since the write queue was re-keyed (migrations 0034 and 0035) the function reads only guardian rows, sessions and
 * pending email changes, all naming a family, so no record names a customer as a student any more. The season's chosen
 * lists, ticks and reminder claims, volunteering's sign-ups, credit and reminder claims, form requests and the current
 * company's signed-form evidence, buy-outs, the money cache and the write queue name the app's own records (migrations
 * 0024 to 0035), so they name no customer for the fill to make a record of (RE_KEYED_SINCE_0023). The queue's cases
 * this test held went with it: a void naming a family the cache doesn't hold (F-GONE's guardian row is that case now),
 * one naming a roster student as a family (S3's guardian row is), and changes naming students the cache doesn't hold
 * and a roster family as a student, which nothing can name now.
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

describe("migration 0023's fill makes what keepAppRecordsInStep() makes", () => {
  beforeEach(async () => { await resetDb(); });

  it("in layered books with a parent type, with records naming customers the cache doesn't hold, or names as the other kind", async () => {
    await company();
    await seedShape();
    await seedCache([
      fam("F1", "Ash Family"), par("P1", "Ash Parent", "F1", "ash@fill.example"), stu("S1", "Ash Kid", "F1"), stu("S2", "Ash Old Kid", "F1", { active: false }),
      fam("F2", "Birch Family", { active: false }), par("P2", "Birch Parent", "F2", "birch@fill.example"), stu("S3", "Birch Kid", "F2"),
      stu("S9", "Stray Kid", "NOT-CACHED"), member("X1", "Lincoln High"),
    ]);
    const [ash, cedar, birch, old, gone, d, e, typed] = await Promise.all(["Ash Parent", "Cedar Hand", "Birch Parent", "Old Company", "Gone Family Parent", "Shared One", "Shared Two", "Retyped Family"].map(person));
    await seedGuardian({ parentId: ash!.id, familyQboId: "F1", status: "active", sourceQboId: "P1" });
    await seedGuardian({ parentId: cedar!.id, familyQboId: "F1", status: "invited" });
    await seedGuardian({ parentId: birch!.id, familyQboId: "F2", status: "disabled", disabledReason: "family_inactive", statusBeforeDisable: "active", sourceQboId: "P2" });
    await seedGuardian({ parentId: old!.id, familyQboId: "OLD-F", status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active", sourceQboId: "OLD-P" });
    await seedGuardian({ parentId: gone!.id, familyQboId: "F-GONE", status: "active", sourceQboId: "P-GONE" });
    await seedGuardian({ parentId: gone!.id, familyQboId: "X1", status: "active", sourceQboId: "X1" });
    await seedGuardian({ parentId: d!.id, familyQboId: "F1", status: "active", sourceQboId: "P-SHARED" });
    await seedGuardian({ parentId: e!.id, familyQboId: "F2", status: "active", sourceQboId: "P-SHARED" });
    // S3 is a student on the roster: a guardian row names it as its family (someone changed its type in QuickBooks).
    await seedGuardian({ parentId: typed!.id, familyQboId: "S3", status: "disabled", disabledReason: "not_in_quickbooks", statusBeforeDisable: "active" });
    await seedRecordsNamingOthers();

    const { byFunction, byFill } = await bothWays();
    expect(byFill).toEqual(byFunction);
    // And what that is, so the two can't agree by both making nothing.
    expect(byFunction.families).toEqual([
      { customer: "F-GONE", name: null, active: false },
      { customer: "F1", name: "Ash Family", active: true },
      { customer: "F2", name: "Birch Family", active: false },
      { customer: "S3", name: "Birch Kid", active: false },       // named as a family by a guardian row
      { customer: "X1", name: "Lincoln High", active: false },
    ]);
    expect(byFunction.students).toEqual([
      { customer: "S1", name: "Ash Kid", active: true, family: "F1" },
      { customer: "S2", name: "Ash Old Kid", active: false, family: "F1" },
      { customer: "S3", name: "Birch Kid", active: true, family: "F2" },
    ]);
    // Each customer named as both kinds has a link of each kind.
    for (const customer of ["S3"]) expect(byFunction.links.filter((l) => l.customer === customer).map((l) => l.kind)).toEqual(["family", "student"]);
    // Never an earlier company's evidence, a closed link of another company, or a student the roster holds under no family.
    for (const customer of ["F-ARCHIVED", "OLD-F", "OLD-P", "S9"]) expect(byFunction.links.map((l) => l.customer)).not.toContain(customer);
    // Sign-ins from a record of their own, open or closed, both rows from P-SHARED; not the hand-made one, the one whose
    // record is the family's own, or the earlier company's.
    expect(byFunction.links.filter((l) => l.kind === "membership").map((l) => l.customer)).toEqual(["P-GONE", "P-SHARED", "P-SHARED", "P1", "P2"]);
    for (const l of byFunction.links) expect(l).toMatchObject({ system: "quickbooks", realmId: REALM, origin: "carried_over", linkedBy: null });
    expect(byFunction.memberships.filter((m) => m.family === null)).toHaveLength(1); // the closed link of the earlier company
  });

  it("in flat books, where a member is a family of one and its sign-in has no record of its own", async () => {
    await company();
    await seedShape({ kind: "flat", memberTypeIds: ["M"] } satisfies MembershipShape);
    await seedCache([member("M1", "Dana Member"), member("M2", "Eli Member", { active: false }), fam("F1", "Not A Family Here")]);
    const dana = await person("Dana Member"), gone = await person("Gone Member");
    await seedGuardian({ parentId: dana.id, familyQboId: "M1", status: "active", sourceQboId: "M1" });
    await seedGuardian({ parentId: gone.id, familyQboId: "M-GONE", status: "active", sourceQboId: "M-GONE" });
    const { byFunction, byFill } = await bothWays();
    expect(byFill).toEqual(byFunction);
    expect(byFunction.families).toEqual([
      { customer: "M-GONE", name: null, active: false },
      { customer: "M1", name: "Dana Member", active: true },
      { customer: "M2", name: "Eli Member", active: false },
    ]);
    expect(byFunction.students).toEqual([]);
    expect(byFunction.links.filter((l) => l.kind === "membership")).toEqual([]);
  });

  it("in layered books with no parent type, where each sign-in comes from the family's own record", async () => {
    await company();
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null });
    await seedCache([fam("F1", "Ash Family", { email: "ash@fill.example" }), stu("S1", "Ash Kid", "F1")]);
    const ash = await person("Ash Parent");
    await seedGuardian({ parentId: ash.id, familyQboId: "F1", status: "active", sourceQboId: "F1" });
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
  ])("with %s, which the portal reads as no shape: only what the records name", async (_what, shape) => {
    await company();
    if (shape) await db.insert(setting).values({ key: "membership.shape", value: shape });
    await seedCache([fam("F1", "Ash Family"), stu("S1", "Ash Kid", "F1")]);
    const ash = await person("Ash Parent");
    await seedGuardian({ parentId: ash.id, familyQboId: "F1", status: "active", sourceQboId: "P1" });
    const { byFunction, byFill } = await bothWays();
    expect(byFill).toEqual(byFunction);
    expect(byFunction.families).toEqual([{ customer: "F1", name: "Ash Family", active: false }]);
    expect(byFunction.students).toEqual([]);
  });

  it("while the cache names no company: nothing at all", async () => {
    await seedShape();
    await seedCache([fam("F1", "Ash Family"), stu("S1", "Ash Kid", "F1")]);
    const ash = await person("Ash Parent");
    await seedGuardian({ parentId: ash.id, familyQboId: "F1", status: "active", sourceQboId: "P1" });
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
    const ash = await person("Ash Parent");
    await seedGuardian({ parentId: ash.id, familyQboId: "F1", status: "active", sourceQboId: "P1" });
    await seedRecordsNamingOthers();
    await emptyAppRecords();
    await runFill();
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    // The fill run here leaves no audit row: that is the migration's own, once.
    expect((await db.select().from(auditLog)).filter((r) => r.action === "accounting.link.carried_over")).toEqual([]);
  });
});
