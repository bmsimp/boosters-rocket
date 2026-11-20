import { describe, it, expect, vi, beforeEach } from "vitest";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, parent, parentAuthAccount, parentAuthPasskey, parentAuthSession, parentAuthVerification, rateLimitEvent, signinCode } from "@/lib/db/schema";
import { signinStands } from "@/lib/parents/signin-codes";
import { checkPasskeySignin } from "@/lib/parents/passkey-signin";
import { signOutEverywhere } from "@/lib/parents/signin-settings";
import { resetDb, seedParent, seedGuardianInFamily, seedWorkingMail } from "../helpers/db";
import { SIGNINS_ON, seedParentSettings } from "../helpers/roster-cache";
import { DOOR_IP, DOOR_PASSWORD, appStep, codeStep, cookieNamed, getDoor, passwordStep, postDoor, stepPersonFor } from "../helpers/parent-door";
import { deviceRows, seedCode, seedDevice, seedPassword } from "../helpers/signin-links";
import { appCode, seedAuthenticator, seedBackupCodes, wrongAppCode } from "../helpers/authenticator";
import { ORIGIN, RP_ID, passkeyOptions, passkeyRows, passkeyStep, postPasskey, seedPasskey } from "../helpers/passkey";
import { assertionFor, makePasskeyKey } from "../helpers/passkey-keys";

/**
 * A passkey at the door (the sign-in release, slice SI-7a; open questions 24, 30 and 35 of the app-owned families
 * spec): alone, with no address typed, it is a whole sign-in; after a right password it is the second step, and its
 * holder is never emailed a code. The ceremony is the passkey library's, the sign-in the portal's (/portal-passkey/check).
 * Nothing a parent can press adds a passkey until SI-7b, so the passkeys are seeded and signed with by the software
 * authenticator of tests/helpers/passkey-keys.ts.
 */
const REFUSED = { ok: false, error: "rejected" };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const sessions = () => db.select().from(parentAuthSession);
const codesOf = (parentId: string) => db.select().from(signinCode).where(eq(signinCode.parentId, parentId));
const placesOf = (kind: string) => db.select().from(rateLimitEvent).where(eq(rateLimitEvent.kind, kind));

/** A guardian in a family of the app's own (`familyQboId`), with the helper's password unless told not, and a passkey unless told not. */
async function seedHolder(name: string, o: { familyQboId?: string; password?: boolean; passkey?: boolean; counter?: number } = {}) {
  const p = await seedParent({ name, email: `${name.toLowerCase()}@example.com` });
  await seedGuardianInFamily({ parentId: p.id, familyQboId: o.familyQboId ?? "F1" });
  if (o.password !== false) await seedPassword(p.authUserId, DOOR_PASSWORD);
  const key = o.passkey === false ? null : await seedPasskey(p.id, { counter: o.counter });
  return { ...p, key };
}
/** Ana's right password on a new device: the pending step's cookie, after checking what she was asked for. */
async function atThePasskey(email: string, app = false) {
  const first = await passwordStep(email);
  expect(first.body).toEqual({ ok: true, step: "passkey", app });
  return first.pending;
}

beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); await seedParentSettings(SIGNINS_ON); });

