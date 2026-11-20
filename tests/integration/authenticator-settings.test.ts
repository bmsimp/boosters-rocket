import { describe, it, expect, vi, beforeEach } from "vitest";
import { asParent, fromIp, renderPage } from "../helpers/signed-in";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, parentAuthenticator, parentAuthSession, parentAuthUser, parentDevice, rateLimitEvent, signinCode } from "@/lib/db/schema";
import type { ParentIdentity } from "@/lib/auth/resolve";
import { currentPassword } from "@/lib/parents/asking-again";
import { confirmMyAuthenticator, groupKey, remakeMyBackupCodes, startMyAuthenticator, turnOffMyAuthenticator } from "@/lib/parents/authenticator-settings";
import { authenticatorKeyUri, qrSquares } from "@/lib/parents/authenticator-qr";
import { hashBackupCode, normalizeBackupCode } from "@/lib/parents/backup-codes";
import { checkPasswordSignin } from "@/lib/parents/password-signin";
import { takeRateLimit, takeRateLimitPlace } from "@/lib/parents/rate-limit";
import { sendSecondStepCode, signinStands, verifySecondFactor, type StepPerson } from "@/lib/parents/signin-codes";
import { SIGNIN_SETTINGS_COPY as COPY } from "@/lib/parents/signin-settings-copy";
import { totpStep } from "@/lib/parents/totp";
import { currentBrand } from "@/lib/mail/send";
import SignInSettingsPage from "@/app/(parent)/family/sign-in/page";
import { confirmAuthenticatorAction, newBackupCodesAction, startAuthenticatorAction, turnOffAuthenticatorAction } from "@/app/(parent)/family/sign-in/actions";
import { resetDb, seedParentSession, seedWorkingMail } from "../helpers/db";
import { FAMILY_A, FAMILY_B, PROVEN_PASSWORD, proveRecently, seedParentIn, seedSignedInParent } from "../helpers/parent";
import { seedParentSettings } from "../helpers/roster-cache";
import { seedCode, seedDevice } from "../helpers/signin-links";
import { appCode, authenticatorRows, backupCodeRows, seedAuthenticator, seedBackupCodes, wrongAppCode } from "../helpers/authenticator";

/**
 * Setting up an authenticator app in sign-in settings, its backup codes shown once and made again, and turning it off
 * (the sign-in release, slice SI-6b; open questions 25, 28 and 33 of the app-owned families spec). Every press is asked
 * again first, is the session's own person's alone and takes no id. A code is worked out at a fixed `now` that the
 * press is given too, never the wall clock near a step's edge.
 */
const IP = "203.0.113.72";
beforeEach(async () => { await resetDb(); outbox.length = 0; await seedWorkingMail(); fromIp(IP); });

const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const allAudit = async () => JSON.stringify(await db.select().from(auditLog));
const ctxOf = (identity: ParentIdentity) => ({ ...identity, ip: IP });
const authUserOf = async (parentId: string) => (await db.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, parentId)))[0]!.id;
const sessionsOf = (parentId: string) => db.select({ id: parentAuthSession.id }).from(parentAuthSession)
  .innerJoin(parentAuthUser, eq(parentAuthUser.id, parentAuthSession.userId)).where(eq(parentAuthUser.parentId, parentId)).orderBy(parentAuthSession.id);
const strongAtOf = async (sessionId: string): Promise<Date | null> => (await db.select({ strongAt: sql<Date | null>`${parentAuthSession.strongAt}`.mapWith(parentAuthSession.strongAt) })
  .from(parentAuthSession).where(eq(parentAuthSession.id, sessionId)))[0]?.strongAt ?? null;
const devicesOf = (parentId: string) => db.select().from(parentDevice).where(eq(parentDevice.parentId, parentId)).orderBy(parentDevice.id);
const codesOf = (parentId: string) => db.select().from(signinCode).where(eq(signinCode.parentId, parentId));
const placesOf = async (parentId: string) => (await db.select().from(rateLimitEvent)
  .where(and(eq(rateLimitEvent.kind, "second_step_parent"), eq(rateLimitEvent.subject, parentId)))).length;
