import { describe, it, expect, vi, beforeEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, parent, parentAuthUser, parentAuthSession, signinCode } from "@/lib/db/schema";
import {
  createOrLinkGuardian, removeGuardian, blockPerson, unblockPerson, onFamilyStudentsChanged, resendWelcome, changeParentEmailByStaff,
} from "@/lib/parents/people";
import { enabledGuardianRows } from "@/lib/parents/sessions";
import { resetDb, seedParent, seedGuardian, seedParentSession, seedWorkingMail } from "../helpers/db";

const o = { actor: { door: "staff" as const, id: null, label: "board@club.org" }, ip: "203.0.113.5" };
const add = (email: string, familyQboId: string, extra: Partial<Parameters<typeof createOrLinkGuardian>[0]> = {}, confirmLinkParentId?: string) =>
  createOrLinkGuardian({ familyQboId, familyLabel: `the ${familyQboId} family`, name: "Ana Ramirez", email, ...extra }, { ...o, confirmLinkParentId });
const actions = async () => (await db.select().from(auditLog)).map((a) => a.action);
const pid = (r: Awaited<ReturnType<typeof createOrLinkGuardian>>) => ("parentId" in r ? r.parentId : "");
const sessionsOf = async (authUserId: string) => db.select().from(parentAuthSession).where(eq(parentAuthSession.userId, authUserId));

describe("adding guardians", () => {
  beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); });

  it("makes a new person, their sign-in user and an invited row, and sends a welcome with no code", async () => {
    const r = await add(" Ana@Example.COM ", "F1");
    expect(r).toMatchObject({ ok: true, outcome: "created", welcomeSent: true });
    const [p] = await db.select().from(parent);
    expect(p).toMatchObject({ name: "Ana Ramirez", email: "ana@example.com", blocked: false });
    expect(await db.select().from(parentAuthUser)).toMatchObject([{ email: "ana@example.com", parentId: p!.id }]);
    expect(await db.select().from(guardian)).toMatchObject([{ familyQboId: "F1", parentId: p!.id, status: "invited" }]);
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.to).toBe("ana@example.com");
    expect(outbox[0]!.text).toContain("We'll email you a code each time.");
    expect(outbox[0]!.text).not.toMatch(/\b\d{6}\b/);
    expect(await actions()).toEqual(["parent.create", "guardian.create", "guardian.welcome_sent"]);
  });

  it("asks before linking an existing person, writes nothing until confirmed, then links the same person", async () => {
    const first = await add("ana@example.com", "F1");
    const ask = await add("ANA@example.com", "F2", { name: "Someone Else" });
    expect(ask).toEqual({ ok: false, reason: "confirm_link", parentId: pid(first), name: "Ana Ramirez", familyQboIds: ["F1"] });
    expect(await db.select().from(guardian)).toHaveLength(1);
    const linked = await add("ana@example.com", "F2", {}, pid(ask));
    expect(linked).toMatchObject({ ok: true, outcome: "linked" });
    expect(await db.select().from(parent)).toHaveLength(1);
    expect((await db.select().from(guardian)).map((g) => g.parentId)).toEqual([pid(first), pid(first)]);
    expect(outbox.at(-1)!.text).toContain("You've been added as a guardian for the F2 family.");
  });

  it("asks again when the confirmation names a different person", async () => {
    await add("ana@example.com", "F1");
    expect(await add("ana@example.com", "F2", {}, "00000000-0000-0000-0000-000000000000")).toMatchObject({ ok: false, reason: "confirm_link" });
  });

  it("refuses a second link to the same family", async () => {
    const first = await add("ana@example.com", "F1");
    const again = await add("ana@example.com", "F1", {}, pid(first));
    expect(again).toMatchObject({ ok: false, reason: "already_in_family" });
    expect(await db.select().from(guardian)).toHaveLength(1);
  });

  it("offers no link to a blocked person", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com", blocked: true });
    expect(await add("ana@example.com", "F2", {}, p.id)).toEqual({ ok: false, reason: "blocked", parentId: p.id, name: "Ana" });
    expect(await db.select().from(guardian)).toHaveLength(0);
  });

  it("refuses an address that isn't one", async () => {
    expect(await add("not-an-email", "F1")).toMatchObject({ ok: false, reason: "invalid", errors: ["Enter a valid email address."] });
  });

  it("re-enables a removed row instead of making a second one, with its old status, and welcomes them again", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    const g = await seedGuardian({ parentId: p.id, familyQboId: "F1", status: "disabled", disabledReason: "removed", statusBeforeDisable: "active" });
    const r = await add("ana@example.com", "F1", {}, p.id);
    expect(r).toMatchObject({ ok: true, outcome: "reenabled", guardianId: g.id, welcomeSent: true });
    expect(await db.select().from(guardian)).toMatchObject([{ id: g.id, status: "active", disabledReason: null, statusBeforeDisable: null }]);
    expect(await actions()).toEqual(["guardian.reenable", "guardian.welcome_sent"]);
  });
});

