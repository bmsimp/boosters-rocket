import { describe, it, expect, vi, beforeEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

/**
 * Each password check, as better-auth/crypto runs it, with a gate a test can hold shut (so checks pile up behind the
 * ones running), a hook run inside the check (`during`), and counts of how many started and how many ran at once.
 */
const hold = vi.hoisted(() => ({ gate: null as Promise<void> | null, during: null as (() => void) | null, started: 0, running: 0, most: 0 }));
vi.mock("better-auth/crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("better-auth/crypto")>();
  return {
    ...real,
    verifyPassword: async (data: Parameters<typeof real.verifyPassword>[0]) => {
      hold.started++; hold.running++; hold.most = Math.max(hold.most, hold.running);
      try {
        hold.during?.();
        if (hold.gate) await hold.gate;
        return await real.verifyPassword(data);
      } finally { hold.running--; }
    },
  };
});

import { db } from "@/lib/db/client";
import { auditLog, rateLimitEvent, signinCode } from "@/lib/db/schema";
import { checkPasswordSignin, hashTriedAddress, MOST_WAITING_TO_CHECK, passwordChecksWaiting } from "@/lib/parents/password-signin";
import { CODE_TTL_MS } from "@/lib/parents/signin-codes";
import { resetDb, seedParent, seedGuardianInFamily, seedWorkingMail } from "../helpers/db";
import { SIGNINS_ON, seedParentSettings } from "../helpers/roster-cache";
import { DOOR_PASSWORD, cookieNamed, passwordStep } from "../helpers/parent-door";
import { seedPassword } from "../helpers/signin-links";

/**
 * The wait for a password check (inTurn(), src/lib/parents/password-signin.ts; the sign-in release, slice SI-3b): at
 * most two checks at once and twenty waiting, the next turned away at once with the over-limit answer; a try whose
 * request is given up leaves the wait; and what follows a right password is timed from when its check finished.
 */
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const anasCount = async () => (await db.select().from(rateLimitEvent)).filter((e) => e.subject === hashTriedAddress("ana@example.com"));
/** A gate the checks wait at until `open()`. */
function shutTheGate() {
  let open!: () => void;
  hold.gate = new Promise<void>((go) => { open = go; });
  return open;
}

async function seedAna() {
  const ana = await seedParent({ name: "Ana", email: "ana@example.com" });
  await seedGuardianInFamily({ parentId: ana.id, familyQboId: "F1" });
  await seedPassword(ana.authUserId, DOOR_PASSWORD);
  return ana;
}

describe("the wait for a password check", () => {
  beforeEach(async () => {
    await resetDb(); outbox.length = 0; await seedWorkingMail(); await seedParentSettings(SIGNINS_ON);
    Object.assign(hold, { gate: null, during: null, started: 0, running: 0, most: 0 });
  });

  it("runs at most two checks at once with twenty waiting, and turns the next away at once with the over-limit answer, audited once", async () => {
    await seedAna();
    const open = shutTheGate();
    // With no visitor's address (the per-IP limit skipped), tries for made-up addresses, each its own count.
    const tries = Array.from({ length: 2 + MOST_WAITING_TO_CHECK }, (_, i) => checkPasswordSignin(`nobody${i}@example.com`, "not a password", null, null));
    await vi.waitFor(() => {
      expect(hold.started).toBe(2);
      expect(passwordChecksWaiting()).toBe(MOST_WAITING_TO_CHECK);
    });
    // The wait is full: Ana's right password is turned away at once, twice, while the gate is still shut, before it
    // is counted or anything is read for it.
    expect(await checkPasswordSignin("ana@example.com", DOOR_PASSWORD, null, null)).toEqual({ ok: false, limited: true });
    expect(await checkPasswordSignin("ana@example.com", DOOR_PASSWORD, null, null)).toEqual({ ok: false, limited: true });
    expect(await anasCount()).toEqual([]);
    // Recorded once, naming nobody, not once per try.
    const busy = (await audits("signin.password_refused")).filter((r) => (r.after as { limit?: string }).limit === "busy");
    expect(busy.map((r) => [r.actorId, r.actorLabel, r.targetId, r.after])).toEqual([[null, null, null, { reason: "rate_limited", limit: "busy" }]]);

    open();
    expect(await Promise.all(tries)).toEqual(Array(tries.length).fill({ ok: false, limited: false }));
    expect(hold.started).toBe(tries.length);
    expect(hold.most).toBe(2);
    expect(passwordChecksWaiting()).toBe(0);
    // With the wait empty again, her right password goes on, and its place is given back.
    hold.gate = null;
    expect(await checkPasswordSignin("ana@example.com", DOOR_PASSWORD, null, null)).toMatchObject({ ok: true });
    expect(await anasCount()).toEqual([]);
  });

  it("a try whose request is given up while it waits leaves the wait, runs no check and gives its place back", async () => {
    await seedAna();
    const open = shutTheGate();
    const running = [0, 1].map((i) => checkPasswordSignin(`nobody${i}@example.com`, "not a password", null, null));
    await vi.waitFor(() => expect(hold.started).toBe(2));
    const client = new AbortController();
    const given = checkPasswordSignin("ana@example.com", DOOR_PASSWORD, null, null, new Date(), client.signal);
    await vi.waitFor(() => expect(passwordChecksWaiting()).toBe(1));
    expect(await anasCount()).toHaveLength(1);   // counted before its turn, as every try is
    client.abort();
    expect(await given).toEqual({ ok: false, limited: false });
    expect(passwordChecksWaiting()).toBe(0);
    open();
    await Promise.all(running);
    expect(hold.started).toBe(2);   // hers never ran
    expect(await anasCount()).toEqual([]);
    expect(await audits("signin.second_step_asked")).toEqual([]);
    // A request given up before it is sent anywhere is refused the same way, counting nothing.
    const gone = new AbortController();
    gone.abort();
    expect(await checkPasswordSignin("ana@example.com", DOOR_PASSWORD, null, null, new Date(), gone.signal)).toEqual({ ok: false, limited: false });
    expect(await anasCount()).toEqual([]);
  });

  it("times the pending step and its code from when the check finished, so a wait for a turn never shortens what the mail promises", async () => {
    await seedAna();
    const waited = 9 * 60_000;
    let start = 0;
    vi.useFakeTimers({ toFake: ["Date"] });
    let answer: Awaited<ReturnType<typeof passwordStep>>;
    try {
      start = Date.now();
      // The check finishes nine minutes after the try arrived, as after a long wait for its turn.
      hold.during = () => vi.setSystemTime(start + waited);
      answer = await passwordStep("ana@example.com");
    } finally {
      hold.during = null;
      vi.useRealTimers();
    }
    expect(answer.body).toEqual({ ok: true, step: "code" });
    // The step ends a code's life after the check, not after the try arrived (which would leave it one minute).
    const value = decodeURIComponent(cookieNamed(answer.res, "signin_step").split("=")[1]!).replace(/\.[^.]*$/, "");
    expect((JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { x: number }).x).toBe(start + waited + CODE_TTL_MS);
    // And so does its code, whose mail promises what it has.
    const [row] = await db.select().from(signinCode);
    expect(row!.expiresAt.getTime()).toBe(start + waited + CODE_TTL_MS);
    expect(row!.createdAt.getTime()).toBe(start + waited);
    await vi.waitFor(() => expect(outbox).toHaveLength(1));
    expect(outbox[0]!.text).toContain("It expires in 10 minutes.");
  });
});