/** The person the door's password step would name, for calling its second step directly. */
const stepOf = async (identity: ParentIdentity): Promise<StepPerson> =>
  ({ parentId: identity.parentId, email: identity.email, password: (await currentPassword(db, identity.parentId))! });

/** Family A's parent with a password and a proof just now. */
async function provedParent() {
  const a = await seedSignedInParent(FAMILY_A);
  await proveRecently(a.identity);
  return a;
}
/** The set-up's first press, as the page sends it, and the base32 secret its key shows. */
async function started(identity: ParentIdentity, now?: Date) {
  const r = await startMyAuthenticator(ctxOf(identity), now);
  if (!r.ok) throw new Error(`the set-up should begin: ${r.errors.join(" ")}`);
  return { ...r, secret: r.key.replace(/ /g, "") };
}

describe("every press is asked again first", () => {
  it("is refused without a recent proof, changing nothing", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await proveRecently(a.identity);
    await db.update(parentAuthSession).set({ strongAt: new Date(Date.now() - 11 * 60_000) }).where(eq(parentAuthSession.id, a.identity.sessionId));
    asParent(a.identity);
    const NOT_PROVED = { ok: false, errors: [COPY.proveAgain] };
    expect(await startAuthenticatorAction()).toEqual(NOT_PROVED);
    expect(await confirmAuthenticatorAction("123456")).toEqual(NOT_PROVED);
    expect(await authenticatorRows(a.identity.parentId)).toEqual([]);
    const app = await seedAuthenticator(a.identity.parentId);
    await seedBackupCodes(a.identity.parentId, 3);
    const before = { app: await authenticatorRows(a.identity.parentId), codes: await backupCodeRows(a.identity.parentId) };
    expect(await newBackupCodesAction()).toEqual(NOT_PROVED);
    expect(await turnOffAuthenticatorAction()).toEqual(NOT_PROVED);
    expect({ app: await authenticatorRows(a.identity.parentId), codes: await backupCodeRows(a.identity.parentId) }).toEqual(before);
    expect(app.id).toBe(before.app[0]!.id);
    // No try at the confirm was counted: it never reached the code.
    expect(await placesOf(a.identity.parentId)).toBe(0);
    for (const action of ["parent.authenticator.setup_started", "parent.authenticator.on", "parent.authenticator.off", "parent.backup_codes.make"]) expect(await audits(action)).toEqual([]);
  });
});

