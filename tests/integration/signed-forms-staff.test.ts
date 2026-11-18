import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { asParent, asStaff, pageOutcome, renderPage, signedOut } from "../helpers/signed-in";

type Msg = { to: string; subject: string; text: string; html: string };
const mail = vi.hoisted(() => ({ outbox: [] as Msg[] }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { mail.outbox.push(m); } }));

import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import {
  auditLog, formReminderClaim, formReminderRound, formWithdrawal, parent, qboCustomer, requirement, requirementProgress, role, roleAssignment, roleRule, season, setting, signatureConsent, signatureRequest,
  signedFormEvidence, signedFormFile,
} from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import { GRANTABLE } from "@/lib/permissions/registry";
import SignedFormsPage from "@/app/staff/(app)/forms/page";
import EvidencePage from "@/app/staff/(app)/forms/evidence/[id]/page";
import FormRequestPage from "@/app/staff/(app)/forms/requests/[id]/page";
import FormsPage from "@/app/(parent)/forms/page";
import FormPage from "@/app/(parent)/forms/[id]/page";
import { GET as parentDownload } from "@/app/(parent)/forms/[id]/signed/route";
import { remindFamilyAction, remindFormAction, remindRequestAction, saveScheduleAction, startAgainAction } from "@/app/staff/(app)/forms/actions";
import { GET as staffDownload } from "@/app/staff/(app)/forms/evidence/[id]/[file]/route";
import { findMySignedPdf, mySignedDownloads } from "@/lib/forms/my-evidence";
import { formsForMovedStudent } from "@/lib/forms/moved";
import { clearRosterOfOtherCompany } from "@/lib/roster/source";
import { runEvidenceJob } from "@/lib/signed-forms/evidence-job";
import { runScheduledReminders } from "@/lib/signed-forms/reminders";
import { resetDb, seedStaff, seedWorkingMail } from "../helpers/db";
import { startDocumensoStub, type DocumensoStub } from "../helpers/documenso-stub";
import { connectForms, formSetting, requestNow, seedConsent, seedFormRequirement, signedInStub } from "../helpers/forms";
import { FAMILY_A, FAMILY_B, seedParentIn, seedTwoFamilies, type SeededParent } from "../helpers/parent";
import { addToCache, fam, moveInCache, par, seedParentSettings, stu } from "../helpers/roster-cache";
import { subjectColumns } from "../helpers/app-records";

/**
 * Signed forms for staff (v1 spec §9.3): the matrix, one request and one signed form's evidence (each audited when
 * opened), reminders (never another family's guardian, never a blocked one, once a day per form), the schedule, start
 * again, the moved-student rule, and a change of QuickBooks company that keeps every signed form's evidence.
 */
vi.setConfig({ testTimeout: 30_000 });
type Staff = Awaited<ReturnType<typeof seedStaff>>;
const NOBODY = "5b0e7f0a-3c1d-4a52-9f0e-3a1b2c3d4e5f";
const NOBODY_OWED = "Nobody needs a reminder: everyone has signed, the form was waived, or it isn't ready to sign yet.";
/**
 * A form with no template ("Medical release QC31", per family) asked of family A and of a third family, the
 * Cobblestones, whose every other form is waived or not theirs: their only outstanding form can't be signed yet.
 */
const COBBLE = "COBBLE-1";
async function seedNotReadyForm(): Promise<string> {
  await addToCache([fam(COBBLE, "Cobblestone Family")]);
  const travel = await requirementIdOf("Travel consent");
  await db.insert(requirementProgress).values({ requirementId: travel, ...(await subjectColumns(COBBLE, "family")), waivedAt: new Date(), waivedReason: "Staff-only reason QC31" });
  const [{ stepId }] = await db.select({ stepId: requirement.stepId }).from(requirement).where(eq(requirement.id, travel)) as [{ stepId: string }];
  return seedFormRequirement({ stepId, title: "Medical release QC31", appliesTo: "family", form: null, chosen: [FAMILY_A.family.qboId, COBBLE] });
}
const SYSTEM = { actor: { door: "system" as const, id: null, label: "test" }, ip: null };
const withRole = async (email: string, patterns: string[]): Promise<Staff> => {
  const s = await seedStaff({ email, name: email });
  const [r] = await db.insert(role).values({ key: email, name: email }).returning();
  await db.insert(roleRule).values(patterns.map((pattern) => ({ roleId: r!.id, kind: "include" as const, pattern })));
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: s.id });
  return s;
};
const audits = async (action?: string) => (await db.select().from(auditLog).orderBy(asc(auditLog.id))).filter((r) => !action || r.action === action);
const textOf = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", '"');
const requirementIdOf = async (title: string) => (await db.select({ id: requirement.id }).from(requirement).where(eq(requirement.title, title)))[0]!.id;

let stub: DocumensoStub;
beforeAll(async () => { stub = await startDocumensoStub(); });
afterAll(async () => { await stub.close(); });

let a: SeededParent, b: SeededParent, writer: Staff, reader: Staff, outsider: Staff;
beforeEach(async () => {
  await resetDb(); stub.reset(); mail.outbox.length = 0;
  ({ a, b } = await seedTwoFamilies());
  writer = await withRole("writer@club.org", ["Forms.Signature.ReadWrite"]);
  reader = await withRole("reader@club.org", ["Forms.Signature.Read"]);
  outsider = await withRole("outsider@club.org", ["Roster.*", "Season.*", "Volunteer.*"]);
});

