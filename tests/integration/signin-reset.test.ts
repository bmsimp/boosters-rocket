import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

type Msg = { to: string; subject: string; text: string; html: string };
// The outbox, and a switch that makes the next sends fail as a mail server that can't be reached would.
const mail = vi.hoisted(() => ({ outbox: [] as Msg[], fail: false }));
vi.mock("@/lib/mail/senders", () => ({ SMTP_PASSWORD_AAD: "mail:smtp-password", buildSender: async () => async (m: Msg) => {
  if (mail.fail) throw new Error("the mail server can't be reached");
  mail.outbox.push(m);
} }));
// The breach service, as a stub on a port of its own (choosing a password from the mail's link asks it).
const where = vi.hoisted(() => ({ range: "" }));
vi.mock("@/lib/parents/breach-endpoints", () => ({ breachEndpoints: () => ({ range: where.range }) }));
// A fault injected from outside src/ into the reset's transaction, after its first deletes: removing the passkeys throws.
const fault = vi.hoisted(() => ({ passkeys: false }));
vi.mock("@/lib/parents/passkeys", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/parents/passkeys")>();
  return { ...real, removeAllPasskeys: async (...a: Parameters<typeof real.removeAllPasskeys>) => {
    if (fault.passkeys) throw new Error("a fault injected by the test");
    return real.removeAllPasskeys(...a);
  } };
});

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { auditLog, guardian, parent, parentAuthSession, parentAuthUser, parentBackupCode, parentEmailChange, parentSigninToken, rateLimitEvent, signinCode } from "@/lib/db/schema";
import { resetSignin, signinHeld } from "@/lib/parents/signin-reset";
import { linkVerdict } from "@/lib/parents/signin-links";
import { choosePasswordFromLink } from "@/lib/parents/password-set";
import { signinStands, type PasswordProof } from "@/lib/parents/signin-codes";
import { resetDb, seedGuardianInFamily, seedParent, seedParentSession, seedWorkingMail } from "../helpers/db";
import { SIGNINS_ON, seedParentSettings } from "../helpers/roster-cache";
import { DOOR_PASSWORD, codeMailed, codeStep, cookieNamed, passwordStep } from "../helpers/parent-door";
import { credentialRows, deviceRows, linkRows, mintLink, seedCode, seedDevice, seedPassword } from "../helpers/signin-links";
import { authenticatorRows, backupCodeRows, seedAuthenticator, seedBackupCodes } from "../helpers/authenticator";
import { passkeyRows, passkeyStep, seedPasskey } from "../helpers/passkey";
import { seedEmailChange } from "../helpers/email-change";

/**
 * An Admin's reset of one parent's sign-in (the sign-in release, slice SI-9a; open questions 22, 24, 26 and 33 of the
 * app-owned families spec): every session ended and everything the person signs in with removed, in one transaction
 * with its audit row, a new set-up link mailed after it, and the way back in for a parent who lost what they sign in
 * with: a lost passkey, or passkeys a change of the portal's address made useless. The staff action and the person's
 * page are tests/integration/parents-pages.test.ts's; the staff home's line, staff-home.test.ts's.
 */
const IP = "203.0.113.71";
const REASON = "Lost her phone at the band trip; called back on the number in the club's records.";
const NEW_PASSWORD = "a brand new phrase chosen after the reset";
const ADMIN = { actor: { door: "staff" as const, id: "00000000-0000-4000-8000-0000000000ad", label: "ada@club.org" }, ip: IP, permission: "Parents.SignInReset.ReadWrite" };
const asked = { reason: REASON, calledBack: true };
const audits = async (action: string) => (await db.select().from(auditLog).orderBy(auditLog.id)).filter((r) => r.action === action);
const sessionsOf = (authUserId: string) => db.select().from(parentAuthSession).where(eq(parentAuthSession.userId, authUserId));
const codesOf = (parentId: string) => db.select().from(signinCode).where(eq(signinCode.parentId, parentId));
const unusedLinks = async (parentId: string) => (await linkRows(parentId)).filter((l) => l.usedAt === null);
const requestsOf = (parentId: string) => db.select().from(parentEmailChange).where(and(eq(parentEmailChange.parentId, parentId), isNull(parentEmailChange.usedAt)));
/** The set-up token a mail carries in its link (`/sign-in/set-up/<token>`). */
const tokenIn = (m: Msg) => /\/sign-in\/set-up\/([A-Za-z0-9_-]{43})/.exec(m.text)?.[1] ?? null;
/** The password the person proved, as the password step read it. */
async function passwordProof(authUserId: string): Promise<PasswordProof> {
  const [cred] = await credentialRows(authUserId);
  return { credentialId: cred!.id, credentialUpdatedAt: cred!.updatedAt };
}

