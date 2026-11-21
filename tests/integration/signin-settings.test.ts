import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { asParent, fromIp, renderPage } from "../helpers/signed-in";

type Msg = { to: string; subject: string; text: string; html: string };
const outbox = vi.hoisted(() => [] as Msg[]);
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => { outbox.push(m); } }));
// The breach service is a stub listening on port 0, as in password-links.test.ts.
const where = vi.hoisted(() => ({ range: "" }));
vi.mock("@/lib/parents/breach-endpoints", () => ({ breachEndpoints: () => ({ range: where.range }) }));
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

import { and, eq, sql } from "drizzle-orm";
import { verifyPassword } from "better-auth/crypto";
import { db } from "@/lib/db/client";
import { auditLog, parent, parentAuthAccount, parentAuthenticator, parentAuthPasskey, parentAuthSession, parentAuthUser, parentDevice, parentEmailChange, parentSigninToken, rateLimitEvent, signinCode } from "@/lib/db/schema";
import type { ParentIdentity } from "@/lib/auth/resolve";
import { askAgainCode, currentPassword, sessionProvedRecently } from "@/lib/parents/asking-again";
import { removeAuthenticator } from "@/lib/parents/authenticator";
import { recordStrongSignin } from "@/lib/parents/devices";
import { checkPasswordSignin, hashTriedAddress } from "@/lib/parents/password-signin";
import { PASSWORD_COPY } from "@/lib/parents/password-copy";
import { takeRateLimit } from "@/lib/parents/rate-limit";
import { changeMyPassword } from "@/lib/parents/signin-settings";
import { confirmMyAuthenticator, remakeMyBackupCodes, startMyAuthenticator, turnOffMyAuthenticator } from "@/lib/parents/authenticator-settings";
import { renewParentSession } from "@/lib/parents/sessions";
import { SIGNIN_SETTINGS_COPY as COPY, SIGNIN_WITH_APP_COPY as WITH_APP, howYouSignIn } from "@/lib/parents/signin-settings-copy";
import { CODE_TTL_MS, signinStands } from "@/lib/parents/signin-codes";
import SignInSettingsPage from "@/app/(parent)/family/sign-in/page";
import FamilyPage from "@/app/(parent)/family/page";
import { utcFallback } from "@/app/components/utc-fallback";
import { askAgainCodeAction, askAgainPasswordAction, askSetupLinkAction, changePasswordAction, forgetDeviceAction, forgetOtherDevicesAction, signOutEverywhereAction } from "@/app/(parent)/family/sign-in/actions";
import { resetDb, seedParentSession, seedWorkingMail } from "../helpers/db";
import { FAMILY_A, FAMILY_B, PROVEN_PASSWORD, identityNow, proveRecently, seedParentIn, seedSignedInParent, type SeededParent } from "../helpers/parent";
import { seedParentSettings } from "../helpers/roster-cache";
import { codeMailed } from "../helpers/parent-door";
import { seedEmailChange } from "../helpers/email-change";
import { linkRows, mintLink, seedCode, seedDevice, seedPassword } from "../helpers/signin-links";
import { appCode, authenticatorRows, backupCodeRows, seedAuthenticator, seedBackupCodes, wrongAppCode } from "../helpers/authenticator";
import { seedPasskey } from "../helpers/passkey";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CodesSaved } from "@/app/(parent)/family/sign-in/passkey-add";
import { ENROLMENT_COPY } from "@/lib/parents/enrolment-copy";

/**
 * A parent's sign-in settings (/family/sign-in; the sign-in release, slice SI-5a): the page, asking again (the door's
 * password check, then its emailed code, with a stamp between them that names no id), changing the password, signing
 * out everywhere and the set-up link offered to a person with no password; since slice SI-5b the remembered devices
 * listed, forgotten one at a time or all but this one, and asking again counted against the session's own device.
 * Every action is called as the signed-in parent; whose password, sessions, code and devices are the session's own.
 */
const sha1 = (s: string) => createHash("sha1").update(s, "utf8").digest("hex").toUpperCase();
const NEW_PASSWORD = "a brand new phrase for the portal, long enough";
const BREACHED = "password-from-a-breach-1234";
let breachDown = false;
let server: Server;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (breachDown) { res.writeHead(503).end(); return; }
    const prefix = (req.url ?? "").split("/").pop()!;
    const seen = sha1(BREACHED);
    const lines = [`${"0".repeat(35)}:0`, ...(seen.startsWith(prefix) ? [`${seen.slice(5)}:42`] : [])];
    res.writeHead(200, { "content-type": "text/plain" }).end(lines.join("\r\n"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  where.range = `http://127.0.0.1:${(server.address() as AddressInfo).port}/range/`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

const IP = "203.0.113.71";
beforeEach(async () => { await resetDb(); outbox.length = 0; breachDown = false; appHook.seed = null; await seedWorkingMail(); fromIp(IP); });

/** React writes an apostrophe in text as &#x27;. */
const html = (words: string) => words.replace(/'/g, "&#x27;");
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const authUserOf = async (parentId: string) => (await db.select({ id: parentAuthUser.id }).from(parentAuthUser).where(eq(parentAuthUser.parentId, parentId)))[0]!.id;
const sessionsOf = (parentId: string) => db.select({ id: parentAuthSession.id, strongAt: parentAuthSession.strongAt }).from(parentAuthSession)
  .innerJoin(parentAuthUser, eq(parentAuthUser.id, parentAuthSession.userId)).where(eq(parentAuthUser.parentId, parentId));
// Read through sql<Date>: drizzle's inferred type of this column of the Better Auth tables comes out as never (schema.ts).
const strongAtOf = async (sessionId: string): Promise<Date | null> => (await db.select({ strongAt: sql<Date | null>`${parentAuthSession.strongAt}`.mapWith(parentAuthSession.strongAt) })
  .from(parentAuthSession).where(eq(parentAuthSession.id, sessionId)))[0]?.strongAt ?? null;
const credentialOf = async (parentId: string) => (await db.select().from(parentAuthAccount)
  .where(and(eq(parentAuthAccount.userId, await authUserOf(parentId)), eq(parentAuthAccount.providerId, "credential"))))[0];
const devicesOf = (parentId: string) => db.select().from(parentDevice).where(eq(parentDevice.parentId, parentId));
const codesOf = (parentId: string) => db.select().from(signinCode).where(eq(signinCode.parentId, parentId));
const emailChangesOf = (parentId: string) => db.select().from(parentEmailChange).where(eq(parentEmailChange.parentId, parentId));
const allSessions = () => db.select({ id: parentAuthSession.id }).from(parentAuthSession);
const ctxOf = (identity: ParentIdentity) => ({ ...identity, ip: IP });
const DAY = 86_400_000;
/** The device a session was made on (`device_id`, slice SI-5b), as a sign-in's strong step writes it. */
const nameDevice = (sessionId: string, deviceId: string | null) => db.update(parentAuthSession).set({ deviceId }).where(eq(parentAuthSession.id, sessionId));
const deviceIdOf = async (sessionId: string) => (await db.select({ deviceId: parentAuthSession.deviceId }).from(parentAuthSession).where(eq(parentAuthSession.id, sessionId)))[0]?.deviceId;

/** The parent with a password chosen a minute ago, and no proof on their session (as a session from before SI-3b). */
async function withPassword(seeded: { identity: ParentIdentity }): Promise<void> {
  await seedPassword(await authUserOf(seeded.identity.parentId), PROVEN_PASSWORD, new Date(Date.now() - 60_000));
}
/** The first step, as the page sends it, and the code it mailed. */
async function passwordThenCode(identity: ParentIdentity): Promise<{ stamp: string; code: string }> {
  asParent(identity);
  const since = outbox.length;
  const first = await askAgainPasswordAction(PROVEN_PASSWORD);
  expect(first).toEqual({ ok: true, message: COPY.codeSent, stamp: expect.stringMatching(/^\d{13}\.[A-Za-z0-9_-]{43}$/), step: "code" });
  if (!first.ok) throw new Error("unreachable");
  return { stamp: first.stamp, code: await codeMailed(outbox, identity.email, since) };
}

describe("the page", () => {
  it("is linked from the Family page's Your account box", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    asParent(a.identity);
    expect(await renderPage(FamilyPage)).toContain(`<a class="btn btn-line" href="/family/sign-in">Sign-in settings</a>`);
  });

  it("with a password and a proof just now: the change form, and nothing of the session, the person or the password", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await proveRecently(a.identity);
    asParent(a.identity);
    const page = await renderPage(SignInSettingsPage);
    expect(page).toContain(COPY.title);
    expect(page).toContain(FAMILY_A.parent.email);
    expect(page).toContain(COPY.passwordChosen);
    expect(page.match(/autocomplete="new-password"/gi)).toHaveLength(2);
    expect(page).not.toMatch(/autocomplete="current-password"/i);
    expect(page).toContain(html(COPY.signsOutEverywhere));
    expect(page).toContain(COPY.everywhereButton);
    // No device remembered for this parent: the list says so, and what it means at the next sign-in.
    expect(page).toContain(html(COPY.devicesNone));
    // The authenticator app box (slice SI-6b), off, with its set-up press: this session proved itself just now.
    expect(page).toContain(COPY.appTitle);
    expect(page).toContain(COPY.appSetUp);
    const credential = await credentialOf(a.identity.parentId);
    for (const secret of [a.identity.sessionId, a.session.token, a.identity.parentId, a.identity.guardianId, credential!.id, credential!.password!]) expect(page).not.toContain(secret);
  });

  it("with a password and no recent proof, a proof 11 minutes old, or one stamped ahead of the clock: the asking again", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    asParent(a.identity);
    for (const strongAt of [null, new Date(Date.now() - 11 * 60_000), new Date(Date.now() + 60_000)]) {
      await db.update(parentAuthSession).set({ strongAt }).where(eq(parentAuthSession.id, a.identity.sessionId));
      const page = await renderPage(SignInSettingsPage);
      expect(page, String(strongAt)).toContain(html(COPY.askAgainForPassword));
      expect(page).toMatch(/autocomplete="current-password"/i);
      // The address a password manager files the password under, as the page already shows it.
      expect(page).toMatch(/autocomplete="username"/i);
      expect(page).not.toMatch(/autocomplete="new-password"/i);
      expect(page).toContain(COPY.everywhereButton);
    }
  });

  it("with no password: the offer of a link to choose one, and no password field", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    asParent(a.identity);
    const page = await renderPage(SignInSettingsPage);
    expect(page).toContain(COPY.passwordNotChosen);
    expect(page).toContain(html(COPY.noPassword));
    expect(page).toContain(COPY.setupButton);
    expect(page).not.toContain(`type="password"`);
    expect(page).toContain(COPY.everywhereButton);
    // Nothing tells them they sign in with a password they don't have: how they sign in again says to choose one first.
    expect(page).toContain(html(COPY.howNoPassword));
    expect(page).not.toContain(html(COPY.how));
    expect(page).toContain(html(COPY.everywhereThenNoPassword));
    expect(page).not.toContain(html(COPY.everywhereThen));
  });

  it("under Strict, proved under Strict: the password box and the email link as at Standard, with Strict's words", async () => {
    // Changed on purpose by slice SI-10b: Strict's placeholder ("can't be changed here") is gone, since the switch to
    // Strict clears every older proof, so a proof here is Strict's own.
    const a = await seedSignedInParent(FAMILY_A);
    await seedAuthenticator(a.identity.parentId);
    await proveRecently(a.identity);
    await seedParentSettings({ level: "strict" });
    asParent(a.identity);
    const page = await renderPage(SignInSettingsPage);
    expect(page).toContain(`type="password"`);
    expect(page).toContain(COPY.changeButton);
    expect(page).toContain(COPY.everywhereButton);
    expect(page).toContain(`href="/family/email"`);
    expect(page).toContain(COPY.changeEmail);
    expect(page).not.toContain("can&#x27;t be changed here");
    expect(page).toContain(html("You sign in with this address and your password, and then the code from your authenticator app or one of your backup codes, every time, on every phone or computer."));
    expect(page).not.toContain(html(WITH_APP.how));
  });
});

