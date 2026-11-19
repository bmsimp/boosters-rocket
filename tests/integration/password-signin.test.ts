import { describe, it, expect, vi, beforeEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, parent, parentAuthAccount, parentAuthSession, parentAuthUser, parentDevice, rateLimitEvent, signinCode, staffAuthUser } from "@/lib/db/schema";
import { blockPerson, unblockPerson } from "@/lib/parents/people";
import { forgetDevices } from "@/lib/parents/sessions";
import { hashTriedAddress } from "@/lib/parents/password-signin";
import { DEVICE_LIFE_MS, hashDeviceToken } from "@/lib/parents/devices";
import { CODE_TTL_MS } from "@/lib/parents/signin-codes";
import { PARENT_SESSION_COOKIE_SECONDS } from "@/lib/parents/sessions";
import { env } from "@/env";
import { resetDb, seedParent, seedGuardianInFamily, seedWorkingMail } from "../helpers/db";
import { SIGNINS_ON, seedParentSettings } from "../helpers/roster-cache";
import { DOOR_IP, DOOR_PASSWORD, codeMailed, codeStep, cookieNamed, cookiesSet, passwordStep, postDoor, setCookieLine } from "../helpers/parent-door";
import { deviceRows, seedDevice, seedPassword } from "../helpers/signin-links";

/**
 * The parent door as the sign-in release's slice SI-3b made it: the address and the password at /portal-password/check;
 * on a device the portal doesn't remember for the person, the emailed code at /portal-code/check through the pending
 * step (a signed cookie only a right password makes); on one it remembers, a sign-in at once. Every refusal at the
 * password step is one answer, with no cookie and no mail.
 */
const REFUSED = { ok: false, error: "rejected" };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const staff = { actor: { door: "staff" as const, id: null, label: "board" }, ip: null };
const sessions = () => db.select().from(parentAuthSession);

/** Ana, with one family of the app's own and the helper's password; Ben too, in another family, when asked. */
async function seedAna(o: { families?: 1 | 2; password?: boolean } = {}) {
  const ana = await seedParent({ name: "Ana", email: "ana@example.com" });
  await seedGuardianInFamily({ parentId: ana.id, familyQboId: "F1" });
  if (o.families === 2) await seedGuardianInFamily({ parentId: ana.id, familyQboId: "F2" });
  if (o.password !== false) await seedPassword(ana.authUserId, DOOR_PASSWORD);
  return ana;
}
async function seedBen() {
  const ben = await seedParent({ name: "Ben", email: "ben@example.com" });
  await seedGuardianInFamily({ parentId: ben.id, familyQboId: "F9" });
  await seedPassword(ben.authUserId, DOOR_PASSWORD);
  return ben;
}
/** The password step's whole answer: status, body and every cookie it set. */
async function answerTo(email: string, password = DOOR_PASSWORD, cookie?: string) {
  const res = await postDoor("/portal-password/check", { email, password }, { cookie });
  return [res.status, await res.json(), res.headers.getSetCookie()];
}
/** A pending step signed as the server signs one (better-call's HMAC of the value with the secret), with what it names. */
function signedStep(name: string, v: { p: string; e: string; c: string; u: number; x: number }) {
  const value = Buffer.from(JSON.stringify(v)).toString("base64url");
  const sig = createHmac("sha256", env.BETTER_AUTH_SECRET).update(value).digest("base64");
  return `${name}=${encodeURIComponent(`${value}.${sig}`)}`;
}
/** Ana's right password and the code it mailed: the pending step's cookie and the code. */
async function anaAtTheCode() {
  const since = outbox.length;
  const first = await passwordStep("ana@example.com");
  expect(first.body).toEqual({ ok: true, step: "code" });
  return { pending: first.pending, code: await codeMailed(outbox, "ana@example.com", since) };
}

