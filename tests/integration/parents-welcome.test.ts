import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

// Mail goes over real SMTP to the local sink; only the certificate trust is test-side (the app never trusts a custom CA).
const tlsHolder = vi.hoisted(() => ({ cert: "" }));
vi.mock("@/lib/mail/senders", async () => {
  const { createSmtpSender } = await import("@/lib/mail/smtp");
  return {
    SMTP_PASSWORD_AAD: "mail:smtp-password",
    buildSender: async (stored: { host: string; port: number; security: "starttls" | "tls"; username: string; from: string }, brand: { clubName: string }) =>
      createSmtpSender({ host: stored.host, port: stored.port, security: stored.security, username: stored.username, password: "sink-password",
        from: stored.from, fromName: brand.clubName, tls: { ca: tlsHolder.cert } }),
  };
});

import { and, eq, isNull, sql } from "drizzle-orm";
import * as sendModule from "@/lib/mail/send";
import { db } from "@/lib/db/client";
import { auditLog, family, parent, parentAuthUser, parentSigninToken, setting, student } from "@/lib/db/schema";
import { runDueJobs } from "@/lib/jobs/runner";
import { blockPerson, unblockPerson } from "@/lib/parents/people";
import * as linkDelivery from "@/lib/parents/link-delivery";
import { removeGuardian } from "@/lib/parents/guardians";
import { askForPasswordLink } from "@/lib/parents/password-request";
import { hashLinkToken, holdSigninLink, linkVerdict, LINK_LIFE_MS } from "@/lib/parents/signin-links";
import { failedLast, markJob, readMark, WELCOME_MARK } from "@/lib/jobs/marks";
import { oweSetupMails, setSignins, setupMailsToOwe, setWelcome, SETUP_MAILS_NEED_SWITCHES } from "@/lib/parents/switches";
import { sendOwedWelcomes, resendWelcome, EARLIER_LINK_MIN_LIFE_MS, REFUSED_RETRY_MS, WELCOME_RETRY_MS } from "@/lib/parents/welcome";
import { resetDb, seedParent, seedGuardianInFamily, seedWorkingMail } from "../helpers/db";
import { seedParentSettings, storeShape } from "../helpers/roster-cache";
import { linkRows, mailText, mintLink, seedPassword, setupTokensIn } from "../helpers/signin-links";
import { startMailSink, type MailSink } from "../helpers/mail-sink";
import { localhostCertificate } from "../helpers/tls";

const admin = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000001", label: "admin@club.org" }, ip: null, permission: "Settings.Parents.ReadWrite" };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
/**
 * A person with one guardian row, in an active family record of the app's own (seedGuardianInFamily(): rows of one
 * `family` share it), so the row counts as the gate counts rows (src/lib/parents/sessions.ts).
 */
const person = async (name: string, o: { family?: string; welcomedAt?: Date | null; welcomeOwed?: boolean; blocked?: boolean; status?: "invited" | "active" | "disabled" } = {}) => {
  const p = await seedParent({ name, welcomedAt: o.welcomedAt ?? null, welcomeOwed: o.welcomeOwed ?? false, blocked: o.blocked ?? false });
  const g = await seedGuardianInFamily({ parentId: p.id, familyQboId: o.family ?? "10", status: o.status ?? "invited" });
  return { ...p, familyId: g.familyId!, guardianId: g.id };
};
/** Longer ago than this is past the resend wait of the request page (RESEND_AFTER_MS, a minute). */
const RESEND_WAIT = 60_000;
const owedNames = async () => (await db.select().from(parent)).filter((p) => p.welcomeOwed).map((p) => p.name).sort();

let tls: { key: string; cert: string };
let sink: MailSink;
beforeAll(async () => { tls = await localhostCertificate(); tlsHolder.cert = tls.cert; sink = await startMailSink({ secure: true, ...tls }); });
afterAll(async () => { await sink.close(); });