describe("asking again", () => {
  it("the right password, then the right code: this session's strong_at is stamped, no other's, and no session is made", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    const other = await seedParentSession(await authUserOf(a.identity.parentId), { familyQboId: FAMILY_A.family.qboId });
    const sessionsBefore = (await allSessions()).length;
    const { stamp, code } = await passwordThenCode(a.identity);
    // The stamp names nothing: no session, person or password row.
    const credential = await credentialOf(a.identity.parentId);
    for (const id of [a.identity.sessionId, a.identity.parentId, credential!.id]) expect(stamp).not.toContain(id);
    expect(await audits("signin.second_step_asked")).toHaveLength(1);
    // The code's mail says what it is for: a change asked for in a session, never a sign-in on a device it doesn't know.
    const mail = outbox.filter((m) => m.to === FAMILY_A.parent.email).at(-1)!;
    expect(mail.subject).toMatch(/sign-in code: \d{6}, to confirm a change$/);
    expect(mail.text).toContain("has asked to change how you sign in");
    expect(mail.text).toContain("http://localhost:3000/family/sign-in");
    expect(`${mail.text}${mail.html}`).not.toMatch(/device/i);

    const before = Date.now();
    expect(await askAgainCodeAction(stamp, code)).toEqual({ ok: true, message: COPY.proved });
    expect((await strongAtOf(a.identity.sessionId))!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await strongAtOf(other.id)).toBeNull();
    expect((await allSessions()).length).toBe(sessionsBefore);
    const proved = await audits("signin.proved_again");
    expect(proved.map((r) => [r.targetType, r.targetId, r.after])).toEqual([["parent", a.identity.parentId, { step: "emailed_code" }]]);
    expect(JSON.stringify(proved)).not.toContain(code);
    expect(JSON.stringify(proved)).not.toContain(stamp);
    // The page is drawn again with the change form.
    expect(await renderPage(SignInSettingsPage)).toMatch(/autocomplete="new-password"/i);
  });

  it("for a parent with an authenticator app (slice SI-6a): no code is sent, and the app's code or a backup code proves this session alone", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    const app = await seedAuthenticator(a.identity.parentId);
    const [backup] = await seedBackupCodes(a.identity.parentId, 1);
    const other = await seedParentSession(await authUserOf(a.identity.parentId), { familyQboId: FAMILY_A.family.qboId });
    asParent(a.identity);
    const first = await askAgainPasswordAction(PROVEN_PASSWORD);
    expect(first).toEqual({ ok: true, message: COPY.appAsked, stamp: expect.stringMatching(/^\d{13}\.[A-Za-z0-9_-]{43}$/), step: "app" });
    if (!first.ok) throw new Error("unreachable");
    expect(await codesOf(a.identity.parentId)).toEqual([]);
    expect(await audits("signin.code_refused")).toEqual([]);
    expect((await audits("signin.second_step_asked")).map((r) => r.after)).toEqual([{ step: "second_factor" }]);
    // A wrong code is the app's one refusal, and stamps nothing.
    expect(await askAgainCodeAction(first.stamp, wrongAppCode(app.secret))).toEqual({ ok: false, errors: [COPY.appRejected] });
    expect(await strongAtOf(a.identity.sessionId)).toBeNull();
    const before = Date.now();
    expect(await askAgainCodeAction(first.stamp, appCode(app.secret))).toEqual({ ok: true, message: COPY.proved });
    expect((await strongAtOf(a.identity.sessionId))!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(await strongAtOf(other.id)).toBeNull();
    // Again, once the proof is gone, with a backup code in place of the app.
    await db.update(parentAuthSession).set({ strongAt: null }).where(eq(parentAuthSession.id, a.identity.sessionId));
    const second = await askAgainPasswordAction(PROVEN_PASSWORD);
    if (!second.ok) throw new Error("unreachable");
    expect(await askAgainCodeAction(second.stamp, backup!)).toEqual({ ok: true, message: COPY.proved });
    expect(await strongAtOf(other.id)).toBeNull();
    expect((await backupCodeRows(a.identity.parentId))[0]!.usedAt).not.toBeNull();
    const proved = await audits("signin.proved_again");
    expect(proved.map((r) => [r.targetId, r.after])).toEqual([[a.identity.parentId, { step: "authenticator" }], [a.identity.parentId, { step: "backup_code" }]]);
    for (const secret of [app.secret, backup!, first.stamp, second.stamp]) expect(JSON.stringify(await db.select().from(auditLog))).not.toContain(secret);
    // Nothing was mailed to them: an app holder is never sent the emailed code.
    await new Promise((r) => setImmediate(r));
    expect(outbox.filter((m) => m.to === FAMILY_A.parent.email)).toEqual([]);
  });

  it("an app holder's late, forged or over-long try reads the app's words, never an email's; with no app, the emailed code's", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    const app = await seedAuthenticator(a.identity.parentId);
    asParent(a.identity);
    const first = await askAgainPasswordAction(PROVEN_PASSWORD);
    if (!first.ok) throw new Error("unreachable");
    const late = new Date(Date.now() + CODE_TTL_MS + 60_000);
    const forged = `${Date.now() + 60_000}.${"A".repeat(43)}`;
    const tries = (code: string) => [
      // The step's 10 minutes are over.
      () => askAgainCode(ctxOf(a.identity), first.stamp, code, late),
      // A stamp of the right shape that this session never got.
      () => askAgainCode(ctxOf(a.identity), forged, code),
      // More than the field can hold.
      () => askAgainCode(ctxOf(a.identity), first.stamp, "1".repeat(21)),
    ];
    for (const t of tries(appCode(app.secret, late))) {
      const answer = await t();
      expect(answer).toEqual({ ok: false, errors: [COPY.appRejected] });
      expect(JSON.stringify(answer)).not.toMatch(/email/i);
    }
    expect(await strongAtOf(a.identity.sessionId)).toBeNull();
    // With no app in force, the same tries read the emailed code's words, as before.
    await db.delete(parentAuthenticator).where(eq(parentAuthenticator.parentId, a.identity.parentId));
    for (const t of tries("123456")) expect(await t()).toEqual({ ok: false, errors: [COPY.codeRejected] });
    expect(await strongAtOf(a.identity.sessionId)).toBeNull();
  });

  it("an app that comes into force after the password's reads: nothing is sent, the app is asked for, and its code proves the session", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    let secret = "";
    // The password check's own read (the first) and the send's read before its lock (the second) answer no app; the
    // app is seeded then, and the send's read under the lock sees it.
    Object.assign(appHook, { parentId: a.identity.parentId, after: 2, seed: async () => { secret = (await seedAuthenticator(a.identity.parentId)).secret; } });
    asParent(a.identity);
    const first = await askAgainPasswordAction(PROVEN_PASSWORD);
    expect(appHook.seed).toBeNull();
    expect(first).toEqual({ ok: true, message: COPY.appAsked, stamp: expect.stringMatching(/^\d{13}\.[A-Za-z0-9_-]{43}$/), step: "app" });
    if (!first.ok) throw new Error("unreachable");
    expect(await codesOf(a.identity.parentId)).toEqual([]);
    expect((await audits("signin.code_refused")).map((r) => r.after)).toEqual([{ reason: "has_second_factor" }]);
    await new Promise((r) => setImmediate(r));
    expect(outbox.filter((m) => m.to === FAMILY_A.parent.email)).toEqual([]);
    expect(await askAgainCodeAction(first.stamp, appCode(secret))).toEqual({ ok: true, message: COPY.proved });
    expect((await audits("signin.proved_again")).map((r) => r.after)).toEqual([{ step: "authenticator" }]);
  });

  const counted = (kind: "password_reask_parent" | "password_try_email" | "password_try_device", subject: string) =>
    db.select().from(rateLimitEvent).where(and(eq(rateLimitEvent.kind, kind), eq(rateLimitEvent.subject, subject)));

  it("five wrong passwords stop asking again, counted against the person and not the address: the door still lets them in", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    asParent(a.identity);
    for (let i = 0; i < 5; i++) expect(await askAgainPasswordAction("not the password at all")).toEqual({ ok: false, errors: [COPY.passwordRejected] });
    // The sixth, right or not, is refused in the over-limit words before the password is read.
    expect(await askAgainPasswordAction(PROVEN_PASSWORD)).toEqual({ ok: false, errors: [COPY.tooManyTries] });
    expect(await counted("password_reask_parent", a.identity.parentId)).toHaveLength(5);
    expect(await counted("password_try_email", hashTriedAddress(FAMILY_A.parent.email))).toEqual([]);
    expect(await audits("signin.password_wrong")).toHaveLength(5);
    expect(outbox).toEqual([]);
    expect(await strongAtOf(a.identity.sessionId)).toBeNull();
    // A thief holding only the session can't fill the door's count from here: the right password at the door, for the
    // address and with no device (as /sign-in checks it), still goes on to its code.
    expect(await checkPasswordSignin(FAMILY_A.parent.email, PROVEN_PASSWORD, null, IP)).toMatchObject({ ok: true, person: { id: a.identity.parentId } });
  });

  it("a wrong password is counted against the device this session was made on, and with none (expired, or forgotten) against the person", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    const device = await seedDevice(a.identity.parentId);
    await nameDevice(a.identity.sessionId, device.id);
    asParent(a.identity);
    const PASSWORD_NO = { ok: false, errors: [COPY.passwordRejected] };
    expect(await askAgainPasswordAction("not the password at all")).toEqual(PASSWORD_NO);
    expect(await counted("password_try_device", device.id)).toHaveLength(1);
    expect(await counted("password_reask_parent", a.identity.parentId)).toEqual([]);
    // Its device expired: the person's count, as before the session named one.
    await db.update(parentDevice).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(parentDevice.id, device.id));
    expect(await askAgainPasswordAction("not the password at all")).toEqual(PASSWORD_NO);
    expect(await counted("password_try_device", device.id)).toHaveLength(1);
    expect(await counted("password_reask_parent", a.identity.parentId)).toHaveLength(1);
    // Forgotten: the session names none now, and the person's count it is.
    await db.delete(parentDevice).where(eq(parentDevice.id, device.id));
    expect(await deviceIdOf(a.identity.sessionId)).toBeNull();
    expect(await askAgainPasswordAction("not the password at all")).toEqual(PASSWORD_NO);
    expect(await counted("password_reask_parent", a.identity.parentId)).toHaveLength(2);
    // Never the address's count.
    expect(await counted("password_try_email", hashTriedAddress(FAMILY_A.parent.email))).toEqual([]);
  });

  it("five wrong passwords at the door for the address don't stop the parent proving it's them here", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    // A stranger who knows only the address keeps the door's count for it full.
    for (let i = 0; i < 5; i++) expect(await checkPasswordSignin(FAMILY_A.parent.email, "a stranger's guess", null, IP)).toEqual({ ok: false, limited: false });
    expect(await checkPasswordSignin(FAMILY_A.parent.email, PROVEN_PASSWORD, null, IP)).toEqual({ ok: false, limited: true });
    expect(await counted("password_try_email", hashTriedAddress(FAMILY_A.parent.email))).toHaveLength(5);
    // The parent, signed in, proves it's them all the same, and the right password gives its place back.
    const { stamp, code } = await passwordThenCode(a.identity);
    expect(await askAgainCodeAction(stamp, code)).toEqual({ ok: true, message: COPY.proved });
    expect(await counted("password_reask_parent", a.identity.parentId)).toEqual([]);
  });

  // A block and a change of address are seen by the door's own checks of the code (verifySigninCode(), signinStands())
  // before the lock is taken, and again under it by askAgainCode(); a session ended since is seen only there.
  it.each(["blocked", "moved", "session_ended"] as const)("refuses a code once the person is %s since the password, stamping nothing", async (stop) => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    const { stamp, code } = await passwordThenCode(a.identity);
    if (stop === "blocked") await db.update(parent).set({ blocked: true }).where(eq(parent.id, a.identity.parentId));
    if (stop === "moved") await db.update(parent).set({ email: "somewhere.else@family-a.example" }).where(eq(parent.id, a.identity.parentId));
    if (stop === "session_ended") await db.delete(parentAuthSession).where(eq(parentAuthSession.id, a.identity.sessionId));
    expect(await askAgainCode(ctxOf(a.identity), stamp, code)).toEqual({ ok: false, errors: [COPY.codeRejected] });
    expect(await strongAtOf(a.identity.sessionId)).toBeNull();
    expect(await audits("signin.proved_again")).toEqual([]);
  });

  it("a code with a stamp of another session, of another person, from before the password changed, or past its end is refused, and stamps nothing", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const b = await seedSignedInParent(FAMILY_B);
    await withPassword(a); await withPassword(b);
    const second = await identityNow((await seedParentSession(await authUserOf(a.identity.parentId), { familyQboId: FAMILY_A.family.qboId })).id);
    const mine = await passwordThenCode(a.identity);
    const theirs = await passwordThenCode(b.identity);

    // Another session of the same person, and another person, with a stamp that is not theirs.
    asParent(second);
    expect(await askAgainCodeAction(mine.stamp, mine.code)).toEqual({ ok: false, errors: [COPY.codeRejected] });
    asParent(a.identity);
    expect(await askAgainCodeAction(theirs.stamp, theirs.code)).toEqual({ ok: false, errors: [COPY.codeRejected] });
    expect(await askAgainCodeAction(theirs.stamp, mine.code)).toEqual({ ok: false, errors: [COPY.codeRejected] });
    // Past its end (as read CODE_TTL_MS and a moment later).
    expect(await askAgainCode(ctxOf(a.identity), mine.stamp, mine.code, new Date(Date.now() + CODE_TTL_MS + 1000))).toEqual({ ok: false, errors: [COPY.codeRejected] });
    // A stamp is no stamp once the password it was made for has been replaced.
    const [credential] = await db.select({ id: parentAuthAccount.id }).from(parentAuthAccount).where(eq(parentAuthAccount.userId, await authUserOf(a.identity.parentId)));
    await db.update(parentAuthAccount).set({ updatedAt: new Date() }).where(eq(parentAuthAccount.id, credential!.id));
    expect(await askAgainCodeAction(mine.stamp, mine.code)).toEqual({ ok: false, errors: [COPY.codeRejected] });

    for (const s of [a.identity.sessionId, second.sessionId, b.identity.sessionId]) expect(await strongAtOf(s)).toBeNull();
    // None of those refusals reached a code: each person's code is unused and untried.
    for (const p of [a.identity.parentId, b.identity.parentId]) expect((await codesOf(p)).map((c) => [c.usedAt, c.tries])).toEqual([[null, 0]]);
    expect(await audits("signin.proved_again")).toEqual([]);
  });
});