describe("a passkey alone signs in (open questions 30 and 35)", () => {
  it("with no address typed: the session, a new device remembered, strong_at stamped, the passkey used and audited", async () => {
    const ana = await seedHolder("Ana");
    const { res, body } = await passkeyStep(ana.key!);
    expect(body).toEqual({ ok: true, next: "/" });
    expect(cookieNamed(res, "session_token")).not.toBe("");
    expect(cookieNamed(res, "device")).not.toBe("");
    const [session] = await sessions();
    expect(session!.strongAt).not.toBeNull();
    const [device] = await deviceRows(ana.id);
    expect(session!.deviceId).toBe(device!.id);
    const [row] = await passkeyRows(ana.id);
    expect(row!.lastUsedAt).not.toBeNull();
    expect(row!.counter).toBe(1); // written by the library, as it verified
    expect((await audits("signin.second_step")).map((r) => [r.targetId, r.after])).toEqual([[ana.id, { factor: "passkey", alone: true }]]);
    expect(await audits("signin.device_remembered")).toHaveLength(1);
    expect(await audits("signin.second_step_asked")).toEqual([]);
    expect(outbox).toEqual([]);
  });

  it("takes a signature counter past a 32-bit signed number, as WebAuthn's counter is unsigned", async () => {
    const ana = await seedHolder("Ana", { counter: 3_000_000_000 });
    expect((await passkeyStep(ana.key!, { counter: 3_000_000_001 })).body).toEqual({ ok: true, next: "/" });
    expect((await passkeyRows(ana.id))[0]!.counter).toBe(3_000_000_001);
  });

  it("lands where the code's sign-in lands: the page asked for", async () => {
    const ana = await seedHolder("Ana");
    expect((await passkeyStep(ana.key!, { next: "/forms" })).body).toEqual({ ok: true, next: "/forms" });
  });

  it("renews the device the browser's cookie names for this person instead of making a copy", async () => {
    const ana = await seedHolder("Ana");
    const device = await seedDevice(ana.id);
    const { body } = await passkeyStep(ana.key!, { cookie: `br_parent.device=${device.token}` });
    expect(body).toEqual({ ok: true, next: "/" });
    expect((await deviceRows(ana.id)).map((d) => d.id)).toEqual([device.id]);
    expect(await audits("signin.device_used")).toHaveLength(1);
    expect((await sessions())[0]!.strongAt).not.toBeNull();
  });

  it("needs no password: a guardian with none signs in with their passkey", async () => {
    const ana = await seedHolder("Ana", { password: false });
    expect((await passkeyStep(ana.key!)).body).toEqual({ ok: true, next: "/" });
  });

  it("is not stopped by a full count of wrong passwords for the address", async () => {
    const ana = await seedHolder("Ana");
    for (let i = 0; i < 5; i++) expect((await passwordStep("ana@example.com", { password: "not the password at all" })).body).toEqual(REFUSED);
    expect((await passwordStep("ana@example.com")).body).toEqual({ ok: false, error: "rate_limited" });
    expect((await passkeyStep(ana.key!)).body).toEqual({ ok: true, next: "/" });
  });
});

