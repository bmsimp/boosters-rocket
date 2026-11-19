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

import { eq, sql } from "drizzle-orm";
import * as sendModule from "@/lib/mail/send";
import { db } from "@/lib/db/client";
import { auditLog, family, parent, parentSigninToken, setting, student } from "@/lib/db/schema";
import { runDueJobs } from "@/lib/jobs/runner";
import { blockPerson } from "@/lib/parents/people";
import { removeGuardian } from "@/lib/parents/guardians";
import { hashLinkToken, linkVerdict } from "@/lib/parents/signin-links";
import { setSignins, setWelcome } from "@/lib/parents/switches";
import { sendOwedWelcomes, resendWelcome, WELCOME_RETRY_MS } from "@/lib/parents/welcome";
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

  it("a failed send is recorded, tried again only after 15 minutes, and holds nobody else up", async () => {
    await seedParentSettings({ welcome: true });
    const bad = await person("Bounce", { welcomeOwed: true }); await person("Fine", { welcomeOwed: true });
    sink.rejectRecipient = bad.email; // the sink refuses this one address
    expect(await sendOwedWelcomes()).toEqual({ sent: 1, failed: 1 });
    expect((await audits("parent.welcome.failed"))[0]).toMatchObject({ targetId: bad.id });
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 0 }); // too soon to retry
    sink.rejectRecipient = null;
    expect(await sendOwedWelcomes(new Date(Date.now() + WELCOME_RETRY_MS + 1000))).toEqual({ sent: 1, failed: 0 });
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

  it("a failed send leaves the person owed, writes why the link wasn't put in place, and leaves the link they held working", async () => {
    await seedParentSettings({ welcome: true });
    const p = await person("Bounce", { welcomeOwed: true });
    const earlier = await mintLink(p.id, "setup", new Date(Date.now() - 2 * RESEND_WAIT));
    sink.rejectRecipient = p.email;
    expect(await sendOwedWelcomes()).toEqual({ sent: 0, failed: 1 });
    expect(await owedNames()).toEqual(["Bounce"]);
    expect((await audits("parent.password.link_not_sent")).map((r) => r.after)).toEqual([{ purpose: "setup", reason: "mail_failed" }]);
    expect((await audits("parent.welcome.failed"))[0]!.after).toMatchObject({ to: p.email, mail: "welcome", link: "setup" });
    expect(await linkVerdict("setup", earlier)).toMatchObject({ ok: true });
    expect((await linkRows(p.id)).map((l) => l.tokenHash)).toEqual([hashLinkToken("setup", earlier)]);
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
    const earlier = await mintLink(p.id, "setup");
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
    const earlier = await mintLink(p.id, "setup");
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
});
