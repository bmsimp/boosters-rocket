import { describe, it, expect, vi, beforeEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));
/**
 * A change made between the reads: once `seed` is set, after the `after`-th read of whether `parentId` has an app in
 * force (hasAuthenticator()) has answered, `seed` runs once (seeding the app), so the reads after it see it. Every read
 * goes through as it is; with no `seed`, nothing else happens.
 */
const appHook = vi.hoisted(() => ({ parentId: "", after: 0, seed: null as null | (() => Promise<unknown>) }));
vi.mock("@/lib/parents/authenticator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/parents/authenticator")>();
  return { ...actual, hasAuthenticator: async (...args: Parameters<typeof actual.hasAuthenticator>) => {
    const answer = await actual.hasAuthenticator(...args);
    if (appHook.seed && args[0] === appHook.parentId && --appHook.after === 0) { const seed = appHook.seed; appHook.seed = null; await seed(); }
    return answer;
  } };
});

import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, parentAuthenticator, parentAuthSession, parentBackupCode, parentDevice, rateLimitEvent, signinCode } from "@/lib/db/schema";
import { sealAuthenticatorSecret } from "@/lib/parents/authenticator";
import { sendSecondStepCode, signinStands, verifySecondFactor } from "@/lib/parents/signin-codes";
import { signOutEverywhere } from "@/lib/parents/signin-settings";
import { totpStep } from "@/lib/parents/totp";
import { env } from "@/env";
import { resetDb, seedParent, seedGuardianInFamily, seedWorkingMail } from "../helpers/db";
import { SIGNINS_ON, seedParentSettings } from "../helpers/roster-cache";
import { DOOR_IP, DOOR_PASSWORD, appStep, codeStep, cookieNamed, passwordStep, postDoor, stepPersonFor } from "../helpers/parent-door";
import { deviceRows, seedCode, seedDevice, seedPassword } from "../helpers/signin-links";
import { appCode, authenticatorRows, backupCodeRows, seedAuthenticator, seedBackupCodes, wrongAppCode } from "../helpers/authenticator";

/**
 * An authenticator app and backup codes as the second step (the sign-in release, slice SI-6a; open questions 24, 25
 * and 35 of the app-owned families spec): a guardian with an app in force is asked for its code, or a backup code, at
 * /portal-app/check through the same pending step, and is never sent the emailed code. Nothing a parent can press sets
 * an app up until SI-6b, so the app is seeded (tests/helpers/authenticator.ts).
 */
const REFUSED = { ok: false, error: "rejected" };
const LIMITED = { ok: false, error: "rate_limited" };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const sessions = () => db.select().from(parentAuthSession);
const codesOf = (parentId: string) => db.select().from(signinCode).where(eq(signinCode.parentId, parentId));

/** Ana, in one family of the app's own, with the helper's password and, unless told otherwise, an app in force. */
async function seedAna(o: { app?: "in_force" | "unfinished" | "none" } = {}) {
  const ana = await seedParent({ name: "Ana", email: "ana@example.com" });
  await seedGuardianInFamily({ parentId: ana.id, familyQboId: "F1" });
  await seedPassword(ana.authUserId, DOOR_PASSWORD);
  const app = o.app === "none" ? null : await seedAuthenticator(ana.id, { confirmed: o.app !== "unfinished" });
  return { ...ana, app };
}
/** Ana's right password on a new device: the pending step's cookie, after checking she was asked for the app. */
async function anaAtTheApp() {
  const first = await passwordStep("ana@example.com");
  expect(first.body).toEqual({ ok: true, step: "app" });
  return first.pending;
}
/** A pending step signed as the server signs one (better-call's HMAC of the value with the secret), with what it names. */
function signedStep(name: string, v: { p: string; e: string; c: string; u: number; x: number }) {
  const value = Buffer.from(JSON.stringify(v)).toString("base64url");
  const sig = createHmac("sha256", env.BETTER_AUTH_SECRET).update(value).digest("base64");
  return `${name}=${encodeURIComponent(`${value}.${sig}`)}`;
}

beforeEach(async () => { await resetDb(); outbox.length = 0; appHook.seed = null; await seedWorkingMail(); await seedParentSettings(SIGNINS_ON); });