describe("who is asked for the passkey (open question 24)", () => {
  it("a holder's right password asks for the passkey, sends no code, makes no code row, and the passkey finishes it", async () => {
    const ana = await seedHolder("Ana");
    const { res, body, pending } = await passwordStep("ana@example.com");
    expect(body).toEqual({ ok: true, step: "passkey", app: false });
    expect(pending).not.toBe("");
    expect(cookieNamed(res, "session_token")).toBe("");
    expect(await codesOf(ana.id)).toEqual([]);
    expect((await audits("signin.second_step_asked")).map((r) => r.after)).toEqual([{ step: "second_factor" }]);
    await new Promise((r) => setImmediate(r));
    expect(outbox).toEqual([]);
    const done = await passkeyStep(ana.key!, { cookie: pending });
    expect(done.body).toEqual({ ok: true, next: "/" });
    expect((await audits("signin.second_step")).map((r) => r.after)).toEqual([{ factor: "passkey", alone: false }]);
    expect((await sessions())[0]!.strongAt).not.toBeNull();
  });

  it("a holder of an app and a passkey is offered both, and the app's code or a backup code finishes the step", async () => {
    const ana = await seedHolder("Ana");
    const app = await seedAuthenticator(ana.id);
    const [backup] = await seedBackupCodes(ana.id, 1);
    expect((await appStep(appCode(app.secret), await atThePasskey("ana@example.com", true))).body).toEqual({ ok: true, next: "/" });
    expect((await appStep(backup!, await atThePasskey("ana@example.com", true))).body).toEqual({ ok: true, next: "/" });
  });

  it("the code endpoints send and take nothing for a holder at the door", async () => {
    const ana = await seedHolder("Ana");
    const pending = await atThePasskey("ana@example.com");
    await seedCode(ana.id, { code: "135790" });
    expect(await (await postDoor("/portal-code/resend", {}, { cookie: pending })).json()).toEqual({ ok: true });
    expect((await audits("signin.code_refused")).map((r) => r.after)).toEqual([{ reason: "has_second_factor" }]);
    expect((await codeStep("135790", pending)).body).toEqual(REFUSED);
    expect((await audits("signin.refused")).map((r) => r.after)).toEqual([{ reason: "has_second_factor" }]);
    expect((await codesOf(ana.id)).map((c) => c.usedAt)).toEqual([null]);
    expect(outbox).toEqual([]);
    expect((await passkeyStep(ana.key!, { cookie: pending })).body).toEqual({ ok: true, next: "/" });
  });

  it("a code mailed before the passkey is refused at the sign-in's last check at the door, and taken by asking again", async () => {
    const ana = await seedHolder("Ana", { passkey: false });
    const step = await stepPersonFor("ana@example.com");
    const codeId = await seedCode(ana.id, { usedAt: new Date() });
    expect(await signinStands(ana.id, "ana@example.com", DOOR_IP, { password: step.password, codeId })).toBe(true);
    await seedPasskey(ana.id);
    expect(await signinStands(ana.id, "ana@example.com", DOOR_IP, { password: step.password, codeId })).toBe(false);
    expect((await audits("signin.refused")).map((r) => r.after)).toEqual([{ reason: "second_factor_in_force" }]);
    // Asking again counts the app alone until slice SI-7b, by design.
    expect(await signinStands(ana.id, "ana@example.com", DOOR_IP, { password: step.password, codeId }, new Date(), "change")).toBe(true);
  });

  it("under Strict a passkey alone signs in, and a holder's password asks for the passkey", async () => {
    const ana = await seedHolder("Ana");
    await seedParentSettings({ level: "strict" });
    expect((await passkeyStep(ana.key!)).body).toEqual({ ok: true, next: "/" });
    expect((await passwordStep("ana@example.com")).body).toEqual({ ok: true, step: "passkey", app: false });
  });
});

