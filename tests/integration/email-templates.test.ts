import { describe, it, expect, beforeEach, vi } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const mail = vi.hoisted(() => ({ outbox: [] as Msg[] }));
vi.mock("@/lib/mail/senders", async () => ({
  SMTP_PASSWORD_AAD: "mail:smtp-password",
  buildSender: async () => async (m: Msg) => { mail.outbox.push(m); },
}));

import { asStaff, pageOutcome, renderPage, revalidatedPaths } from "../helpers/signed-in";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, emailTemplateVersion, role, roleAssignment, roleRule, setting } from "@/lib/db/schema";
import { AccessDenied } from "@/lib/guards";
import { defaultWordsAction, saveEmailAction, testEmailAction, versionAgainAction } from "@/app/staff/(app)/settings/emails/actions";
import EmailsPage from "@/app/staff/(app)/settings/emails/page";
import EmailPage from "@/app/staff/(app)/settings/emails/[key]/page";
import { currentBrand } from "@/lib/mail/send";
import { formReminderMessage, passwordResetMessage } from "@/lib/mail/messages";
import { defaultTemplate, emailByKey } from "@/lib/email-templates/catalog";
import { TESTS_PER_HOUR } from "@/lib/mail/template-store";
import { resetDb, seedStaff, seedWorkingMail } from "../helpers/db";

/**
 * Email templates (docs/superpowers/specs/2026-11-28-email-templates-design.md), slices 2 to 5: the list and each email's
 * page, Save as versions with their audit rows, the club's words reaching every send, Send me a test, Use the default
 * words and an earlier version again, and the permission a custom role may hold. No real mail: the sender is replaced.
 */
type Staff = { id: string; name: string; email: string };
const audits = (action: string) => db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(asc(auditLog.id));
const versions = (key: string) => db.select().from(emailTemplateVersion).where(eq(emailTemplateVersion.emailKey, key)).orderBy(asc(emailTemplateVersion.n));
const reminder = emailByKey("form_reminder")!;
const withLine = (line: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: line }] }, ...defaultTemplate(reminder).body.content] });
const words = (line: string, subject = "Please sign: {Form name}") => ({ subject, body: withLine(line) });
const data = { formTitle: "Medical release", forNames: ["Maya"], due: null, link: "https://p.example/forms" };

let secretary: Staff, viewer: Staff, admin: Staff;
async function roleWith(staff: Staff, key: string, patterns: string[]) {
  const [r] = await db.insert(role).values({ key, name: key }).returning();
  for (const pattern of patterns) await db.insert(roleRule).values({ roleId: r!.id, kind: "include", pattern });
  await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: staff.id });
}
beforeEach(async () => {
  await resetDb();
  mail.outbox.length = 0;
  secretary = await seedStaff({ email: "secretary@club.org", name: "Sam Secretary" });
  await roleWith(secretary, "secretary", ["Settings.Club.Read", "Settings.Emails.ReadWrite"]);
  viewer = await seedStaff({ email: "viewer@club.org", name: "Vic Viewer" });
  await roleWith(viewer, "viewer", ["Settings.Club.Read"]);
  admin = await seedStaff({ email: "admin@club.org", name: "Ada Admin", admin: true });
  await db.insert(setting).values({ key: "club", value: { name: "Lakeside Band", shortName: "LB", color: "#336699", treasurerEmail: "treasurer@lakeside.example", timeZone: "America/Chicago" } })
    .onConflictDoNothing();
});

describe("saving an email's words", () => {
  it("saves each change as the next version, audited with the email and the version, and the next send uses it", async () => {
    asStaff(secretary);
    expect(await saveEmailAction("form_reminder", words("Hello from the band."))).toMatchObject({ ok: true });
    expect(await saveEmailAction("form_reminder", words("Hello again.", "Sign {Form name}, please"))).toMatchObject({ ok: true });
    expect((await versions("form_reminder")).map((v) => [v.n, v.subject, v.savedBy, v.reset])).toEqual([
      [1, "Please sign: {Form name}", secretary.id, false], [2, "Sign {Form name}, please", secretary.id, false]]);
    expect((await audits("email_template.save")).map((r) => [r.targetId, r.permission, r.before, r.after, r.actorId])).toEqual([
      ["form_reminder", "Settings.Emails.ReadWrite", { version: null }, { version: 1, reset: false }, secretary.id],
      ["form_reminder", "Settings.Emails.ReadWrite", { version: 1 }, { version: 2, reset: false }, secretary.id]]);
    expect(revalidatedPaths()).toContain("/staff/settings");
    const m = formReminderMessage(await currentBrand(), "a@x.org", data);
    expect(m.subject).toBe("Sign Medical release, please");
    expect(m.text.startsWith("Hello again.\n\nA friendly reminder: Medical release for Maya still needs your signature.")).toBe(true);
    // Other emails keep their default words.
    expect(passwordResetMessage(await currentBrand(), "a@x.org", { link: "https://p/r", life: "1 hour" }).subject).toBe("Reset your Lakeside Band password");
  });

  it("refuses words that are the same as the current ones, and words the check refuses, saving nothing", async () => {
    asStaff(secretary);
    expect(await saveEmailAction("form_reminder", defaultTemplate(reminder))).toEqual({ ok: false, errors: ["Nothing has changed since the last save."] });
    const missing = { subject: "x", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }] } };
    expect(await saveEmailAction("form_reminder", missing)).toMatchObject({ ok: false });
    const link = { subject: "x", body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "go", marks: [{ type: "link", attrs: { href: "https://evil.example" } }] }] },
      ...defaultTemplate(emailByKey("password_reset")!).body.content] } };
    expect(await saveEmailAction("password_reset", link)).toMatchObject({ ok: false, errors: [expect.stringMatching(/^Sign-in emails can't hold links/)] });
    expect(await saveEmailAction("no_such_email", words("x"))).toMatchObject({ ok: false });
    expect(await saveEmailAction("form_reminder", "not words")).toMatchObject({ ok: false });
    expect(await db.select().from(emailTemplateVersion)).toEqual([]);
    expect(await audits("email_template.save")).toEqual([]);
  });

  it("is refused to someone who may only see the emails, and to nobody", async () => {
    asStaff(viewer);
    await expect(saveEmailAction("form_reminder", words("x"))).rejects.toBeInstanceOf(AccessDenied);
    await expect(defaultWordsAction("form_reminder")).rejects.toBeInstanceOf(AccessDenied);
    await expect(testEmailAction("form_reminder", words("x"))).rejects.toBeInstanceOf(AccessDenied);
    expect(await db.select().from(emailTemplateVersion)).toEqual([]);
  });
});