describe("changing the password", () => {
  it("is refused without a recent proof, changing nothing", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    asParent(a.identity);
    const before = await credentialOf(a.identity.parentId);
    expect(await changePasswordAction(NEW_PASSWORD, NEW_PASSWORD)).toEqual({ ok: false, errors: [COPY.proveAgain] });
    expect(await credentialOf(a.identity.parentId)).toEqual(before);
    expect(await sessionsOf(a.identity.parentId)).toHaveLength(1);
    expect(await audits("parent.password.changed")).toEqual([]);
  });

  it("a remembered device's sign-in stamps no proof: the page asks again, and the change is refused; a code's new device stamps one", async () => {
    // The strong step of a password sign-in on a remembered device (recordStrongSignin()): it renews the device, and
    // proved only the password at that moment, so it leaves the session's strong_at as it is.
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    const device = await seedDevice(a.identity.parentId);
    const strong = { parentId: a.identity.parentId, email: a.identity.email, sessionId: a.identity.sessionId, ip: IP };
    expect(await recordStrongSignin({ ...strong, device: { deviceId: device.id, token: device.token } })).toMatchObject({ ok: true });
    expect(await audits("signin.device_used")).toHaveLength(1);
    expect(await strongAtOf(a.identity.sessionId)).toBeNull();
    asParent(a.identity);
    expect(await renderPage(SignInSettingsPage)).toContain(html(COPY.askAgainForPassword));
    expect(await sessionProvedRecently(db, a.identity)).toBe(false); // what requestMyEmailChange() reads under the lock
    const before = await credentialOf(a.identity.parentId);
    expect(await changePasswordAction(NEW_PASSWORD, NEW_PASSWORD)).toEqual({ ok: false, errors: [COPY.proveAgain] });
    expect(await credentialOf(a.identity.parentId)).toEqual(before);
    expect(await audits("parent.password.changed")).toEqual([]);
    // A code's or a set-up link's sign-in remembers a new device and proved the second step itself: it stamps the session.
    const at = Date.now();
    expect(await recordStrongSignin({ ...strong, device: { remember: true } })).toMatchObject({ ok: true });
    expect((await strongAtOf(a.identity.sessionId))!.getTime()).toBeGreaterThanOrEqual(at - 1000);
    expect(await sessionProvedRecently(db, a.identity)).toBe(true);
    expect(await renderPage(SignInSettingsPage)).toMatch(/autocomplete="new-password"/i);
  });

  it("is refused under the lock when the password was replaced since the proof, the person is blocked or has no password, changing nothing", async () => {
    await seedSignedInParent(FAMILY_A); // the roster and family A, which each person below is a guardian of
    for (const stop of ["password_changed", "blocked", "no_password"] as const) {
      const seeded = await seedParentIn({ familyQboId: FAMILY_A.family.qboId, name: `Someone ${stop}`, email: `${stop.replace("_", ".")}@family-a.example` });
      await proveRecently(seeded.identity);
      const credentialId = (await credentialOf(seeded.identity.parentId))!.id;
      // Each is read only under the person's row: the window itself still holds.
      if (stop === "password_changed") await db.update(parentAuthAccount).set({ updatedAt: new Date(Date.now() + 1000) }).where(eq(parentAuthAccount.id, credentialId));
      if (stop === "blocked") await db.update(parent).set({ blocked: true }).where(eq(parent.id, seeded.identity.parentId));
      if (stop === "no_password") await db.delete(parentAuthAccount).where(eq(parentAuthAccount.id, credentialId));
      expect(await sessionProvedRecently(db, seeded.identity), stop).toBe(true);
      const before = await credentialOf(seeded.identity.parentId);
      expect(await changeMyPassword(ctxOf(seeded.identity), { password: NEW_PASSWORD, again: NEW_PASSWORD }), stop).toEqual({ ok: false, errors: [COPY.proveAgain] });
      expect(await credentialOf(seeded.identity.parentId), stop).toEqual(before);
      expect(await sessionsOf(seeded.identity.parentId), stop).toHaveLength(1);
    }
    expect(await audits("parent.password.changed")).toEqual([]);
    expect(outbox.filter((m) => m.subject.endsWith("password was changed"))).toEqual([]);
  });

  it("is limited per person, and only tries from a session that proved itself count", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    asParent(a.identity);
    // A session that hasn't proved itself can't use up the parent's changes.
    for (let i = 0; i < 11; i++) expect(await changePasswordAction(NEW_PASSWORD, `${NEW_PASSWORD}!`)).toEqual({ ok: false, errors: [COPY.proveAgain] });
    expect(await db.select().from(rateLimitEvent).where(eq(rateLimitEvent.kind, "password_change_parent"))).toEqual([]);
    // Proved, ten tries an hour (here two that differ, which count), and the eleventh is refused in words, changing nothing.
    await proveRecently(a.identity);
    for (let i = 0; i < 10; i++) expect(await changePasswordAction(NEW_PASSWORD, `${NEW_PASSWORD}!`)).toEqual({ ok: false, errors: [PASSWORD_COPY.mismatch] });
    const before = await credentialOf(a.identity.parentId);
    expect(await changePasswordAction(NEW_PASSWORD, NEW_PASSWORD)).toEqual({ ok: false, errors: [COPY.tooManyChanges] });
    expect(await credentialOf(a.identity.parentId)).toEqual(before);
    expect(await sessionsOf(a.identity.parentId)).toHaveLength(1);
    expect(await audits("parent.password.changed")).toEqual([]);
  });

  it("under Strict changes the password for a session proved under Strict, as at Standard", async () => {
    // Changed on purpose by slice SI-10b: Strict's refusal is gone (the switch to Strict cleared every older proof).
    const a = await seedSignedInParent(FAMILY_A);
    await seedAuthenticator(a.identity.parentId);
    await proveRecently(a.identity);
    await seedParentSettings({ level: "strict" });
    asParent(a.identity);
    expect(await changePasswordAction(NEW_PASSWORD, NEW_PASSWORD)).toEqual({ ok: true, message: COPY.changed });
    expect(await verifyPassword({ hash: (await credentialOf(a.identity.parentId))!.password!, password: NEW_PASSWORD })).toBe(true);
    expect(await sessionsOf(a.identity.parentId)).toEqual([]);
    expect(await audits("parent.password.changed")).toHaveLength(1);
    // The app stays: it is the second step, not the first.
    expect(await authenticatorRows(a.identity.parentId)).toHaveLength(1);
  });

  it("is refused for a breached password, one too short and two that differ, in words, changing nothing", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await proveRecently(a.identity);
    asParent(a.identity);
    const before = await credentialOf(a.identity.parentId);
    expect(await changePasswordAction(BREACHED, BREACHED)).toEqual({ ok: false, errors: [PASSWORD_COPY.breached] });
    expect(await changePasswordAction("too short", "too short")).toEqual({ ok: false, errors: [PASSWORD_COPY.tooShort] });
    expect(await changePasswordAction(NEW_PASSWORD, `${NEW_PASSWORD}!`)).toEqual({ ok: false, errors: [PASSWORD_COPY.mismatch] });
    expect(await credentialOf(a.identity.parentId)).toEqual(before);
    expect(await sessionsOf(a.identity.parentId)).toHaveLength(1);
    expect(await audits("parent.password.changed")).toEqual([]);
  });

  it("taken: the password replaced, the codes, links and devices gone, every session of the person ended (this one too) and nobody else's, one row, one notice", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const b = await seedSignedInParent(FAMILY_B);
    await proveRecently(a.identity);
    await withPassword(b);
    await seedParentSession(await authUserOf(a.identity.parentId), { familyQboId: FAMILY_A.family.qboId });
    await seedCode(a.identity.parentId);
    await mintLink(a.identity.parentId, "reset");
    await seedDevice(a.identity.parentId);
    await seedDevice(b.identity.parentId);
    await seedCode(b.identity.parentId);
    // A change of sign-in email asked for in a session this ends can't outlive it; B's is B's.
    await seedEmailChange({ parentId: a.identity.parentId, guardianId: a.identity.guardianId, familyId: a.identity.familyId, recordQboId: null, newEmail: "taken.over@elsewhere.example" });
    await seedEmailChange({ parentId: b.identity.parentId, guardianId: b.identity.guardianId, familyId: b.identity.familyId, recordQboId: null, newEmail: "b.moving@elsewhere.example" });
    const theirsBefore = { credential: await credentialOf(b.identity.parentId), sessions: await sessionsOf(b.identity.parentId), devices: await devicesOf(b.identity.parentId), codes: await codesOf(b.identity.parentId),
      emailChanges: await emailChangesOf(b.identity.parentId) };
    const before = await credentialOf(a.identity.parentId);
    asParent(a.identity);

    expect(await changePasswordAction(NEW_PASSWORD, NEW_PASSWORD)).toEqual({ ok: true, message: COPY.changed });
    const after = await credentialOf(a.identity.parentId);
    expect(after!.id).toBe(before!.id);
    expect(await verifyPassword({ hash: after!.password!, password: NEW_PASSWORD })).toBe(true);
    expect(await verifyPassword({ hash: after!.password!, password: PROVEN_PASSWORD })).toBe(false);
    expect(await codesOf(a.identity.parentId)).toEqual([]);
    expect((await linkRows(a.identity.parentId)).filter((l) => l.usedAt === null)).toEqual([]);
    expect(await devicesOf(a.identity.parentId)).toEqual([]);
    expect(await sessionsOf(a.identity.parentId)).toEqual([]);
    expect(await emailChangesOf(a.identity.parentId)).toEqual([]);
    // Nobody else's.
    expect({ credential: await credentialOf(b.identity.parentId), sessions: await sessionsOf(b.identity.parentId), devices: await devicesOf(b.identity.parentId), codes: await codesOf(b.identity.parentId),
      emailChanges: await emailChangesOf(b.identity.parentId) }).toEqual(theirsBefore);

    const rows = await audits("parent.password.changed");
    expect(rows.map((r) => [r.targetType, r.targetId, r.after])).toEqual([["parent", a.identity.parentId,
      { breachChecked: true, emailChangesDeleted: 1, codesDeleted: 1, linksDeleted: 1, devicesForgotten: 1, sessionsEnded: 2 }]]);
    expect(JSON.stringify(rows)).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(rows)).not.toContain(after!.password!);
    // One notice, to the address held at that moment, and to nobody else.
    await vi.waitFor(() => expect(outbox.filter((m) => m.subject.endsWith("password was changed"))).toHaveLength(1));
    const notice = outbox.find((m) => m.subject.endsWith("password was changed"))!;
    expect(notice.to).toBe(FAMILY_A.parent.email);
    expect(notice.text).toContain("http://localhost:3000/sign-in/password");
    expect(outbox.map((m) => m.to)).toEqual([FAMILY_A.parent.email]);
    for (const s of [FAMILY_A.family.name, ...FAMILY_A.students.map((x) => x.name), FAMILY_A.parent.name]) expect(`${notice.text}${notice.html}`).not.toContain(s);
  });

  it("takes a password the breach service couldn't check, and says so in its row", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await proveRecently(a.identity);
    breachDown = true;
    asParent(a.identity);
    expect(await changePasswordAction(NEW_PASSWORD, NEW_PASSWORD)).toEqual({ ok: true, message: COPY.changed });
    expect((await audits("parent.password.changed"))[0]!.after).toEqual({ breachChecked: false, breachNotChecked: "bad_answer", emailChangesDeleted: 0, codesDeleted: 0, linksDeleted: 0, devicesForgotten: 0, sessionsEnded: 1 });
  });
});