describe("one person's passkey, and one answer for everything else", () => {
  it("at family A's parent's step, family B's parent's passkey and A's second guardian's are refused, A's step kept and nothing of theirs used", async () => {
    const ana = await seedHolder("Ana", { familyQboId: "F1" });
    const ben = await seedHolder("Ben", { familyQboId: "F2" });
    const cal = await seedHolder("Cal", { familyQboId: "F1" });
    const pending = await atThePasskey("ana@example.com");
    for (const other of [ben, cal]) {
      const r = await passkeyStep(other.key!, { cookie: pending });
      expect(r.body).toEqual(REFUSED);
      expect(cookieNamed(r.res, "session_token")).toBe("");
      expect(r.res.headers.getSetCookie().some((l) => /signin_step=;/.test(l))).toBe(false);
      const [row] = await passkeyRows(other.id);
      expect([row!.counter, row!.lastUsedAt]).toEqual([0, null]);
    }
    expect(await sessions()).toEqual([]);
    expect((await audits("signin.refused")).map((r) => [r.targetId, r.after])).toEqual([
      [ana.id, { reason: "other_person", factor: "passkey" }], [ana.id, { reason: "other_person", factor: "passkey" }]]);
    expect((await passkeyStep(ana.key!, { cookie: pending })).body).toEqual({ ok: true, next: "/" });
  });

  it("refuses no user verification, another origin, another relying party id, a stale counter, a forged signature, an unknown credential and a challenge from no options", async () => {
    const ana = await seedHolder("Ana", { counter: 5 });
    const tries = [
      { flags: 0x01, counter: 6 }, { origin: "https://elsewhere.example", counter: 6 }, { rpId: "elsewhere.example", counter: 6 },
      { counter: 3 }, { signWith: makePasskeyKey(), counter: 6 },
    ];
    for (const t of tries) expect((await passkeyStep(ana.key!, t)).body).toEqual(REFUSED);
    expect((await passkeyStep(makePasskeyKey())).body).toEqual(REFUSED);
    expect((await passkeyStep(ana.key!, { counter: 6, challengeCookie: null })).body).toEqual(REFUSED);
    expect(await sessions()).toEqual([]);
    expect((await audits("signin.second_step_wrong")).map((r) => r.after)).toEqual([
      { factor: "passkey", reason: "not_verified" }, { factor: "passkey", reason: "passkey_failed" }, { factor: "passkey", reason: "passkey_failed" },
      { factor: "passkey", reason: "passkey_failed" }, { factor: "passkey", reason: "passkey_failed" }, { factor: "passkey", reason: "challenge_used" }]);
    expect((await audits("signin.refused")).map((r) => [r.targetId, r.after])).toEqual([[null, { reason: "passkey_unknown", factor: "passkey" }]]);
    expect((await passkeyRows(ana.id))[0]!.counter).toBe(5);
    // Nothing of an assertion, a key or a counter is in any row.
    const rows = JSON.stringify(await db.select().from(auditLog));
    expect(rows).not.toContain(ana.key!.id);
    expect(rows).not.toContain(ana.key!.publicKey.slice(0, 20));
    // And then a good one signs in.
    expect((await passkeyStep(ana.key!, { counter: 6 })).body).toEqual({ ok: true, next: "/" });
  });

  it("an assertion sent again, or twice at once, signs in once", async () => {
    const ana = await seedHolder("Ana");
    const first = await passkeyStep(ana.key!);
    expect(first.body).toEqual({ ok: true, next: "/" });
    expect((await postPasskey(first.assertion, { cookie: first.cookie })).body).toEqual(REFUSED);
    const options = await passkeyOptions();
    const twice = assertionFor(ana.key!, options.body.challenge, { origin: ORIGIN, rpId: RP_ID, counter: 2 });
    const both = await Promise.all([1, 2].map(() => postPasskey(twice, { cookie: options.challengeCookie })));
    expect(both.map((b) => b.body.ok).sort()).toEqual([false, true]);
    expect(await sessions()).toHaveLength(2);
    expect((await audits("signin.second_step")).map((r) => r.after)).toEqual([{ factor: "passkey", alone: true }, { factor: "passkey", alone: true }]);
  });

  it("a blocked person, sign-ins off and nobody the club lets in are refused", async () => {
    const ana = await seedHolder("Ana");
    await db.update(parent).set({ blocked: true }).where(eq(parent.id, ana.id));
    expect((await passkeyStep(ana.key!)).body).toEqual(REFUSED);
    await db.update(parent).set({ blocked: false }).where(eq(parent.id, ana.id));
    // Sign-ins switched off between the challenge and the passkey (while they are off, the challenge itself is refused:
    // below): the check refuses it.
    const asked = await passkeyOptions();
    await seedParentSettings({ signin: false });
    const offAssertion = assertionFor(ana.key!, asked.body.challenge, { origin: ORIGIN, rpId: RP_ID, counter: 2 });
    expect((await postPasskey(offAssertion, { cookie: asked.challengeCookie })).body).toEqual(REFUSED);
    await seedParentSettings(SIGNINS_ON);
    const dan = await seedParent({ name: "Dan", email: "dan@example.com" });
    const danKey = await seedPasskey(dan.id);
    expect((await passkeyStep(danKey)).body).toEqual(REFUSED);
    expect(await sessions()).toEqual([]);
    expect((await audits("signin.refused")).map((r) => (r.after as { reason: string }).reason)).toEqual(["blocked", "signins_off", "no_enabled_guardian"]);
  });

  it("a refusal that ends the second step answers ended and clears the pending step", async () => {
    const ana = await seedHolder("Ana");
    const pending = await atThePasskey("ana@example.com");
    await db.update(parent).set({ blocked: true }).where(eq(parent.id, ana.id));
    const r = await passkeyStep(ana.key!, { cookie: pending });
    expect(r.body).toEqual({ ...REFUSED, ended: true });
    expect(r.res.headers.getSetCookie().some((l) => /signin_step=;/.test(l))).toBe(true);
  });

  it("a passkey's refusals take no second-step place, and a full count of them doesn't stop it", async () => {
    const ana = await seedHolder("Ana");
    const app = await seedAuthenticator(ana.id);
    const pending = await atThePasskey("ana@example.com", true);
    for (let i = 0; i < 5; i++) expect((await passkeyStep(ana.key!, { cookie: pending, signWith: makePasskeyKey() })).body).toEqual(REFUSED);
    expect(await placesOf("second_step_parent")).toEqual([]);
    for (const row of await audits("signin.second_step_wrong")) expect(row.after).not.toHaveProperty("try");
    // The app's five wrong codes fill the person's count; the passkey still finishes the step.
    for (let i = 0; i < 5; i++) expect((await appStep(wrongAppCode(app.secret), pending)).body).toEqual(REFUSED);
    expect((await appStep(appCode(app.secret), pending)).body).toEqual({ ok: false, error: "rate_limited" });
    expect((await passkeyStep(ana.key!, { cookie: pending })).body).toEqual({ ok: true, next: "/" });
  });
});