describe("Use the default words and an earlier version", () => {
  it("saves each as the next version, so either can be undone", async () => {
    asStaff(admin);
    await saveEmailAction("form_reminder", words("One."));
    await saveEmailAction("form_reminder", words("Two."));
    expect(await defaultWordsAction("form_reminder")).toMatchObject({ ok: true, message: "Saved. \"Please sign\" has its default words again." });
    expect(await defaultWordsAction("form_reminder")).toEqual({ ok: false, errors: ["This email already has its default words."] });
    expect(formReminderMessage(await currentBrand(), "a@x.org", data).text.startsWith("A friendly reminder")).toBe(true);
    expect(await versionAgainAction("form_reminder", 1)).toMatchObject({ ok: true });
    expect(await versionAgainAction("form_reminder", 99)).toMatchObject({ ok: false });
    expect((await versions("form_reminder")).map((v) => [v.n, v.reset])).toEqual([[1, false], [2, false], [3, true], [4, false]]);
    expect(formReminderMessage(await currentBrand(), "a@x.org", data).text.startsWith("One.")).toBe(true);
  });
});

describe("Send me a test", () => {
  it("sends the words on the page, unsaved, with samples, to the staff member's own address, 'Test: ' first", async () => {
    await seedWorkingMail();
    asStaff(secretary);
    expect(await testEmailAction("form_reminder", words("Not saved yet."))).toEqual({ ok: true, message: "Sent to secretary@club.org. It has sample values, and its links open nothing." });
    expect(mail.outbox).toHaveLength(1);
    expect(mail.outbox[0]).toMatchObject({ to: "secretary@club.org", subject: "Test: Please sign: Medical release 2026" });
    expect(mail.outbox[0]!.text).toContain("Not saved yet.");
    expect(await db.select().from(emailTemplateVersion)).toEqual([]);
    const [row] = await audits("email_template.test");
    expect(row).toMatchObject({ targetId: "form_reminder", after: { ok: true }, actorId: secretary.id });
    expect(JSON.stringify(row)).not.toContain("secretary@club.org\"}");
  });

  it("is refused while outgoing mail isn't working, and after the hour's limit", async () => {
    asStaff(secretary);
    expect(await testEmailAction("form_reminder", words("x"))).toMatchObject({ ok: false, errors: [expect.stringMatching(/^Outgoing mail isn't working/)] });
    await seedWorkingMail();
    for (let i = 0; i < TESTS_PER_HOUR; i++) expect(await testEmailAction("form_reminder", words("x"))).toMatchObject({ ok: true });
    expect(await testEmailAction("form_reminder", words("x"))).toMatchObject({ ok: false, errors: [`You've sent ${TESTS_PER_HOUR} tests in the last hour. Try again a little later.`] });
    expect(mail.outbox).toHaveLength(TESTS_PER_HOUR);
  });
});

describe("the pages", () => {
  it("list every email with where it stands", async () => {
    asStaff(secretary);
    await saveEmailAction("form_reminder", words("Hi."));
    const html = await renderPage(EmailsPage);
    for (const e of ["Sign-in code", "Welcome", "Please sign", "Shift tomorrow", "Club message"]) expect(html).toContain(e);
    expect(html).toContain("Club&#x27;s words");
    expect(html).toContain('href="/staff/settings/emails/form_reminder"');
  });

  it("show one email with its editor to someone who may change it, and read only to someone who may not", async () => {
    asStaff(secretary);
    const html = await renderPage(EmailPage, { params: { key: "form_reminder" } });
    expect(html).toContain("Save the email");
    expect(html).toContain("Send me a test");
    expect(html).toContain("The test goes to secretary@club.org");
    asStaff(viewer);
    const read = await renderPage(EmailPage, { params: { key: "form_reminder" } });
    expect(read).not.toContain("Save the email");
    expect(read).toContain("Only someone allowed to change the emails can change them.");
    expect(read).not.toContain("secretary@club.org");
  });

  it("answer 404 for an address that names no email", async () => {
    asStaff(admin);
    expect(await pageOutcome(EmailPage, { params: { key: "nope" } })).toEqual({ notFound: true });
    expect(await pageOutcome(EmailPage, { params: { key: "../club" } })).toEqual({ notFound: true });
  });

  it("show an earlier version read only, with the way to use it again", async () => {
    asStaff(admin);
    await saveEmailAction("form_reminder", words("First words."));
    await saveEmailAction("form_reminder", words("Second words."));
    const html = await renderPage(EmailPage, { params: { key: "form_reminder" }, searchParams: { version: "1" } });
    expect(html).toContain("Version 1");
    expect(html).toContain("Use these words again");
    expect(html).toContain("First words.");
  });
});