describe("welcome emails", () => {
  beforeEach(async () => {
    await resetDb();
    sink.messages.length = 0;
    sink.rejectRecipient = null;
    sink.rejectReply = { code: 550, text: "Mailbox unavailable" };
    await seedWorkingMail({ method: "smtp", host: "127.0.0.1", port: sink.port, security: "tls", username: "sender", from: "boosters@example.org",
      passwordCiphertext: "unused", passwordKeyId: "unused" });
    await seedParentSettings({ signin: true });
  });

  it("switching welcomes on marks everyone with access who was never welcomed, and nobody else", async () => {
    await person("New One"); await person("Welcomed Before", { welcomedAt: new Date("2026-01-01T00:00:00Z") });
    await person("Blocked One", { blocked: true }); await person("No Access", { status: "disabled" });
    expect(await setWelcome(true, admin)).toEqual({ ok: true });
    const owed = (await db.select().from(parent)).filter((p) => p.welcomeOwed).map((p) => p.name);
    expect(owed).toEqual(["New One"]);
    expect((await audits("settings.parents.save"))[0]!.after).toMatchObject({ welcome: true, owed: 1 });
    expect(sink.messages).toEqual([]); // the switch itself sends nothing
  });

  it("switching welcomes off clears what was owed", async () => {
    await seedParentSettings({ welcome: true });
    await person("Parent 1", { welcomeOwed: true });
    expect(await setWelcome(false, admin)).toEqual({ ok: true });
    expect((await db.select().from(parent)).every((p) => !p.welcomeOwed)).toBe(true);
  });

  it("the worker sends owed welcomes, five a wake, and records each one", async () => {
    await seedParentSettings({ welcome: true });
    for (let i = 1; i <= 7; i++) await person(`Parent ${i}`, { welcomeOwed: true });
    expect(await sendOwedWelcomes()).toEqual({ sent: 5, failed: 0 });
    expect(sink.messages).toHaveLength(5);
    expect(await sendOwedWelcomes()).toEqual({ sent: 2, failed: 0 });
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 0 });
    expect(sink.messages).toHaveLength(7);
    expect(sink.messages[0]!.raw).toContain("Questions? Write to boosters@example.org.");
    const rows = await db.select().from(parent);
    expect(rows.every((p) => p.welcomedAt !== null && !p.welcomeOwed)).toBe(true);
    const sent = await audits("parent.welcome.sent");
    expect(sent).toHaveLength(7);
    expect(sent[0]).toMatchObject({ door: "system", targetType: "parent" });
    // No email body in the audit log, and no link: the welcome's words and its set-up link are in the mail alone.
    expect(JSON.stringify(sent)).not.toContain("choose your password with this link");
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain("/sign-in/set-up/");
    expect(sent.map((r) => r.after)).toEqual(Array(7).fill(expect.objectContaining({ mail: "welcome", link: "setup" })));
  }, 30_000);

  it("sends to the first five by the time they were created", async () => {
    await seedParentSettings({ welcome: true });
    const made: string[] = [];
    for (let i = 1; i <= 7; i++) made.push((await person(`Parent ${i}`, { welcomeOwed: true })).email);
    await sendOwedWelcomes();
    expect(sink.messages.map((m) => m.to[0]!).sort()).toEqual(made.slice(0, 5).sort());
  });

  it("two runs at once welcome each person once", async () => {
    await seedParentSettings({ welcome: true });
    const emails = [(await person("Parent 1", { welcomeOwed: true })).email, (await person("Parent 2", { welcomeOwed: true })).email, (await person("Parent 3", { welcomeOwed: true })).email];
    const [a, b] = await Promise.all([sendOwedWelcomes(), sendOwedWelcomes()]);
    expect(a.sent + b.sent).toBe(3);
    expect(a.failed + b.failed).toBe(0);
    expect(sink.messages.map((m) => m.to[0]!).sort()).toEqual([...emails].sort());
  });

  it("nobody blocked after the run chose its people gets a welcome", async () => {
    await seedParentSettings({ welcome: true });
    const first = await person("Parent 1", { welcomeOwed: true });
    const second = await person("Parent 2", { welcomeOwed: true });
    await person("Parent 3", { welcomeOwed: true });
    const real = sendModule.sendMail;
    // While the first welcome is being sent, the second person is blocked: the claim must refuse them.
    const spy = vi.spyOn(sendModule, "sendMail").mockImplementation(async (m, o) => {
      if (m.to === first.email) await db.update(parent).set({ blocked: true }).where(eq(parent.id, second.id));
      return real(m, o);
    });
    try { expect(await sendOwedWelcomes()).toEqual({ sent: 2, failed: 0 }); } finally { spy.mockRestore(); }
    expect(sink.messages.map((m) => m.to[0]!)).not.toContain(second.email);
    expect((await db.select().from(parent).where(eq(parent.id, second.id)))[0]!.welcomeOwed).toBe(true);
  });

  it("a run stops when welcomes are switched off while it is going", async () => {
    await seedParentSettings({ welcome: true });
    const first = await person("Parent 1", { welcomeOwed: true });
    await person("Parent 2", { welcomeOwed: true });
    const real = sendModule.sendMail;
    const spy = vi.spyOn(sendModule, "sendMail").mockImplementation(async (m, o) => {
      if (m.to === first.email) await seedParentSettings({ welcome: false });
      return real(m, o);
    });
    try { expect(await sendOwedWelcomes()).toEqual({ sent: 1, failed: 0 }); } finally { spy.mockRestore(); }
    expect(sink.messages).toHaveLength(1);
  });

  it("sends nothing while welcomes, or sign-ins, are off, or mail isn't working", async () => {
    await person("Parent 1", { welcomeOwed: true });
    await seedParentSettings({ welcome: false });
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 0 });
    await seedParentSettings({ welcome: true, signin: false });
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 0 });
    await seedParentSettings({ welcome: true, signin: true }); // both on: only mail is failing now
    await db.delete(setting).where(eq(setting.key, "mail.status")); // mail no longer counts as working
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 0 });
    expect(sink.messages).toEqual([]);
  });

  it("skips a blocked person and one with no open link, and leaves them owed", async () => {
    await seedParentSettings({ welcome: true });
    await person("Blocked One", { welcomeOwed: true, blocked: true }); await person("No Access", { welcomeOwed: true, status: "disabled" });
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 0 });
    expect((await db.select().from(parent)).every((p) => p.welcomeOwed)).toBe(true);
    expect(sink.messages).toEqual([]);
  });

  it("an address the mail server refuses is recorded and tried again only a day later, and is no mail outage: the rest of the batch goes, and the next wake's is five", async () => {
    await seedParentSettings({ welcome: true });
    const bad = await person("Bounce", { welcomeOwed: true }); const fine = await person("Fine", { welcomeOwed: true });
    for (let i = 1; i <= 5; i++) await person(`Parent ${i}`, { welcomeOwed: true });
    sink.rejectRecipient = bad.email; // the sink answers "550 Mailbox unavailable" to RCPT TO for this one address
    expect(await sendOwedWelcomes()).toEqual({ sent: 4, failed: 1 }); // Bounce, Fine and Parents 1 to 3: the others still go
    expect((await audits("parent.welcome.failed")).map((r) => ({ targetId: r.targetId, refused: (r.after as { recipientRefused?: boolean }).recipientRefused })))
      .toEqual([{ targetId: bad.id, refused: true }]);
    expect(sink.messages.map((m) => m.to[0])).toEqual([fine.email, "parent.1@example.com", "parent.2@example.com", "parent.3@example.com"]);
    expect(failedLast(await readMark(WELCOME_MARK))).toBe(false); // the refusal marks no failure of the mail
    // Not held to one person a wake: Parents 4 and 5 go together; Bounce is too soon to retry.
    expect(await sendOwedWelcomes()).toEqual({ sent: 2, failed: 0 });
    sink.rejectRecipient = null;
    // Not tried every fifteen minutes: the wakes inside the day pass Bounce over, and the first after it sends.
    expect(await sendOwedWelcomes(new Date(Date.now() + WELCOME_RETRY_MS + 1000))).toEqual({ sent: 0, failed: 0 });
    expect(await sendOwedWelcomes(new Date(Date.now() + REFUSED_RETRY_MS - 60_000))).toEqual({ sent: 0, failed: 0 });
    expect(await sendOwedWelcomes(new Date(Date.now() + REFUSED_RETRY_MS + 1000))).toEqual({ sent: 1, failed: 0 });
    expect(sink.messages.at(-1)!.to).toEqual([bad.email]);
  });

  it("a relay refused at RCPT TO with an enhanced code of policy is the mail failing: the batch ends at once and the throttle starts", async () => {
    await seedParentSettings({ welcome: true });
    for (let i = 1; i <= 3; i++) await person(`Parent ${i}`, { welcomeOwed: true });
    sink.rejectRecipient = "*";
    sink.rejectReply = { code: 554, text: "5.7.1 Relay access denied" };
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 1 });
    expect((await audits("parent.welcome.failed")).map((r) => (r.after as { recipientRefused?: boolean }).recipientRefused)).toEqual([undefined]);
    expect(failedLast(await readMark(WELCOME_MARK))).toBe(true);
    // Held to one person a wake, and nobody is held off a day: the one tried keeps the fifteen-minute back-off.
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 1 });
    expect((await db.select().from(parent)).filter((p) => p.welcomeTriedAt !== null && p.welcomeTriedAt.getTime() > Date.now())).toEqual([]);
  });

  it("a relay refused with no enhanced code is caught by the wake: nobody sent to and two or more refused is the mail failing", async () => {
    await seedParentSettings({ welcome: true });
    for (let i = 1; i <= 7; i++) await person(`Parent ${i}`, { welcomeOwed: true });
    sink.rejectRecipient = "*"; // "550 Mailbox unavailable" for every address: each reads as the address's own
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 5 });
    expect((await audits("parent.welcome.failed")).every((r) => (r.after as { recipientRefused?: boolean }).recipientRefused === true)).toBe(true);
    expect(failedLast(await readMark(WELCOME_MARK))).toBe(true); // the throttle starts, and the Health note can show
    // Like any mail failure, the five keep the claim's fifteen-minute back-off, not a day's.
    expect((await db.select().from(parent)).filter((p) => p.welcomeTriedAt !== null && p.welcomeTriedAt.getTime() > Date.now())).toEqual([]);
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 1 }); // one person a wake now
    // The throttled wake's one refused person (Parent 6) is not held off a day either: a wake of one can't tell a
    // refusal from the mail failing, so once the mail is mended nobody waits a day.
    const [sixth] = await db.select().from(parent).where(eq(parent.name, "Parent 6"));
    expect(sixth!.welcomeTriedAt).not.toBeNull();
    expect((await db.select().from(parent)).filter((p) => p.welcomeTriedAt !== null && p.welcomeTriedAt.getTime() > Date.now())).toEqual([]);
    sink.rejectRecipient = null;
    expect(await sendOwedWelcomes(new Date(Date.now() + WELCOME_RETRY_MS + 1000))).toEqual({ sent: 1, failed: 0 }); // still one, and it goes
    expect(failedLast(await readMark(WELCOME_MARK))).toBe(false);
    expect(await sendOwedWelcomes(new Date(Date.now() + WELCOME_RETRY_MS + 2000))).toEqual({ sent: 5, failed: 0 }); // the batch of five again
  });

  it("a throttled wake whose one person is refused stays throttled: a refusal never clears the mark", async () => {
    await seedParentSettings({ welcome: true });
    const bad = await person("Bounce", { welcomeOwed: true });
    await person("Fine", { welcomeOwed: true });
    await markJob(WELCOME_MARK, { counts: { sent: 0, recipientRefused: 0, linkNotInPlace: 0 }, failed: 1 }); // the last send failed
    sink.rejectRecipient = bad.email;
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 1 }); // one person a wake: Bounce, the oldest
    expect(failedLast(await readMark(WELCOME_MARK))).toBe(true);
    expect(sink.messages).toEqual([]);
    // Refused in a wake that began throttled, Bounce keeps the claim's fifteen-minute back-off, not a day's.
    const [bounce] = await db.select().from(parent).where(eq(parent.id, bad.id));
    expect(bounce!.welcomeTriedAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(await sendOwedWelcomes()).toEqual({ sent: 1, failed: 0 }); // still one a wake; Fine goes, and that clears it
    expect(failedLast(await readMark(WELCOME_MARK))).toBe(false);
    // So Bounce is tried again once the fifteen minutes pass, not a day on.
    expect(await sendOwedWelcomes(new Date(Date.now() + WELCOME_RETRY_MS + 1000))).toEqual({ sent: 0, failed: 1 });
  });

  it("a wake that throws after a send still marks what it did", async () => {
    await seedParentSettings({ welcome: true });
    await person("Parent 1", { welcomeOwed: true }); await person("Parent 2", { welcomeOwed: true });
    const real = linkDelivery.deliverHeldLink;
    let calls = 0;
    const spy = vi.spyOn(linkDelivery, "deliverHeldLink").mockImplementation(async (l, o) => {
      if (++calls === 2) throw new Error("the process stopped here");
      return real(l, o);
    });
    try { await expect(sendOwedWelcomes()).rejects.toThrow("the process stopped here"); } finally { spy.mockRestore(); }
    expect(sink.messages).toHaveLength(1);
    expect(await readMark(WELCOME_MARK)).toMatchObject({ did: { sent: 1, recipientRefused: 0, linkNotInPlace: 0 }, failedLast: false });
  });

  it("while mail is failing, a wake tries one person, not five, and the first that goes brings back the batch of five", async () => {
    await seedParentSettings({ welcome: true });
    for (let i = 1; i <= 10; i++) await person(`Parent ${i}`, { welcomeOwed: true });
    const outage = { on: true };
    const real = sendModule.sendMail;
    const tried: string[] = [];
    const spy = vi.spyOn(sendModule, "sendMail").mockImplementation(async (m, o) => {
      tried.push(m.to);
      return outage.on ? { ok: false as const, error: "The mail server didn't accept the message (421)." } : real(m, o);
    });
    try {
      expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 1 }); // the first failure ends the batch
      expect(tried).toHaveLength(1);
      for (let wake = 2; wake <= 4; wake++) {
        expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 1 });
        expect(tried).toHaveLength(wake); // one person a wake
      }
      outage.on = false;
      expect(await sendOwedWelcomes()).toEqual({ sent: 1, failed: 0 }); // still one, and it goes
      expect(await sendOwedWelcomes()).toEqual({ sent: 5, failed: 0 }); // the batch of five again
      expect(tried).toHaveLength(10);
    } finally { spy.mockRestore(); }
    expect(await owedNames()).toHaveLength(4); // the four whose sends failed, tried again after their back-off
  });

  it("staff can resend to one person, which never needs the welcome switch", async () => {
    const p = await person("Ana Rivera", { welcomedAt: new Date("2026-01-01T00:00:00Z") });
    const staff = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000002", label: "reg@club.org" }, ip: "203.0.113.9", permission: "Parents.ReadWrite" };
    expect(await resendWelcome(p.id, staff)).toEqual({ ok: true, link: "setup" });
    expect(sink.messages).toHaveLength(1);
    expect((await audits("parent.welcome.sent"))[0]).toMatchObject({ door: "staff", permission: "Parents.ReadWrite", targetId: p.id });
    expect((await audits("parent.welcome.sent"))[0]!.after).toMatchObject({ resend: true });
    const blocked = await person("Blocked One", { blocked: true }), gone = await person("No Access", { status: "disabled" });
    expect(await resendWelcome(blocked.id, staff)).toEqual({ ok: false, reason: "blocked" });
    expect(await resendWelcome(gone.id, staff)).toEqual({ ok: false, reason: "no_access" });
    expect(await resendWelcome("00000000-0000-4000-8000-00000000dead", staff)).toEqual({ ok: false, reason: "not_found" });
  });

  it("a resend while the parent door is closed emails nobody", async () => {
    await seedParentSettings({ signin: false });
    const p = await person("Ana Rivera");
    expect(await resendWelcome(p.id, admin)).toEqual({ ok: false, reason: "no_access" });
    expect(sink.messages).toEqual([]);
  });

  it("a resend before sign-ins were ever switched on emails nobody either: the door is closed until they are", async () => {
    await db.delete(setting).where(eq(setting.key, "parents.settings"));
    const p = await person("Ana Rivera");
    expect(await resendWelcome(p.id, admin)).toEqual({ ok: false, reason: "no_access" });
    expect(sink.messages).toEqual([]);
  });

  it("switching off sets updated_at on the rows it clears", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Parent 1", { welcomeOwed: true });
    await db.update(parent).set({ updatedAt: new Date("2026-01-01T00:00:00Z") }).where(eq(parent.id, p.id));
    await setWelcome(false, admin);
    expect((await db.select().from(parent).where(eq(parent.id, p.id)))[0]!.updatedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("a failed resend says so and is audited", async () => {
    const p = await person("Bounce");
    sink.rejectRecipient = p.email;
    expect(await resendWelcome(p.id, admin)).toEqual({ ok: false, reason: "mail_failed" });
    expect((await audits("parent.welcome.failed"))[0]!.after).toMatchObject({ resend: true });
  });

  it("the worker's wake sends owed welcomes even when QuickBooks isn't connected", async () => {
    await seedParentSettings({ welcome: true }); await person("Parent 1", { welcomeOwed: true });
    expect((await runDueJobs()).ran).toEqual([{ job: "parents.welcome", ok: true }]);
  });

  // The welcome counts the rows the gate counts (enterableGuardianRows(), src/lib/parents/sessions.ts): a person with no
  // row that counts is marked by no switch, skipped by the worker and left owed, and refused a resend, the same way
  // whatever the reason.
  it("a person whose only family is inactive, or has no active student while that is asked, is not welcomed, and stays owed", async () => {
    await seedParentSettings({ welcome: true });
    const inactive = await person("Inactive Family", { family: "20", welcomeOwed: true });
    await db.update(family).set({ active: false }).where(eq(family.id, inactive.familyId));
    const noStudent = await person("No Student", { family: "30", welcomeOwed: true });
    const withStudent = await person("With Student", { family: "40", welcomeOwed: true });
    await db.insert(student).values({ familyId: withStudent.familyId, name: "Sam", active: true });
    await db.insert(student).values({ familyId: noStudent.familyId, name: "Gone", active: false });
    // With the setting off, a family's students don't matter: only the inactive family's person is skipped.
    expect(await sendOwedWelcomes()).toEqual({ sent: 2, failed: 0 });
    expect(sink.messages.map((m) => m.to[0]!).sort()).toEqual([noStudent.email, withStudent.email].sort());
    expect(await owedNames()).toEqual(["Inactive Family"]);
    // With it on, a family with no active student is skipped too, and its person stays owed.
    sink.messages.length = 0;
    await db.update(parent).set({ welcomeOwed: true, welcomedAt: null, welcomeTriedAt: null });
    // In force only while the stored shape names students (studentsRuleInForce()).
    await storeShape();
    await seedParentSettings({ requireActiveStudents: true });
    expect(await sendOwedWelcomes()).toEqual({ sent: 1, failed: 0 });
    expect(sink.messages.map((m) => m.to[0]!)).toEqual([withStudent.email]);
    expect(await owedNames()).toEqual(["Inactive Family", "No Student"]);
    // A resend is refused them the same way as anyone with no family to sign in to.
    const staff = { actor: { door: "staff" as const, id: null, label: "reg@club.org" }, ip: null, permission: "Parents.ReadWrite" };
    expect(await resendWelcome(inactive.id, staff)).toEqual({ ok: false, reason: "no_access" });
    expect(await resendWelcome(noStudent.id, staff)).toEqual({ ok: false, reason: "no_access" });
    // Once the family has an active student, the welcome still owed goes at the next run.
    await db.insert(student).values({ familyId: noStudent.familyId, name: "Back", active: true });
    expect(await sendOwedWelcomes()).toEqual({ sent: 1, failed: 0 });
    expect(await owedNames()).toEqual(["Inactive Family"]);
  });

  it("switching welcomes on, or sign-ins on with welcomes on, marks only people with a row that counts", async () => {
    await storeShape(); // the students rule is in force only while the shape names students
    await seedParentSettings({ signin: false, requireActiveStudents: true });
    const counts = await person("Counts", { family: "50" });
    await db.insert(student).values({ familyId: counts.familyId, name: "Sam", active: true });
    await person("No Student", { family: "60" });
    const inactive = await person("Inactive Family", { family: "70" });
    await db.update(family).set({ active: false }).where(eq(family.id, inactive.familyId));
    expect(await setWelcome(true, admin)).toEqual({ ok: false, errors: ["Switch parent sign-ins on first."] });
    // A stored value with welcomes on and sign-ins off is read as it is: switching sign-ins on owes the welcomes then.
    await seedParentSettings({ welcome: true });
    expect(await setSignins(true, admin)).toEqual({ ok: true });
    expect(await owedNames()).toEqual(["Counts"]);
    expect((await audits("settings.parents.save")).at(-1)!.after).toMatchObject({ signin: true, welcomeOwed: 1 });
    await db.update(parent).set({ welcomeOwed: false });
    await seedParentSettings({ welcome: false });
    expect(await setWelcome(true, admin)).toEqual({ ok: true });
    expect(await owedNames()).toEqual(["Counts"]);
    expect((await audits("settings.parents.save")).at(-1)!.after).toMatchObject({ welcome: true, owed: 1 });
  });

  // The sign-in release's slice SI-4: the welcome carries a set-up link to a person with no password, made for that mail
  // through the held link's delivery (src/lib/parents/link-delivery.ts), and none to a person with a password.
  /** The person's links that are not spent: unused, or held while a mail is on its way. */
  const unspent = async (parentId: string) => (await linkRows(parentId)).filter((l) => l.usedAt === null || l.usedAt.getTime() === l.createdAt.getTime());
  const STAFF = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000002", label: "reg@club.org" }, ip: "203.0.113.9", permission: "Parents.ReadWrite" };
  /** Every row of every table of the database, as text. */
  const everyRow = async () => {
    const tables = Array.from(await db.execute<{ name: string }>(sql`select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`) as ArrayLike<{ name: string }>);
    const out: string[] = [];
    for (const t of tables) out.push(...Array.from(await db.execute<{ row: string }>(sql.raw(`select t::text as row from "${t.name}" t`)) as ArrayLike<{ row: string }>).map((r) => `${t.name}: ${r.row}`));
    return out;
  };

  it("a welcome to a person with no password carries one set-up link, which works, and is in the mail alone", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Parent 1", { welcomeOwed: true });
    expect(await sendOwedWelcomes()).toEqual({ sent: 1, failed: 0 });
    const tokens = setupTokensIn(sink.messages[0]!.raw);
    expect(tokens).toHaveLength(1);
    const token = tokens[0]!;
    expect(await linkVerdict("setup", token)).toMatchObject({ ok: true, link: { parentId: p.id } });
    expect(mailText(sink.messages[0]!.raw)).toContain("The link works once, for 7 days.");
    // Stored only as its keyed hash; in no audit row, and nowhere else.
    expect((await unspent(p.id)).map((l) => l.tokenHash)).toEqual([hashLinkToken("setup", token)]);
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain(token);
    expect((await everyRow()).filter((r) => r.includes(token))).toEqual([]);
    expect((await audits("parent.welcome.sent"))[0]!.after).toEqual({ to: p.email, mail: "welcome", link: "setup" });
    expect(await audits("parent.password.link_made")).toEqual([expect.objectContaining({ targetId: p.id, door: "system" })]);
  });

  it("a person with a password, or who chose one after being owed, gets the welcome with no link", async () => {
    await seedParentSettings({ welcome: true });
    const has = await person("Has One", { welcomeOwed: true });
    await seedPassword(has.authUserId, "a phrase they chose some time ago");
    const later = await person("Chose Later", { welcomeOwed: true });
    await seedPassword(later.authUserId, "a phrase chosen after the welcome was owed");
    expect(await sendOwedWelcomes()).toEqual({ sent: 2, failed: 0 });
    expect(sink.messages).toHaveLength(2);
    for (const m of sink.messages) {
      expect(setupTokensIn(m.raw)).toEqual([]);
      expect(mailText(m.raw)).toContain("with this email address and your password, at ");
    }
    expect(await db.select().from(parentSigninToken)).toEqual([]);
    expect((await audits("parent.welcome.sent")).map((r) => (r.after as { link: string }).link)).toEqual(["none", "none"]);
    expect(await owedNames()).toEqual([]);
  });

  it("two runs at once welcome each person once and leave one live link each", async () => {
    await seedParentSettings({ welcome: true });
    const people = [await person("Parent 1", { welcomeOwed: true }), await person("Parent 2", { welcomeOwed: true }), await person("Parent 3", { welcomeOwed: true })];
    const [a, b] = await Promise.all([sendOwedWelcomes(), sendOwedWelcomes()]);
    expect(a.sent + b.sent).toBe(3);
    expect(sink.messages).toHaveLength(3);
    for (const p of people) {
      expect(await unspent(p.id)).toHaveLength(1);
      const m = sink.messages.find((x) => x.to[0] === p.email)!;
      expect(await linkVerdict("setup", setupTokensIn(m.raw)[0])).toMatchObject({ ok: true, link: { parentId: p.id } });
    }
  });

  it("a failed send leaves the person owed, writes why the link wasn't put in place, and leaves no link from it", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Bounce", { welcomeOwed: true });
    sink.rejectRecipient = p.email;
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 1 });
    expect(await owedNames()).toEqual(["Bounce"]);
    expect((await audits("parent.password.link_not_sent")).map((r) => r.after)).toEqual([{ purpose: "setup", reason: "mail_failed" }]);
    expect((await audits("parent.welcome.failed"))[0]!.after).toMatchObject({ to: p.email, mail: "welcome", link: "setup" });
    expect(await linkRows(p.id)).toEqual([]);
  });

  // No mail the portal sends by itself destroys a link that still works (the lead's decision after the second review).
  it("a person who asked on the request page, reached by the worker more than a minute later, gets one welcome with no link, and the link they asked for still works", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Asked First", { welcomeOwed: true });
    await (await askForPasswordLink(p.email, null, new Date(Date.now() - 2 * RESEND_WAIT))).delivery;
    expect(sink.messages).toHaveLength(1);
    const asked = setupTokensIn(sink.messages[0]!.raw)[0]!;
    expect(await sendOwedWelcomes()).toEqual({ sent: 1, failed: 0 });
    expect(sink.messages).toHaveLength(2);
    const welcome = sink.messages[1]!;
    expect(welcome.to).toEqual([p.email]);
    expect(setupTokensIn(welcome.raw)).toEqual([]);
    expect(mailText(welcome.raw)).toContain("A link to choose your password was emailed to you earlier, and it still works.");
    expect(await linkVerdict("setup", asked)).toMatchObject({ ok: true, link: { parentId: p.id } });
    expect((await unspent(p.id)).map((l) => l.tokenHash)).toEqual([hashLinkToken("setup", asked)]);
    expect((await audits("parent.welcome.sent")).map((r) => r.after)).toEqual([{ to: p.email, mail: "welcome", link: "earlier" }]);
    expect(await owedNames()).toEqual([]);
    // Welcomed once: the next wake sends nothing.
    expect(await sendOwedWelcomes(new Date(Date.now() + WELCOME_RETRY_MS + 1000))).toEqual({ sent: 0, failed: 0 });
  });

  it("a welcome tried again after its first mail's link was put in place sends no second link", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Parent 1", { welcomeOwed: true });
    const real = linkDelivery.deliverHeldLink;
    // The first try's mail goes and its link is put in place, then the process stops before the welcome is recorded.
    const spy = vi.spyOn(linkDelivery, "deliverHeldLink").mockImplementationOnce(async (l, o) => { await real(l, o); throw new Error("the process stopped here"); });
    try { await expect(sendOwedWelcomes()).rejects.toThrow("the process stopped here"); } finally { spy.mockRestore(); }
    expect(await owedNames()).toEqual(["Parent 1"]);
    const first = setupTokensIn(sink.messages[0]!.raw)[0]!;
    expect(await sendOwedWelcomes(new Date(Date.now() + WELCOME_RETRY_MS + 1000))).toEqual({ sent: 1, failed: 0 });
    expect(sink.messages).toHaveLength(2);
    expect(setupTokensIn(sink.messages[1]!.raw)).toEqual([]);
    expect(await linkVerdict("setup", first)).toMatchObject({ ok: true, link: { parentId: p.id } });
    expect(await audits("parent.password.link_made")).toHaveLength(1);
    expect((await audits("parent.welcome.sent")).map((r) => (r.after as { link: string }).link)).toEqual(["earlier"]);
  });

  it("a welcome's link is made at the person's turn, not the wake's start, so a resend just after it is held off", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Parent 1", { welcomeOwed: true });
    const wakeStarted = new Date(Date.now() - 5 * 60_000); // a long batch: this person's turn came five minutes in
    expect(await sendOwedWelcomes(wakeStarted)).toEqual({ sent: 1, failed: 0 });
    const [link] = await unspent(p.id);
    expect(link!.createdAt.getTime()).toBeGreaterThan(Date.now() - RESEND_WAIT);
    expect(link!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 7 * 24 * 3_600_000 - RESEND_WAIT);
    expect(await resendWelcome(p.id, STAFF)).toEqual({ ok: false, reason: "on_its_way" });
    expect(sink.messages).toHaveLength(1);
  });

  it("a second Resend within a minute of the first is refused, and the link the first one mailed still works", async () => {
    const p = await person("Ana Rivera", { welcomedAt: new Date("2026-01-01T00:00:00Z") });
    expect(await resendWelcome(p.id, STAFF)).toEqual({ ok: true, link: "setup" });
    const first = setupTokensIn(sink.messages[0]!.raw)[0]!;
    expect(await resendWelcome(p.id, STAFF)).toEqual({ ok: false, reason: "on_its_way" });
    // A slow send: the link was made more than a minute before the press, but its welcome went less than one ago.
    await db.update(parentSigninToken).set({ createdAt: new Date(Date.now() - 2 * RESEND_WAIT) }).where(eq(parentSigninToken.parentId, p.id));
    expect(await resendWelcome(p.id, STAFF)).toEqual({ ok: false, reason: "on_its_way" });
    expect(sink.messages).toHaveLength(1);
    expect(await linkVerdict("setup", first)).toMatchObject({ ok: true });
    // A minute after the welcome went, a resend sends a fresh link, as staff mean it to.
    await db.update(parent).set({ welcomedAt: new Date(Date.now() - 2 * RESEND_WAIT) }).where(eq(parent.id, p.id));
    expect(await resendWelcome(p.id, STAFF)).toEqual({ ok: true, link: "setup" });
    expect(await linkVerdict("setup", first)).toMatchObject({ ok: false, reason: "unknown" });
  });

  // An end of the person's sign-in while the welcome is on its way deletes the held link with the unused ones, and the
  // check under the lock then refuses to put anything in place.
  const ENDS: Record<string, { end: (p: Awaited<ReturnType<typeof person>>) => Promise<unknown>; reason: string }> = {
    "blocked": { end: (p) => blockPerson(p.id, "Custody order on file.", STAFF), reason: "blocked" },
    "removed from their family": { end: (p) => removeGuardian(p.guardianId, "Moved away.", STAFF), reason: "no_enabled_guardian" },
    "switched off with sign-ins": { end: () => setSignins(false, admin), reason: "signins_off" },
  };
  for (const [how, { end, reason }] of Object.entries(ENDS)) {
    it(`a person ${how} while their welcome is on its way gets no live link from it`, async () => {
      await seedParentSettings({ welcome: true });
      const p = await person("Parent 1", { welcomeOwed: true });
      const real = sendModule.sendMail;
      const spy = vi.spyOn(sendModule, "sendMail").mockImplementation(async (m, o) => {
        if (m.to === p.email) await end(p);
        return real(m, o);
      });
      try { expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 1 }); } finally { spy.mockRestore(); }
      expect(sink.messages).toHaveLength(1);
      expect(await unspent(p.id)).toEqual([]);
      expect(await linkVerdict("setup", setupTokensIn(sink.messages[0]!.raw)[0])).toMatchObject({ ok: false, reason: "unknown" });
      expect((await audits("parent.password.link_not_sent")).map((r) => (r.after as { reason: string }).reason)).toEqual([reason]);
      expect((await audits("parent.welcome.failed"))[0]!.after).toMatchObject({ error: "link_not_put_in_place", reason });
      expect(await audits("parent.welcome.sent")).toEqual([]);
    });
  }

  it("a resend gives a person with no password a fresh link, which replaces their unused one only once the mail has gone", async () => {
    const p = await person("Ana Rivera", { welcomedAt: new Date("2026-01-01T00:00:00Z") });
    const earlier = await mintLink(p.id, "setup", new Date(Date.now() - 2 * RESEND_WAIT)); // past the resend wait
    const real = sendModule.sendMail;
    const seen: boolean[] = [];
    const spy = vi.spyOn(sendModule, "sendMail").mockImplementation(async (m, o) => {
      seen.push((await linkVerdict("setup", earlier)).ok); // while the mail is on its way, the earlier link still works
      return real(m, o);
    });
    try { expect(await resendWelcome(p.id, STAFF)).toEqual({ ok: true, link: "setup" }); } finally { spy.mockRestore(); }
    expect(seen).toEqual([true]);
    const fresh = setupTokensIn(sink.messages[0]!.raw)[0]!;
    expect(fresh).not.toBe(earlier);
    expect(await linkVerdict("setup", fresh)).toMatchObject({ ok: true, link: { parentId: p.id } });
    expect(await linkVerdict("setup", earlier)).toMatchObject({ ok: false, reason: "unknown" });
    expect(await unspent(p.id)).toHaveLength(1);
    // Every row is the staff member's.
    expect((await audits("parent.password.link_made")).at(-1)).toMatchObject({ door: "staff", actorId: STAFF.actor.id, after: expect.objectContaining({ replaced: 1 }) });
    expect((await audits("parent.welcome.sent"))[0]).toMatchObject({ door: "staff", permission: "Parents.ReadWrite", after: { to: p.email, mail: "welcome", link: "setup", resend: true } });
  });

  it("a resend whose mail fails leaves the earlier link working and says so", async () => {
    const p = await person("Bounce");
    const earlier = await mintLink(p.id, "setup", new Date(Date.now() - 2 * RESEND_WAIT)); // past the resend wait
    sink.rejectRecipient = p.email;
    expect(await resendWelcome(p.id, STAFF)).toEqual({ ok: false, reason: "mail_failed" });
    expect(await linkVerdict("setup", earlier)).toMatchObject({ ok: true });
    expect(await unspent(p.id)).toHaveLength(1);
  });

  it("a resend to a person with a password sends the welcome with no link", async () => {
    const p = await person("Has One", { welcomedAt: new Date("2026-01-01T00:00:00Z") });
    await seedPassword(p.authUserId, "a phrase they chose some time ago");
    expect(await resendWelcome(p.id, STAFF)).toEqual({ ok: true, link: "none" });
    expect(setupTokensIn(sink.messages[0]!.raw)).toEqual([]);
    expect(await linkRows(p.id)).toEqual([]);
  });

  // The Admin's press (oweSetupMails(), src/lib/parents/switches.ts): people welcomed before this release have no
  // password, and nothing else emails them a link.
  it("the press marks exactly those who can sign in with no password, refuses while a switch is off, and is audited once", async () => {
    await seedParentSettings({ welcome: true });
    const before = new Date("2026-01-01T00:00:00Z");
    const welcomedBefore = await person("Welcomed Before", { welcomedAt: before });
    const neverWelcomed = await person("Never Welcomed");
    await person("Blocked One", { welcomedAt: before, blocked: true });
    await person("No Access", { welcomedAt: before, status: "disabled" });
    const has = await person("Has One", { welcomedAt: before });
    await seedPassword(has.authUserId, "a phrase they chose some time ago");
    await person("Owed Already", { welcomeOwed: true });
    const justSent = await person("Just Sent", { welcomedAt: before });
    await mintLink(justSent.id, "setup");
    await seedParentSettings({ welcome: false });
    expect(await oweSetupMails(admin)).toEqual({ ok: false, errors: [SETUP_MAILS_NEED_SWITCHES] });
    await seedParentSettings({ welcome: true, signin: false });
    expect(await oweSetupMails(admin)).toEqual({ ok: false, errors: [SETUP_MAILS_NEED_SWITCHES] });
    expect(await audits("parent.setup_mail.owed")).toEqual([]);
    await seedParentSettings({ welcome: true, signin: true });
    expect(await oweSetupMails(admin)).toEqual({ ok: true, owed: 2 });
    expect(await owedNames()).toEqual(["Never Welcomed", "Owed Already", "Welcomed Before"]);
    // A second press while they are still owed marks nobody twice.
    expect(await oweSetupMails(admin)).toEqual({ ok: true, owed: 0 });
    expect((await audits("parent.setup_mail.owed")).map((r) => r.after)).toEqual([{ owed: 2 }, { owed: 0 }]);
    expect((await audits("parent.setup_mail.owed"))[0]).toMatchObject({ actorId: admin.actor.id, permission: "Settings.Parents.ReadWrite", targetType: "setting", targetId: "parents.settings" });
    expect(sink.messages).toEqual([]); // the press itself sends nothing

    // The worker sends the mail for those welcomed before, and the welcome to those never welcomed, each with a link.
    expect(await sendOwedWelcomes()).toEqual({ sent: 3, failed: 0 });
    const textTo = (email: string) => mailText(sink.messages.find((m) => m.to[0] === email)!.raw);
    expect(textTo(welcomedBefore.email)).toContain("with this email address and a password. To choose your password, open this link:");
    expect(textTo(welcomedBefore.email)).toMatch(/Subject: Choose your password for /);
    expect(textTo(neverWelcomed.email)).toMatch(/Subject: You can now sign in to /);
    for (const p of [welcomedBefore, neverWelcomed]) {
      const token = setupTokensIn(sink.messages.find((m) => m.to[0] === p.email)!.raw)[0];
      expect(await linkVerdict("setup", token)).toMatchObject({ ok: true, link: { parentId: p.id } });
    }
    expect((await audits("parent.welcome.sent")).find((r) => r.targetId === welcomedBefore.id)!.after).toMatchObject({ mail: "choose_password", link: "setup" });
    expect(await owedNames()).toEqual([]);
  });

  it("a press mail to someone who chose a password meanwhile is not sent, and says why", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Welcomed Before", { welcomedAt: new Date("2026-01-01T00:00:00Z") });
    expect(await oweSetupMails(admin)).toEqual({ ok: true, owed: 1 });
    await seedPassword(p.authUserId, "a phrase chosen after the press");
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 0 });
    expect(sink.messages).toEqual([]);
    expect((await audits("parent.welcome.skipped")).map((r) => [r.targetId, r.after])).toEqual([[p.id, { to: p.email, mail: "choose_password", reason: "has_password" }]]);
    expect(await owedNames()).toEqual([]);
    expect(await db.select().from(parentSigninToken)).toEqual([]);
  });

  it("a press mail waits, owed, while a set-up link sent a moment ago may still be unread", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Welcomed Before", { welcomedAt: new Date("2026-01-01T00:00:00Z") });
    expect(await oweSetupMails(admin)).toEqual({ ok: true, owed: 1 });
    const asked = await mintLink(p.id, "setup"); // asked for on "Set up or reset my password" just after the press
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 0 });
    expect(sink.messages).toEqual([]);
    expect(await owedNames()).toEqual(["Welcomed Before"]);
    expect(await linkVerdict("setup", asked)).toMatchObject({ ok: true });
    expect(await db.select().from(parentSigninToken).where(and(eq(parentSigninToken.parentId, p.id), isNull(parentSigninToken.usedAt)))).toHaveLength(1);
  });

  // What the review of slice SI-4 found.
  it("the press doesn't count someone a welcome mailed while their link works, and counts them again once it runs out unused", async () => {
    await seedParentSettings({ welcome: true });
    await person("Parent 1", { welcomeOwed: true });
    expect(await sendOwedWelcomes()).toEqual({ sent: 1, failed: 0 });
    const aWhileLater = new Date(Date.now() + 2 * RESEND_WAIT);
    expect(await setupMailsToOwe(aWhileLater)).toBe(0);
    expect(await oweSetupMails(admin, aWhileLater)).toEqual({ ok: true, owed: 0 });
    expect(await owedNames()).toEqual([]);
    expect(await setupMailsToOwe(new Date(Date.now() + 8 * 24 * 3_600_000))).toBe(1); // past the link's 7 days
  });

  it("a press mail to someone holding a set-up link that still works, asked for since the press, is not sent, and says why", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Welcomed Before", { welcomedAt: new Date("2026-01-01T00:00:00Z") });
    expect(await oweSetupMails(admin)).toEqual({ ok: true, owed: 1 });
    const asked = await mintLink(p.id, "setup", new Date(Date.now() - 2 * RESEND_WAIT));
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 0 });
    expect(sink.messages).toEqual([]);
    expect((await audits("parent.welcome.skipped")).map((r) => [r.targetId, r.after])).toEqual([[p.id, { to: p.email, mail: "choose_password", reason: "has_live_link" }]]);
    expect(await owedNames()).toEqual([]);
    expect(await linkVerdict("setup", asked)).toMatchObject({ ok: true });
  });

  it("while another set-up link is on its way to the person, the worker waits and a resend is refused, and the link they held still works", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Parent 1", { welcomeOwed: true });
    const earlier = await mintLink(p.id, "setup", new Date(Date.now() - 2 * RESEND_WAIT));
    await db.transaction((tx) => holdSigninLink(tx, { parentId: p.id, purpose: "setup", now: new Date() })); // an ask's mail, going now
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 0 });
    expect(await owedNames()).toEqual(["Parent 1"]);
    expect(await resendWelcome(p.id, STAFF)).toEqual({ ok: false, reason: "on_its_way" });
    expect(sink.messages).toEqual([]);
    expect(await linkVerdict("setup", earlier)).toMatchObject({ ok: true });
  });

  it("a person who chooses a password while their welcome is on its way is welcomed, with no live link from it", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Parent 1", { welcomeOwed: true });
    const real = sendModule.sendMail;
    const spy = vi.spyOn(sendModule, "sendMail").mockImplementation(async (m, o) => {
      if (m.to === p.email) await seedPassword(p.authUserId, "a phrase chosen from an earlier link");
      return real(m, o);
    });
    try { expect(await sendOwedWelcomes()).toEqual({ sent: 1, failed: 0 }); } finally { spy.mockRestore(); }
    expect((await audits("parent.password.link_not_sent")).map((r) => r.after)).toEqual([{ purpose: "setup", reason: "has_password" }]);
    expect((await audits("parent.welcome.sent")).map((r) => r.after)).toEqual([{ to: p.email, mail: "welcome", link: "not_in_place" }]);
    expect(await owedNames()).toEqual([]);
    expect(await unspent(p.id)).toEqual([]);
  });

  it("a welcome whose person's address changes while it is on its way puts no link in place, stays owed, and goes to the new address later", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Parent 1", { welcomeOwed: true });
    const real = sendModule.sendMail;
    const spy = vi.spyOn(sendModule, "sendMail").mockImplementation(async (m, o) => {
      if (m.to === p.email) await db.update(parent).set({ email: "new.address@example.com" }).where(eq(parent.id, p.id));
      return real(m, o);
    });
    try { expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 1 }); } finally { spy.mockRestore(); }
    expect((await audits("parent.welcome.failed"))[0]!.after).toMatchObject({ error: "link_not_put_in_place", reason: "unknown_email" });
    expect(await unspent(p.id)).toEqual([]);
    expect(await owedNames()).toEqual(["Parent 1"]);
    expect(await sendOwedWelcomes(new Date(Date.now() + WELCOME_RETRY_MS + 1000))).toEqual({ sent: 1, failed: 0 });
    expect(sink.messages.at(-1)!.to[0]).toBe("new.address@example.com");
  });

  it("under Strict the worker's welcome says to ask the club once the link runs out", async () => {
    await seedParentSettings({ welcome: true, level: "strict" });
    await person("Parent 1", { welcomeOwed: true });
    expect(await sendOwedWelcomes()).toEqual({ sent: 1, failed: 0 });
    expect(mailText(sink.messages[0]!.raw)).toContain("please ask the club to send this email again.");
    expect(setupTokensIn(sink.messages[0]!.raw)).toHaveLength(1);
  });

  it("a resend is refused for a person with no sign-in account", async () => {
    const p = await person("No Account");
    await db.delete(parentAuthUser).where(eq(parentAuthUser.parentId, p.id));
    expect(await resendWelcome(p.id, STAFF)).toEqual({ ok: false, reason: "no_access" });
    expect(sink.messages).toEqual([]);
  });

  it("a resend whose person is blocked while it is on its way says its link won't work, and leaves no live link", async () => {
    const p = await person("Parent 1");
    const earlier = await mintLink(p.id, "setup", new Date(Date.now() - 2 * RESEND_WAIT));
    const real = sendModule.sendMail;
    const spy = vi.spyOn(sendModule, "sendMail").mockImplementation(async (m, o) => {
      if (m.to === p.email) await blockPerson(p.id, "Custody order on file.", STAFF);
      return real(m, o);
    });
    try { expect(await resendWelcome(p.id, STAFF)).toEqual({ ok: false, reason: "link_not_in_place" }); } finally { spy.mockRestore(); }
    expect(await unspent(p.id)).toEqual([]);
    expect(await linkVerdict("setup", earlier)).toMatchObject({ ok: false });
  });

  it("a block and an unblock after the link was put in place, before the welcome was recorded, leave the person owed, not welcomed with a dead link", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Parent 1", { welcomeOwed: true });
    const real = linkDelivery.deliverHeldLink;
    const spy = vi.spyOn(linkDelivery, "deliverHeldLink").mockImplementation(async (l, o) => {
      const d = await real(l, o);
      await blockPerson(p.id, "Custody order on file.", STAFF);
      await unblockPerson(p.id, STAFF);
      return d;
    });
    try { expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 1 }); } finally { spy.mockRestore(); }
    expect(await unspent(p.id)).toEqual([]);
    expect((await audits("parent.welcome.failed"))[0]!.after).toMatchObject({ error: "link_not_put_in_place", reason: "changed_while_mailing" });
    expect(await audits("parent.welcome.sent")).toEqual([]);
    const [row] = await db.select().from(parent).where(eq(parent.id, p.id));
    expect(row).toMatchObject({ welcomedAt: null, welcomeOwed: true });
  });

  it("a block and an unblock while a welcome saying the earlier link still works is on its way leave the person owed, not welcomed with no working link", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Asked First", { welcomeOwed: true });
    await mintLink(p.id, "setup", new Date(Date.now() - 2 * RESEND_WAIT)); // asked for on the request page, two minutes ago
    const real = sendModule.sendMail;
    const spy = vi.spyOn(sendModule, "sendMail").mockImplementation(async (m, o) => {
      if (m.to === p.email) { await blockPerson(p.id, "Custody order on file.", STAFF); await unblockPerson(p.id, STAFF); }
      return real(m, o);
    });
    try { expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 1 }); } finally { spy.mockRestore(); }
    expect(sink.messages).toHaveLength(1);
    expect(setupTokensIn(sink.messages[0]!.raw)).toEqual([]);
    expect(mailText(sink.messages[0]!.raw)).toContain("A link to choose your password was emailed to you earlier, and it still works.");
    expect((await audits("parent.welcome.failed"))[0]!.after).toMatchObject({ mail: "welcome", link: "earlier", error: "earlier_link_gone", reason: "changed_while_mailing" });
    expect(await audits("parent.welcome.sent")).toEqual([]);
    const [row] = await db.select().from(parent).where(eq(parent.id, p.id));
    expect(row).toMatchObject({ welcomedAt: null, welcomeOwed: true });
    // Tried again after the back-off, with no link that works, the welcome carries a new one.
    expect(await sendOwedWelcomes(new Date(Date.now() + WELCOME_RETRY_MS + 1000))).toEqual({ sent: 1, failed: 0 });
    const token = setupTokensIn(sink.messages[1]!.raw)[0]!;
    expect(await linkVerdict("setup", token)).toMatchObject({ ok: true, link: { parentId: p.id } });
    expect((await audits("parent.welcome.sent")).map((r) => (r.after as { link: string }).link)).toEqual(["setup"]);
  });

  it("a press mail whose send fails stays owed, and is the same mail when it is tried again", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Welcomed Before", { welcomedAt: new Date("2026-01-01T00:00:00Z") });
    expect(await oweSetupMails(admin)).toEqual({ ok: true, owed: 1 });
    sink.rejectRecipient = p.email;
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 1 });
    expect((await audits("parent.welcome.failed"))[0]!.after).toMatchObject({ mail: "choose_password", link: "setup" });
    expect(await owedNames()).toEqual(["Welcomed Before"]);
    sink.rejectRecipient = null;
    // The server refused the address, so it is tried again a day on (holdOffRefused()).
    expect(await sendOwedWelcomes(new Date(Date.now() + REFUSED_RETRY_MS + 1000))).toEqual({ sent: 1, failed: 0 });
    expect(mailText(sink.messages.filter((m) => m.to[0] === p.email).at(-1)!.raw)).toMatch(/Subject: Choose your password for /);
    expect(await owedNames()).toEqual([]);
  });

  // The earlier-link welcome needs a link with a day left (EARLIER_LINK_MIN_LIFE_MS): one that might run out before the
  // mail is read is replaced by a new link, once the welcome's mail has gone.
  const HOUR = 60 * 60_000;
  /** A set-up link asked for on the request page long enough ago that `left` of its life remains. */
  const linkWithLeft = (parentId: string, left: number) => mintLink(parentId, "setup", new Date(Date.now() - LINK_LIFE_MS.setup + left));

  it("a set-up link with a day and more left is the earlier link the welcome says still works", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Asked First", { welcomeOwed: true });
    const earlier = await linkWithLeft(p.id, EARLIER_LINK_MIN_LIFE_MS + HOUR);
    expect(await sendOwedWelcomes()).toEqual({ sent: 1, failed: 0 });
    expect(setupTokensIn(sink.messages[0]!.raw)).toEqual([]);
    expect(mailText(sink.messages[0]!.raw)).toContain("A link to choose your password was emailed to you earlier, and it still works.");
    expect(await linkVerdict("setup", earlier)).toMatchObject({ ok: true });
    expect((await audits("parent.welcome.sent")).map((r) => r.after)).toEqual([{ to: p.email, mail: "welcome", link: "earlier" }]);
  });

  it("a set-up link with less than a day left gets a welcome with a new link, which takes its place once the mail has gone", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Asked Long Ago", { welcomeOwed: true });
    const earlier = await linkWithLeft(p.id, EARLIER_LINK_MIN_LIFE_MS - HOUR);
    const real = sendModule.sendMail;
    const seen: boolean[] = [];
    const spy = vi.spyOn(sendModule, "sendMail").mockImplementation(async (m, o) => {
      seen.push((await linkVerdict("setup", earlier)).ok); // while the welcome is on its way, the earlier link still works
      return real(m, o);
    });
    try { expect(await sendOwedWelcomes()).toEqual({ sent: 1, failed: 0 }); } finally { spy.mockRestore(); }
    expect(seen).toEqual([true]);
    const [fresh] = setupTokensIn(sink.messages[0]!.raw);
    expect(await linkVerdict("setup", fresh!)).toMatchObject({ ok: true, link: { parentId: p.id } });
    expect(await linkVerdict("setup", earlier)).toMatchObject({ ok: false });
    expect((await audits("parent.welcome.sent")).map((r) => (r.after as { link: string }).link)).toEqual(["setup"]);
  });

  it("a press mail to someone whose set-up link, asked for since the press, has less than a day left goes with a new link, which takes its place once the mail has gone", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Welcomed Before", { welcomedAt: new Date("2026-01-01T00:00:00Z") });
    expect(await oweSetupMails(admin)).toEqual({ ok: true, owed: 1 });
    const earlier = await linkWithLeft(p.id, EARLIER_LINK_MIN_LIFE_MS - HOUR);
    expect(await sendOwedWelcomes()).toEqual({ sent: 1, failed: 0 });
    expect(await audits("parent.welcome.skipped")).toEqual([]);
    expect(mailText(sink.messages[0]!.raw)).toMatch(/Subject: Choose your password for /);
    const [fresh] = setupTokensIn(sink.messages[0]!.raw);
    expect(await linkVerdict("setup", fresh!)).toMatchObject({ ok: true, link: { parentId: p.id } });
    expect(await linkVerdict("setup", earlier)).toMatchObject({ ok: false });
    expect((await audits("parent.welcome.sent")).map((r) => r.after)).toEqual([{ to: p.email, mail: "choose_password", link: "setup" }]);
    expect(await owedNames()).toEqual([]);
  });

  it("the check after the send holds the earlier link to the same day: one with less left by then leaves the person owed, and the next try carries a new link", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Asked First", { welcomeOwed: true });
    await linkWithLeft(p.id, EARLIER_LINK_MIN_LIFE_MS + HOUR);
    const real = sendModule.sendMail;
    // While the mail goes, the link comes to have less than a day left (as if the mail took that long to go).
    const spy = vi.spyOn(sendModule, "sendMail").mockImplementation(async (m, o) => {
      await db.update(parentSigninToken).set({ expiresAt: new Date(Date.now() + EARLIER_LINK_MIN_LIFE_MS - HOUR) }).where(eq(parentSigninToken.parentId, p.id));
      return real(m, o);
    });
    try { expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 1 }); } finally { spy.mockRestore(); }
    expect((await audits("parent.welcome.failed"))[0]!.after).toMatchObject({ link: "earlier", error: "earlier_link_gone", reason: "runs_out_within_a_day" });
    expect(await owedNames()).toEqual(["Asked First"]);
    expect(await sendOwedWelcomes(new Date(Date.now() + WELCOME_RETRY_MS + 1000))).toEqual({ sent: 1, failed: 0 });
    const token = setupTokensIn(sink.messages[1]!.raw)[0]!;
    expect(await linkVerdict("setup", token)).toMatchObject({ ok: true, link: { parentId: p.id } });
    expect((await audits("parent.welcome.sent")).map((r) => (r.after as { link: string }).link)).toEqual(["setup"]);
  });
});
