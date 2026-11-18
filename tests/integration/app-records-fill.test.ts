import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { accountingLink, auditLog, family, familyMoney, guardian, setting, signedFormEvidence, student, writeQueue } from "@/lib/db/schema";
import { setRosterSource } from "@/lib/roster/source";
import type { MembershipShape } from "@/lib/roster/shape";
import { resetDb, seedGuardian, seedParent } from "../helpers/db";
import { fam, par, seedCache, seedShape, stu, type CacheCustomer } from "../helpers/roster-cache";
import { seedSeason } from "../helpers/season";
import { seedEvent, seedSignup } from "../helpers/volunteer";
import { appRecordsFillStatements } from "../helpers/app-records-fill";
import { NO_CHANGES, appRecordsByCustomer, syncAppRecords, whatAFreshRunWouldChange } from "../helpers/app-records";

/**
 * Migration 0023 fills the app's own records in SQL from what the database holds, so that stage 2's migrations find
 * them however soon they run after it (AGENTS.md, The app's own records). The fill must make exactly what the
 * TypeScript function makes (keepAppRecordsInStep(), src/lib/families/in-step.ts): here each is run on the same data,
 * in turn, and what they made is compared customer by customer. And after the fill, the function finds nothing to change.
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
/** What the function makes, then what the fill makes from the same data. */
async function bothWays() {
  await syncAppRecords();
  const byFunction = await appRecordsByCustomer();
  await emptyAppRecords();
  await runFill();
  const byFill = await appRecordsByCustomer();
  return { byFunction, byFill };
}