describe("signing out everywhere", () => {
  it("ends every session and forgets every device of the person, and nobody else's, with no recent proof", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const b = await seedSignedInParent(FAMILY_B);
    await seedParentSession(await authUserOf(a.identity.parentId), { familyQboId: FAMILY_A.family.qboId });
    await seedDevice(a.identity.parentId);
    await seedDevice(b.identity.parentId);
    // An unused code, one spent a minute ago (a sign-in finishing elsewhere at this moment) and one spent long ago, which
    // stays; an email change asked for in a session this ends; and B's code and email change, which stay.
    await seedCode(a.identity.parentId);
    await seedCode(a.identity.parentId, { usedAt: new Date(Date.now() - 60_000) });
    const old = await seedCode(a.identity.parentId, { usedAt: new Date(Date.now() - CODE_TTL_MS - 60_000) });
    await seedEmailChange({ parentId: a.identity.parentId, guardianId: a.identity.guardianId, familyId: a.identity.familyId, recordQboId: null, newEmail: "taken.over@elsewhere.example" });
    await seedCode(b.identity.parentId);
    await seedEmailChange({ parentId: b.identity.parentId, guardianId: b.identity.guardianId, familyId: b.identity.familyId, recordQboId: null, newEmail: "b.moving@elsewhere.example" });
    asParent(a.identity);
    expect(await signOutEverywhereAction()).toEqual({ ok: true, message: COPY.everywhereDone });
    expect(await sessionsOf(a.identity.parentId)).toEqual([]);
    expect(await devicesOf(a.identity.parentId)).toEqual([]);
    expect((await codesOf(a.identity.parentId)).map((c) => c.id)).toEqual([old]);
    expect(await emailChangesOf(a.identity.parentId)).toEqual([]);
    expect(await sessionsOf(b.identity.parentId)).toHaveLength(1);
    expect(await devicesOf(b.identity.parentId)).toHaveLength(1);
    expect(await codesOf(b.identity.parentId)).toHaveLength(1);
    expect(await emailChangesOf(b.identity.parentId)).toHaveLength(1);
    expect((await audits("parent.sessions.end_all")).map((r) => [r.targetType, r.targetId, r.after])).toEqual([["parent", a.identity.parentId,
      { emailChangesDeleted: 1, codesDeleted: 2, devicesForgotten: 1, sessionsEnded: 2 }]]);
  });

  it("refuses the last check of a sign-in whose code was spent just before the press: no session made after it stands", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    const codeId = await seedCode(a.identity.parentId, { usedAt: new Date(Date.now() - 1000) });
    const password = (await currentPassword(db, a.identity.parentId))!;
    // As the door's finish would see it a moment before the press: the code it spent still stands.
    expect(await signinStands(a.identity.parentId, a.identity.email, IP, { password, codeId })).toBe(true);
    asParent(a.identity);
    expect(await signOutEverywhereAction()).toEqual({ ok: true, message: COPY.everywhereDone });
    expect(await signinStands(a.identity.parentId, a.identity.email, IP, { password, codeId })).toBe(false);
    expect((await audits("signin.refused")).map((r) => r.after)).toContainEqual({ reason: "code_gone" });
  });

  it("is limited per person: past ten presses an hour it is refused in words, ending nothing", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    for (let i = 0; i < 10; i++) expect(await takeRateLimit("signin_settings_parent", a.identity.parentId)).toBe("taken");
    asParent(a.identity);
    expect(await signOutEverywhereAction()).toEqual({ ok: false, errors: [COPY.tooManyPresses] });
    expect(await sessionsOf(a.identity.parentId)).toHaveLength(1);
    expect(await audits("parent.sessions.end_all")).toEqual([]);
  });
});