describe("removing, blocking and students", () => {
  beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); });

  it("removing one family leaves the person and their other family alone, and keeps their session", async () => {
    const p = await seedParent({ name: "Ana" });
    const g1 = await seedGuardian({ parentId: p.id, familyQboId: "F1" });
    await seedGuardian({ parentId: p.id, familyQboId: "F2" });
    await seedParentSession(p.authUserId, { familyQboId: "F2" });
    expect(await removeGuardian(g1.id, o)).toEqual({ ok: true, sessionsEnded: 0 });
    expect((await db.select().from(guardian).where(eq(guardian.id, g1.id)))[0]).toMatchObject({ status: "disabled", disabledReason: "removed", statusBeforeDisable: "active" });
    expect((await enabledGuardianRows(p.id)).map((r) => r.familyQboId)).toEqual(["F2"]);
    expect(await sessionsOf(p.authUserId)).toHaveLength(1);
  });

  it("removing the last enabled row ends every session at once", async () => {
    const p = await seedParent({ name: "Ana" });
    const g = await seedGuardian({ parentId: p.id, familyQboId: "F1" });
    await seedParentSession(p.authUserId); await seedParentSession(p.authUserId);
    expect(await removeGuardian(g.id, o)).toEqual({ ok: true, sessionsEnded: 2 });
    expect(await sessionsOf(p.authUserId)).toHaveLength(0);
    const [a] = (await db.select().from(auditLog)).filter((x) => x.action === "guardian.remove");
    expect(a!.after).toMatchObject({ status: "disabled", disabledReason: "removed", sessionsEnded: 2 });
  });

  it("blocking ends sessions and drops unused codes but keeps the rows, so unblocking restores the same access", async () => {
    const p = await seedParent({ name: "Ana" });
    await seedGuardian({ parentId: p.id, familyQboId: "F1", status: "active" });
    await seedParentSession(p.authUserId);
    await db.insert(signinCode).values({ parentId: p.id, codeHash: "x", expiresAt: new Date(Date.now() + 60_000) });
    expect(await blockPerson(p.id, o)).toEqual({ ok: true, sessionsEnded: 1 });
    expect(await sessionsOf(p.authUserId)).toHaveLength(0);
    expect(await db.select().from(signinCode)).toHaveLength(0);
    expect(await db.select().from(guardian)).toMatchObject([{ status: "active" }]);
    expect(await unblockPerson(p.id, o)).toEqual({ ok: true });
    expect((await db.select().from(parent))[0]!.blocked).toBe(false);
    expect(await actions()).toEqual(["parent.block", "parent.unblock"]);
  });

  it("the family's last active student going disables its rows, and a student coming back restores each one's status", async () => {
    const a = await seedParent({ name: "Ana" });
    const b = await seedParent({ name: "Ben" });
    const c = await seedParent({ name: "Cy" });
    await seedGuardian({ parentId: a.id, familyQboId: "F1", status: "active" });
    await seedGuardian({ parentId: b.id, familyQboId: "F1", status: "invited" });
    await seedGuardian({ parentId: c.id, familyQboId: "F1", status: "disabled", disabledReason: "removed", statusBeforeDisable: "active" });
    await seedGuardian({ parentId: b.id, familyQboId: "F9", status: "active" });
    await seedParentSession(a.authUserId); await seedParentSession(b.authUserId);
    expect(await onFamilyStudentsChanged("F1", false, o)).toEqual({ changed: 2 });
    const f1 = async () => Object.fromEntries((await db.select().from(guardian).where(eq(guardian.familyQboId, "F1"))).map((g) => [g.parentId, [g.status, g.disabledReason]]));
    expect(await f1()).toEqual({ [a.id]: ["disabled", "no_active_students"], [b.id]: ["disabled", "no_active_students"], [c.id]: ["disabled", "removed"] });
    expect(await sessionsOf(a.authUserId)).toHaveLength(0); // F1 was Ana's only family
    expect(await sessionsOf(b.authUserId)).toHaveLength(1); // Ben still has F9
    expect(await onFamilyStudentsChanged("F1", true, o)).toEqual({ changed: 2 });
    expect(await f1()).toEqual({ [a.id]: ["active", null], [b.id]: ["invited", null], [c.id]: ["disabled", "removed"] });
    expect((await actions()).filter((x) => x === "guardian.disable")).toHaveLength(2);
    expect((await actions()).filter((x) => x === "guardian.reenable")).toHaveLength(2);
    expect(outbox).toHaveLength(0); // coming back for a student sends no welcome
  });

  it("two disables racing over a person's last two rows still end their sessions", async () => {
    for (let i = 0; i < 10; i++) { // a race can pass by luck once; repeat so a missing lock shows up
      await resetDb();
      const p = await seedParent({ name: "Ana" });
      const g1 = await seedGuardian({ parentId: p.id, familyQboId: "F1", status: "active" });
      await seedGuardian({ parentId: p.id, familyQboId: "F2", status: "active" });
      await seedParentSession(p.authUserId);
      await Promise.all([removeGuardian(g1.id, o), onFamilyStudentsChanged("F2", false, o)]);
      expect(await enabledGuardianRows(p.id)).toHaveLength(0);
      expect(await sessionsOf(p.authUserId)).toHaveLength(0);
    }
  });

  it("resends the welcome for an enabled row only", async () => {
    const p = await seedParent({ name: "Ana" });
    const g = await seedGuardian({ parentId: p.id, familyQboId: "F1", status: "invited" });
    expect(await resendWelcome(g.id, "the F1 family", o)).toEqual({ ok: true });
    expect(outbox).toHaveLength(1);
    await removeGuardian(g.id, o);
    expect(await resendWelcome(g.id, null, o)).toEqual({ ok: false, reason: "disabled" });
  });
});

