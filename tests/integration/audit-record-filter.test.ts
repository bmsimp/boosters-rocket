import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db/client";
import { desc, eq, inArray, or } from "drizzle-orm";
import { accountingLink, accountingLinkEnded, auditLog, guardian, student } from "@/lib/db/schema";
import { asAppFamilyId } from "@/lib/families/ids";
import { writeAudit } from "@/lib/audit/log";
import { auditExportScope, auditPage, parseAuditFilters } from "@/lib/audit/query";
import { setRosterSource } from "@/lib/roster/source";
import { resetDb, seedParent } from "../helpers/db";
import { fam, seedCache, seedShape, stu } from "../helpers/roster-cache";
import { recordOfCustomer } from "../helpers/app-records";
import { seedSeason } from "../helpers/season";

/**
 * The audit page's record filter for a family or a student (open question 17 of the app-owned families spec): audit
 * rows are never rewritten, so rows written before the seasons moved name the QuickBooks customer, and those written
 * since name the app's record. A search for the record finds both: a row naming one of its customers under a target
 * that names a customer of its kind, and a tick's or waiver's row ("<requirement>:<subject>") naming either. The same
 * for volunteering, which moved next: a family's credit page read by its customer and by its record, a moved student's
 * places by the student's customer and by their record. And for forms, which moved after: a request's rows name its
 * family and student in their body, by customer before and by record since (a move names both families), while a kept
 * form's rows are never matched by a number. Nothing of another family or student comes with them, and no
 * row of another kind whose id happens to be the same number (a job run, a product, a check's run).
 */
const REQ = "7d1f0b2a-1111-4c3d-8e9f-000000000001";
const actor = { door: "staff" as const, id: null, label: "admin@club.org" };
const row = (action: string, targetType: string, targetId: string) => writeAudit({ actor, action, targetType, targetId });
const bodied = (action: string, targetType: string, targetId: string, body: { before?: Record<string, unknown>; after?: Record<string, unknown> }) =>
  writeAudit({ actor, action, targetType, targetId, ...body });