describe("remembered devices", () => {
  /** Two devices of the person, the older-used one this session's, and one expired, which is never listed. */
  async function withDevices(a: SeededParent) {
    const mine = await seedDevice(a.identity.parentId, { createdAt: new Date(Date.now() - 40 * DAY), lastUsedAt: new Date(Date.now() - 5 * DAY), expiresAt: new Date(Date.now() + 85 * DAY) });
    const other = await seedDevice(a.identity.parentId, { createdAt: new Date(Date.now() - 20 * DAY), lastUsedAt: new Date(Date.now() - DAY), expiresAt: new Date(Date.now() + 89 * DAY) });
    const expired = await seedDevice(a.identity.parentId, { createdAt: new Date(Date.now() - 200 * DAY), lastUsedAt: new Date(Date.now() - 100 * DAY), expiresAt: new Date(Date.now() - DAY) });
    await nameDevice(a.identity.sessionId, mine.id);
    return { mine, other, expired };
  }
  /** The devices box, cut from its heading to the next box's, so nothing another box draws is counted. */
  const devicesBox = (page: string) => page.slice(page.indexOf(`id="devices-h"`), page.indexOf(`id="app-h"`));
  const NOT_FROM_PAGE = { ok: false, errors: [COPY.deviceNotFound] };
  const PROVE = { ok: false, errors: [COPY.proveAgain] };
  /** Each button's accessible name in the box, as its text reads (the hidden words included, tags and React's text breaks cut). */
  const buttonNames = (box: string) => [...box.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]!.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'"));
  /** The name an unmarked row's button carries, by the times its row shows (as the server draws LocalTime: in UTC). */
  const forgetName = (d: { createdAt: Date; lastUsedAt: Date }, row?: number) =>
    `${COPY.forgetOne} ${COPY.forgetWhichFirst} ${utcFallback(d.createdAt.toISOString())}, ${COPY.forgetWhichLast} ${utcFallback(d.lastUsedAt.toISOString())}${row ? `, ${COPY.forgetWhichRow} ${row}` : ""}`;

  it("lists the unexpired devices, newest use first, this session's marked, with their two times and nothing else of them", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await proveRecently(a.identity);
    const { mine, other, expired } = await withDevices(a);
    asParent(a.identity);
    const box = devicesBox(await renderPage(SignInSettingsPage));
    expect(box).toContain(html(COPY.devicesLede));
    expect(box).toContain(html(COPY.devicesNoNames));
    expect(box).toContain(other.id);
    expect(box).toContain(mine.id);
    expect(box.indexOf(other.id)).toBeLessThan(box.indexOf(mine.id));
    expect(box).not.toContain(expired.id);
    expect(box.match(/<strong>This device<\/strong>/g)).toHaveLength(1);
    expect(box.indexOf(`<strong>${COPY.thisDevice}</strong>`)).toBeGreaterThan(box.indexOf(mine.id));
    // Each button says which device it forgets: this one's "Forget this device", the other's "Forget" named by its two
    // times; no two share a name. The session named one, so nothing says it can't tell which.
    const [otherRow] = await db.select().from(parentDevice).where(eq(parentDevice.id, other.id));
    expect(buttonNames(box)).toEqual([forgetName(otherRow!), COPY.forgetDevice, COPY.forgetOthers]);
    expect(box).not.toContain(html(COPY.devicesWhichUnknown));
    expect(box).not.toContain(COPY.forgetAll);
    expect(box).toContain(html(COPY.forgetHere));
    // The rows' two times each, and the other row's button's two.
    expect(box.match(/<time /g)).toHaveLength(6);
    // Nothing that would let anyone use a device: no token, no hash, no session or person.
    const rows = await db.select().from(parentDevice).where(eq(parentDevice.parentId, a.identity.parentId));
    for (const secret of [mine.token, other.token, ...rows.map((r) => r.tokenHash), a.identity.sessionId, a.session.token, a.identity.parentId]) expect(box).not.toContain(secret);
  });

  it("a session that names no device marks none, and without a recent proof the list has no buttons and asks again", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    const { mine, other } = await withDevices(a);
    await nameDevice(a.identity.sessionId, null);
    asParent(a.identity);
    const box = devicesBox(await renderPage(SignInSettingsPage));
    for (const id of [mine.id, other.id]) expect(box).toContain(id);
    expect(box).not.toContain(`<strong>${COPY.thisDevice}</strong>`);
    expect(box).not.toContain(html(COPY.forgetHere));
    // It can't say which is the one in use, and says so above the list.
    expect(box).toContain(html(COPY.devicesWhichUnknown));
    expect(box.indexOf(html(COPY.devicesWhichUnknown))).toBeLessThan(box.indexOf(mine.id));
    expect(box).not.toContain(`>${COPY.forgetDevice}<`);
    expect(box).not.toContain(`>${COPY.forgetOne}<`);
    expect(box).not.toContain(COPY.forgetOthers);
    expect(box).not.toContain(COPY.forgetAll);
    expect(box).toContain(html(COPY.askAgainForDevices));
    expect(box).toMatch(/autocomplete="current-password"/i);
  });

  it("proved, a session that names none says it can't tell which is in use, names every button by its row, and offers Forget every device", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await proveRecently(a.identity);
    // Two devices whose times read the same to the minute, and a third: names that still differ, by the row's place.
    const at = { createdAt: new Date(Date.now() - 30 * DAY), lastUsedAt: new Date(Date.now() - 2 * DAY) };
    const twinA = await seedDevice(a.identity.parentId, at);
    const twinB = await seedDevice(a.identity.parentId, at);
    const newest = await seedDevice(a.identity.parentId, { createdAt: new Date(Date.now() - 10 * DAY), lastUsedAt: new Date(Date.now() - DAY) });
    asParent(a.identity);
    const box = devicesBox(await renderPage(SignInSettingsPage));
    expect(box).toContain(html(COPY.devicesWhichUnknown));
    expect(box).not.toContain(`<strong>${COPY.thisDevice}</strong>`);
    expect(box).not.toContain(html(COPY.forgetHere));
    // The newest use first; the two alike in either order, each told apart by its place in the list.
    const rows = new Map((await devicesOf(a.identity.parentId)).map((d) => [d.id, d]));
    const names = buttonNames(box);
    expect(names[0]).toBe(forgetName(rows.get(newest.id)!));
    expect(names.slice(1, 3).sort()).toEqual([forgetName(rows.get(twinA.id)!, 2), forgetName(rows.get(twinB.id)!, 3)].sort());
    expect(names[3]).toBe(COPY.forgetAll);
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain(COPY.forgetDevice);
    expect(box).not.toContain(COPY.forgetOthers);
    // Pressed: every device goes, and the answer and the row say none was kept.
    expect(await forgetOtherDevicesAction()).toEqual({ ok: true, message: COPY.everyDeviceForgotten });
    expect(await devicesOf(a.identity.parentId)).toEqual([]);
    expect((await audits("parent.devices.forgotten")).map((r) => r.after)).toEqual([{ devicesForgotten: 3, thisDeviceKept: false }]);
  });

  it("forgetting one is refused without a recent proof, and taken with one; this device too, the session going on", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    const { mine, other, expired } = await withDevices(a);
    asParent(a.identity);
    expect(await forgetDeviceAction(other.id)).toEqual(PROVE);
    expect(await devicesOf(a.identity.parentId)).toHaveLength(3);
    await proveRecently(a.identity);
    expect(await forgetDeviceAction(other.id)).toEqual({ ok: true, message: COPY.deviceForgotten });
    expect((await devicesOf(a.identity.parentId)).map((d) => d.id).sort()).toEqual([mine.id, expired.id].sort());
    // An expired one isn't listed, and is no device to forget: the one refusal.
    expect(await forgetDeviceAction(expired.id)).toEqual(NOT_FROM_PAGE);
    // This device: forgotten, and the session goes on with none.
    expect(await forgetDeviceAction(mine.id)).toEqual({ ok: true, message: COPY.deviceForgotten });
    expect((await devicesOf(a.identity.parentId)).map((d) => d.id)).toEqual([expired.id]);
    expect(await sessionsOf(a.identity.parentId)).toHaveLength(1);
    expect(await deviceIdOf(a.identity.sessionId)).toBeNull();
    const rows = await audits("parent.device.forgotten");
    expect(rows.map((r) => [r.actorId, r.targetType, r.targetId, r.after])).toEqual([
      [a.identity.parentId, "parent", a.identity.parentId, { deviceId: other.id, thisDevice: false }],
      [a.identity.parentId, "parent", a.identity.parentId, { deviceId: mine.id, thisDevice: true }],
    ]);
    expect(JSON.stringify(rows)).not.toContain(mine.token);
    // The page goes on drawing, with nothing to list.
    expect(devicesBox(await renderPage(SignInSettingsPage))).toContain(html(COPY.devicesNone));
  });

  it("forgetting every other device is refused without a recent proof, and taken with one, keeping this one", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    const { mine } = await withDevices(a);
    asParent(a.identity);
    expect(await forgetOtherDevicesAction()).toEqual(PROVE);
    expect(await devicesOf(a.identity.parentId)).toHaveLength(3);
    await proveRecently(a.identity);
    expect(await forgetOtherDevicesAction()).toEqual({ ok: true, message: COPY.otherDevicesForgotten });
    expect((await devicesOf(a.identity.parentId)).map((d) => d.id)).toEqual([mine.id]);
    expect(await deviceIdOf(a.identity.sessionId)).toBe(mine.id);
    expect((await audits("parent.devices.forgotten")).map((r) => [r.targetId, r.after])).toEqual([[a.identity.parentId, { devicesForgotten: 2, thisDeviceKept: true }]]);
    // A session naming a device past its end (its row not yet cleaned up) keeps no remembered device, and says so: the
    // answer says every device is forgotten, this one included, and the row that none was kept.
    await db.update(parentDevice).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(parentDevice.id, mine.id));
    expect(await forgetOtherDevicesAction()).toEqual({ ok: true, message: COPY.everyDeviceForgotten });
    expect((await audits("parent.devices.forgotten")).map((r) => r.after)[1]).toEqual({ devicesForgotten: 0, thisDeviceKept: false });
    // A session that names none forgets them all, in the same words.
    await nameDevice(a.identity.sessionId, null);
    expect(await forgetOtherDevicesAction()).toEqual({ ok: true, message: COPY.everyDeviceForgotten });
    expect((await audits("parent.devices.forgotten")).map((r) => r.after)).toEqual([
      { devicesForgotten: 2, thisDeviceKept: true }, { devicesForgotten: 0, thisDeviceKept: false }, { devicesForgotten: 1, thisDeviceKept: false }]);
    expect(await devicesOf(a.identity.parentId)).toEqual([]);
    expect(await sessionsOf(a.identity.parentId)).toHaveLength(1);
  });

  it("is refused when the window ran out between the page and the press, changing nothing", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const { other } = await withDevices(a);
    await proveRecently(a.identity, undefined, new Date(Date.now() - 11 * 60_000));
    expect(await sessionProvedRecently(db, a.identity)).toBe(false);
    asParent(a.identity);
    expect(await forgetDeviceAction(other.id)).toEqual(PROVE);
    expect(await forgetOtherDevicesAction()).toEqual(PROVE);
    expect(await devicesOf(a.identity.parentId)).toHaveLength(3);
    expect(await audits("parent.device.forgotten")).toEqual([]);
    expect(await audits("parent.devices.forgotten")).toEqual([]);
  });
});

describe("the set-up link offered to a person with no password", () => {
  it("mails one link to the session's own address and answers as the request page does", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    asParent(a.identity);
    expect(await askSetupLinkAction()).toEqual({ ok: true, message: PASSWORD_COPY.askAnswer });
    await vi.waitFor(async () => expect((await linkRows(a.identity.parentId)).filter((l) => l.usedAt === null && l.purpose === "setup")).toHaveLength(1));
    expect(outbox.map((m) => m.to)).toEqual([FAMILY_A.parent.email]);
    expect(outbox[0]!.text).toMatch(/\/sign-in\/set-up\/[A-Za-z0-9_-]{43}/);
    expect(await credentialOf(a.identity.parentId)).toBeUndefined();
  });
});

describe("one parent never reaches another's devices", () => {
  it("as family A's parent: family B's parent's devices, a second guardian of family A's, an id of another shape and a gone one are never shown, forgotten or renewed, and are the one refusal", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const b = await seedSignedInParent(FAMILY_B);
    const second = await seedParentIn({ familyQboId: FAMILY_A.family.qboId, name: "Sigrid Secondguardian", email: "sigrid.second@family-a.example" });
    const mine = await seedDevice(a.identity.parentId);
    await nameDevice(a.identity.sessionId, mine.id);
    const theirs = await seedDevice(b.identity.parentId);
    const bOther = await seedDevice(b.identity.parentId, { lastUsedAt: new Date(Date.now() - 10 * DAY), expiresAt: new Date(Date.now() + 80 * DAY) });
    const secondsDevice = await seedDevice(second.identity.parentId);
    await nameDevice(b.identity.sessionId, theirs.id);
    await nameDevice(second.identity.sessionId, secondsDevice.id);
    const gone = await seedDevice(a.identity.parentId);
    await db.delete(parentDevice).where(eq(parentDevice.id, gone.id));
    const theirRows = async () => ({ devices: await db.select().from(parentDevice).where(eq(parentDevice.parentId, b.identity.parentId)),
      second: await db.select().from(parentDevice).where(eq(parentDevice.parentId, second.identity.parentId)),
      sessions: [...await sessionsOf(b.identity.parentId), ...await sessionsOf(second.identity.parentId)],
      named: [await deviceIdOf(b.identity.sessionId), await deviceIdOf(second.identity.sessionId)] });
    const before = await theirRows();
    await proveRecently(a.identity);
    asParent(a.identity);

    // Not shown: A's page lists A's device alone.
    const page = await renderPage(SignInSettingsPage);
    expect(page).toContain(mine.id);
    for (const id of [theirs.id, bOther.id, secondsDevice.id, gone.id]) expect(page).not.toContain(id);

    // Not forgotten: each is the one refusal, whatever the reason.
    const NOT_FROM_PAGE = { ok: false, errors: [COPY.deviceNotFound] };
    const odd = [theirs.id, bOther.id, secondsDevice.id, gone.id, theirs.id.toUpperCase(), `${theirs.id} `, "not-a-device", "", undefined, null, 42, {}, [theirs.id],
      b.identity.sessionId, b.identity.parentId, theirs.token, "x".repeat(5000)] as unknown as string[];
    for (const v of odd) expect(await forgetDeviceAction(v), String(v)).toEqual(NOT_FROM_PAGE);
    // "Forget every other device" takes no id: one sent is never read, and only A's own others go (A has none).
    expect(await (forgetOtherDevicesAction as unknown as (x: unknown) => Promise<unknown>)(theirs.id)).toEqual({ ok: true, message: COPY.otherDevicesForgotten });
    expect((await devicesOf(a.identity.parentId)).map((d) => d.id)).toEqual([mine.id]);

    // Not renewed: A's session renewing, even naming B's device by hand, touches nothing of theirs.
    await nameDevice(a.identity.sessionId, bOther.id);
    const [row] = await db.select().from(parentAuthSession).where(eq(parentAuthSession.id, a.identity.sessionId));
    expect(await renewParentSession({ id: row!.id, expiresAt: row!.expiresAt })).toBe(true);

    // Not counted against: A asking again in a session naming B's device by hand is counted against A, never B's device.
    await withPassword(a);
    await nameDevice(a.identity.sessionId, theirs.id);
    const triesOn = (kind: "password_reask_parent" | "password_try_device", subject: string) => db.select().from(rateLimitEvent).where(and(eq(rateLimitEvent.kind, kind), eq(rateLimitEvent.subject, subject)));
    expect(await askAgainPasswordAction("not the password at all")).toEqual({ ok: false, errors: [COPY.passwordRejected] });
    expect(await triesOn("password_try_device", theirs.id)).toEqual([]);
    expect(await triesOn("password_reask_parent", a.identity.parentId)).toHaveLength(1);

    expect(await theirRows()).toEqual(before);
    expect((await audits("parent.device.forgotten")).length).toBe(0);
  });
});

