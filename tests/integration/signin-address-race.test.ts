import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";

/**
 * A sign-in that meets a change of address half way (parents spec, the two gaps it listed as known). The change is a
 * parent's own confirmed change of sign-in email (confirmMyEmailChange(), src/lib/parents/email-change.ts), the one way a
 * person's address changes since the reconcile went, made in the portal alone (stage 3's slice 11d: nothing of QuickBooks
 * is read or written) and held at the one moment that matters: after it has written the new address and before it
 * deletes the person's codes and ends their sessions. A code request, or a code check, then runs against it for real, on its own database connection, and the
 * change is let go once the other side is waiting on a lock.
 *
 * Before the fix each of these went wrong: the code was mailed to the old address and worked with the new one; with an
 * earlier code on file the two deadlocked and Postgres ended one of them; and a code proved with the old address became
 * a session after the change had ended the person's sessions.
 */
const stubBase = vi.hoisted(() => ({ url: "" }));
vi.mock("@/lib/quickbooks/endpoints", async (original) => {
  const m = await original<typeof import("@/lib/quickbooks/endpoints")>();
  return { ...m, qboEndpoints: () => ({ authorize: `${stubBase.url}/authorize`, token: `${stubBase.url}/token`, revoke: `${stubBase.url}/revoke`,
    api: { sandbox: stubBase.url, production: stubBase.url } }) };
});
type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

const gate = vi.hoisted(() => ({ held: null as Promise<void> | null, reached: false, release: () => {} }));
vi.mock("@/lib/parents/sessions", async (original) => {
  const real = await original<typeof import("@/lib/parents/sessions")>();
  return {
    ...real,
    // The change calls this right after it has written the new address (src/lib/parents/email-change.ts).
    deleteUnusedSigninCodes: async (...args: Parameters<typeof real.deleteUnusedSigninCodes>) => {
      if (gate.held) { gate.reached = true; await gate.held; }
      return real.deleteUnusedSigninCodes(...args);
    },
  };
});

import { eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, parent, parentAuthSession, signinCode } from "@/lib/db/schema";
import { getParentAuth } from "@/lib/auth/parent-auth";
import { confirmMyEmailChange } from "@/lib/parents/email-change";
import { requestSigninCode, verifySigninCode, hashSigninCode } from "@/lib/parents/signin-codes";
import { enterableGuardianRows } from "@/lib/parents/sessions";
import { env } from "@/env";
import { resetDb, seedWorkingMail } from "../helpers/db";
import { seedContactFamilies } from "../helpers/contact";
import { seedEmailChange } from "../helpers/email-change";
import { RIVERA } from "../helpers/money";
import type { SeededParent } from "../helpers/parent";
import { startQboStub, type QboStub } from "../helpers/qbo-stub";

let stub: QboStub;
beforeAll(async () => { stub = await startQboStub(); stubBase.url = stub.base; });
afterAll(() => stub.close());

const IP = "203.0.113.40";
const OLD = RIVERA.parent.email, NEW = "rosalind.new@family-r.example";
const T0 = new Date("2026-11-10T12:00:00Z");
const codeOf = (m: Msg) => /sign-in code: (\d{6})/.exec(m.subject)![1]!;
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((a) => a.action === action);
const addressOf = async (id: string) => (await db.select({ email: parent.email }).from(parent).where(eq(parent.id, id)))[0]!.email;

/** Somebody in this database is waiting for a lock another transaction holds. */
async function someoneWaitsForALock(): Promise<boolean> {
  const [row] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
  return (row?.n ?? 0) > 0;
}

let r: SeededParent;
/** The parent's own confirmed change, from OLD to NEW, made in the portal alone, from the session the parent confirms in. */
async function confirmTheChange() {
  const { token } = await seedEmailChange({ parentId: r.identity.parentId, guardianId: r.identity.guardianId, familyId: r.identity.familyId,
    recordQboId: RIVERA.parent.qboId, newEmail: NEW });
  return confirmMyEmailChange({ ...r.identity, ip: null }, token);
}

/** Starts the change of Ana's address, and returns once it has written the new address and stopped. */
async function addressChangeUnderWay(): Promise<{ finish: () => Promise<void> }> {
  gate.reached = false;
  gate.held = new Promise<void>((resolve) => { gate.release = resolve; });
  const changing = confirmTheChange();
  await vi.waitFor(() => expect(gate.reached).toBe(true), { timeout: 10_000 });
  return {
    finish: async () => {
      // The gate is let go whatever happens, so a failure here can't leave the change holding its locks into the
      // next test's set-up.
      try {
        await vi.waitFor(async () => expect(await someoneWaitsForALock()).toBe(true), { timeout: 10_000, interval: 50 });
      } finally {
        gate.held = null; gate.release();
      }
      expect(await changing).toMatchObject({ ok: true });   // the change was not the loser of a deadlock
    },
  };
}