let server: Server;
beforeAll(async () => {
  // A padded range with nothing in it: every password is one nobody has seen.
  server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }).end(`${"0".repeat(35)}:0`); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  where.range = `http://127.0.0.1:${(server.address() as AddressInfo).port}/range/`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

/** A guardian of a family of the app's own (`familyQboId`, F1 unless told), with a sign-in account; nothing to sign in with unless the test gives it. */
async function seedGuardianNamed(name: string, familyQboId = "F1") {
  const p = await seedParent({ name, email: `${name.toLowerCase().split(" ")[0]}@example.com` });
  const row = await seedGuardianInFamily({ parentId: p.id, familyQboId });
  return { ...p, row };
}

/** Ana, holding every kind of thing a sign-in hangs on: a password, an app with ten backup codes, two passkeys, two devices, two sessions, an unused code, an unused reset link and an email change request. */
async function seedAnaWithEverything() {
  const ana = await seedGuardianNamed("Ana Zebrafish");
  await seedPassword(ana.authUserId, DOOR_PASSWORD);
  await seedAuthenticator(ana.id);
  await seedBackupCodes(ana.id);
  await seedPasskey(ana.id); await seedPasskey(ana.id);
  await seedDevice(ana.id); await seedDevice(ana.id);
  await seedParentSession(ana.authUserId); await seedParentSession(ana.authUserId);
  await seedCode(ana.id);
  await mintLink(ana.id, "reset");
  await seedEmailChange({ parentId: ana.id, guardianId: ana.row.id, familyId: ana.row.familyId, recordQboId: null, newEmail: "ana.new@example.com" });
  return ana;
}

/** Everything a person signs in with, as rows: what a reset takes, and what one refused or rolled back leaves. */
async function held(p: { id: string; authUserId: string }) {
  return {
    passwords: (await credentialRows(p.authUserId)).length, apps: (await authenticatorRows(p.id)).length, backupCodes: (await backupCodeRows(p.id)).length,
    passkeys: (await passkeyRows(p.id)).length, devices: (await deviceRows(p.id)).length, sessions: (await sessionsOf(p.authUserId)).length,
    codes: (await codesOf(p.id)).length, links: (await unusedLinks(p.id)).map((l) => l.purpose), requests: (await requestsOf(p.id)).length,
  };
}

beforeEach(async () => {
  await resetDb();
  mail.outbox.length = 0; mail.fail = false; fault.passkeys = false;
  await seedWorkingMail();
  await seedParentSettings(SIGNINS_ON);
});