describe("who is asked for the app (open question 24)", () => {
  it("an app holder's right password on a new device sets the pending step, sends no code and asks for the app", async () => {
    const ana = await seedAna();
    const { res, body, pending } = await passwordStep("ana@example.com");
    expect(body).toEqual({ ok: true, step: "app" });
    expect(pending).not.toBe("");
    expect(cookieNamed(res, "session_token")).toBe("");
    expect(await sessions()).toEqual([]);
    expect(await codesOf(ana.id)).toEqual([]);
    expect(await audits("signin.second_step_asked")).toEqual([expect.objectContaining({ actorId: ana.id, targetId: ana.id, after: { step: "second_factor" } })]);
    expect(await audits("signin.code_sent")).toEqual([]);
    expect(await audits("signin.code_refused")).toEqual([]);
    // Nothing is mailed (no send is begun), however long one waits.
    await new Promise((r) => setImmediate(r));
    expect(outbox).toEqual([]);
  });

  it("a set-up never finished is no second step: the emailed code is asked for, as before", async () => {
    const ana = await seedAna({ app: "unfinished" });
    const { body } = await passwordStep("ana@example.com");
    expect(body).toEqual({ ok: true, step: "code" });
    await vi.waitFor(() => expect(outbox.map((m) => m.to)).toEqual(["ana@example.com"]));
    expect(await codesOf(ana.id)).toHaveLength(1);
  });

  it("under Standard a remembered device still finishes the sign-in for an app holder, with no step asked", async () => {
    const ana = await seedAna();
    const device = await seedDevice(ana.id);
    const { body } = await passwordStep("ana@example.com", { cookie: `br_parent.device=${device.token}` });
    expect(body).toEqual({ ok: true, next: "/" });
    expect(await audits("signin.second_step_asked")).toEqual([]);
  });

  it("under Strict an app holder is asked for the app, even on a remembered device, and signs in with it", async () => {
    const ana = await seedAna();
    const device = await seedDevice(ana.id);
    await seedParentSettings({ level: "strict" });
    const { body, pending } = await passwordStep("ana@example.com", { cookie: `br_parent.device=${device.token}` });
    expect(body).toEqual({ ok: true, step: "app" });
    expect((await appStep(appCode(ana.app!.secret), pending)).body).toEqual({ ok: true, next: "/" });
  });

  it("under Strict two sign-ins on one browser leave one device row, renewed by use, and still ask for the app", async () => {
    const ana = await seedAna();
    await seedParentSettings({ level: "strict" });
    const first = await appStep(appCode(ana.app!.secret), await anaAtTheApp());
    expect(first.body).toEqual({ ok: true, next: "/" });
    const device = cookieNamed(first.res, "device");
    expect(device).not.toBe("");
    const [row] = await deviceRows(ana.id);
    // Set back a day, so its renewal shows.
    const earlier = new Date(Date.now() - 86_400_000);
    await db.update(parentDevice).set({ lastUsedAt: earlier }).where(eq(parentDevice.id, row!.id));
    // The same browser: the remembered device stands in for nothing under Strict, so the app is asked for again.
    const second = await passwordStep("ana@example.com", { cookie: device });
    expect(second.body).toEqual({ ok: true, step: "app" });
    const done = await appStep(appCode(ana.app!.secret, Date.now(), 1), `${second.pending}; ${device}`);
    expect(done.body).toEqual({ ok: true, next: "/" });
    const rows = await deviceRows(ana.id);
    expect(rows.map((r) => r.id)).toEqual([row!.id]);
    expect(rows[0]!.lastUsedAt.getTime()).toBeGreaterThan(earlier.getTime());
    expect(cookieNamed(done.res, "device")).toBe(device);
    expect((await sessions()).map((s) => s.deviceId)).toEqual([row!.id, row!.id]);
    expect((await audits("signin.device_remembered")).map((r) => (r.after as { deviceId: string }).deviceId)).toEqual([row!.id]);
    expect((await audits("signin.device_used")).map((r) => (r.after as { deviceId: string }).deviceId)).toEqual([row!.id]);
  });

  it("under Strict a device cookie naming another person's device, or an expired one, makes a new device at the finish", async () => {
    const ana = await seedAna();
    const ben = await seedParent({ name: "Ben", email: "ben@example.com" });
    const bens = await seedDevice(ben.id);
    const expired = await seedDevice(ana.id, { expiresAt: new Date(Date.now() - 1000) });
    await seedParentSettings({ level: "strict" });
    for (const [i, token] of [bens.token, expired.token].entries()) {
      const cookie = `br_parent.device=${token}`;
      const step = await passwordStep("ana@example.com", { cookie });
      expect(step.body).toEqual({ ok: true, step: "app" });
      const done = await appStep(appCode(ana.app!.secret, Date.now(), i), `${step.pending}; ${cookie}`);
      expect(done.body).toEqual({ ok: true, next: "/" });
      expect(cookieNamed(done.res, "device")).not.toBe("");
      expect(cookieNamed(done.res, "device")).not.toBe(cookie);
    }
    const anas = await deviceRows(ana.id);
    expect(anas).toHaveLength(3);
    expect(anas.filter((d) => d.id !== expired.id).every((d) => d.expiresAt.getTime() > Date.now())).toBe(true);
    expect((await deviceRows(ben.id)).map((d) => d.id)).toEqual([bens.id]);
    expect(await audits("signin.device_used")).toEqual([]);
  });

  it("an app that comes into force after the password's reads: the send stores and mails nothing, under its lock, and answers app", async () => {
    const ana = await seedAna({ app: "none" });
    const step = await stepPersonFor("ana@example.com");
    // Seeded once the send's first read (before its lock) has answered no app: the read under the lock sees it.
    Object.assign(appHook, { parentId: ana.id, after: 1, seed: () => seedAuthenticator(ana.id) });
    const sent = await sendSecondStepCode({ ...step, endsAt: new Date(Date.now() + 600_000) }, DOOR_IP);
    await sent.delivery;
    expect(appHook.seed).toBeNull();
    expect({ ended: sent.ended, app: sent.app }).toEqual({ ended: false, app: true });
    expect(await codesOf(ana.id)).toEqual([]);
    expect((await audits("signin.code_refused")).map((r) => r.after)).toEqual([{ reason: "has_second_factor" }]);
    expect(await audits("signin.code_sent")).toEqual([]);
    expect(outbox).toEqual([]);
  });

  it("an app that comes into force after the password's reads: the door asks for the app, with the pending step, and it signs in", async () => {
    const ana = await seedAna({ app: "none" });
    let secret = "";
    // The password step's own read (the first) and the send's read before its lock (the second) answer no app; the
    // app is seeded then, and the send's read under the lock sees it.
    Object.assign(appHook, { parentId: ana.id, after: 2, seed: async () => { secret = (await seedAuthenticator(ana.id)).secret; } });
    const { body, pending } = await passwordStep("ana@example.com");
    expect(appHook.seed).toBeNull();
    expect(body).toEqual({ ok: true, step: "app" });
    expect(pending).not.toBe("");
    expect(await codesOf(ana.id)).toEqual([]);
    expect((await audits("signin.second_step_asked")).map((r) => r.after)).toEqual([{ step: "emailed_code" }]);
    expect((await audits("signin.code_refused")).map((r) => r.after)).toEqual([{ reason: "has_second_factor" }]);
    await new Promise((r) => setImmediate(r));
    expect(outbox).toEqual([]);
    expect((await appStep(appCode(secret), pending)).body).toEqual({ ok: true, next: "/" });
  });

  it("answers an unknown address, and an app holder's wrong password, the same as any refusal", async () => {
    await seedAna();
    const answers = [];
    for (const [email, password] of [["nobody@example.com", DOOR_PASSWORD], ["ana@example.com", "not the password at all"]]) {
      const res = await postDoor("/portal-password/check", { email, password });
      answers.push([res.status, await res.text(), res.headers.getSetCookie()]);
    }
    expect(answers[0]).toEqual([200, JSON.stringify(REFUSED), []]);
    expect(answers[1]).toEqual(answers[0]);
  });
});

