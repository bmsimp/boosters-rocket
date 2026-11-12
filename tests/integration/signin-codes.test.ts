import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const mail = vi.hoisted(() => ({ outbox: [] as Msg[], attempted: [] as Msg[], gate: null as Promise<void> | null, fail: false }));
vi.mock("@/lib/mail/senders", async () => {
  const { MailSendError } = await import("@/lib/mail/types");
  return {
    SMTP_PASSWORD_AAD: "mail:smtp-password",
    buildSender: async () => async (m: Msg) => {
      if (mail.gate) await mail.gate;
      mail.attempted.push(m); // every message handed to the sender, sent or not
      if (mail.fail) throw new MailSendError("The mail server didn't accept the message (EENVELOPE 550).");
      mail.outbox.push(m);
    },
  };
});

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, setting, signinCode } from "@/lib/db/schema";
import { requestSigninCode, verifySigninCode, hashSigninCode, CODE_TTL_MS } from "@/lib/parents/signin-codes";
import { resetDb, seedParent, seedGuardian, seedWorkingMail } from "../helpers/db";
import { seedParentSettings } from "../helpers/roster-cache";

const T0 = new Date("2026-11-10T12:00:00Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const IP = "203.0.113.20";
const codeOf = (m: Msg) => /sign-in code: (\d{6})/.exec(m.subject)![1]!;
const audits = async (action: string) => (await db.select().from(auditLog)).filter((a) => a.action === action);
async function send(email: string, now = T0, ip: string | null = IP) { const r = await requestSigninCode(email, ip, now); await r.delivery; }

async function ana(o: { blocked?: boolean; status?: "invited" | "active" | "disabled" } = {}) {
  const p = await seedParent({ name: "Ana", email: "ana@example.com", blocked: o.blocked });
  await seedGuardian({ parentId: p.id, familyQboId: "F1", status: o.status ?? "active", disabledReason: o.status === "disabled" ? "removed" : null });
  return p;
}

describe("requesting a code", () => {
  beforeEach(async () => { await resetDb(); mail.outbox.length = 0; mail.attempted.length = 0; mail.gate = null; mail.fail = false; await seedWorkingMail(); });
  afterEach(() => vi.restoreAllMocks());

  it("counts every spelling of an address against the same 3 codes", async () => {
    await ana();
    const spellings = [" Ana@Example.com ", "ANA@EXAMPLE.COM", "ana@example.com", "Ana@example.COM  "];
    for (const [i, email] of spellings.entries()) await send(email, at(i * 61_000));
    expect(mail.outbox).toHaveLength(3);
    expect(mail.outbox.every((m) => m.to === "ana@example.com")).toBe(true);
    expect((await audits("signin.code_refused")).at(-1)).toMatchObject({ after: { reason: "rate_limited", limit: "email" } });
  }, 30_000);

  it("never puts the code in a log line, the audit log or the mail status when the send fails", async () => {
    await ana();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    mail.fail = true;
    await send("ana@example.com");
    expect(mail.outbox).toHaveLength(0);
    const code = codeOf(mail.attempted[0]!);
    expect((await audits("signin.code_refused"))[0]).toMatchObject({ after: { reason: "mail_failed" } });
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(code);
    expect(JSON.stringify([await db.select().from(auditLog), await db.select().from(setting)])).not.toContain(code);
  });

  it("sends a 6-digit code to a person with an enabled row, stored only as a hash, valid 10 minutes", async () => {
    const p = await ana();
    await send("ana@example.com");
    expect(mail.outbox).toHaveLength(1);
    const code = codeOf(mail.outbox[0]!);
    expect(code).toMatch(/^\d{6}$/);
    const [row] = await db.select().from(signinCode);
    expect(row!.codeHash).toBe(hashSigninCode(p.id, code));
    expect(row!.codeHash).not.toContain(code);
    expect(row!.expiresAt.getTime()).toBe(T0.getTime() + CODE_TTL_MS);
    expect((await audits("signin.code_sent"))[0]).toMatchObject({ door: "parent", actorId: p.id, targetType: "parent", targetId: p.id, ip: IP });
  });

  it.each([
    ["an unknown email", async (): Promise<void> => undefined, "unknown_email"],
    ["a blocked person", () => ana({ blocked: true }), "blocked"],
    ["a person whose rows are all disabled", () => ana({ status: "disabled" }), "no_enabled_guardian"],
  ] as const)("sends nothing to %s and audits why", async (_, setup, reason) => {
    await setup();
    await send("ana@example.com");
    expect(mail.outbox).toHaveLength(0);
    expect(await db.select().from(signinCode)).toHaveLength(0);
    expect((await audits("signin.code_refused"))[0]).toMatchObject({ actorLabel: "ana@example.com", after: { reason } });
  });

  it("matches case and spaces the same on both steps", async () => {
    const p = await ana();
    await send("  Ana@Example.COM ");
    expect(mail.outbox[0]!.to).toBe("ana@example.com");
    expect(await verifySigninCode(" ANA@example.com", codeOf(mail.outbox[0]!), IP, at(1000))).toEqual({ ok: true, parentId: p.id });
  });

  it("answers before the email is sent", async () => {
    await ana();
    let release!: () => void;
    mail.gate = new Promise<void>((r) => { release = r; });
    const r = await requestSigninCode("ana@example.com", IP, T0);
    expect(mail.outbox).toHaveLength(0); // the caller already has its answer; the send is still waiting
    release();
    await r.delivery;
    expect(mail.outbox).toHaveLength(1);
  });

  it("a new code replaces the earlier one, and only the newest works", async () => {
    await ana();
    await send("ana@example.com");
    await send("ana@example.com", at(61_000));
    const [first, second] = mail.outbox.map(codeOf);
    expect(await db.select().from(signinCode)).toHaveLength(1);
    if (first !== second) expect(await verifySigninCode("ana@example.com", first!, IP, at(62_000))).toEqual({ ok: false, reason: "rejected" });
    expect(await verifySigninCode("ana@example.com", second!, IP, at(63_000))).toMatchObject({ ok: true });
  });

  it("two requests at once leave exactly one live code", async () => {
    await ana();
    const rs = await Promise.all([requestSigninCode("ana@example.com", IP, T0), requestSigninCode("ana@example.com", IP, T0)]);
    await Promise.all(rs.map((r) => r.delivery));
    expect(await db.select().from(signinCode)).toHaveLength(1);
    expect(mail.outbox).toHaveLength(1);
    expect((await audits("signin.code_refused"))[0]).toMatchObject({ after: { reason: "rate_limited", limit: "resend" } });
  });

  it("holds 3 codes per email and 10 requests per IP in 15 minutes, and audits hitting them", async () => {
    await ana();
    for (let i = 0; i < 4; i++) await send("ana@example.com", at(i * 61_000));
    expect(mail.outbox).toHaveLength(3);
    expect((await audits("signin.code_refused")).at(-1)).toMatchObject({ after: { reason: "rate_limited", limit: "email" } });
    for (let i = 0; i < 7; i++) await send(`nobody${i}@example.com`, at(300_000), "198.51.100.7");
    await send("ana@example.com", at(300_000), "198.51.100.7"); // 8th from this IP: still allowed by the IP limit, refused by the email one
    for (let i = 0; i < 2; i++) await send(`more${i}@example.com`, at(300_000), "198.51.100.7");
    await send("x@example.com", at(300_000), "198.51.100.7");
    expect((await audits("signin.code_refused")).at(-1)).toMatchObject({ after: { reason: "rate_limited", limit: "ip" } });
  }, 30_000);

  it("audits a failed send as mail_failed and leaves no usable code", async () => {
    await ana();
    mail.fail = true;
    await send("ana@example.com");
    expect((await audits("signin.code_refused"))[0]).toMatchObject({ after: { reason: "mail_failed" } });
    expect(await db.select().from(signinCode)).toHaveLength(0);
  });

  it("sends nothing while mail isn't working", async () => {
    await resetDb();
    await ana();
    await send("ana@example.com");
    expect(mail.outbox).toHaveLength(0);
    expect((await audits("signin.code_refused"))[0]).toMatchObject({ after: { reason: "mail_failed", detail: "mail_not_working" } });
  });

  it("while mail isn't working, stops writing audit rows once the IP limit is reached", async () => {
    await resetDb();
    await ana();
    for (let i = 0; i < 15; i++) await send(`n${i}@example.com`, at(i));
    const refused = await audits("signin.code_refused");
    expect(refused.filter((a) => (a.after as { detail?: string }).detail === "mail_not_working")).toHaveLength(10);
    expect(refused.filter((a) => (a.after as { reason: string }).reason === "rate_limited")).toHaveLength(1);
    expect(refused).toHaveLength(11);
    expect(mail.outbox).toHaveLength(0);
  }, 30_000);

  it("audits a full email window once, and again in the next one", async () => {
    await ana();
    for (let i = 0; i < 8; i++) await send("ana@example.com", at(i * 61_000), `198.51.100.${i}`); // 3 sent, 5 past the limit
    expect(mail.outbox).toHaveLength(3);
    const limited = async () => (await audits("signin.code_refused")).filter((a) => (a.after as { reason: string }).reason === "rate_limited");
    expect(await limited()).toHaveLength(1);
    expect((await limited())[0]).toMatchObject({ actorLabel: "ana@example.com", after: { limit: "email" } });
    // The first code's slot frees 15 minutes after it was sent: one more goes out, and the next refusal is a new window.
    await send("ana@example.com", at(15 * 60_000 + 1), "198.51.100.50");
    expect(mail.outbox).toHaveLength(4);
    await send("ana@example.com", at(15 * 60_000 + 2), "198.51.100.51");
    await send("ana@example.com", at(15 * 60_000 + 3), "198.51.100.52");
    expect(await limited()).toHaveLength(2);
  }, 30_000);

  it("never puts the code in a log line or the audit log", async () => {
    await ana();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    await send("ana@example.com");
    const code = codeOf(mail.outbox[0]!);
    await verifySigninCode("ana@example.com", "000000" === code ? "111111" : "000000", IP, at(1000));
    await verifySigninCode("ana@example.com", code, IP, at(2000));
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(code);
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain(code);
  });
});

describe("checking a code", () => {
  beforeEach(async () => { await resetDb(); mail.outbox.length = 0; mail.gate = null; mail.fail = false; await seedWorkingMail(); });

  const wrong = (c: string) => String((Number(c) + 1) % 1_000_000).padStart(6, "0");

  it("works once", async () => {
    await ana();
    await send("ana@example.com");
    const code = codeOf(mail.outbox[0]!);
    expect(await verifySigninCode("ana@example.com", code, IP, at(1000))).toMatchObject({ ok: true });
    expect(await verifySigninCode("ana@example.com", code, IP, at(2000))).toEqual({ ok: false, reason: "rejected" });
    expect((await audits("signin.code_expired"))[0]).toMatchObject({ after: { reason: "no_code" } });
  });

  it("works once even when two checks race", async () => {
    await ana();
    await send("ana@example.com");
    const code = codeOf(mail.outbox[0]!);
    const rs = await Promise.all([verifySigninCode("ana@example.com", code, IP, at(1000)), verifySigninCode("ana@example.com", code, IP, at(1000))]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
  });

  it("expires after 10 minutes", async () => {
    await ana();
    await send("ana@example.com");
    expect(await verifySigninCode("ana@example.com", codeOf(mail.outbox[0]!), IP, at(CODE_TTL_MS))).toEqual({ ok: false, reason: "rejected" });
    expect((await audits("signin.code_expired"))[0]).toMatchObject({ after: { reason: "expired" } });
  });

  it("dies after 5 wrong tries, recording each try number", async () => {
    await ana();
    await send("ana@example.com");
    const code = codeOf(mail.outbox[0]!);
    for (let i = 1; i <= 5; i++) expect(await verifySigninCode("ana@example.com", wrong(code), IP, at(i * 1000))).toEqual({ ok: false, reason: "rejected" });
    expect(await verifySigninCode("ana@example.com", code, IP, at(6000))).toEqual({ ok: false, reason: "rejected" });
    expect((await audits("signin.code_wrong")).map((a) => (a.after as { try: number }).try)).toEqual([1, 2, 3, 4, 5]);
    expect((await audits("signin.code_expired"))[0]).toMatchObject({ after: { reason: "too_many_tries" } });
  });

  it("refuses a right code once the person's last guardian row was disabled after it was sent", async () => {
    const p = await ana();
    const [g] = await db.select().from(guardian).where(eq(guardian.parentId, p.id));
    await send("ana@example.com");
    await db.update(guardian).set({ status: "disabled", disabledReason: "removed" }).where(eq(guardian.id, g!.id));
    expect(await db.select().from(signinCode)).toHaveLength(1); // removing a row leaves the code live; the final check is what refuses it
    expect(await verifySigninCode("ana@example.com", codeOf(mail.outbox[0]!), IP, at(1000))).toEqual({ ok: false, reason: "rejected" });
    expect((await audits("signin.refused"))[0]).toMatchObject({ targetType: "parent", targetId: p.id, after: { reason: "no_enabled_guardian" } });
  });

  it("refuses a right code for a person blocked after it was sent", async () => {
    const p = await ana();
    await send("ana@example.com");
    const { blockPerson } = await import("@/lib/parents/people");
    await blockPerson(p.id, { actor: { door: "staff", id: null, label: "board" }, ip: null });
    expect(await verifySigninCode("ana@example.com", codeOf(mail.outbox[0]!), IP, at(1000))).toEqual({ ok: false, reason: "rejected" });
  });

  it("allows 30 checks per IP in 15 minutes", async () => {
    for (let i = 0; i < 30; i++) expect(await verifySigninCode(`n${i}@example.com`, "123456", IP, at(i))).toEqual({ ok: false, reason: "rejected" });
    expect(await verifySigninCode("n@example.com", "123456", IP, at(31))).toEqual({ ok: false, reason: "rate_limited" });
    expect((await audits("signin.code_refused")).at(-1)).toMatchObject({ after: { reason: "rate_limited", limit: "check_ip" } });
  }, 30_000);

  it("audits a full check window once, and again in the next one", async () => {
    for (let i = 0; i < 30; i++) await verifySigninCode(`n${i}@example.com`, "123456", IP, at(i));
    for (let i = 0; i < 5; i++) expect(await verifySigninCode("n@example.com", "123456", IP, at(100 + i))).toEqual({ ok: false, reason: "rate_limited" });
    const limited = async () => (await audits("signin.code_refused")).filter((a) => (a.after as { reason: string }).reason === "rate_limited");
    expect(await limited()).toHaveLength(1);
    expect((await limited())[0]).toMatchObject({ ip: IP, after: { limit: "check_ip" } });
    expect(await verifySigninCode("n@example.com", "123456", "198.51.100.9", at(200))).toEqual({ ok: false, reason: "rejected" }); // another IP has its own limit
    // 15 minutes after the first check its slot frees; the check after that fills the window again and is audited again.
    expect(await verifySigninCode("n@example.com", "123456", IP, at(15 * 60_000))).toEqual({ ok: false, reason: "rejected" });
    for (let i = 0; i < 5; i++) expect(await verifySigninCode("n@example.com", "123456", IP, at(15 * 60_000))).toEqual({ ok: false, reason: "rate_limited" });
    expect(await limited()).toHaveLength(2);
  }, 30_000);

  it("counts a code with letters or the wrong length as a wrong try", async () => {
    await ana();
    await send("ana@example.com");
    expect(await verifySigninCode("ana@example.com", "12a456", IP, at(1000))).toEqual({ ok: false, reason: "rejected" });
    const [row] = await db.select().from(signinCode);
    expect(row!.tries).toBe(1);
    expect(await verifySigninCode("ana@example.com", ` ${codeOf(mail.outbox[0]!).slice(0, 3)} ${codeOf(mail.outbox[0]!).slice(3)} `, IP, at(2000))).toMatchObject({ ok: true });
  });
});

describe("when an Admin has switched parent sign-ins off", () => {
  beforeEach(async () => { await resetDb(); mail.outbox.length = 0; mail.attempted.length = 0; mail.gate = null; mail.fail = false; await seedWorkingMail(); });

  it("refuses a code, and audits why, once sign-ins have been switched off", async () => {
    await ana();
    await seedParentSettings({ signin: false, everEnabled: true });
    await send("ana@example.com");
    expect(mail.outbox).toHaveLength(0);
    expect(await db.select().from(signinCode)).toEqual([]);
    expect((await audits("signin.code_refused")).at(-1)).toMatchObject({ actorLabel: "ana@example.com", after: { reason: "signins_off" } });
  });

  it("still sends codes before parent sign-ins have ever been switched on", async () => {
    await ana();
    await seedParentSettings({ signin: false, everEnabled: false });
    await send("ana@example.com");
    expect(mail.outbox).toHaveLength(1);
    expect(await db.select().from(signinCode)).toHaveLength(1);
  });

  it("still sends codes while sign-ins are on", async () => {
    await ana();
    await seedParentSettings({ signin: true, everEnabled: true });
    await send("ana@example.com");
    expect(mail.outbox).toHaveLength(1);
  });

  it("refuses a correct code entered after sign-ins were switched off", async () => {
    const p = await ana();
    await seedParentSettings({ signin: true, everEnabled: true });
    await send("ana@example.com");
    const code = codeOf(mail.outbox[0]!);
    await seedParentSettings({ signin: false, everEnabled: true });
    expect(await verifySigninCode("ana@example.com", code, IP, at(1000))).toEqual({ ok: false, reason: "rejected" });
    expect((await audits("signin.refused")).at(-1)).toMatchObject({ targetType: "parent", targetId: p.id, after: { reason: "signins_off" } });
  });
});