describe("the password step", () => {
  beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); await seedParentSettings(SIGNINS_ON); });

  type RefusalCase = [string, () => Promise<string | [string, string]>, string, boolean];
  const REFUSALS: RefusalCase[] = [
    ["an address nobody holds", async () => { await seedAna(); return "nobody@example.com"; }, "unknown_email", false],
    ["an address only a staff member holds", async () => {
      await seedAna();
      await db.insert(staffAuthUser).values({ id: "s1", name: "Sam", email: "sam@club.org", emailVerified: true });
      return "sam@club.org";
    }, "unknown_email", false],
    ["a person with no password yet", async () => { await seedAna({ password: false }); return "ana@example.com"; }, "no_password", true],
    ["a wrong password", async () => { await seedAna(); return ["ana@example.com", "not the right password at all"]; }, "wrong_password", true],
    ["a blocked person", async () => { const a = await seedAna(); await db.update(parent).set({ blocked: true }).where(eq(parent.id, a.id)); return "ana@example.com"; }, "blocked", true],
    ["a person with no row that counts", async () => {
      const a = await seedParent({ name: "Ana", email: "ana@example.com" });
      await seedGuardianInFamily({ parentId: a.id, familyQboId: "F1", status: "disabled", disabledReason: "removed" });
      await seedPassword(a.authUserId, DOOR_PASSWORD);
      return "ana@example.com";
    }, "no_enabled_guardian", true],
    ["sign-ins switched off", async () => { await seedAna(); await seedParentSettings({ signin: false }); return "ana@example.com"; }, "signins_off", true],
    ["the club at Strict", async () => { await seedAna(); await seedParentSettings({ level: "strict" }); return "ana@example.com"; }, "strict_no_factor", true],
    ["a malformed address", async () => { await seedAna(); return "not an address"; }, "not_an_address", false],
    ["a person with no sign-in account", async () => {
      const a = await seedAna();
      await db.delete(parentAuthAccount).where(eq(parentAuthAccount.userId, a.authUserId));
      await db.delete(parentAuthUser).where(eq(parentAuthUser.id, a.authUserId));
      return "ana@example.com";
    }, "no_sign_in_account", true],
  ];
  it.each(REFUSALS)("refuses %s with the one answer, no cookie and no mail", async (_, setup, reason, namesThePerson) => {
    const given = await setup();
    const [email, password] = typeof given === "string" ? [given, DOOR_PASSWORD] : given;
    expect(await answerTo(email, password)).toEqual([200, REFUSED, []]);
    expect(outbox).toEqual([]);
    expect(await sessions()).toEqual([]);
    const action = reason === "wrong_password" ? "signin.password_wrong" : "signin.password_refused";
    const [row] = await audits(action);
    expect(await audits(action)).toHaveLength(1);
    if (reason !== "wrong_password") expect(row!.after).toEqual({ reason });
    const ana = (await db.select().from(parent))[0]!;
    if (namesThePerson) expect(row).toMatchObject({ door: "parent", actorId: ana.id, actorLabel: "ana@example.com", targetType: "parent", targetId: ana.id });
    else expect(row).toMatchObject({ door: "parent", actorId: null, actorLabel: null, targetType: null, targetId: null });
    // Nothing of the password, and, for an address that is nobody's, nothing of what was typed, in any row or count.
    const stored = JSON.stringify([await db.select().from(auditLog), await db.select().from(rateLimitEvent)]);
    expect(stored).not.toContain(password);
    if (!namesThePerson) expect(stored).not.toContain(email);
    expect((await db.select().from(rateLimitEvent)).filter((e) => e.kind === "password_try_email").map((e) => e.subject)).toEqual([hashTriedAddress(email.trim().toLowerCase())]);
  });

  it("holds 5 tries per address in 15 minutes, whatever the address names, a right password included, and mails nothing past it", async () => {
    await seedAna();
    for (let i = 0; i < 5; i++) expect(await answerTo("ana@example.com", "a wrong password, try " + i)).toEqual([200, REFUSED, []]);
    // The sixth: the right password, refused as anything is, with no code.
    expect(await answerTo("ana@example.com")).toEqual([200, REFUSED, []]);
    for (let i = 0; i < 6; i++) expect(await answerTo("nobody@example.com", "anything at all " + i)).toEqual([200, REFUSED, []]);
    expect(outbox).toEqual([]);
    const limited = (await audits("signin.password_refused")).filter((r) => (r.after as { reason: string }).reason === "rate_limited");
    // Each address's full window is recorded once, naming nobody.
    expect(limited.map((r) => [r.actorId, r.actorLabel, r.targetId, r.after])).toEqual([
      [null, null, null, { reason: "rate_limited", limit: "email" }], [null, null, null, { reason: "rate_limited", limit: "email" }]]);
    expect(await audits("signin.password_wrong")).toHaveLength(5);
    expect(await sessions()).toEqual([]);
  });

  it("over the limit per IP address, refuses even the right password, naming nobody, and counts nothing against the address", async () => {
    await seedAna();
    const now = new Date();
    await db.insert(rateLimitEvent).values(Array.from({ length: 180 }, () => ({ kind: "password_try_ip", subject: DOOR_IP, at: now })));
    expect(await answerTo("ana@example.com")).toEqual([200, REFUSED, []]);
    expect(await answerTo("ana@example.com")).toEqual([200, REFUSED, []]);
    expect(outbox).toEqual([]);
    expect(await sessions()).toEqual([]);
    // The full window is recorded once, naming nobody; the address's own count was never taken.
    expect((await audits("signin.password_refused")).map((r) => [r.actorId, r.actorLabel, r.targetId, r.after]))
      .toEqual([[null, null, null, { reason: "rate_limited", limit: "ip" }]]);
    expect((await db.select().from(rateLimitEvent)).filter((e) => e.kind === "password_try_email")).toEqual([]);
  });

  it("a right password on a device not remembered mails one code, sets the pending step and makes no session", async () => {
    const ana = await seedAna();
    const res = await postDoor("/portal-password/check", { email: " Ana@Example.com ", password: DOOR_PASSWORD });
    expect(await res.json()).toEqual({ ok: true, step: "code" });
    await vi.waitFor(() => expect(outbox).toHaveLength(1));
    expect(outbox[0]!.to).toBe("ana@example.com");
    const line = setCookieLine(res, "signin_step")!;
    expect(line).toMatch(/;\s*HttpOnly(;|$)/i);
    expect(line).toMatch(/;\s*SameSite=Lax(;|$)/i);
    expect(line).toMatch(/;\s*Path=\/api\/auth\/parent(;|$)/i);
    expect(line).toMatch(new RegExp(`;\\s*Max-Age=${CODE_TTL_MS / 1000}(;|$)`, "i"));
    expect(cookieNamed(res, "session_token")).toBe("");
    expect(cookieNamed(res, "device")).toBe("");
    expect(await sessions()).toEqual([]);
    expect(await audits("signin.second_step_asked")).toEqual([expect.objectContaining({ actorId: ana.id, targetId: ana.id, after: { step: "emailed_code" } })]);
    // The pending step's value names nothing a reader of the cookie could use without the server's secret, and no password.
    expect(decodeURIComponent(line)).not.toContain(DOOR_PASSWORD);
  });

  it.each([[1, "/"], [2, "/choose-family"]] as const)("with %s families, the code and its pending step sign in and land on %s, remembering the device", async (families, next) => {
    const ana = await seedAna({ families });
    const { pending, code } = await anaAtTheCode();
    const before = Date.now();
    const { res, body } = await codeStep(code, pending);
    expect(body).toEqual({ ok: true, next });
    const session = setCookieLine(res, "session_token")!;
    expect(session).toMatch(new RegExp(`;\\s*Max-Age=${PARENT_SESSION_COOKIE_SECONDS}(;|$)`, "i"));
    const [device] = await deviceRows(ana.id);
    expect(await deviceRows(ana.id)).toHaveLength(1);
    const deviceLine = setCookieLine(res, "device")!;
    expect(deviceLine).toMatch(new RegExp(`;\\s*Max-Age=${DEVICE_LIFE_MS / 1000}(;|$)`, "i"));
    expect(deviceLine).toMatch(/;\s*Path=\/api\/auth\/parent(;|$)/i);
    expect(deviceLine).toMatch(/;\s*HttpOnly(;|$)/i);
    expect(hashDeviceToken(cookieNamed(res, "device").split("=")[1]!)).toBe(device!.tokenHash);
    // The pending step is cleared.
    expect(setCookieLine(res, "signin_step")).toMatch(/Max-Age=0/i);
    const [row] = await sessions();
    expect(row!.strongAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    for (const action of ["signin.second_step_asked", "signin.code_sent", "signin.device_remembered"]) expect([action, (await audits(action)).length]).toEqual([action, 1]);
    if (families === 1) expect(await audits("signin")).toHaveLength(1);
    // The token is only in the cookie: no audit row holds it, or its hash.
    const all = JSON.stringify(await db.select().from(auditLog));
    expect(all).not.toContain(device!.tokenHash);
    expect(all).not.toContain(cookieNamed(res, "device").split("=")[1]!);
  });

  it("the password again on that device signs in at once, with no code, and renews the device", async () => {
    const ana = await seedAna();
    const { pending, code } = await anaAtTheCode();
    const first = await codeStep(code, pending);
    const device = cookieNamed(first.res, "device");
    const [made] = await deviceRows(ana.id);
    await db.update(parentDevice).set({ lastUsedAt: new Date(Date.now() - 5 * 86_400_000), expiresAt: new Date(Date.now() + 85 * 86_400_000) });
    outbox.length = 0;
    const res = await postDoor("/portal-password/check", { email: "ana@example.com", password: DOOR_PASSWORD }, { cookie: device });
    expect(await res.json()).toEqual({ ok: true, next: "/" });
    expect(outbox).toEqual([]);
    expect(cookieNamed(res, "session_token")).not.toBe("");
    // The same device, its token set again, its row's last use and end moved on.
    expect(cookieNamed(res, "device")).toBe(device);
    const [renewed] = await deviceRows(ana.id);
    expect(await deviceRows(ana.id)).toHaveLength(1);
    expect(renewed!.id).toBe(made!.id);
    expect(renewed!.lastUsedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(renewed!.expiresAt.getTime()).toBeGreaterThan(Date.now() + DEVICE_LIFE_MS - 60_000);
    expect(await audits("signin.device_used")).toEqual([expect.objectContaining({ actorId: ana.id, targetId: ana.id, after: expect.objectContaining({ deviceId: made!.id }) })]);
    expect(await audits("signin.second_step_asked")).toHaveLength(1);   // only the first sign-in's
    expect((await sessions()).every((s) => s.strongAt !== null)).toBe(true);
  });

  it.each([
    ["another person's device", async (anaId: string) => { void anaId; const ben = await seedBen(); return (await seedDevice(ben.id)).token; }],
    ["an expired device", async (anaId: string) => (await seedDevice(anaId, { expiresAt: new Date(Date.now() - 1000) })).token],
    ["a device forgotten by a block (and the person unblocked)", async (anaId: string) => {
      const { token } = await seedDevice(anaId);
      await blockPerson(anaId, "reason", staff);
      await unblockPerson(anaId, staff);
      return token;
    }],
    ["a device forgotten by a reset (forgetDevices(), as choosePasswordFromLink() runs it)", async (anaId: string) => {
      const { token } = await seedDevice(anaId);
      await db.transaction((tx) => forgetDevices(anaId, tx));
      return token;
    }],
    ["a token of another shape", async () => "not-a-device-token"],
  ] as const)("asks for the code instead on %s", async (_, setup) => {
    const ana = await seedAna();
    const token = await setup(ana.id);
    const res = await postDoor("/portal-password/check", { email: "ana@example.com", password: DOOR_PASSWORD }, { cookie: `br_parent.device=${token}` });
    expect(await res.json()).toEqual({ ok: true, step: "code" });
    expect(cookieNamed(res, "session_token")).toBe("");
    await vi.waitFor(() => expect(outbox.filter((m) => m.to === "ana@example.com")).toHaveLength(1));
    expect(await audits("signin.device_used")).toEqual([]);
  });

  it("under Strict, a remembered device signs nobody in by password either", async () => {
    const ana = await seedAna();
    const { token } = await seedDevice(ana.id);
    await seedParentSettings({ level: "strict" });
    expect(await answerTo("ana@example.com", DOOR_PASSWORD, `br_parent.device=${token}`)).toEqual([200, REFUSED, []]);
    expect((await audits("signin.password_refused")).map((r) => r.after)).toEqual([{ reason: "strict_no_factor" }]);
    expect(await sessions()).toEqual([]);
  });
});