describe("the app step at /portal-app/check", () => {
  it("the current code signs in, remembers the device and proves the session strong", async () => {
    const ana = await seedAna();
    const pending = await anaAtTheApp();
    const before = Date.now();
    const { res, body } = await appStep(appCode(ana.app!.secret), pending);
    expect(body).toEqual({ ok: true, next: "/" });
    expect(cookieNamed(res, "session_token")).not.toBe("");
    expect(cookieNamed(res, "device")).not.toBe("");
    const [device] = await deviceRows(ana.id);
    expect(await deviceRows(ana.id)).toHaveLength(1);
    const [row] = await sessions();
    expect(row!.strongAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row!.deviceId).toBe(device!.id);
    const [app] = await authenticatorRows(ana.id);
    expect(app!.lastUsedStep).toBeGreaterThanOrEqual(totpStep(before) - 1);
    expect((await audits("signin.second_step")).map((r) => r.after)).toEqual([{ factor: "authenticator" }]);
    expect(await audits("signin")).toHaveLength(1);
    // No row holds the code, the secret or its sealed form.
    const all = JSON.stringify(await db.select().from(auditLog));
    for (const secret of [ana.app!.secret, app!.secretCiphertext]) expect(all).not.toContain(secret);
  });

  it("the same code again is refused: a code is taken once in its 30 seconds", async () => {
    const ana = await seedAna();
    const code = appCode(ana.app!.secret);
    expect((await appStep(code, await anaAtTheApp())).body).toEqual({ ok: true, next: "/" });
    // A second sign-in, on another new device (no device cookie), with the very same code.
    const again = await appStep(code, await anaAtTheApp());
    expect(again.body).toEqual(REFUSED);
    expect(cookieNamed(again.res, "session_token")).toBe("");
    expect(await sessions()).toHaveLength(1);
    expect((await audits("signin.second_step_wrong")).map((r) => r.after)).toEqual([{ factor: "authenticator", try: 1, reason: "replayed" }]);
  });

  it("two tries at once with the same code take it once", async () => {
    const ana = await seedAna();
    const step = await stepPersonFor("ana@example.com");
    const now = new Date();
    const code = appCode(ana.app!.secret, now);
    const both = await Promise.all([verifySecondFactor(step, code, DOOR_IP, now), verifySecondFactor(step, code, DOOR_IP, now)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "rejected", ended: false }]);
  });

  it("takes the code of the step before and the step after, and refuses one two steps away", async () => {
    const ana = await seedAna();
    const step = await stepPersonFor("ana@example.com");
    const now = new Date();
    const s = ana.app!.secret;
    expect(await verifySecondFactor(step, appCode(s, now, -2), DOOR_IP, now)).toEqual({ ok: false, reason: "rejected", ended: false });
    expect(await verifySecondFactor(step, appCode(s, now, 2), DOOR_IP, now)).toEqual({ ok: false, reason: "rejected", ended: false });
    expect(await verifySecondFactor(step, appCode(s, now, -1), DOOR_IP, now)).toMatchObject({ ok: true, factor: "authenticator" });
    expect(await verifySecondFactor(step, appCode(s, now, 1), DOOR_IP, now)).toMatchObject({ ok: true, factor: "authenticator" });
    // The newest step taken is now the one after: the code of the step now is older, and taken no more.
    expect(await verifySecondFactor(step, appCode(s, now), DOOR_IP, now)).toEqual({ ok: false, reason: "rejected", ended: false });
    expect((await authenticatorRows(ana.id))[0]!.lastUsedStep).toBe(totpStep(now) + 1);
  });

  it("a backup code signs in once, with or without its dash and in any case, and not twice", async () => {
    const ana = await seedAna();
    const [first, second] = await seedBackupCodes(ana.id, 3);
    const typed = first!.toLowerCase().replace("-", " ");
    expect((await appStep(typed, await anaAtTheApp())).body).toEqual({ ok: true, next: "/" });
    expect((await audits("signin.second_step")).map((r) => r.after)).toEqual([{ factor: "backup_code", left: 2 }]);
    const again = await appStep(first!, await anaAtTheApp());
    expect(again.body).toEqual(REFUSED);
    expect((await audits("signin.second_step_wrong")).map((r) => r.after)).toEqual([{ factor: "backup_code", try: 1, reason: "wrong" }]);
    expect((await appStep(second!, await anaAtTheApp())).body).toEqual({ ok: true, next: "/" });
    expect((await backupCodeRows(ana.id)).filter((c) => c.usedAt !== null)).toHaveLength(2);
    // No row holds a code or its hash.
    const all = JSON.stringify(await db.select().from(auditLog));
    for (const c of [first!, second!, ...(await backupCodeRows(ana.id)).map((r) => r.codeHash)]) expect(all).not.toContain(c);
  });

  it("a backup code is no second step for a person with no app in force", async () => {
    const ana = await seedAna({ app: "unfinished" });
    const [code] = await seedBackupCodes(ana.id, 1);
    const step = await stepPersonFor("ana@example.com");
    expect(await verifySecondFactor(step, code!, DOOR_IP)).toEqual({ ok: false, reason: "rejected", ended: false });
    expect((await backupCodeRows(ana.id))[0]!.usedAt).toBeNull();
    expect((await audits("signin.second_step_wrong")).map((r) => r.after)).toEqual([{ factor: "backup_code", try: 1, reason: "no_app" }]);
  });

  it("the sixth wrong try is refused in the over-limit words, the right code included, and a right code gives its place back", async () => {
    const ana = await seedAna();
    const pending = await anaAtTheApp();
    // A right code first: its place is given back, so it never counts.
    // Worked out for the instant the check is given, so no step's edge can fall between the two.
    const at = new Date();
    const right = await verifySecondFactor(await stepPersonFor("ana@example.com"), appCode(ana.app!.secret, at, -1), DOOR_IP, at);
    expect(right.ok).toBe(true);
    for (let i = 0; i < 5; i++) expect((await appStep(wrongAppCode(ana.app!.secret), pending)).body).toEqual(REFUSED);
    expect((await appStep(appCode(ana.app!.secret, Date.now(), 1), pending)).body).toEqual(LIMITED);
    expect(await sessions()).toEqual([]);
    expect((await audits("signin.second_step_wrong")).map((r) => (r.after as { try: number }).try)).toEqual([1, 2, 3, 4, 5]);
    expect((await audits("signin.refused")).map((r) => r.after)).toEqual([{ reason: "rate_limited", limit: "second_step" }]);
    expect((await db.select().from(rateLimitEvent)).filter((e) => e.kind === "second_step_parent" && e.subject === ana.id)).toHaveLength(5);
  });

  it("signs nobody in with no pending step, a forged one, or another person's", async () => {
    const ana = await seedAna();
    const ben = await seedParent({ name: "Ben", email: "ben@example.com" });
    await seedGuardianInFamily({ parentId: ben.id, familyQboId: "F2" });
    await seedPassword(ben.authUserId, DOOR_PASSWORD);
    const bens = (await passwordStep("ben@example.com")).pending;
    const name = bens.split("=")[0]!;
    // Signed with the server's secret but naming a password row that isn't Ana's: refused before her code is looked at.
    const forgedSigned = signedStep(name, { p: ana.id, e: "ana@example.com", c: "not-her-row", u: Date.now(), x: Date.now() + 60_000 });
    const unsigned = `${name}=${Buffer.from(JSON.stringify({ p: ana.id, e: "ana@example.com", c: "x", u: 0, x: Date.now() + 60_000 })).toString("base64url")}`;
    for (const cookie of ["", unsigned, forgedSigned, bens]) {
      const r = await appStep(appCode(ana.app!.secret), cookie);
      expect([cookie, r.body]).toEqual([cookie, REFUSED]);
      expect(cookieNamed(r.res, "session_token")).toBe("");
    }
    expect(await sessions()).toEqual([]);
    expect((await authenticatorRows(ana.id))[0]!.lastUsedStep).toBeNull();
  });

  it("a secret that won't open is a refused try, never a throw", async () => {
    const ana = await seedAna();
    // Sealed for another row: the box refuses to open it here.
    const elsewhere = sealAuthenticatorSecret("00000000-0000-4000-8000-000000000000", ana.id, ana.app!.secret);
    await db.update(parentAuthenticator).set({ secretCiphertext: elsewhere.ciphertext, secretKeyId: elsewhere.keyId }).where(eq(parentAuthenticator.id, ana.app!.id));
    const pending = await anaAtTheApp();
    const { res, body } = await appStep(appCode(ana.app!.secret), pending);
    expect(res.status).toBe(200);
    expect(body).toEqual(REFUSED);
    expect((await audits("signin.refused")).map((r) => r.after)).toEqual([{ reason: "second_factor_unreadable" }]);
    expect(await sessions()).toEqual([]);
  });

  it("tries against a secret that won't open keep no place: after five the count is zero, and a backup code still gets in", async () => {
    const ana = await seedAna();
    const [backup] = await seedBackupCodes(ana.id, 1);
    const elsewhere = sealAuthenticatorSecret("00000000-0000-4000-8000-000000000000", ana.id, ana.app!.secret);
    await db.update(parentAuthenticator).set({ secretCiphertext: elsewhere.ciphertext, secretKeyId: elsewhere.keyId }).where(eq(parentAuthenticator.id, ana.app!.id));
    const pending = await anaAtTheApp();
    for (let i = 0; i < 5; i++) expect((await appStep(appCode(ana.app!.secret), pending)).body).toEqual(REFUSED);
    expect((await db.select().from(rateLimitEvent)).filter((e) => e.kind === "second_step_parent" && e.subject === ana.id)).toEqual([]);
    expect((await audits("signin.refused")).map((r) => r.after)).toEqual(Array.from({ length: 5 }, () => ({ reason: "second_factor_unreadable" })));
    expect(await audits("signin.second_step_wrong")).toEqual([]);
    expect((await appStep(backup!, pending)).body).toEqual({ ok: true, next: "/" });
    expect((await audits("signin.second_step")).map((r) => r.after)).toEqual([{ factor: "backup_code", left: 0 }]);
  });

  it("an app's code typed as the apps show it, with a space or a dash, is the app's code, a leading zero kept", async () => {
    const ana = await seedAna();
    const step = await stepPersonFor("ana@example.com");
    const s = ana.app!.secret;
    // Two steps whose codes start with a zero, the second the newer (a code is taken only for a newer step than the last).
    const zeros: Date[] = [];
    for (let k = 0; zeros.length < 2; k++) {
      const at = new Date(Date.now() + k * 30_000);
      if (appCode(s, at).startsWith("0")) zeros.push(at);
    }
    const [first, second] = zeros as [Date, Date];
    const a = appCode(s, first);
    const b = appCode(s, second);
    expect(await verifySecondFactor(step, `${a.slice(0, 3)} ${a.slice(3)}`, DOOR_IP, first)).toMatchObject({ ok: true, factor: "authenticator" });
    expect(await verifySecondFactor(step, `${b.slice(0, 3)}-${b.slice(3)}`, DOOR_IP, second)).toMatchObject({ ok: true, factor: "authenticator" });
    expect((await authenticatorRows(ana.id))[0]!.lastUsedStep).toBe(totpStep(second));
    // Five digits (as a code with its zero dropped would be) or seven, spaced or dashed or not, are no code of either shape.
    const later = new Date(second.getTime() + 30_000);
    for (const typed of ["12345", "12 34 5", "1234-567"]) {
      expect([typed, await verifySecondFactor(step, typed, DOOR_IP, later)]).toEqual([typed, { ok: false, reason: "rejected", ended: false }]);
    }
    expect((await audits("signin.second_step_wrong")).map((r) => (r.after as { reason: string }).reason)).toEqual(["wrong", "wrong", "wrong"]);
  });

  it("a backup code with spaces and dashes about it is still a backup code", async () => {
    const ana = await seedAna();
    const step = await stepPersonFor("ana@example.com");
    const [code] = await seedBackupCodes(ana.id, 1);
    expect(await verifySecondFactor(step, ` ${code!.replace("-", " - ").toLowerCase()} `, DOOR_IP)).toMatchObject({ ok: true, factor: "backup_code" });
  });

  it("tries made at once each write their own number among the window's tries", async () => {
    const ana = await seedAna();
    const step = await stepPersonFor("ana@example.com");
    const wrong = wrongAppCode(ana.app!.secret);
    const now = new Date();
    await Promise.all([1, 2, 3].map(() => verifySecondFactor(step, wrong, DOOR_IP, now)));
    expect((await audits("signin.second_step_wrong")).map((r) => (r.after as { try: number }).try).sort()).toEqual([1, 2, 3]);
  });
});