describe("setting it up", () => {
  it("answers a key and a QR code once: the page before and after holds neither, the secret is sealed, and a second press replaces it", async () => {
    const a = await provedParent();
    asParent(a.identity);
    const before = await renderPage(SignInSettingsPage);
    expect(before).toContain(COPY.appSetUp);
    const first = await startAuthenticatorAction();
    if (!first.ok) throw new Error("the set-up should begin");
    expect(first.message).toBe(COPY.appScan);
    // The key to type: 20 bytes as base32 (32 characters), in eight groups of four.
    expect(first.key).toMatch(/^[A-Z2-7]{4}( [A-Z2-7]{4}){7}$/);
    const secret = first.key.replace(/ /g, "");
    expect(groupKey(secret)).toBe(first.key);
    // The QR code is the standard key URI, drawn on the server: its squares, and nothing of the URI itself.
    const uri = authenticatorKeyUri((await currentBrand()).clubName, a.identity.email, secret);
    expect(uri).toBe(`otpauth://totp/${encodeURIComponent((await currentBrand()).clubName)}:${encodeURIComponent(a.identity.email)}?secret=${secret}`
      + `&issuer=${encodeURIComponent((await currentBrand()).clubName)}&algorithm=SHA1&digits=6&period=30`);
    expect(first.qr).toEqual(qrSquares(uri));
    expect(first.qr.path).toMatch(/^(M\d+ \d+h1v1h-1z)+$/);
    expect(JSON.stringify(first)).not.toContain("otpauth");

    const [row] = await authenticatorRows(a.identity.parentId);
    expect(row).toMatchObject({ confirmedAt: null, lastUsedStep: null });
    for (const v of [secret, first.key]) expect(row!.secretCiphertext).not.toContain(v);
    expect(row!.secretCiphertext).not.toBe(secret);

    const after = await renderPage(SignInSettingsPage);
    for (const v of [secret, first.key, first.qr.path, "otpauth"]) {
      expect(before).not.toContain(v);
      expect(after).not.toContain(v);
    }
    // An unfinished set-up is nothing the page shows: the box is still off, with its press.
    expect(after).toContain(COPY.appSetUp);

    const second = await startAuthenticatorAction();
    if (!second.ok) throw new Error("the set-up should begin again");
    expect(second.key).not.toBe(first.key);
    const rows = await authenticatorRows(a.identity.parentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).not.toBe(row!.id);
    expect((await audits("parent.authenticator.setup_started")).map((r) => [r.targetType, r.targetId, r.after]))
      .toEqual([["parent", a.identity.parentId, { replaced: 0 }], ["parent", a.identity.parentId, { replaced: 1 }]]);
    const all = await allAudit();
    for (const v of [secret, second.key.replace(/ /g, ""), row!.secretCiphertext, first.qr.path]) expect(all).not.toContain(v);
    // Nothing is in force until a code checks: the door still asks for the emailed code.
    const check = await checkPasswordSignin(a.identity.email, PROVEN_PASSWORD, null, IP);
    expect(check.ok && check.step).toBe("emailed_code");
  });

  it("the right code puts it in force: the emailed codes go, ten backup codes are made and held as hashes, and the door then asks for the app", async () => {
    const a = await provedParent();
    const unused = await seedCode(a.identity.parentId);
    const spent = await seedCode(a.identity.parentId, { usedAt: new Date(Date.now() - 60_000) });
    await seedDevice(a.identity.parentId);
    const devicesBefore = await devicesOf(a.identity.parentId);
    const sessionsBefore = await sessionsOf(a.identity.parentId);
    const strongBefore = await strongAtOf(a.identity.sessionId);
    const now = new Date();
    const { secret } = await started(a.identity, now);
    const code = appCode(secret, now);
    const r = await confirmMyAuthenticator(ctxOf(a.identity), code, now);
    if (!r.ok) throw new Error(`the code should be taken: ${r.errors.join(" ")}`);
    expect(r.message).toBe(COPY.appOn);
    expect(r.codes).toHaveLength(10);
    for (const c of r.codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(new Set(r.codes).size).toBe(10);

    const [app] = await authenticatorRows(a.identity.parentId);
    expect(app!.confirmedAt).not.toBeNull();
    expect(app!.lastUsedStep).toBe(totpStep(now));
    // The emailed code not yet used is gone; the spent one stays for its sign-in's last check.
    expect((await codesOf(a.identity.parentId)).map((c) => c.id)).toEqual([spent]);
    expect(unused).not.toBe(spent);
    const rows = await backupCodeRows(a.identity.parentId);
    expect(rows).toHaveLength(10);
    const hashes = rows.map((x) => x.codeHash).sort();
    expect(hashes).toEqual(r.codes.map((c) => hashBackupCode(a.identity.parentId, normalizeBackupCode(c)!)).sort());
    for (const c of r.codes) for (const h of hashes) { expect(h).not.toBe(c); expect(h).not.toContain(normalizeBackupCode(c)!); }
    expect(rows.every((x) => x.usedAt === null)).toBe(true);

    expect((await audits("parent.authenticator.on")).map((x) => [x.targetType, x.targetId, x.after])).toEqual([["parent", a.identity.parentId, { codesDeleted: 1 }]]);
    expect((await audits("parent.backup_codes.make")).map((x) => x.after)).toEqual([{ made: 10, replaced: 0 }]);
    const all = await allAudit();
    for (const v of [secret, code, ...r.codes, ...r.codes.map((c) => normalizeBackupCode(c)!), ...hashes]) expect(all).not.toContain(v);

    // Nothing of the sign-in changed: no session made or ended, no device forgotten, strong_at as it was.
    expect(await sessionsOf(a.identity.parentId)).toEqual(sessionsBefore);
    expect(await devicesOf(a.identity.parentId)).toEqual(devicesBefore);
    expect(await strongAtOf(a.identity.sessionId)).toEqual(strongBefore);

    // The door now asks this person for the app (SI-6a's step) and emails no code.
    const check = await checkPasswordSignin(a.identity.email, PROVEN_PASSWORD, null, IP);
    expect(check.ok && check.step).toBe("second_factor");
    const sent = await sendSecondStepCode({ ...(await stepOf(a.identity)), endsAt: new Date(Date.now() + 600_000) }, IP);
    await sent.delivery;
    expect(sent.app).toBe(true);
    expect((await codesOf(a.identity.parentId)).map((c) => c.id)).toEqual([spent]);
    expect(outbox).toEqual([]);
    // The code the set-up took is never taken again; a backup code it showed signs in.
    expect(await verifySecondFactor(await stepOf(a.identity), code, IP, now)).toEqual({ ok: false, reason: "rejected", ended: false });
    expect(await verifySecondFactor(await stepOf(a.identity), r.codes[0]!, IP, now)).toMatchObject({ ok: true, factor: "backup_code" });
  });

  it("takes a code typed as apps show it, with a space or a dash", async () => {
    const a = await provedParent();
    const b = await seedSignedInParent(FAMILY_B);
    await proveRecently(b.identity);
    const now = new Date();
    for (const [who, join] of [[a, " "], [b, "-"]] as const) {
      const { secret } = await started(who.identity, now);
      const c = appCode(secret, now);
      expect(await confirmMyAuthenticator(ctxOf(who.identity), `${c.slice(0, 3)}${join}${c.slice(3)}`, now)).toMatchObject({ ok: true, message: COPY.appOn });
    }
  });

  it("counts a wrong code under the door's second_step_parent: the sixth try is refused, the right code included", async () => {
    const a = await provedParent();
    const now = new Date();
    const { secret } = await started(a.identity, now);
    // Three wrong tries at the door's count first (as three wrong app codes at sign-in would leave it).
    for (let i = 0; i < 3; i++) expect((await takeRateLimitPlace("second_step_parent", a.identity.parentId, now)).take).toBe("taken");
    const WRONG = { ok: false, errors: [COPY.appSetupWrong] };
    expect(await confirmMyAuthenticator(ctxOf(a.identity), wrongAppCode(secret, now), now)).toEqual(WRONG);
    // Anything not of the app's shape is a wrong try too, and counted.
    expect(await confirmMyAuthenticator(ctxOf(a.identity), "ABCDE-FGHJK", now)).toEqual(WRONG);
    expect(await placesOf(a.identity.parentId)).toBe(5);
    expect(await confirmMyAuthenticator(ctxOf(a.identity), appCode(secret, now), now)).toEqual({ ok: false, errors: [COPY.tooManyTries] });
    expect((await authenticatorRows(a.identity.parentId))[0]!.confirmedAt).toBeNull();
    expect((await audits("parent.authenticator.confirm_wrong")).map((r) => r.after))
      .toEqual([{ factor: "authenticator", try: 4, reason: "wrong" }, { factor: "authenticator", try: 5, reason: "wrong" }]);
    expect((await audits("parent.authenticator.confirm_refused")).map((r) => r.after)).toEqual([{ reason: "rate_limited", limit: "second_step" }]);
    const all = await allAudit();
    expect(all).not.toContain(wrongAppCode(secret, now));
    expect(all).not.toContain(appCode(secret, now));
  });

  it("a right code gives its place back, and a value no field could send is refused uncounted", async () => {
    const a = await provedParent();
    const now = new Date();
    const { secret } = await started(a.identity, now);
    for (const v of [undefined, null, 123456, {}, [], "1".repeat(21)]) {
      expect(await confirmMyAuthenticator(ctxOf(a.identity), v, now)).toEqual({ ok: false, errors: [COPY.appSetupWrong] });
    }
    expect(await placesOf(a.identity.parentId)).toBe(0);
    expect(await confirmMyAuthenticator(ctxOf(a.identity), appCode(secret, now), now)).toMatchObject({ ok: true });
    expect(await placesOf(a.identity.parentId)).toBe(0);
  });

  it("refuses a set-up past its life, and confirms nothing", async () => {
    const a = await provedParent();
    const now = new Date();
    const { secret } = await started(a.identity, now);
    await db.update(parentAuthenticator).set({ createdAt: new Date(now.getTime() - 31 * 60_000) }).where(eq(parentAuthenticator.parentId, a.identity.parentId));
    expect(await confirmMyAuthenticator(ctxOf(a.identity), appCode(secret, now), now)).toEqual({ ok: false, errors: [COPY.appSetupGone] });
    expect((await authenticatorRows(a.identity.parentId))[0]!.confirmedAt).toBeNull();
    expect(await backupCodeRows(a.identity.parentId)).toEqual([]);
    expect((await audits("parent.authenticator.confirm_wrong")).map((r) => (r.after as { reason: string }).reason)).toEqual(["no_setup"]);
  });

  it("two confirms at once make one app and ten backup codes", async () => {
    const a = await provedParent();
    const now = new Date();
    const { secret } = await started(a.identity, now);
    const code = appCode(secret, now);
    const both = await Promise.all([confirmMyAuthenticator(ctxOf(a.identity), code, now), confirmMyAuthenticator(ctxOf(a.identity), code, now)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.filter((r) => !r.ok)).toEqual([{ ok: false, errors: [COPY.appSetupGone] }]);
    expect(await authenticatorRows(a.identity.parentId)).toHaveLength(1);
    expect(await backupCodeRows(a.identity.parentId)).toHaveLength(10);
    expect(await audits("parent.authenticator.on")).toHaveLength(1);
  });

  it("is refused while an app is in force, under Strict and with no password, changing nothing", async () => {
    const a = await provedParent();
    const app = await seedAuthenticator(a.identity.parentId);
    expect(await startMyAuthenticator(ctxOf(a.identity))).toEqual({ ok: false, errors: [COPY.appAlreadyOn] });
    expect((await authenticatorRows(a.identity.parentId)).map((r) => r.id)).toEqual([app.id]);
    // A session that proved itself (as one from before passwords can't, but stamped here by hand) with no password: refused.
    const second = await seedParentIn({ familyQboId: FAMILY_A.family.qboId, name: "Sigrid Secondguardian", email: "sigrid.second@family-a.example" });
    await db.update(parentAuthSession).set({ strongAt: new Date() }).where(eq(parentAuthSession.id, second.identity.sessionId));
    expect(await startMyAuthenticator(ctxOf(second.identity))).toEqual({ ok: false, errors: [COPY.appNeedsPassword] });
    expect(await authenticatorRows(second.identity.parentId)).toEqual([]);
    const b = await seedSignedInParent(FAMILY_B);
    await proveRecently(b.identity);
    await seedParentSettings({ level: "strict" });
    expect(await startMyAuthenticator(ctxOf(b.identity))).toEqual({ ok: false, errors: [COPY.appStrictOff] });
    expect(await authenticatorRows(b.identity.parentId)).toEqual([]);
    expect(await audits("parent.authenticator.setup_started")).toEqual([]);
  });
});

describe("new backup codes", () => {
  it("replace the old ones; a sign-in that spent an old one just before is refused at its last check", async () => {
    const a = await provedParent();
    await seedAuthenticator(a.identity.parentId);
    const old = await seedBackupCodes(a.identity.parentId, 3);
    const step = await stepOf(a.identity);
    const spent = await verifySecondFactor(step, old[0]!, IP);
    if (!spent.ok) throw new Error("the old code should be taken");
    expect(await signinStands(a.identity.parentId, a.identity.email, IP, { password: step.password, ...spent.proof })).toBe(true);

    asParent(a.identity);
    const r = await newBackupCodesAction();
    if (!r.ok) throw new Error("new codes should be made");
    expect(r.message).toBe(COPY.newCodesMade);
    expect(r.codes).toHaveLength(10);
    expect(await backupCodeRows(a.identity.parentId)).toHaveLength(10);
    expect((await audits("parent.backup_codes.make")).map((x) => [x.targetId, x.after])).toEqual([[a.identity.parentId, { made: 10, replaced: 3 }]]);
    // The sign-in that spent the old code, whose session is made after the press, is refused.
    expect(await signinStands(a.identity.parentId, a.identity.email, IP, { password: step.password, ...spent.proof })).toBe(false);
    expect((await audits("signin.refused")).map((x) => x.after)).toContainEqual({ reason: "backup_code_gone" });
    // An old code no longer works; a new one does.
    expect(await verifySecondFactor(step, old[1]!, IP)).toEqual({ ok: false, reason: "rejected", ended: false });
    expect(await verifySecondFactor(step, r.codes[0]!, IP)).toMatchObject({ ok: true, factor: "backup_code" });
    for (const v of [...r.codes, ...old]) expect(await allAudit()).not.toContain(v);
  });

  it("are made under Strict too, and refused with no app in force", async () => {
    const a = await provedParent();
    expect(await remakeMyBackupCodes(ctxOf(a.identity))).toEqual({ ok: false, errors: [COPY.appNotOn] });
    await seedAuthenticator(a.identity.parentId, { confirmed: false });
    expect(await remakeMyBackupCodes(ctxOf(a.identity))).toEqual({ ok: false, errors: [COPY.appNotOn] });
    expect(await backupCodeRows(a.identity.parentId)).toEqual([]);
    await db.update(parentAuthenticator).set({ confirmedAt: new Date() }).where(eq(parentAuthenticator.parentId, a.identity.parentId));
    await seedParentSettings({ level: "strict" });
    expect(await remakeMyBackupCodes(ctxOf(a.identity))).toMatchObject({ ok: true, message: COPY.newCodesMade });
    expect(await backupCodeRows(a.identity.parentId)).toHaveLength(10);
  });
});

describe("turning it off", () => {
  it("under Standard removes the app and the codes; the door asks for the emailed code again; a sign-in that took the app's code just before is refused", async () => {
    const a = await provedParent();
    const app = await seedAuthenticator(a.identity.parentId);
    await seedBackupCodes(a.identity.parentId, 4);
    await seedDevice(a.identity.parentId);
    const devicesBefore = await devicesOf(a.identity.parentId);
    const strongBefore = await strongAtOf(a.identity.sessionId);
    const step = await stepOf(a.identity);
    const now = new Date();
    const took = await verifySecondFactor(step, appCode(app.secret, now), IP, now);
    if (!took.ok) throw new Error("the app's code should be taken");
    expect(await signinStands(a.identity.parentId, a.identity.email, IP, { password: step.password, ...took.proof })).toBe(true);

    asParent(a.identity);
    expect(await turnOffAuthenticatorAction()).toEqual({ ok: true, message: COPY.turnedOff });
    expect(await authenticatorRows(a.identity.parentId)).toEqual([]);
    expect(await backupCodeRows(a.identity.parentId)).toEqual([]);
    expect((await audits("parent.authenticator.off")).map((x) => [x.targetType, x.targetId, x.after])).toEqual([["parent", a.identity.parentId, { backupCodesDeleted: 4 }]]);
    expect(await signinStands(a.identity.parentId, a.identity.email, IP, { password: step.password, ...took.proof })).toBe(false);
    expect((await audits("signin.refused")).map((x) => x.after)).toContainEqual({ reason: "second_factor_gone" });
    // Devices stay remembered, this session goes on with its proof, and the door asks for the emailed code again.
    expect(await devicesOf(a.identity.parentId)).toEqual(devicesBefore);
    expect(await sessionsOf(a.identity.parentId)).toHaveLength(1);
    expect(await strongAtOf(a.identity.sessionId)).toEqual(strongBefore);
    const check = await checkPasswordSignin(a.identity.email, PROVEN_PASSWORD, null, IP);
    expect(check.ok && check.step).toBe("emailed_code");
    // Once off, a second press is refused in words.
    expect(await turnOffAuthenticatorAction()).toEqual({ ok: false, errors: [COPY.appNotOn] });
  });

  it("under Strict is refused, and nothing changes", async () => {
    const a = await provedParent();
    await seedAuthenticator(a.identity.parentId);
    await seedBackupCodes(a.identity.parentId, 2);
    await seedParentSettings({ level: "strict" });
    const before = { app: await authenticatorRows(a.identity.parentId), codes: await backupCodeRows(a.identity.parentId) };
    expect(await turnOffMyAuthenticator(ctxOf(a.identity))).toEqual({ ok: false, errors: [COPY.turnOffStrict] });
    expect({ app: await authenticatorRows(a.identity.parentId), codes: await backupCodeRows(a.identity.parentId) }).toEqual(before);
    expect(await audits("parent.authenticator.off")).toEqual([]);
  });
});

describe("no press touches a session, a device or strong_at", () => {
  it("setting up, confirming, new codes and turning off leave every session, device and proof as they were", async () => {
    const a = await provedParent();
    await seedParentSession(await authUserOf(a.identity.parentId), { familyQboId: FAMILY_A.family.qboId });
    await seedDevice(a.identity.parentId);
    const before = { sessions: await sessionsOf(a.identity.parentId), devices: await devicesOf(a.identity.parentId), strongAt: await strongAtOf(a.identity.sessionId) };
    const now = new Date();
    const { secret } = await started(a.identity, now);
    expect(await confirmMyAuthenticator(ctxOf(a.identity), appCode(secret, now), now)).toMatchObject({ ok: true });
    expect(await remakeMyBackupCodes(ctxOf(a.identity), now)).toMatchObject({ ok: true });
    expect(await turnOffMyAuthenticator(ctxOf(a.identity), now)).toMatchObject({ ok: true });
    expect({ sessions: await sessionsOf(a.identity.parentId), devices: await devicesOf(a.identity.parentId), strongAt: await strongAtOf(a.identity.sessionId) }).toEqual(before);
    expect(await audits("signin")).toEqual([]);
    expect(await audits("parent.sessions.end_all")).toEqual([]);
  });

  it("the presses share the settings' limit: past ten an hour they are refused in words", async () => {
    const a = await provedParent();
    for (let i = 0; i < 10; i++) expect(await takeRateLimit("signin_settings_parent", a.identity.parentId)).toBe("taken");
    const TOO_MANY = { ok: false, errors: [COPY.tooManyPresses] };
    expect(await startMyAuthenticator(ctxOf(a.identity))).toEqual(TOO_MANY);
    expect(await remakeMyBackupCodes(ctxOf(a.identity))).toEqual(TOO_MANY);
    expect(await turnOffMyAuthenticator(ctxOf(a.identity))).toEqual(TOO_MANY);
    expect(await authenticatorRows(a.identity.parentId)).toEqual([]);
  });
});

describe("one parent never reaches another's app", () => {
  for (const arrangement of [{ b: "unfinished", second: "in_force" }, { b: "in_force", second: "unfinished" }] as const) {
    it(`as family A's parent, with family B's parent's app ${arrangement.b} and a second guardian of family A's ${arrangement.second}: nothing of theirs is confirmed, replaced, shown or removed`, async () => {
      const a = await provedParent();
      const b = await seedSignedInParent(FAMILY_B);
      const second = await seedParentIn({ familyQboId: FAMILY_A.family.qboId, name: "Sigrid Secondguardian", email: "sigrid.second@family-a.example" });
      for (const p of [b, second]) await proveRecently(p.identity);
      const now = new Date();
      const theirApps = {
        b: await seedAuthenticator(b.identity.parentId, { confirmed: arrangement.b === "in_force", createdAt: now }),
        second: await seedAuthenticator(second.identity.parentId, { confirmed: arrangement.second === "in_force", createdAt: now }),
      };
      const theirCodes = { b: await seedBackupCodes(b.identity.parentId, 2), second: await seedBackupCodes(second.identity.parentId, 2) };
      const theirs = async () => Promise.all([b.identity, second.identity].map(async (i) => ({
        app: await authenticatorRows(i.parentId), codes: await backupCodeRows(i.parentId), sessions: await sessionsOf(i.parentId), strongAt: await strongAtOf(i.sessionId),
      })));
      const before = await theirs();

      asParent(a.identity);
      // Their codes, and values of the wrong type and size, at A's confirm: A has no set-up, so nothing is confirmed.
      for (const v of [appCode(theirApps.b.secret, now), appCode(theirApps.second.secret, now), theirCodes.b[0]!, theirCodes.second[0]!]) {
        const r = await confirmAuthenticatorAction(v);
        expect(r.ok, v).toBe(false);
      }
      const odd = [undefined, null, 123456, {}, [], "x".repeat(5000), b.identity.parentId, theirApps.b.id, theirApps.second.id] as unknown as string[];
      for (const v of odd) expect(await confirmAuthenticatorAction(v), String(v)).toEqual({ ok: false, errors: [COPY.appSetupWrong] });
      // The presses take no id: one sent is never read, and what they act on is A's own (A has no app to replace or remove).
      const withArg = <T,>(action: () => Promise<T>) => action as unknown as (x: unknown) => Promise<T>;
      for (const v of [b.identity.parentId, theirApps.b.id, theirApps.second.id, second.identity.sessionId]) {
        expect(await withArg(newBackupCodesAction)(v)).toEqual({ ok: false, errors: [COPY.appNotOn] });
        expect(await withArg(turnOffAuthenticatorAction)(v)).toEqual({ ok: false, errors: [COPY.appNotOn] });
      }
      const mine = await withArg(startAuthenticatorAction)(theirApps.b.id);
      if (!mine.ok) throw new Error("A's own set-up should begin");
      // A's set-up is A's alone: a new secret, on A's own row.
      expect([theirApps.b.secret, theirApps.second.secret]).not.toContain(mine.key.replace(/ /g, ""));
      expect(await authenticatorRows(a.identity.parentId)).toHaveLength(1);

      expect(await theirs()).toEqual(before);
      const page = await renderPage(SignInSettingsPage);
      for (const v of [theirApps.b.secret, theirApps.second.secret, theirApps.b.id, theirApps.second.id, ...theirCodes.b, ...theirCodes.second]) expect(page).not.toContain(v);
      expect(await audits("parent.authenticator.on")).toEqual([]);
      expect(await audits("parent.backup_codes.make")).toEqual([]);
      expect(await audits("parent.authenticator.off")).toEqual([]);
    });
  }
});