describe("a sign-in that meets a change of address", () => {
  beforeEach(async () => {
    // A change an earlier test left at the gate is let go before anything else.
    gate.held = null; gate.reached = false; gate.release();
    await resetDb(); stub.reset(); outbox.length = 0;
    await seedWorkingMail();
    ({ r } = await seedContactFamilies(stub));
    expect(await addressOf(r.identity.parentId)).toBe(OLD);
    expect(await enterableGuardianRows(r.identity.parentId)).toHaveLength(1);
  });

  it("mails no code to an address that is being replaced", async () => {
    const change = await addressChangeUnderWay();
    const asked = requestSigninCode(OLD, IP, T0);
    await change.finish();
    await (await asked).delivery;
    expect(outbox).toEqual([]);
    expect(await db.select().from(signinCode)).toEqual([]);
    expect((await audits("signin.code_refused")).at(-1)).toMatchObject({ actorId: null, actorLabel: OLD, after: { reason: "unknown_email" } });
    expect(await addressOf(r.identity.parentId)).toBe(NEW);
    // The new address is the one that works now.
    await (await requestSigninCode(NEW, IP, new Date(T0.getTime() + 1000))).delivery;
    expect(outbox.map((m) => m.to)).toEqual([NEW]);
    expect(await verifySigninCode(NEW, codeOf(outbox[0]!), IP, new Date(T0.getTime() + 2000))).toEqual({ ok: true, parentId: r.identity.parentId, codeId: expect.any(String) });
  }, 30_000);

  it("neither side is the loser of a deadlock when the person already holds an unused code", async () => {
    await db.insert(signinCode).values({ parentId: r.identity.parentId, codeHash: hashSigninCode(r.identity.parentId, "123456"),
      expiresAt: new Date(T0.getTime() + 60_000), createdAt: new Date(T0.getTime() - 120_000) });
    const change = await addressChangeUnderWay();
    const asked = requestSigninCode(OLD, IP, T0);
    await change.finish();
    await (await asked).delivery;               // resolves: the request was not ended by the database either
    expect(outbox).toEqual([]);
    expect(await db.select().from(signinCode)).toEqual([]);   // the change deleted the earlier code, and no new one was stored
    expect(await addressOf(r.identity.parentId)).toBe(NEW);
  }, 30_000);

  it("a request that got in first is mailed to the address of that moment, and the change then ends its code", async () => {
    await (await requestSigninCode(OLD, IP, T0)).delivery;
    expect(outbox.map((m) => m.to)).toEqual([OLD]);
    expect(await confirmTheChange()).toMatchObject({ ok: true });
    const code = codeOf(outbox[0]!);
    for (const address of [OLD, NEW]) expect(await verifySigninCode(address, code, IP, new Date(T0.getTime() + 1000))).toEqual({ ok: false, reason: "rejected" });
  }, 30_000);

  it("makes no session from a code that was proved with the old address while the change was under way", async () => {
    await (await requestSigninCode(OLD, IP, new Date())).delivery;
    const code = codeOf(outbox[0]!);
    // The parent is signed out of the browser the code is checked in; the session the change is confirmed in stays, as the
    // confirm reads it again under the person's row (and the change then ends it).
    await db.delete(parentAuthSession).where(ne(parentAuthSession.id, r.identity.sessionId));
    const change = await addressChangeUnderWay();
    const auth = await getParentAuth();
    const checking = auth.handler(new Request(`${env.APP_URL}/api/auth/parent/portal-code/verify`, {
      method: "POST", body: JSON.stringify({ email: OLD, code }), headers: { "content-type": "application/json", origin: env.APP_URL, "cf-connecting-ip": IP },
    }));
    await change.finish();
    const res = await checking;
    expect(await res.json()).toEqual({ ok: false, error: "rejected" });
    expect(res.headers.getSetCookie().some((c) => c.startsWith("br_parent.session_token=") && !/Max-Age=0/i.test(c))).toBe(false);
    expect(await db.select().from(parentAuthSession)).toEqual([]);
    expect((await audits("signin.refused")).at(-1)).toMatchObject({ actorId: r.identity.parentId, targetId: r.identity.parentId, after: { reason: "address_changed" }, ip: IP });
    expect(await audits("signin")).toEqual([]);                       // nothing was recorded as a sign-in
    expect(await audits("guardian.activate")).toEqual([]);
  }, 30_000);
});