describe("the permissions", () => {
  it("are ordinary ones a custom role can hold, by their exact names", () => {
    expect(GRANTABLE).toContain("Forms.Signature.Read");
    expect(GRANTABLE).toContain("Forms.Signature.ReadWrite");
  });

  it("guard every page and action: staff without them are refused, and so is a parent's session", async () => {
    const pages = [
      () => pageOutcome(SignedFormsPage, { searchParams: {} }),
      () => pageOutcome(EvidencePage, { params: { id: a.forms!.evidence.id } }),
      () => pageOutcome(FormRequestPage, { params: { id: a.forms!.ids.waiting } }),
    ];
    const actions = [
      () => remindFormAction(NOBODY), () => remindFamilyAction(FAMILY_A.family.qboId), () => remindRequestAction(a.forms!.ids.waiting),
      () => saveScheduleAction(NOBODY, [7], false), () => startAgainAction(a.forms!.ids.declined, "declined", ""),
    ];
    asStaff(outsider);
    for (const p of pages) expect(await p()).toEqual({ redirect: "/refused" });
    for (const act of actions) await expect(act()).rejects.toBeInstanceOf(AccessDenied);
    // Read alone opens the pages but does none of the writes.
    asStaff(reader);
    for (const act of actions) await expect(act()).rejects.toBeInstanceOf(AccessDenied);
    signedOut();
    asParent(a.identity);
    for (const p of pages) expect(await p()).toEqual({ redirect: "/staff/sign-in" });
    for (const act of actions) await expect(act()).rejects.toBeInstanceOf(AccessDenied);
    expect(mail.outbox).toEqual([]);
    expect(await audits("forms.reminder.sent")).toEqual([]);
    expect((await requestNow(a.forms!.ids.declined)).state).toBe("declined");
  });
});

describe("the matrix", () => {
  it("lists the season's students by family and its forms across, each cell in words, and is not audited", async () => {
    asStaff(reader);
    const html = await renderPage(SignedFormsPage, { searchParams: {} });
    const text = textOf(html);
    for (const words of [FAMILY_A.family.name, FAMILY_B.family.name, ...FAMILY_A.students.map((s) => s.name), ...FAMILY_B.students.map((s) => s.name),
      "Travel consent", "Uniform agreement", "Photo release", "Bus waiver QA74", "Field trip waiver QB85",
      "Not opened yet", "Waiting for a guardian", "Waiting for the other guardian", "Signed, being sealed", "Signed", "Declined"]) expect(text).toContain(words);
    // Each family's signed form leads to its evidence; the others to their request.
    expect(html).toContain(`/staff/forms/evidence/${a.forms!.evidence.id}`);
    expect(html).toContain(`/staff/forms/evidence/${b.forms!.evidence.id}`);
    expect(html).toContain(`/staff/forms/requests/${a.forms!.ids.waiting}`);
    expect(text).toContain("2 of 4 signed"); // the uniform agreement: one student of each family has signed
    expect(await audits()).toEqual([]);
    // Without ReadWrite there is no Remind now and no schedule.
    expect(text).not.toContain("Remind now");
    asStaff(writer);
    expect(textOf(await renderPage(SignedFormsPage, { searchParams: {} }))).toContain("Remind now");
  });

  it("filters by one form, one state, and a family or student name, and shows a waiver as Waived", async () => {
    asStaff(reader);
    const travel = await requirementIdOf("Travel consent");
    await db.insert(requirementProgress).values({ requirementId: travel, ...(await subjectColumns(FAMILY_B.family.qboId, "family")), waivedAt: new Date(), waivedReason: "Staff-only reason QZ19" });
    const oneHtml = await renderPage(SignedFormsPage, { searchParams: { form: travel } });
    const one = textOf(oneHtml);
    expect(textOf(/<table[^>]*class="table matrix"[^>]*>[\s\S]*?(<thead[\s\S]*?<\/thead>)/.exec(oneHtml)![1]!).trim()).toBe("Family and students Travel consent");
    expect(one).toContain("Waived");
    expect(one).not.toContain("Staff-only reason QZ19");
    const signed = await renderPage(SignedFormsPage, { searchParams: { state: "signed" } });
    expect(textOf(signed)).toContain(FAMILY_A.students[1]!.name);
    expect(textOf(signed).split("Who has signed")[1]).not.toContain(FAMILY_A.students[0]!.name);
    const searched = textOf(await renderPage(SignedFormsPage, { searchParams: { q: "brackenMOOR" } }));
    expect(searched.split("Who has signed")[1]).not.toContain(FAMILY_A.family.name);
    expect(searched).toContain(FAMILY_B.students[0]!.name);
    const student = textOf(await renderPage(SignedFormsPage, { searchParams: { q: FAMILY_A.students[1]!.name } }));
    expect(student.split("Who has signed")[1]).not.toContain(FAMILY_A.students[0]!.name);
    expect(student).toContain(FAMILY_A.family.name);
    // Anything it doesn't know in the address is dropped, not guessed at.
    expect(await pageOutcome(SignedFormsPage, { searchParams: { form: "x'; drop", state: "nope", q: ["a", "b"] } })).toHaveProperty("html");
  });
});