const [FORM_OLD, FORM_NEW, FORM_MOVED] = ["7d1f0b2a-2222-4c3d-8e9f-000000000001", "7d1f0b2a-2222-4c3d-8e9f-000000000002", "7d1f0b2a-2222-4c3d-8e9f-000000000003"];
const [EVIDENCE_OLD, EVIDENCE_NEW] = ["7d1f0b2a-3333-4c3d-8e9f-000000000001", "7d1f0b2a-3333-4c3d-8e9f-000000000002"];
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
    // Volunteering, before it moved: the family's credit page read by its customer, and a moved student's places.
    await row("volunteer.credit.family.read", "family", "10");
    await row("volunteer.signup.moved", "student", "12");
    await row("volunteer.credit.family.read", "family", "20");
    // Since: by the app's own records.
    await row("volunteer.credit.family.read", "family", rivera);
    await row("volunteer.signup.moved", "student", leo);
    // Forms, which moved next: a request's rows name its family and student in their body, by the customers before
    // forms moved and by the records since, a move by both families. A kept form's read names an earlier company's
    // number, which may be Rivera's now: never Rivera's.
    await bodied("form.state.change", "signature_request", FORM_OLD, { after: { state: "waiting", familyQboId: "10", subjectQboId: "12" } });
    await bodied("form.state.change", "signature_request", FORM_NEW, { after: { state: "waiting", familyId: rivera, studentId: leo } });
    await bodied("forms.request.moved", "signature_request", FORM_MOVED, { before: { familyId: rivera, studentId: leo }, after: { familyId: chen, studentId: leo } });
    await bodied("forms.evidence.read", "signed_form_evidence", EVIDENCE_OLD, { after: { familyQboId: "10", earlierCompany: true } });
    await bodied("forms.evidence.read", "signed_form_evidence", EVIDENCE_NEW, { after: { familyId: null, studentId: null, earlierCompany: true } });
    // Rows of other kinds whose ids are the same numbers as the customers': never the family's or the student's.
    await row("roster.refresh", "job_run", "10");
    await row("season.requirement.item", "qbo_item", "12");
    await row("quickbooks.check.start", "qbo_check_run", "10");
  });

  it("finds a family's old rows and its new ones, the season's and volunteering's, and nothing of another family or another kind", async () => {
    const rivers = [`family:${rivera}`, `family:${rivera}`, "family:10", "qbo_customer:10",
      `signature_request:${FORM_OLD}`, `signature_request:${FORM_NEW}`, `signature_request:${FORM_MOVED}`].sort();
    expect(await targets(`family:${rivera}`)).toEqual(rivers);
    expect(await targets(`family:${chen}`)).toEqual([`family:${chen}`, "family:20", "qbo_customer:20", `signature_request:${FORM_MOVED}`].sort());
    // The id alone finds the same.
    expect(await targets(rivera)).toEqual(rivers);
    expect((await auditExportScope(parseAuditFilters({ record: `family:${rivera}` }))).rows).toBe(7);
    // A kept form's read is never matched by a number: an earlier company's evidence may hold Rivera's.
    for (const record of [`family:${rivera}`, rivera]) for (const e of [EVIDENCE_OLD, EVIDENCE_NEW]) expect(await targets(record)).not.toContain(`signed_form_evidence:${e}`);
  });

  it("finds a family's money rows written before the money cache moved, by its customer, and those written since, by its record", async () => {
    // Before: the cross-check's difference under "family" by the customer, and the Balances page's read by the customer.
    await row("money.balance_mismatch", "family", "10");
    await row("money.family.read", "qbo_customer", "10");
    // Since: both by the app's own family; the Chen family's own row never comes with Rivera's.
    await row("money.balance_mismatch", "family", rivera);
    await row("money.family.read", "family", rivera);
    await row("money.balance_mismatch", "family", chen);
    const rivers = [`family:${rivera}`, `family:${rivera}`, "family:10", "qbo_customer:10",
      `signature_request:${FORM_OLD}`, `signature_request:${FORM_NEW}`, `signature_request:${FORM_MOVED}`];
    const money = ["family:10", "qbo_customer:10", `family:${rivera}`, `family:${rivera}`];
    expect(await targets(`family:${rivera}`)).toEqual([...rivers, ...money].sort());
    expect(await targets(rivera)).toEqual([...rivers, ...money].sort());
    expect(await targets(`family:${chen}`)).toEqual([`family:${chen}`, `family:${chen}`, "family:20", "qbo_customer:20", `signature_request:${FORM_MOVED}`].sort());
  });

  it("finds a family's sign-in and email-change rows by its customer before the session moved and by its record since, and nothing of another family's", async () => {
    // A sign-in row's target is the person; the family is in its body. Each row carries a tag, to name it here.
    const PERSON = "7d1f0b2a-4444-4c3d-8e9f-000000000001";
    const signin = (action: string, tag: string, after: Record<string, unknown>) => bodied(action, "parent", PERSON, { after: { ...after, tag } });
    // Before stage 3's fifth slice: by the family's customer.
    await signin("signin", "old-in-rivera", { familyQboId: "10" });
    await signin("signin.refused", "old-refused-rivera", { reason: "family_not_enabled", familyQboId: "10" });
    await signin("signin.family_switch", "old-switch-chen-to-rivera", { from: "20", to: "10" });
    await signin("signin", "old-in-chen", { familyQboId: "20" });
    // Since: by the app's own family record.
    await signin("signin", "new-in-rivera", { familyId: rivera });
    await signin("signin.refused", "new-refused-rivera", { reason: "family_not_enabled", familyId: rivera });
    await signin("signin.family_switch", "new-switch-rivera-to-chen", { from: rivera, to: chen });
    await signin("signin", "new-in-chen", { familyId: chen });
    // Nobody's family: a refusal naming none, and what a browser sent the chooser, which may be any string.
    await signin("signin.refused", "no-family", { reason: "no_enabled_guardian" });
    await signin("signin.refused", "sent-a-number", { reason: "family_not_enabled", sent: "10" });
    // A change of sign-in address targets the QuickBooks record it changes, and names the family it was asked in since.
    await bodied("parent.email.request", "qbo_customer", "11", { after: { email: "rosa.new@example.com", familyId: rivera, tag: "email-asked-rivera" } });
    await bodied("parent.email.save", "qbo_customer", "11", { after: { email: "rosa.new@example.com", familyId: rivera, tag: "email-saved-rivera" } });
    await bodied("parent.email.request", "qbo_customer", "21", { after: { email: "mei.new@example.com", familyId: chen, tag: "email-asked-chen" } });
    const tagged = async (record: string) => (await auditPage(parseAuditFilters({ record }))).rows
      .map((r) => (r.after as { tag?: string } | null)?.tag).filter((t): t is string => t !== undefined).sort();
    const rivers = ["old-in-rivera", "old-refused-rivera", "old-switch-chen-to-rivera", "new-in-rivera", "new-refused-rivera", "new-switch-rivera-to-chen",
      "email-asked-rivera", "email-saved-rivera"].sort();
    expect(await tagged(`family:${rivera}`)).toEqual(rivers);
    expect(await tagged(rivera)).toEqual(rivers);
    expect(await tagged(`family:${chen}`)).toEqual(["old-switch-chen-to-rivera", "old-in-chen", "new-switch-rivera-to-chen", "new-in-chen", "email-asked-chen"].sort());
    // A student's record finds none of them; the person's own record finds every sign-in row, as before.
    expect(await tagged(`student:${leo}`)).toEqual([]);
    expect(await tagged(`parent:${PERSON}`)).toHaveLength(10);
  });

  it("finds the guardians staff gave or ended for a family, and the people made for it, by its record, and nothing of another family's", async () => {
    // Stage 3's slice 7b: a membership's rows target the guardian row, a person made by staff targets the person; the
    // family is in their body. Rows the retired reconcile wrote named the family's customer.
    const [ROW_A, ROW_B, PERSON] = ["7d1f0b2a-5555-4c3d-8e9f-000000000001", "7d1f0b2a-5555-4c3d-8e9f-000000000002", "7d1f0b2a-5555-4c3d-8e9f-000000000003"];
    const tag = (t: string, after: Record<string, unknown>) => ({ after: { ...after, tag: t } });
    await bodied("parent.create", "parent", PERSON, tag("made-for-rivera", { name: "Ana", email: "ana@example.com", familyId: rivera }));
    await bodied("parent.access.granted", "guardian", ROW_A, tag("granted-rivera", { parentId: PERSON, familyId: rivera, familyQboId: "10", status: "invited", addedBy: "staff" }));
    await bodied("parent.access.ended", "guardian", ROW_A, tag("ended-rivera", { parentId: PERSON, familyId: rivera, familyQboId: "10", reason: "removed" }));
    await bodied("parent.access.ended", "guardian", ROW_B, tag("old-ended-rivera", { parentId: PERSON, familyQboId: "10", reason: "not_in_quickbooks" }));
    await bodied("parent.access.granted", "guardian", ROW_B, tag("granted-chen", { parentId: PERSON, familyId: chen, familyQboId: "20", status: "invited" }));
    // A person made with no family named in its body, and a block, are nobody's family's rows.
    await bodied("parent.create", "parent", PERSON, tag("made-for-nobody", { name: "Ana", email: "ana@example.com" }));
    await bodied("parent.block", "parent", PERSON, tag("blocked", { blocked: true, familyId: rivera }));
    const tagged = async (record: string) => (await auditPage(parseAuditFilters({ record }))).rows
      .map((r) => (r.after as { tag?: string } | null)?.tag).filter((t): t is string => t !== undefined).sort();
    const rivers = ["made-for-rivera", "granted-rivera", "ended-rivera", "old-ended-rivera"].sort();
    expect(await tagged(`family:${rivera}`)).toEqual(rivers);
    expect(await tagged(rivera)).toEqual(rivers);
    expect(await tagged(`family:${chen}`)).toEqual(["granted-chen"]);
    expect(await tagged(`student:${leo}`)).toEqual([]);
  });

  it("finds a student's move under the student and under both families, the rows written before the move was saved in the portal first and those since", async () => {
    // Since slice 9f: the portal's save and its follow-ups target the student record and name both families in their
    // body; the send to QuickBooks targets the student's customer, naming where the cache and QuickBooks' answer had them.
    // Before: the follow-ups targeted the customer and named the families' customers.
    const tag = (t: string, body: { before?: Record<string, unknown>; after: Record<string, unknown> }) => ({ ...body, after: { ...body.after, tag: t } });
    await bodied("roster.record.moved", "student", leo, tag("saved", { before: { familyId: rivera }, after: { kind: "student", studentId: leo, familyId: chen, fromFamilyId: rivera, quickbooks: "sending" } }));
    await bodied("roster.student.move.followed", "student", leo, tag("followed", { after: { studentId: leo, fromFamilyId: rivera, toFamilyId: chen, cause: `roster.record.moved#${leo}` } }));
    await bodied("roster.student.move", "qbo_customer", "12", tag("sent", { before: { name: "Leo Rivera", familyQboId: "10" }, after: { role: "student", familyQboId: "20" } }));
    await bodied("roster.student.move.followed", "qbo_customer", "12", tag("old-followed", { after: { fromFamilyQboId: "10", toFamilyQboId: "20", cause: "roster.refresh#7" } }));
    // Kai moved out of the Chen family to a family neither search is about: Chen's, and never Rivera's.
    const OTHER = "7d1f0b2a-6666-4c3d-8e9f-000000000001";
    await bodied("roster.record.moved", "student", kai, tag("kai-left-chen", { before: { familyId: chen }, after: { kind: "student", studentId: kai, familyId: OTHER, fromFamilyId: chen, quickbooks: "not_sent" } }));
    const tagged = async (record: string) => (await auditPage(parseAuditFilters({ record }))).rows
      .map((r) => (r.after as { tag?: string } | null)?.tag).filter((t): t is string => t !== undefined).sort();
    const leos = ["saved", "followed", "sent", "old-followed"].sort();
    expect(await tagged(`family:${rivera}`)).toEqual(leos);
    expect(await tagged(rivera)).toEqual(leos);
    expect(await tagged(`family:${chen}`)).toEqual([...leos, "kai-left-chen"].sort());
    expect(await tagged(`student:${leo}`)).toEqual(leos);
    expect(await tagged(`student:${kai}`)).toEqual(["kai-left-chen"]);
  });

  it("finds a move taken from the books on the accounting links screen under the student and under both families, and a take of another field by its target alone", async () => {
    // Stage 4's slice M4a: a take's move names both families in its body, as the portal's own move's row does.
    const take = (t: string, targetType: string, targetId: string, before: Record<string, unknown>, after: Record<string, unknown>) =>
      bodied("accounting.difference.take", targetType, targetId, { before, after: { ...after, tag: t } });
    await take("moved", "student", leo, { familyId: rivera }, { field: "place", kind: "student", studentId: leo, familyId: chen, fromFamilyId: rivera, customerQboId: "12", familyQboId: "20", replaced: [] });
    await bodied("roster.student.move.followed", "student", leo, { after: { studentId: leo, fromFamilyId: rivera, toFamilyId: chen, cause: `accounting.difference.take#${leo}`, tag: "followed" } });
    // Kai made inactive from the books: his row names the Chen family in its body, and is his alone.
    await take("kai-inactive", "student", kai, { active: true }, { field: "inactive", kind: "student", studentId: kai, familyId: chen, customerQboId: "22", replaced: [], active: false });
    await take("rivera-named", "family", rivera, { name: "Riveras" }, { field: "name", kind: "family", familyId: rivera, customerQboId: "10", name: "Rivera Family", replaced: [] });
    const tagged = async (record: string) => (await auditPage(parseAuditFilters({ record }))).rows
      .map((r) => (r.after as { tag?: string } | null)?.tag).filter((t): t is string => t !== undefined).sort();
    expect(await tagged(`family:${rivera}`)).toEqual(["followed", "moved", "rivera-named"]);
    expect(await tagged(`family:${chen}`)).toEqual(["followed", "moved"]);
    expect(await tagged(`student:${leo}`)).toEqual(["followed", "moved"]);
    expect(await tagged(`student:${kai}`)).toEqual(["kai-inactive"]);
  });

  it("finds a confirm on the accounting links screen under its family and under each student it linked, and never under another student", async () => {
    // Stage 4's slice M3a: the row targets the family and names the students it linked only in its body.
    const confirm = (t: string, familyId: string, studentId: string, customerQboId: string) => bodied("accounting.link.confirm", "family", familyId,
      { after: { familyId, customerQboId: "10", realmId: "4620000000000001", chosen: "suggested", studentsLinked: [{ studentId, customerQboId }], studentsLeft: [], studentCustomersLeft: [], tag: t } });
    await confirm("rivera-confirm", rivera, leo, "12");
    await confirm("chen-confirm", chen, kai, "22");
    // A confirm that linked no student, and one naming Leo only among the students it left: neither is Leo's.
    await bodied("accounting.link.confirm", "family", chen, { after: { familyId: chen, studentsLinked: [], studentsLeft: [leo], tag: "chen-left-leo" } });
    const tagged = async (record: string) => (await auditPage(parseAuditFilters({ record }))).rows
      .map((r) => (r.after as { tag?: string } | null)?.tag).filter((t): t is string => t !== undefined).sort();
    expect(await tagged(`student:${leo}`)).toEqual(["rivera-confirm"]);
    expect(await tagged(leo)).toEqual(["rivera-confirm"]);
    expect(await tagged(`student:${kai}`)).toEqual(["chen-confirm"]);
    expect(await tagged(`family:${rivera}`)).toEqual(["rivera-confirm"]);
    expect(await tagged(`family:${chen}`)).toEqual(["chen-confirm", "chen-left-leo"]);
    // A family search by a student's id finds nothing of the student's confirm.
    expect(await tagged(`family:${leo}`)).toEqual([]);
  });

  it("finds a family's roster page reads written while the page was addressed by its customer, and those written since, by its record", async () => {
    // Before stage 3's third slice: the roster page read under the customer. Since: under the app's own family.
    await row("roster.family.read", "qbo_customer", "10");
    await row("roster.family.read", "family", rivera);
    await row("roster.family.read", "family", chen);
    const reads = async (record: string) => (await auditPage(parseAuditFilters({ record }))).rows
      .filter((r) => r.action === "roster.family.read").map((r) => `${r.targetType}:${r.targetId}`).sort();
    expect(await reads(`family:${rivera}`)).toEqual([`family:${rivera}`, "qbo_customer:10"].sort());
    expect(await reads(rivera)).toEqual([`family:${rivera}`, "qbo_customer:10"].sort());
    expect(await reads(`family:${chen}`)).toEqual([`family:${chen}`]);
  });

  it("finds a student's ticks and moved places under the old key and the new, and never another's whose id ends the same", async () => {
    expect(await targets(`student:${leo}`)).toEqual([`requirement_progress:${REQ}:12`, `requirement_progress:${REQ}:${leo}`, "student:12", `student:${leo}`,
      `signature_request:${FORM_OLD}`, `signature_request:${FORM_NEW}`, `signature_request:${FORM_MOVED}`].sort());
    expect(await targets(`student:${kai}`)).toEqual([`requirement_progress:${REQ}:22`, `requirement_progress:${REQ}:${kai}`].sort());
  });

  it("matches a customer's number only under a target that names a customer of the record's kind", async () => {
    for (const record of [`family:${rivera}`, rivera, `student:${leo}`, leo]) {
      const found = await targets(record);
      for (const other of ["job_run:10", "qbo_item:12", "qbo_check_run:10"]) expect(found, record).not.toContain(other);
    }
    // A family's customer is not looked for among students' rows, nor a student's among families'.
    expect(await targets(`family:${rivera}`)).not.toContain("student:12");
    expect(await targets(`student:${leo}`)).not.toContain("family:10");
  });

  it("matches any other record exactly, as before", async () => {
    expect(await targets("qbo_customer:10")).toEqual(["qbo_customer:10"]);
    // A family's id under the wrong kind is no family: only an exact match, and there is none.
    expect(await targets(`student:${rivera}`)).toEqual([]);
    expect((await db.select().from(auditLog)).length).toBe(22);
    // A request's id is an exact match too, as before.
    expect(await targets(`signature_request:${FORM_MOVED}`)).toEqual([`signature_request:${FORM_MOVED}`]);
  });
});

