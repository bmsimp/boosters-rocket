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

import { eq } from "drizzle-orm";
import * as sendModule from "@/lib/mail/send";
import { db } from "@/lib/db/client";
import { auditLog, parent, setting } from "@/lib/db/schema";
import { runDueJobs } from "@/lib/jobs/runner";
import { setWelcome } from "@/lib/parents/switches";
import { sendOwedWelcomes, resendWelcome, WELCOME_RETRY_MS } from "@/lib/parents/welcome";
import { resetDb, seedParent, seedGuardian, seedWorkingMail } from "../helpers/db";
import { seedParentSettings } from "../helpers/roster-cache";
import { startMailSink, type MailSink } from "../helpers/mail-sink";
import { localhostCertificate } from "../helpers/tls";

const admin = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000001", label: "admin@club.org" }, ip: null, permission: "Settings.Parents.ReadWrite" };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const person = async (name: string, o: { family?: string; welcomedAt?: Date | null; welcomeOwed?: boolean; blocked?: boolean; status?: "invited" | "active" | "disabled" } = {}) => {
  const p = await seedParent({ name, welcomedAt: o.welcomedAt ?? null, welcomeOwed: o.welcomeOwed ?? false, blocked: o.blocked ?? false });
  await seedGuardian({ parentId: p.id, familyQboId: o.family ?? "10", status: o.status ?? "invited" });
  return p;
};

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
    await seedParentSettings({ signin: true, everEnabled: true });
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
    expect(JSON.stringify(sent)).not.toContain("We'll email you a code"); // no email body in the audit log
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
    expect(await resendWelcome(p.id, staff)).toEqual({ ok: true });
    expect(sink.messages).toHaveLength(1);
    expect((await audits("parent.welcome.sent"))[0]).toMatchObject({ door: "staff", permission: "Parents.ReadWrite", targetId: p.id });
    expect((await audits("parent.welcome.sent"))[0]!.after).toMatchObject({ resend: true });
    const blocked = await person("Blocked One", { blocked: true }), gone = await person("No Access", { status: "disabled" });
    expect(await resendWelcome(blocked.id, staff)).toEqual({ ok: false, reason: "blocked" });
    expect(await resendWelcome(gone.id, staff)).toEqual({ ok: false, reason: "no_access" });
    expect(await resendWelcome("00000000-0000-4000-8000-00000000dead", staff)).toEqual({ ok: false, reason: "not_found" });
  });

  it("a resend while the parent door is closed emails nobody", async () => {
    await seedParentSettings({ signin: false, everEnabled: true });
    const p = await person("Ana Rivera");
    expect(await resendWelcome(p.id, admin)).toEqual({ ok: false, reason: "no_access" });
    expect(sink.messages).toEqual([]);
  });

  it("a resend before sign-ins were ever switched on still goes", async () => {
    await seedParentSettings({ signin: false, everEnabled: false });
    const p = await person("Ana Rivera");
    expect(await resendWelcome(p.id, admin)).toEqual({ ok: true });
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
});
