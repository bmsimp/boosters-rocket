import { describe, it, expect, vi, beforeEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, parent, parentAuthSession, signinCode } from "@/lib/db/schema";
import { blockPerson, unblockPerson } from "@/lib/parents/people";
import { seedParentSettings, SIGNINS_ON } from "../helpers/roster-cache";
import { resetDb, seedParent, seedGuardian, seedGuardianInFamily, seedParentSession, seedWorkingMail } from "../helpers/db";

const o = { actor: { door: "staff" as const, id: null, label: "board@club.org" }, ip: "203.0.113.5" };
const staff = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-000000000002", label: "reg@club.org" }, ip: "203.0.113.9", permission: "Parents.ReadWrite" };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const actions = async () => (await db.select().from(auditLog)).map((a) => a.action);
const sessionsOf = async (authUserId: string) => db.select().from(parentAuthSession).where(eq(parentAuthSession.userId, authUserId));

describe("blocking and unblocking", () => {
  beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); });

  it("blocking ends sessions and drops unused codes but keeps the rows, so unblocking restores the same access", async () => {
    const p = await seedParent({ name: "Ana" });
    await seedGuardian({ parentId: p.id, familyQboId: "F1", status: "active" });
    await seedParentSession(p.authUserId);
    await db.insert(signinCode).values({ parentId: p.id, codeHash: "x", expiresAt: new Date(Date.now() + 60_000) });
    expect(await blockPerson(p.id, "Custody order on file.", o)).toEqual({ ok: true, sessionsEnded: 1 });
    expect(await sessionsOf(p.authUserId)).toHaveLength(0);
    expect(await db.select().from(signinCode)).toHaveLength(0);
    expect(await db.select().from(guardian)).toMatchObject([{ status: "active" }]);
    expect(await unblockPerson(p.id, o)).toEqual({ ok: true, changed: true });
    expect((await db.select().from(parent))[0]!.blocked).toBe(false);
    expect(await actions()).toEqual(["parent.block", "parent.unblock"]);
  });

  it("blocking records who, when and why; unblocking clears them; the reason is audited", async () => {
    const p = await seedParent({ name: "Ana Rivera" });
    expect(await blockPerson(p.id, "  ", staff)).toEqual({ ok: false, reason: "invalid" });
    expect(await blockPerson(p.id, "Custody order on file.", staff)).toMatchObject({ ok: true });
    const [row] = await db.select().from(parent);
    expect(row).toMatchObject({ blocked: true, blockedReason: "Custody order on file.", blockedBy: staff.actor.id });
    expect(row!.blockedAt).toBeInstanceOf(Date);
    expect((await audits("parent.block"))[0]!.after).toMatchObject({ blocked: true, reason: "Custody order on file." });
    await unblockPerson(p.id, staff);
    expect((await db.select().from(parent))[0]).toMatchObject({ blocked: false, blockedReason: null, blockedBy: null, blockedAt: null });
  });

  it("blocking again records the earlier reason; unblocking someone who is not blocked changes nothing and is not audited", async () => {
    const p = await seedParent({ name: "Ana Rivera" });
    expect(await unblockPerson(p.id, staff)).toEqual({ ok: true, changed: false });
    expect(await audits("parent.unblock")).toEqual([]);
    await blockPerson(p.id, "First reason.", staff);
    await blockPerson(p.id, "Second reason.", staff);
    const rows = await audits("parent.block");
    expect(rows[0]!.before).toEqual({ blocked: false, reason: null });
    expect(rows[1]!.before).toEqual({ blocked: true, reason: "First reason." });
  });

  it("unblocking owes the welcome back to someone never welcomed who has a row that counts, when welcomes are on", async () => {
    await seedParentSettings({ ...SIGNINS_ON, welcome: true });
    const p = await seedParent({ name: "Ana Rivera", welcomeOwed: true });
    await seedGuardianInFamily({ parentId: p.id, familyQboId: "F1", status: "invited" });
    await blockPerson(p.id, "reason", staff);
    await unblockPerson(p.id, staff);
    expect((await db.select().from(parent))[0]!.welcomeOwed).toBe(true);
    expect((await audits("parent.unblock"))[0]!.after).toMatchObject({ blocked: false, welcomeOwed: true });
  });

  it("unblocking owes nothing when welcomes are off, the person was welcomed, or no row counts", async () => {
    const a = await seedParent({ name: "Ann One" }); await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1", status: "invited" });
    await blockPerson(a.id, "r", staff); await unblockPerson(a.id, staff);       // welcomes off
    await seedParentSettings({ ...SIGNINS_ON, welcome: true });
    const b = await seedParent({ name: "Bea Two", welcomedAt: new Date() }); await seedGuardianInFamily({ parentId: b.id, familyQboId: "F1", status: "invited" });
    await blockPerson(b.id, "r", staff); await unblockPerson(b.id, staff);       // already welcomed
    const c = await seedParent({ name: "Cy Three" }); await seedGuardianInFamily({ parentId: c.id, familyQboId: "F1", status: "disabled", disabledReason: "removed" });
    await blockPerson(c.id, "r", staff); await unblockPerson(c.id, staff);       // no open link
    // An open row that names no family record is no row that counts either: the gate wouldn't let them in.
    const d = await seedParent({ name: "Di Four" }); await seedGuardian({ parentId: d.id, familyQboId: "F9", status: "invited" });
    await blockPerson(d.id, "r", staff); await unblockPerson(d.id, staff);
    expect((await db.select().from(parent).orderBy(parent.createdAt, parent.id)).map((x) => [x.name, x.welcomeOwed])).toEqual(
      [["Ann One", false], ["Bea Two", false], ["Cy Three", false], ["Di Four", false]]);
    for (const u of await audits("parent.unblock")) expect(u.after).not.toHaveProperty("welcomeOwed");
  });

  it("a blocked person owed a welcome is no longer owed one", async () => {
    const p = await seedParent({ name: "Ana Rivera", welcomeOwed: true });
    await blockPerson(p.id, "reason", staff);
    expect((await db.select().from(parent))[0]!.welcomeOwed).toBe(false);
  });
});