describe("one parent never reaches another's sign-in", () => {
  it("as family A's parent: family B's stamp, app code and backup code, and a second guardian of family A's, spend nothing of theirs and are the one refusal", async () => {
    // The sign-in release, slice SI-6a: asking again takes an authenticator app's code or a backup code, for the
    // session's own person alone.
    const a = await seedSignedInParent(FAMILY_A);
    const b: SeededParent = await seedSignedInParent(FAMILY_B);
    const second = await seedParentIn({ familyQboId: FAMILY_A.family.qboId, name: "Sigrid Secondguardian", email: "sigrid.second@family-a.example" });
    for (const p of [a, b, second]) await withPassword(p);
    const apps = { b: await seedAuthenticator(b.identity.parentId), second: await seedAuthenticator(second.identity.parentId) };
    const codes = { b: (await seedBackupCodes(b.identity.parentId, 1))[0]!, second: (await seedBackupCodes(second.identity.parentId, 1))[0]! };
    const stampOf = async (identity: ParentIdentity) => {
      asParent(identity);
      const r = await askAgainPasswordAction(PROVEN_PASSWORD);
      if (!r.ok || r.step !== "app") throw new Error("the app's step should be asked for");
      return r.stamp;
    };
    const stamps = { b: await stampOf(b.identity), second: await stampOf(second.identity) };
    const theirs = async () => Promise.all([b.identity, second.identity].map(async (i) => ({
      app: await authenticatorRows(i.parentId), codes: await backupCodeRows(i.parentId), strongAt: await strongAtOf(i.sessionId),
    })));
    const before = await theirs();

    asParent(a.identity);
    const NO = { ok: false, errors: [COPY.codeRejected] };
    const tries: [string, string][] = [[stamps.b, codes.b], [stamps.b, appCode(apps.b.secret)], [stamps.second, codes.second], [stamps.second, appCode(apps.second.secret)]];
    for (const [stamp, code] of tries) expect(await askAgainCodeAction(stamp, code)).toEqual(NO);
    // A's own stamp (A has no app, so the emailed code is A's step) with their codes: wrong codes of A's own step.
    const mine = await askAgainPasswordAction(PROVEN_PASSWORD);
    if (!mine.ok) throw new Error("unreachable");
    expect(mine.step).toBe("code");
    for (const code of [codes.b, codes.second, appCode(apps.b.secret)]) expect(await askAgainCodeAction(mine.stamp, code)).toEqual(NO);

    expect(await theirs()).toEqual(before);
    expect(await strongAtOf(a.identity.sessionId)).toBeNull();
    expect(await audits("signin.proved_again")).toEqual([]);
    expect(await audits("signin.second_step")).toEqual([]);
  });

  it("as family A's parent: family B's stamp, a stamp made for a second guardian of family A, and values of the wrong type and size change nothing of theirs, and are the one refusal", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const b: SeededParent = await seedSignedInParent(FAMILY_B);
    const second = await seedParentIn({ familyQboId: FAMILY_A.family.qboId, name: "Sigrid Secondguardian", email: "sigrid.second@family-a.example" });
    for (const p of [a, b, second]) await withPassword(p);
    await seedDevice(b.identity.parentId);
    await seedDevice(second.identity.parentId);
    const theirStamp = await passwordThenCode(b.identity);
    const secondStamp = await passwordThenCode(second.identity);
    const theirs = async () => Promise.all([b.identity, second.identity].map(async (i) => ({
      credential: await credentialOf(i.parentId), sessions: await sessionsOf(i.parentId), devices: await devicesOf(i.parentId), codes: await codesOf(i.parentId),
      links: await db.select().from(parentSigninToken).where(eq(parentSigninToken.parentId, i.parentId)),
    })));
    const before = await theirs();

    asParent(a.identity);
    const CODE_NO = { ok: false, errors: [COPY.codeRejected] };
    const PASSWORD_NO = { ok: false, errors: [COPY.passwordRejected] };
    expect(await askAgainCodeAction(theirStamp.stamp, theirStamp.code)).toEqual(CODE_NO);
    expect(await askAgainCodeAction(secondStamp.stamp, secondStamp.code)).toEqual(CODE_NO);
    const odd = [undefined, null, 123456, {}, [], "x".repeat(5000), b.identity.sessionId, b.identity.parentId] as unknown as string[];
    for (const v of odd) {
      expect(await askAgainCodeAction(v, theirStamp.code), String(v)).toEqual(CODE_NO);
      expect(await askAgainCodeAction(theirStamp.stamp, v), String(v)).toEqual(CODE_NO);
      if (typeof v !== "string" || v.length > 1024) expect(await askAgainPasswordAction(v), String(v)).toEqual(PASSWORD_NO);
      if (typeof v !== "string" || v.length > 1024) expect(await changePasswordAction(v, v), String(v)).toEqual({ ok: false, errors: [COPY.failed] });
    }
    // Ids of theirs sent where none is taken are never read: what changes is A's own, or nothing.
    expect(await (askSetupLinkAction as unknown as (x: unknown) => Promise<unknown>)(b.identity.email)).toEqual({ ok: true, message: PASSWORD_COPY.askAnswer });
    expect(await (signOutEverywhereAction as unknown as (x: unknown) => Promise<unknown>)(b.identity.sessionId)).toEqual({ ok: true, message: COPY.everywhereDone });
    expect(await sessionsOf(a.identity.parentId)).toEqual([]);

    expect(await theirs()).toEqual(before);
    for (const s of [b.identity.sessionId, second.identity.sessionId]) expect(await strongAtOf(s)).toBeNull();
    expect(await audits("signin.proved_again")).toEqual([]);
    // Nothing was mailed to anyone but A after their codes went: A has a password, so the ask was a reset link to A.
    await vi.waitFor(() => expect(outbox.some((m) => m.to === FAMILY_A.parent.email)).toBe(true));
    expect(outbox.filter((m) => m.to !== FAMILY_A.parent.email).map((m) => m.to).sort()).toEqual([FAMILY_B.parent.email, "sigrid.second@family-a.example"].sort());
  });
});

describe("a proof made before the person's authenticator app came into force (slice SI-6b's second read, decision 1)", () => {
  it("no longer counts: another session's changes ask again and change nothing, the confirming session is asked again too, and the app's code lets each through", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    // Session A proves itself (as a sign-in with the emailed code would) a few seconds ago.
    await proveRecently(a.identity, PROVEN_PASSWORD, new Date(Date.now() - 5_000));
    const device = await seedDevice(a.identity.parentId);
    // Session B, the same person's, proves itself just after and sets an app up there.
    const bSession = await seedParentSession(await authUserOf(a.identity.parentId), { familyQboId: FAMILY_A.family.qboId, strongAt: new Date(Date.now() - 4_000) });
    const b = { ...a.identity, sessionId: bSession.id };
    expect(await sessionProvedRecently(db, a.identity)).toBe(true);
    const start = await startMyAuthenticator(ctxOf(b));
    if (!start.ok) throw new Error(`B's set-up should begin: ${start.errors.join(" ")}`);
    const secret = start.key.replace(/ /g, "");
    expect(await confirmMyAuthenticator(ctxOf(b), appCode(secret), start.stamp)).toMatchObject({ ok: true });

    // Within A's 10 minutes, every change of A's asks again, and nothing changes.
    const PROVE_AGAIN = { ok: false, errors: [COPY.proveAgain] };
    const before = { app: await authenticatorRows(a.identity.parentId), codes: await backupCodeRows(a.identity.parentId),
      credential: await credentialOf(a.identity.parentId), devices: await devicesOf(a.identity.parentId) };
    expect(await sessionProvedRecently(db, a.identity)).toBe(false);
    expect(await remakeMyBackupCodes(ctxOf(a.identity))).toEqual(PROVE_AGAIN);
    expect(await turnOffMyAuthenticator(ctxOf(a.identity))).toEqual(PROVE_AGAIN);
    expect(await changeMyPassword(ctxOf(a.identity), { password: NEW_PASSWORD, again: NEW_PASSWORD })).toEqual(PROVE_AGAIN);
    asParent(a.identity);
    expect(await forgetDeviceAction(device.id)).toEqual(PROVE_AGAIN);
    expect(await forgetOtherDevicesAction()).toEqual(PROVE_AGAIN);
    expect({ app: await authenticatorRows(a.identity.parentId), codes: await backupCodeRows(a.identity.parentId),
      credential: await credentialOf(a.identity.parentId), devices: await devicesOf(a.identity.parentId) }).toEqual(before);
    expect(await sessionsOf(a.identity.parentId)).toHaveLength(2);
    for (const action of ["parent.backup_codes.make", "parent.authenticator.off", "parent.password.changed", "parent.device.forgotten", "parent.devices.forgotten"]) {
      expect((await audits(action)).length, action).toBe(action === "parent.backup_codes.make" ? 1 : 0); // the confirm's own
    }
    // The page asks again too, so it never offers a press the server refuses: the box's ask names the app's code.
    const page = await renderPage(SignInSettingsPage);
    expect(page).toContain(html(COPY.askAgainForAppChange));
    expect(page).toContain(html(WITH_APP.askAgainForPassword));
    expect(page).not.toContain(COPY.newCodes);
    expect(page).not.toContain(COPY.changeButton);
    // B, which confirmed the app, is asked again for its next press as well: confirming stamps no session.
    expect(await remakeMyBackupCodes(ctxOf(b))).toEqual(PROVE_AGAIN);

    // A shows it's them again, now with the app's code (nothing is emailed), and each change goes through.
    const sentBefore = outbox.length;
    const first = await askAgainPasswordAction(PROVEN_PASSWORD);
    if (!first.ok || first.step !== "app") throw new Error("the app's step should be asked for");
    expect(await askAgainCodeAction(first.stamp, appCode(secret, Date.now(), 1))).toEqual({ ok: true, message: COPY.proved });
    expect(outbox.length).toBe(sentBefore);
    expect((await audits("signin.proved_again")).map((r) => r.after)).toEqual([{ step: "authenticator" }]);
    expect(await sessionProvedRecently(db, a.identity)).toBe(true);
    expect(await renderPage(SignInSettingsPage)).toContain(COPY.newCodes);
    expect(await forgetDeviceAction(device.id)).toMatchObject({ ok: true });
    expect(await remakeMyBackupCodes(ctxOf(a.identity))).toMatchObject({ ok: true, message: COPY.newCodesMade });
    expect(await turnOffMyAuthenticator(ctxOf(a.identity))).toEqual({ ok: true, message: COPY.turnedOff });
    expect(await changeMyPassword(ctxOf(a.identity), { password: NEW_PASSWORD, again: NEW_PASSWORD })).toMatchObject({ ok: true });
  });

  it("leaves a person with no app as they were: a proof within the window counts", async () => {
    const b = await seedSignedInParent(FAMILY_B);
    await proveRecently(b.identity, PROVEN_PASSWORD, new Date(Date.now() - 5_000));
    // Another person's app, set up just now, is nothing to do with them.
    const a = await seedSignedInParent(FAMILY_A);
    await seedAuthenticator(a.identity.parentId, { createdAt: new Date() });
    expect(await sessionProvedRecently(db, b.identity)).toBe(true);
    asParent(b.identity);
    expect(await renderPage(SignInSettingsPage)).toContain(COPY.changeButton);
    expect(await forgetOtherDevicesAction()).toMatchObject({ ok: true });
  });
});

