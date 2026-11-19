import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A sign-in that meets a change of address half way (parents spec, the two gaps it listed as known). The real reconcile
 * changes a person's address in place, and is held at the one moment that matters: after it has written the new address
 * and before it deletes the person's codes and ends their sessions. A code request, or a code check, then runs against
 * it for real, on its own database connection, and the reconcile is let go once the other side is waiting on a lock.
 *
 * Before the fix each of these went wrong: the code was mailed to the old address and worked with the new one; with an
 * earlier code on file the two deadlocked and Postgres ended one of them; and a code proved with the old address became
 * a session after the change had ended the person's sessions.
 */
type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

const gate = vi.hoisted(() => ({ held: null as Promise<void> | null, reached: false, release: () => {} }));
vi.mock("@/lib/parents/sessions", async (original) => {
  const real = await original<typeof import("@/lib/parents/sessions")>();
  return {
    ...real,
    // The reconcile calls this right after it has written the new address (src/lib/parents/reconcile.ts).
    deleteUnusedSigninCodes: async (...args: Parameters<typeof real.deleteUnusedSigninCodes>) => {
      if (gate.held) { gate.reached = true; await gate.held; }
      return real.deleteUnusedSigninCodes(...args);
    },
  };
});

import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, parent, parentAuthSession, signinCode } from "@/lib/db/schema";
import { getParentAuth } from "@/lib/auth/parent-auth";
import { requestSigninCode, verifySigninCode, hashSigninCode } from "@/lib/parents/signin-codes";
import { enterableGuardianRows } from "@/lib/parents/sessions";
import { env } from "@/env";
import { resetDb, seedWorkingMail } from "../helpers/db";
import { runReconcile } from "../helpers/reconcile";
import { seedCache, seedRosterRead, seedShape, seedParentSettings, SIGNINS_ON, fam, par, stu } from "../helpers/roster-cache";

const IP = "203.0.113.40";
const REALM = "9130000000000001";
const OLD = "ana@example.com", NEW = "ana.new@example.com";
const T0 = new Date("2026-11-10T12:00:00Z");
const codeOf = (m: Msg) => /sign-in code: (\d{6})/.exec(m.subject)![1]!;
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((a) => a.action === action);
const roster = (email: string) => [fam("10", "Rivera Family"), par("11", "Ana Rivera", "10", email), stu("12", "Leo Rivera", "10")];

/** Somebody in this database is waiting for a lock another transaction holds. */
async function someoneWaitsForALock(): Promise<boolean> {
  const [row] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
  return (row?.n ?? 0) > 0;
}

/** Starts the reconcile that changes Ana's address in place, and returns once it has written the new address and stopped. */
async function addressChangeUnderWay(): Promise<{ finish: () => Promise<void> }> {
  await seedCache(roster(NEW));
  gate.reached = false;
  gate.held = new Promise<void>((resolve) => { gate.release = resolve; });
  const changing = runReconcile({ cause: "test" });
  await vi.waitFor(() => expect(gate.reached).toBe(true), { timeout: 10_000 });
  return {
    finish: async () => {
      // The gate is let go whatever happens, so a failure here can't leave the reconcile holding its locks into the
      // next test's set-up.
      try {
        await vi.waitFor(async () => expect(await someoneWaitsForALock()).toBe(true), { timeout: 10_000, interval: 50 });
      } finally {
        gate.held = null; gate.release();
      }
      expect(await changing).toMatchObject({ ran: true, emailChanged: 1 });   // the reconcile was not the loser of a deadlock
    },
  };
}

describe("a sign-in that meets a change of address", () => {
  let ana: typeof parent.$inferSelect;
  beforeEach(async () => {
    // A reconcile an earlier test left at the gate is let go before anything else.
    gate.held = null; gate.reached = false; gate.release();
    await resetDb(); outbox.length = 0;
    // The roster's company first, so the read below gives the family its app record: a code goes only to a person with
    // an open row in an active family (enterableGuardianRows()).
    await seedWorkingMail(); await seedRosterRead({ realmId: REALM }); await seedShape(); await seedParentSettings(SIGNINS_ON);
    await seedCache(roster(OLD));
    await runReconcile({ cause: "test" });
    [ana] = await db.select().from(parent) as [typeof parent.$inferSelect];
    expect(ana.email).toBe(OLD);
    expect(await enterableGuardianRows(ana.id)).toHaveLength(1);
  });

  it("mails no code to an address that is being replaced", async () => {
    const change = await addressChangeUnderWay();
    const asked = requestSigninCode(OLD, IP, T0);
    await change.finish();
    await (await asked).delivery;
    expect(outbox).toEqual([]);
    expect(await db.select().from(signinCode)).toEqual([]);
    expect((await audits("signin.code_refused")).at(-1)).toMatchObject({ actorId: null, actorLabel: OLD, after: { reason: "unknown_email" } });
    expect((await db.select().from(parent))[0]!.email).toBe(NEW);
    // The new address is the one that works now.
    await (await requestSigninCode(NEW, IP, new Date(T0.getTime() + 1000))).delivery;
    expect(outbox.map((m) => m.to)).toEqual([NEW]);
    expect(await verifySigninCode(NEW, codeOf(outbox[0]!), IP, new Date(T0.getTime() + 2000))).toEqual({ ok: true, parentId: ana.id });
  }, 30_000);

  it("neither side is the loser of a deadlock when the person already holds an unused code", async () => {
    await db.insert(signinCode).values({ parentId: ana.id, codeHash: hashSigninCode(ana.id, "123456"), expiresAt: new Date(T0.getTime() + 60_000), createdAt: new Date(T0.getTime() - 120_000) });
    const change = await addressChangeUnderWay();
    const asked = requestSigninCode(OLD, IP, T0);
    await change.finish();
    await (await asked).delivery;               // resolves: the request was not ended by the database either
    expect(outbox).toEqual([]);
    expect(await db.select().from(signinCode)).toEqual([]);   // the change deleted the earlier code, and no new one was stored
    expect((await db.select().from(parent))[0]!.email).toBe(NEW);
  }, 30_000);

  it("a request that got in first is mailed to the address of that moment, and the change then ends its code", async () => {
    await (await requestSigninCode(OLD, IP, T0)).delivery;
    expect(outbox.map((m) => m.to)).toEqual([OLD]);
    await seedCache(roster(NEW));
    expect(await runReconcile({ cause: "test" })).toMatchObject({ emailChanged: 1 });
    const code = codeOf(outbox[0]!);
    for (const address of [OLD, NEW]) expect(await verifySigninCode(address, code, IP, new Date(T0.getTime() + 1000))).toEqual({ ok: false, reason: "rejected" });
  }, 30_000);

  it("makes no session from a code that was proved with the old address while the change was under way", async () => {
    await (await requestSigninCode(OLD, IP, new Date())).delivery;
    const code = codeOf(outbox[0]!);
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
    expect((await audits("signin.refused")).at(-1)).toMatchObject({ actorId: ana.id, targetId: ana.id, after: { reason: "address_changed" }, ip: IP });
    expect(await audits("signin")).toEqual([]);                       // nothing was recorded as a sign-in
    expect(await audits("guardian.activate")).toEqual([]);
  }, 30_000);
});