describe("a form with no template in the matrix", () => {
  it("reads Not ready yet, has its own filter, and offers no Remind for a family whose only outstanding forms have none", async () => {
    await seedNotReadyForm();
    asStaff(writer);
    const html = await renderPage(SignedFormsPage, { searchParams: {} });
    const text = textOf(html);
    expect(text).toContain("Medical release QC31 No template attached yet");
    expect(text).toContain("Cobblestone Family");
    expect(html).toContain('<option value="not_ready">Not ready yet</option>');
    // Not "Not opened yet": nothing can be opened. Family A still has forms a reminder can help with; the Cobblestones don't.
    const ready = textOf(await renderPage(SignedFormsPage, { searchParams: { state: "not_ready" } })).split("Who has signed").at(-1)!; // the matrix, after the lede's words
    expect(ready).toContain("Not ready yet");
    expect(ready).toContain(FAMILY_A.family.name);
    expect(ready).toContain("Cobblestone Family");
    expect(ready).not.toContain(FAMILY_B.family.name);
    const opened = textOf(await renderPage(SignedFormsPage, { searchParams: { state: "not_opened" } })).split("Who has signed").at(-1)!; // the matrix, after the lede's words
    expect(opened).not.toContain("Cobblestone Family");
    expect(text).toContain(`Remind ${FAMILY_A.family.name}`);
    expect(text).toContain(`Remind ${FAMILY_B.family.name}`);
    expect(text).not.toContain("Remind Cobblestone Family");
  });
});

describe("kept signed forms the matrix doesn't lead to", () => {
  it("are listed apart once their season isn't current, or their student has left the roster, and lead to their evidence", async () => {
    asStaff(reader);
    const othersOf = (html: string) => html.split("Other kept signed forms")[1]!.split("Earlier company")[0]!;
    // While the season is current, both families' signed forms are in the table, and nothing is listed apart.
    expect(othersOf(await renderPage(SignedFormsPage, { searchParams: {} }))).not.toContain("/staff/forms/evidence/");
    // A's student leaves the roster: A's signed form is listed apart, B's stays in the table.
    await db.update(qboCustomer).set({ active: false }).where(eq(qboCustomer.qboId, FAMILY_A.students[1]!.qboId));
    let others = othersOf(await renderPage(SignedFormsPage, { searchParams: {} }));
    expect(others).toContain(`/staff/forms/evidence/${a.forms!.evidence.id}`);
    expect(others).not.toContain(`/staff/forms/evidence/${b.forms!.evidence.id}`);
    // A new season is made current: both are listed apart, and a search narrows them by the names kept with them.
    await db.update(season).set({ isCurrent: false });
    await db.insert(season).values({ name: "Spring 2027", isCurrent: true });
    others = othersOf(await renderPage(SignedFormsPage, { searchParams: {} }));
    expect(others).toContain(`/staff/forms/evidence/${a.forms!.evidence.id}`);
    expect(others).toContain(`/staff/forms/evidence/${b.forms!.evidence.id}`);
    others = othersOf(await renderPage(SignedFormsPage, { searchParams: { q: FAMILY_B.family.name } }));
    expect(others).not.toContain(`/staff/forms/evidence/${a.forms!.evidence.id}`);
    expect(others).toContain(`/staff/forms/evidence/${b.forms!.evidence.id}`);
    expect(await audits()).toEqual([]);
  });
});

describe("one request and one signed form", () => {
  it("audits the read of one request before it is shown", async () => {
    asStaff(reader);
    const text = textOf(await renderPage(FormRequestPage, { params: { id: a.forms!.ids.waitingOther } }));
    expect(text).toContain("Waiting for the other guardian");
    expect(text).toContain("Ottoline Alderquist-Voss");
    expect(text).not.toContain("Start again");
    expect((await audits("forms.request.read"))[0]).toMatchObject({ actorId: reader.id, targetId: a.forms!.ids.waitingOther, permission: "Forms.Signature.Read" });
    for (const id of [NOBODY, "not-a-uuid"]) expect(await pageOutcome(FormRequestPage, { params: { id } })).toEqual({ notFound: true });
  });

  it("audits the read of a signed form's evidence before it is shown, with the signers, consents, template and hashes", async () => {
    asStaff(reader);
    const text = textOf(await renderPage(EvidencePage, { params: { id: a.forms!.evidence.id } }));
    expect(text).toContain("Uniform agreement");
    expect(text).toContain(FAMILY_A.parent.name);
    expect(text).toContain(a.forms!.evidence.sealedSha256);
    expect(text).toContain("envelope_seedtemplate");
    expect(text).toContain("Consent to sign electronically");
    expect(text).not.toContain("no longer connected");
    const [read] = await audits("forms.evidence.read");
    expect(read).toMatchObject({ actorId: reader.id, targetId: a.forms!.evidence.id, permission: "Forms.Signature.Read" });
    expect(await pageOutcome(EvidencePage, { params: { id: NOBODY } })).toEqual({ notFound: true });
  });
});