/**
 * Buy-outs, which moved after forms: a buy-out's rows name its family and student in their body, by customer before
 * (the choice its subject's, the daily check's flag and the close the family's, a move's flag both families') and by
 * record since; a family's buy-outs page was read by its customer, and is read by its record now. An old choice names
 * its subject's customer, which is a family's only for a per-family requirement: a customer with a record of each kind
 * (the Chen family's customer once named as a student, Kai's once as a family) is found by the kind its requirement
 * asks of, never by the other.
 */
describe("the audit page's filter for a family's or student's buy-out rows", () => {
  let rivera = "", chen = "", leo = "", kai = "", chenAsStudent = "", kaiAsFamily = "";
  const [BOTH_STUDENT_OLD, BOTH_FAMILY_OLD] = [1, 2].map((n) => `7d1f0b2a-6666-4c3d-8e9f-00000000000${n}`) as [string, string];
  const [CHOSEN_OLD, CHOSEN_STUDENT_OLD, FLAGGED_OLD, MOVED_OLD, CLOSED_OLD] = [1, 2, 3, 4, 5].map((n) => `7d1f0b2a-4444-4c3d-8e9f-00000000000${n}`) as [string, string, string, string, string];
  const [CHOSEN_NEW, CHOSEN_STUDENT_NEW, MOVED_NEW, CLOSED_NEW, CHEN_NEW] = [1, 2, 3, 4, 5].map((n) => `7d1f0b2a-5555-4c3d-8e9f-00000000000${n}`) as [string, string, string, string, string];
  beforeEach(async () => {
    await resetDb();
    await db.transaction((tx) => setRosterSource(tx, "4620000000000001"));
    await seedShape();
    await seedCache([fam("10", "Rivera Family"), stu("12", "Leo Rivera", "10"), fam("20", "Chen Family"), stu("22", "Kai Chen", "20")]);
    [rivera, chen, leo, kai] = [String(await recordOfCustomer("10", "family")), String(await recordOfCustomer("20", "family")),
      String(await recordOfCustomer("12", "student")), String(await recordOfCustomer("22", "student"))];
    // A record of the other kind for each Chen customer, as 0023 made for a customer once named as that kind.
    [chenAsStudent, kaiAsFamily] = [String(await recordOfCustomer("20", "student")), String(await recordOfCustomer("22", "family"))];
    const { requirementIds: req } = await seedSeason({ name: "Fall", steps: [{ name: "Volunteer", requirements: [
      { title: "Family hours", appliesTo: "family" }, { title: "Student hours", appliesTo: "student" }] }] });
    const [perFamily, perStudent] = [req["Family hours"]!, req["Student hours"]!];
    // Before buy-outs moved: by the customers.
    await bodied("volunteer.buyout.chosen", "buyout", CHOSEN_OLD, { after: { state: "being_invoiced", requirementId: perFamily, subjectQboId: "10", customerQboId: "10" } });
    await bodied("volunteer.buyout.chosen", "buyout", CHOSEN_STUDENT_OLD, { after: { state: "being_invoiced", requirementId: perStudent, subjectQboId: "12", customerQboId: "12" } });
    // The Chen family's customer named as a student, and Kai's as a family.
    await bodied("volunteer.buyout.chosen", "buyout", BOTH_STUDENT_OLD, { after: { state: "being_invoiced", requirementId: perStudent, subjectQboId: "20", customerQboId: "20" } });
    await bodied("volunteer.buyout.chosen", "buyout", BOTH_FAMILY_OLD, { after: { state: "being_invoiced", requirementId: perFamily, subjectQboId: "22", customerQboId: "22" } });
    await bodied("volunteer.buyout.flagged", "buyout", FLAGGED_OLD, { after: { flag: "missing", familyQboId: "10" } });
    await bodied("volunteer.buyout.flagged", "buyout", MOVED_OLD, { after: { flag: "student_moved", fromFamilyQboId: "10", toFamilyQboId: "20" } });
    await bodied("volunteer.buyout.closed", "buyout", CLOSED_OLD, { before: { state: "refused", familyQboId: "10" } });
    await row("volunteer.buyout.family.read", "qbo_customer", "10");
    // Since: by the records.
    await bodied("volunteer.buyout.chosen", "buyout", CHOSEN_NEW, { after: { state: "being_invoiced", familyId: rivera, studentId: null, customerQboId: "10" } });
    await bodied("volunteer.buyout.chosen", "buyout", CHOSEN_STUDENT_NEW, { after: { state: "being_invoiced", familyId: rivera, studentId: leo, customerQboId: "12" } });
    await bodied("volunteer.buyout.flagged", "buyout", MOVED_NEW, { after: { flag: "student_moved", familyId: rivera, studentId: leo, toFamilyId: chen } });
    await bodied("volunteer.buyout.closed", "buyout", CLOSED_NEW, { before: { state: "refused", familyId: rivera, studentId: null } });
    await bodied("volunteer.buyout.chosen", "buyout", CHEN_NEW, { after: { state: "being_invoiced", familyId: chen, studentId: kai, customerQboId: "22" } });
    await row("volunteer.buyout.family.read", "family", rivera);
    // Rows of other kinds whose ids are the same numbers: never the family's or the student's.
    await row("roster.refresh", "job_run", "10");
  });

  it("finds a family's buy-out rows by its customer before and its record since, and nothing of another family's", async () => {
    const rivers = [CHOSEN_OLD, CHOSEN_STUDENT_OLD, FLAGGED_OLD, MOVED_OLD, CLOSED_OLD].filter((id) => id !== CHOSEN_STUDENT_OLD)
      .concat([CHOSEN_NEW, CHOSEN_STUDENT_NEW, MOVED_NEW, CLOSED_NEW]).map((id) => `buyout:${id}`).concat([`family:${rivera}`, "qbo_customer:10"]).sort();
    expect(await targets(`family:${rivera}`)).toEqual(rivers);
    expect(await targets(rivera)).toEqual(rivers);
    // The Chen family: its own choice, and the moves that named it as the family the student went to.
    expect(await targets(`family:${chen}`)).toEqual([`buyout:${MOVED_OLD}`, `buyout:${MOVED_NEW}`, `buyout:${CHEN_NEW}`].sort());
  });

  it("finds a student's buy-out rows by the student's customer before and record since, and never a family's alone", async () => {
    expect(await targets(`student:${leo}`)).toEqual([`buyout:${CHOSEN_STUDENT_OLD}`, `buyout:${CHOSEN_STUDENT_NEW}`, `buyout:${MOVED_NEW}`].sort());
    expect(await targets(`student:${kai}`)).toEqual([`buyout:${CHEN_NEW}`]);
    expect(await targets("buyout:" + CLOSED_NEW)).toEqual([`buyout:${CLOSED_NEW}`]);
  });

  it("finds an old choice naming a customer with a record of each kind by the kind its requirement asks of, never the other", async () => {
    // The Chen family's customer, chosen for as a student: its student record's row, never the Chen family's.
    expect(await targets(`student:${chenAsStudent}`)).toEqual([`buyout:${BOTH_STUDENT_OLD}`]);
    expect(await targets(`family:${chen}`)).not.toContain(`buyout:${BOTH_STUDENT_OLD}`);
    // Kai's customer, chosen for as a family: its family record's row, never Kai's.
    expect(await targets(`family:${kaiAsFamily}`)).toEqual([`buyout:${BOTH_FAMILY_OLD}`]);
    expect(await targets(`student:${kai}`)).not.toContain(`buyout:${BOTH_FAMILY_OLD}`);
  });
});

