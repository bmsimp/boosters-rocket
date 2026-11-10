import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, setting } from "@/lib/db/schema";
import { getSetupState, updateSetupState, saveAdminEmail, finishSetup, setupStatusCached, clearSetupStatusCache, SETUP_CODE_KEY } from "@/lib/setup/state";
import { issueSetupCode, verifySetupCode, resetSetupCodeLimiter, readStoredCode, MAX_FAILED_TOTAL } from "@/lib/setup/code";
import { resetDb, seedStaff } from "../helpers/db";

const actions = async () => (await db.select().from(auditLog)).map((a) => a.action);

describe("setup state", () => {
  beforeEach(async () => { await resetDb(); resetSetupCodeLimiter(); clearSetupStatusCache(); });

  it("starts open at the staff step", async () => {
    expect(await getSetupState()).toEqual({ status: "open", step: "staff", adminEmail: null, finishedAt: null });
  });

  it("reads an old or unknown step as the staff step", async () => {
    await db.insert(setting).values({ key: "setup.state", value: { status: "open", step: "parent", adminEmail: null, finishedAt: null } })
      .onConflictDoUpdate({ target: setting.key, set: { value: { status: "open", step: "parent", adminEmail: null, finishedAt: null } } });
    expect((await getSetupState()).step).toBe("staff");
  });

  it("has the mail step between staff sign-in and the first Admin", async () => {
    const { SETUP_STEPS } = await import("@/lib/setup/state");
    expect(SETUP_STEPS).toEqual(["staff", "mail", "admin"]);
    await updateSetupState({ step: "mail" });
    expect((await getSetupState()).step).toBe("mail");
  });

  it("saves the Admin email lower-cased and audits it", async () => {
    expect(await saveAdminEmail("  First.Admin@Club.ORG ", null)).toEqual({ ok: true });
    expect((await getSetupState()).adminEmail).toBe("first.admin@club.org");
    expect(await actions()).toEqual(["setup.admin_email.save"]);
    expect(await saveAdminEmail("not an email", null)).toEqual({ ok: false, error: "Enter a valid email address." });
  });

  it("finishes once, deletes the code and audits", async () => {
    await issueSetupCode();
    const s = await seedStaff({ email: "a@club.org", admin: true });
    await finishSetup({ staffUserId: s.id, email: "a@club.org", ip: null });
    await finishSetup({ staffUserId: s.id, email: "a@club.org", ip: null });
    expect((await getSetupState()).status).toBe("finished");
    expect(await db.select().from(setting).where(eq(setting.key, SETUP_CODE_KEY))).toHaveLength(0);
    expect((await actions()).filter((a) => a === "setup.finish")).toHaveLength(1);
  });

  it("caches the status briefly for the proxy", async () => {
    expect(await setupStatusCached(1000)).toBe("open");
    await db.insert(setting).values({ key: "setup.state", value: { status: "finished", step: "admin", adminEmail: null, finishedAt: null } })
      .onConflictDoUpdate({ target: setting.key, set: { value: { status: "finished" } } });
    expect(await setupStatusCached(2000)).toBe("open");
    expect(await setupStatusCached(1000 + 6000)).toBe("finished");
  });

  it("updateSetupState clears the cache in this process", async () => {
    expect(await setupStatusCached()).toBe("open");
    await updateSetupState({ status: "finished" });
    expect(await setupStatusCached()).toBe("finished");
  });
});

describe("setup code verification", () => {
  beforeEach(async () => { await resetDb(); resetSetupCodeLimiter(); });

  it("unlocks with the right code in any case or spacing, and audits", async () => {
    const code = await issueSetupCode();
    const r = await verifySetupCode(code.toLowerCase().replaceAll("-", " "), "203.0.113.5");
    expect(r.ok).toBe(true);
    expect(await actions()).toEqual(["setup.code.issue", "setup.unlock"]);
  });

  it("refuses a wrong code and counts it", async () => {
    await issueSetupCode();
    expect(await verifySetupCode("AAAA-AAAA-AAAA", "203.0.113.5")).toEqual({ ok: false, reason: "wrong" });
    expect((await readStoredCode())!.failedTotal).toBe(1);
    expect(await actions()).toContain("setup.unlock.refused");
  });

  it("slows down after 5 wrong tries from one address, but not from another", async () => {
    const code = await issueSetupCode();
    for (let i = 0; i < 5; i++) await verifySetupCode("AAAA-AAAA-AAAA", "203.0.113.5", 1000 + i);
    expect(await verifySetupCode(code, "203.0.113.5", 2000)).toEqual({ ok: false, reason: "slowed" });
    expect((await verifySetupCode(code, "198.51.100.7", 2000)).ok).toBe(true);
    expect((await verifySetupCode(code, "203.0.113.5", 2000 + 15 * 60_000)).ok).toBe(true);
  });

  it("voids the code after 20 wrong tries in total, even across restarts", async () => {
    const code = await issueSetupCode();
    for (let i = 0; i < MAX_FAILED_TOTAL; i++) { resetSetupCodeLimiter(); await verifySetupCode("AAAA-AAAA-AAAA", `203.0.113.${i + 1}`); }
    resetSetupCodeLimiter();
    expect(await verifySetupCode(code, "198.51.100.7")).toEqual({ ok: false, reason: "void" });
  });

  it("a parallel burst from many addresses cannot get past the 20-try total", async () => {
    const code = await issueSetupCode();
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => verifySetupCode("AAAA-AAAA-AAAA", `203.0.113.${i + 1}`)));
    const reasons = results.map((r) => (r.ok ? "ok" : r.reason));
    expect(reasons.filter((r) => r === "wrong").length).toBeLessThanOrEqual(MAX_FAILED_TOTAL);
    expect(reasons.filter((r) => r === "void").length).toBeGreaterThanOrEqual(10);
    expect((await readStoredCode())!.failedTotal).toBe(MAX_FAILED_TOTAL);
    resetSetupCodeLimiter();
    expect(await verifySetupCode(code, "198.51.100.7")).toEqual({ ok: false, reason: "void" });
  });

  it("a parallel burst from one address gets at most 5 tries", async () => {
    await issueSetupCode();
    const results = await Promise.all(Array.from({ length: 10 }, () => verifySetupCode("AAAA-AAAA-AAAA", "203.0.113.5")));
    const reasons = results.map((r) => (r.ok ? "ok" : r.reason));
    expect(reasons.filter((r) => r === "wrong")).toHaveLength(5);
    expect(reasons.filter((r) => r === "slowed")).toHaveLength(5);
  });

  it("a right code does not use up a try", async () => {
    const code = await issueSetupCode();
    expect((await verifySetupCode(code, "203.0.113.5")).ok).toBe(true);
    expect((await readStoredCode())!.failedTotal).toBe(0);
  });

  it("refuses a non-string input as wrong without throwing", async () => {
    await issueSetupCode();
    expect(await verifySetupCode(null, "203.0.113.5")).toEqual({ ok: false, reason: "wrong" });
  });

  it("says when no code has been issued", async () => {
    expect(await verifySetupCode("AAAA-AAAA-AAAA", null)).toEqual({ ok: false, reason: "no_code" });
  });
});