describe("the first screen's passkey signs in alone, whatever step the browser still carries", () => {
  it("after A's password left a step (Start again on a shared computer), B's passkey alone signs B in and ends A's step", async () => {
    const ana = await seedHolder("Ana", { familyQboId: "F1" });
    const ben = await seedHolder("Ben", { familyQboId: "F2" });
    const pending = await atThePasskey("ana@example.com");
    const r = await passkeyStep(ben.key!, { cookie: pending, alone: true });
    expect(r.body).toEqual({ ok: true, next: "/" });
    expect(r.res.headers.getSetCookie().some((l) => /signin_step=;/.test(l))).toBe(true);
    const [session] = await sessions();
    expect(session!.userId).toBe(ben.authUserId);
    expect((await audits("signin.second_step")).map((x) => [x.targetId, x.after])).toEqual([[ben.id, { factor: "passkey", alone: true }]]);
    expect(await audits("signin.refused")).toEqual([]);
    // Nothing of A's was used: her passkey untouched, and her step no longer carried by the browser that sent B's.
    expect((await passkeyRows(ana.id))[0]!.lastUsedAt).toBeNull();
  });

  it("A's own passkey from the first screen signs her in alone, the step she left ended", async () => {
    const ana = await seedHolder("Ana");
    const pending = await atThePasskey("ana@example.com");
    const r = await passkeyStep(ana.key!, { cookie: pending, alone: true });
    expect(r.body).toEqual({ ok: true, next: "/" });
    expect((await audits("signin.second_step")).map((x) => x.after)).toEqual([{ factor: "passkey", alone: true }]);
  });

  it("a refused passkey alone still ends the step left in the browser, and its refusal ends nothing at the page", async () => {
    const ana = await seedHolder("Ana");
    const pending = await atThePasskey("ana@example.com");
    const r = await passkeyStep(ana.key!, { cookie: pending, alone: true, signWith: makePasskeyKey() });
    expect(r.body).toEqual(REFUSED);
    expect(r.res.headers.getSetCookie().some((l) => /signin_step=;/.test(l))).toBe(true);
    expect((await audits("signin.second_step_wrong")).map((x) => [x.targetId, x.after])).toEqual([[ana.id, { factor: "passkey", reason: "passkey_failed" }]]);
  });

  it("refuses, uncounted, an alone that is not 1 and a next that is not one string of at most a return path's length", async () => {
    const ana = await seedHolder("Ana");
    const options = await passkeyOptions();
    const assertion = assertionFor(ana.key!, options.body.challenge, { origin: ORIGIN, rpId: RP_ID });
    for (const query of ["alone=2", "alone=1&alone=1", "next=%2Fa&next=%2Fb", `next=${"a".repeat(2049)}`]) {
      expect((await postPasskey(assertion, { cookie: options.challengeCookie, query })).body).toEqual(REFUSED);
    }
    expect(await placesOf("code_check_ip")).toEqual([]);
    expect((await db.select().from(auditLog)).filter((x) => x.action.startsWith("signin."))).toEqual([]);
    // The challenge was never spent: the same assertion then signs in.
    expect((await postPasskey(assertion, { cookie: options.challengeCookie })).body).toEqual({ ok: true, next: "/" });
  });
});

