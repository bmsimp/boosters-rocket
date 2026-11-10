import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const box = vi.hoisted(() => ({ fail: null as string | null, sent: [] as Msg[] }));
vi.mock("@/lib/mail/senders", async () => {
  const { MailSendError } = await import("@/lib/mail/types");
  return {
    SMTP_PASSWORD_AAD: "mail:smtp-password",
    buildSender: async () => async (m: Msg) => { if (box.fail) throw new MailSendError(box.fail); box.sent.push(m); },
  };
});

import { db } from "@/lib/db/client";
import { auditLog, setting } from "@/lib/db/schema";
import { saveMailSettings, mailWorking, mailSummary, mailAttention, getStoredMailConfig } from "@/lib/mail/settings";
import { sendMail, sendTestMail } from "@/lib/mail/send";
import { signinCodeMessage } from "@/lib/mail/messages";
import { resetDb, seedProvider } from "../helpers/db";

const actor = { door: "staff" as const, id: null, label: "admin@example.org" };
const o = { actor, ip: "203.0.113.5", permission: "Settings.Mail.ReadWrite" };
const smtp = { method: "smtp" as const, host: "smtp.example.org", port: 587, security: "starttls" as const, username: "u", from: "club@example.org" };
const cipher = async () => { const c = await getStoredMailConfig(); return c?.method === "smtp" ? c.passwordCiphertext : null; };

describe("mail settings", () => {
  beforeEach(async () => { await resetDb(); box.fail = null; box.sent.length = 0; });
  afterEach(() => vi.restoreAllMocks());

  it("seals the SMTP password, never returns it, and audits the save without it", async () => {
    expect(await saveMailSettings({ ...smtp, password: "hunter2-secret" }, o)).toEqual({ ok: true });
    expect(JSON.stringify(await getStoredMailConfig())).not.toContain("hunter2-secret");
    const summary = await mailSummary();
    expect(summary).toMatchObject({ config: smtp, passwordSaved: true, passwordReadable: true, working: false });
    expect(JSON.stringify(summary)).not.toMatch(/hunter2|Ciphertext/);
    const audits = await db.select().from(auditLog);
    expect(audits.map((a) => a.action)).toEqual(["settings.mail.save"]);
    expect(JSON.stringify(audits)).not.toContain("hunter2-secret");
    expect(audits[0]!.after).toMatchObject({ method: "smtp", passwordChanged: true });
  });

  it("asks for a password the first time and keeps the saved one when left blank", async () => {
    expect(await saveMailSettings({ ...smtp, password: null }, o)).toEqual({ ok: false, errors: ["Enter the SMTP password."] });
    await saveMailSettings({ ...smtp, password: "first" }, o);
    const before = await cipher();
    await saveMailSettings({ ...smtp, username: "u2", password: null }, o);
    expect(await cipher()).toBe(before);
  });

  it("offers Microsoft 365 only when staff sign-in with Microsoft is set up", async () => {
    expect(await saveMailSettings({ method: "graph", mailbox: "webmaster@example.org" }, o)).toEqual({ ok: false,
      errors: ["Sending through Microsoft 365 uses the staff sign-in app. Set up staff sign-in with Microsoft first, or use SMTP."] });
    await seedProvider("staff-microsoft", { tenantId: "0f8fad5b-d9cb-469f-a165-70867728950e", clientId: "11111111-2222-3333-4444-555555555555" });
    expect(await saveMailSettings({ method: "graph", mailbox: "webmaster@example.org" }, o)).toEqual({ ok: true });
    expect((await mailSummary()).graphAvailable).toBe(true);
  });

  it("works only after a test send, and needs a new test when the settings change", async () => {
    await saveMailSettings({ ...smtp, password: "p" }, o);
    expect(await mailWorking()).toBe(false);
    expect(await mailAttention()).toMatchObject({ kind: "not_tested" });
    expect(await sendTestMail(" Admin@Example.org ", o)).toEqual({ ok: true });
    expect(box.sent[0]!.to).toBe("admin@example.org");
    expect(await mailWorking()).toBe(true);
    expect(await mailAttention()).toBeNull();
    await saveMailSettings({ ...smtp, port: 465, security: "tls", password: null }, o);
    expect(await mailWorking()).toBe(false);
    expect((await db.select().from(auditLog)).map((a) => a.action)).toEqual(["settings.mail.save", "settings.mail.test", "settings.mail.save"]);
  });

  it("a failed test doesn't count as working", async () => {
    await saveMailSettings({ ...smtp, password: "p" }, o);
    box.fail = "The mail server refused the username or password.";
    expect(await sendTestMail("admin@example.org", o)).toEqual({ ok: false, error: "The mail server refused the username or password." });
    expect(await mailWorking()).toBe(false);
    expect((await db.select().from(auditLog)).map((a) => a.action)).toEqual(["settings.mail.save", "mail.failed", "settings.mail.test"]);
  });

  it("audits a failed send without the body, raises the warning, and a later success clears it", async () => {
    await saveMailSettings({ ...smtp, password: "p" }, o);
    await sendTestMail("admin@example.org", o);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    box.fail = "The mail server didn't accept the message (EENVELOPE 550).";
    const m = signinCodeMessage({ clubName: "FZN", color: "#5b2a86" }, "ana@example.com", "482913");
    expect(await sendMail(m, { purpose: "signin_code" })).toEqual({ ok: false, error: "The mail server didn't accept the message (EENVELOPE 550)." });
    const failed = (await db.select().from(auditLog)).filter((a) => a.action === "mail.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.after).toEqual({ purpose: "signin_code", method: "smtp", to: "ana@example.com", error: "The mail server didn't accept the message (EENVELOPE 550)." });
    expect(JSON.stringify(await db.select().from(auditLog))).not.toContain("482913");
    expect(JSON.stringify(await db.select().from(setting))).not.toContain("482913");
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain("482913");
    expect(await mailAttention()).toMatchObject({ kind: "failing", lastError: "The mail server didn't accept the message (EENVELOPE 550)." });
    box.fail = null;
    expect(await sendMail(m, { purpose: "signin_code" })).toEqual({ ok: true });
    expect(await mailAttention()).toBeNull();
  });

  it("says mail isn't set up when nothing is saved", async () => {
    expect(await mailAttention()).toMatchObject({ kind: "not_set_up" });
    expect(await sendMail({ to: "a@example.com", subject: "s", text: "t", html: "h" }, { purpose: "welcome" })).toEqual({ ok: false, error: "Outgoing mail isn't set up." });
  });
});