describe("asking again when the app is turned off while its step is open (slice SI-6b, decision 10)", () => {
  it("the app's step ends: the app's words and that they start again, still counted, and the next password asks for the emailed code", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    const app = await seedAuthenticator(a.identity.parentId);
    asParent(a.identity);
    const first = await askAgainPasswordAction(PROVEN_PASSWORD);
    if (!first.ok || first.step !== "app") throw new Error("the app's step should be asked for");
    // Turned off in another tab, by the press's own delete (removeAuthenticator(), which turnOffMyAuthenticator() runs).
    expect(await db.transaction((tx) => removeAuthenticator(tx, a.identity.parentId))).toEqual({ apps: 1, backupCodes: 0 });
    const ENDED = { ok: false, errors: [COPY.appRejected, COPY.stepOver], ended: true };
    expect(await askAgainCodeAction(first.stamp, appCode(app.secret))).toEqual(ENDED);
    // The stamp asked for the app: it is never read as an emailed code's, whatever is typed with it.
    expect(await askAgainCodeAction(first.stamp, "123456")).toEqual(ENDED);
    expect((await audits("signin.second_step_wrong")).map((r) => r.after))
      .toEqual([{ factor: "authenticator", try: 1, reason: "no_app" }, { factor: "authenticator", try: 2, reason: "no_app" }]);
    expect((await db.select().from(rateLimitEvent)).filter((e) => e.kind === "second_step_parent" && e.subject === a.identity.parentId)).toHaveLength(2);
    expect(await strongAtOf(a.identity.sessionId)).toBeNull();
    expect(await audits("signin.proved_again")).toEqual([]);
    // Back at the password, the next right one asks for the emailed code, which proves the session.
    const { stamp, code } = await passwordThenCode(a.identity);
    expect(await askAgainCodeAction(stamp, code)).toEqual({ ok: true, message: COPY.proved });
    expect((await audits("signin.proved_again")).map((r) => r.after)).toEqual([{ step: "emailed_code" }]);
  });
});

describe("the authenticator app box (slice SI-6b)", () => {
  /** The box alone: from its heading to the end of the page's last box. */
  const box = (page: string) => page.slice(page.indexOf(`id="app-h"`));

  it("off, with no recent proof: what an app is, and asking again before the set-up press", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    asParent(a.identity);
    const page = box(await renderPage(SignInSettingsPage));
    expect(page).toContain(COPY.appTitle);
    expect(page).toContain(html(COPY.appWhat));
    expect(page).toContain(html(COPY.appKeepsDevices));
    expect(page).toContain(html(COPY.askAgainForApp));
    expect(page).toMatch(/autocomplete="current-password"/i);
    expect(page).not.toContain(COPY.appSetUp);
  });

  it("off and proved: the set-up press, under Strict too (slice SI-10a); with no password: choose one first", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await proveRecently(a.identity);
    asParent(a.identity);
    expect(box(await renderPage(SignInSettingsPage))).toContain(COPY.appSetUp);
    // Strict's own words are gone: a proved session sets an app up there as at Standard.
    await seedParentSettings({ level: "strict" });
    const strict = box(await renderPage(SignInSettingsPage));
    expect(strict).toContain(COPY.appSetUp);
    await seedParentSettings({ level: "standard" });
    const b = await seedSignedInParent(FAMILY_B);
    asParent(b.identity);
    const none = box(await renderPage(SignInSettingsPage));
    expect(none).toContain(html(COPY.appNeedsPassword));
    expect(none).not.toContain(COPY.appSetUp);
    expect(none).not.toMatch(/type="password"/);
  });

  it("on and proved: since when, the backup codes left, new codes and turning off, every sentence of how they sign in naming the app, and nothing of the app itself", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await proveRecently(a.identity);
    const app = await seedAuthenticator(a.identity.parentId);
    const codes = await seedBackupCodes(a.identity.parentId, 3);
    asParent(a.identity);
    const whole = await renderPage(SignInSettingsPage);
    const page = box(whole);
    expect(page).toContain(COPY.appOn);
    expect(page).toContain(`<dt>${COPY.appOnSince}</dt>`);
    expect(page).toContain(`<dt>${COPY.backupCodesLeft}</dt><dd>3</dd>`);
    expect(page).toContain(COPY.newCodes);
    expect(page).toContain(html(COPY.turnOffWords));
    expect(page).toContain(COPY.turnOff);
    expect(page).not.toContain(COPY.appSetUp);
    expect(page).not.toContain(html(COPY.backupCodesNone));
    // How they sign in, signing out everywhere, the password change and the device list name the app's code.
    for (const words of [WITH_APP.how, WITH_APP.everywhereThen, WITH_APP.signsOutEverywhere, WITH_APP.devicesNone]) expect(whole).toContain(html(words));
    for (const words of [COPY.how, COPY.everywhereThen, COPY.signsOutEverywhere, COPY.devicesNone]) expect(whole).not.toContain(html(words));
    const [row] = await authenticatorRows(a.identity.parentId);
    const hashes = (await backupCodeRows(a.identity.parentId)).map((r) => r.codeHash);
    for (const v of [app.secret, app.id, row!.secretCiphertext, ...codes, ...hashes]) expect(whole).not.toContain(v);
    // The Family page's "Your account" box says the same.
    const family = await renderPage(FamilyPage);
    expect(family).toContain(html(WITH_APP.how));
    expect(family).not.toContain(html(COPY.how));
  });

  it("on with no recent proof: asking again for the app's code; none left: what to do; under Strict: new codes, and no turning off", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    await seedAuthenticator(a.identity.parentId);
    asParent(a.identity);
    const page = await renderPage(SignInSettingsPage);
    expect(box(page)).toContain(html(COPY.askAgainForAppChange));
    expect(box(page)).toContain(html(COPY.backupCodesNone));
    expect(box(page)).not.toContain(COPY.newCodes);
    expect(page).toContain(html(WITH_APP.askAgainForPassword));
    await proveRecently(a.identity);
    await seedParentSettings({ level: "strict" });
    const strict = box(await renderPage(SignInSettingsPage));
    expect(strict).toContain(COPY.newCodes);
    expect(strict).toContain(html(COPY.turnOffStrict));
    expect(strict).not.toContain(COPY.turnOff);
  });

  it("an unfinished set-up is nothing the page shows: the box is off", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await proveRecently(a.identity);
    const unfinished = await seedAuthenticator(a.identity.parentId, { confirmed: false });
    asParent(a.identity);
    const whole = await renderPage(SignInSettingsPage);
    expect(box(whole)).toContain(COPY.appSetUp);
    expect(whole).toContain(html(COPY.how));
    for (const v of [unfinished.secret, unfinished.id]) expect(whole).not.toContain(v);
  });
});

describe("a passkey and asking again (slice SI-7a's newest-factor rule; since SI-7b asking again takes the passkey)", () => {
  it("a passkey added after a session's proof makes the session asked again", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await proveRecently(a.identity, PROVEN_PASSWORD, new Date(Date.now() - 5_000));
    expect(await sessionProvedRecently(db, a.identity)).toBe(true);
    await seedPasskey(a.identity.parentId, { createdAt: new Date() });
    expect(await sessionProvedRecently(db, a.identity)).toBe(false);
    expect(await changeMyPassword(ctxOf(a.identity), { password: NEW_PASSWORD, again: NEW_PASSWORD })).toEqual({ ok: false, errors: [COPY.proveAgain] });
  });

  it("a passkey older than the proof leaves it counting", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await seedPasskey(a.identity.parentId, { createdAt: new Date(Date.now() - 60_000) });
    await proveRecently(a.identity, PROVEN_PASSWORD, new Date(Date.now() - 5_000));
    expect(await sessionProvedRecently(db, a.identity)).toBe(true);
  });

  it("a passkey holder with no app is asked again with the passkey (slice SI-7b): the password sends no code and answers the passkey's step, and a code is taken nowhere", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    await seedPasskey(a.identity.parentId);
    asParent(a.identity);
    const first = await askAgainPasswordAction(PROVEN_PASSWORD);
    expect(first).toMatchObject({ ok: true, step: "passkey", app: false, backupCodes: false, message: COPY.passkeyAsked });
    if (!first.ok) throw new Error("the passkey's step should be asked for");
    expect(await codesOf(a.identity.parentId)).toEqual([]);
    const r = await askAgainCodeAction(first.stamp, "123456");
    expect(r.ok).toBe(false);
    expect(await audits("signin.proved_again")).toEqual([]);
    expect(await sessionProvedRecently(db, a.identity)).toBe(false);
    // A stamp that can't be read answers in the words of a person with a factor of their own, never "look for an email".
    expect(await askAgainCodeAction("not-a-stamp", "123456")).toEqual({ ok: false, errors: [COPY.appRejected] });
  });

  it("a holder of a passkey and an app gets the passkey's step, whose stamp takes the app's code and a backup code (slice SI-7b)", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    const app = await seedAuthenticator(a.identity.parentId);
    const [backup] = await seedBackupCodes(a.identity.parentId);
    await seedPasskey(a.identity.parentId);
    asParent(a.identity);
    const first = await askAgainPasswordAction(PROVEN_PASSWORD);
    if (!first.ok || first.step !== "passkey" || !first.app) throw new Error("the passkey's step, with the app beside it, should be asked for");
    expect(first.message).toBe(COPY.passkeyOrAppAsked);
    expect(await askAgainCodeAction(first.stamp, appCode(app.secret))).toEqual({ ok: true, message: COPY.proved });
    const again = await askAgainPasswordAction(PROVEN_PASSWORD);
    if (!again.ok) throw new Error("the password should be right");
    expect(await askAgainCodeAction(again.stamp, backup!)).toEqual({ ok: true, message: COPY.proved });
    expect(await codesOf(a.identity.parentId)).toEqual([]);
  });

  it("a passkey holder with no app who holds unspent backup codes is offered one beside the passkey, which proves this session (slice SI-7b)", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    const [backup] = await seedBackupCodes(a.identity.parentId);
    await seedPasskey(a.identity.parentId);
    asParent(a.identity);
    const first = await askAgainPasswordAction(PROVEN_PASSWORD);
    expect(first).toMatchObject({ ok: true, step: "passkey", app: false, backupCodes: true, message: COPY.passkeyOrBackupAsked });
    if (!first.ok) throw new Error("the passkey's step should be asked for");
    expect(await codesOf(a.identity.parentId)).toEqual([]);
    expect(await askAgainCodeAction(first.stamp, backup!)).toEqual({ ok: true, message: COPY.proved });
    expect((await audits("signin.proved_again")).map((r) => r.after)).toEqual([{ step: "backup_code" }]);
    expect(await sessionProvedRecently(db, a.identity)).toBe(true);
  });
});

