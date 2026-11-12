import { describe, it, expect, vi, beforeEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, parent, parentAuthUser, parentAuthSession, signinCode } from "@/lib/db/schema";
import { blockPerson, unblockPerson, changeParentEmailByStaff } from "@/lib/parents/people";
import { enabledGuardianRows } from "@/lib/parents/sessions";
import { resetDb, seedParent, seedGuardian, seedParentSession, seedWorkingMail } from "../helpers/db";

const o = { actor: { door: "staff" as const, id: null, label: "board@club.org" }, ip: "203.0.113.5" };
const actions = async () => (await db.select().from(auditLog)).map((a) => a.action);
const sessionsOf = async (authUserId: string) => db.select().from(parentAuthSession).where(eq(parentAuthSession.userId, authUserId));

describe("blocking and unblocking", () => {
  beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); });

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
