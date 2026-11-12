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
import { db } from "@/lib/db/client";
import { auditLog, heldAddress, role, roleAssignment, roleRule, setting } from "@/lib/db/schema";
import { runDueJobs } from "@/lib/jobs/runner";
import * as reconcileModule from "@/lib/parents/reconcile";
import { runReconcile } from "../helpers/reconcile";
import { reviewWaiting, sendReviewNotice, REVIEW_NOTICE_KEY } from "@/lib/parents/review-notice";
import { decideHold, reverseHold } from "@/lib/parents/holds";
import { resetDb, seedStaff, seedWorkingMail } from "../helpers/db";
import { seedCache, seedShape, seedParentSettings, SIGNINS_ON, fam, par } from "../helpers/roster-cache";
import { startMailSink, type MailSink } from "../helpers/mail-sink";
import { localhostCertificate } from "../helpers/tls";

const TWO = [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", "ana@example.com"), fam("20", "Chen Family"), par("21", "Ana Rivera", "20", "ana@example.com")];
const MORE = [...TWO, fam("30", "Third Family"), par("31", "Sam Lee", "30", "sam@example.com"), fam("40", "Fourth Family"), par("41", "Sam Lee", "40", "sam@example.com")];
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const hours = (n: number) => new Date(Date.now() + n * 3_600_000);
// The sink keeps the raw MIME, whose quoted-printable encoding breaks long lines: join them again before looking inside.
const body = (raw: string) => raw.replace(/=\r?\n/g, "");

let tls: { key: string; cert: string };
let sink: MailSink;
beforeAll(async () => { tls = await localhostCertificate(); tlsHolder.cert = tls.cert; sink = await startMailSink({ secure: true, ...tls }); });
afterAll(async () => { await sink.close(); });

describe("the staff review notice", () => {
  let reviewer: Awaited<ReturnType<typeof seedStaff>>;
  const reviewerRole = async (staffId: string, key: string) => {
    const [r] = await db.insert(role).values({ key, name: key }).returning();
    await db.insert(roleRule).values({ roleId: r!.id, kind: "include", pattern: "Parents.*" });
    await db.insert(roleAssignment).values({ roleId: r!.id, staffUserId: staffId });
  };
  beforeEach(async () => {
    await resetDb();
    sink.messages.length = 0;
    sink.rejectRecipient = null;
    await seedWorkingMail({ method: "smtp", host: "127.0.0.1", port: sink.port, security: "tls", username: "sender", from: "boosters@example.org",
      passwordCiphertext: "unused", passwordKeyId: "unused" });
    await seedShape(); await seedParentSettings(SIGNINS_ON);
    reviewer = await seedStaff({ email: "reg@club.org", name: "Reg Istrar" });
    await reviewerRole(reviewer.id, "parents");
    await seedStaff({ email: "volunteer@club.org" });                                  // no permission: never emailed
    await seedStaff({ email: "gone@club.org", admin: true, status: "disabled" });      // disabled: never emailed
  });

  it("counts what is waiting, and nothing while sign-ins are off", async () => {
    await seedCache(TWO);
    expect(await reviewWaiting()).toBe(1);
    await seedParentSettings({ signin: false });
    expect(await reviewWaiting()).toBe(0);
  });

  it("reads the setting before building the roster: nothing is worked out while sign-ins or review emails are off", async () => {
    await seedCache(TWO); await runReconcile({ cause: "test" });
    const spy = vi.spyOn(reconcileModule, "loadDecision");
    try {
      await seedParentSettings({ signin: false });
      expect(await reviewWaiting()).toBe(0);
      expect(await sendReviewNotice()).toEqual({ sent: 0, newItems: 0 });
      await seedParentSettings({ signin: true, reviewEmails: false });
      expect(await sendReviewNotice()).toEqual({ sent: 0, newItems: 0 });
      expect(spy).not.toHaveBeenCalled();
      expect(await reviewWaiting()).toBe(1);                                  // the home notice still counts
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });

  it("emails each person who can act, once per item, with numbers and a link only", async () => {
    await seedCache(TWO); await runReconcile({ cause: "test" });
    expect(await sendReviewNotice()).toEqual({ sent: 1, newItems: 1 });
    expect(sink.messages).toHaveLength(1);
    const text = body(sink.messages[0]!.raw);
    expect(sink.messages[0]).toMatchObject({ to: ["reg@club.org"] });
    expect(text).toContain("/staff/parents");
    for (const secret of ["ana@example.com", "Rivera", "Chen", "Ana"]) expect(text).not.toContain(secret);
    expect((await db.select().from(heldAddress))[0]!.announcedFamilyQboIds).toEqual(["10", "20"]);
    const [row] = await audits("parent.review.notified");
    expect(row).toMatchObject({ door: "system" });
    expect(row!.after).toEqual({ newItems: 1, waiting: 1, recipients: 1, failed: 0 });
    expect(JSON.stringify(row)).not.toContain("ana@example.com");

    expect(await sendReviewNotice(hours(72))).toEqual({ sent: 0, newItems: 0 });         // the same item is never announced again
    expect(sink.messages).toHaveLength(1);
  });

  it("gathers new items into at most one email in 24 hours", async () => {
    await seedCache(TWO); await runReconcile({ cause: "test" });
    await sendReviewNotice();
    await seedCache(MORE); await runReconcile({ cause: "test" });
    expect(await sendReviewNotice(hours(1))).toEqual({ sent: 0, newItems: 1 });          // new, but too soon
    expect(await sendReviewNotice(hours(25))).toEqual({ sent: 1, newItems: 1 });
    expect(body(sink.messages[1]!.raw)).toContain("2 waiting in all");
  });

  it("announces an approved address again only for a family it has not been announced for", async () => {
    await seedCache(TWO); await runReconcile({ cause: "test" }); await sendReviewNotice();
    await db.update(heldAddress).set({ approvedFamilyQboIds: ["10", "20"] });
    await seedCache([...TWO, fam("30", "Third Family"), par("31", "Ana Rivera", "30", "ana@example.com")]); await runReconcile({ cause: "test" });
    expect(await sendReviewNotice(hours(25))).toEqual({ sent: 1, newItems: 1 });
  });

  it("sends nothing when the switch is off, or nobody holds the permission", async () => {
    await seedCache(TWO); await runReconcile({ cause: "test" });
    await seedParentSettings({ reviewEmails: false });
    expect(await sendReviewNotice()).toEqual({ sent: 0, newItems: 0 });
    await seedParentSettings({ reviewEmails: true });
    await db.delete(roleAssignment);
    expect(await sendReviewNotice()).toEqual({ sent: 0, newItems: 1 });
    expect((await db.select().from(heldAddress))[0]!.announcedFamilyQboIds).toEqual([]);  // nobody was told, so it is still new
    expect(sink.messages).toEqual([]);
  });

  it("sends nothing while mail isn't working or sign-ins are off", async () => {
    await seedCache(TWO); await runReconcile({ cause: "test" });
    await db.delete(setting).where(eq(setting.key, "mail.status")); // mail no longer counts as working
    expect(await sendReviewNotice()).toEqual({ sent: 0, newItems: 1 });
    await seedParentSettings({ signin: false });
    expect(await sendReviewNotice()).toEqual({ sent: 0, newItems: 0 });
    expect(sink.messages).toEqual([]);
  });

  it("two wakes at once send each person exactly one email", async () => {
    await seedCache(TWO); await runReconcile({ cause: "test" });
    const second = await seedStaff({ email: "treasurer@club.org" });
    await reviewerRole(second.id, "parents2");
    const [a, b] = await Promise.all([sendReviewNotice(), sendReviewNotice()]);
    expect(a.sent + b.sent).toBe(2);
    expect(sink.messages.map((m) => m.to[0]!).sort()).toEqual(["reg@club.org", "treasurer@club.org"]);
    expect(await audits("parent.review.notified")).toHaveLength(1);
  });

  it("when no email could be sent the day's slot is given back and the items stay new", async () => {
    await seedCache(TWO); await runReconcile({ cause: "test" });
    sink.rejectRecipient = "reg@club.org";
    expect(await sendReviewNotice()).toEqual({ sent: 0, newItems: 1 });
    expect((await db.select().from(heldAddress))[0]!.announcedFamilyQboIds).toEqual([]);
    expect(await db.select().from(setting).where(eq(setting.key, REVIEW_NOTICE_KEY))).toEqual([]);
    sink.rejectRecipient = null;
    expect(await sendReviewNotice()).toEqual({ sent: 1, newItems: 1 });
  });

  it("when one of two sends fails, the items are announced and the audit row counts the failure", async () => {
    await seedCache(TWO); await runReconcile({ cause: "test" });
    const second = await seedStaff({ email: "treasurer@club.org" });
    await reviewerRole(second.id, "parents2");
    sink.rejectRecipient = "treasurer@club.org";
    expect(await sendReviewNotice()).toEqual({ sent: 1, newItems: 1 });
    expect(sink.messages.map((m) => m.to[0])).toEqual(["reg@club.org"]);
    expect((await db.select().from(heldAddress))[0]!.announcedFamilyQboIds).toEqual(["10", "20"]);
    expect((await audits("parent.review.notified"))[0]!.after).toEqual({ newItems: 1, waiting: 1, recipients: 2, failed: 1 });
  });

  it("an item decided and then reversed is not announced a second time", async () => {
    await seedCache(TWO); await runReconcile({ cause: "test" });
    expect(await sendReviewNotice()).toEqual({ sent: 1, newItems: 1 });
    const op = { actor: { door: "staff" as const, id: reviewer.id, label: reviewer.email }, ip: null, permission: "Parents.ReadWrite" };
    expect(await decideHold("ana@example.com", "not_same", ["10", "20"], "Two people.", op)).toEqual({ ok: true });
    expect(await reviewWaiting()).toBe(0);
    expect(await reverseHold("ana@example.com", "Wrong after all.", op)).toEqual({ ok: true });
    expect(await reviewWaiting()).toBe(1);                                                // waiting again on the home notice
    expect(await sendReviewNotice(hours(25))).toEqual({ sent: 0, newItems: 0 });         // but already announced
    expect(sink.messages).toHaveLength(1);
  });

  it("an active Admin with no other role is emailed", async () => {
    await seedCache(TWO); await runReconcile({ cause: "test" });
    await db.delete(roleAssignment);
    await seedStaff({ email: "chair@club.org", admin: true });
    expect(await sendReviewNotice()).toEqual({ sent: 1, newItems: 1 });
    expect(sink.messages.map((m) => m.to[0])).toEqual(["chair@club.org"]);
  });

  it("giving the slot back restores the earlier send time", async () => {
    await seedCache(TWO); await runReconcile({ cause: "test" });
    const earlier = { lastSentAt: hours(-30).toISOString() };
    await db.insert(setting).values({ key: REVIEW_NOTICE_KEY, value: earlier });
    sink.rejectRecipient = "reg@club.org";
    expect(await sendReviewNotice()).toEqual({ sent: 0, newItems: 1 });
    expect((await db.select().from(setting).where(eq(setting.key, REVIEW_NOTICE_KEY)))[0]!.value).toEqual(earlier);
  });

  it("is sent from the worker's wake", async () => {
    await seedCache(TWO); await runReconcile({ cause: "test" });
    expect((await runDueJobs()).ran).toContainEqual({ job: "parents.review_notice", ok: true });
  });
});