describe("the Passkeys box, drawn (slice SI-7b)", () => {
  /** The passkeys box alone: from its heading to the page's way back to Family. */
  const passkeysBox = (page: string) => page.slice(page.indexOf(`id="passkeys-h"`), page.indexOf("Back to Family"));
  const AAGUID = "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4";
  /** Two passkeys of the person: one named and used, one with no name and never used, each with an AAGUID stored. */
  async function twoPasskeys(parentId: string) {
    const named = await seedPasskey(parentId);
    const unnamed = await seedPasskey(parentId);
    await db.update(parentAuthPasskey).set({ name: "Bitwarden", lastUsedAt: new Date(Date.now() - 60_000) }).where(eq(parentAuthPasskey.id, named.rowId));
    await db.update(parentAuthPasskey).set({ aaguid: AAGUID });
    return [named, unnamed];
  }
  const secretsOf = (keys: { id: string; publicKey: string }[]) => [...keys.flatMap((k) => [k.id, k.publicKey]), AAGUID, "internal,hybrid", "multiDevice"];

  it("proved: both listed with their names and times, Rename and Remove on each, new backup codes and the add, and nothing of the device", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const keys = await twoPasskeys(a.identity.parentId);
    await seedBackupCodes(a.identity.parentId);
    await proveRecently(a.identity);
    asParent(a.identity);
    const whole = await renderPage(SignInSettingsPage);
    const box = passkeysBox(whole);
    expect(box).toContain(html(COPY.passkeysWhat));
    expect(box).toContain("<strong>Bitwarden</strong>");
    expect(box).toContain(COPY.passkeyNoName);
    expect(box).toContain(COPY.passkeyNotUsed);
    expect(box.match(/>Rename</g)).toHaveLength(2);
    expect(box.match(/>Remove</g)).toHaveLength(2);
    expect(box).toContain(COPY.newCodes);
    expect(box).toContain(COPY.backupCodesLeft);
    expect(box).toContain(COPY.passkeyAdd);
    expect(box).not.toContain(html(COPY.passkeyRemoveLastWords));
    for (const v of secretsOf(keys)) expect(whole).not.toContain(v);
    expect(whole).toContain(html(howYouSignIn({ app: false, passkey: true, strict: false }).how));
  });

  it("not proved: listed with Rename, no Remove, no add, and asking again offers the passkey first", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await withPassword(a);
    const keys = await twoPasskeys(a.identity.parentId);
    asParent(a.identity);
    const whole = await renderPage(SignInSettingsPage);
    const box = passkeysBox(whole);
    expect(box.match(/>Rename</g)).toHaveLength(2);
    expect(box).not.toContain(">Remove<");
    expect(box).not.toContain(COPY.passkeyAdd);
    expect(box).toContain(html(howYouSignIn({ app: false, passkey: true, strict: false }).askAgainForPasskeys));
    expect(box).toContain(COPY.usePasskey);
    for (const v of secretsOf(keys)) expect(whole).not.toContain(v);
  });

  it("under Strict the last second factor offers no Remove, says why, and keeps the add beside it", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    const k = await seedPasskey(a.identity.parentId);
    await seedParentSettings({ level: "strict" });
    await proveRecently(a.identity);
    asParent(a.identity);
    const box = passkeysBox(await renderPage(SignInSettingsPage));
    expect(box).toContain(html(COPY.passkeyRemoveStrict));
    expect(box).not.toContain(">Remove<");
    expect(box).toContain(COPY.passkeyAdd);
    expect(box).not.toContain(k.id);
  });

  it("beside an app: the last one's words name the app, and the box leaves the backup codes to the app's box", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await seedAuthenticator(a.identity.parentId);
    await seedBackupCodes(a.identity.parentId);
    await seedPasskey(a.identity.parentId);
    await proveRecently(a.identity);
    asParent(a.identity);
    const box = passkeysBox(await renderPage(SignInSettingsPage));
    expect(box).toContain(html(COPY.passkeyRemoveLastAppWords));
    expect(box).toContain(">Remove<");
    expect(box).not.toContain(COPY.newCodes);
    expect(box).not.toContain(COPY.backupCodesLeft);
  });

  it("with no passkey: the sentence of what one is, none listed, and the add once proved", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await proveRecently(a.identity);
    asParent(a.identity);
    const box = passkeysBox(await renderPage(SignInSettingsPage));
    expect(box).toContain(html(COPY.passkeysWhat));
    expect(box).toContain(html(COPY.passkeysNone));
    expect(box).toContain(COPY.passkeyAdd);
    expect(box).not.toContain(COPY.newCodes);
  });
});

// Sign-in settings at Strict (the sign-in release, slice SI-10b): as at Standard for a session proved under Strict,
// with Strict's words of how the parent signs in and of what a remembered device spares (nothing, there), and, under
// new backup codes, a confirm that they were saved.
describe("Sign-in settings at Strict (slice SI-10b)", () => {
  const devicesBox = (page: string) => page.slice(page.indexOf(`id="devices-h"`), page.indexOf(`id="app-h"`));
  const appBox = (page: string) => page.slice(page.indexOf(`id="app-h"`), page.indexOf(`id="passkeys-h"`));

  it("says how an app holder, a passkey holder and one with both sign in at Strict, and what a device spares, word for word", () => {
    const app = howYouSignIn({ app: true, passkey: false, strict: true });
    expect(app.how).toBe("You sign in with this address and your password, and then the code from your authenticator app or one of your backup codes, every time, on every phone or computer.");
    expect(app.devicesLede).toBe("These are the phones and computers we remember for you. The club asks everyone for a passkey or an authenticator app each time they sign in, so on these too, after your password we ask for the code from your authenticator app.");
    expect(app.devicesNone).toBe("We don't remember any device for you right now. Wherever you sign in with your password, we ask for the code from your authenticator app too.");
    const passkey = howYouSignIn({ app: false, passkey: true, strict: true });
    expect(passkey.how).toBe("You can sign in with your passkey alone. With this address and your password instead, we also ask for your passkey, every time, on every phone or computer.");
    expect(passkey.devicesLede).toBe("These are the phones and computers we remember for you. The club asks everyone for a passkey or an authenticator app each time they sign in, so on these too, after your password we ask for your passkey.");
    expect(passkey.devicesNone).toBe("We don't remember any device for you right now. Wherever you sign in with your password, we ask for your passkey too.");
    const both = howYouSignIn({ app: true, passkey: true, strict: true });
    expect(both.how).toBe("You can sign in with your passkey alone. With this address and your password instead, we also ask for your passkey or the code from your authenticator app, every time, on every phone or computer.");
    expect(both.devicesNone).toBe("We don't remember any device for you right now. Wherever you sign in with your password, we ask for your passkey or the code from your authenticator app too.");
    for (const w of [app, passkey, both]) {
      expect(w.forgetHere).toBe("Forgetting the device you're using now doesn't sign you out here, and doesn't change how you sign in on it.");
      expect(w.deviceForgotten).toBe("That device is forgotten. You sign in on it the same way as before.");
      expect(w.otherDevicesForgotten).toBe("Every other device is forgotten. You sign in on them the same way as before.");
      expect(w.everyDeviceForgotten).toBe("Every device is forgotten, this one included. You sign in on each of them the same way as before.");
    }
    // Every other key is the factor's own, the same at either level.
    for (const f of [{ app: true, passkey: false }, { app: false, passkey: true }, { app: true, passkey: true }]) {
      const strict = howYouSignIn({ ...f, strict: true }), standard = howYouSignIn({ ...f, strict: false });
      for (const key of ["askAgainForPassword", "askAgainForEmail", "askAgainForDevices", "signsOutEverywhere", "changedNext", "everywhereThen", "everywhereNext",
        "askAgainForApp", "askAgainForAppChange", "askAgainForPasskeys"] as const) expect(strict[key]).toBe(standard[key]);
    }
    // At Strict with no factor (the gate makes it unreachable), Standard's words.
    expect(howYouSignIn({ app: false, passkey: false, strict: true })).toEqual(howYouSignIn({ app: false, passkey: false, strict: false }));
    // And Standard's words are as they were.
    expect(howYouSignIn({ app: true, passkey: false, strict: false })).toEqual(WITH_APP);
  });

  it("says Strict's words of the last factor and of what an app is, word for word", () => {
    expect(COPY.turnOffStrict).toBe("Your authenticator app is your only second step, and the club asks everyone for one, so it can't be turned off while it's your only one. Add a passkey first, then you can turn the app off.");
    expect(COPY.passkeyRemoveStrict).toBe("This passkey is your only second step, and the club asks everyone for one, so it can't be removed while it's your only one. Add another passkey or set up an authenticator app first, then you can remove this one.");
    expect(COPY.appWhatStrict).toBe("An authenticator app on your phone, like Google Authenticator or Microsoft Authenticator, shows a new 6-digit code every 30 seconds. Once you set one up, you can enter its code after your password in place of your passkey.");
    expect(COPY.codesDone).toBe("Done");
    expect(COPY.codesPutAway).toBe("Your backup codes aren't shown here any more. We won't show them again.");
  });

  it("lists a passkey holder's devices with their buttons at Strict, in Strict's words, and forgets one and then the rest", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await seedPasskey(a.identity.parentId);
    await proveRecently(a.identity);
    const first = await seedDevice(a.identity.parentId, { createdAt: new Date(Date.now() - 20 * DAY), lastUsedAt: new Date(Date.now() - DAY) });
    await seedDevice(a.identity.parentId, { createdAt: new Date(Date.now() - 10 * DAY), lastUsedAt: new Date(Date.now() - 2 * DAY) });
    await seedParentSettings({ level: "strict" });
    asParent(a.identity);
    const words = howYouSignIn({ app: false, passkey: true, strict: true });
    const page = await renderPage(SignInSettingsPage);
    const box = devicesBox(page);
    expect(box).toContain(html(words.devicesLede));
    expect(box).not.toContain(html(howYouSignIn({ app: false, passkey: true, strict: false }).devicesLede));
    expect(box).toContain(COPY.forgetAll);
    expect(box).not.toContain("one at a time");
    // The app box says what an app is at Strict: in place of the passkey, not of an emailed code.
    expect(appBox(page)).toContain(html(COPY.appWhatStrict));
    expect(appBox(page)).not.toContain(html(COPY.appWhat));
    expect(await forgetDeviceAction(first.id)).toEqual({ ok: true, message: "That device is forgotten. You sign in on it the same way as before." });
    expect(await devicesOf(a.identity.parentId)).toHaveLength(1);
    expect(await forgetOtherDevicesAction()).toEqual({ ok: true, message: "Every device is forgotten, this one included. You sign in on each of them the same way as before." });
    expect(await devicesOf(a.identity.parentId)).toEqual([]);
    expect(await audits("parent.device.forgotten")).toHaveLength(1);
    expect(await audits("parent.devices.forgotten")).toHaveLength(1);
  });

  it("the Family page says how they sign in at Strict", async () => {
    const a = await seedSignedInParent(FAMILY_A);
    await seedAuthenticator(a.identity.parentId);
    await seedParentSettings({ level: "strict" });
    asParent(a.identity);
    const page = await renderPage(FamilyPage);
    expect(page).toContain(html(howYouSignIn({ app: true, passkey: false, strict: true }).how));
    expect(page).not.toContain(html(WITH_APP.how));
  });

  it("draws the confirm of new backup codes: the box to tick, labelled, and Done, aria-disabled until it is ticked", () => {
    const drawn = renderToStaticMarkup(createElement(CodesSaved, { onDone: () => undefined })).replaceAll("&#x27;", "'");
    expect(drawn).toContain('<div class="checks"><label><input type="checkbox" name="saved"');
    expect(drawn).toContain(`<span>${ENROLMENT_COPY.saved}</span></label></div>`);
    expect(drawn).toMatch(/<button class="btn" aria-disabled="true">Done<\/button>/);
    expect(drawn).not.toMatch(/\sdisabled=""/);
    expect(drawn).toContain('<p role="status" class="help"></p>');
  });
});