describe("an Admin's reset of a parent's sign-in", () => {
  it("removes everything the person signs in with, leaves one unused set-up link, and counts each in its audit row", async () => {
    const ana = await seedAnaWithEverything();
    expect(await signinHeld(ana.id)).toEqual({ password: true, passkeys: 2, app: true, backupCodes: 10, devices: 2, sessions: 2 });
    expect(await resetSignin(ana.id, asked, ADMIN)).toEqual({ ok: true, to: "ana@example.com", mailed: true });
    expect(await held(ana)).toEqual({ passwords: 0, apps: 0, backupCodes: 0, passkeys: 0, devices: 0, sessions: 0, codes: 0, links: ["setup"], requests: 0 });
    expect(await signinHeld(ana.id)).toEqual({ password: false, passkeys: 0, app: false, backupCodes: 0, devices: 0, sessions: 0 });
    const [row] = await audits("parent.signin.reset");
    expect(row).toMatchObject({ door: "staff", actorId: ADMIN.actor.id, actorLabel: "ada@club.org", permission: "Parents.SignInReset.ReadWrite", targetType: "parent", targetId: ana.id, ip: IP,
      before: { password: true, passkeys: 2, app: true, backupCodes: 10, devices: 2, sessions: 2 } });
    expect(row!.after).toEqual({ reason: REASON, calledBack: true, passwordRemoved: true, passkeysRemoved: 2, appsRemoved: 1, backupCodesRemoved: 10,
      devicesForgotten: 2, sessionsEnded: 2, codesDeleted: 1, linksDeleted: 1, requestsDeleted: 1 });
    // The link is made as every link is, its own row beside the reset's, never with its token.
    const made = await audits("parent.password.link_made");
    expect(made.at(-1)).toMatchObject({ actorId: ADMIN.actor.id, targetId: ana.id, after: { purpose: "setup", replaced: 0 } });
    // Nothing in either row holds a token, a hash or the person's address.
    const [link] = await unusedLinks(ana.id);
    for (const r of [row!, made.at(-1)!]) {
      const body = JSON.stringify([r.before, r.after]);
      expect(body).not.toContain(link!.tokenHash);
      expect(body).not.toContain("ana@example.com");
    }
    // Everything else of the person stays: their name, their guardian row and its family, their block state.
    expect((await db.select().from(parent).where(eq(parent.id, ana.id)))[0]).toMatchObject({ name: "Ana Zebrafish", blocked: false, email: "ana@example.com" });
    expect((await db.select().from(guardian).where(eq(guardian.parentId, ana.id)))[0]).toMatchObject({ id: ana.row.id, status: "active", familyId: ana.row.familyId });
  });

  it("does it all in one transaction: a fault after its first deletes leaves everything as it was, and mails nothing", async () => {
    const ana = await seedAnaWithEverything();
    const before = await held(ana);
    fault.passkeys = true;
    await expect(resetSignin(ana.id, asked, ADMIN)).rejects.toThrow("a fault injected by the test");
    expect(await held(ana)).toEqual(before);
    expect(before).toEqual({ passwords: 1, apps: 1, backupCodes: 10, passkeys: 2, devices: 2, sessions: 2, codes: 1, links: ["reset"], requests: 1 });
    expect(await audits("parent.signin.reset")).toEqual([]);
    expect((await audits("parent.password.link_made")).filter((r) => r.actorId === ADMIN.actor.id)).toEqual([]);
    expect(mail.outbox).toEqual([]);
  });

  it("mails a working set-up link to the address read under the lock; with it the person chooses a password, and the door then asks for the emailed code, never the passkey", async () => {
    const ana = await seedAnaWithEverything();
    expect((await resetSignin(ana.id, asked, ADMIN)).ok).toBe(true);
    expect(mail.outbox.map((m) => m.to)).toEqual(["ana@example.com"]);
    const [m] = mail.outbox;
    expect(m!.subject).toMatch(/ sign-in was reset$/);
    const token = tokenIn(m!);
    expect(token).not.toBeNull();
    expect((await linkVerdict("setup", token)).ok).toBe(true);
    // The reason is for staff only: in its audit row, and in no mail and no row a parent's page reads.
    expect(`${m!.text}${m!.html}`).not.toContain(REASON);
    expect(JSON.stringify(await db.select().from(parent))).not.toContain(REASON);
    expect(JSON.stringify(await db.select().from(parentSigninToken))).not.toContain(REASON);
    expect((await audits("parent.signin.reset"))[0]!.after).toMatchObject({ reason: REASON });

    expect(await choosePasswordFromLink({ purpose: "setup", token, password: NEW_PASSWORD, again: NEW_PASSWORD }, { ip: IP })).toMatchObject({ ok: true });
    const since = mail.outbox.length;
    const first = await passwordStep("ana@example.com", { password: NEW_PASSWORD });
    expect(first.body).toEqual({ ok: true, step: "code" });
    const code = await codeMailed(mail.outbox, "ana@example.com", since);
    const done = await codeStep(code, first.pending);
    expect(done.body.ok).toBe(true);
    expect(cookieNamed(done.res, "session_token")).not.toBe("");
  });

  it("touches nobody else's sign-in: another family's guardian, or the same family's second guardian", async () => {
    const ana = await seedAnaWithEverything();
    const bea = await seedGuardianNamed("Bea Other", "F2");
    const cal = await seedGuardianNamed("Cal Second", "F1");
    for (const p of [bea, cal]) {
      await seedPassword(p.authUserId, DOOR_PASSWORD); await seedAuthenticator(p.id); await seedBackupCodes(p.id); await seedPasskey(p.id);
      await seedDevice(p.id); await seedParentSession(p.authUserId); await seedCode(p.id); await mintLink(p.id, "reset");
    }
    const theirs = { bea: await held(bea), cal: await held(cal) };
    expect((await resetSignin(ana.id, asked, ADMIN)).ok).toBe(true);
    expect({ bea: await held(bea), cal: await held(cal) }).toEqual(theirs);
    expect(mail.outbox.map((m) => m.to)).toEqual(["ana@example.com"]);
  });
});