describe("reminders", () => {
  beforeEach(async () => {
    await connectForms({ origin: "http://127.0.0.1:9", token: "api_never_called" }); // no reminder calls Documenso
    await seedWorkingMail();
    asStaff(writer);
  });
  const sentTo = () => mail.outbox.map((m) => m.to).sort();

  it("emails only the guardians of the family asked about, about their own forms, with a link to the portal", async () => {
    const r = await remindFamilyAction(FAMILY_A.family.qboId);
    expect(r.ok).toBe(true);
    expect(sentTo().every((to) => to === FAMILY_A.parent.email)).toBe(true);
    expect(mail.outbox.length).toBeGreaterThan(0);
    for (const m of mail.outbox) {
      for (const marker of b.markers) expect(`${m.subject} ${m.text} ${m.html}`).not.toContain(marker);
      expect(m.text).toMatch(/http:\/\/localhost:\d+\/forms/);
    }
    const travel = mail.outbox.find((m) => m.subject === "Please sign: Travel consent")!;
    expect(travel.text).toContain(`/forms/${a.forms!.ids.waiting}`);
    expect(r.ok && r.message).toMatch(/^Emailed 1 guardian, \d+ reminders in all\./);
    const rows = await audits("forms.reminder.sent");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatchObject({ actorId: writer.id, permission: "Forms.Signature.ReadWrite" });
      expect(JSON.stringify(row.after)).not.toContain("@");
    }
  });

  it("for a form, reminds each family's own guardians, never a blocked one, and each at most once a day", async () => {
    const travel = await requirementIdOf("Travel consent");
    await db.update(parent).set({ blocked: true }).where(eq(parent.id, b.identity.parentId));
    let r = await remindFormAction(travel);
    expect(sentTo()).toEqual([FAMILY_A.parent.email]);
    expect(r).toEqual({ ok: true, message: "Emailed 1 guardian." });
    // Pressed again, or for the family or the request, the same day: nothing more goes.
    r = await remindFormAction(travel);
    expect(r).toEqual({ ok: true, message: "Emailed 0 guardians. 1 reminder had already gone today, so it wasn't sent again." });
    await remindRequestAction(a.forms!.ids.waiting);
    expect(mail.outbox).toHaveLength(1);
    expect(await db.select().from(formReminderClaim)).toHaveLength(1);
    expect((await audits("forms.reminder.sent")).at(-1)!.after).toMatchObject({ kind: "now", scope: "request", emailed: 0, alreadyToday: 1 });
  });

  it("for a request whose form waits for every guardian, reminds only those who haven't signed", async () => {
    // A's parent signed the photo release for the second student; its other guardian isn't a portal person here.
    await remindRequestAction(a.forms!.ids.waitingOther);
    expect(mail.outbox).toEqual([]);
    await remindRequestAction(a.forms!.ids.declined);
    expect(sentTo()).toEqual([FAMILY_A.parent.email]);
    expect(mail.outbox[0]!.text).toContain(FAMILY_A.students[0]!.name);
  });

  it("needs parent sign-ins switched on, and says nothing is owed when nobody needs one", async () => {
    await seedParentSettings({ signin: false });
    const r = await remindFormAction(await requirementIdOf("Travel consent"));
    expect(r.ok).toBe(false);
    expect(mail.outbox).toEqual([]);
    await seedParentSettings({ signin: true });
    expect(await remindRequestAction(a.forms!.ids.complete)).toEqual({ ok: true, message: NOBODY_OWED });
  });

  it("sends nothing, now or on a schedule, for a form with no template", async () => {
    const medical = await seedNotReadyForm();
    await addToCache([par("COBBLE-P", "Cora Cobblestone", COBBLE, "cora@cobble.example")]);
    expect(await remindFamilyAction(COBBLE)).toEqual({ ok: true, message: NOBODY_OWED });
    await db.update(requirement).set({ dueOn: "2026-12-15", formReminders: { before: [7], weeklyAfter: false } }).where(eq(requirement.id, medical));
    await db.insert(setting).values({ key: "club", value: { timeZone: "America/Chicago" } }).onConflictDoUpdate({ target: setting.key, set: { value: { timeZone: "America/Chicago" } } });
    await seedParentSettings({ signin: true, welcome: true });
    expect(await runScheduledReminders(new Date("2026-12-08T15:01:00.000Z"))).toEqual({ rounds: 0, emailed: 0, failed: 0, alreadyToday: 0 }); // 7 days before, after 9 in Chicago
    expect(await db.select().from(formReminderRound)).toEqual([]);
    expect(mail.outbox).toEqual([]);
    expect(await audits("forms.reminder.sent")).toEqual([]);
  });

  it("saves a form's schedule, and sends it at the first wake on or after 9 on the club's clock, once, while sign-ins and welcome emails are on", async () => {
    const travel = await requirementIdOf("Travel consent");
    expect(await saveScheduleAction(travel, [7, 99], true)).toEqual({ ok: true, message: "Saved. Reminders will go on the days you chose." });
    expect((await db.select().from(requirement).where(eq(requirement.id, travel)))[0]!.formReminders).toEqual({ before: [7], weeklyAfter: true });
    expect((await audits("forms.reminder.schedule"))[0]!.after).toEqual({ reminders: { before: [7], weeklyAfter: true } });
    await db.update(requirement).set({ dueOn: "2026-12-15" }).where(eq(requirement.id, travel));
    await db.insert(setting).values({ key: "club", value: { timeZone: "America/Chicago" } }).onConflictDoUpdate({ target: setting.key, set: { value: { timeZone: "America/Chicago" } } });
    const before9 = new Date("2026-12-08T14:59:00.000Z"), after9 = new Date("2026-12-08T15:01:00.000Z"); // 8:59 and 9:01 in Chicago, 7 days before
    await seedParentSettings({ signin: true, welcome: false });
    expect((await runScheduledReminders(after9)).rounds).toBe(0);
    await seedParentSettings({ welcome: true });
    expect((await runScheduledReminders(before9)).rounds).toBe(0);
    expect((await runScheduledReminders(new Date("2026-12-09T15:01:00.000Z"))).rounds).toBe(0); // not a reminder day
    const done = await runScheduledReminders(after9);
    expect(done).toMatchObject({ rounds: 1, emailed: 2 });
    expect(sentTo()).toEqual([FAMILY_A.parent.email, FAMILY_B.parent.email]);
    expect(mail.outbox[0]!.text).toContain("It's due Tuesday, December 15, 2026.");
    expect((await runScheduledReminders(new Date("2026-12-08T20:00:00.000Z"))).rounds).toBe(0); // once
    expect(await db.select().from(formReminderRound)).toHaveLength(1);
    expect((await audits("forms.reminder.sent")).at(-1)!.after).toMatchObject({ kind: "scheduled", clubDate: "2026-12-08", emailed: 2 });
    // Weekly after the due date.
    expect((await runScheduledReminders(new Date("2026-12-22T15:30:00.000Z"))).rounds).toBe(1);
    // After the due date it says it was due, never that it is.
    expect(mail.outbox.at(-1)!.text).toContain("It was due Tuesday, December 15, 2026. It's not too late to sign it.");
    expect(mail.outbox.at(-1)!.text).not.toContain("It's due");
    // Taking the schedule away stops it.
    expect(await saveScheduleAction(travel, [], false)).toEqual({ ok: true, message: "Saved. No reminders will go for this form." });
    expect((await runScheduledReminders(new Date("2026-12-29T15:30:00.000Z"))).rounds).toBe(0);
  });
});