describe("the pending step", () => {
  beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); await seedParentSettings(SIGNINS_ON); });

  const refusedWith = async (code: string, cookie: string) => {
    const { res, body } = await codeStep(code, cookie);
    expect(body).toEqual(REFUSED);
    expect(cookieNamed(res, "session_token")).toBe("");
    expect(cookieNamed(res, "device")).toBe("");
    return res;
  };

  it("is refused unsigned, or past its end even when signed", async () => {
    const ana = await seedAna();
    const { pending, code } = await anaAtTheCode();
    const [name, signed] = pending.split("=") as [string, string];
    // Unsigned: the value alone, without the signature.
    await refusedWith(code, `${name}=${encodeURIComponent(decodeURIComponent(signed).replace(/\.[^.]*$/, ""))}`);
    const [cred] = await db.select().from(parentAuthAccount).where(eq(parentAuthAccount.userId, ana.authUserId));
    const u = (cred as { updatedAt: Date }).updatedAt.getTime();
    await refusedWith(code, signedStep(name, { p: ana.id, e: "ana@example.com", c: cred!.id, u, x: Date.now() - 1000 }));
    // Signed, and still within its life: the same code signs her in (it was never spent by the refusals above).
    expect((await codeStep(code, signedStep(name, { p: ana.id, e: "ana@example.com", c: cred!.id, u, x: Date.now() + 60_000 }))).body).toEqual({ ok: true, next: "/" });
  });

  it("is refused after a block, after a reset, after an address change, and once its code is spent", async () => {
    const ana = await seedAna();
    // Spent: signed in once, the same step and code again.
    const first = await anaAtTheCode();
    expect((await codeStep(first.code, first.pending)).body).toEqual({ ok: true, next: "/" });
    await refusedWith(first.code, first.pending);

    // A reset: the password it proved was replaced before the code was checked.
    await db.delete(rateLimitEvent); await db.update(signinCode).set({ createdAt: new Date(Date.now() - 120_000) });
    const second = await anaAtTheCode();
    await db.delete(parentAuthAccount).where(eq(parentAuthAccount.userId, ana.authUserId));
    await seedPassword(ana.authUserId, "a new password after the reset");
    await refusedWith(second.code, second.pending);
    expect((await audits("signin.refused")).at(-1)).toMatchObject({ after: { reason: "password_changed" } });

    // An address change between the password and the code.
    await db.delete(rateLimitEvent); await db.update(signinCode).set({ createdAt: new Date(Date.now() - 120_000) });
    const third = await (async () => {
      const since = outbox.length;
      const r = await passwordStep("ana@example.com", { password: "a new password after the reset" });
      return { pending: r.pending, code: await codeMailed(outbox, "ana@example.com", since) };
    })();
    await db.update(parent).set({ email: "ana.new@example.com" }).where(eq(parent.id, ana.id));
    await refusedWith(third.code, third.pending);
    expect((await audits("signin.refused")).at(-1)).toMatchObject({ after: { reason: "address_changed" } });
    await db.update(parent).set({ email: "ana@example.com" }).where(eq(parent.id, ana.id));

    // A block: it deletes the code, and the step signs nobody in.
    await db.delete(rateLimitEvent); await db.update(signinCode).set({ createdAt: new Date(Date.now() - 120_000) });
    const fourth = await (async () => {
      const since = outbox.length;
      const r = await passwordStep("ana@example.com", { password: "a new password after the reset" });
      return { pending: r.pending, code: await codeMailed(outbox, "ana@example.com", since) };
    })();
    await blockPerson(ana.id, "reason", staff);
    await refusedWith(fourth.code, fourth.pending);
    expect(await sessions()).toEqual([]);
  });

  /** Whether a response clears the pending step's cookie (sets it empty). */
  const clearsStep = (res: Response) => Object.entries(cookiesSet(res)).some(([n, v]) => n.endsWith(".signin_step") && v === "");
  /** A pending step for Ana, signed as the server signs one, ending `msLeft` from now. */
  async function anaStepEnding(name: string, ana: { id: string; authUserId: string }, msLeft: number) {
    const [cred] = await db.select().from(parentAuthAccount).where(eq(parentAuthAccount.userId, ana.authUserId));
    return signedStep(name, { p: ana.id, e: "ana@example.com", c: cred!.id, u: (cred as { updatedAt: Date }).updatedAt.getTime(), x: Date.now() + msLeft });
  }

  it("ends at the code check once the person is blocked, or the club is at Strict, and clears its cookie", async () => {
    const ana = await seedAna();
    const first = await anaAtTheCode();
    await blockPerson(ana.id, "reason", staff);
    const blocked = await refusedWith(first.code, first.pending);
    expect(clearsStep(blocked)).toBe(true);
    expect((await audits("signin.refused")).at(-1)).toMatchObject({ targetId: ana.id, after: { reason: "blocked" } });
    await unblockPerson(ana.id, staff);

    // Strict stored after the step was made at Standard: an emailed code is never a second step under Strict.
    await db.delete(rateLimitEvent);
    const second = await anaAtTheCode();
    await seedParentSettings({ level: "strict" });
    const strict = await refusedWith(second.code, second.pending);
    expect(clearsStep(strict)).toBe(true);
    expect((await audits("signin.refused")).at(-1)).toMatchObject({ targetId: ana.id, after: { reason: "strict_no_factor" } });
    expect(await sessions()).toEqual([]);
  });

  it("a resend after a reset, or under Strict, mails nothing and clears the step", async () => {
    const ana = await seedAna();
    const { pending } = await anaAtTheCode();
    await db.update(signinCode).set({ createdAt: new Date(Date.now() - 120_000) });
    await seedParentSettings({ level: "strict" });
    const strict = await postDoor("/portal-code/resend", {}, { cookie: pending });
    expect(await strict.json()).toEqual({ ok: true });
    expect(clearsStep(strict)).toBe(true);
    await seedParentSettings({ level: "standard" });
    await db.delete(parentAuthAccount).where(eq(parentAuthAccount.userId, ana.authUserId));
    await seedPassword(ana.authUserId, "a new password after the reset");
    const reset = await postDoor("/portal-code/resend", {}, { cookie: pending });
    expect(await reset.json()).toEqual({ ok: true });
    expect(clearsStep(reset)).toBe(true);
    expect(outbox).toHaveLength(1);
    expect((await audits("signin.code_refused")).map((r) => (r.after as { reason: string }).reason)).toEqual(["strict_no_factor", "password_changed"]);
  });

  it("a code resent late in the step ends with the step, and its mail says how long it has; none is sent in the last minute", async () => {
    const ana = await seedAna();
    const { pending } = await anaAtTheCode();
    const name = pending.split("=")[0]!;
    await db.update(signinCode).set({ createdAt: new Date(Date.now() - 120_000) });
    // Four and a half minutes of the step left: the code resent ends when the step does, not 10 minutes on.
    const late = await anaStepEnding(name, ana, 4.5 * 60_000);
    const endsAt = JSON.parse(Buffer.from(decodeURIComponent(late.split("=")[1]!).replace(/\.[^.]*$/, ""), "base64url").toString("utf8")).x as number;
    expect(await (await postDoor("/portal-code/resend", {}, { cookie: late })).json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(outbox).toHaveLength(2));
    const [row] = await db.select().from(signinCode);
    expect(row!.expiresAt.getTime()).toBe(endsAt);
    expect(outbox[1]!.text).toContain("It expires in 4 minutes.");
    expect((await audits("signin.code_sent")).at(-1)!.after).toEqual({ expiresAt: new Date(endsAt).toISOString() });
    // And it works, within the step.
    const code = /sign-in code: (\d{6})/.exec(outbox[1]!.subject)![1]!;
    expect((await codeStep(code, late)).body).toEqual({ ok: true, next: "/" });

    // Under a minute left: nothing is stored or mailed, and the answer is the same.
    await db.delete(rateLimitEvent); await db.update(signinCode).set({ createdAt: new Date(Date.now() - 120_000) });
    const codes = (await db.select().from(signinCode)).map((c) => c.id);
    const ending = await anaStepEnding(name, ana, 30_000);
    expect(await (await postDoor("/portal-code/resend", {}, { cookie: ending })).json()).toEqual({ ok: true });
    expect((await db.select().from(signinCode)).map((c) => c.id)).toEqual(codes);
    expect(outbox).toHaveLength(2);
    expect((await audits("signin.code_refused")).at(-1)).toMatchObject({ targetId: ana.id, after: { reason: "step_ending" } });
  });

  it("two right codes at once make at most one session", async () => {
    await seedAna();
    const { pending, code } = await anaAtTheCode();
    const answers = await Promise.all([codeStep(code, pending), codeStep(code, pending)]);
    expect(answers.filter((a) => a.body.ok)).toHaveLength(1);
    expect(answers.filter((a) => !a.body.ok).map((a) => a.body)).toEqual([REFUSED]);
    expect(await sessions()).toHaveLength(1);
  });

  it("a resend mails the pending step's person and nobody else, and answers the same with no step", async () => {
    await seedAna();
    const { pending } = await anaAtTheCode();
    await db.update(signinCode).set({ createdAt: new Date(Date.now() - 120_000) });
    expect(await (await postDoor("/portal-code/resend", {}, { cookie: pending })).json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(outbox).toHaveLength(2));
    expect(outbox.map((m) => m.to)).toEqual(["ana@example.com", "ana@example.com"]);
    expect(await (await postDoor("/portal-code/resend", {})).json()).toEqual({ ok: true });
    expect(await (await postDoor("/portal-code/resend", {}, { cookie: "br_parent.signin_step=forged" })).json()).toEqual({ ok: true });
    // With no step there is no person to mail, so nothing was stored or put on its way.
    expect(await db.select().from(signinCode)).toHaveLength(1);
    expect(outbox).toHaveLength(2);
  });
});