describe("what a reset refuses, changing nothing and mailing nothing", () => {
  it("refuses no box, no reason and a reason over 500 characters, counting and writing nothing", async () => {
    const ana = await seedAnaWithEverything();
    const before = await held(ana);
    for (const raw of [{ reason: REASON, calledBack: false }, { reason: "   ", calledBack: true }, { reason: "x".repeat(501), calledBack: true },
      { reason: REASON, calledBack: "yes" as unknown as boolean }]) {
      expect(await resetSignin(ana.id, raw, ADMIN)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(await held(ana)).toEqual(before);
    expect(await db.select().from(rateLimitEvent)).toEqual([]);
    expect((await db.select().from(auditLog)).filter((r) => r.action.startsWith("parent.signin.reset"))).toEqual([]);
    expect(mail.outbox).toEqual([]);
  });

  it("refuses a blocked person, one with no row that counts, one with no sign-in account, a closed door and an unknown id, each audited with its reason", async () => {
    const ana = await seedAnaWithEverything();
    const before = await held(ana);
    const refusedFor = async (id: string) => (await audits("parent.signin.reset_refused")).filter((r) => (r.targetId ?? null) === id).map((r) => (r.after as { reason: string }).reason);

    await db.update(parent).set({ blocked: true }).where(eq(parent.id, ana.id));
    expect(await resetSignin(ana.id, asked, ADMIN)).toEqual({ ok: false, reason: "blocked" });
    await db.update(parent).set({ blocked: false }).where(eq(parent.id, ana.id));

    await db.update(guardian).set({ status: "disabled", disabledReason: "removed" }).where(eq(guardian.id, ana.row.id));
    expect(await resetSignin(ana.id, asked, ADMIN)).toEqual({ ok: false, reason: "no_access" });
    await db.update(guardian).set({ status: "active", disabledReason: null }).where(eq(guardian.id, ana.row.id));

    await seedParentSettings({ signin: false });
    expect(await resetSignin(ana.id, asked, ADMIN)).toEqual({ ok: false, reason: "signins_off" });
    await seedParentSettings(SIGNINS_ON);
    expect(await refusedFor(ana.id)).toEqual(["blocked", "no_access", "signins_off"]);
    expect(await held(ana)).toEqual(before);

    // A person with no sign-in account: nothing signs in without one.
    const dan = await seedGuardianNamed("Dan Noaccount");
    await db.delete(parentAuthUser).where(eq(parentAuthUser.parentId, dan.id));
    expect(await resetSignin(dan.id, asked, ADMIN)).toEqual({ ok: false, reason: "no_access" });
    expect(await refusedFor(dan.id)).toEqual(["no_access"]);
    expect(await unusedLinks(dan.id)).toEqual([]);

    // An id nobody has: its row names nobody.
    const nobody = "00000000-0000-4000-8000-00000000dead";
    expect(await resetSignin(nobody, asked, ADMIN)).toEqual({ ok: false, reason: "not_found" });
    expect((await audits("parent.signin.reset_refused")).at(-1)).toMatchObject({ targetType: null, targetId: null, after: { reason: "not_found" }, actorId: ADMIN.actor.id });

    expect(await audits("parent.signin.reset")).toEqual([]);
    expect(await audits("parent.password.link_made")).toHaveLength(1); // the reset link the seed made, and no other
    expect(mail.outbox).toEqual([]);
  });

  it("resets one person at most three times a day, auditing the first refusal once; another person's reset the same hour goes through", async () => {
    const ana = await seedGuardianNamed("Ana Zebrafish");
    for (let i = 0; i < 3; i++) expect((await resetSignin(ana.id, asked, ADMIN)).ok).toBe(true);
    await seedPassword(ana.authUserId, DOOR_PASSWORD);
    expect(await resetSignin(ana.id, asked, ADMIN)).toEqual({ ok: false, reason: "rate_limited" });
    expect(await resetSignin(ana.id, asked, ADMIN)).toEqual({ ok: false, reason: "rate_limited" });
    expect((await audits("parent.signin.reset_refused")).map((r) => [r.targetId, r.after])).toEqual([[ana.id, { reason: "rate_limited" }]]);
    expect(await audits("parent.signin.reset")).toHaveLength(3);
    expect(await credentialRows(ana.authUserId)).toHaveLength(1); // the refused ones changed nothing
    expect(mail.outbox).toHaveLength(3);
    const bea = await seedGuardianNamed("Bea Other", "F2");
    expect(await resetSignin(bea.id, asked, ADMIN)).toEqual({ ok: true, to: "bea@example.com", mailed: true });
  });
});

describe("a reset's limit and counts", () => {
  it("counts every spelling of one person's id in one window, and names the person one way in every row", async () => {
    const ana = await seedGuardianNamed("Ana Zebrafish");
    // Postgres reads a uuid in any letter case as the same one: each spelling must take a place in the same count.
    const spellings = [ana.id, ana.id.toUpperCase(), ana.id.replace(/[a-f]/, (c) => c.toUpperCase())];
    expect(new Set(spellings).size).toBeGreaterThan(1); // seedParent's ids are random uuids, holding letters
    for (const id of spellings) expect((await resetSignin(id, asked, ADMIN)).ok).toBe(true);
    expect(await resetSignin(ana.id.toUpperCase(), asked, ADMIN)).toEqual({ ok: false, reason: "rate_limited" });
    expect(await resetSignin(ana.id, asked, ADMIN)).toEqual({ ok: false, reason: "rate_limited" });
    expect(mail.outbox).toHaveLength(3);
    const rows = (await db.select().from(auditLog)).filter((r) => r.action.startsWith("parent.signin.reset"));
    expect(rows.map((r) => r.targetId)).toEqual([ana.id, ana.id, ana.id, ana.id]);
    // A mail that fails for an upper-cased id writes its row under the id as the audit page's filter finds it.
    const bea = await seedGuardianNamed("Bea Other", "F2");
    mail.fail = true;
    expect((await resetSignin(bea.id.toUpperCase(), asked, ADMIN)).ok).toBe(true);
    expect((await audits("parent.signin.reset_unmailed")).map((r) => r.targetId)).toEqual([bea.id]);
  });

  it("counts as what the person had only the devices and sessions still live, as their page does, and forgets the expired ones too", async () => {
    const ana = await seedGuardianNamed("Ana Zebrafish");
    await seedPassword(ana.authUserId, DOOR_PASSWORD);
    const gone = new Date(Date.now() - 60_000);
    await seedDevice(ana.id); await seedDevice(ana.id, { expiresAt: gone });
    await seedParentSession(ana.authUserId); await seedParentSession(ana.authUserId, { expiresAt: gone });
    expect(await signinHeld(ana.id)).toMatchObject({ devices: 1, sessions: 1 });
    expect((await resetSignin(ana.id, asked, ADMIN)).ok).toBe(true);
    const [row] = await audits("parent.signin.reset");
    expect(row!.before).toMatchObject({ devices: 1, sessions: 1 });
    expect(row!.after).toMatchObject({ devicesForgotten: 2, sessionsEnded: 2 });
    expect(await held(ana)).toMatchObject({ devices: 0, sessions: 0 });
  });
});

describe("a reset whose mail can't be handed over", () => {
  it("stands, keeps its link, and writes its own row with the send's sentence", async () => {
    const ana = await seedAnaWithEverything();
    mail.fail = true;
    expect(await resetSignin(ana.id, asked, ADMIN)).toEqual({ ok: true, to: "ana@example.com", mailed: false });
    expect(await held(ana)).toEqual({ passwords: 0, apps: 0, backupCodes: 0, passkeys: 0, devices: 0, sessions: 0, codes: 0, links: ["setup"], requests: 0 });
    expect(await audits("parent.signin.reset")).toHaveLength(1);
    expect((await audits("parent.signin.reset_unmailed")).map((r) => [r.targetId, r.actorId, r.after])).toEqual([[ana.id, ADMIN.actor.id, { error: "Sending failed for an unexpected reason." }]]);
    expect((await audits("mail.failed")).at(-1)).toMatchObject({ after: { purpose: "signin_reset", to: "ana@example.com" } });
  });
});

describe("a sign-in that proved itself before the reset, and makes its session after it, is refused at its last check", () => {
  // Each proof as the door's own functions hand it to the one finish (signin-codes.ts's SigninProof), standing before
  // the reset; the reset then deletes the password every proof but a passkey alone carries (`password_changed`), and
  // the second line behind it is gone too (the code, the app, the backup code, the passkey, the device).
  type Seeded = Awaited<ReturnType<typeof seedGuardianNamed>>;
  const cases: [string, (p: Seeded) => Promise<Parameters<typeof signinStands>[3]>, string][] = [
    ["an emailed code", async (p) => ({ password: await passwordProof(p.authUserId), codeId: await seedCode(p.id, { usedAt: new Date() }) }), "password_changed"],
    ["the app's code", async (p) => ({ password: await passwordProof(p.authUserId), authenticatorId: (await seedAuthenticator(p.id)).id, signedOutSeen: 0 }), "password_changed"],
    ["a backup code", async (p) => {
      await seedAuthenticator(p.id); await seedBackupCodes(p.id);
      const [spent] = await backupCodeRows(p.id);
      await db.update(parentBackupCode).set({ usedAt: new Date() }).where(eq(parentBackupCode.id, spent!.id));
      return { password: await passwordProof(p.authUserId), backupCodeId: spent!.id, signedOutSeen: 0 };
    }, "password_changed"],
    ["a passkey after the password", async (p) => ({ password: await passwordProof(p.authUserId), passkeyId: (await seedPasskey(p.id)).rowId, signedOutSeen: 0 }), "password_changed"],
    ["a passkey alone", async (p) => ({ passkeyId: (await seedPasskey(p.id)).rowId, signedOutSeen: 0 }), "passkey_gone"],
    ["a remembered device", async (p) => ({ password: await passwordProof(p.authUserId), deviceId: (await seedDevice(p.id)).id }), "password_changed"],
  ];
  it.each(cases)("by %s", async (_name, proofOf, why) => {
    const ana = await seedGuardianNamed("Ana Zebrafish");
    await seedPassword(ana.authUserId, DOOR_PASSWORD);
    const proof = await proofOf(ana);
    expect(await signinStands(ana.id, "ana@example.com", IP, proof)).toBe(true);
    expect((await resetSignin(ana.id, asked, ADMIN)).ok).toBe(true);
    await seedParentSession(ana.authUserId); // the door makes its session after the reset committed
    expect(await signinStands(ana.id, "ana@example.com", IP, proof)).toBe(false);
    expect((await audits("signin.refused")).at(-1)).toMatchObject({ targetId: ana.id, after: { reason: why }, ip: IP });
    // The second line is gone too.
    expect(await held(ana)).toMatchObject({ codes: 0, apps: 0, backupCodes: 0, passkeys: 0, devices: 0 });
  });

  it("by a set-up link used a moment before", async () => {
    const ana = await seedGuardianNamed("Ana Zebrafish");
    const token = await mintLink(ana.id, "setup");
    const set = await choosePasswordFromLink({ purpose: "setup", token, password: NEW_PASSWORD, again: NEW_PASSWORD }, { ip: IP });
    if (!set.ok || !set.signIn) expect.fail(`the link didn't set a password and sign in: ${JSON.stringify(set)}`);
    expect((await resetSignin(ana.id, asked, ADMIN)).ok).toBe(true);
    await seedParentSession(ana.authUserId);
    expect(await signinStands(ana.id, "ana@example.com", IP, { link: set.signIn.proof })).toBe(false);
    expect((await audits("signin.refused")).at(-1)).toMatchObject({ targetId: ana.id, after: { reason: "password_changed" } });
  });
});

describe("the way back in for a parent whose only second step is a passkey", () => {
  /** The mail's link, the password chosen with it, then the door: a code is asked on a new device, and with it the person is signed in. */
  async function backIn(email: string) {
    const token = tokenIn(mail.outbox.filter((m) => m.to === email).at(-1)!);
    expect(await choosePasswordFromLink({ purpose: "setup", token, password: NEW_PASSWORD, again: NEW_PASSWORD }, { ip: IP })).toMatchObject({ ok: true });
    const since = mail.outbox.length;
    const first = await passwordStep(email, { password: NEW_PASSWORD });
    expect(first.body).toEqual({ ok: true, step: "code" });
    const done = await codeStep(await codeMailed(mail.outbox, email, since), first.pending);
    expect(done.body.ok).toBe(true);
  }

  it("a lost passkey: the door asks for it and sends no code; after the reset, the link, the password and the emailed code sign them in", async () => {
    const ana = await seedGuardianNamed("Ana Zebrafish");
    await seedPassword(ana.authUserId, DOOR_PASSWORD);
    const key = await seedPasskey(ana.id);
    expect((await passwordStep("ana@example.com")).body).toEqual({ ok: true, step: "passkey", app: false });
    expect(mail.outbox).toEqual([]);
    expect((await resetSignin(ana.id, asked, ADMIN)).ok).toBe(true);
    await backIn("ana@example.com");
    // The passkey the device still holds is no way in now: its row is gone.
    expect((await passkeyStep(key, { alone: true })).body.ok).toBe(false);
  });

  it("passkeys a change of the portal's address made useless: refused before; after the reset, as above", async () => {
    const ana = await seedGuardianNamed("Ana Zebrafish");
    await seedPassword(ana.authUserId, DOOR_PASSWORD);
    const key = await seedPasskey(ana.id);
    // Made for the portal's old address: another host and origin than the portal's own now.
    expect((await passkeyStep(key, { alone: true, rpId: "portal.old.example", origin: "https://portal.old.example" })).body.ok).toBe(false);
    expect((await passwordStep("ana@example.com")).body).toEqual({ ok: true, step: "passkey", app: false });
    expect(mail.outbox).toEqual([]);
    expect((await resetSignin(ana.id, asked, ADMIN)).ok).toBe(true);
    await backIn("ana@example.com");
  });
});

describe("under Strict", () => {
  it("the reset is the same; with a password chosen from its link, the link and the door lead only to adding a second factor, and email no code", async () => {
    await seedParentSettings({ ...SIGNINS_ON, level: "strict" });
    const ana = await seedAnaWithEverything();
    expect((await resetSignin(ana.id, asked, ADMIN)).ok).toBe(true);
    expect(await held(ana)).toMatchObject({ passwords: 0, apps: 0, passkeys: 0 });
    const token = tokenIn(mail.outbox[0]!);
    // Under Strict a set-up link, for a person left with no second factor, is Strict's enrolment (slice SI-10a), and so
    // is the password at the door: each leads to /one-more-step and nothing else.
    expect(await choosePasswordFromLink({ purpose: "setup", token, password: NEW_PASSWORD, again: NEW_PASSWORD }, { ip: IP }))
      .toMatchObject({ ok: true, signIn: { parentId: ana.id, enrol: true } });
    const since = mail.outbox.length;
    expect((await passwordStep("ana@example.com", { password: NEW_PASSWORD })).body).toEqual({ ok: true, next: "/one-more-step" });
    expect((await audits("signin.second_step_asked")).at(-1)).toMatchObject({ targetId: ana.id, after: { step: "enrol" } });
    expect(await audits("signin.password_refused")).toEqual([]);
    expect(mail.outbox.slice(since)).toEqual([]);
  });
});