describe("starting a form again", () => {
  let requirementId: string, templateId: string, twoTemplateId: string;
  beforeEach(async () => {
    await connectForms(stub);
    asStaff(writer);
    const template = stub.addTemplate({ signers: 1 }), two = stub.addTemplate({ signers: 2 });
    templateId = template.id; twoTemplateId = two.id;
    requirementId = await seedFormRequirement({ stepId: (await db.select({ stepId: requirement.stepId }).from(requirement).where(eq(requirement.title, "Travel consent")))[0]!.stepId,
      title: "Medical release", appliesTo: "student", form: formSetting({ id: template.id }) });
  });
  const guardian = (p: SeededParent) => ({ parentId: p.identity.parentId, name: p.spec.parent.name, email: p.spec.parent.email });

  it("deletes a document nobody signed, cancels one somebody signed, and sets the request back to not opened, audited with the reason", async () => {
    const unsigned = await signedInStub(stub, { requirementId, templateId, familyQboId: FAMILY_A.family.qboId, subjectQboId: FAMILY_A.students[0]!.qboId, guardians: [guardian(a)], sign: false });
    await seedConsent(unsigned.id, guardian(a));
    expect(await startAgainAction(unsigned.id, "lost_access", "Moved away; QZ77")).toMatchObject({ ok: true });
    expect(stub.apiCalls("/envelope/delete")).toHaveLength(1);
    expect(stub.envelopes.has(unsigned.envelopeId)).toBe(false);
    expect(await requestNow(unsigned.id)).toMatchObject({ state: "not_opened", envelopeId: null, signers: [], evidenceOwed: false, preparingAt: null });
    const [row] = await audits("forms.request.restart");
    expect(row).toMatchObject({ actorId: writer.id, permission: "Forms.Signature.ReadWrite", targetId: unsigned.id });
    expect(row!.before).toMatchObject({ state: "waiting", envelopeId: unsigned.envelopeId });
    expect(row!.after).toEqual({ state: "not_opened", reason: "lost_access", note: "Moved away; QZ77", withdrawn: "delete" });

    // Half signed: one guardian of two has signed. It is cancelled, not deleted.
    const twoReq = await seedFormRequirement({ stepId: (await db.select({ stepId: requirement.stepId }).from(requirement).where(eq(requirement.id, requirementId)))[0]!.stepId,
      title: "Trip form", appliesTo: "student", form: formSetting({ id: twoTemplateId }, { signers: "every" }) });
    const half = await signedInStub(stub, { requirementId: twoReq, templateId: twoTemplateId, familyQboId: FAMILY_B.family.qboId, subjectQboId: FAMILY_B.students[0]!.qboId,
      guardians: [guardian(b), { parentId: crypto.randomUUID(), name: "Other Guardian", email: "other.b@example.com" }], sign: false });
    stub.sign(half.envelopeId, FAMILY_B.parent.email);
    await db.update(signatureRequest).set({ signers: (await requestNow(half.id)).signers.map((s, i) => (i === 0 ? { ...s, signedAt: new Date().toISOString() } : s)) }).where(eq(signatureRequest.id, half.id));
    expect(await startAgainAction(half.id, "gone", "")).toMatchObject({ ok: true });
    expect(stub.apiCalls("/envelope/cancel")).toHaveLength(1);
    expect(stub.envelopes.get(half.envelopeId)!.status).toBe("CANCELLED");
    expect((await requestNow(half.id)).state).toBe("not_opened");
    // The parent reads only that the form is ready to sign again: no reason, no note.
    asParent(a.identity);
    const page = textOf(await renderPage(FormsPage));
    expect(page).not.toContain("QZ77");
    expect(page).not.toContain("Moved away");
  });

  it("never touches a complete form, refuses an unsealed one before six hours, and changes nothing when Documenso can't withdraw it", async () => {
    stub.calls.length = 0;
    expect(await startAgainAction(a.forms!.ids.complete, "gone", "")).toEqual({ ok: false, errors: [expect.stringContaining("never started again")] });
    expect(await startAgainAction(a.forms!.ids.signed, "not_sealed", "")).toEqual({ ok: false, errors: [expect.stringContaining("six hours")] });
    expect(await startAgainAction(a.forms!.ids.not_opened, "gone", "")).toEqual({ ok: false, errors: [expect.stringContaining("nothing to start again")] });
    expect(await startAgainAction(a.forms!.ids.declined, "sideways", "")).toEqual({ ok: false, errors: ["Choose why it is being started again."] });
    expect(stub.apiCalls()).toEqual([]);
    const waiting = await signedInStub(stub, { requirementId, templateId, familyQboId: FAMILY_A.family.qboId, subjectQboId: FAMILY_A.students[1]!.qboId, guardians: [guardian(a)], sign: false });
    stub.failNext = 1;
    expect(await startAgainAction(waiting.id, "gone", "")).toMatchObject({ ok: false });
    expect((await requestNow(waiting.id)).state).toBe("waiting");
    expect(await audits("forms.request.restart")).toEqual([]);
    // A document Documenso no longer has (its seeded id answers 404): the request is started again all the same.
    expect(await startAgainAction(a.forms!.ids.declined, "declined", "")).toMatchObject({ ok: true });
    expect((await audits("forms.request.restart"))[0]!.after).toMatchObject({ withdrawn: "already_gone" });
  });

  it("reads Documenso first: a form sealed since the portal last read it is kept, never deleted, and one signed since is cancelled, not deleted", async () => {
    const sealed = await signedInStub(stub, { requirementId, templateId, familyQboId: FAMILY_A.family.qboId, subjectQboId: FAMILY_A.students[0]!.qboId, guardians: [guardian(a)], sign: false });
    stub.sign(sealed.envelopeId, FAMILY_A.parent.email);
    expect(stub.envelopes.get(sealed.envelopeId)!.status).toBe("COMPLETED");
    expect((await requestNow(sealed.id)).state).toBe("waiting");
    expect(await startAgainAction(sealed.id, "lost_access", "")).toEqual({ ok: false, errors: [expect.stringContaining("never started again")] });
    expect(stub.apiCalls("/envelope/delete")).toEqual([]);
    expect(stub.envelopes.get(sealed.envelopeId)!.deletedAt).toBeNull();
    expect(await requestNow(sealed.id)).toMatchObject({ state: "complete", evidenceOwed: true, envelopeId: sealed.envelopeId });
    expect(await audits("forms.request.restart")).toEqual([]);

    const twoReq = await seedFormRequirement({ stepId: (await db.select({ stepId: requirement.stepId }).from(requirement).where(eq(requirement.id, requirementId)))[0]!.stepId,
      title: "Trip form", appliesTo: "student", form: formSetting({ id: twoTemplateId }, { signers: "every" }) });
    const half = await signedInStub(stub, { requirementId: twoReq, templateId: twoTemplateId, familyQboId: FAMILY_A.family.qboId, subjectQboId: FAMILY_A.students[1]!.qboId,
      guardians: [guardian(a), { parentId: crypto.randomUUID(), name: "Other Guardian", email: "other.a@example.com" }], sign: false });
    stub.sign(half.envelopeId, FAMILY_A.parent.email);
    expect(await startAgainAction(half.id, "lost_access", "")).toMatchObject({ ok: true });
    expect(stub.apiCalls("/envelope/delete")).toEqual([]);
    expect(stub.envelopes.get(half.envelopeId)!.status).toBe("CANCELLED");
    expect((await audits("forms.request.restart"))[0]!.after).toMatchObject({ withdrawn: "cancel" });
  });
});

