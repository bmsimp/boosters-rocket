import { describe, it, expect, vi, beforeEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { parent, parentAuthSession, parentEmailChange } from "@/lib/db/schema";
import { requestParentEmailChange, confirmParentEmailChange, setPrimaryGuardianEmailHook } from "@/lib/parents/email-change";
import { blockPerson } from "@/lib/parents/people";
import { resetDb, seedParent, seedGuardian, seedParentSession, seedWorkingMail } from "../helpers/db";

const tokenFrom = (m: Msg) => /token=([A-Za-z0-9_-]+)/.exec(m.text)![1]!;

describe("a parent changing their own email", () => {
  beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); setPrimaryGuardianEmailHook(async () => {}); });

  it("sends a confirm link to the new address and a notice to the old one, and changes nothing yet", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    expect(await requestParentEmailChange(p.id, "Ana.New@Example.com", { ip: null })).toEqual({ ok: true });
    expect(outbox.map((m) => m.to).sort()).toEqual(["ana.new@example.com", "ana@example.com"]);
    const link = outbox.find((m) => m.to === "ana.new@example.com")!;
    expect(link.text).toContain("http://localhost:3000/email-change/confirm?token=");
    const [row] = await db.select().from(parentEmailChange);
    expect(row!.tokenHash).not.toBe(tokenFrom(link)); // stored hashed
    expect((await db.select().from(parent))[0]!.email).toBe("ana@example.com");
  });

  it("on confirm updates the one record, ends sessions, tells QuickBooks about primary families, and works once", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedGuardian({ parentId: p.id, familyQboId: "F1", isPrimary: true });
    await seedGuardian({ parentId: p.id, familyQboId: "F2", isPrimary: false });
    await seedParentSession(p.authUserId);
    const calls: unknown[] = [];
    setPrimaryGuardianEmailHook(async (x) => { calls.push(x); });
    await requestParentEmailChange(p.id, "ana.new@example.com", { ip: null });
    const token = tokenFrom(outbox.find((m) => m.to === "ana.new@example.com")!);
    expect(await confirmParentEmailChange(token, { ip: "198.51.100.2" })).toEqual({ ok: true, parentId: p.id });
    expect((await db.select().from(parent))[0]!.email).toBe("ana.new@example.com");
    expect(await db.select().from(parentAuthSession)).toHaveLength(0);
    expect(calls).toEqual([{ parentId: p.id, email: "ana.new@example.com", familyQboIds: ["F1"] }]);
    expect(await confirmParentEmailChange(token, { ip: null })).toEqual({ ok: false, reason: "invalid" });
  });

  it("keeps the new address working when the QuickBooks update fails", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedGuardian({ parentId: p.id, familyQboId: "F1", isPrimary: true });
    setPrimaryGuardianEmailHook(async () => { throw new Error("QuickBooks is down"); });
    await requestParentEmailChange(p.id, "ana.new@example.com", { ip: null });
    expect(await confirmParentEmailChange(tokenFrom(outbox.find((m) => m.to === "ana.new@example.com")!), { ip: null })).toMatchObject({ ok: true });
    expect((await db.select().from(parent))[0]!.email).toBe("ana.new@example.com");
  });

  it("refuses an address in use, at request and again at confirm", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedParent({ name: "Ben", email: "ben@example.com" });
    expect(await requestParentEmailChange(p.id, "ben@example.com", { ip: null })).toEqual({ ok: false, reason: "in_use" });
    await requestParentEmailChange(p.id, "cy@example.com", { ip: null });
    const token = tokenFrom(outbox.find((m) => m.to === "cy@example.com")!);
    await seedParent({ name: "Cy", email: "cy@example.com" }); // someone else took it meanwhile
    expect(await confirmParentEmailChange(token, { ip: null })).toEqual({ ok: false, reason: "in_use" });
    expect((await db.select().from(parent)).find((x) => x.id === p.id)!.email).toBe("ana@example.com");
  });

  it("refuses an expired link", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    await requestParentEmailChange(p.id, "ana.new@example.com", { ip: null });
    await db.update(parentEmailChange).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await confirmParentEmailChange(tokenFrom(outbox.find((m) => m.to === "ana.new@example.com")!), { ip: null })).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("a blocked person and email changes", () => {
  const o = { actor: { door: "staff" as const, id: null, label: "board@club.org" }, ip: null };
  beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); setPrimaryGuardianEmailHook(async () => {}); });

  it("blocking deletes a pending change request", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    await requestParentEmailChange(p.id, "ana.new@example.com", { ip: null });
    expect(await db.select().from(parentEmailChange)).toHaveLength(1);
    await blockPerson(p.id, "reason", o);
    expect(await db.select().from(parentEmailChange)).toHaveLength(0);
  });

  it("refuses to confirm for a blocked person, changes nothing and does not call QuickBooks", async () => {
    const p = await seedParent({ name: "Ana", email: "ana@example.com" });
    await seedGuardian({ parentId: p.id, familyQboId: "F1", isPrimary: true });
    const calls: unknown[] = [];
    setPrimaryGuardianEmailHook(async (x) => { calls.push(x); });
    await requestParentEmailChange(p.id, "ana.new@example.com", { ip: null });
    await db.update(parent).set({ blocked: true }).where(eq(parent.id, p.id));
    const token = tokenFrom(outbox.find((m) => m.to === "ana.new@example.com")!);
    expect(await confirmParentEmailChange(token, { ip: null })).toEqual({ ok: false, reason: "invalid" });
    expect((await db.select().from(parent))[0]!.email).toBe("ana@example.com");
    expect(calls).toEqual([]);
  });
});