/**
 * Stage 4's slice M3b: an unlink moves a family's links to accounting_link_ended, and the filter bounds each customer by
 * when it was the record's: a row naming the customer written while the family was linked to it is the family's; one
 * written after the family's unlink, once another family is linked to the customer, is that other family's alone; and
 * one written before that other family's link is never the other family's.
 */
describe("the audit page's filter for a customer a family was linked to and another is linked to now", () => {
  const REALM = "4620000000000001";
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  let rivera = "", chen = "", leo = "";
  /** A row, written as of `at`. */
  const rowAt = async (at: Date, action: string, targetType: string, targetId: string, body: { before?: Record<string, unknown>; after?: Record<string, unknown> } = {}) => {
    await writeAudit({ actor, action, targetType, targetId, ...body });
    const [last] = await db.select({ id: auditLog.id }).from(auditLog).orderBy(desc(auditLog.id)).limit(1);
    await db.update(auditLog).set({ at }).where(eq(auditLog.id, last!.id));
  };
  /** A family's links (and its students'), ended as of `at`, as an unlink ends them. */
  const endLinksOf = async (familyId: string, at: Date) => {
    const studentIds = (await db.select({ id: student.id }).from(student).where(eq(student.familyId, asAppFamilyId(familyId)))).map((s) => s.id);
    const links = await db.select().from(accountingLink).where(or(eq(accountingLink.familyId, asAppFamilyId(familyId)), studentIds.length ? inArray(accountingLink.studentId, studentIds) : undefined));
    await db.insert(accountingLinkEnded).values(links.map((l) => ({ id: l.id, system: l.system, realmId: l.realmId, customerId: l.customerId, familyId: l.familyId, studentId: l.studentId,
      guardianId: l.guardianId, origin: l.origin, linkedAt: l.linkedAt, linkedBy: l.linkedBy, endedAt: at, endedBy: null, endedHow: "unlinked" as const })));
    await db.delete(accountingLink).where(inArray(accountingLink.id, links.map((l) => l.id)));
  };
  const tagged = async (record: string) => (await auditPage(parseAuditFilters({ record }))).rows
    .map((r) => (r.after as { tag?: string } | null)?.tag).filter((t): t is string => t !== undefined).sort();

  beforeEach(async () => {
    await resetDb();
    await db.transaction((tx) => setRosterSource(tx, REALM));
    await seedShape();
    await seedCache([fam("10", "Rivera Family"), stu("12", "Leo Rivera", "10"), fam("20", "Chen Family")]);
    [rivera, chen, leo] = [String(await recordOfCustomer("10", "family")), String(await recordOfCustomer("20", "family")), String(await recordOfCustomer("12", "student"))];
    // Rivera's links were made long ago (carried over by the import): set them back so every row below falls after them.
    await db.update(accountingLink).set({ linkedAt: ago(600) });
    await rowAt(ago(180), "season.progress.family.read", "qbo_customer", "10", { after: { tag: "x-while-rivera" } });
    await rowAt(ago(170), "money.balance_mismatch", "family", "10", { after: { tag: "x-old-money-while-rivera" } });
    // Rivera unlinked from 10 (with Leo's link), and Chen from 20, two hours ago.
    await endLinksOf(rivera, ago(120));
    await rowAt(ago(120), "accounting.link.remove", "family", rivera, { after: { familyId: rivera, customerQboId: "10", studentLinksEnded: [{ studentId: leo, customerQboId: "12" }], tag: "rivera-unlinked" } });
    await endLinksOf(chen, ago(115));
    await rowAt(ago(100), "season.progress.family.read", "qbo_customer", "10", { after: { tag: "x-between" } });
    // Chen linked to 10 an hour ago.
    await db.insert(accountingLink).values({ system: "quickbooks", realmId: REALM, customerId: "10", familyId: asAppFamilyId(chen), origin: "confirmed", linkedBy: "00000000-0000-4000-8000-0000000000aa", linkedAt: ago(60) });
    await rowAt(ago(30), "season.progress.family.read", "qbo_customer", "10", { after: { tag: "x-while-chen" } });
  });

  it("finds a row naming the customer under the family it was linked to when the row was written, and never the other", async () => {
    expect(await tagged(`family:${rivera}`)).toEqual(["rivera-unlinked", "x-old-money-while-rivera", "x-while-rivera"]);
    // Chen's window for 10 opens at Rivera's unlink (the latest of another family's, before Chen's link was made): no row
    // of Rivera's time is Chen's; one written since, before or after Chen's link, is.
    expect(await tagged(`family:${chen}`)).toEqual(["x-between", "x-while-chen"]);
    expect(await tagged(rivera)).toEqual(["rivera-unlinked", "x-old-money-while-rivera", "x-while-rivera"]);
  });

  it("finds an unlink under the family and under each student whose link it ended", async () => {
    expect(await tagged(`student:${leo}`)).toEqual(["rivera-unlinked"]);
    expect(await tagged(leo)).toEqual(["rivera-unlinked"]);
  });

  it("never bounds a student's window by a guardian row's ended link to the same customer", async () => {
    // A guardian row of the Chens whose own link to 12 ended before Leo's did: a guardian row is neither kind, so Leo's
    // window for 12 still has no lower bound, and a row naming 12 from before it is still Leo's.
    const kit = await seedParent({ name: "Kit Chen", email: "kit@example.com" });
    const [row] = await db.insert(guardian).values({ parentId: kit.id, familyId: asAppFamilyId(chen), status: "invited" }).returning();
    await db.insert(accountingLinkEnded).values({ id: "00000000-0000-4000-8000-0000000000c1", system: "quickbooks", realmId: REALM, customerId: "12", guardianId: row!.id,
      origin: "carried_over", linkedAt: ago(500), linkedBy: null, endedAt: ago(150), endedBy: "00000000-0000-4000-8000-0000000000aa", endedHow: "unlinked" });
    await rowAt(ago(200), "season.progress.family.read", "qbo_customer", "12", { after: { tag: "leo-old" } });
    expect(await tagged(`student:${leo}`)).toEqual(["leo-old", "rivera-unlinked"]);
  });
});