describe("staff changing a parent's email", () => {
  beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); });

  it("changes the one record and the sign-in user, ends sessions, tells the old address, and every family keeps working", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedGuardian({ parentId: p.id, familyQboId: "F1" });
    await seedGuardian({ parentId: p.id, familyQboId: "F2" });
    await seedParentSession(p.authUserId);
    expect(await changeParentEmailByStaff(p.id, " Ana.New@Example.com", o)).toEqual({ ok: true, changed: true });
    expect((await db.select().from(parent))[0]!.email).toBe("ana.new@example.com");
    expect((await db.select().from(parentAuthUser))[0]!.email).toBe("ana.new@example.com");
    expect(await sessionsOf(p.authUserId)).toHaveLength(0);
    expect((await enabledGuardianRows(p.id)).map((g) => g.familyQboId)).toEqual(["F1", "F2"]);
    expect(outbox.map((m) => m.to)).toEqual(["ana@example.com"]);
    expect(outbox[0]!.text).toMatch(/The club changed/);
    const [a] = (await db.select().from(auditLog)).filter((x) => x.action === "parent.email_change");
    expect(a).toMatchObject({ before: { email: "ana@example.com" }, after: { email: "ana.new@example.com", by: "staff", sessionsEnded: 1 } });
  });

  it("refuses an address another person holds, and says who", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    const q = await seedParent({ name: "Ben Lee", email: "ben@example.com" });
    expect(await changeParentEmailByStaff(p.id, "BEN@example.com", o)).toEqual({ ok: false, reason: "in_use", heldBy: { parentId: q.id, name: "Ben Lee" } });
  });

  it("treats a change of letter case only as no change", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedParentSession(p.authUserId);
    expect(await changeParentEmailByStaff(p.id, "ANA@Example.com", o)).toEqual({ ok: true, changed: false });
    expect(await sessionsOf(p.authUserId)).toHaveLength(1);
  });
});
