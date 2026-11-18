import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, familyMoney, jobRun, parentAuthSession, parentAuthVerification, parentEmailChange, rateLimitEvent, signinCode, staffAuthSession, staffAuthUser, staffAuthVerification, writeQueue } from "@/lib/db/schema";
import * as schema from "@/lib/db/schema";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { cleanUp, runCleanup, describeCleanup, CLEANED_TABLES, KEPT_TABLES, CLEANUP_JOB, FINISHED_WRITES_DAYS, JOB_HISTORY_DAYS, REMINDER_CLAIM_DAYS, type CleanupCounts } from "@/lib/jobs/cleanup";
import { runDueJobs } from "@/lib/jobs/runner";
import { RATE_LIMITS } from "@/lib/parents/rate-limit";
import { CODE_TTL_MS, RESEND_AFTER_MS } from "@/lib/parents/signin-codes";
import { EMAIL_CHANGE_TTL_MS } from "@/lib/parents/email-change";
import { ROSTER_JOB } from "@/lib/roster/refresh";
import { resetDb, seedParent, seedParentSession } from "../helpers/db";
import { addToCache, fam } from "../helpers/roster-cache";

const NOW = new Date("2026-11-15T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);
const SEC = 1000, DAY = 86_400_000;
const NOTHING: CleanupCounts = { staffSessions: 0, parentSessions: 0, signinCodes: 0, rateLimitEvents: 0, emailChanges: 0, familyMoney: 0, jobRuns: 0, reminderClaims: 0, writeQueue: 0, verifications: 0 };
const clean = (now = NOW) => db.transaction((tx) => cleanUp(tx, now));

async function staffSession(id: string, expiresAt: Date) {
  await db.insert(staffAuthUser).values({ id: "s1", name: "Sam", email: "sam@club.org", emailVerified: true }).onConflictDoNothing();
  await db.insert(staffAuthSession).values({ id, token: `t-${id}`, userId: "s1", expiresAt });
}
const ids = async <T extends { id: unknown }>(rows: Promise<T[]>) => (await rows).map((r) => String(r.id)).sort();

describe("the daily clean-up knows every table", () => {
  it("names each table of the schema once: cleaned, or kept with a reason", () => {
    const tables = Object.values(schema).filter((v) => is(v, PgTable)).map((t) => getTableName(t as PgTable)).sort();
    const named = [...CLEANED_TABLES, ...Object.keys(KEPT_TABLES)].sort();
    expect(named).toEqual(tables);
    for (const why of Object.values(KEPT_TABLES)) expect(why.length).toBeGreaterThan(0);
  });
});

describe("the daily clean-up deletes only what is past use", () => {
  beforeEach(async () => { await resetDb(); });

  it("removes nothing from an empty portal, and nothing that is still alive", async () => {
    expect(await clean()).toEqual(NOTHING);
    const ana = await seedParent({ name: "Ana" });
    await seedParentSession(ana.authUserId, { expiresAt: at(90 * DAY) });
    await staffSession("live", at(7 * DAY));
    await db.insert(signinCode).values({ parentId: ana.id, codeHash: "h", expiresAt: at(CODE_TTL_MS), createdAt: NOW });
    await db.insert(rateLimitEvent).values({ kind: "code_send_ip", subject: "203.0.113.7", at: NOW });
    await db.insert(parentEmailChange).values({ parentId: ana.id, newEmail: "new@example.com", tokenHash: "tok", expiresAt: at(EMAIL_CHANGE_TTL_MS) });
    await db.insert(jobRun).values({ job: ROSTER_JOB, startedAt: NOW, finishedAt: NOW, outcome: "ok", startedBy: "worker" });
    expect(await clean()).toEqual(NOTHING);
  });

  it("sessions, both doors: one that ran out a second ago goes, one with a second left stays", async () => {
    const ana = await seedParent({ name: "Ana" });
    const gone = await seedParentSession(ana.authUserId, { expiresAt: at(-SEC) });
    const edge = await seedParentSession(ana.authUserId, { expiresAt: NOW });
    const kept = await seedParentSession(ana.authUserId, { expiresAt: at(SEC) });
    await staffSession("gone", at(-SEC)); await staffSession("edge", NOW); await staffSession("kept", at(SEC));
    expect(await clean()).toEqual({ ...NOTHING, staffSessions: 1, parentSessions: 1 });
    expect(await ids(db.select({ id: parentAuthSession.id }).from(parentAuthSession))).toEqual([edge.id, kept.id].sort());
    expect(await ids(db.select({ id: staffAuthSession.id }).from(staffAuthSession))).toEqual(["edge", "kept"]);
    expect(gone.id).not.toBe(kept.id);
  });

  it("sign-in codes: used or expired ones go, but never one young enough to hold back the next send", async () => {
    const people = await Promise.all(["a", "b", "c", "d", "e", "f"].map((n) => seedParent({ name: n })));
    const code = async (i: number, v: { expiresAt: Date; createdAt: Date; usedAt?: Date }) =>
      (await db.insert(signinCode).values({ parentId: people[i]!.id, codeHash: `h${i}`, ...v }).returning({ id: signinCode.id }))[0]!.id;
    const expiredGone = await code(0, { createdAt: at(-CODE_TTL_MS - SEC), expiresAt: at(-SEC) });
    const expiresNow = await code(1, { createdAt: at(-CODE_TTL_MS), expiresAt: NOW });
    const secondLeft = await code(2, { createdAt: at(-CODE_TTL_MS + SEC), expiresAt: at(SEC) });
    const usedOld = await code(3, { createdAt: at(-RESEND_AFTER_MS - SEC), expiresAt: at(CODE_TTL_MS - RESEND_AFTER_MS - SEC), usedAt: at(-SEC) });
    const usedYoung = await code(4, { createdAt: at(-RESEND_AFTER_MS + SEC), expiresAt: at(CODE_TTL_MS - RESEND_AFTER_MS + SEC), usedAt: at(-SEC) });
    const usedAtEdge = await code(5, { createdAt: at(-RESEND_AFTER_MS), expiresAt: at(CODE_TTL_MS - RESEND_AFTER_MS), usedAt: at(-SEC) });
    expect(await clean()).toEqual({ ...NOTHING, signinCodes: 2 });
    const left = await ids(db.select({ id: signinCode.id }).from(signinCode));
    expect(left).toEqual([expiresNow, secondLeft, usedYoung, usedAtEdge].sort());
    expect(left).not.toContain(expiredGone); expect(left).not.toContain(usedOld);
  });

  it("rate-limit records: only those outside their kind's window, an unknown kind after the longest window", async () => {
    const w = RATE_LIMITS.code_send_email.windowMs;
    const longest = Math.max(...Object.values(RATE_LIMITS).map((l) => l.windowMs));
    const rows = await db.insert(rateLimitEvent).values([
      { kind: "code_send_email", subject: "ana@example.com", at: at(-w - SEC) },   // gone
      { kind: "code_send_email", subject: "ana@example.com", at: at(-w) },         // the edge: stays
      { kind: "code_send_email", subject: "ana@example.com", at: at(-w + SEC), refusalAudited: true }, // inside: stays
      { kind: "code_send_ip", subject: "203.0.113.7", at: at(-RATE_LIMITS.code_send_ip.windowMs - SEC) }, // gone
      { kind: "code_check_ip", subject: "203.0.113.7", at: at(-RATE_LIMITS.code_check_ip.windowMs + SEC) }, // stays
      { kind: "from_a_later_version", subject: "x", at: at(-longest - SEC) },      // gone
      { kind: "from_a_later_version", subject: "x", at: at(-longest + SEC) },      // stays
      // A parent's own contact edits are counted in the same table, a save over an hour: each kind goes by its own window.
      { kind: "contact_save_parent", subject: "p-1", at: at(-w - SEC) },           // past the sign-in window, inside its own: stays
      { kind: "contact_save_parent", subject: "p-1", at: at(-RATE_LIMITS.contact_save_parent.windowMs - SEC) }, // gone
      { kind: "contact_open_parent", subject: "p-1", at: at(-RATE_LIMITS.contact_open_parent.windowMs + SEC) }, // stays
      { kind: "contact_open_parent", subject: "p-1", at: at(-RATE_LIMITS.contact_open_parent.windowMs - SEC) }, // gone
    ]).returning({ id: rateLimitEvent.id });
    expect(RATE_LIMITS.contact_save_parent.windowMs).toBeGreaterThan(w);
    expect(await clean()).toEqual({ ...NOTHING, rateLimitEvents: 5 });
    expect(await ids(db.select({ id: rateLimitEvent.id }).from(rateLimitEvent))).toEqual([rows[1], rows[2], rows[4], rows[6], rows[7], rows[9]].map((r) => String(r!.id)).sort());
  });

  it("email changes: an expired link goes, confirmed or not; one with a second left stays", async () => {
    const people = await Promise.all(["a", "b", "c", "d"].map((n) => seedParent({ name: n })));
    const change = async (i: number, expiresAt: Date, usedAt?: Date) =>
      (await db.insert(parentEmailChange).values({ parentId: people[i]!.id, newEmail: `n${i}@example.com`, tokenHash: `t${i}`, expiresAt, usedAt }).returning({ id: parentEmailChange.id }))[0]!.id;
    await change(0, at(-SEC));
    await change(1, at(-SEC), at(-DAY));
    const edge = await change(2, NOW);
    const kept = await change(3, at(SEC), at(-SEC));
    expect(await clean()).toEqual({ ...NOTHING, emailChanges: 2 });
    expect(await ids(db.select({ id: parentEmailChange.id }).from(parentEmailChange))).toEqual([edge, kept].sort());
  });

  it("money: figures for a family the roster cache no longer holds go; a family still in it keeps its own", async () => {
    await addToCache([fam("F1", "Rivera Family"), fam("F2", "Chenoweth Family", { active: false })]);
    await db.insert(familyMoney).values([{ familyQboId: "F1", totalCents: 100 }, { familyQboId: "F2", totalCents: 200 }, { familyQboId: "F-LEFT", totalCents: 300 }]);
    expect(await clean()).toEqual({ ...NOTHING, familyMoney: 1 });
    // An inactive family is still in the cache: its row is not this job's to judge (family-money.ts refuses to show it).
    expect((await db.select().from(familyMoney)).map((r) => r.familyQboId).sort()).toEqual(["F1", "F2"]);
  });

  it("money: nothing goes while the roster cache holds no customers at all", async () => {
    await db.insert(familyMoney).values([{ familyQboId: "F1", totalCents: 100 }]);
    expect(await clean()).toEqual(NOTHING);
    expect(await db.select().from(familyMoney)).toHaveLength(1);
  });

  it("job history: older than 90 days goes, except each job's newest run and its newest run that worked", async () => {
    const old = at(-JOB_HISTORY_DAYS * DAY - SEC), edge = at(-JOB_HISTORY_DAYS * DAY), recent = at(-JOB_HISTORY_DAYS * DAY + SEC);
    const run = async (job: string, startedAt: Date, outcome: "ok" | "failed") =>
      String((await db.insert(jobRun).values({ job, startedAt, finishedAt: startedAt, outcome, startedBy: "worker" }).returning({ id: jobRun.id }))[0]!.id);
    const goneOk = await run("roster.refresh", at(-200 * DAY), "ok");
    const lastOk = await run("roster.refresh", at(-150 * DAY), "ok");        // old, but the newest that worked: stays
    const goneFailed = await run("roster.refresh", at(-120 * DAY), "failed");
    const newestFailed = await run("roster.refresh", at(-100 * DAY), "failed"); // old, but the job's newest run: stays
    const oneSecondOver = await run("quickbooks.token_refresh", old, "ok");
    const onTheEdge = await run("quickbooks.token_refresh", edge, "ok");
    const inside = await run("quickbooks.token_refresh", recent, "ok");
    const only = await run("parents.welcome", at(-400 * DAY), "failed");     // a job's only run: stays
    expect(await clean()).toEqual({ ...NOTHING, jobRuns: 3 });
    const left = await ids(db.select({ id: jobRun.id }).from(jobRun));
    expect(left).toEqual([lastOk, newestFailed, onTheEdge, inside, only].sort());
    for (const gone of [goneOk, goneFailed, oneSecondOver]) expect(left).not.toContain(gone);
  });

  it("reminder records: claims and rounds older than a year go, one a second inside it stays; signed forms' evidence never goes", async () => {
    const year = REMINDER_CLAIM_DAYS * DAY, requirementId = crypto.randomUUID(), parentId = crypto.randomUUID();
    const [old] = await db.insert(schema.formReminderClaim).values({ requirementId, parentId, onDate: "2025-11-01", createdAt: at(-year - SEC) }).returning();
    const [edge] = await db.insert(schema.formReminderClaim).values({ requirementId, parentId, onDate: "2025-11-02", createdAt: at(-year + SEC) }).returning();
    await db.insert(schema.formReminderRound).values({ requirementId, onDate: "2025-11-01", createdAt: at(-year - SEC) });
    const [round] = await db.insert(schema.formReminderRound).values({ requirementId, onDate: "2025-11-02", createdAt: at(-year + SEC) }).returning();
    const [evidence] = await db.insert(schema.signedFormEvidence).values({ familyQboId: "F", subjectQboId: "F", subjectKind: "family", formTitle: "Old form", envelopeId: "envelope_oldoldold",
      signers: [], consents: [], originals: [], storedAt: at(-10 * year) }).returning();
    await db.insert(schema.signedFormFile).values({ evidenceId: evidence!.id, kind: "sealed_pdf", bytes: Buffer.from("%PDF-1.7 old"), size: 12, sha256: "x", createdAt: at(-10 * year) });
    expect(await clean()).toEqual({ ...NOTHING, reminderClaims: 2 });
    expect(await ids(db.select({ id: schema.formReminderClaim.id }).from(schema.formReminderClaim))).toEqual([edge!.id]);
    expect(await ids(db.select({ id: schema.formReminderRound.id }).from(schema.formReminderRound))).toEqual([round!.id]);
    expect(old).toBeTruthy();
    expect(await db.select().from(schema.signedFormEvidence)).toHaveLength(1);
    expect(await db.select().from(schema.signedFormFile)).toHaveLength(1);
  });

  it("due-date reminder claims older than a year go, one a second inside it stays", async () => {
    const year = REMINDER_CLAIM_DAYS * DAY, parentId = crypto.randomUUID();
    // A claim names the app's own family (stage 2 of the app-owned families spec), which it can't outlive.
    const [family] = await db.insert(schema.family).values({ name: "Claim Family", active: true }).returning();
    const claim = (dueOn: string, ago: number) => db.insert(schema.requirementReminder).values({ kind: "due_3", familyId: family!.id, parentId, dueOn, triedAt: at(ago), outcome: "sent", createdAt: at(ago) }).returning();
    await claim("2025-11-01", -year - SEC);
    const [edge] = await claim("2025-11-02", -year + SEC);
    const [recent] = await claim("2026-11-02", -DAY);
    expect(await clean()).toEqual({ ...NOTHING, reminderClaims: 1 });
    expect(await ids(db.select({ id: schema.requirementReminder.id }).from(schema.requirementReminder))).toEqual([edge!.id, recent!.id].sort());
  });

  it("staff roster writes: one that went through or was given up more than 30 days ago goes; one a second inside stays, and waiting and stuck ones always stay", async () => {
    const w = { op: "deactivate" as const, role: "student" as const, qboId: "12", syncToken: "0" };
    const item = async (state: "waiting" | "stuck" | "done" | "given_up", finishedAt: Date | null) => String((await db.insert(writeQueue)
      .values({ realmId: "1", request: w, targetQboId: "12", state, sent: false, finishedAt, createdAt: at(-400 * DAY), lastTriedAt: at(-400 * DAY) }).returning({ id: writeQueue.id }))[0]!.id);
    const over = at(-FINISHED_WRITES_DAYS * DAY - SEC), edge = at(-FINISHED_WRITES_DAYS * DAY), inside = at(-FINISHED_WRITES_DAYS * DAY + SEC);
    const goneDone = await item("done", over), goneGivenUp = await item("given_up", over);
    const kept = [await item("done", edge), await item("given_up", inside), await item("waiting", null), await item("stuck", null)];
    expect(await clean()).toEqual({ ...NOTHING, writeQueue: 2 });
    const left = await ids(db.select({ id: writeQueue.id }).from(writeQueue));
    expect(left).toEqual(kept.sort());
    for (const gone of [goneDone, goneGivenUp]) expect(left).not.toContain(gone);
    expect(describeCleanup({ ...NOTHING, writeQueue: 2 })).toBe("Removed 2 finished changes to QuickBooks.");
  });

  it("Better Auth's verification rows, both doors: one that ran out a second ago goes, one with a second left stays", async () => {
    for (const [table, door] of [[staffAuthVerification, "staff"], [parentAuthVerification, "parent"]] as const) {
      await db.insert(table).values([
        { id: `${door}-gone`, identifier: "state", value: "v", expiresAt: at(-SEC) },
        { id: `${door}-edge`, identifier: "state", value: "v", expiresAt: NOW },
        { id: `${door}-kept`, identifier: "state", value: "v", expiresAt: at(SEC) },
      ]);
    }
    expect(await clean()).toEqual({ ...NOTHING, verifications: 2 });
    expect(await ids(db.select({ id: staffAuthVerification.id }).from(staffAuthVerification))).toEqual(["staff-edge", "staff-kept"]);
    expect(await ids(db.select({ id: parentAuthVerification.id }).from(parentAuthVerification))).toEqual(["parent-edge", "parent-kept"]);
    expect(describeCleanup({ ...NOTHING, verifications: 2 })).toBe("Removed 2 expired sign-in checks.");
  });

  it("never touches the audit log, however old", async () => {
    await db.insert(auditLog).values({ at: at(-3650 * DAY), door: "system", action: "signin" });
    expect(await clean()).toEqual(NOTHING);
    expect(await db.select().from(auditLog)).toHaveLength(1);
  });
});

describe("a run of the clean-up", () => {
  beforeEach(async () => { await resetDb(); });
  const audits = async () => (await db.select().from(auditLog)).filter((r) => r.action === "cleanup.run");
  const runs = async () => (await db.select().from(jobRun).where(eq(jobRun.job, CLEANUP_JOB))).sort((a, b) => a.id - b.id);

  it("that removed something writes one audit row with the counts and says so in the job history", async () => {
    const ana = await seedParent({ name: "Ana" });
    await seedParentSession(ana.authUserId, { expiresAt: new Date(Date.now() - SEC) });
    await seedParentSession(ana.authUserId, { expiresAt: new Date(Date.now() - DAY) });
    await db.insert(rateLimitEvent).values({ kind: "code_send_ip", subject: "203.0.113.7", at: new Date(Date.now() - DAY) });
    const r = await runCleanup();
    expect(r).toEqual({ ok: true, counts: { ...NOTHING, parentSessions: 2, rateLimitEvents: 1 } });
    const [run] = await runs();
    expect(run).toMatchObject({ outcome: "ok", startedBy: "worker", detail: "Removed 2 expired parent sessions and 1 rate-limit record." });
    const rows = await audits();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ door: "system", actorLabel: "worker", targetType: "job_run", targetId: String(run!.id), after: { ...NOTHING, parentSessions: 2, rateLimitEvents: 1 }, ip: null });
  });

  it("that removed nothing writes no audit row, and is still in the job history", async () => {
    expect(await runCleanup()).toEqual({ ok: true, counts: NOTHING });
    expect(await audits()).toHaveLength(0);
    expect((await runs())[0]).toMatchObject({ outcome: "ok", detail: "Nothing to remove." });
  });

  it("happens once a day from the worker, connected to QuickBooks or not, and is quiet unless it removed something", async () => {
    const ana = await seedParent({ name: "Ana" });
    expect(await runDueJobs()).toEqual({ ran: [] });
    expect(await runs()).toHaveLength(1);
    await seedParentSession(ana.authUserId, { expiresAt: new Date(Date.now() - SEC) });
    const live = await seedParentSession(ana.authUserId, { expiresAt: new Date(Date.now() + 26 * 3_600_000) });
    expect(await runDueJobs(new Date(Date.now() + 23 * 3_600_000))).toEqual({ ran: [] });
    expect(await db.select().from(parentAuthSession)).toHaveLength(2);
    // A day on by the worker's clock. What has expired is still judged by the real time: the session that runs out
    // in 26 hours is not removed by a wake that was told it is 25 hours from now.
    expect(await runDueJobs(new Date(Date.now() + 25 * 3_600_000))).toEqual({ ran: [{ job: CLEANUP_JOB, ok: true }] });
    expect((await db.select().from(parentAuthSession)).map((s) => s.id)).toEqual([live.id]);
    expect(await runs()).toHaveLength(2);
    expect(await audits()).toHaveLength(1);
  });

  it("says what it removed in plain words", () => {
    expect(describeCleanup(NOTHING)).toBe("Nothing to remove.");
    expect(describeCleanup({ ...NOTHING, staffSessions: 1 })).toBe("Removed 1 expired staff session.");
    expect(describeCleanup({ staffSessions: 2, parentSessions: 1, signinCodes: 3, rateLimitEvents: 4, emailChanges: 1, familyMoney: 1, jobRuns: 5, reminderClaims: 0, writeQueue: 0, verifications: 0 }))
      .toBe("Removed 2 expired staff sessions, 1 expired parent session, 3 sign-in codes, 4 rate-limit records, 1 expired email change, 1 set of figures for a family no longer in the roster and 5 old job records.");
    expect(describeCleanup({ ...NOTHING, reminderClaims: 3 })).toBe("Removed 3 reminder records older than a year.");
  });
});