describe("a student moved to another family", () => {
  it("takes a complete form along with its evidence, and resets the others under the new family, queuing their documents to withdraw", async () => {
    await seedConsent(a.forms!.ids.signed, { parentId: a.identity.parentId, name: FAMILY_A.parent.name, email: FAMILY_A.parent.email });
    const [s1, s2] = [FAMILY_A.students[0]!, FAMILY_A.students[1]!];
    const result = await db.transaction(async (tx) => {
      const first = await formsForMovedStudent(tx, { studentQboId: s1.qboId, fromFamilyQboId: FAMILY_A.family.qboId, toFamilyQboId: FAMILY_B.family.qboId });
      const second = await formsForMovedStudent(tx, { studentQboId: s2.qboId, fromFamilyQboId: FAMILY_A.family.qboId, toFamilyQboId: FAMILY_B.family.qboId });
      return { first, second };
    });
    expect(result.first).toMatchObject({ moved: 0, reset: 2 });
    expect(result.first.toWithdraw.sort()).toEqual(["envelope_alderquistdeclined", "envelope_alderquistsigned"]);
    expect(result.second).toMatchObject({ moved: 1, reset: 1, toWithdraw: ["envelope_alderquistother"] });
    expect(await requestNow(a.forms!.ids.signed)).toMatchObject({ familyQboId: FAMILY_B.family.qboId, state: "not_opened", envelopeId: null });
    expect(await db.select().from(signatureConsent).where(eq(signatureConsent.requestId, a.forms!.ids.signed))).toEqual([]);
    expect(await requestNow(a.forms!.ids.complete)).toMatchObject({ familyQboId: FAMILY_B.family.qboId, state: "complete" });
    expect((await db.select().from(signedFormEvidence).where(eq(signedFormEvidence.id, a.forms!.evidence.id)))[0]!.familyQboId).toBe(FAMILY_B.family.qboId);
    expect((await db.select().from(formWithdrawal)).map((w) => [w.envelopeId, w.anySigned]).sort()).toEqual([["envelope_alderquistdeclined", false], ["envelope_alderquistother", true], ["envelope_alderquistsigned", true]]);
    expect(await audits("forms.request.moved")).toHaveLength(4);
    // A's parent no longer reaches the moved form; the worker withdraws the documents (gone already here) and clears the queue.
    expect(await findMySignedPdf({ ...a.identity, ip: null }, a.forms!.ids.complete)).toBeNull();
    await connectForms(stub);
    await runEvidenceJob();
    expect(await db.select().from(formWithdrawal)).toEqual([]);
    expect((await audits("form.document.withdraw")).map((r) => r.after)).toEqual(Array(3).fill({ reason: "student_moved", how: "already_gone" }));
  });

  it("gives the new family nothing of who signed a form it brought along: no names, no download, no PDF", async () => {
    const s2 = FAMILY_A.students[1]!;
    await db.transaction((tx) => formsForMovedStudent(tx, { studentQboId: s2.qboId, fromFamilyQboId: FAMILY_A.family.qboId, toFamilyQboId: FAMILY_B.family.qboId }));
    await moveInCache([s2.qboId], FAMILY_B.family.qboId); // as a roster read leaves it: the app's records follow
    const bCtx = { ...b.identity, ip: null };
    expect(await findMySignedPdf(bCtx, a.forms!.ids.complete)).toBeNull();
    expect(await mySignedDownloads(bCtx, [a.forms!.ids.complete])).toEqual(new Map());
    asParent(b.identity);
    const page = await renderPage(FormPage, { params: { id: a.forms!.ids.complete } });
    expect(textOf(page)).toContain("Signed Thank you!");
    expect(page).not.toContain(FAMILY_A.parent.name);
    expect(page).not.toContain("Download the signed form");
    expect(page).not.toContain(`/forms/${a.forms!.ids.complete}/signed`);
    const list = await renderPage(FormsPage);
    expect(textOf(list)).not.toContain(FAMILY_A.parent.name);
    expect(list).not.toContain(`/forms/${a.forms!.ids.complete}/signed`);
    const answer = await parentDownload(new Request(`http://portal.test/forms/${a.forms!.ids.complete}/signed`), { params: Promise.resolve({ id: a.forms!.ids.complete }) });
    expect(answer.status).toBe(404);
    // B's own complete form, signed by B's guardian, is still B's to download.
    expect(await findMySignedPdf(bCtx, b.forms!.ids.complete)).not.toBeNull();
  });

  it("never deletes a document Documenso sealed after the portal last read it, and audits a withdrawal that keeps failing as failed", async () => {
    await connectForms(stub);
    const template = stub.addTemplate({ signers: 1 });
    const requirementId = await seedFormRequirement({ stepId: (await db.select({ stepId: requirement.stepId }).from(requirement).where(eq(requirement.title, "Travel consent")))[0]!.stepId,
      title: "Medical release", appliesTo: "student", form: formSetting({ id: template.id }) });
    const who = { parentId: a.identity.parentId, name: FAMILY_A.parent.name, email: FAMILY_A.parent.email };
    const sealed = await signedInStub(stub, { requirementId, templateId: template.id, familyQboId: FAMILY_A.family.qboId, subjectQboId: FAMILY_A.students[0]!.qboId, guardians: [who], sign: false });
    stub.sign(sealed.envelopeId, FAMILY_A.parent.email);
    await db.transaction((tx) => formsForMovedStudent(tx, { studentQboId: FAMILY_A.students[0]!.qboId, fromFamilyQboId: FAMILY_A.family.qboId, toFamilyQboId: FAMILY_B.family.qboId }));
    expect(await db.select().from(formWithdrawal).where(eq(formWithdrawal.envelopeId, sealed.envelopeId))).toMatchObject([{ anySigned: false }]);
    await runEvidenceJob(); await runEvidenceJob();
    expect(stub.apiCalls("/envelope/delete")).toEqual([]);
    expect(stub.envelopes.get(sealed.envelopeId)).toMatchObject({ status: "COMPLETED", deletedAt: null });
    expect((await audits("form.document.withdraw.kept")).map((r) => r.targetId)).toEqual([sealed.envelopeId]);

    // A document Documenso won't answer about: tried ten times, then audited as failed, never as withdrawn.
    const open = await signedInStub(stub, { requirementId, templateId: template.id, familyQboId: FAMILY_B.family.qboId, subjectQboId: FAMILY_B.students[0]!.qboId, guardians: [who], sign: false });
    await db.insert(formWithdrawal).values({ envelopeId: open.envelopeId, anySigned: false, tries: 10 });
    stub.failNext = 50;
    await runEvidenceJob();
    stub.failNext = 0;
    expect(await db.select().from(formWithdrawal)).toEqual([]);
    expect((await audits("form.document.withdraw.failed")).map((r) => [r.targetId, (r.after as { error: string }).error])).toEqual([[open.envelopeId, expect.any(String)]]);
    expect((await audits("form.document.withdraw")).map((r) => r.targetId)).not.toContain(open.envelopeId);
    expect(stub.envelopes.get(open.envelopeId)!.deletedAt).toBeNull();
  });
});

