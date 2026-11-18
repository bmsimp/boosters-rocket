import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { auditLog } from "@/lib/db/schema";
import { writeAudit } from "@/lib/audit/log";
import { auditExportScope, auditPage, parseAuditFilters } from "@/lib/audit/query";
import { setRosterSource } from "@/lib/roster/source";
import { resetDb } from "../helpers/db";
import { fam, seedCache, seedShape, stu } from "../helpers/roster-cache";
import { recordOfCustomer } from "../helpers/app-records";

/**
 * The audit page's record filter for a family or a student (open question 17 of the app-owned families spec): audit
 * rows are never rewritten, so rows written before the seasons moved name the QuickBooks customer, and those written
 * since name the app's record. A search for the record finds both: a row naming one of its customers, and a tick's or
 * waiver's row ("<requirement>:<subject>") naming either. Nothing of another family or student comes with them.
 */
const REQ = "7d1f0b2a-1111-4c3d-8e9f-000000000001";
const actor = { door: "staff" as const, id: null, label: "admin@club.org" };
const row = (action: string, targetType: string, targetId: string) => writeAudit({ actor, action, targetType, targetId });
const targets = async (record: string) => (await auditPage(parseAuditFilters({ record }))).rows.map((r) => `${r.targetType}:${r.targetId}`).sort();

describe("the audit page's filter for one family or student", () => {
  let rivera = "", chen = "", leo = "", kai = "";
  beforeEach(async () => {
    await resetDb();
    await db.transaction((tx) => setRosterSource(tx, "4620000000000001"));
    await seedShape();
    await seedCache([fam("10", "Rivera Family"), stu("12", "Leo Rivera", "10"), fam("20", "Chen Family"), stu("22", "Kai Chen", "20")]);
    [rivera, chen, leo, kai] = [String(await recordOfCustomer("10", "family")), String(await recordOfCustomer("20", "family")),
      String(await recordOfCustomer("12", "student")), String(await recordOfCustomer("22", "student"))];
    // Before the seasons moved: the family's page read by its customer, and ticks keyed by the customer.
    await row("season.progress.family.read", "qbo_customer", "10");
    await row("season.requirement.tick", "requirement_progress", `${REQ}:12`);
    await row("season.progress.family.read", "qbo_customer", "20");
    await row("season.requirement.tick", "requirement_progress", `${REQ}:22`);
    // A customer whose id ends as Leo's does: never his.
    await row("season.requirement.tick", "requirement_progress", `${REQ}:112`);
    // Since: by the app's own records.
    await row("season.progress.family.read", "family", rivera);
    await row("season.requirement.tick", "requirement_progress", `${REQ}:${leo}`);
    await row("season.progress.family.read", "family", chen);
    await row("season.requirement.tick", "requirement_progress", `${REQ}:${kai}`);
  });

  it("finds a family's old rows and its new ones, and nothing of another family", async () => {
    expect(await targets(`family:${rivera}`)).toEqual([`family:${rivera}`, "qbo_customer:10"].sort());
    expect(await targets(`family:${chen}`)).toEqual([`family:${chen}`, "qbo_customer:20"].sort());
    // The id alone finds the same.
    expect(await targets(rivera)).toEqual([`family:${rivera}`, "qbo_customer:10"].sort());
    expect((await auditExportScope(parseAuditFilters({ record: `family:${rivera}` }))).rows).toBe(2);
  });

  it("finds a student's ticks under the old key and the new, and never another's whose id ends the same", async () => {
    expect(await targets(`student:${leo}`)).toEqual([`requirement_progress:${REQ}:12`, `requirement_progress:${REQ}:${leo}`].sort());
    expect(await targets(`student:${kai}`)).toEqual([`requirement_progress:${REQ}:22`, `requirement_progress:${REQ}:${kai}`].sort());
  });

  it("matches any other record exactly, as before", async () => {
    expect(await targets("qbo_customer:10")).toEqual(["qbo_customer:10"]);
    // A family's id under the wrong kind is no family: only an exact match, and there is none.
    expect(await targets(`student:${rivera}`)).toEqual([]);
    expect((await db.select().from(auditLog)).length).toBe(9);
  });
});