const person = (name: string) => seedParent({ name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@fill.example` });
const member = (qboId: string, displayName: string, o: Partial<CacheCustomer> = {}): CacheCustomer => ({ qboId, displayName, typeQboId: "M", ...o });

/** Records of the current company naming customers the cache doesn't hold, of each kind the function reads, and one of an earlier company. */
async function seedRecordsNamingOthers() {
  const season = await seedSeason({ name: "Fill season", steps: [{ name: "Join", requirements: [
    { title: "Locker key", appliesTo: "family", chosen: ["F-COVER-GONE", "S1"], ticked: ["F-COVER-GONE"] },
    { title: "Uniform", appliesTo: "student", ticked: ["S-GONE", "S1"] },
  ] }] });
  expect(season.requirementIds["Uniform"]).toBeTruthy();
  const { shifts: [shift] } = await seedEvent({ inDays: 10 });
  const signer = await person("Signup Guardian");
  await seedSignup({ shiftId: shift!.id, familyQboId: "F1", signedUpBy: signer.id, student: { qboId: "S-GONE", name: "Gone Kid Name" } });
  await db.insert(familyMoney).values({ familyQboId: "F-MONEY", realmId: null, failedAt: new Date(), failedCode: "timeout" });
  await db.insert(writeQueue).values([
    { realmId: REALM, request: { op: "rename", role: "student", qboId: "S-QUEUE", syncToken: "0", name: "New", was: "Old" }, targetQboId: "S-QUEUE", familyQboId: "F1", state: "waiting", sent: false },
    { realmId: "OTHER-REALM", request: { op: "rename", role: "student", qboId: "S-OTHER-REALM", syncToken: "0", name: "New", was: "Old" }, targetQboId: "S-OTHER-REALM", familyQboId: "F-OTHER-REALM", state: "waiting", sent: false },
  ]);
  const evidence = (o: { family: string; familyName: string; realmId: string; earlier: boolean }) => ({
    requestId: null, realmId: o.realmId, earlierCompanyAt: o.earlier ? new Date() : null, familyQboId: o.family, subjectQboId: o.family, subjectKind: "family" as const,
    formTitle: "Fill form", familyName: o.familyName, subjectName: o.familyName, envelopeId: `envelope_fill${o.family.replace(/\W/g, "")}`, signers: [], consents: [], originals: [],
  });
  await db.insert(signedFormEvidence).values([
    evidence({ family: "F-EVID", familyName: "Evidence Family", realmId: REALM, earlier: false }),
    evidence({ family: "F-ARCHIVED", familyName: "Archived Family", realmId: "EARLIER-REALM", earlier: true }),
  ]);
}

describe("migration 0023's fill makes what keepAppRecordsInStep() makes", () => {
  beforeEach(async () => { await resetDb(); });

  it("in layered books with a parent type, with records naming customers the cache no longer holds", async () => {
    await db.transaction((tx) => setRosterSource(tx, REALM));
    await seedShape();
    await seedCache([
      fam("F1", "Ash Family"), par("P1", "Ash Parent", "F1", "ash@fill.example"), stu("S1", "Ash Kid", "F1"), stu("S2", "Ash Old Kid", "F1", { active: false }),
      fam("F2", "Birch Family", { active: false }), par("P2", "Birch Parent", "F2", "birch@fill.example"), stu("S3", "Birch Kid", "F2"),
      stu("S9", "Stray Kid", "NOT-CACHED"), member("X1", "Lincoln High"),
    ]);
    const [ash, cedar, birch, old, gone, d, e] = await Promise.all(["Ash Parent", "Cedar Hand", "Birch Parent", "Old Company", "Gone Family Parent", "Shared One", "Shared Two"].map(person));
    await seedGuardian({ parentId: ash!.id, familyQboId: "F1", status: "active", sourceQboId: "P1" });
    await seedGuardian({ parentId: cedar!.id, familyQboId: "F1", status: "invited" });
    await seedGuardian({ parentId: birch!.id, familyQboId: "F2", status: "disabled", disabledReason: "family_inactive", statusBeforeDisable: "active", sourceQboId: "P2" });
    await seedGuardian({ parentId: old!.id, familyQboId: "OLD-F", status: "disabled", disabledReason: "company_changed", statusBeforeDisable: "active", sourceQboId: "OLD-P" });
    await seedGuardian({ parentId: gone!.id, familyQboId: "F-GONE", status: "active", sourceQboId: "P-GONE" });
    await seedGuardian({ parentId: gone!.id, familyQboId: "X1", status: "active", sourceQboId: "X1" });
    await seedGuardian({ parentId: d!.id, familyQboId: "F1", status: "active", sourceQboId: "P-SHARED" });
    await seedGuardian({ parentId: e!.id, familyQboId: "F2", status: "active", sourceQboId: "P-SHARED" });
    await seedRecordsNamingOthers();

    const { byFunction, byFill } = await bothWays();
    expect(byFill).toEqual(byFunction);
    // And what that is, so the two can't agree by both making nothing.
    expect(byFunction.families).toEqual([
      { customer: "F-COVER-GONE", name: "Family F-COVER-GONE", active: false },
      { customer: "F-EVID", name: "Evidence Family", active: false },
      { customer: "F-GONE", name: "Family F-GONE", active: false },
      { customer: "F-MONEY", name: "Family F-MONEY", active: false },
      { customer: "F1", name: "Ash Family", active: true },
      { customer: "F2", name: "Birch Family", active: false },
      { customer: "X1", name: "Lincoln High", active: false },
    ]);
    expect(byFunction.students).toEqual([
      { customer: "S-GONE", name: "Gone Kid Name", active: false, family: null },
      { customer: "S-QUEUE", name: "Student S-QUEUE", active: false, family: null },
      { customer: "S1", name: "Ash Kid", active: true, family: "F1" },
      { customer: "S2", name: "Ash Old Kid", active: false, family: "F1" },
      { customer: "S3", name: "Birch Kid", active: true, family: "F2" },
    ]);
    // Never an earlier company's evidence, a closed link of another company, or another company's queue item.
    for (const customer of ["F-ARCHIVED", "OLD-F", "OLD-P", "S-OTHER-REALM", "F-OTHER-REALM", "S9"]) expect(byFunction.links.map((l) => l.customer)).not.toContain(customer);
    // Sign-ins from a record of their own: P1, P-GONE and the first of the two rows from P-SHARED. Not the hand-made one,
    // the closed one, or one whose record is the family's own.
    const memberships = byFunction.links.filter((l) => l.kind === "membership");
    expect(memberships.map((l) => l.customer).sort()).toEqual(["P-GONE", "P-SHARED", "P1"]);
    for (const l of byFunction.links) expect(l).toMatchObject({ system: "quickbooks", realmId: REALM, origin: "carried_over", linkedBy: null });
    expect(byFunction.memberships.filter((m) => m.family === null)).toHaveLength(1); // the closed link of the earlier company
  });

  it("in flat books, where a member is a family of one and its sign-in has no record of its own", async () => {
    await db.transaction((tx) => setRosterSource(tx, REALM));
    await seedShape({ kind: "flat", memberTypeIds: ["M"] } satisfies MembershipShape);
    await seedCache([member("M1", "Dana Member"), member("M2", "Eli Member", { active: false }), fam("F1", "Not A Family Here")]);
    const dana = await person("Dana Member"), gone = await person("Gone Member");
    await seedGuardian({ parentId: dana.id, familyQboId: "M1", status: "active", sourceQboId: "M1" });
    await seedGuardian({ parentId: gone.id, familyQboId: "M-GONE", status: "active", sourceQboId: "M-GONE" });
    const { byFunction, byFill } = await bothWays();
    expect(byFill).toEqual(byFunction);
    expect(byFunction.families).toEqual([
      { customer: "M-GONE", name: "Family M-GONE", active: false },
      { customer: "M1", name: "Dana Member", active: true },
      { customer: "M2", name: "Eli Member", active: false },
    ]);
    expect(byFunction.students).toEqual([]);
    expect(byFunction.links.filter((l) => l.kind === "membership")).toEqual([]);
  });

  it("in layered books with no parent type, where each sign-in comes from the family's own record", async () => {
    await db.transaction((tx) => setRosterSource(tx, REALM));
    await seedShape({ kind: "layered", familyTypeId: "F", studentTypeId: "S", parentTypeId: null });
    await seedCache([fam("F1", "Ash Family", { email: "ash@fill.example" }), stu("S1", "Ash Kid", "F1")]);
    const ash = await person("Ash Parent");
    await seedGuardian({ parentId: ash.id, familyQboId: "F1", status: "active", sourceQboId: "F1" });
    const { byFunction, byFill } = await bothWays();
    expect(byFill).toEqual(byFunction);
    expect(byFunction.families).toEqual([{ customer: "F1", name: "Ash Family", active: true }]);
    expect(byFunction.links.map((l) => [l.kind, l.customer])).toEqual([["family", "F1"], ["student", "S1"]]);
  });

  it("with no membership shape: only what the records name", async () => {
    await db.transaction((tx) => setRosterSource(tx, REALM));
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

  it("leaves records the function finds nothing to change in, and its scratch tables can be made again", async () => {
    await db.transaction((tx) => setRosterSource(tx, REALM));
    await seedShape();
    await seedCache([fam("F1", "Ash Family"), par("P1", "Ash Parent", "F1", "ash@fill.example"), stu("S1", "Ash Kid", "F1")]);
    const ash = await person("Ash Parent");
    await seedGuardian({ parentId: ash.id, familyQboId: "F1", status: "active", sourceQboId: "P1" });
    await seedRecordsNamingOthers();
    await runFill();
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
    // The fill run here leaves no audit row: that is the migration's own, once.
    expect((await db.select().from(auditLog)).filter((r) => r.action === "accounting.link.carried_over")).toEqual([]);
    await emptyAppRecords();
    await runFill();
    expect(await whatAFreshRunWouldChange()).toEqual(NO_CHANGES);
  });
});