describe("a different QuickBooks company connected", () => {
  it("keeps every byte and hash of the earlier evidence, shows it to no parent and leaves it out of the matrix, and lists it in the archive", async () => {
    const before = await db.select().from(signedFormFile).orderBy(asc(signedFormFile.id));
    await connectForms({ origin: "http://127.0.0.1:9", token: "api_never_called" });
    await seedWorkingMail();
    expect(await clearRosterOfOtherCompany("NEW-COMPANY-REALM", SYSTEM)).toBe(true);
    const kept = await db.select().from(signedFormEvidence);
    expect(kept).toHaveLength(2);
    for (const e of kept) expect(e).toMatchObject({ requestId: null, earlierCompanyAt: expect.any(Date), realmId: "9130000000000001" });
    const after = await db.select().from(signedFormFile).orderBy(asc(signedFormFile.id));
    expect(after.map((f) => [f.id, f.sha256, f.size, f.bytes.toString("base64")])).toEqual(before.map((f) => [f.id, f.sha256, f.size, f.bytes.toString("base64")]));
    expect((await audits("form.records.cleared"))[0]!.after).toMatchObject({ evidenceKeptAsEarlierCompany: 2 });
    expect(await db.select().from(formReminderClaim)).toEqual([]);

    // The new company has a family with the same QuickBooks id as A, and a parent of it.
    await addToCache([fam(FAMILY_A.family.qboId, "Newcomb Family"), par("NEW-P-1", "Nell Newcomb", FAMILY_A.family.qboId, "nell.newcomb@new.example"),
      stu(FAMILY_A.students[1]!.qboId, "Nico Newcomb", FAMILY_A.family.qboId)]);
    await seedParentSettings({ signin: true, everEnabled: true, welcome: true });
    const nell = await seedParentIn({ familyQboId: FAMILY_A.family.qboId, name: "Nell Newcomb", email: "nell.newcomb@new.example", sourceQboId: "NEW-P-1" });
    asParent(nell.identity);
    const forms = await renderPage(FormsPage);
    for (const m of [a.forms!.evidence.id, a.forms!.evidence.sealedSha256, "/signed", FAMILY_A.parent.name, "Ottoline"]) expect(forms).not.toContain(m);
    expect(await findMySignedPdf({ ...nell.identity, ip: null }, a.forms!.ids.complete)).toBeNull();
    // Her own new request for the same student and form finds nothing of the earlier company's evidence.
    const mine = await db.select().from(signatureRequest).where(eq(signatureRequest.familyQboId, FAMILY_A.family.qboId));
    for (const r of mine) {
      await db.update(signatureRequest).set({ state: "complete", envelopeId: `envelope_new${r.id.slice(0, 8)}` }).where(eq(signatureRequest.id, r.id));
      expect(await findMySignedPdf({ ...nell.identity, ip: null }, r.id)).toBeNull();
    }
    await db.update(signatureRequest).set({ state: "not_opened", envelopeId: null }).where(eq(signatureRequest.familyQboId, FAMILY_A.family.qboId));

    // Reminders reach her about the forms of the new company only, never the earlier evidence.
    asStaff(writer);
    await remindFamilyAction(FAMILY_A.family.qboId);
    for (const m of mail.outbox) {
      expect(m.to).toBe("nell.newcomb@new.example");
      for (const marker of [FAMILY_A.parent.name, FAMILY_A.students[1]!.name, a.forms!.evidence.id]) expect(`${m.text} ${m.html}`).not.toContain(marker);
    }
    // The matrix leaves it out; the archive lists it, opens it (audited) and downloads every file of it.
    asStaff(reader);
    const html = await renderPage(SignedFormsPage, { searchParams: {} });
    const [matrixPart, archivePart] = html.split("Earlier company");
    expect(matrixPart).not.toContain(a.forms!.evidence.id);
    expect(archivePart).toContain(`/staff/forms/evidence/${a.forms!.evidence.id}`);
    expect(archivePart).toContain(`/staff/forms/evidence/${b.forms!.evidence.id}`);
    expect(textOf(archivePart!)).toContain("Uniform agreement");
    expect(textOf(await renderPage(EvidencePage, { params: { id: a.forms!.evidence.id } }))).toContain("no longer connected");
    expect((await audits("forms.evidence.read")).at(-1)!.after).toMatchObject({ earlierCompany: true });
    for (const key of ["sealed-pdf-1", "certificate-pdf", "audit-log-pdf", "audit-log-json", "evidence-record-json"]) {
      const res = await staffDownload(new Request(`http://localhost/staff/forms/evidence/${a.forms!.evidence.id}/${key}`), { params: Promise.resolve({ id: a.forms!.evidence.id, file: key }) });
      expect(res.status).toBe(200);
      if (key === "sealed-pdf-1") expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), a.forms!.evidence.sealed)).toBe(0);
    }
    expect(await audits("forms.evidence.download")).toHaveLength(5);
    // And it is never deleted: a second change of company keeps it as it was.
    expect(await clearRosterOfOtherCompany("THIRD-REALM", SYSTEM)).toBe(true);
    expect(await db.select().from(signedFormEvidence).where(and(eq(signedFormEvidence.id, a.forms!.evidence.id)))).toHaveLength(1);
  });
});