describe("a passkey's refusals that the other tests don't meet", () => {
  it("a stored public key that won't decode is refused in words of its own (passkey_unreadable), never a throw", async () => {
    const ana = await seedHolder("Ana", { passkey: false });
    const notBase64 = await seedPasskey(ana.id, { publicKey: "!!" });
    const notAMap = await seedPasskey(ana.id, { publicKey: Buffer.from([0x82, 0x01, 0x02]).toString("base64") });
    for (const key of [notBase64, notAMap]) {
      const r = await passkeyStep(key);
      expect(r.res.status).toBe(200);
      expect(r.body).toEqual(REFUSED);
    }
    expect(await sessions()).toEqual([]);
    expect((await audits("signin.second_step_wrong")).map((x) => [x.targetId, x.after])).toEqual([
      [ana.id, { factor: "passkey", reason: "passkey_unreadable" }], [ana.id, { factor: "passkey", reason: "passkey_unreadable" }]]);
  });

  it("a password reset between the password and the passkey ends the step (password_changed)", async () => {
    const ana = await seedHolder("Ana");
    const pending = await atThePasskey("ana@example.com");
    await db.delete(parentAuthAccount).where(eq(parentAuthAccount.userId, ana.authUserId));
    await seedPassword(ana.authUserId, "a new password after the reset");
    const r = await passkeyStep(ana.key!, { cookie: pending });
    expect(r.body).toEqual({ ...REFUSED, ended: true });
    expect(r.res.headers.getSetCookie().some((l) => /signin_step=;/.test(l))).toBe(true);
    expect((await audits("signin.refused")).map((x) => [x.targetId, x.after])).toEqual([[ana.id, { reason: "password_changed", factor: "passkey" }]]);
    expect(await sessions()).toEqual([]);
  });

  it("an address changed between the password and the passkey ends the step (address_changed)", async () => {
    const ana = await seedHolder("Ana");
    const pending = await atThePasskey("ana@example.com");
    await db.update(parent).set({ email: "ana.new@example.com" }).where(eq(parent.id, ana.id));
    const r = await passkeyStep(ana.key!, { cookie: pending });
    expect(r.body).toEqual({ ...REFUSED, ended: true });
    expect((await audits("signin.refused")).map((x) => [x.targetId, x.after])).toEqual([[ana.id, { reason: "address_changed", factor: "passkey" }]]);
    expect(await sessions()).toEqual([]);
  });

  it("a passkey the library verified as another person's than the step's is refused after it (other_person), the step kept", async () => {
    const ana = await seedHolder("Ana", { familyQboId: "F1" });
    const ben = await seedHolder("Ben", { familyQboId: "F2" });
    const step = await stepPersonFor("ana@example.com");
    // A credential id the portal finds nobody for before the library is asked (a row made between the two reads), which
    // the library then verifies as Ben's.
    const assertion = assertionFor(makePasskeyKey(), "a-challenge", { origin: ORIGIN, rpId: RP_ID });
    const r = await checkPasskeySignin({ ...assertion }, step,
      async () => ({ ok: true, passkey: { passkeyId: ben.key!.rowId, parentId: ben.id } }), DOOR_IP);
    expect(r).toEqual({ ok: false, reason: "rejected", ended: false });
    expect((await audits("signin.refused")).map((x) => [x.targetId, x.after])).toEqual([[ana.id, { reason: "other_person", factor: "passkey" }]]);
    expect((await passkeyRows(ben.id))[0]!.lastUsedAt).toBeNull();
    expect(await audits("signin.second_step")).toEqual([]);
  });
});