describe("the emailed code is never an app holder's", () => {
  it("/portal-code/resend and /portal-code/check send and take nothing for an app holder", async () => {
    const ana = await seedAna();
    const pending = await anaAtTheApp();
    await seedCode(ana.id, { code: "135790" });
    expect(await (await postDoor("/portal-code/resend", {}, { cookie: pending })).json()).toEqual({ ok: true });
    expect((await audits("signin.code_refused")).map((r) => r.after)).toEqual([{ reason: "has_second_factor" }]);
    const checked = await codeStep("135790", pending);
    expect(checked.body).toEqual(REFUSED);
    expect(cookieNamed(checked.res, "session_token")).toBe("");
    // Not ended: the pending step goes on to the app.
    expect(cookieNamed(checked.res, "signin_step")).toBe("");
    expect(checked.res.headers.getSetCookie().some((l) => /signin_step=;/.test(l))).toBe(false);
    expect((await audits("signin.refused")).map((r) => r.after)).toEqual([{ reason: "has_second_factor" }]);
    // The seeded code is not spent, and only it is there: none was sent.
    expect((await codesOf(ana.id)).map((c) => c.usedAt)).toEqual([null]);
    expect(outbox).toEqual([]);
    expect((await appStep(appCode(ana.app!.secret), pending)).body).toEqual({ ok: true, next: "/" });
  });

  it("a code mailed before the app was in force is refused at the sign-in's last check", async () => {
    const ana = await seedAna({ app: "none" });
    const step = await stepPersonFor("ana@example.com");
    const codeId = await seedCode(ana.id, { usedAt: new Date() });
    expect(await signinStands(ana.id, "ana@example.com", DOOR_IP, { password: step.password, codeId })).toBe(true);
    await seedAuthenticator(ana.id);
    expect(await signinStands(ana.id, "ana@example.com", DOOR_IP, { password: step.password, codeId })).toBe(false);
    expect((await audits("signin.refused")).map((r) => r.after)).toEqual([{ reason: "second_factor_in_force" }]);
  });

  it("the app's and a backup code's proofs stand only while the app is in force and the code is spent", async () => {
    const ana = await seedAna();
    const step = await stepPersonFor("ana@example.com");
    const [code] = await seedBackupCodes(ana.id, 1);
    const spent = await verifySecondFactor(step, code!, DOOR_IP);
    if (!spent.ok) throw new Error("the backup code should be taken");
    expect(await signinStands(ana.id, "ana@example.com", DOOR_IP, { password: step.password, ...spent.proof })).toBe(true);
    expect(await signinStands(ana.id, "ana@example.com", DOOR_IP, { password: step.password, authenticatorId: ana.app!.id, signedOutSeen: 0 })).toBe(true);
    await db.delete(parentBackupCode).where(eq(parentBackupCode.parentId, ana.id));
    await db.update(parentAuthenticator).set({ confirmedAt: null }).where(eq(parentAuthenticator.id, ana.app!.id));
    expect(await signinStands(ana.id, "ana@example.com", DOOR_IP, { password: step.password, ...spent.proof })).toBe(false);
    expect(await signinStands(ana.id, "ana@example.com", DOOR_IP, { password: step.password, authenticatorId: ana.app!.id, signedOutSeen: 0 })).toBe(false);
    expect((await audits("signin.refused")).map((r) => r.after)).toEqual([{ reason: "backup_code_gone" }, { reason: "second_factor_gone" }]);
  });

  it("a code taken before Sign out everywhere signs nobody in after it, and one taken after the press does", async () => {
    const ana = await seedAna();
    const step = await stepPersonFor("ana@example.com");
    const [code] = await seedBackupCodes(ana.id, 1);
    const now = new Date();
    const byApp = await verifySecondFactor(step, appCode(ana.app!.secret, now), DOOR_IP, now);
    const byCode = await verifySecondFactor(step, code!, DOOR_IP, now);
    if (!byApp.ok || !byCode.ok) throw new Error("both should be taken");
    // The press commits between the try and the sign-in's last check: it keeps the app and the backup codes.
    expect(await signOutEverywhere({ parentId: ana.id, sessionId: "no-session", email: "ana@example.com", ip: DOOR_IP })).toEqual(expect.objectContaining({ ok: true }));
    expect(await signinStands(ana.id, "ana@example.com", DOOR_IP, { password: step.password, ...byApp.proof })).toBe(false);
    expect(await signinStands(ana.id, "ana@example.com", DOOR_IP, { password: step.password, ...byCode.proof })).toBe(false);
    expect((await audits("signin.refused")).map((r) => r.after)).toEqual([{ reason: "signed_out_everywhere" }, { reason: "signed_out_everywhere" }]);
    // A code taken after the press stands.
    const later = new Date(now.getTime() + 30_000);
    const again = await verifySecondFactor(step, appCode(ana.app!.secret, later), DOOR_IP, later);
    if (!again.ok) throw new Error("the next step's code should be taken");
    expect(await signinStands(ana.id, "ana@example.com", DOOR_IP, { password: step.password, ...again.proof })).toBe(true);
  });
});