describe("a passkey's proof at the sign-in's last check", () => {
  it("Sign out everywhere between the passkey's check and its session refuses it", async () => {
    const ana = await seedHolder("Ana");
    const proof = { passkeyId: ana.key!.rowId, signedOutSeen: 0 };
    expect(await signinStands(ana.id, "ana@example.com", DOOR_IP, proof)).toBe(true);
    expect(await signOutEverywhere({ parentId: ana.id, sessionId: "no-session", email: "ana@example.com", ip: DOOR_IP })).toEqual(expect.objectContaining({ ok: true }));
    expect(await signinStands(ana.id, "ana@example.com", DOOR_IP, proof)).toBe(false);
    const step = await stepPersonFor("ana@example.com");
    expect(await signinStands(ana.id, "ana@example.com", DOOR_IP, { password: step.password, ...proof })).toBe(false);
    expect((await audits("signin.refused")).map((r) => r.after)).toEqual([{ reason: "signed_out_everywhere" }, { reason: "signed_out_everywhere" }]);
  });

  it("a passkey gone before the session is made is refused (passkey_gone), and a passkey alone reads no password", async () => {
    const ana = await seedHolder("Ana", { password: false });
    const proof = { passkeyId: ana.key!.rowId, signedOutSeen: 0 };
    expect(await signinStands(ana.id, "ana@example.com", DOOR_IP, proof)).toBe(true);
    await db.delete(parentAuthPasskey).where(eq(parentAuthPasskey.id, ana.key!.rowId));
    expect(await signinStands(ana.id, "ana@example.com", DOOR_IP, proof)).toBe(false);
    expect((await audits("signin.refused")).map((r) => r.after)).toEqual([{ reason: "passkey_gone" }]);
  });
});

describe("the challenge (generate-authenticate-options)", () => {
  it("answers a visitor the same whatever they send: no address in it, and no credentials listed", async () => {
    await seedHolder("Ana");
    const plain = await passkeyOptions();
    const asked = await passkeyOptions({ query: "?email=ana%40example.com&name=ana" });
    for (const o of [plain, asked]) {
      expect(o.res.status).toBe(200);
      expect(o.challengeCookie).not.toBe("");
      expect(o.body.allowCredentials).toBeUndefined();
      expect(o.body.userVerification).toBe("required");
      expect(JSON.stringify(o.body)).not.toContain("example.com");
    }
    expect(Object.keys(asked.body).sort()).toEqual(Object.keys(plain.body).sort());
    expect(asked.body.challenge).not.toBe(plain.body.challenge);
  });

  it("while sign-ins are off, answers as a disabled path does, writing no row and setting no cookie", async () => {
    await seedHolder("Ana");
    await seedParentSettings({ signin: false });
    const off = await getDoor("/passkey/generate-authenticate-options");
    const disabled = await getDoor("/passkey/generate-register-options");
    expect([off.status, await off.text()]).toEqual([disabled.status, await disabled.text()]);
    expect(off.status).toBe(404);
    expect(off.headers.getSetCookie()).toEqual([]);
    expect(await db.select().from(parentAuthVerification)).toEqual([]);
    // Switched on again, it answers and writes its one row.
    await seedParentSettings(SIGNINS_ON);
    const on = await passkeyOptions();
    expect(on.res.status).toBe(200);
    expect(await db.select().from(parentAuthVerification)).toHaveLength(1);
  });

  it("with a session, lists that session's own person's passkeys alone", async () => {
    const ana = await seedHolder("Ana", { familyQboId: "F1" });
    const ben = await seedHolder("Ben", { familyQboId: "F2" });
    const signedIn = await passkeyStep(ana.key!);
    expect(signedIn.body).toEqual({ ok: true, next: "/" });
    const listed = await passkeyOptions({ cookie: cookieNamed(signedIn.res, "session_token") });
    expect(listed.res.status).toBe(200);
    expect((listed.body.allowCredentials ?? []).map((c) => c.id)).toEqual([ana.key!.id]);
    expect(JSON.stringify(listed.body)).not.toContain(ben.key!.id);
  });
});
